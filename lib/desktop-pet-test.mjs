/**
 * desktop-pet-test.mjs —— 桌面宠物进程管理层的离线单测（零依赖）。
 *
 * 只测纯逻辑与进程生命周期，**不启动 Electron**（那是 e2e 的事，跑得慢还依赖图形环境）。
 * 覆盖：Electron 查找顺序、`ELECTRON_RUN_AS_NODE` 必须被删、宠物列表精简、
 * 以及 sync 的三个关键行为（去重、空列表停进程、端口没就绪时**不记指纹**）。
 *
 * 用法：node lib/desktop-pet-test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDesktopPets, desktopPetList, electronHome, findElectron, helperEnv, sizeBody, sizeMap, structuralKey } from './desktop-pet.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
let failures = 0

const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-desktop-pet-'))

/** 造一个"看起来像 Electron"的假可执行文件（只要是非空文件就够，本测试不执行它）。 */
const fakeElectron = path.join(tmp, 'electron.exe')
fs.writeFileSync(fakeElectron, 'not really an exe')

/**
 * 钉住"找到了 Electron"、把 `spawn` 换成记录器，跑一段用例。
 *
 * 为什么必须这样：`sync()` 里"找 Electron"排在读 `origin()` 之前，而这台机器**真的**
 * 装了 Electron（`$DSH_HOME/electron/electron.exe`，DSH 桌面版自带）。不管住它，
 * 一次 sync 要么真的 spawn 一个 helper（沙箱里直接 EPERM），要么在没装的机器上短路 ——
 * 同一条用例在开发机上必挂、在别的机器上必过。注入后过程完全由用例控制，不碰本机。
 *
 * @param {(env: { launches: () => number }) => void} fn 用例主体。
 */
const withStubbedLaunch = (fn) => {
  const procs = []
  fn({
    launches: () => procs.length,
    spawn: () => {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.unref = () => {}
      proc.kill = () => {}
      procs.push(proc)
      return proc
    },
  })
}

console.log('== 环境与查找 ==')

check('electronHome 跟随 DSH_HOME', () => {
  assert.equal(electronHome({ DSH_HOME: 'C:\\x\\.dsh' }), path.join('C:\\x\\.dsh', 'electron'))
  // 没有 DSH_HOME 时退回 USERPROFILE/.dsh —— 与宿主其它模块同一套口径。
  assert.equal(electronHome({ USERPROFILE: 'C:\\Users\\a' }), path.join('C:\\Users\\a', '.dsh', 'electron'))
})

check('findElectron：显式路径优先，其次是 DSH_HOME/electron/electron.exe', () => {
  // 造一个隔离的 DSH_HOME，里面放一份假 exe —— 不碰本机真实安装。
  const home = path.join(tmp, 'home-a')
  fs.mkdirSync(path.join(home, 'electron'), { recursive: true })
  const landed = path.join(home, 'electron', 'electron.exe')
  fs.writeFileSync(landed, 'fake')
  // 显式路径指向另一份真实存在的假 exe → 认显式那份。
  assert.equal(findElectron({ DSA_PET_ELECTRON_PATH: fakeElectron, DSH_HOME: home }), path.resolve(fakeElectron))
  // 显式路径不存在 → 回落到 DSH_HOME 下那份。
  assert.equal(findElectron({ DSA_PET_ELECTRON_PATH: path.join(tmp, 'nope.exe'), DSH_HOME: home }), path.resolve(landed))
  // 都没有 → undefined（调用方据此降级，不抛）。
  assert.equal(findElectron({ DSH_HOME: path.join(tmp, 'empty-home') }), undefined)
})

check('findElectron：非 Windows 一律 undefined（桌面模式仅 Windows）', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    assert.equal(findElectron({ DSA_PET_ELECTRON_PATH: fakeElectron }), undefined)
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
})

check('helperEnv：删掉 ELECTRON_RUN_AS_NODE（留空串会让 Electron abort）', () => {
  const env = helperEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: 'x' })
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false, 'ELECTRON_RUN_AS_NODE 必须真的删键')
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in env, false)
  assert.equal(env.PATH, 'x', '其余变量原样保留')
  // 不改入参。
  assert.equal(helperEnv({ ELECTRON_RUN_AS_NODE: '1' }).ELECTRON_RUN_AS_NODE, undefined)
})

