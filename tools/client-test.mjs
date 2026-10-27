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
function findAll(node, className) {
  const out = []
  walk(node, (item) => {
    if (item.props && item.props.className === className) out.push(item)
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
    },
    document: { createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {} }) },
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
      return Promise.resolve({ ok: true, json: async () => status })
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
  const restore = findAll(tree, 'dsa-set-btn').find((btn) => btn.children.includes('恢复默认'))
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
  const { render } = await loadClient()
  const tree = await render()
  const badge = findAll(tree, 'dsa-set-ver')[0]
  assert.ok(badge, '没有版本小字')
  assert.ok(
    badge.children.some((child) => typeof child === 'string' && child.includes('1.10.0')),
    `版本小字没有版本号：${JSON.stringify(badge.children)}`,
  )
})

await check('有新版时版本小字可点开 Release 页', async () => {
  const { render, calls } = await loadClient({
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
  const button = findAll(tree, 'dsa-set-ver-btn')[0]
  assert.ok(button, '有新版时版本小字不可点')
  button.props.onClick()
  const opened = calls.find((call) => call.type === 'open')
  assert.ok(opened, '点击没有打开 Release 页')
  assert.ok(String(opened.args[0]).endsWith('/releases'))
})

console.log('')
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('CLIENT TEST PASS')
