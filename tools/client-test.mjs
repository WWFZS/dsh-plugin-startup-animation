/**
 * client-test.mjs —— 给 client.js 的设置页做**行为**测试（零依赖）。
 *
 * 为什么需要它：client.js 是浏览器半边，里面是 React 组件。历史上的验证方式是
 * 在源码里正则匹配字符串（"启用→enabled 映射存在"这类）—— 那只能证明代码没被删，
 * 证明不了**行为**对：比如"点卡片到底发了什么请求体"、"删除按钮的文案对不对"、
 * "恢复默认后界面显示什么"。
 *
 * 做法：在 vm 里放一个**极小的 React 垫片**（createElement + 四个 hook），
 * 把 client.js 原文跑起来，拿到组件树，再断言树上的实际内容。
 * 不引 React 真身：插件本身零依赖，测试也该零依赖，而且仓库里的 React UMD
 * 在 .gitignore 里（截图工具的临时产物），拿来当测试依赖不可靠。
 *
 * 用法：node tools/client-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

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

// ─────────────────────────── React 垫片 ───────────────────────────

/**
 * 极小的 React 替身：只实现 client.js 用到的部分。
 * hooks 用一个简单的游标实现 —— 组件函数按顺序调用 hook，渲染器负责重放。
 */
function createReact() {
  let hookIndex = 0
  /** @type {any[]} */
  let currentHooks = []
  let effects = []

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const index = hookIndex++
      if (currentHooks.length <= index) {
        currentHooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const setValue = (next) => {
        currentHooks[index] = typeof next === 'function' ? next(currentHooks[index]) : next
      }
      return [currentHooks[index], setValue]
    },
    useRef(initial) {
      const index = hookIndex++
      if (currentHooks.length <= index) currentHooks[index] = { current: initial }
      return currentHooks[index]
    },
    useEffect(fn, deps) {
      const index = hookIndex++
      const previous = currentHooks[index]
      const changed =
        previous === undefined ||
        deps === undefined ||
        previous.deps === undefined ||
        deps.length !== previous.deps.length ||
        deps.some((dep, i) => dep !== previous.deps[i])
      if (changed) {
        currentHooks[index] = { deps }
        effects.push(() => fn())
      }
    },
    /** 供渲染器使用：跑完一轮后收集 effect。 */
    __reset() {
      hookIndex = 0
      effects = []
    },
    __effects() {
      return effects
    },
    __hooks() {
      return currentHooks
    },
  }
  return React
}

/** 递归遍历组件树。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** 收集树上所有文本。 */
function texts(node) {
  const out = []
  walk(node, (item) => {
    if (typeof item.type === 'string' && item.type !== 'img' && item.type !== 'input') {
      const text = item.children.filter((child) => typeof child === 'string').join('')
      if (text !== '') out.push(text)
    }
  })
  return out
}

/** 按 className 找节点。 */
/** 按 className 精确匹配。 */
function findAll(node, className) {
  const out = []
  walk(node, (item) => {
    if (item.props && item.props.className === className) out.push(item)
  })
  return out
}

/** 按 className **包含**匹配（一个节点可能有多个类，如 "a b"）。 */
function findByClass(node, className) {
  const out = []
  walk(node, (item) => {
    const value = item.props?.className
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) out.push(item)
  })
  return out
}

/** 找出 props 里带指定 prop 的节点。 */
function findByProp(node, prop) {
  const out = []
  walk(node, (item) => {
    if (item.props && item.props[prop] !== undefined) out.push(item)
  })
  return out
}

// ─────────────────────────── 加载 client.js ───────────────────────────

/**
 * 在 vm 里跑 client.js，拿到 makeStartupAnimationPage。
 * @param {object} options 选项。
 * @param {object} [options.status] manage 回包（默认一份"全新安装"的状态）。
 * @param {object} [options.update] update 回包。
 * @returns {Promise<{ React: object, render: Function, calls: object[] }>} 测试现场。
 */