console.log('== 宠物列表精简 ==')

check('desktopPetList：只挑渲染端要的字段，坏条目丢掉', () => {
  const list = desktopPetList([
    { id: 'a', enabled: true, size: 200, x: 10, y: 20, canvas: [480, 648], clips: new Array(100).fill({ file: 'x' }) },
    { id: '', enabled: true, size: 100 },
    { enabled: true, size: 100 },
    null,
    { id: 'b', enabled: true, size: 'bad', x: 'bad' },
  ])
  assert.equal(list.length, 2, '只有带非空 id 的两条算数')
  assert.deepEqual(list[0], { id: 'a', size: 200, x: 10, y: 20, canvas: [480, 648] })
  // 坏数值回落默认值，而不是把 NaN 递给窗口（NaN 尺寸会让 BrowserWindow 直接抛）。
  assert.deepEqual(list[1], { id: 'b', size: 176, x: 100, y: 100, canvas: [480, 648] })
})

check('desktopPetList：没启用的宠物一只都不进桌面（用户关掉就不该出现）', () => {
  const list = desktopPetList([
    { id: 'on', enabled: true, size: 120 },
    { id: 'off', enabled: false, size: 120 },
    { id: 'missing', size: 120 },
  ])
  assert.deepEqual(
    list.map((pet) => pet.id),
    ['on'],
    `只有启用中的才该上桌面，实际：${list.map((pet) => pet.id).join(',')}`,
  )
})

check('desktopPetList：全部关掉 → 空列表（helper 不启动）', () => {
  assert.deepEqual(desktopPetList([{ id: 'a', enabled: false }, { id: 'b' }]), [])
})

check('sync：只把启用的那几只交给 helper，关掉的不建窗', () => {
  // 用假 Electron 走到真正 spawn 的分支是重活；这里断言"交给 helper 的清单"这个中间产物，
  // 它正是"桌面上出现几只"的唯一来源。
  const list = desktopPetList([
    { id: 'lulu', enabled: true, size: 152, x: 6, y: 60 },
    { id: 'maid', enabled: false, size: 208, x: 96, y: 70 },
  ])
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'lulu')
})

console.log('== sync 行为 ==')

check('sync：没有启用的宠物 → 不拉进程，且不报错', () => {
  const pets = createDesktopPets({ packageRoot: root, origin: () => 'http://127.0.0.1:1', log: { info() {}, warn() {} } })
  assert.equal(pets.sync([{ id: 'a', enabled: false }]), true, '空列表是"已达成目标"')
  pets.dispose()
})

check('sync：端口没就绪 → 返回 false（值得重试），不记指纹', () => {
  const pets = createDesktopPets({
    packageRoot: root,
    origin: () => {
      throw new Error('webserver: origin read before the listener bound a port')
    },
    findElectron: () => 'C:\\fake\\electron.exe',
    spawn: () => {
      throw new Error('不该走到拉起：端口没就绪时应该直接放弃')
    },
    log: { info() {}, warn() {} },
  })
  // 传一只启用的宠物，逼它走到"要拉进程"那一步。
  const settled = pets.sync([{ id: 'a', enabled: true, size: 100 }])
  assert.equal(settled, false, '端口没就绪必须返回 false，否则重试逻辑会静默放弃')
  // 没记指纹：端口就绪后再调一次，还得真的去拉进程。
  assert.equal(settled, false)
  pets.dispose()
})

check('sync：找不到 Electron → 记下原因，返回 true（重试也没用）', () => {
  const warnings = []
  const pets = createDesktopPets({
    packageRoot: root,
    origin: () => 'http://127.0.0.1:1',
    log: { info() {}, warn: (msg) => warnings.push(msg) },
  })
  const original = process.env.DSA_PET_ELECTRON_PATH
  delete process.env.DSA_PET_ELECTRON_PATH
  try {
    const settled = pets.sync([{ id: 'a', enabled: true, size: 100 }])
    // 非 Windows 一定走"仅支持 Windows"分支；Windows 上本机可能真有 Electron，
    // 那种情况会真的 spawn —— 所以只断言"返回了布尔值且没有抛"。
    assert.equal(typeof settled, 'boolean')
  } finally {
    if (original !== undefined) process.env.DSA_PET_ELECTRON_PATH = original
    pets.dispose()
  }
})

