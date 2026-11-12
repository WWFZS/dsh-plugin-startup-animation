/**
 * 桌面宠物 Helper 的进程管理（仅 Windows）。
 *
 * 职责只有三件：找到 Electron、按配置拉起一个 helper 进程、配置变了重启它。
 * 不含宠物业务逻辑 —— 渲染与命中判定在 `runtime/pet-desktop/`，配置与素材仍在 `index.js` 的路由里。
 *
 * 为什么单独成文件：`index.js` 是宿主半侧的唯一入口，它必须保持"只用 node: 内建、不阻塞 apply"。
 * 这里同样只用 node: 内建，并且**所有失败都只降级**：拉不起来 = 桌面上少一只宠物，
 * 浏览器浮层照常工作。
 *
 * @module lib/desktop-pet.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** helper 入口（相对包根）。必须是 .cjs：本包 `"type": "module"`，`.js` 会被当成 ESM 加载，
 * 而 helper 是 CommonJS（`require('electron')`）—— 用 `.js` 会直接 `require is not defined`。 */
const HELPER_ENTRY = 'runtime/pet-desktop/main.cjs'

/** 宿主退出后 helper 的最长存活时间（它自己有 kill(pid,0) 探测，这里只是兜底）。 */
const HOST_POLL_MS = 2000

/**
 * Electron 落地目录：`$DSH_HOME/electron`。
 *
 * 只认这一处：与 dsh-pet 共用同一个下载位置，用户装过其中任意一个就已经有了二进制，
 * 不必再下 200MB。也正因为共用，这里**从不删除**这个目录。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量表。
 * @returns {string} 绝对路径。
 */
export function electronHome(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(env.USERPROFILE || env.HOME || os.homedir(), '.dsh')
  return path.join(home, 'electron')
}

/**
 * 找 Electron 可执行文件。只在 Windows 上返回结果。
 *
 * 查找顺序：`DSA_PET_ELECTRON_PATH` → `$DSH_HOME/electron/electron.exe`。
 * 不做"按需下载"：那要引入 @electron/get（一堆运行依赖），而本插件的原则是
 * 零依赖 + 装不上就降级。设置页会明确告诉用户去哪拿。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量表。
 * @returns {string | undefined} 可执行文件绝对路径。
 */
export function findElectron(env = process.env) {
  if (process.platform !== 'win32') return undefined
  const candidates = []
  if (typeof env.DSA_PET_ELECTRON_PATH === 'string' && env.DSA_PET_ELECTRON_PATH !== '') {
    candidates.push(env.DSA_PET_ELECTRON_PATH)
  }
  candidates.push(path.join(electronHome(env), 'electron.exe'))
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && stat.size > 0) return path.resolve(candidate)
    } catch {
      /* 换下一个候选 */
    }
  }
  return undefined
}

/**
 * 去掉会让 Electron 变成纯 Node 的继承变量。
 *
 * `ELECTRON_RUN_AS_NODE=1` 是宿主（DSH 桌面版自己跑在 Electron 里）会带上的；
 * 原样继承下去，子进程里 `require('electron')` 直接 MODULE_NOT_FOUND。
 * 设成空串也不行 —— Electron 会 abort，必须真的删键。
 *
 * @param {NodeJS.ProcessEnv} source 原始环境变量表。
 * @returns {NodeJS.ProcessEnv} 新的环境变量表。
 */