async function loadClient(options = {}) {
  const React = createReact()
  const calls = []
  /** window 事件监听（宠物浮层 ↔ 设置页的那条桥）。 */
  const listeners = []
  const status = options.status ?? {
    ok: true,
    version: '1.10.0',
    enabled: true,
    sound: true,
    audioEnabled: false,
    audioVolume: 0.4,
    durationSec: 8,
    mode: 'css',
    custom: false,
    name: '',
    file: '',
    audioFile: '',
    audioName: '',
    audioBuiltin: false,
    builtin: false,
    limitBytes: 128 * 1024 * 1024,
    library: [],
    cfg: {},
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          // client.js 顶层就调 load()，factory 会被**立即**执行：
          // 所以 require('react') 必须当场返回 React 垫片。
          sandbox.__module = mod.factory((name) => {
            if (name === 'react') return React
            throw new Error('unexpected require: ' + name)
          })
        },
      },
      location: { reload: () => calls.push({ type: 'reload' }) },
      open: (...args) => calls.push({ type: 'open', args }),
      innerWidth: 1280,
      innerHeight: 800,
      // 真实窗口上这两个就是全局函数的别名，垫片里补上（宠物浮层切动画时会用）。
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      requestAnimationFrame: (fn) => setTimeout(() => fn(0), 16),
      cancelAnimationFrame: (id) => clearTimeout(id),
      // 宠物浮层用 window 事件和设置页通信（两边不在同一棵渲染树上）。
      // 这里记下事件名，测试就能断言"点动作按钮 → 发了一条 dsa:pet-play"。
      addEventListener: (name, fn) => {
        listeners.push({ name, fn })
      },
      removeEventListener: (name) => {
        const at = listeners.findIndex((entry) => entry.name === name)
        if (at >= 0) listeners.splice(at, 1)
      },
      dispatchEvent: (event) => {
        calls.push({ type: 'event', name: event.type, detail: event.detail })
        for (const entry of listeners) if (entry.name === event.type) entry.fn(event)
        return true
      },
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init && init.detail
      }
    },
    document: {
      createElement: () => {
        const attrs = {}
        return {
          style: {},
          dataset: {},
          classList: { add() {}, remove() {} },
          setAttribute(name, value) {
            attrs[name] = String(value)
          },
          getAttribute(name) {
            return name in attrs ? attrs[name] : null
          },
          appendChild() {},
          remove() {},
          addEventListener() {},
          removeEventListener() {},
          play: () => Promise.resolve(),
          pause() {},
        }
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    fetch: (url, init) => {
      const path = String(url)
      calls.push({ type: 'fetch', url: path, init })
      if (path.includes('/update')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            options.update ?? { ok: true, current: '1.10.0', reachable: false, updateAvailable: false },
        })
      }
      // 自我管理并入 manage：GET 状态里带 `self`，POST 用 `{action}` 触发。
      // 以前是单独的 `/self` 端点，但那条路由在某些宿主上会被吃掉（400 无 body），
      // 设置页因此整块不显示卸载/更新 —— 所以状态与动作现在都走 manage。
      const isSelfAction = init?.method === 'POST' && String(init?.body ?? '').includes('"action"')
      if (isSelfAction) {
        return Promise.resolve({
          ok: true,
          json: async () => options.selfResult ?? { ok: true },
        })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ...status, self: options.self ?? { installed: false, selected: false } }),
      })
    },
    confirm: (text) => {
      calls.push({ type: 'confirm', text })
      return options.confirmResult !== false
    },
    Audio: class {
      constructor(src) {
        this.src = src
        this.volume = 1
      }

      play() {
        return Promise.resolve()
      }

      pause() {}
    },
    console,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = sandbox.document
  const context = vm.createContext(sandbox)
  // client.js 顶层就会调 window.__ModuleLoader__.load(...) —— 跑完即已装载。
  vm.runInContext(clientSource, context, { filename: 'client.js' })
  const module = sandbox.__module
  assert.ok(module, 'client.js 没有导出模块')

  const dicts = {}
  let Page = null
  module.apply({
    effect: (fn) => fn(),
    locale: {
      register: (ns, lang, dict) => {
        dicts[lang] = dict
        return () => {}
      },
      bind: () => (key) => (dicts.zh && dicts.zh[key]) ?? key,
    },
    slots: {
      inject: (name, cb) => {
        cb()
        return () => {}
      },
      register: (meta, component) => {
        Page = component
        return () => {}
      },
    },
  })
  assert.ok(Page, '没有注册设置页组件')

  /**
   * 渲染组件并跑完 effect。
   *
   * 组件的状态来自一次 fetch（异步），所以要"渲染 → 跑 effect → 等 fetch 落地
   * → 再渲染一次"才能拿到有数据的树。第二次渲染时 hooks 的 deps 没变，
   * effect 不会重复触发。
   * @returns {Promise<object>} 最终组件树。
   */
  const render = async () => {
    React.__reset()
    Page()
    for (const effect of React.__effects()) effect()
    // 等 fetch 的 Promise 链落地（manage 状态 + update 版本）。
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
    React.__reset()
    return Page()
  }

  return { React, render, calls, dicts, context }
}

// ─────────────────────────── 测试 ───────────────────────────

console.log('== 设置页结构 ==')

await check('渲染出标题、开关与三个分类页签', async () => {
  const { render } = await loadClient()
  const tree = await render()
  const all = texts(tree)
  assert.ok(all.includes('开机动画'), `没有标题：${all.join(' | ')}`)
  assert.ok(all.includes('显示开机动画'), '没有总开关')
  assert.ok(all.includes('MP4') && all.includes('壁纸') && all.includes('音频'), '三个分类页签不齐')
})

await check('总开关读的是 enabled（不是不存在的 enable）', async () => {
  const { render } = await loadClient()
  const tree = await render()
  const switches = findAll(tree, 'dsa-set-switch')
  assert.equal(switches.length, 3, `开关数量异常：${switches.length}`)
  const enable = switches.find((sw) => sw.props['aria-label'] === '显示开机动画')
  assert.ok(enable, '找不到总开关')
  assert.equal(enable.props['aria-checked'], 'true', '总开关没有反映 enabled=true')
})