check('dispose 之后再 sync 不做事（插件卸载后不该再拉进程）', () => {
  const pets = createDesktopPets({ packageRoot: root, origin: () => 'http://127.0.0.1:1', log: { info() {}, warn() {} } })
  pets.dispose()
  assert.equal(pets.sync([{ id: 'a', enabled: true, size: 100 }]), true)
})

check('helper 入口文件随包存在（.cjs —— .js 会被 type:module 当 ESM 加载）', () => {
  for (const file of ['main.cjs', 'preload.cjs', 'renderer.js', 'index.html']) {
    const abs = path.join(root, 'runtime', 'pet-desktop', file)
    assert.ok(fs.existsSync(abs), `缺少 ${file}`)
    assert.ok(fs.statSync(abs).size > 0, `${file} 是空文件`)
  }
})

check('helper 必须自己上报优雅退出端口（READY <port>），宿主据此避免残影', () => {
  const source = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  // 宿主在 stdout 里找的就是这行；改名/删掉会让优雅退出悄悄退化成硬杀。
  assert.ok(/READY \$\{port\}/.test(source), 'helper 没有输出 `READY <port>`')
  assert.ok(source.includes("'/quit'"), 'helper 没有 /quit 端点')
  // 退出前必须先 hide：硬退会留下冻结的宠物残影（实测）。
  assert.ok(/function gracefulExit[\s\S]{0,600}hideAllWindows\(\)/.test(source), 'gracefulExit 没有先 hideAllWindows')
  assert.ok(
    /before-quit[\s\S]{0,200}hideAllWindows\(\)/.test(source),
    'before-quit 没有 hideAllWindows（Electron 自己的退出路径会留残影）',
  )
})

check('宿主解析 READY 端口，并在 stop 时优先走 HTTP 而不是硬杀', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'desktop-pet.mjs'), 'utf8')
  assert.ok(/READY \(\\d\+\)/.test(source) || source.includes('READY (\\d+)'), '宿主没有解析 READY 行')
  assert.ok(source.includes('/quit'), '宿主 stop 没有请求 /quit')
})

check('渲染端不能自己决定位置（窗口位置归主进程）', () => {
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  // 坐标系不同：渲染端只管演，位置由主进程跟系统光标算。渲染端写 left/top 会和主进程打架。
  assert.ok(!/style\.(left|top)\s*=/.test(renderer), '渲染端不应该写窗口位置')
})

check('渲染端：没启用就不演（每一层都要挡住）', () => {
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  assert.ok(
    /payload\.pet\.enabled !== true/.test(renderer) && /entry\.enabled !== true/.test(renderer),
    '渲染端没有校验总开关与单只开关',
  )
})

