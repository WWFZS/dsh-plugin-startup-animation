'use strict'
/**
 * 桌面宠物 Helper 主进程（仅 Windows）。
 *
 * 一只宠物 = 一块透明置顶小窗，浮在所有应用窗口之上（浏览器、微信、资源管理器都一样）。
 * 它不往任何应用里注入内容——那在 OS 层做不到；能做到的是"盖在上面"。
 *
 * 三条必须成立的约束（都是实测出来的，别按直觉改）：
 *   ① 透明分层窗在 Windows DWM 下必须关硬件加速，否则拖动时四周出黑边；
 *   ② 默认整窗点击穿透，否则宠物那块区域会吃掉别的应用的点击；命中判定靠
 *      60ms 光标轮询（`forward: true` 的鼠标钩子在本机不可靠）；
 *   ③ 被 `ELECTRON_RUN_AS_NODE=1` 拉起时内置 electron 模块不注册，宿主 spawn 前必须删掉它。
 *
 * 与宿主的通道：`dsa-pet://` 自定义协议，把渲染端的请求原样转给 DSH 自己的 webServer。
 * 走协议而不是直连 HTTP，是因为渲染端页面是 file:// 源，直连会被 CORS 挡掉。
 *
 * @module runtime/pet-desktop/main
 */
let electronApi
try {
  electronApi = require('electron')
} catch (error) {
  process.stderr.write(
    '[dsa-pet-desktop] 启动失败：本进程被以纯 Node 模式拉起（ELECTRON_RUN_AS_NODE=' +
      JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
      '）。宿主 spawn 前必须删除该变量。原始错误：' +
      (error instanceof Error ? error.message : String(error)) +
      '\n',
  )
  process.exit(3)
}

const { app, BrowserWindow, ipcMain, screen, protocol, net, Menu } = electronApi
const path = require('node:path')

/** DSH 自己的 Web 服务源（宿主注入）。 */
const ORIGIN = String(process.env.DSA_PET_ORIGIN || 'http://127.0.0.1:3080').replace(/\/+$/, '')

/** 本插件在宿主上注册的路由前缀。 */
const ROUTE = '/dsh-startup-animation'

/** 要建的宠物窗：`[{ id, size, x, y, canvas:[w,h] }]`。空数组 = 不建窗。 */
const PETS = (() => {
  try {
    const parsed = JSON.parse(process.env.DSA_PET_PETS || '[]')
    if (!Array.isArray(parsed)) return []
    // 宿主已经只传启用的那几只了，这里再挡一道：**桌面上只该出现用户开着的那几只**。
    // 任何绕过宿主筛选的路径（手工设环境变量、旧宿主、调试脚本）都不该凭空多出一只。
    return parsed.filter((pet) => pet !== null && typeof pet === 'object' && typeof pet.id === 'string' && pet.id !== '')
  } catch {
    return []
  }
})()

/** 宿主进程号：它一死，本进程立刻退，绝不留僵尸窗。 */
const HOST_PID = Number(process.env.DSA_PET_HOST_PID || 0)

const HELPER_DIR = __dirname

/** 命中判定的轮询间隔（ms）：穿透窗收不到鼠标事件，只能问系统光标。 */
const POINTER_POLL_MS = 60
/** 置顶看门狗的间隔（ms）：WS_EX_TOPMOST 只是样式位，不代表真在置顶带。 */
const TOPMOST_TICK_MS = 4000
/** 拖动跟随的帧间隔（ms）。 */
const DRAG_TICK_MS = 16
/** 拖动位移小于这个像素数就算点击，不算拖拽。 */
const TAP_SLOP = 4

/**
 * 甩抛物理：与浏览器浮层（client.js 的 createPetInstance）同一套手感，只是把
 * "改 CSS left/top" 换成"移窗口"。
 *
 * 四个数值都是手调的，不是物理常数：
 * - `SPEED_KEEP` 每秒保留多少速度，决定"能飞多远、弹几下"；
 * - `BOUNCE` 撞墙后保留多少速度（0.82 ≈ 撞五次还剩三成，弹得很"活"）；
 * - `STOP` 低于这个速度（px/ms）就算停了，避免无限拖一条零头在飘；
 * - `MAX` 速度上限，防止一次抽搐把宠物甩到屏幕另一头。
 *
 * 另外两个是手感细节：采样窗口（松手前停住不动就不该起飞）与撞墙挤压反馈的时长。
 */
const SPEED_KEEP = 0.16
const BOUNCE = 0.82
const STOP_SPEED = 0.06
const MAX_SPEED = 4
const VELOCITY_WINDOW_MS = 100
/** 飞行推进间隔（约 60fps）。窗口位移比 DOM 贵，不再往上加。 */
const FLIGHT_TICK_MS = 16

/** petId -> 飞行状态 `{ vx, vy, last, timer }` */
const flying = new Map()
/** petId -> 渲染端回报的演出状态（只给测试钩子读）。 */
const renderState = new Map()
/**
 * petId -> 菜单结构（`{ categories: [{name, clips:[{id,name}]}] }`）。
 *
 * 为什么由渲染端上报而不是主进程自己算：动作表（分类、动作名）来自宿主的
 * `/manage`，只有渲染端取过那份配置。主进程只拿到宠物 id/尺寸/位置 ——
 * 再抄一份扫描逻辑就是第二份数据源，素材一改两边就漂移。
 */
const menuData = new Map()