await check('关闭总开关 → 写回 enabled:false（不是 enable）', async () => {
  const { render, calls } = await loadClient()
  const tree = await render()
  const enable = findAll(tree, 'dsa-set-switch').find((sw) => sw.props['aria-label'] === '显示开机动画')
  enable.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点击开关没有发 POST')
  const body = JSON.parse(post.init.body)
  assert.deepEqual(body, { enabled: false }, `写回内容不对：${JSON.stringify(body)}`)
})

await check('"视频带声播放" 写回 sound', async () => {
  const { render, calls } = await loadClient()
  const tree = await render()
  const sound = findAll(tree, 'dsa-set-switch').find((sw) => sw.props['aria-label'] === '视频带声播放')
  sound.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { sound: false })
})

await check('展示时长滑杆 3–30 秒：拖过顶 → 夹到 30 并写回', async () => {
  const { render, calls } = await loadClient()
  const tree = await render()
  const range = findAll(tree, 'dsa-set-range').find((el) => el.props['aria-label'] === '展示时长')
  assert.ok(range, '找不到展示时长滑杆')
  assert.equal(range.props.min, 3, `下界不是 3 秒：${range.props.min}`)
  assert.equal(range.props.max, 30, `上界不是 30 秒：${range.props.max}`)
  range.props.onChange({ target: { value: '99' } })
  // 读数要立刻跟上，否则界面显示的秒数和真正生效的不一致。
  // 必须在提交之前断言：回包会触发"按状态回读"的 effect，把读数拨回 fixture 的值。
  const label = texts(await render()).find((text) => /^\d+ 秒$/.test(text))
  assert.equal(label, '30 秒', `读数没更新：${label}`)
  // 拖动停手 350ms 才提交一次（防抖），等它落地。
  await new Promise((resolve) => setTimeout(resolve, 400))
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '拖动滑杆没有发 POST')
  assert.deepEqual(JSON.parse(post.init.body), { durationSec: 30 }, '越界值没被夹到 30 秒')
})

console.log('== 开机音频 ==')

await check('音频页签存在；点音频卡片写回 useAudio', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioEnabled: false,
      audioFile: '',
      audioName: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        { id: '音频', files: [{ path: 'builtin/音频/秘书.mp3', name: '秘书.mp3', size: 100 }] },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  // 切到"音频"页签（React state 变化 → 需要再渲染一次才能拿到新树）。
  const audioTab = findAll(tree, 'dsa-set-tab').find((tab) => tab.children.includes('音频'))
  assert.ok(audioTab, '没有音频页签')
  audioTab.props.onClick()
  const audioTree = await render()
  const cards = findAll(audioTree, 'dsa-set-card-hit')
  assert.equal(cards.length, 1, `音频卡片数量异常：${cards.length}`)
  cards[0].props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点音频卡片没有发 POST')
  const body = JSON.parse(post.init.body)
  assert.equal(body.useAudio, 'builtin/音频/秘书.mp3')
  // 开关由**宿主**在收到 useAudio 时顺手打开（index.js 的 libraryPatch.audioEnabled），
  // 客户端只管"选中了哪一条"，不重复写开关 —— 两边都写会互相覆盖。
  assert.equal(body.audioEnabled, undefined, '客户端不该重复写 audioEnabled')
})

await check('开机音频开关写回 audioEnabled', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioEnabled: false,
      audioFile: '',
      audioName: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [],
      cfg: {},
    },
  })
  const tree = await render()
  const audioSwitch = findAll(tree, 'dsa-set-switch').find(
    (sw) => sw.props['aria-label'] === '播放开机音频',
  )
  assert.ok(audioSwitch, '找不到开机音频开关')
  audioSwitch.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点击开机音频开关没有发 POST')
  assert.deepEqual(JSON.parse(post.init.body), { audioEnabled: true })
})

console.log('== 素材库卡片 ==')

await check('点卡片 → 写回 use（选用未在用的素材）', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'video',
      custom: true,
      name: '在用.mp4',
      file: 'builtin/MP4/在用.mp4',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        {
          id: 'MP4',
          files: [
            { path: 'builtin/MP4/在用.mp4', name: '在用.mp4', size: 100 },
            { path: 'builtin/MP4/开场.mp4', name: '开场.mp4', size: 100 },
          ],
        },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  const cards = findAll(tree, 'dsa-set-card-hit')
  assert.equal(cards.length, 2, `卡片数量异常：${cards.length}`)
  // 第一张是"在用"（点了不重复写），第二张才真的发请求。
  const target = cards[1]
  target.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点未在用的卡片没有发 POST')
  assert.deepEqual(JSON.parse(post.init.body), { use: 'builtin/MP4/开场.mp4' })
})

await check('点在用的卡片 → 不重复写配置', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'video',
      custom: true,
      name: '在用.mp4',
      file: 'builtin/MP4/在用.mp4',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        { id: 'MP4', files: [{ path: 'builtin/MP4/在用.mp4', name: '在用.mp4', size: 100 }] },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  findAll(tree, 'dsa-set-card-hit')[0].props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.equal(post, undefined, '点在用的卡片也发了写请求')
})