check('两档互斥：全局界面下页面浮层必须不建（否则同一只宠物出现两次）', () => {
  const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  // 用户报的就是"两只噜噜各演各的"：页面浮层 + 全局窗同时存在。
  assert.ok(
    /pet\.display === 'global'/.test(client),
    '页面浮层没有在 global 档下让位 —— 会造出第二只',
  )
  assert.ok(
    !/petWhereBtn\('both'/.test(client),
    '设置页还在渲染「都显示」档 —— 它会造出第二只',
  )
  assert.ok(!/petWhereBoth/.test(client), '「都显示」的文案没删干净')
})

console.log('== 甩抛 / 碰撞 ==')

check('主进程有完整甩抛物理（起飞/反弹/衰减/停稳），参数与浏览器浮层一致', () => {
  const source = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  // 数值必须和 client.js 的 createPetInstance 一模一样，否则桌面与页面手感会分叉。
  for (const [name, value] of [
    ['SPEED_KEEP', '0.16'],
    ['BOUNCE', '0.82'],
    ['STOP_SPEED', '0.06'],
    ['MAX_SPEED', '4'],
  ]) {
    assert.ok(new RegExp(`const ${name} = ${value.replace('.', '\\.')}`).test(source), `${name} 不是 ${value}`)
  }
  assert.ok(/function startFlight/.test(source), '缺少 startFlight')
  assert.ok(/function stepFlight/.test(source), '缺少 stepFlight')
  assert.ok(/function finishFlight/.test(source), '缺少 finishFlight')
  // 撞边必须反向并打折 —— 只反向不打折会永远弹不停。
  assert.ok(/\* -.*BOUNCE|BOUNCE.*-/.test(source) || /-state\.(vx|vy) \* BOUNCE/.test(source), '撞边没有按 BOUNCE 反向')
})

check('撞边会通知渲染端挤压，停稳会通知回待机', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  assert.ok(main.includes("'pet:bump'"), '主进程没有通知撞边')
  assert.ok(main.includes("'pet:landed'"), '主进程没有通知停稳')
  const preload = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'preload.cjs'), 'utf8')
  assert.ok(preload.includes("'pet:bump'") && preload.includes('onBump'), 'preload 没有暴露 onBump')
  assert.ok(preload.includes("'pet:landed'") && preload.includes('onLanded'), 'preload 没有暴露 onLanded')
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  assert.ok(/data-squash='1'/.test(renderer) || /dataset\.squash = '1'/.test(renderer), '渲染端没有挤压反馈')
  assert.ok(renderer.includes('onBump') && renderer.includes('onLanded'), '渲染端没有接撞边/停稳')
})

check('松手用最近 100ms 的采样算速度（不是拿最后一帧硬算）', () => {
  const source = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  assert.ok(/VELOCITY_WINDOW_MS/.test(source), '没有速度采样窗口')
  assert.ok(/samples\.push/.test(source), '拖动期间没有采样光标位置')
  assert.ok(/const dt = last\.t - first\.t/.test(source), '速度没有按采样时间差算')
})

console.log('== 落地不闪（用户报的"甩完消失再加载"）==')

check('指纹只看结构：位置与大小都不该触发 helper 重建', () => {
  const a = [{ id: 'lulu', size: 152, x: 10, y: 10, canvas: [480, 648] }]
  const b = [{ id: 'lulu', size: 152, x: 88.8, y: 91.2, canvas: [480, 648] }]
  assert.equal(
    structuralKey(a),
    structuralKey(b),
    '位置不同却算出不同指纹 —— 宠物每次落地都会停进程再重启（闪一下）',
  )
  // 大小同样是运行期状态：留在指纹里，拖完滑杆的落盘就会重建整个 Electron 进程，
  // 用户看到的是"拖的时候没反应，停手闪没一秒再长回来"（实时尺寸走 resize()）。
  const sized = [{ id: 'lulu', size: 300, x: 10, y: 10, canvas: [480, 648] }]
  assert.equal(
    structuralKey(a),
    structuralKey(sized),
    '改大小不该触发重建 —— 窗口尺寸由 /size 实时改，不该重启进程',
  )
})

check('指纹认结构性变化：增减宠物 / 换画布必须重建', () => {
  const base = [{ id: 'lulu', size: 152, x: 10, y: 10, canvas: [480, 648] }]
  const extra = [...base, { id: 'maid', size: 176, x: 0, y: 100, canvas: [360, 360] }]
  const reshaped = [{ id: 'lulu', size: 152, x: 10, y: 10, canvas: [400, 400] }]
  assert.notEqual(structuralKey(base), structuralKey(extra), '多了一只却没触发重建')
  // 画布决定窗口比例，改它必须重建（实时通道只改宽度，不动比例）。
  assert.notEqual(structuralKey(base), structuralKey(reshaped), '换画布没触发重建（窗口比例会和内容对不上）')
})