/** 菜单文案：跟随系统语言（桌宠用户以中文为主，非中文系统给英文）。 */
const MENU_LABELS = (() => {
  const zh = String((app.getLocale && app.getLocale()) || '').toLowerCase().startsWith('zh')
  return {
    random: zh ? '随机一个' : 'Random',
    reset: zh ? '归位' : 'Reset position',
    hide: zh ? '隐藏' : 'Hide',
  }
})()

/**
 * 组装某只宠物的右键菜单（一级 = 分类，二级 = 该分类的每个动作）。
 *
 * 为什么用原生菜单而不是像浏览器浮层那样画 HTML：桌面窗只有宠物包围盒那么大
 * （176–320px），二级菜单动辄几十条，画在窗口内会被边界裁掉，也压不出"浮在
 * 所有窗口之上"的效果；原生菜单是独立的 OS 弹层，没有这两个问题，还自带
 * 系统深浅色与滚动。
 *
 * 动作表从哪来：渲染端 load 完配置后上报（`pet:menu-data`）。主进程手上只有
 * id/尺寸/位置，分类与动作名只有那份配置里有 —— 在这里再扫一遍就是第二份数据源。
 *
 * @param {string} petId 宠物 id。
 * @param {Electron.BrowserWindow} win 对应窗口。
 * @returns {Electron.Menu | null} 没有动作表时返回 null（不弹半截菜单）。
 */
function buildPetMenu(petId, win) {
  const data = menuData.get(petId)
  const send = (msg) => {
    if (!win.isDestroyed()) win.webContents.send('pet:menu-action', msg)
  }
  const items = []
  if (data !== undefined && Array.isArray(data.categories)) {
    for (const category of data.categories) {
      if (category === null || typeof category !== 'object') continue
      const clips = Array.isArray(category.clips)
        ? category.clips.filter((clip) => clip !== null && typeof clip === 'object' && typeof clip.id === 'string' && clip.id !== '')
        : []
      if (clips.length === 0) continue
      items.push({
        label: String(category.name || ''),
        submenu: clips.map((clip) => ({
          label: String(clip.name || clip.id),
          click: () => send({ type: 'play', id: clip.id }),
        })),
      })
    }
  }
  // 配置还没取到（冷启动头几百毫秒）时不弹空菜单：右键没反应比弹一个
  // 只有"归位/隐藏"的半截菜单更诚实，也省得用户点了个寂寞。
  if (items.length === 0) return null
  items.push({ type: 'separator' })
  items.push({ label: MENU_LABELS.random, click: () => send({ type: 'random' }) })
  items.push({
    label: MENU_LABELS.reset,
    click: () => {
      resetPetToCorner(petId, win)
    },
  })
  items.push({ type: 'separator' })
  items.push({
    label: MENU_LABELS.hide,
    click: () => {
      hidePet(petId)
    },
  })
  return Menu.buildFromTemplate(items)
}

/**
 * 归位：回右下角并落盘（与浏览器浮层的"归位"同一口径：100/100 百分比）。
 * 飞行中被归位要先掐掉飞行，否则下一帧物理又把窗口推走、落盘还会打架。
 */
function resetPetToCorner(petId, win) {
  if (win.isDestroyed()) return
  stopFlight(petId, win)
  const bounds = win.getBounds()
  const area = deskArea()
  const at = clampToDesk(
    area,
    area.x + area.width - bounds.width,
    area.y + area.height - bounds.height,
    bounds.width,
    bounds.height,
  )
  win.setPosition(at.x, at.y)
  persistPosition(petId, positionOf(win))
}

/**
 * 隐藏 = 关掉这一只：POST petToggle 给宿主，宿主写完配置会重启 helper，
 * 新进程按新列表建窗 —— 这一只连同它的窗口一起消失，和浏览器浮层的"隐藏"一致。
 * 这是用户的显式操作，不受 DSA_PET_NO_PERSIST 影响（那个开关挡的是物理落盘这类自动写）。
 */