await check('删除按钮文案区分内置与上传', async () => {
  const { render } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        {
          id: 'MP4',
          files: [
            { path: 'builtin/MP4/内置.mp4', name: '内置.mp4', size: 100 },
            { path: '/home/x/startup-animation-media/上传.mp4', name: '上传.mp4', size: 100, uploaded: true },
          ],
        },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  const dels = findAll(tree, 'dsa-set-card-del')
  assert.equal(dels.length, 2, `删除按钮数量异常：${dels.length}`)
  const titles = dels.map((del) => del.props.title)
  assert.ok(
    titles.some((title) => title.includes('从列表移除')),
    `内置素材的删除文案不对：${titles.join(' | ')}`,
  )
  assert.ok(
    titles.some((title) => title === '删除文件'),
    `上传素材的删除文案不对：${titles.join(' | ')}`,
  )
  // 无障碍名要带素材名，否则读屏只会念"删除文件"，不知道删的是哪一条。
  for (const del of dels) {
    assert.ok(
      del.props['aria-label'].includes('.mp4'),
      `删除按钮的无障碍名没有素材名：${del.props['aria-label']}`,
    )
  }
})

await check('内置素材删除 → 只写 forget，不真删', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        { id: 'MP4', files: [{ path: 'builtin/MP4/内置.mp4', name: '内置.mp4', size: 100 }] },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  findAll(tree, 'dsa-set-card-del')[0].props.onClick({ stopPropagation() {} })
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { forget: 'builtin/MP4/内置.mp4' })
})

console.log('== 宠物 ==')

/** 一个动作（宿主的真实形状：id/name/file/loop）。 */
const petClip = (id, loop = false) => ({ id, name: id, file: `builtin/宠物/河马/${id}.webm`, loop })

/** 小包：4 个动作，应该平铺成动作格。 */
const HIPPO_PACK = {
  id: 'hippo',
  name: '河马',
  description: '一只河马',
  credit: null,
  canvas: [480, 648],
  cover: 'builtin/宠物/河马/cover.webp',
  roles: { idle: '待机', drag: '', clicks: ['点击回应'], turn: [], moves: [] },
  ambient: ['interact', 'chill'],
  categories: [
    { id: 'interact', name: '互动', cover: 'builtin/宠物/河马/cat-interact.webp', clips: ['点击回应', '害羞捂脸'] },
    { id: 'chill', name: '休闲', cover: 'builtin/宠物/河马/cat-chill.webp', clips: ['吃橘子', '待机'] },
  ],
  clips: [petClip('待机', true), petClip('点击回应'), petClip('害羞捂脸'), petClip('吃橘子')],
  count: 4,
}

/** 大包：109 个动作，应该按分类展示 + 搜索，不铺动作格。 */
const MAID_CLIPS = Array.from({ length: 109 }, (_, i) => petClip(`动作${String(i + 1).padStart(3, '0')}`))
const MAID_PACK = {
  id: 'maid',
  name: '女仆',
  description: '一只女仆',
  credit: {
    author: 'PC2005-cloud',
    name: 'dsh-pet',
    url: 'https://github.com/PC2005-cloud/dsh-pet',
    license: 'CC BY-NC-SA 4.0',
  },
  canvas: [360, 360],
  cover: 'builtin/宠物/女仆/cover.webp',
  roles: { idle: '动作058', drag: '', clicks: ['动作077'], turn: [], moves: [] },
  ambient: ['play', 'food'],
  categories: [
    { id: 'play', name: '玩耍', cover: 'builtin/宠物/女仆/cat-play.webp', clips: MAID_CLIPS.slice(0, 60).map((clip) => clip.id) },
    { id: 'food', name: '吃什么', cover: 'builtin/宠物/女仆/cat-food.webp', clips: MAID_CLIPS.slice(60).map((clip) => clip.id) },
  ],
  clips: MAID_CLIPS,
  count: 109,
}

/** 带宠物域的 manage 状态（宿主的真实回包形状）。 */
const petStatus = (packs = [HIPPO_PACK], pack = 'hippo', over = {}) => ({
  ok: true,
  enabled: true,
  durationSec: 8,
  mode: 'css',
  custom: false,
  name: '',
  file: '',
  audioFile: '',
  audioBuiltin: false,
  limitBytes: 1e9,
  library: [],
  cfg: {},
  pet: { enabled: false, size: 176, x: 100, y: 100, pack, packs, ...over },
})

/** 切到宠物页签并返回这一轮渲染的树。 */
const openPetTab = async (render) => {
  const tree = await render()
  findAll(tree, 'dsa-set-tab')
    .find((tab) => tab.children[0] === '宠物')
    .props.onClick()
  return render()
}

await check('页签顺序：MP4 / 壁纸 / 音频 / 宠物 / 更新公告', async () => {
  const { render } = await loadClient({ status: petStatus() })
  const tree = await render()
  const labels = findAll(tree, 'dsa-set-tab').map((tab) => tab.children[0])
  assert.deepEqual(labels, ['MP4', '壁纸', '音频', '宠物', '更新公告'], `页签顺序不对：${labels.join(' / ')}`)
})