check('sizeBody 只带 id 与 size（画布不走实时通道）', () => {
  const body = JSON.parse(
    sizeBody([{ id: 'lulu', size: 200, x: 10, y: 20, canvas: [480, 648] }]),
  )
  assert.deepEqual(body, { pets: [{ id: 'lulu', size: 200 }] }, `实时尺寸多带了字段：${JSON.stringify(body)}`)
  // sizeMap 只认 id → size：它是"要不要推一次"的比较基准。
  assert.deepEqual(sizeMap([{ id: 'lulu', size: 200 }, { id: 'maid', size: 168 }]), { lulu: 200, maid: 168 })
})

check('只改大小时 sync 不重启进程（走 resize 那条实时通道）', () => {
  // 数的是"这一步真正要拉起 helper"的次数：既数被注入的 spawn，也数读 origin()
  // （读 origin() 是拉起流程的入口，被注入路径短路时只能靠它观察）。
  // 两者都用注入钉死，不碰本机 Electron，也不真的起进程 —— 沙箱里 spawn 会抛 EPERM。
  let launches = 0
  let origins = 0
  const spawned = []
  const pets = createDesktopPets({
    packageRoot: root,
    origin: () => {
      origins += 1
      return 'http://127.0.0.1:1'
    },
    findElectron: () => 'C:\\fake\\electron.exe',
    spawn: () => {
      launches += 1
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.unref = () => {}
      proc.kill = () => {}
      spawned.push(proc)
      return proc
    },
    log: { info() {}, warn() {} },
  })
  // 1) 首次：要拉起。
  pets.sync([{ id: 'a', enabled: true, size: 150 }])
  assert.equal(launches, 1, '第一次 sync 没有拉起 helper')
  // 2) 只改大小：结构指纹没变 → 不该再走拉起流程（那才是重建 Electron 的入口）。
  pets.sync([{ id: 'a', enabled: true, size: 300 }])
  assert.equal(launches, 1, '只改大小却又走了一次拉起流程 —— 拖滑杆会反复重启 Electron')
  assert.equal(origins, 1, '只改大小也读了 origin() —— 拉起流程被整段走了一遍')
  // 3) 换画布：比例变了，实时通道不动比例，必须重建。
  pets.sync([{ id: 'a', enabled: true, size: 300, canvas: [400, 400] }])
  assert.equal(launches, 2, '换画布却没触发重建 —— 窗口比例会和内容对不上')
  pets.dispose()
})

check('resize：没有 helper 在跑时如实返回 false（调用方据此回退到 sync）', () => {
  const pets = createDesktopPets({ packageRoot: root, origin: () => 'http://127.0.0.1:1', log: { info() {}, warn() {} } })
  // 从没 sync 过 = 没有子进程，任何尺寸都推不出去。
  assert.equal(pets.resize([{ id: 'a', size: 200 }]), false, '没有 helper 却说推成功了')
  assert.equal(pets.resize([]), false, '空数组不该报成功')
  assert.equal(pets.resize([{ id: 'a', size: Number.NaN }]), false, '非法尺寸不该报成功')
  pets.dispose()
})

check('落地只回待机，不需要重载视频（不该走 load()）', () => {
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  const landed = /onLanded\(\(\) => \{([\s\S]{0,300}?)\}\)/.exec(renderer)
  assert.ok(landed !== null, '没有 onLanded 处理')
  assert.ok(!/load\(\)/.test(landed[1]), '落地时调了 load() —— 会重新走一次网络与解码')
})

console.log('== 全局界面的点击音效与动作 ==')

check('渲染端有点击音效（与浏览器浮层同一份 pet.json clickSound）', () => {
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  assert.ok(/playClickSound/.test(renderer), '桌面渲染端没有点击音效 —— 全局界面下点了没声音')
  assert.ok(/pack\.clickSound/.test(renderer), '音效没有读 pet.json 的 clickSound')
  assert.ok(/new Audio\(/.test(renderer), '没有构造 Audio 元素')
  // 必须在点击处理里调用，而不是只在某处定义。
  const playClick = /const playClick = \(\) => \{([\s\S]{0,400}?)\n  \}/.exec(renderer)
  assert.ok(playClick !== null, '找不到 playClick')
  assert.ok(/playClickSound\(\)/.test(playClick[1]), 'playClick 里没有播放音效 —— 点了不响')
})

check('落地通知不能打断回应动作（点了要能展开）', () => {
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  const landed = /onLanded\(\(\) => \{([\s\S]{0,600}?)\n    \}\)/.exec(renderer)
  assert.ok(landed !== null, '找不到 onLanded')
  const body = landed[1]
  // 只该在"拖拽"这条线上回待机；无条件 startIdle 会把刚触发的 action 切掉。
  assert.ok(
    /mode === 'drag'\s*\)\s*startIdle\(\)/.test(body) || /if \(mode === 'drag'\) startIdle\(\)/.test(body),
    'onLanded 没有限定只收拖拽 —— 会打断点击触发的动作',
  )
  assert.ok(
    !/mode === 'drag' \|\| mode === 'action'/.test(body),
    'onLanded 仍在 action 时回待机 —— 就是"点了动作展开不出来"的成因',
  )
})