function hidePet(petId) {
  net
    .fetch(`${ORIGIN}${ROUTE}/manage?lite=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ petToggle: { pack: petId, enabled: false } }),
    })
    .catch((error) => {
      process.stderr.write(`[dsa-pet-desktop] 隐藏失败：${String(error)}\n`)
    })
}

/** 宠物当前可用活动范围：主屏工作区（含任务栏让位）。 */
function deskArea() {
  return screen.getPrimaryDisplay().workArea
}

/**
 * 把窗口位置夹进工作区，返回 `{ x, y }`（左上角像素）。
 *
 * 为什么需要它（用户报"全局界面下宠物会超出屏幕"）：位置有**三个来源**——配置里
 * 的历史百分比、拖动、甩抛飞行。任意一个都可能产生越界值：
 *   · 用户换了更小的屏幕 / 改了分辨率，旧的百分比换算出来就出界；
 *   · 拖到边缘时手一滑，`setPosition` 本身就收到了界外的坐标；
 *   · 飞行途中窗口被别的置顶窗挤动。
 * 越界的后果不是"看不见"，而是**被屏幕边缘裁掉半个宠物**（截图里就是这样）。
 *
 * 夹取时保证**整只宠物**都在工作区内：`x ∈ [area.x, area.x + area.width - w]`。
 * 窗口比屏幕还宽时（小屏 + 大尺寸）退化成贴左上角，至少不会再裁掉右边。
 *
 * @param {{ x: number, y: number, width: number, height: number }} area 工作区。
 * @param {number} x 目标左边界。 @param {number} y 目标上边界。
 * @param {number} w 窗口宽。 @param {number} h 窗口高。
 * @returns {{ x: number, y: number }} 夹好的像素坐标。
 */
function clampToDesk(area, x, y, w, h) {
  const maxX = area.x + area.width - w
  const maxY = area.y + area.height - h
  return {
    x: Math.round(Math.max(area.x, Math.min(maxX, x))),
    y: Math.round(Math.max(area.y, Math.min(maxY, y))),
  }
}

/**
 * 一帧飞行：推进 → 撞边反弹 → 衰减 → 判定停下。
 *
 * 边界是**工作区的四条边**（浏览器浮层里是视口四条边，口径一致）。
 * 撞边时把位置镜像回来（`maxX * 2 - x`），否则高速撞墙会"穿"出去一截。
 */
function stepFlight(petId, win) {
  const state = flying.get(petId)
  if (state === undefined || win.isDestroyed()) {
    stopFlight(petId, win)
    return
  }
  const now = Date.now()
  // 掉帧保护：dt 太大（切后台回来）会让宠物一帧瞬移出屏幕，按 48ms 封顶。
  const dt = Math.min(48, Math.max(1, now - state.last))
  state.last = now

  const bounds = win.getBounds()
  const area = deskArea()
  const maxX = area.x + area.width - bounds.width
  const maxY = area.y + area.height - bounds.height
  let x = bounds.x + state.vx * dt
  let y = bounds.y + state.vy * dt
  let hit = false

  if (x < area.x) {
    x = area.x + (area.x - x)
    state.vx = -state.vx * BOUNCE
    hit = true
  } else if (x > maxX) {
    x = maxX - (x - maxX)
    state.vx = -state.vx * BOUNCE
    hit = true
  }
  if (y < area.y) {
    y = area.y + (area.y - y)
    state.vy = -state.vy * BOUNCE
    hit = true
  } else if (y > maxY) {
    y = maxY - (y - maxY)
    state.vy = -state.vy * BOUNCE
    hit = true
  }

  // 一帧位移超过整块屏幕时（极端速度 + 长帧）上面那套镜像会算到边界外，贴回去。
  x = Math.max(area.x, Math.min(maxX, x))
  y = Math.max(area.y, Math.min(maxY, y))

  win.setPosition(Math.round(x), Math.round(y))
  if (hit) {
    // 撞墙那一下的挤压：渲染端把画面压扁一点，给个明确的"弹到了"的反馈。
    win.webContents.send('pet:bump')
  }

  if (Math.hypot(state.vx, state.vy) < STOP_SPEED) {
    finishFlight(petId, win)
    return
  }
  // 按真实时间衰减：掉帧时速度曲线不会变形（固定按帧乘会把慢机器的宠物甩更远）。
  const decay = Math.pow(SPEED_KEEP, dt / 1000)
  state.vx *= decay
  state.vy *= decay
}

/** 起飞：vx/vy 单位是 px/ms。够快才飞，慢慢放下就只算移动。 */
function startFlight(petId, win, vx, vy) {
  if (win.isDestroyed()) return
  const speed = Math.hypot(vx, vy)
  if (speed < STOP_SPEED) {
    finishFlight(petId, win)
    return
  }
  const cap = Math.min(1, MAX_SPEED / speed)
  stopFlight(petId, win)
  const state = { vx: vx * cap, vy: vy * cap, last: Date.now(), timer: null }
  state.timer = setInterval(() => stepFlight(petId, win), FLIGHT_TICK_MS)
  flying.set(petId, state)
}

/** 停稳：清定时器、落盘位置、让渲染端回待机。 */
function finishFlight(petId, win) {
  const state = flying.get(petId)
  if (state !== undefined && state.timer !== null) clearInterval(state.timer)
  flying.delete(petId)
  if (win.isDestroyed()) return
  win.webContents.send('pet:landed')
  persistPosition(petId, positionOf(win))
}

/** 打断飞行（用户又抓住它 / 关窗）：位置先落盘，等松手时统一提交。 */
function stopFlight(petId, win) {
  const state = flying.get(petId)
  if (state === undefined) return
  if (state.timer !== null) clearInterval(state.timer)
  flying.delete(petId)
  if (!win.isDestroyed()) win.webContents.send('pet:landed')
}

app.setName('dsa-pet-desktop')
if (process.platform === 'win32') app.setAppUserModelId('com.dsa.pet.desktop')

// 透明分层窗 + 硬件加速在 DWM 下会出黑边；关掉 GL，同时关 GPU 沙箱（远程桌面/虚拟显示器
// 下 GPU 进程会反复崩溃，宿主只看到一个无意义的退出码）。
app.disableHardwareAcceleration()
if (process.env.DSA_PET_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox')
// 宠物动画没有用户手势，不允许自动播放就永远停在第一帧。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsa-pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])

/** petId -> BrowserWindow */
const windows = new Map()
/** win.id -> 当前是否穿透（Electron 没有读回来的 API，只能自己记）。 */
const ignoring = new Map()
/** win.id -> 拖动状态 `{ timer, startX, startY, offsetX, offsetY, moved }` */
const dragging = new Map()
/** 命中判定的定时器与置顶看门狗的定时器。 */
let pointerTimer = null
let topmostTimer = null

/** 宿主没了就退：管道写失败与 kill(pid,0) 两条路，缺一不可。 */
let hostGone = false
/** 正在走优雅退出（防重入）。 */
let quitting = false

/**
 * 把所有宠物窗藏起来（同步）。DWM 立刻重绘它们覆盖过的区域。
 *
 * 单独抽出来是因为它有两个用途：优雅退出前（配合延时 app.exit），
 * 以及 `before-quit` 里（Electron 自己的退出路径，没时间等定时器）。
 */
function hideAllWindows() {
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue
    try {
      win.hide()
    } catch {
      /* 已经没了 */
    }
  }
}

/**
 * 优雅退出：先 hide 所有窗、等一帧让 DWM 重绘那块区域，再退。
 *
 * 为什么不能直接 `app.exit()`：Windows 上透明分层窗（WS_EX_LAYERED）被进程直接带走时，
 * DWM 不会重绘它覆盖过的区域，屏幕上会**留下一只冻结的宠物**（实测：kill 之后截图里
 * 那只还在，而且擦不掉，直到有别的窗口盖过去）。`hide()` 走正常的隐藏路径，DWM 立刻
 * 把那块重绘成底下的内容；等 300ms 再退就没有残影。
 *
 * 这条路径覆盖：宿主发来的 quit、宿主进程消失、窗口全关。
 */
function gracefulExit(code = 0) {
  if (quitting) return
  quitting = true
  if (pointerTimer !== null) clearInterval(pointerTimer)
  if (topmostTimer !== null) clearInterval(topmostTimer)
  hideAllWindows()
  setTimeout(() => app.exit(code), 300)
}

function exitForDeadHost() {
  if (hostGone) return
  hostGone = true
  gracefulExit(0)
}
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => exitForDeadHost())
}
if (HOST_PID > 0) {
  setInterval(() => {
    try {
      process.kill(HOST_PID, 0)
    } catch (error) {
      if (error && error.code === 'ESRCH') exitForDeadHost()
    }
  }, 2000).unref?.()
}

/** 把窗口内容区换算成"贴边百分比"（与浏览器浮层同一套 0–100 口径）。 */
function positionOf(win) {
  const bounds = win.getBounds()
  const area = screen.getPrimaryDisplay().workArea
  const maxX = Math.max(1, area.width - bounds.width)
  const maxY = Math.max(1, area.height - bounds.height)
  return {
    x: Math.max(0, Math.min(100, Math.round(((bounds.x - area.x) / maxX) * 1000) / 10)),
    y: Math.max(0, Math.min(100, Math.round(((bounds.y - area.y) / maxY) * 1000) / 10)),
  }
}

/**
 * 百分比 → 主屏工作区里的像素左上角。
 *
 * 换算结果**再过一次 `clampToDesk`**：百分比本身是 0–100 的闭区间，理论上算不出界外，
 * 但窗口尺寸可能超过工作区（小屏 + 320px 的宠物），那时 `maxX` 会变成负数，
 * 直接用会把窗口推到左/上边界之外。
 *
 * @param {Record<string, any>} pet 宠物配置（含 x/y 百分比）。
 * @param {number} width 窗口宽。 @param {number} height 窗口高。
 * @returns {{ x: number, y: number }} 夹好的像素坐标。
 */
function pixelOf(pet, width, height) {
  const area = screen.getPrimaryDisplay().workArea
  const maxX = Math.max(0, area.width - width)
  const maxY = Math.max(0, area.height - height)
  const x = Number.isFinite(pet.x) ? pet.x : 100
  const y = Number.isFinite(pet.y) ? pet.y : 100
  const targetX = area.x + (maxX * Math.max(0, Math.min(100, x))) / 100
  const targetY = area.y + (maxY * Math.max(0, Math.min(100, y))) / 100
  return clampToDesk(area, targetX, targetY, width, height)
}

/**
 * 宠物窗尺寸：宽度 = 用户设的 size，高度按宠物包画布比例算。
 *
 * 还要**按屏幕兜底**：用户设 320px、屏幕只有 1024 宽时，一只 320px 的宠物
 * 加上其它窗口很容易显得"占了半个屏"，而且窗口一旦比工作区高就必然被裁。
 * 所以宽度再夹一道：不超过工作区的 45%，也不超过工作区高度能容纳的值
 * （高度 = 宽 × 画布比例，反解出宽度上限）。
 *
 * @param {Record<string, any>} pet 宠物配置（size + canvas）。
 * @returns {{ width: number, height: number }} 窗口的逻辑像素尺寸。
 */
function sizeOf(pet) {
  const area = deskArea()
  const canvas = Array.isArray(pet.canvas) && pet.canvas.length === 2 ? pet.canvas : [480, 648]
  const ratio = Number(canvas[1]) > 0 && Number(canvas[0]) > 0 ? Number(canvas[1]) / Number(canvas[0]) : 648 / 480

  const wanted = Math.max(80, Math.round(Number(pet.size) || 176))
  // 宽不超过工作区 45%；同时保证"宽 × 比例"塞得进工作区高度（留 8% 余量给任务栏/边距）。
  const byWidth = Math.floor(area.width * 0.45)
  const byHeight = Math.floor((area.height * 0.92) / ratio)
  const width = Math.max(80, Math.min(wanted, byWidth, byHeight))
  return { width, height: Math.max(80, Math.round(width * ratio)) }
}

/**
 * 实时改一只宠物的大小（拖大小滑杆的预览通道，宿主 POST /size）。
 *
 * 为什么要有这条通道：大小原来在重建指纹里，每次落盘都重建整个 Electron 进程 ——
 * 用户看到的就是"拖的时候没反应，停手闪没一秒再长回来"。大小和位置一样是运行期
 * 状态，窗口当场改掉就行，根本不该重启进程。
 *
 * 锚点与页面浮层同一套口径：先把当前像素位置换算成百分比（`positionOf`），再按
 * **新尺寸**换算回像素（`pixelOf`）。页面里 `layout()` 就是这么做的，两边手感
 * 一致 —— 贴右下角的宠物长大时向右下长，不会往屏幕中间飘。
 *
 * @param {string} petId 宠物 id。
 * @param {number} size 新的宽度（px）。
 * @returns {boolean} 是否真的改了（不认识 id / 窗口没了 = false）。
 */
function applyPetSize(petId, size) {
  const win = windows.get(petId)
  const pet = PETS.find((item) => item.id === petId)
  if (win === undefined || win.isDestroyed() || pet === undefined) return false
  const wanted = Math.max(80, Math.min(320, Math.round(Number(size) || pet.size)))
  if (wanted === pet.size) return true
  pet.size = wanted
  const at = positionOf(win)
  const { width, height } = sizeOf(pet)
  const pos = pixelOf({ x: at.x, y: at.y }, width, height)
  win.setBounds({ x: pos.x, y: pos.y, width, height })
  return true
}

/** 翻转整窗穿透的唯一出口。 */
function setIgnore(win, ignore) {
  if (win.isDestroyed()) return
  if (ignoring.get(win.id) === ignore) return
  ignoring.set(win.id, ignore)
  win.setIgnoreMouseEvents(ignore, { forward: true })
}

/**
 * 把一只窗收回屏幕内（越界才动，正常时什么都不做）。
 *
 * 这是**兜底**，不是主路径：建窗、拖动、飞行三处都各自夹过一次了。它挡的是那些
 * 我们控制不到的越界来源 —— 显示器分辨率/缩放变了、任务栏挪了边、DPI 在窗口
 * 真正创建后才有最终值。用户看到的是"宠物被屏幕边缘裁掉半个"，这条能当场修好。
 *
 * @param {Electron.BrowserWindow} win 目标窗口。
 * @returns {boolean} 是否移动过（用于测试与日志）。
 */
function ensureInsideScreen(win) {
  if (win === undefined || win.isDestroyed()) return false
  const bounds = win.getBounds()
  const area = deskArea()
  const at = clampToDesk(area, bounds.x, bounds.y, bounds.width, bounds.height)
  if (at.x === bounds.x && at.y === bounds.y) return false
  win.setPosition(at.x, at.y)
  return true
}

/**
 * 把所有窗收回屏幕内。屏幕参数变化时调一次。
 * @returns {number} 移动过的窗数。
 */
function ensureAllInsideScreen() {
  let moved = 0
  for (const win of windows.values()) {
    if (ensureInsideScreen(win)) moved += 1
  }
  return moved
}

/** 建一只宠物的窗。 */
function createWindow(pet) {  const { width, height } = sizeOf(pet)
  const at = pixelOf(pet, width, height)
  const win = new BrowserWindow({
    width,
    height,
    x: at.x,
    y: at.y,
    show: false,
    useContentSize: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    // 关掉"允许超出屏幕"：我们要的就是**不许**超出。开着它时 Electron 不会替我们把窗口
    // 收回屏幕内，越界值会原样生效，结果就是宠物被屏幕边缘裁掉半个（用户截图那样）。
    enableLargerThanScreen: false,
    webPreferences: {
      preload: path.join(HELPER_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setSkipTaskbar(true)
  setIgnore(win, true)
  // 右键：弹原生菜单（一级 = 分类，二级 = 动作；另有随机/归位/隐藏）。
  // 与浏览器浮层的两级菜单同一份数据源（渲染端上报的动作表），只是画在 OS 弹层里 ——
  // 透明小窗自己放不下几十条动作，画在里面会被窗口边界裁掉。
  win.webContents.on('context-menu', (event) => {
    event.preventDefault()
    const menu = buildPetMenu(pet.id, win)
    if (menu === null) return
    // 菜单弹出期间窗口必须能收鼠标（否则菜单关闭后光标还在宠物上，
    // 穿透镜像却停在 ignore，下一次左键要点两下才生效）。
    setIgnore(win, false)
    menu.popup({ window: win, callback: () => setIgnore(win, true) })
  })
  // 渲染端的报错要进宿主日志：桌面窗是透明的，出错时用户只会看到"什么都没有"，
  // 没有任何线索。这里把 console 与加载失败都转成一行 stdout。
  if (process.env.DSA_PET_DEBUG === '1') {
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      process.stdout.write(`[renderer ${pet.id}] L${level} ${message} (${sourceId}:${line})\n`)
    })
    win.webContents.on('did-fail-load', (_event, code, desc, url) => {
      process.stdout.write(`[renderer ${pet.id}] did-fail-load ${code} ${desc} ${url}\n`)
    })
  }
  win.once('ready-to-show', () => win.showInactive())
  // paintWhenInitiallyHidden:false 时可能不产首帧、ready-to-show 永不触发：兜底显示一次。
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.showInactive()
      // 显示之后再校验一次位置：窗口真正落到屏幕上时尺寸才最终确定（DPI、任务栏高度
      // 都可能和创建时拿到的值差一点）。越界就当场收回屏幕内 —— 这是"宠物被裁掉半个"
      // 的最后一道防线，也是唯一不依赖任何调用方自觉的地方。
      ensureInsideScreen(win)
    }, 400)
  })
  win.on('closed', () => {
    stopDrag(win)
    stopFlight(pet.id, win)
    windows.delete(pet.id)
    ignoring.delete(win.id)
  })
  const query = `?pack=${encodeURIComponent(String(pet.id))}&route=${encodeURIComponent(ROUTE)}`
  win.loadFile(path.join(HELPER_DIR, 'index.html'), { search: query.slice(1) }).catch((error) => {
    process.stderr.write(`[dsa-pet-desktop] 页面加载失败（${pet.id}）：${String(error)}\n`)
    win.destroy()
  })
  windows.set(pet.id, win)
  return win
}

/** 开始拖动：主进程跟着系统光标挪窗（渲染端的 pointermove 在窗口跟手时会失真）。 */
function startDrag(win) {
  // 飞行中又被抓住：钉在当前位置，先落盘 —— 用户抓到的就是它此刻待的地方。
  // **只在真的在飞时**才收尾：无条件调用会让每次点击都发一次 pet:landed
  // （那条异步 IPC 会晚到，把点击刚触发的回应动作打断回待机 —— 用户看到的就是
  // "点它没反应"），还会顺手写一次盘。
  const petId = [...windows.entries()].find(([, value]) => value === win)?.[0]
  if (petId !== undefined && flying.has(petId)) finishFlight(petId, win)
  stopDrag(win)
  const point = screen.getCursorScreenPoint()
  const bounds = win.getBounds()
  setIgnore(win, false)
  dragging.set(win.id, {
    startX: point.x,
    startY: point.y,
    offsetX: point.x - bounds.x,
    offsetY: point.y - bounds.y,
    moved: false,
    // 光标采样：松手时用最近 100ms 这段算甩出去的速度。
    samples: [{ x: point.x, y: point.y, t: Date.now() }],
    timer: setInterval(() => {
      const state = dragging.get(win.id)
      if (state === undefined || win.isDestroyed()) return
      const now = screen.getCursorScreenPoint()
      const nowMs = Date.now()
      if (!state.moved && Math.hypot(now.x - state.startX, now.y - state.startY) >= TAP_SLOP) state.moved = true
      state.samples.push({ x: now.x, y: now.y, t: nowMs })
      const cutoff = nowMs - VELOCITY_WINDOW_MS
      while (state.samples.length > 2 && state.samples[0].t < cutoff) state.samples.shift()
      // 拖动时也夹住：手滑到屏幕外不该把宠物带出去（松手后它就卡在屏幕外了）。
      const b = win.getBounds()
      const at = clampToDesk(deskArea(), now.x - state.offsetX, now.y - state.offsetY, b.width, b.height)
      win.setPosition(at.x, at.y)
    }, DRAG_TICK_MS),
  })
}

/**
 * 结束拖动：返回这次的判定结果。
 *
 * `{ moved, vx, vy }`：moved = 算不算拖拽；vx/vy = 甩出去的速度（px/ms），
 * 用最近 100ms 的采样平均算 —— 单次位移噪声太大，直接拿最后一帧算会乱飞。
 */
function stopDrag(win) {
  const state = dragging.get(win.id)
  if (state === undefined) return { moved: false, vx: 0, vy: 0 }
  clearInterval(state.timer)
  dragging.delete(win.id)

  const samples = state.samples
  const last = samples[samples.length - 1]
  let vx = 0
  let vy = 0
  if (samples.length >= 2 && last !== undefined) {
    const cutoff = last.t - VELOCITY_WINDOW_MS
    const first = samples.find((sample) => sample.t >= cutoff) ?? samples[0]
    const dt = last.t - first.t
    if (dt > 0) {
      vx = (last.x - first.x) / dt
      vy = (last.y - first.y) / dt
    }
  }
  return { moved: state.moved, vx, vy }
}

/**
 * 落盘位置：POST 回宿主的 manage 路由（与浏览器浮层同一个写入口）。
 *
 * 带 `?lite=1`：只要一句 `{ok}`。位置落盘每次甩出去停下都会发生，而完整 status
 * 要重扫整个素材库 —— 那份回包对这个调用方毫无用处，只是让落地多等一会儿。
 *
 * 失败只记日志：位置没存上是小事，不该弹窗、不该打断演出。
 */
function persistPosition(petId, position) {
  // 验收/排障时设 DSA_PET_NO_PERSIST=1：不发写请求。
  // 这样 e2e 可以接真实 DSH（渲染端要取配置与素材）而**不改用户配置**。
  if (process.env.DSA_PET_NO_PERSIST === '1') return
  const body = JSON.stringify({ petMove: { pack: petId, x: position.x, y: position.y } })
  net
    .fetch(`${ORIGIN}${ROUTE}/manage?lite=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    .catch((error) => {
      process.stderr.write(`[dsa-pet-desktop] 位置保存失败：${String(error)}\n`)
    })
}

/**
 * 命中判定：光标在窗口里就把穿透关掉，离开再打开。
 *
 * 窗口尺寸就是宠物的包围盒（宽度 = size，高度按画布比例），视频用 object-fit: contain
 * 铺满整窗 —— 所以"窗口矩形"与"宠物本体"基本重合，不需要再做逐像素命中。
 */
function startPointerWatch() {
  if (pointerTimer !== null) return
  pointerTimer = setInterval(() => {
    const point = screen.getCursorScreenPoint()
    for (const win of windows.values()) {
      if (win.isDestroyed()) continue
      // 拖动中必须保持可交互，否则松手收不到 pointerup。
      if (dragging.has(win.id)) {
        setIgnore(win, false)
        continue
      }
      const bounds = win.getBounds()
      const inside =
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height
      setIgnore(win, !inside)
    }
  }, POINTER_POLL_MS)
  pointerTimer.unref?.()
}

/**
 * 屏幕变化看门狗：分辨率/缩放/任务栏一变，之前合法的位置可能就出界了。
 *
 * 监听 Electron 的 display 事件（它会带上"变了哪块屏"），收到就把所有窗收一次。
 * 比轮询省事，也比只依赖建窗时那一次校验可靠 —— 用户把笔记本接上外接屏、
 * 或者在设置里改了缩放比例，都走这条。
 */
function startDisplayWatch() {
  const onDisplayChange = () => {
    // 给系统一点时间把新几何算完，否则读到的还是旧值。
    setTimeout(() => ensureAllInsideScreen(), 400).unref?.()
  }
  screen.on('display-metrics-changed', onDisplayChange)
  screen.on('display-added', onDisplayChange)
  screen.on('display-removed', onDisplayChange)
}

/** 置顶看门狗：别的置顶窗（播放器、会议软件）会把宠物压下去，低频重钉一次。 */
function startTopmostWatch() {
  if (topmostTimer !== null) return
  topmostTimer = setInterval(() => {
    for (const win of windows.values()) {
      if (win.isDestroyed() || !win.isVisible()) continue
      win.setAlwaysOnTop(true, 'screen-saver')
    }
  }, TOPMOST_TICK_MS)
  topmostTimer.unref?.()
}

/**
 * `dsa-pet://` 协议：原样转发给 DSH 的 webServer（含 Range，视频拖动播放要用）。
 *
 * 只放行**本插件的路由前缀**。这个窗是透明置顶、渲染端跑的是 DSH 自己的页面，
 * 但协议注册时开了 `bypassCSP`；如果放任任何 path 转发，页面上任何一个 XSS 或
 * 第三方脚本都能借 `dsa-pet://127.0.0.1:3080/...` 打到宿主**全部** HTTP 接口
 * （管理页、其它插件、甚至 DSH 内部 API），等于绕开了同源策略。前缀白名单把
 * 可达面收回到本插件自己的三个路由（asset / manage / update），刚好够渲染端用。
 */
const ALLOWED_PREFIX = `${ROUTE}/`

async function proxy(request) {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(ALLOWED_PREFIX)) {
    return new Response(`dsa-pet: 拒绝代理 ${url.pathname}（只放行 ${ALLOWED_PREFIX}）`, {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  const target = `${ORIGIN}${url.pathname}${url.search}`
  /** @type {Record<string, string>} */
  const headers = {}
  for (const [key, value] of request.headers) {
    const name = key.toLowerCase()
    // Host/Origin/Referer 由 net 自己算；带过去会被 DSH 的访问闸门当成跨站请求。
    if (name === 'host' || name === 'origin' || name === 'referer' || name === 'connection') continue
    headers[key] = value
  }
  const init = { method: request.method, headers }
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer()
  try {
    return await net.fetch(target, init)
  } catch (error) {
    return new Response(`dsa-pet: ${String(error && error.message ? error.message : error)}`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

app.whenReady().then(() => {
  protocol.handle('dsa-pet', (request) => proxy(request))

  for (const pet of PETS) {
    if (pet === null || typeof pet !== 'object' || typeof pet.id !== 'string' || pet.id === '') continue
    createWindow(pet)
  }

  ipcMain.on('pet:drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win !== null) startDrag(win)
  })

  ipcMain.on('pet:drag-end', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null || win.isDestroyed()) return
    const result = stopDrag(win)
    // 位置以窗口表为准，反查宠物 id（一只窗对一个包）。
    const petId = [...windows.entries()].find(([, value]) => value === win)?.[0]
    if (petId === undefined) return
    if (result.moved) {
      // 拖了就飞：慢放（速度不足）自己会落到 finishFlight 里立刻停稳并落盘。
      startFlight(petId, win, result.vx, result.vy)
    } else {
      // 没拖动 = 点击：让渲染端演一段回应动作。
      win.webContents.send('pet:tap')
    }
  })

  ipcMain.on('pet:state', (event, state) => {
    // 渲染端回报"现在在演什么 / 音效放了几次"：只给测试钩子用，正常运行时静默丢弃。
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null) return
    const petId = [...windows.entries()].find(([, value]) => value === win)?.[0]
    if (petId !== undefined) renderState.set(petId, state)
  })

  ipcMain.on('pet:menu-data', (event, data) => {
    // 渲染端取到配置后上报动作表：右键菜单只有这一份数据源（主进程不重扫素材目录）。
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null) return
    const petId = [...windows.entries()].find(([, value]) => value === win)?.[0]
    if (petId === undefined) return
    if (data === null || typeof data !== 'object' || !Array.isArray(data.categories)) return
    menuData.set(petId, data)
  })

  ipcMain.on('pet:quit', () => gracefulExit(0))

  startPointerWatch()
  startTopmostWatch()
  startDisplayWatch()

  // 优雅退出通道：只监听 127.0.0.1 的随机端口，POST /quit 即优雅退出。
  //
  // 为什么需要它：宿主停 helper 时 `child.kill()` 在 Windows 上是 TerminateProcess，
  // 本进程的 before-quit 根本不会跑 —— 于是 DWM 留下冻结的宠物残影。宿主拿到这个端口
  // （从 stdout 的 `READY <port>`）就能请我们"自己体面地退"。
  // 只绑 loopback、只认 POST /quit，不做别的任何事：多一个能远程关窗的口子都是风险。
  try {
    const server = require('node:http').createServer((req, res) => {
      if (process.env.DSA_PET_TEST_HOOKS === '1' && req.method === 'POST' && req.url === '/test/menu') {
        // 验收右键菜单：弹出真实菜单并回传结构（分类数 / 动作总数）。
        const first = [...windows.entries()][0]
        if (first === undefined) {
          res.writeHead(409, { 'content-type': 'text/plain' })
          res.end('no-window')
          return
        }
        const [petId, win] = first
        const menu = buildPetMenu(petId, win)
        if (menu === null) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, reason: '渲染端还没上报动作表' }))
          return
        }
        const shape = menu.items.map((item) => ({
          label: item.label,
          children: item.submenu !== null ? item.submenu.items.length : 0,
        }))
        menu.popup({ window: win })
        // 自动收起，验收脚本在弹出期间检查 #32768 菜单窗是否存在。
        setTimeout(() => {
          try {
            menu.closePopup()
          } catch {
            /* 已经关了 */
          }
        }, 800)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, shape }))
        return
      }
      if (process.env.DSA_PET_TEST_HOOKS === '1' && req.method === 'POST' && req.url === '/test/menu-action') {
        // 模拟"菜单里点了某一项"（与原生菜单 click 回调同一条 IPC）。
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const first = [...windows.entries()][0]
          if (first === undefined) {
            res.writeHead(409, { 'content-type': 'text/plain' })
            res.end('no-window')
            return
          }
          let msg = { type: 'random' }
          try {
            const parsed = JSON.parse(body || '{}')
            if (typeof parsed.type === 'string') msg = parsed
          } catch {
            /* 用默认 */
          }
          first[1].webContents.send('pet:menu-action', msg)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      if (process.env.DSA_PET_TEST_HOOKS === '1' && req.method === 'POST' && req.url === '/test/allbounds') {
        // 所有窗的几何 + 工作区：验收"任意屏幕下都不越界"要用。
        const area = deskArea()
        const list = []
        for (const [id, win] of windows) {
          if (win.isDestroyed()) continue
          list.push({ id, bounds: win.getBounds() })
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ area, windows: list }))
        return
      }
      if (process.env.DSA_PET_TEST_HOOKS === '1' && req.method === 'POST' && req.url === '/test/tap') {
        const first = [...windows.entries()][0]
        if (first === undefined) {
          res.writeHead(409, { 'content-type': 'text/plain' })
          res.end('no-window')
          return
        }
        // 与真实点击同一条路径：主进程发 pet:tap，渲染端 playClick（音效 + 动作）。
        first[1].webContents.send('pet:tap')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (process.env.DSA_PET_TEST_HOOKS === '1' && req.method === 'POST' && req.url === '/test/bounds') {
        const first = [...windows.entries()][0]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            bounds: first === undefined ? null : first[1].getBounds(),
            flying: flying.size > 0,
            render: first === undefined ? null : (renderState.get(first[0]) ?? null),
          }),
        )
        return
      }
      // 测试钩子（只在 DSA_PET_TEST_HOOKS=1 时开）：模拟一次"甩出去"，用来验收
      // 反弹物理。真实用户碰不到这条路径 —— 它只接受 POST、只认本机、且默认关闭。
      if (process.env.DSA_PET_TEST_HOOKS === '1' && req.method === 'POST' && req.url === '/test/fling') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const first = [...windows.entries()][0]
          if (first === undefined) {
            res.writeHead(409, { 'content-type': 'text/plain' })
            res.end('no-window')
            return
          }
          let vx = 1.5
          let vy = 1.2
          try {
            const parsed = JSON.parse(body || '{}')
            if (Number.isFinite(parsed.vx)) vx = parsed.vx
            if (Number.isFinite(parsed.vy)) vy = parsed.vy
          } catch {
            /* 用默认速度 */
          }
          startFlight(first[0], first[1], vx, vy)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, id: first[0], from: first[1].getBounds() }))
        })
        return
      }
      // 实时改大小：`POST /size`，body `{ pets: [{ id, size }] }`。
      //
      // 为什么开这条口子：大小原来在重建指纹里，每次拖完滑杆落盘都要重建整个
      // Electron 进程 —— 用户看到"拖的时候没反应，停手闪没一秒再长回来"。
      // 与 /quit 同一把锁：只绑 127.0.0.1、只认 POST、只改窗口尺寸，
      // 不接受 id 之外的任何字段（改画布/改位置都要走重建或拖动那条既有路径）。
      if (req.method === 'POST' && req.url === '/size') {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          if (body.length > 65536) req.destroy()
        })
        req.on('end', () => {
          /** @type {Array<{ id?: unknown, size?: unknown }>} */
          let list = []
          try {
            const parsed = JSON.parse(body || '{}')
            if (Array.isArray(parsed.pets)) list = parsed.pets
          } catch {
            /* 坏 body 当作没收到 */
          }
          let changed = 0
          for (const item of list) {
            if (item === null || typeof item !== 'object') continue
            if (typeof item.id !== 'string' || item.id === '') continue
            if (typeof item.size !== 'number' || !Number.isFinite(item.size)) continue
            if (applyPetSize(item.id, item.size)) changed += 1
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, changed }))
        })
        return
      }
      if (req.method !== 'POST' || req.url !== '/quit') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('dsa-pet: not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('bye')
      gracefulExit(0)
    })
    server.on('error', (error) => {
      process.stdout.write(`QUITPORT fail ${String(error && error.message ? error.message : error)}\n`)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      if (port > 0) process.stdout.write(`READY ${port}\n`)
    })
    server.unref?.()
  } catch (error) {
    process.stdout.write(`QUITPORT fail ${String(error)}\n`)
  }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  // Electron 自己的退出路径（window-all-closed / app.quit()）：同步 hide 一次，
  // 避免透明窗被带走时在桌面上留残影。gracefulExit 有防重入，这里不必再判断。
  hideAllWindows()
})
