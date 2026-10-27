/**
 * boot-runtime.mjs —— 给 runtime/boot.js 造一个**行为**测试台。
 *
 * 为什么需要它：boot.js 是"注入进 index.html 的脚本文本"，既不是模块也不是
 * DOM 组件，历史上只能用正则断言源码里有没有某段字符串（`selftest.mjs` 里的
 * "静态锚点"）。那种断言钉得住"代码没被删"，钉不住"行为没变"——
 * 比如"css 模式到底挂不挂覆盖层"这种最核心的政策，源码里看着有 CSS 动画、
 * 实际却被一行 early-return 挡掉，正则一条都测不出来。
 *
 * 这里做的是：一份**极小的 DOM 垫片** + **可控时钟** + 可注入的 fetch，
 * 把 boot.js 原文在一个 vm 上下文里跑起来，然后断言**真实的 DOM 结果**：
 *   - 覆盖层挂没挂、挂成什么样（data-mode / data-media / 透明度）
 *   - 素材就位前后、素材挂掉后的回落
 *   - 应用就绪后是否交接（淡出 → 移除节点）
 *   - 点击跳过是否立刻让开
 *
 * 垫片只实现 boot.js 真正用到的那部分 DOM，**不追求通用**——
 * 它的价值在于"够用且可读"，而不是替代 jsdom（插件零依赖，测试也零依赖）。
 *
 * 用法：node tools/boot-runtime.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const bootSource = fs.readFileSync(new URL('../runtime/boot.js', import.meta.url), 'utf8')

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

// ─────────────────────────── 可控时钟 ───────────────────────────

/**
 * 假时钟：测试里"推进 300ms"就真的推进 300ms，不靠 sleep，也不会有 flaky。
 * @returns {{ now: () => number, setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function, advance: (ms: number) => Promise<void>, pending: () => number }}
 */