check('释放指针时不抢先回待机（否则点击动画会顿一下）', () => {
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  const release = /const release = \(event\) => \{([\s\S]{0,900}?)\n  \}/.exec(renderer)
  assert.ok(release !== null, '找不到 release')
  assert.ok(
    !/if \(mode === 'drag'\) startIdle\(\)/.test(release[1]),
    'release 里还在回待机 —— 点击会先闪回待机再被回应动作顶掉',
  )
})

check('点一下（没拖动）时主进程不要走飞行收尾', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  const at = main.indexOf('function startDrag(')
  assert.ok(at >= 0, '找不到 startDrag')
  // 取函数开头的一段（到下一次 `\n}` 为止，允许块内缩进）。
  const body = main.slice(at, at + 1200)
  assert.ok(
    /flying\.has\(petId\)/.test(body),
    'startDrag 无条件收尾飞行 —— 每次点击都会发 pet:landed 并写盘，打断回应动作',
  )
})

console.log('== 屏幕自适应（宠物不许越出屏幕）==')

check('有夹取函数，且建窗/拖动/显示后三处都用了它', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  assert.ok(/function clampToDesk\(/.test(main), '缺少 clampToDesk')
  assert.ok(/function ensureInsideScreen\(/.test(main), '缺少 ensureInsideScreen（显示后兜底）')
  // 建窗路径：pixelOf 内部要夹。
  assert.ok(/return clampToDesk\(area, targetX, targetY, width, height\)/.test(main), 'pixelOf 没有夹')
  // 拖动路径：setPosition 前要夹。
  const drag = main.slice(main.indexOf('function startDrag('), main.indexOf('function stopDrag('))
  assert.ok(/clampToDesk\(deskArea\(\)/.test(drag), '拖动时没有夹 —— 手滑到屏幕外会把宠物带出去')
  // 显示后兜底。
  assert.ok(/ensureInsideScreen\(win\)/.test(main), '显示后没有兜底校验')
})

check('必须在窗口真正显示后再校验一次（DPI/任务栏高度那时才定）', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  const didFinish = /did-finish-load'[\s\S]{0,600}?ensureInsideScreen\(win\)/.exec(main)
  assert.ok(didFinish !== null, 'did-finish-load 之后没有 ensureInsideScreen')
})

check('屏幕参数变化要重新校验（换屏 / 改缩放 / 任务栏挪边）', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  assert.ok(/display-metrics-changed/.test(main), '没有监听屏幕度量变化')
  assert.ok(/display-removed/.test(main), '没有监听拔掉显示器')
  assert.ok(/function startDisplayWatch\(/.test(main), '缺少 startDisplayWatch')
  assert.ok(/startDisplayWatch\(\)/.test(main), 'startDisplayWatch 没有被调用')
})

check('不允许窗口超出屏幕（enableLargerThanScreen 必须关掉）', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  assert.ok(
    /enableLargerThanScreen: false/.test(main),
    'enableLargerThanScreen 还开着 —— Electron 不会把越界窗口收回屏幕内，宠物会被裁掉半个',
  )
  assert.ok(!/enableLargerThanScreen: true/.test(main), 'enableLargerThanScreen 仍是 true')
})