export function helperEnv(source) {
  const env = { ...source }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

/**
 * 一只宠物在桌面窗里需要的全部参数。
 *
 * 只挑渲染端真正要用的字段：整份宠物包（含 100+ 段动作路径）塞进环境变量会超过
 * Windows 的命令行长度上限，而且渲染端本来就要自己去 `/manage` 取一次完整配置。
 *
 * **只收 enabled === true 的**：这里是"哪几只该出现在桌面上"的唯一判定点之一
 * （另一个是调用方）。用户关掉的那只必须不建窗 —— 桌面上凭空多一只不受总开关
 * 与单只开关约束的宠物，是最难解释的一类 bug。
 *
 * @param {Array<Record<string, any>>} pets 宿主给的宠物列表。
 * @returns {Array<{ id: string, size: number, x: number, y: number, canvas: number[] }>} 精简列表。
 */
export function desktopPetList(pets) {
  return pets
    .filter((pet) => pet !== null && typeof pet === 'object' && pet.enabled === true)
    .filter((pet) => typeof pet.id === 'string' && pet.id !== '')
    .map((pet) => ({
      id: pet.id,
      size: Number(pet.size) || 176,
      x: Number.isFinite(pet.x) ? pet.x : 100,
      y: Number.isFinite(pet.y) ? pet.y : 100,
      canvas: Array.isArray(pet.canvas) && pet.canvas.length === 2 ? pet.canvas : [480, 648],
    }))
}

/**
 * 决定"要不要重建 helper 进程"的指纹：**只含身份与画布，不含位置、也不含大小**。
 *
 * 为什么必须把 x/y 排除掉（这条踩过，用户原话是"甩出去停下的一瞬间会消失再加载"）：
 * 宠物落地时会把位置写盘 → 宿主收到写回 → 调 sync → 若指纹含 x/y 就变了 →
 * `stop()` + 重新 `spawn` 整个 Electron 进程。表现就是宠物在停稳那一刻闪没了、
 * 一两秒后又"重新加载"出来。
 *
 * 为什么**大小**也要排除（同一个坑的第二次踩法，用户原话是"全局界面下拖大小滑杆
 * 不跟手，要等停手后闪一下才变"）：大小和位置一样是运行期可变状态。留在指纹里，
 * 每次拖完滑杆的防抖落盘都会重建整个进程 —— 用户看到的就是"拖的时候没反应，
 * 停手宠物消失一秒再长回来"。现在大小走 `resize()` 实时推给活着的 helper
 * （helper 当场改窗口尺寸），指纹只管"哪几只、每只什么画布"这种真结构性变化。
 *
 * @param {Array<{ id: string, canvas: number[] }>} list desktopPetList 的结果。
 * @returns {string} 可比较的指纹。
 */
export function structuralKey(list) {
  return JSON.stringify(
    list.map((pet) => ({ id: pet.id, canvas: pet.canvas })),
  )
}

/**
 * 每只宠物"当前该显示多大"，用来判断要不要推一次实时尺寸。
 *
 * 只比 `id → size`，不比画布：画布变了走的是重建那条路（指纹里带着它）。
 * @param {Array<{ id: string, size: number }>} list
 * @returns {Record<string, number>}
 */
export function sizeMap(list) {
  const out = {}
  for (const pet of list) out[pet.id] = pet.size
  return out
}

/**
 * 把尺寸推给 helper 的请求体：只带 `id` 与 `size`。
 *
 * 画布**不在这里传**：窗口比例是建窗时定下的事实（helper 自己那份 `PETS` 里有），
 * 让宿主随手改画布等于开了一条"绕过重建去改结构性参数"的路 —— 那条路一定会让
 * 窗口比例和内容对不上。画布真变了，走 `structuralKey` 的重建通道。
 *
 * @param {Array<{ id: string, size: number }>} list
 * @returns {string} JSON 请求体。
 */
export function sizeBody(list) {
  return JSON.stringify({
    pets: list.map((pet) => ({ id: pet.id, size: pet.size })),
  })
}

/**
 * 造桌面宠物的进程管理器。
 *
 * @param {{ packageRoot: string, origin: () => string, log: { info: (msg: string) => void, warn: (msg: string) => void }, spawn?: typeof import('node:child_process').spawn, findElectron?: () => string | undefined }} options
 *   包根、宿主自己的 Web 源（含端口）、日志出口；`spawn` / `findElectron` 可在测试里替换。
 * @returns {{ available: () => boolean, reason: () => string, sync: (pets: Array<Record<string, any>>) => boolean, resize: (pets: Array<Record<string, any>>) => void, stop: () => void, dispose: () => void }} 管理器。
 */
export function createDesktopPets(options) {
  const { packageRoot, origin, log } = options
  // 可注入：启动 helper 与"找 Electron"这两件事都要能在测试里换掉。
  // 不注入的话，「只改大小不重建」这条用例只能靠机器上恰好有没有装 Electron 决定成败，
  // 而这台开发机装了 —— 以前它在别的机器上"碰巧通过"。
  const launch = options.spawn ?? spawn
  const locateElectron = options.findElectron ?? findElectron
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  /** 当前已拉起的宠物列表指纹：内容没变就不重启进程。 */
  let runningKey = ''
  /** 上次失败的原因（设置页要显示"为什么桌面上没有宠物"）。 */
  let lastReason = ''
  /** helper 自报的优雅退出端口（0 = 还没就绪 / 老版本）。 */
  let quitPort = 0
  /** 已经推给 helper 的那份尺寸（`sizeMap` 的形状）：只有它变了才发一次 /size。 */
  let runningSizes = {}
  /** 上一次 sync 算出的目标列表（含 size）：`resize()` 在它基础上做增量合并。 */
  let lastWanted = []
  let disposed = false

  const entry = path.join(packageRoot, HELPER_ENTRY)

  const available = () => locateElectron() !== undefined && fs.existsSync(entry)

  /**
   * helper 是否已经就绪（拿到了 READY 端口）。
   *
   * 指纹去重**不能**等它就绪再算数：冷启动那一小段空窗里宿主往往会再 sync 一次
   * （落盘 + 重试），那一次若按"没就绪就重建"处理，就会把刚拉起的进程杀掉重来 ——
   * 桌面上的宠物闪一下、前一次 spawn 白费。重复拉起是**看得见**的坏效果，
   * 而空窗里的尺寸变化由 `pushSizes` + READY 补推兜住，不会丢。
   *
   * @returns {boolean} true = helper 已上报端口。
   */
  const helperReady = () => quitPort > 0

  const reason = () => {
    if (process.platform !== 'win32') return '桌面模式仅支持 Windows'
    if (!fs.existsSync(entry)) return 'helper 文件缺失（安装包不完整）'
    if (locateElectron() === undefined) return '未找到 Electron'
    return lastReason
  }

/**
 * 停掉当前 helper：先请它自己优雅退出，超时才硬杀。
 *
 * 为什么不能直接 `kill()`：Windows 上 `child.kill()` 走 TerminateProcess，等于硬杀 ——
 * helper 的 `before-quit` 根本没机会跑。而透明分层窗被硬杀带走时，DWM 不会重绘它覆盖过的
 * 区域，桌面上会**留下一只冻结的宠物**（实测，而且擦不掉，直到有别的窗口盖过去）。
 *
 * 所以 helper 启动后会开一个只监听 127.0.0.1 的小端口，并在 stdout 打出 `READY <port>`。
 * 这里 POST 一下 `/quit`，它就会先 hide 所有窗、等 DWM 重绘、再退。
 * 拿不到端口（老版本 helper / 还没就绪）或请求失败时，退回 `kill()` 兜底。
 */
  const stop = () => {
    if (child === null) {
      runningSizes = {}
      return
    }
    const dying = child
    child = null
    runningKey = ''
    runningSizes = {}
    const port = quitPort
    quitPort = 0
    if (port > 0) {
      // 不 await：调用方（配置写入、插件卸载）不该被一次 HTTP 往返拖住。
      // 1.5 秒后如果还活着，才硬杀。
      const killer = setTimeout(() => {
        try {
          dying.kill()
        } catch {
          /* 已经退出 */
        }
      }, 1500)
      killer.unref?.()
      dying.once('exit', () => clearTimeout(killer))
      fetch(`http://127.0.0.1:${port}/quit`, { method: 'POST' }).catch(() => {
        /* 端口已关 = 它已经在退，兜底定时器会收尾 */
      })
      return
    }
    try {
      dying.kill()
    } catch {
      /* 已经退出 */
    }
  }
  /**
   * 把当前尺寸推给**正在运行的** helper：当场改窗口大小，不重建进程。
   *
   * 与 `stop()` 一样不 await：拖滑杆每格都会来一次，调用方（POST 处理）不该被
   * 一次本机 HTTP 往返拖住。
   *
   * 端口还没就绪（冷启动头几百毫秒、或 helper 报错重试中）时**不做比较**：
   * 这时什么都还没推出去，`runningSizes` 若被记成"已推送"，等 `READY` 到了补推时
   * 就会因为"没变化"直接返回 —— 用户拖出来的尺寸永远落不到窗口上。所以只有端口活着
   * 才写 `runningSizes`；就绪那一步会拿最新的 `lastWanted` 补推一次。
   *
   * @param {Array<{ id: string, size: number }>} list desktopPetList 的结果。
   */
  const pushSizes = (list) => {
    const next = sizeMap(list)
    if (child === null || quitPort === 0) return
    if (JSON.stringify(next) === JSON.stringify(runningSizes)) return
    runningSizes = next
    fetch(`http://127.0.0.1:${quitPort}/size`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: sizeBody(list),
    }).catch(() => {
      /* 端口已关 = 它在退；下一次 sync 会按新列表重建 */
    })
  }

  /**
   * 实时改某几只的大小（**不写盘**，是拖滑杆那一侧的预览通道）。
   *
   * 只接受 `{ id, size }` 的增量，其余宠物保持 `lastWanted` 里的现值 —— 调用方
   * 手上只有那一只的新尺寸，让它重传整份列表就等于把"哪几只该在桌面上"变成了
   * 第二个事实来源。陌生 id 一律丢掉：桌面上没有它的窗，那份尺寸永远落不了地。
   *
   * @param {Array<{ id?: string, size?: number }>} updates 增量。
   * @returns {boolean} 是否有宠物真的被推到了尺寸（helper 不在 / 都不认识 = false）。
   */
  const resize = (updates) => {
    if (disposed || child === null) return false
    /** @type {Map<string, number>} */
    const byId = new Map()
    for (const item of updates) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.id !== 'string' || item.id === '') continue
      if (typeof item.size !== 'number' || !Number.isFinite(item.size)) continue
      byId.set(item.id, Math.max(80, Math.min(320, Math.round(item.size))))
    }
    if (byId.size === 0) return false
    let touched = false
    const merged = []
    for (const pet of lastWanted) {
      const next = byId.get(pet.id)
      if (next === undefined) merged.push(pet)
      else {
        touched = next !== pet.size
        merged.push({ ...pet, size: next })
      }
    }
    if (merged.length === 0) return false
    lastWanted = merged
    // 一个字节都没变就别白 POST 一次。
    if (!touched) return true
    pushSizes(merged)
    return true
  }

  /**
   * 按宠物列表同步桌面窗：列表变了就重启（Electron 不支持热改窗口表），
   * 空了就停掉整个进程（桌面上没有宠物时不该常驻 100MB 的 Chromium）。
   *
   * 关键细节一：`runningKey` **只在 helper 真的起来并发出 READY 之后**才赋值。反过来的话，
   * 宿主端口还没绑上、helper 还没就绪的那一次会记下"已经同步过了"，之后端口就绪再调一次
   * 就被指纹去重跳过 —— 桌面上永远没有宠物，而且没有任何日志解释为什么。
   *
   * 关键细节二：指纹命中时**不重启**，哪怕 helper 还没就绪。重复拉起的代价是桌面上
   * 的宠物闪一下、前一次 spawn 白费；而"空窗里改了尺寸"这个丢尺寸的坑由 `pushSizes`
   * 自己兜（端口没就绪就记进 `runningSizes`，等 `READY` 后补推一次），不需要靠重建来救。
   *
   * @param {Array<Record<string, any>>} pets 宿主给的完整宠物列表（函数内自己筛 enabled）。
   * @returns {boolean} 是否已经达到目标状态（false = 需要重试）。
   */
  const sync = (pets) => {
    if (disposed) return true
    const wanted = desktopPetList(pets)
    // 目标尺寸记下来：`resize()` 的增量合并、以及"没拉起来时该带什么进环境变量"
    // 都以它为准。
    lastWanted = wanted
    // 指纹只看身份与画布，不看位置、也不看大小 —— 大小走 pushSizes 实时推。
    const key = structuralKey(wanted)
    if (key === runningKey) {
      // 结构没变但尺寸可能变了（拖完滑杆落盘的那一次就走这里）。
      pushSizes(wanted)
      return true
    }

    // 走到了这里 = 真的要先停掉旧的（列表变了或压根没跑）。
    stop()
    if (wanted.length === 0) {
      runningKey = key
      log.info('桌面宠物：没有启用的宠物，helper 不启动')
      return true
    }
    if (process.platform !== 'win32') {
      lastReason = '桌面模式仅支持 Windows'
      return true
    }
    const electron = locateElectron()
    if (electron === undefined || !fs.existsSync(entry)) {
      lastReason = electron === undefined ? '未找到 Electron' : 'helper 文件缺失'
      log.warn(`桌面宠物：${lastReason}（把 electron.exe 放到 ${path.join(electronHome(), 'electron.exe')} 或设 DSA_PET_ELECTRON_PATH）`)
      return true
    }

    let webOrigin = ''
    try {
      webOrigin = origin()
    } catch {
      // 端口还没绑上：不记指纹，等下一次 sync 重试。
      lastReason = '宿主 Web 服务尚未就绪'
      return false
    }
    lastReason = ''

    let spawned = null
    try {
      spawned = launch(electron, [entry], {
        cwd: packageRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...helperEnv(process.env),
          DSA_PET_ORIGIN: webOrigin,
          DSA_PET_PETS: JSON.stringify(wanted),
          DSA_PET_HOST_PID: String(process.pid),
        },
      })
    } catch (error) {
      // spawn 当场抛（参数/权限）：没有 exit/error 事件，必须就地收拾。
      // 不记指纹（下次才重试），也不留一个假 child 把指纹去重永远卡死。
      lastReason = `启动失败：${error instanceof Error ? error.message : String(error)}`
      log.warn(`桌面宠物：${lastReason}`)
      child = null
      runningKey = ''
      return true
    }
    child = spawned
    // 异步失败（EPERM/EMFILE/找不到文件）走的是 'error' 事件，不是上面的 catch。
    // 这里必须清掉 child/指纹：否则下一次 sync 会以为"已经起好了"，把尺寸 POST 给一个
    // 根本不存在的 helper —— 尺寸改动全部静默丢失。
    // 注意**不能**挂 'exit' 做这件事：刚 spawn 的 child 还没就绪，事件循环一转就可能
    // 先收到 exit，指纹被清掉，紧接着「只改大小」的那次 sync 就变成了重建（用户实测：
    // 拖完滑杆宠物闪一下才变）。
    spawned.on('error', (error) => {
      if (child === spawned) {
        child = null
        runningKey = ''
      }
      lastReason = `启动失败：${error.message}`
      log.warn(`桌面宠物：${lastReason}`)
    })

    runningKey = key
    quitPort = 0
    // 这批尺寸已经随 DSA_PET_PETS 一起交给了新进程，记下来：
    // 下一次 pushSizes 比较时不该再白 POST 一遍。
    runningSizes = sizeMap(wanted)
    // 别让这个子进程拖住宿主的事件循环：宿主该退就退，helper 自己会跟着死
    // （它每 2 秒 kill(pid,0) 探一次，加上管道写失败即退，两条路都通）。
    spawned.unref?.()
    spawned.stdout?.unref?.()
    spawned.stderr?.unref?.()
    spawned.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      // helper 就绪后打一行 `READY <port>`：优雅退出要用的本地端口。
      const ready = /READY (\d+)/.exec(text)
      if (ready !== null) {
        quitPort = Number(ready[1])
        // 空窗里改的尺寸没能推出去（见 pushSizes）：现在补推一次。
        pushSizes(lastWanted)
      }
      log.info(`[pet-desktop] ${text.trimEnd()}`)
    })
    spawned.stderr?.on('data', (chunk) => log.warn(`[pet-desktop] ${String(chunk).trimEnd()}`))
    spawned.on('exit', (code) => {
      if (child === spawned) {
        child = null
        runningKey = ''
      }
      // 非 0 退出说明它自己崩了：留下原因，下次 sync 会重试。
      if (code !== 0 && code !== null) lastReason = `helper 退出（code ${code}）`
    })
    log.info(`桌面宠物：已拉起 ${wanted.length} 只（${wanted.map((pet) => pet.id).join(', ')}）`)
    return true
  }

  /**
   * 插件卸载 / 宿主退出：收干净，绝不留孤儿窗。
   *
   * 两条路都要有：`stop()` 是"现在就杀"，`process.on('exit')` 是宿主被硬杀时
   * 还能赶在 Node 收尾时补一刀（`unref` 之后子进程不再拖住事件循环，所以
   * 宿主正常退出时这条钩子是唯一能主动收它的地方）。
   */
  const dispose = () => {
    disposed = true
    stop()
  }

  const onHostExit = () => stop()
  process.once('exit', onHostExit)

  return { available, reason, sync, resize, stop, dispose, hostPollMs: HOST_POLL_MS }
}