function createClock() {
  let now = 0
  let seq = 0
  /** @type {Map<number, { fn: Function, at: number, every: number | null }>} */
  const timers = new Map()
  const schedule = (fn, ms, every) => {
    seq += 1
    timers.set(seq, { fn, at: now + Math.max(every === null ? 0 : 1, ms || 0), every })
    return seq
  }
  return {
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, ms || 1)),
    clearInterval: (id) => timers.delete(id),
    pending: () => timers.size,
    /**
     * 推进时间：按到期顺序逐个触发，触发后让出微任务（boot.js 里有 Promise 链）。
     * @param {number} ms 推进毫秒数。
     */
    advance: async (ms) => {
      const target = now + ms
      for (;;) {
        let bestId = null
        let best = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (best === null || timer.at < best.at) {
            best = timer
            bestId = id
          }
        }
        if (best === null) break
        now = best.at
        if (best.every === null) timers.delete(bestId)
        else best.at = now + best.every
        best.fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

/**
 * 冲干净微任务队列：boot.js 的实时配置通道是 fetch → json → then 的 Promise 链，
 * 需要若干轮微任务才能落地（不同 realm 的 Promise 也共用同一个微任务队列）。
 * @param {number} [rounds] 冲刷轮数。
 */
async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

// ─────────────────────────── 极小 DOM 垫片 ───────────────────────────

/** 元素属性选择器：只支持 `[name]` 与 `[name="value"]`（boot.js 只用到这两种）。 */
function matchesAttr(node, selector) {
  const match = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(selector.trim())
  if (match === null) return false
  const [, name, value] = match
  if (!node.hasAttribute(name)) return false
  return value === undefined || node.getAttribute(name) === value
}

class StubStyle {
  constructor() {
    this.props = new Map()
  }

  setProperty(key, value) {
    this.props.set(key, String(value))
  }

  getPropertyValue(key) {
    return this.props.has(key) ? this.props.get(key) : ''
  }

  removeProperty(key) {
    this.props.delete(key)
  }
}

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.style = new StubStyle()
    this.listeners = new Map()
    this.parentNode = null
    this.className = ''
    this.textContent = ''
    this.id = ''
    // ── 媒体元素用到的字段 ──
    this.src = ''
    this.readyState = 0
    this.duration = NaN
    this.muted = false
    this.defaultMuted = false
    this.volume = 1
    this.loop = false
    this.currentTime = 0
    this.complete = false
    this.naturalWidth = 0
    this.error = null
    this.paused = true
    /** 起播计数：测试用来断言"什么时候放的音"。 */
    this.playCount = 0
  }

  /**
   * 起播：boot.js 会看返回值是不是 Promise（有 then/catch 就算），
   * 所以这里返回真的 Promise，语义和浏览器一致。
   * @returns {Promise<void>} 已完成的起播。
   */
  play() {
    this.playCount += 1
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.paused = true
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn)
  }

  /**
   * 触发一个事件（垫片只给测试用）。
   * @param {string} type 事件名。
   * @param {object} [event] 事件对象。
   */
  emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  /** 深度优先收集所有后代。 */
  descendants() {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

/**
 * 造一个"宿主页面"：body 里放 #root，#root 里放原生启动卡（带进度 spinner）。
 * @returns {{ document: object, body: StubElement, root: StubElement, bootCard: StubElement, spinner: StubElement }}
 */
function createHostPage() {
  const documentElement = new StubElement('html')
  const body = new StubElement('body')
  const root = new StubElement('div')
  root.id = 'root'
  const bootCard = new StubElement('div')
  bootCard.setAttribute('data-dsh-boot', '')
  const spinner = new StubElement('div')
  spinner.setAttribute('data-dsh-boot-spinner', '')
  spinner.style.setProperty('--dsh-boot-arc', '72deg')
  bootCard.appendChild(spinner)
  root.appendChild(bootCard)
  body.appendChild(root)

  const findById = (id) => {
    if (body.id === id) return body
    return body.descendants().find((node) => node.id === id) ?? null
  }

  const document = {
    body,
    documentElement,
    readyState: 'complete',
    createElement: (tag) => new StubElement(tag),
    getElementById: (id) => findById(id),
    querySelector: (selector) => body.descendants().find((node) => matchesAttr(node, selector)) ?? null,
    querySelectorAll: (selector) => body.descendants().filter((node) => matchesAttr(node, selector)),
    // keydown 是 boot.js 唯一的 document 级监听：记下来，测试里可以直接调用。
    addEventListener: (type, fn) => {
      if (type === 'keydown') document.__keydown = fn
    },
    removeEventListener: (type) => {
      if (type === 'keydown') document.__keydown = undefined
    },
  }
  return { document, body, root, bootCard, spinner }
}

/**
 * 跑一次 boot.js，返回可断言的现场。
 * @param {object} options 选项。
 * @param {object} [options.snapshot] 注入的 global 快照（宿主一次性收集的那份）。
 * @param {object|null} [options.live] 实时配置通道回包（null = 通道失败）。
 * @param {boolean} [options.liveFails] 实时通道直接失败。
 * @returns {Promise<object>} 现场。
 */
async function runBoot(options = {}) {
  const clock = createClock()
  const page = createHostPage()
  const logs = []

  const sandbox = {
    document: page.document,
    navigator: { language: 'en-US' },
    console: {
      info: (msg) => logs.push(String(msg)),
      warn: (msg) => logs.push(String(msg)),
      error: (msg) => logs.push(String(msg)),
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    requestAnimationFrame: (fn) => clock.setTimeout(() => fn(Date.now()), 16),
    MutationObserver: class {
      observe() {}

      disconnect() {}
    },
    Date: { now: () => clock.now() },
    __DSA_BOOT__: options.snapshot ?? {},
    fetch:
      options.liveFails === true
        ? () => Promise.reject(new Error('offline'))
        : () =>
            Promise.resolve({
              ok: true,
              json: async () => (options.live === undefined || options.live === null ? { ok: false } : options.live),
            }),
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  const context = vm.createContext(sandbox)

  vm.runInContext(bootSource, context, { filename: 'runtime/boot.js' })

  // 实时配置通道是 Promise 链：冲干净微任务，让它落地。
  await flush()

  const overlay = () => page.body.children.find((node) => node.className === 'dsa-root') ?? null
  return { clock, page, sandbox, overlay, logs, context }
}

/**
 * 让"应用树"接管 #root（宿主水合完成的样子）：启动卡被换成普通子树。
 * @param {object} page 宿主页面。
 */
function simulateAppReady(page) {
  const app = new StubElement('div')
  app.className = 'app-root'
  page.root.children.length = 0
  page.root.appendChild(app)
}

console.log('== 覆盖层挂载政策（实时配置决定一切）==')

await check('默认（css 模式，无素材）→ 挂载内置动画覆盖层', async () => {
  const { overlay } = await runBoot({ snapshot: { enabled: true, mode: 'css', src: '' } })
  const root = overlay()
  assert.ok(root, 'css 模式没有挂载覆盖层：内置 CSS 动画永远出不来')
  assert.equal(root.getAttribute('data-mode'), 'css')
})

await check('关闭开关 → 不挂载（原生启动页照常）', async () => {
  const { overlay } = await runBoot({ snapshot: { enabled: false, mode: 'css', src: '' } })
  assert.equal(overlay(), null)
})

await check('视频模式但没有素材 → 不挂载', async () => {
  const { overlay } = await runBoot({ snapshot: { enabled: true, mode: 'video', src: '' } })
  assert.equal(overlay(), null)
})

await check('实时配置优先于宿主快照', async () => {
  const { overlay } = await runBoot({
    snapshot: { enabled: true, mode: 'css', src: '' },
    live: { ok: true, cfg: { enabled: false, mode: 'css', src: '' } },
  })
  assert.equal(overlay(), null, '实时配置没有盖过快照')
})

await check('实时通道失败 → 退回宿主快照', async () => {
  const { overlay } = await runBoot({
    snapshot: { enabled: true, mode: 'css', src: '' },
    liveFails: true,
  })
  assert.ok(overlay(), '实时通道失败后没有退回快照')
})

console.log('== 素材模式：出画前透明、出画后可见、挂掉后回落 ==')

await check('素材未出画 → data-media=loading（透明、不拦点击）', async () => {
  const { overlay, sandbox } = await runBoot({
    snapshot: { enabled: true, mode: 'video', src: '/dsh-startup-animation/asset' },
  })
  const root = overlay()
  assert.ok(root, '视频模式没有挂载')
  assert.equal(root.getAttribute('data-mode'), 'media')
  assert.equal(root.getAttribute('data-media'), 'loading', '未出画时没有进入 loading 态')
  assert.equal(sandbox.document.querySelector('[data-dsh-boot]') !== null, true, '原生启动卡不该消失')
})

await check('素材第一帧就位 → data-media=ok', async () => {
  const { overlay, page } = await runBoot({
    snapshot: { enabled: true, mode: 'video', src: '/dsh-startup-animation/asset' },
  })
  const video = page.body.descendants().find((node) => node.tagName === 'VIDEO')
  assert.ok(video, '没有创建 video 元素')
  video.readyState = 2
  video.emit('loadeddata')
  assert.equal(overlay().getAttribute('data-media'), 'ok')
})

await check('素材挂掉 → data-media=gone（透明，回落原生启动页）', async () => {
  const { overlay, page } = await runBoot({
    snapshot: { enabled: true, mode: 'video', src: '/dsh-startup-animation/asset' },
  })
  const video = page.body.descendants().find((node) => node.tagName === 'VIDEO')
  video.error = { code: 4 }
  video.emit('error')
  // 错误路径有重试；再错一次才真正放弃。
  video.error = { code: 4 }
  video.emit('error')
  assert.equal(overlay().getAttribute('data-media'), 'gone')
  assert.equal(overlay().getAttribute('data-mode'), 'css', '挂掉后应回落到内置动画模式')
})

console.log('== 交接：应用就绪即淡出，节点移除 ==')

await check('应用就绪 → 淡出（data-state=leaving）并移除节点', async () => {
  const { clock, page, overlay } = await runBoot({
    snapshot: { enabled: true, mode: 'css', src: '', minMs: 0, fadeMs: 600 },
  })
  simulateAppReady(page)
  await clock.advance(200)
  assert.equal(overlay().getAttribute('data-state'), 'leaving', '应用就绪后没有开始淡出')
  await clock.advance(1000)
  assert.equal(overlay(), null, '淡出结束后覆盖层没有从 DOM 移除')
})

await check('最短展示未到 → 不提前交接', async () => {
  const { clock, page, overlay } = await runBoot({
    snapshot: { enabled: true, mode: 'css', src: '', minMs: 3000, fadeMs: 600 },
  })
  simulateAppReady(page)
  await clock.advance(500)
  assert.equal(overlay().getAttribute('data-state'), 'idle', '最短展示未到就交接了')
  await clock.advance(3000)
  assert.equal(overlay().getAttribute('data-state'), 'leaving')
})

await check('点击画面 → 立刻让开（跳过最短展示）', async () => {
  const { clock, overlay } = await runBoot({
    snapshot: { enabled: true, mode: 'css', src: '', minMs: 5000, skipFadeMs: 240 },
  })
  overlay().emit('click')
  await clock.advance(10)
  assert.equal(overlay().getAttribute('data-state'), 'leaving', '点击后没有立刻让开')
})

await check('Esc 键 → 立刻让开', async () => {
  const { clock, sandbox, overlay } = await runBoot({
    snapshot: { enabled: true, mode: 'css', src: '', minMs: 5000 },
  })
  // boot.js 把 keydown 挂在 document 上；垫片记下监听器，这里直接调用。
  const keydown = sandbox.document.__keydown
  assert.ok(typeof keydown === 'function', '没有监听 keydown')
  keydown({ key: 'Escape' })
  await clock.advance(10)
  assert.equal(overlay().getAttribute('data-state'), 'leaving', 'Esc 没有让开')
})

console.log('== 开机音频：与画面同刻起播 ==')

await check('素材就位后才起播开机音频', async () => {
  const { clock, page } = await runBoot({
    snapshot: {
      enabled: true,
      mode: 'video',
      src: '/dsh-startup-animation/asset',
      audioEnabled: true,
      audioSrc: '/dsh-startup-animation/asset?path=audio.mp3',
    },
  })
  const audio = page.body.descendants().find((node) => node.tagName === 'AUDIO')
  assert.ok(audio, '没有创建 audio 元素')
  let played = 0
  audio.play = () => {
    played += 1
    return Promise.resolve()
  }
  const video = page.body.descendants().find((node) => node.tagName === 'VIDEO')
  video.readyState = 2
  video.emit('loadeddata')
  await clock.advance(10)
  assert.equal(played, 1, '素材就位后开机音频没有起播')
})

console.log('')
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('BOOT RUNTIME PASS')