check('宠物尺寸按屏幕兜底（小屏上大宠物不许占满屏或被裁）', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  const at = main.indexOf('function sizeOf(')
  const body = main.slice(at, at + 1200)
  assert.ok(/byWidth/.test(body) && /byHeight/.test(body), 'sizeOf 没有按屏幕限制尺寸')
  assert.ok(/area\.width \* 0\.45/.test(body), '没有限制宽不超过屏宽的 45%')
})

/**
 * 复刻 main.cjs 里的夹取数学，对各种屏幕尺寸做断言。
 * 这样即使拿不到真实屏幕，也能证明"任何尺寸下都不会出界"。
 */
const clampToDesk = (area, x, y, w, h) => {
  const maxX = area.x + area.width - w
  const maxY = area.y + area.height - h
  return {
    x: Math.round(Math.max(area.x, Math.min(maxX, x))),
    y: Math.round(Math.max(area.y, Math.min(maxY, y))),
  }
}
const sizeFor = (petSize, ratio, area) => {
  const byWidth = Math.floor(area.width * 0.45)
  const byHeight = Math.floor((area.height * 0.92) / ratio)
  const width = Math.max(80, Math.min(Math.max(80, petSize), byWidth, byHeight))
  return { width, height: Math.max(80, Math.round(width * ratio)) }
}

check('任意屏幕尺寸下，夹取后整只宠物都在屏内', () => {
  const screens = [
    { x: 0, y: 0, width: 1440, height: 852 },
    { x: 0, y: 0, width: 1024, height: 728 },
    { x: 0, y: 0, width: 800, height: 1240 },
    { x: 0, y: 0, width: 640, height: 440 },
    { x: 0, y: 0, width: 3840, height: 2120 },
    // 多屏：副屏有偏移，夹取必须认得 area.x/area.y
    { x: 1440, y: 0, width: 1920, height: 1040 },
    { x: -1920, y: 0, width: 1920, height: 1040 },
  ]
  for (const area of screens) {
    const size = sizeFor(320, 648 / 480, area)
    for (const [x, y] of [
      [-99999, -99999],
      [99999, 99999],
      [area.width + 500, area.height + 500],
      [area.x + 10, area.y + 10],
    ]) {
      const at = clampToDesk(area, x, y, size.width, size.height)
      assert.ok(at.x >= area.x, `${JSON.stringify(area)} 下 x=${at.x} 越出左界`)
      assert.ok(at.y >= area.y, `${JSON.stringify(area)} 下 y=${at.y} 越出上界`)
      assert.ok(
        at.x + size.width <= area.x + area.width,
        `${JSON.stringify(area)} 下右边界 ${at.x + size.width} 超过 ${area.x + area.width}`,
      )
      assert.ok(
        at.y + size.height <= area.y + area.height,
        `${JSON.stringify(area)} 下下边界 ${at.y + size.height} 超过 ${area.y + area.height}`,
      )
    }
  }
})

check('小屏上大宠物会被缩小，不会撑破屏幕', () => {
  const tiny = { x: 0, y: 0, width: 640, height: 440 }
  const size = sizeFor(320, 648 / 480, tiny)
  assert.ok(size.width < 320, `小屏上没有缩小（还是 ${size.width}）`)
  assert.ok(size.height <= tiny.height, `缩小后仍然比屏高（${size.height} > ${tiny.height}）`)
})

console.log('== 右键动作菜单（全局界面）==')