await check('宠物页签：开关 + 大小 + 宠物卡 + 动作区', async () => {
  const { render } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const all = texts(petTree)
  assert.ok(all.includes('显示桌面宠物'), '没有宠物开关')
  assert.ok(all.includes('宠物大小'), '没有大小滑杆')
  assert.ok(all.includes('宠物'), '没有宠物选择标题')
  assert.ok(all.includes('动作'), '没有动作区标题')
  const range = findByProp(petTree, 'type').find(
    (el) => el.props.type === 'range' && el.props['aria-label'] === '宠物大小',
  )
  assert.ok(range, '找不到宠物大小滑杆')
  assert.equal(range.props.min, 100, '下界不是 100px')
  assert.equal(range.props.max, 320, '上界不是 320px')
  const packs = findAll(petTree, 'dsa-set-pet')
  assert.equal(packs.length, 1, `宠物卡数量不对：${packs.length}`)
  assert.ok(texts(packs[0]).includes('河马'), '宠物卡上没有名字')
  assert.ok(texts(packs[0]).includes('4 个动作'), `宠物卡上没有动作数：${texts(packs[0]).join('|')}`)
})

await check('小包动作直接平铺：丢一个动作进去就多一格', async () => {
  const clip = petClip('睡觉', true)
  const pack = { ...HIPPO_PACK, clips: [...HIPPO_PACK.clips, clip], count: 5 }
  const { render } = await loadClient({ status: petStatus([pack]) })
  const petTree = await openPetTab(render)
  const cards = findAll(petTree, 'dsa-set-act')
  assert.equal(cards.length, 5, `动作格数不对：${cards.length}`)
  const names = cards.map((card) => texts(card)[0])
  assert.deepEqual(names, ['待机', '点击回应', '害羞捂脸', '吃橘子', '睡觉'], `动作名不对：${names.join(' / ')}`)
})

await check('点动作格 → 通知浮层播这个名字对应的动作', async () => {
  const { render, calls } = await loadClient({ status: petStatus([HIPPO_PACK], 'hippo', { enabled: true }) })
  const petTree = await openPetTab(render)
  const card = findAll(petTree, 'dsa-set-act').find((el) => texts(el).includes('害羞捂脸'))
  assert.ok(card, '找不到「害羞捂脸」')
  card.props.onClick()
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-play')
  assert.ok(play, '没有通知浮层播放')
  assert.equal(play.detail, '害羞捂脸', `播的动作不对：${play.detail}`)
})

await check('浮层回报当前动作 → 对应那格高亮', async () => {
  const { render, context } = await loadClient({ status: petStatus([HIPPO_PACK], 'hippo', { enabled: true }) })
  let petTree = await openPetTab(render)
  // 浮层回报的是对象（v1.14.0 起带名字与包名）。
  context.window.dispatchEvent(
    new context.CustomEvent('dsa:pet-state', { detail: { id: '点击回应', name: '点击回应', pack: 'hippo', loop: false } }),
  )
  petTree = await render()
  const on = findAll(petTree, 'dsa-set-act').find((card) => card.props['data-on'] === '1')
  assert.ok(on, '没有高亮任何动作')
  assert.equal(texts(on)[0], '点击回应', `高亮错了：${texts(on)[0]}`)
})

await check('大包不铺动作格：分类卡 + 搜索 + 随机一个', async () => {
  const { render } = await loadClient({ status: petStatus([MAID_PACK], 'maid', { enabled: true }) })
  const petTree = await openPetTab(render)
  assert.equal(findAll(petTree, 'dsa-set-act').length, 0, '109 个动作不该平铺')
  const cats = findAll(petTree, 'dsa-set-cat')
  assert.equal(cats.length, 2, `分类卡数量不对：${cats.length}`)
  const names = cats.map((cat) => texts(cat)[0])
  assert.deepEqual(names, ['玩耍', '吃什么'], `分类不对：${names.join(' / ')}`)
  const search = findAll(petTree, 'dsa-set-input')[0]
  assert.ok(search, '没有搜索框')
  assert.equal(search.props.placeholder, '搜索动作', '搜索框占位文案不对')
  assert.ok(texts(petTree).includes('随机一个'), '没有「随机一个」按钮')
})

await check('大包搜索：最多 8 条命中，点 chip 播放', async () => {
  const { render, calls } = await loadClient({ status: petStatus([MAID_PACK], 'maid', { enabled: true }) })
  let petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-input')[0].props.onChange({ target: { value: '动作10' } })
  petTree = await render()
  const chips = findAll(petTree, 'dsa-set-chip')
  assert.equal(chips.length, 8, `命中没截到 8 条：${chips.length}`)
  assert.equal(texts(chips[0])[0], '动作100', `第一条不对：${texts(chips[0])[0]}`)
  assert.equal(findAll(petTree, 'dsa-set-cat').length, 0, '搜索结果里不该再显示分类卡')
  chips[0].props.onClick()
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-play')
  assert.equal(play && play.detail, '动作100', 'chip 没有触发播放')
})

await check('搜索无命中 → 说一句没有匹配的动作', async () => {
  const { render } = await loadClient({ status: petStatus([MAID_PACK], 'maid', { enabled: true }) })
  let petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-input')[0].props.onChange({ target: { value: '不存在' } })
  petTree = await render()
  assert.equal(findAll(petTree, 'dsa-set-chip').length, 0, '不该有 chip')
  assert.ok(texts(petTree).includes('没有匹配的动作'), '没有空结果提示')
})

await check('点分类卡 → 通知浮层在这个分类里随机演一个', async () => {
  const { render, calls } = await loadClient({ status: petStatus([MAID_PACK], 'maid', { enabled: true }) })
  const petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-cat')
    .find((cat) => texts(cat).includes('吃什么'))
    .props.onClick()
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-category')
  assert.ok(play, '没有通知浮层按分类播放')
  assert.equal(play.detail, 'food')
})

await check('「随机一个」→ 通知浮层随机演', async () => {
  const { render, calls } = await loadClient({ status: petStatus([MAID_PACK], 'maid', { enabled: true }) })
  const petTree = await openPetTab(render)
  const btn = findByProp(petTree, 'className').find((el) => el.props.className === 'dsa-set-btn' && texts(el).includes('随机一个'))
  assert.ok(btn, '找不到「随机一个」按钮')
  btn.props.onClick()
  assert.ok(
    calls.some((call) => call.type === 'event' && call.name === 'dsa:pet-random'),
    '没有通知浮层随机播放',
  )
})

await check('换宠物 → 写回 petPack，卡片高亮跟着走', async () => {
  const { render, calls } = await loadClient({ status: petStatus([HIPPO_PACK, MAID_PACK], 'hippo', { enabled: true }) })
  const petTree = await openPetTab(render)
  const cards = findAll(petTree, 'dsa-set-pet')
  assert.equal(cards.length, 2, `宠物卡数量不对：${cards.length}`)
  const maid = cards.find((card) => texts(card).includes('女仆'))
  assert.ok(maid, '找不到女仆卡')
  maid.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petPack: 'maid' })
})

await check('素材署名：带原作者链接', async () => {
  const { render } = await loadClient({ status: petStatus([MAID_PACK], 'maid', { enabled: true }) })
  const petTree = await openPetTab(render)
  const credit = findAll(petTree, 'dsa-set-credit')[0]
  assert.ok(credit, '没有署名行')
  const link = findByProp(credit, 'href')[0]
  assert.equal(link.props.href, 'https://github.com/PC2005-cloud/dsh-pet', '没有链回原作者')
  assert.ok(texts(credit).join(' ').includes('CC BY-NC-SA 4.0'), '没有写许可证')
})

await check('打开宠物开关 → 写回 petEnabled:true', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const toggle = findAll(petTree, 'dsa-set-switch').find((el) => el.props['aria-label'] === '显示桌面宠物')
  assert.ok(toggle, '找不到宠物开关')
  toggle.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petEnabled: true })
})

await check('宠物没开就点动作 → 先打开宠物，再通知浮层播放', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-act')
    .find((card) => texts(card).includes('点击回应'))
    .props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petEnabled: true }, '没有先把宠物打开')
  // 打开之后再发播放事件（等状态落地），否则浮层还没显示，动作白播。
  await new Promise((resolve) => setTimeout(resolve, 120))
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-play')
  assert.ok(play, '没有通知浮层播放')
  assert.equal(play.detail, '点击回应', `播的动作不对：${play.detail}`)
})

await check('宠物大小越界 → 夹到 320 再写回', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const range = findByProp(petTree, 'aria-label').find((el) => el.props['aria-label'] === '宠物大小')
  range.props.onChange({ target: { value: '9999' } })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petSize: 320 }, '越界值没被夹到 320')
})

console.log('== 恢复默认与版本 ==')

await check('恢复默认 → DELETE；文案说"内置动画"而不是"原版标配"', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'video',
      custom: true,
      name: '开场.mp4',
      file: 'builtin/MP4/开场.mp4',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [],
      cfg: {},
    },
  })
  const tree = await render()
  const restore = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('恢复默认'))
  assert.ok(restore, '找不到恢复默认按钮')
  restore.props.onClick()
  const del = calls.find((call) => call.type === 'fetch' && call.init?.method === 'DELETE')
  assert.ok(del, '恢复默认没有发 DELETE')
  // 当前还选着自定义素材，所以素材行显示的是"内置 · 开场"；等配置回落到
  // 无素材时才显示"内置动画"。两种文案都不能再叫"原版标配"。
  const all = texts(tree)
  assert.ok(
    !all.some((text) => text.includes('原版标配')),
    `界面里还留着"原版标配"：${all.filter((t) => t.includes('原版')).join(' | ')}`,
  )
})

await check('没有选用素材时 → 素材行显示"内置动画"', async () => {
  const { render } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [],
      cfg: {},
    },
  })
  const tree = await render()
  assert.ok(
    texts(tree).includes('内置动画'),
    `素材行没有显示"内置动画"：${texts(tree).join(' | ')}`,
  )
})