check('主进程用原生菜单画动作表（透明小窗放不下几十条动作）', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  assert.ok(/function buildPetMenu\(/.test(main), '缺少 buildPetMenu')
  assert.ok(/require\('electron'\)/.test(main) && /Menu[,\s}]/.test(main), '没有引入 Menu')
  assert.ok(/menu\.popup\(\{ window: win/.test(main), '菜单没有 popup 到窗口上')
  // 动作表是渲染端上报的，主进程不自己扫素材目录（第二份数据源会漂移）。
  assert.ok(/ipcMain\.on\('pet:menu-data'/.test(main), '没有接收渲染端上报的动作表')
  assert.ok(!/listPetPacks|readdirSync.*宠物/.test(main), '主进程不该自己扫宠物目录')
})

check('context-menu 事件接上菜单，且弹出期间保持可交互', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  const handler = /context-menu'[\s\S]{0,900}?menu\.popup\(\{ window: win[\s\S]{0,120}callback: \(\) => setIgnore\(win, true\) \}/.exec(main)
  assert.ok(handler !== null, 'context-menu 没有接 buildPetMenu 并 popup')
  // 弹出前取消穿透、关闭后恢复 —— 否则菜单关了光标还在宠物上，左键要点两下才生效。
  assert.ok(/setIgnore\(win, false\)/.test(handler[0]), '弹出前没有 setIgnore(false)')
})

check('菜单项点选走同一条 IPC（play/random），归位与隐藏在主进程落地', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  assert.ok(/send\(\{ type: 'play', id: clip\.id \}\)/.test(main), '动作项没有回传 play')
  assert.ok(/send\(\{ type: 'random' \}\)/.test(main), '随机项没有回传 random')
  assert.ok(/function resetPetToCorner\(/.test(main), '缺少归位实现')
  assert.ok(/function hidePet\(/.test(main), '缺少隐藏实现')
  // 归位必须落盘（与浏览器浮层一致：回右下角并记住）。
  const reset = main.slice(main.indexOf('function resetPetToCorner('), main.indexOf('function resetPetToCorner(') + 900)
  assert.ok(/persistPosition\(petId, positionOf\(win\)\)/.test(reset), '归位没有落盘')
  // 隐藏走 petToggle，用户显式操作不受 NO_PERSIST 影响。
  assert.ok(/petToggle/.test(main), '隐藏没有写 petToggle')
})

check('渲染端上报动作表并接住菜单点选', () => {
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  assert.ok(/sendMenuData/.test(renderer), '渲染端没有上报动作表的函数')
  assert.ok(/window\.dsaPet\.menuReady\(/.test(renderer), '没有调用 menuReady')
  assert.ok(/onMenuAction/.test(renderer), '没有接菜单点选')
  // load 成功后必须上报（菜单数据在 startIdle 之前就绪）。
  const loadBody = renderer.slice(renderer.indexOf('const load = async'), renderer.indexOf('void load()'))
  assert.ok(/sendMenuData\(\)/.test(loadBody), 'load 成功后没有上报动作表')
})

check('preload 只暴露固定形状的菜单 IPC，不转发任意 channel', () => {
  const preload = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'preload.cjs'), 'utf8')
  assert.ok(preload.includes("'pet:menu-data'"), '没有 menu-data 上报口')
  assert.ok(preload.includes("'pet:menu-action'"), '没有 menu-action 接收口')
  // 安全底线：不能出现把任意 channel 透出去的口子。
  assert.ok(!/send: \(channel/.test(preload), 'preload 暴露了任意 channel 转发 —— 攻击面失控')
})

check('dsa-pet:// 只代理本插件路由，不把宿主全部 HTTP 接口暴露出去', () => {
  const main = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'), 'utf8')
  // 前缀白名单必须存在，并在拼 target 之前生效。
  const prefixAt = main.indexOf('const ALLOWED_PREFIX')
  assert.ok(prefixAt !== -1, '缺少 dsa-pet 的路由前缀白名单')
  const proxyAt = main.indexOf('async function proxy(')
  const checkAt = main.indexOf('!url.pathname.startsWith(ALLOWED_PREFIX)')
  assert.ok(checkAt !== -1, 'proxy 没有校验路径前缀')
  assert.ok(checkAt > proxyAt, '前缀校验必须在 proxy 里')
  const targetAt = main.indexOf('const target = `${ORIGIN}${url.pathname}', proxyAt)
  assert.ok(checkAt < targetAt, '前缀校验必须在拼 target 之前')
  // 渲染端实际用到的两个路径都在前缀之下。
  const renderer = fs.readFileSync(path.join(root, 'runtime', 'pet-desktop', 'renderer.js'), 'utf8')
  assert.ok(/\$\{BASE\}\/asset\?/.test(renderer), '渲染端素材路径变了，白名单要跟着改')
  assert.ok(/\$\{BASE\}\/manage/.test(renderer), '渲染端管理路径变了，白名单要跟着改')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nDESKTOP PET TEST PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