await check('版本小字显示当前版本', async () => {
  const { render } = await loadClient({ self: { installed: false, selected: false } })
  const tree = await render()
  const badge = findAll(tree, 'dsa-set-ver')[0]
  assert.ok(badge, '没有版本小字')
  assert.ok(
    badge.children.some((child) => typeof child === 'string' && child.includes('1.10.0')),
    `版本小字没有版本号：${JSON.stringify(badge.children)}`,
  )
})

await check('有新版 + 已安装 → 版本小字变成一键更新按钮，不再跳 GitHub', async () => {
  const { render, calls } = await loadClient({
    self: { installed: true, selected: true, spec: 'file:whatever' },
    update: {
      ok: true,
      current: '1.10.0',
      latest: '1.11.0',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  const button = findByClass(tree, 'dsa-set-ver-btn')[0]
  assert.ok(button, '有新版时版本小字没有变成按钮')
  // 按钮文案带当前版本与目标版本，用户知道自己从哪更新到哪。
  const label = button.children.join('')
  assert.ok(label.includes('v1.10.0'), `按钮没带当前版本：${label}`)
  assert.ok(label.includes('更新到 1.11.0'), `按钮没带目标版本：${label}`)
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  // 一键更新：POST {action:'update'} 到 manage，不是 window.open 跳 Release 页。
  const post = calls.find(
    (call) =>
      call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes('"action"'),
  )
  assert.ok(post, '点击没有发出更新请求')
  const sent = JSON.parse(String(post.init.body))
  assert.equal(sent.action, 'update', `动作不对：${String(post.init.body)}`)
  const opened = calls.find((call) => call.type === 'open')
  assert.equal(opened, undefined, '仍然跳转了 GitHub')
})

await check('有新版但 link: 安装 → 版本小字保持纯文字（不给更新按钮）', async () => {
  const { render, calls } = await loadClient({
    self: { installed: true, selected: true, spec: 'link:D:/DeepSeek启动动画' },
    update: {
      ok: true,
      current: '1.11.1',
      latest: '1.11.2',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  assert.equal(findByClass(tree, 'dsa-set-ver-btn').length, 0, 'link 安装也给了版本小字更新按钮')
  // 纯文字 span 仍然在，带"更新到"提示（title 里），只是不可点。
  const badge = findAll(tree, 'dsa-set-ver')[0]
  assert.ok(badge, '版本号消失了')
  const post = calls.find(
    (call) =>
      call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes('"action"'),
  )
  assert.equal(post, undefined, 'link 安装发出了更新请求')
})

console.log('== 卸载 / 更新（v1.11.0）==')

await check('没装在 profile 里 → 不显示卸载/更新区', async () => {
  const { render } = await loadClient({ self: { ok: true, installed: false, selected: false } })
  const tree = await render()
  assert.equal(findAll(tree, 'dsa-set-self').length, 0, '不该显示自管区')
})

await check('装在 profile 里 → 显示卸载按钮', async () => {
  const { render } = await loadClient({ self: { ok: true, installed: true, selected: true } })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  assert.ok(panel, '没显示自管区')
  const labels = texts(panel)
  assert.ok(labels.includes('卸载插件'), `没有卸载按钮：${labels.join(' | ')}`)
  // 没有新版本时不该有更新按钮（不给用户一个按了没用的按钮）。
  assert.ok(!labels.some((text) => text.startsWith('更新到')), `不该显示更新按钮：${labels.join(' | ')}`)
})

await check('有新版本 → 同时显示更新按钮', async () => {
  const { render } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    update: {
      ok: true,
      current: '1.10.0',
      latest: '1.11.0',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  const labels = texts(panel)
  assert.ok(labels.includes('更新到 1.11.0'), `没有更新按钮：${labels.join(' | ')}`)
  assert.ok(labels.includes('卸载插件'), '没有卸载按钮')
})

await check('link: 安装（指向源码目录）→ 不显示更新按钮', async () => {
  const { render } = await loadClient({
    self: { installed: true, selected: true, spec: 'link:D:/DeepSeek启动动画' },
    update: {
      ok: true,
      current: '1.11.1',
      latest: '1.11.2',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  assert.ok(panel, '没显示自管区')
  const labels = texts(panel)
  // 开发链接不指向任何版本；用 tgz 覆盖会把链接换成发行包 —— 不是用户想要的。
  assert.ok(!labels.some((text) => text.startsWith('更新到')), `link 安装不该有更新按钮：${labels.join(' | ')}`)
  assert.ok(labels.includes('卸载插件'), '卸载按钮应该照常可用')
})

await check('点卸载 → 先确认，再 POST action=uninstall', async () => {
  const { render, calls } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    selfResult: { ok: true, restartRequired: true, message: '已卸载' },
  })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  // 按钮的 className 有两个类（dsa-set-btn dsa-set-btn-danger），按 class 精确匹配找不到 ——
  // 这里按 class **包含** 找。
  const button = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('卸载插件'))
  assert.ok(button, '找不到卸载按钮')
  button.props.onClick()
  // 确认框要先过。
  const confirmed = calls.find((call) => call.type === 'confirm')
  assert.ok(confirmed, '没有确认就动手了')
  await Promise.resolve()
  await Promise.resolve()
  const post = calls.find(
    (call) => call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes("action"),
  )
  assert.ok(post, '没有发卸载请求')
  const sent = JSON.parse(String(post.init.body))
  assert.equal(sent.action, 'uninstall', `动作不对：${String(post.init.body)}`)
})

await check('用户在确认框点取消 → 不发请求', async () => {
  const { render, calls } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    confirmResult: false,
  })
  const tree = await render()
  const button = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('卸载插件'))
  assert.ok(button, '找不到卸载按钮')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const post = calls.find(
    (call) => call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes("action"),
  )
  assert.equal(post, undefined, '取消后仍然发了请求')
})

await check('点更新 → POST action=update', async () => {
  const { render, calls } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    update: {
      ok: true,
      current: '1.10.0',
      latest: '1.11.0',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
    selfResult: { ok: true, restartRequired: true, message: '已更新' },
  })
  const tree = await render()
  const button = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('更新到 1.11.0'))
  assert.ok(button, '找不到更新按钮')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const post = calls.find(
    (call) => call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes("action"),
  )
  assert.ok(post, '没有发更新请求')
  const sent = JSON.parse(String(post.init.body))
  assert.equal(sent.action, 'update', `动作不对：${String(post.init.body)}`)
})

console.log('== 更新公告 ==')

/** 一份按真实 Release 写法排版的正文：标题、分节、加粗、代码块、安装链接都在里面。 */
const RELEASE_BODY = [
  '## 开机动画 v1.13.0',
  '',
  '公告页签上线。',
  '',
  '### 改了什么',
  '',
  '- 标题旁的版本号点一下就地更新',
  '- **不再跳转** GitHub 手动下载',
  '',
  '```sh',
  'npm i dsh-plugin-startup-animation',
  '```',
  '',
  '### 安装',
  '',
  'https://example.com/dsh-plugin-startup-animation.tgz',
].join('\n')

await check('更新公告页签：渲染 Release 正文，安装段/代码块不进来', async () => {
  const { render, calls } = await loadClient({
    update: {
      ok: true,
      current: '1.12.0',
      latest: '1.13.0',
      reachable: true,
      updateAvailable: true,
      notes: RELEASE_BODY,
    },
  })
  const tree = await render()
  const tab = findAll(tree, 'dsa-set-tab').find((item) => item.children.includes('更新公告'))
  assert.ok(tab, '没有更新公告页签')
  tab.props.onClick()
  const panel = await render()
  // 页面上只有这一个 tabpanel，抬头标出这是哪一版的公告。
  const panels = findAll(panel, 'dsa-set-panel')
  assert.equal(panels.length, 1, `面板数量异常：${panels.length}`)
  assert.equal(panels[0].props['aria-label'], '更新公告')
  const all = texts(panel)
  assert.ok(all.includes('v1.13.0 更新了什么'), `抬头不对：${all.join(' | ')}`)
  assert.ok(
    all.some((text) => text.includes('标题旁的版本号点一下就地更新')),
    `要点没渲染：${all.join(' | ')}`,
  )
  // 加粗符号要去掉（设置页不渲染富文本）。
  assert.ok(all.some((text) => text.includes('不再跳转 GitHub 手动下载')), `加粗没剥干净：${all.join(' | ')}`)
  assert.ok(!all.some((text) => text.includes('**')), '正文里留着 markdown 加粗符号')
  // 安装链接与代码示例属于"怎么装"，不是"这次改了什么"。
  assert.ok(!all.some((text) => text.includes('example.com')), `安装链接混进了公告：${all.join(' | ')}`)
  assert.ok(!all.some((text) => text.includes('npm i ')), `代码块混进了公告：${all.join(' | ')}`)
  // 「安装」小节与 Release 标题行是重复/无关信息：一个被截断，一个被抬头取代。
  assert.ok(!all.some((text) => text === '安装'), `「安装」小节标题混进了公告：${all.join(' | ')}`)
  assert.ok(!all.some((text) => text.includes('开机动画 v1.13.0')), `Release 标题与抬头重复：${all.join(' | ')}`)
  // 公告不是素材分类：切过去就不该再有上传入口，也不该发任何写请求。
  assert.ok(!all.some((text) => text.startsWith('选择文件')), '公告页里还留着上传入口')
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.equal(post, undefined, '切到更新公告不该发写请求')
})

await check('拿不到 Release 正文（离线）→ 公告页只显示"检查不到更新"，不报错', async () => {
  const { render } = await loadClient({
    update: { ok: true, current: '1.12.0', reachable: false, updateAvailable: false, reason: 'network' },
  })
  const tree = await render()
  findAll(tree, 'dsa-set-tab')
    .find((item) => item.children.includes('更新公告'))
    .props.onClick()
  const panel = await render()
  const all = texts(panel)
  assert.ok(all.includes('检查不到更新'), `离线时该是安静的提示：${all.join(' | ')}`)
  // 没有版本号就没有抬头 —— 宁可少一行，也不拼出"v 更新了什么"。
  assert.ok(!all.some((text) => text.includes('v 更新')), `不该出现拼凑的抬头：${all.join(' | ')}`)
})

console.log('')
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('CLIENT TEST PASS')
