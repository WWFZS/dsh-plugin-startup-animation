/**
 * startup-animation —— 宿主半边。
 *
 * 两件事，仅此而已：
 *   ① 给 `webserver/index-inject` 贡献三行结构化注入（global 配置 + 样式 + 运行时脚本），
 *      它们在页面自己的启动脚本之前/之间挂上**全屏开机动画覆盖层**；
 *   ② 用带 Range/ETag 的路由把用户指定的动画素材提供给浏览器。
 *
 * 设计约束（来自 dsh-video-skin 踩过的坑，逐条遵守）：
 *   - `export const inject = []`，且不 import 任何 DSH/第三方包（只用 node: 内建）：
 *     对象级 inject 会把 apply 推迟到服务就绪之后，而桌面壳的注入表在宿主启动时
 *     收集一次、没有刷新路径 —— 订阅晚于那次收集，注入行就永远进不了表。
 *     模块求值期的任何 import 失败也等于插件全灭，node: 内建没有这条路径。
 *   - 注入行只推 `kind:'global' | 'style' | 'script'`，绝不推 `kind:'script-src'`：
 *     后者在桌面壳上失败会把 `__DSH_BOOT_READY__` 打掉，整个应用起不来。
 *   - style 行推在 script 行之前（渲染器按 placement 分组，但页面侧解释器按数组顺序）。
 *   - 任何一步（读配置、读素材、读运行时文件）出错都只 warn 并跳过，绝不向上抛：
 *     插件出问题时页面回落到内核原生启动页，动画缺席而已。
 *   - 素材路径做逃逸防护（包内相对路径不许 `../` 跳出包根），配置来自文件也不读包外。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PACKAGE_NAME,
  describeSelfInstall,
  findPnpm,
  readBundleSelection,
  readProfileManifest,
  userDataPaths,
  withSelf,
  withoutSelf,
  writeBundleSelection,
  writeJsonAtomic,
  writeProfileManifest,
} from './lib/self-manage.mjs'

/** Cordis 诊断用的插件名。 */
export const name = 'startup-animation'

/** 没有必需服务：`webServer` 用 `ctx.inject` 迟到接入，不阻塞 apply。 */
export const inject = []

/**
 * 版本号**只从 package.json 读**，不在这里手写第二份。
 *
 * 之前这里是常量 `'1.7.1'`，而 package.json 已经到 1.8.0 —— 设置页显示版本号时
 * 就会报错一个根本不存在的版本，更新检查也会永远判定"有新版本"。
 * 包内相对路径读自己的清单在 ESM 里是安全的（同包文件，不走模块解析）。
 */
export const VERSION = (() => {
  try {
    const raw = fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch {
    /* 见下面的调试标记 */
  }
  // 读不到版本是**打包缺陷**（清单没随包分发），不是运行时环境问题。
  // 保留 '0.0.0' 让功能继续跑，但要留下痕迹，否则用户只会看到"版本 0.0.0"
  // 并且每个 Release 都被判成"有新版本"，却无从得知原因。
  if (typeof process !== 'undefined') {
    try {
      process.emitWarning?.(
        '[startup-animation] 读不到自身的 package.json，版本号回落 0.0.0 —— 安装包缺少清单文件',
        'StartupAnimationWarning',
      )
    } catch {
      /* 仅诊断 */
    }
  }
  return '0.0.0'
})()

/**
 * 磁盘上**实际安装的**版本号（每次实时读 package.json）。
 *
 * 为什么不能只用上面的 `VERSION`：那个常量在模块加载时读一次就固定了。
 * 用户点「一键更新」之后，磁盘上的清单已经换成新版，但**运行中的进程**还是旧代码
 * —— `VERSION` 仍是旧值，于是 /update 一直拿旧版本去和 GitHub 比，界面就永远停在
 * 「v1.12.1 · 更新到 1.12.2」，用户以为没更新成功，反复点。
 *
 * 用户问"我装的是哪个版本"，答案在磁盘上。读失败才回落 `VERSION`
 * （正常安装不会失败，失败说明包被改动过）。
 *
 * @param {string} packageRoot 包根目录。
 * @returns {string} 版本号。
 */
export function installedVersion(packageRoot) {
  try {
    const raw = fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch {
    /* 回落到加载时的版本 */
  }
  return VERSION
}

/** 素材路由（页面侧用根相对路径引用，与参考实现一致，桌面壳同样可达）。 */
export const ASSET_ROUTE = '/dsh-startup-animation/asset'

/** 管理路由：GET 状态 / POST 上传或开关 / DELETE 恢复默认。 */
export const MANAGE_ROUTE = '/dsh-startup-animation/manage'

/** 更新检查路由：GET 当前版本 vs GitHub 最新 Release。 */
export const UPDATE_ROUTE = '/dsh-startup-animation/update'

/**
 * 自我管理路由：POST 卸载本插件 / POST 更新本插件。
 *
 * 为什么插件要自带这两个动作（v1.11.0）：
 *
 * 宿主插件管理器的 `removeBundle()` 在 **profile 没启用 HMR** 时会拒绝卸载
 * "正在使用的包"（抛 `stop-profile`）—— 桌面 profile 默认就是没 HMR 的，
 * 所以用户在 **设置 → 插件** 里点卸载必然失败。这不是 bug，是宿主的硬约束。
 *
 * 但那条约束只针对"从运行中的进程里卸载"。插件自己的宿主半边可以像
 * `dsh plugin --profile <p> remove <pkg>` 那样，直接在 profile 目录跑 pnpm
 * 改磁盘（依赖 + bundles 列表），改完提示用户重启 DSH。命令行那条路本来
 * 就是通的、只是用户不一定知道 —— 把它做成设置页里的一个按钮，
 * 用户就不用去记命令行了。
 *
 * 更新同理：插件可以自己在 profile 目录跑 `pnpm add` 把版本升上去。
 *
 * 自我管理不单独占路由：状态与动作都并进了 `MANAGE_ROUTE`。原先那条
 * `/dsh-startup-animation/self` 在某些宿主上会被别的东西吃掉（GET/POST
 * 都直接 400、连 body 都没有），设置页读不到安装形态，卸载/更新按钮
 * 整块不显示 —— 一条已经验证可用的路由比两条各有用处的路由更可靠。
 */

/**
 * 版本比较：只比较 `MAJOR.MINOR.PATCH` 的数字段，忽略预发布后缀。
 *
 * 为什么不用现成的 semver 库：插件零依赖是硬约束（宿主半边只用 node: 内建）。
 * "有没有新版本"只需要大小关系，不需要满足 range —— 真正需要 range 的兼容性
 * 判断交给插件管理器和市场（它们读 engines.dsh），这里不重复实现。
 *
 * @param {string} a 版本 a。
 * @param {string} b 版本 b。
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0。
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    // GitHub 的 tag 习惯带 v 前缀（v1.10.0），必须剥掉再比，否则永远判"无更新"。
    const text = String(value ?? '').trim().replace(/^v/i, '')
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text)
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1
    if (left[i] < right[i]) return -1
  }
  return 0
}

/**
 * 更新检查结果缓存（进程内）：GitHub 匿名 API 每小时只给 60 次，
 * 而设置页可能被反复打开。成功结果缓存 15 分钟 —— 原来是 6 小时，
 * 结果作者自己发完新版、设置页还挂着"已是最新"（缓存里是上一个版本），
 * 用户会以为更新机制坏了。15 分钟对 60 次/小时的额度也很宽松。
 * 失败只缓存 5 分钟（网络抖动不该让用户等一整天才能重试）。
 */
const updateCache = { at: 0, ttlMs: 0, value: null }

/**
 * 问 GitHub 要最新 Release，和当前版本比较。
 *
 * **网络失败不是错误**：插件在离线环境里也必须能正常用，所以这里任何异常都
 * 归一成 `{ ok: true, reachable: false }` —— 界面显示"检查不到"而不是报错。
 *
 * @param {{ currentVersion: string, repoUrl: string, fetchImpl?: typeof fetch, force?: boolean }} options
 * @returns {Promise<Record<string, unknown>>} 检查结果。
 */
export async function checkForUpdate(options) {
  const now = Date.now()
  if (options.force !== true && updateCache.value !== null && now - updateCache.at < updateCache.ttlMs) {
    return updateCache.value
  }

  const current = options.currentVersion
  /** @type {Record<string, unknown>} */
  let result
  // 显式传 null/false 时**不要**回落到全局 fetch：调用方是在声明"没有网络能力"。
  const doFetch = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl
  if (typeof doFetch !== 'function') {
    result = { ok: true, reachable: false, reason: 'no-fetch', current, latest: null, updateAvailable: false }
  } else {
    const slug = options.repoUrl.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
    const headers = {
      // GitHub 要求带 UA；Accept 限定版本，避免拿到 HTML 错误页。
      'User-Agent': `dsh-plugin-startup-animation/${current}`,
      Accept: 'application/vnd.github+json',
    }
    try {
      // 先问 Release（有版本号可读）；没有 Release 就退回 tags。
      const releaseRes = await doFetch(`https://api.github.com/repos/${slug}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(6000),
      })
      let tag = null
      // Release 正文：设置页「更新公告」的内容源。**不在代码里另抄一份更新记录** ——
      // 发布说明只在 GitHub Release 上写一次，这里顺手把它带回来（同一次请求，
      // 不多打一个接口），客户端去掉 markdown 装饰后直接渲染。
      // 4000 字符是上界：公告是摘要，正文再长也不该把设置页撑成一整页。
      let notes = ''
      // `answered` 区分"仓库真的还没有 Release"和"请求根本没被正常应答"：
      // 前者是正常状态（新仓库），后者是故障（限流/代理/格式变化）。
      // 两者对用户都只显示"检查不到"，但原因不同，日志和排查靠它。
      let answered = false
      if (releaseRes.ok) {
        answered = true
        const body = await releaseRes.json()
        tag = typeof body?.tag_name === 'string' ? body.tag_name : null
        if (typeof body?.body === 'string') notes = body.body.slice(0, 4000)
      } else {
        // 404 = 还没有 Release（正常）；其它状态码说明请求本身有问题。
        if (releaseRes.status === 404) answered = true
        const tagsRes = await doFetch(`https://api.github.com/repos/${slug}/tags?per_page=1`, {
          headers,
          signal: AbortSignal.timeout(6000),
        })
        if (tagsRes.ok) {
          answered = true
          const tags = await tagsRes.json()
          if (Array.isArray(tags) && tags.length > 0 && typeof tags[0]?.name === 'string') tag = tags[0].name
        }
      }
      if (tag === null) {
        result = {
          ok: true,
          reachable: false,
          // 仓库还没有任何 Release/tag → 'no-release'；请求未被正常应答 → 'bad-response'。
          reason: answered ? 'no-release' : 'bad-response',
          current,
          latest: null,
          updateAvailable: false,
        }
      } else {
        const latest = String(tag).replace(/^v/i, '')
        const cmp = compareVersions(latest, current)
        result = {
          ok: true,
          reachable: true,
          current,
          latest,
          // 只有"比当前新"才算有更新：本地版本更高（开发中）不该被降级提示。
          updateAvailable: cmp > 0,
          releasesUrl: `${options.repoUrl}/releases`,
          // 更新公告（只在真的读到 Release 时才有；回退 tags 那条路没有正文）。
          notes,
        }
      }
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      result = {
        ok: true,
        reachable: false,
        reason: aborted ? 'timeout' : 'network',
        current,
        latest: null,
        updateAvailable: false,
      }
    }
  }

  const reachable = result.reachable === true
  updateCache.at = now
  updateCache.ttlMs = reachable ? 15 * 60 * 1000 : 5 * 60 * 1000
  updateCache.value = result
  return result
}

/** 仅供测试：清掉更新检查缓存。 */
export function resetUpdateCache() {
  updateCache.at = 0
  updateCache.ttlMs = 0
  updateCache.value = null
}

/** 上传上限 128 MiB。 */
export const MEDIA_LIMIT_BYTES = 128 * 1024 * 1024

/** 上传素材的落盘目录（$DSH_HOME 下，固定，不接受客户端路径）。 */
export const MEDIA_DIR_NAME = 'startup-animation-media'

/** 内置素材库目录名（包内，随插件分发，见 builtin/README 一节的分类结构）。 */
export const BUILTIN_DIR_NAME = 'builtin'

/**
 * 宠物目录（包内 `builtin/宠物/`）。
 *
 * 它和 MP4 / 图片 / 音频并列放在 `builtin/` 下，但**不是启动素材** ——
 * 不出现在素材库列表里（scanLibrary 跳过），只由宠物浮层取用。
 *
 * 目录结构是「一包一只宠物」：
 *
 *     builtin/宠物/河马/pet.json + 待机.webm + …
 *     builtin/宠物/女仆/pet.json + 待机呼吸休闲.webm + …（109 段）
 *
 * `pet.json` 声明语义（哪个文件待机、点击回应、分类），动作本身还是**扫目录**：
 * 往里丢一个 `.webm` 就能在设置页搜索到，不用改代码。
 */
export const PET_DIR_NAME = '宠物'

/** 每个宠物包里的声明文件。没有它这个子目录不算宠物包。 */
export const PET_PACK_FILE = 'pet.json'

/**
 * 宠物包清单：一包 = 一个 `builtin/宠物/<目录>/pet.json`。
 *
 * 返回的对象直接喂给客户端的浮层与设置页，所以这里把「文件路径、语义角色、
 * 分类、封面」一次整理好，前端不再拼路径、不再猜文件名。
 *
 * 约定：
 *   - 动作 id = 文件名（去 `.webm`），显示名也是它；
 *   - `roles.idle` / `roles.drag` 循环播放，其余动作播一遍回待机；
 *   - `categories[].clips` 里没提到的 webm 自动归入「其他」，不会从界面上消失；
 *   - 读不到、`pet.json` 坏掉的包直接跳过 —— 一只宠物不出现，好过整个设置页报错。
 *
 * @param {string} packageRoot 包根。
 * @returns {Array<Record<string, any>>} 宠物包（按 id 排序）。
 */
export function listPetPacks(packageRoot) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(path.join(packageRoot, BUILTIN_DIR_NAME, PET_DIR_NAME), { withFileTypes: true })
  } catch {
    return []
  }
  const packs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const pack = readPetPack(packageRoot, entry.name)
    if (pack !== null) packs.push(pack)
  }
  packs.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  return packs
}

/**
 * 读一个宠物包目录。
 * @param {string} packageRoot 包根。
 * @param {string} dirName `builtin/宠物/` 下的目录名。
 * @returns {Record<string, any> | null} 读不到返回 null。
 */
export function readPetPack(packageRoot, dirName) {
  const relDir = `${BUILTIN_DIR_NAME}/${PET_DIR_NAME}/${dirName}`
  const absDir = path.join(packageRoot, BUILTIN_DIR_NAME, PET_DIR_NAME, dirName)
  /** @type {any} */
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(absDir, PET_PACK_FILE), 'utf8'))
  } catch {
    return null
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null

  /** 目录里真实存在的动作：id → 包内相对路径。 */
  const files = new Map()
  try {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (ext !== '.webm') continue
      const id = entry.name.slice(0, -ext.length)
      if (id === '') continue
      const stat = fs.statSync(path.join(absDir, entry.name))
      if (!stat.isFile() || stat.size <= 0) continue
      files.set(id, `${relDir}/${entry.name}`)
    }
  } catch {
    return null
  }
  if (files.size === 0) return null

  const asList = (/** @type {unknown} */ value) =>
    Array.isArray(value)
      ? value.filter((item) => typeof item === 'string' && item !== '')
      : typeof value === 'string' && value !== ''
        ? [value]
        : []
  const existing = (/** @type {unknown} */ value) => asList(value).filter((name) => files.has(name))
  const fileOf = (/** @type {string} */ name) => {
    const abs = path.join(absDir, name)
    try {
      return fs.statSync(abs).isFile() ? `${relDir}/${name}` : ''
    } catch {
      return ''
    }
  }

  const rawRoles = meta.roles !== null && typeof meta.roles === 'object' ? meta.roles : {}
  const roles = {
    idle: existing(rawRoles.idle)[0] ?? existing(meta.idle)[0] ?? '',
    drag: existing(rawRoles.drag)[0] ?? existing(meta.drag)[0] ?? '',
    clicks: existing(rawRoles.clicks ?? meta.clicks),
    turn: existing(rawRoles.turn ?? meta.turn),
    moves: existing(rawRoles.moves ?? meta.moves),
  }

  /** 动作顺序：待机、拖拽、点击回应、转向、移动、分类…、其他。 */
  const order = []
  const seen = new Set()
  const push = (/** @type {string} */ id) => {
    if (id === '' || seen.has(id) || !files.has(id)) return
    seen.add(id)
    order.push(id)
  }
  push(roles.idle)
  push(roles.drag)
  for (const id of roles.clicks) push(id)
  for (const id of roles.turn) push(id)
  for (const id of roles.moves) push(id)

  const categories = []
  const rawCategories = Array.isArray(meta.categories) ? meta.categories : []
  for (const rawCategory of rawCategories) {
    if (rawCategory === null || typeof rawCategory !== 'object') continue
    const clipIds = existing(rawCategory.clips)
    if (clipIds.length === 0) continue
    for (const id of clipIds) push(id)
    const id = typeof rawCategory.id === 'string' && rawCategory.id !== '' ? rawCategory.id : `cat-${categories.length}`
    categories.push({
      id,
      name: typeof rawCategory.name === 'string' && rawCategory.name !== '' ? rawCategory.name : id,
      cover: typeof rawCategory.cover === 'string' ? fileOf(rawCategory.cover) : '',
      clips: clipIds,
    })
  }

  const extras = [...files.keys()].filter((id) => !seen.has(id))
  for (const id of extras) push(id)
  if (extras.length > 0) {
    categories.push({ id: 'other', name: '其他', cover: '', clips: extras })
  }

  const ambient = (Array.isArray(meta.ambient) ? meta.ambient : [])
    .filter((id) => categories.some((category) => category.id === id && !['balance', 'whisper', 'work', 'sleep', 'other'].includes(id)))
  const [width, height] = Array.isArray(meta.canvas) ? meta.canvas : []
  const cover = typeof meta.cover === 'string' ? fileOf(meta.cover) : ''
  const credit = meta.credit !== null && typeof meta.credit === 'object' ? meta.credit : null

  return {
    id: typeof meta.id === 'string' && meta.id !== '' ? meta.id : dirName,
    name: typeof meta.name === 'string' && meta.name !== '' ? meta.name : dirName,
    description: typeof meta.description === 'string' ? meta.description : '',
    credit:
      credit === null
        ? null
        : {
            author: typeof credit.author === 'string' ? credit.author : '',
            name: typeof credit.name === 'string' ? credit.name : '',
            url: typeof credit.url === 'string' ? credit.url : '',
            license: typeof credit.license === 'string' ? credit.license : '',
          },
    canvas: [
      Number.isFinite(width) && width > 0 ? width : 480,
      Number.isFinite(height) && height > 0 ? height : 648,
    ],
    cover,
    roles,
    /** 参与随机待机的分类；为空时客户端退化为「全部非事件分类」。 */
    ambient,
    categories,
    clips: order.map((id) => ({ id, name: id, file: files.get(id), loop: id === roles.idle || id === roles.drag })),
    count: order.length,
  }
}

/** 仓库主页（更新提示与"查看更新"链接的唯一来源）。 */
export const REPO_URL = 'https://github.com/WWFZS/dsh-plugin-startup-animation'

/**
 * 更新时喂给 pnpm 的目标：Release 的 tgz 直链。
 *
 * 为什么不用 `github:` 里的 git 地址：走 git 要 clone 整个仓库（含内置素材母版），
 * 实测同一个网络下 tgz 约 20 秒、git 要近 3 分钟且经常被掐断。tgz 是打包好的
 * 发布产物，体积更小、路径更短、也不依赖 git。
 */
export const UPDATE_SPEC = `${REPO_URL}/releases/latest/download/dsh-plugin-startup-animation.tgz`

/**
 * 允许 `update` 动作使用的 spec 白名单。
 *
 * 只认本插件自己的两种地址 —— 否则这条接口就成了"往 profile 里塞任意包"的入口。
 * @param {string} spec 客户端给的 spec。
 * @returns {boolean} 是否允许。
 */
export function isAllowedUpdateSpec(spec) {
  return spec === UPDATE_SPEC || /^github:WWFZS\/dsh-plugin-startup-animation$/.test(spec)
}

/** 注入到页面的配置全局名。 */
export const BOOT_GLOBAL = '__DSA_BOOT__'

/**
 * 所有可调项的默认值。默认状态"装上就开箱即用"：
 * 不指定素材也有一个原创的 CSS 动画。
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 是否显示开机动画。false = 运行时不挂载（原版标配启动页）；注入行本身仍然常驻。 */
  enabled: true,
  /** 动画素材：'' = 原版标配（不显示动画）；绝对路径或包内相对路径 = 自己的文件。 */
  file: '',
  /** 展示时长（秒）：MP4 与壁纸素材共用的主配置，用户可调 3–30。 */
  durationSec: 5,
  /** 启动画面上的大标题；'' = 运行时用内置文案。 */
  title: 'DeepSeek Harness',
  /** 视频素材是否尝试带声音播放（普通浏览器被拦会自动退回静音）。 */
  sound: false,
  /** 音量 0..1。 */
  volume: 1,
  /**
   * 开机音频总开关：开 = 动画期间另播所选音频。
   * 它与视频音轨是**两条独立的路**，可以同时开 —— 用户自己决定要听哪个，
   * 插件不替用户做"开一个就关另一个"的决定（早期版本会强制静音视频，那是错的）。
   * 跳过动画时音频同步停止。
   */
  audioEnabled: false,
  /** 开机音频素材：'' = 不播；绝对路径或包内相对路径（builtin/音频/…）= 自己的文件。 */
  audioFile: '',
  /** 音频音量 0..1。 */
  audioVolume: 1,
  /** 交接淡出时长（固定值，不是"剩余时间"）。 */
  fadeMs: 600,
  /** 点击/按键跳过时的淡出时长——要短，用户已经决定不等了。 */
  skipFadeMs: 240,
  /** 动画的最短展示时间，防止一闪而过。 */
  minMs: 900,
  /** 内核迟迟不就绪的上界：到点先转成"启动较慢"（并乐观视为就绪）。 */
  holdMs: 20000,
  /** holdMs 之后的宽限，到点才真的让开，免得把动画拦腰截断。 */
  holdGraceMs: 4000,
  /** 视频开始播但一帧都出不来，多久判定素材坏了。 */
  noFrameMs: 10000,
  /** 时长未知（duration=Infinity）时的唯一上界。 */
  endlessMs: 20000,
  /** 是否显示真实启动进度条（内核暴露进度弧时用真实值，否则流光）。 */
  progress: true,
  /** 状态行文字；'' = 运行时按浏览器语言选择中/英。 */
  hint: '',
  /** "点击画面跳过"胶囊文案；'' = 运行时按语言选择。 */
  skipLabel: '',
  /** 声音被浏览器拦下时开关的文案；'' = 运行时按语言选择。 */
  soundLabel: '',
  // ── 桌面宠物（浮在 DSH 界面上的透明小动物）──
  /** 是否显示宠物。默认关：装上新版不该突然冒出一只动物。 */
  petEnabled: false,
  /** 宠物显示宽度（px）。高度按素材 3:4 自动算。 */
  petSize: 176,
  /** 宠物位置：0–100 的百分比，100 = 贴右/贴下。见 client.js 的定位算法。 */
  petX: 100,
  petY: 100,
  /** 当前宠物的包 id（`builtin/宠物/<目录>/pet.json` 的 id）；'' = 第一个包。 */
  petPack: '',
})

/** 素材扩展名 → 运行时呈现方式。不支持的扩展名只让该素材降级，不影响动画本身。 */
const ASSET_KINDS = Object.freeze({
  '.mp4': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.ogv': 'video',
  '.ogg': 'video',
  '.gif': 'image',
  '.apng': 'image',
  '.webp': 'image',
  '.png': 'still',
  '.jpg': 'still',
  '.jpeg': 'still',
  // 音频（开机音频域专用；kind='audio' 不进 boot.file 的视频/图片管线）。
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.opus': 'audio',
})

/**
 * 取一个安全的错误描述。
 * @param {unknown} error 任意抛出的值。
 * @returns {string} 一行文本。
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * DSH_HOME 的位置。宿主进程通常已经带着 `DSH_HOME`，没有时退回 `~/.dsh`。
 * @param {NodeJS.ProcessEnv} [env] 环境变量表。
 * @param {() => string} [homedir] home 目录提供者。
 * @returns {string | undefined} DSH_HOME 的绝对路径。
 */
export function resolveDshHome(env = process.env, homedir) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : undefined
  if (fromEnv !== undefined) return path.resolve(fromEnv)
  try {
    const home = typeof homedir === 'function' ? homedir() : undefined
    return home === undefined ? undefined : path.join(home, '.dsh')
  } catch {
    return undefined
  }
}

/**
 * 读一个 JSON 文件；不存在/坏了都返回 `undefined` 而不是抛。
 * @param {string} file 绝对路径。
 * @returns {Record<string, unknown> | undefined} 解析出的对象。
 */
export function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 数字夹取：NaN/类型不对回默认值，±Infinity 夹到边界。
 * @param {unknown} value 原始值。 @param {number} fallback 默认值。
 * @param {number} min 下界。 @param {number} max 上界。
 * @returns {number} 夹好的数字。
 */
function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 非空字符串取值；类型不对/空串回默认值。
 * @param {unknown} value 原始值。 @param {string} fallback 默认值。
 * @returns {string} 字符串。
 */
function pickString(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * 展示时长夹取：3–30 秒（含），四舍五入取整；非法值回退默认 5。
 * @param {unknown} value 原始值。 @param {number} [fallback] 默认值。
 * @returns {number} 3..30 的整数秒。
 */
export function clampDurationSec(value, fallback = 5) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < 3) return 3
  if (rounded > 30) return 30
  return rounded
}

/**
 * 把包内相对路径解析到绝对路径，并挡住 `../` 逃逸。
 * @param {string} packageRoot 包根。 @param {string} relative 包内相对路径。
 * @returns {string} 绝对路径。
 */
function resolveInsidePackage(packageRoot, relative) {
  const base = path.resolve(packageRoot)
  const abs = path.resolve(base, relative)
  const root = base.endsWith(path.sep) ? base : base + path.sep
  if (abs !== base && !abs.startsWith(root)) {
    throw new Error(`path escapes the package: ${relative}`)
  }
  return abs
}

/**
 * 内置视频的"网页版"变体后缀：`多重影像.mp4` 分发的是 `多重影像.web.mp4`
 * （1080p / faststart / 去音轨，构建期由 tools/optimize-builtin.mjs 生成）。
 *
 * 为什么带后缀而不是覆盖原文件：仓库里保留 4K 原片作为源素材，用户拿到的包只有
 * 压缩版。查找时**先看变体**，没有就回落原文件 —— 变体缺失不影响功能。
 */
export const WEB_VARIANT_SUFFIX = '.web.mp4'

/**
 * 给内置视频找实际分发文件：优先 `*.web.mp4`，否则原文件。
 * @param {string} filePath 声明的素材路径（绝对）。 @param {string} packageRoot 包根。
 * @returns {string} 实际要发送的文件绝对路径。
 */
export function preferredAssetPath(filePath, packageRoot) {
  if (path.extname(filePath).toLowerCase() !== '.mp4') return filePath
  const candidate = `${filePath.slice(0, -4)}${WEB_VARIANT_SUFFIX}`
  try {
    const stat = fs.statSync(candidate)
    if (stat.isFile() && stat.size > 0) return candidate
  } catch {
    /* 没有变体就用原文件 */
  }
  return filePath
}

/**
 * 解析素材路径：绝对路径 = 用户自己的文件；相对路径 = 包内并做逃逸防护。
 * 存在性与"非空普通文件"在这里一起验证。
 * @param {string} file '' 表示不用素材。 @param {string} packageRoot 包根。
 * @returns {string | undefined} 绝对路径；'' 输入返回 undefined。
 */
function resolveAssetFile(file, packageRoot) {
  if (file === '') return undefined
  const declared = path.isAbsolute(file) ? path.normalize(file) : resolveInsidePackage(packageRoot, file)
  // 内置视频可能只有 .web.mp4 变体（发布包里不含 4K 原片）：先按变体找。
  const candidates = path.isAbsolute(file) ? [declared] : [preferredAssetPath(declared, packageRoot), declared]
  for (const abs of candidates) {
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size <= 0) continue
    return abs
  }
  throw new Error(`not a non-empty file (${file})`)
}

/**
 * 配置文件合并（包内一份、DSH_HOME 一份，后者优先），只取 `boot` 段。
 * @param {{ packageRoot: string, homeDir?: string }} options 位置。
 * @returns {{ raw: Record<string, unknown>, sources: string[] }} 合并后的 boot 段与命中文件。
 */
export function loadRawBoot(options) {
  const sources = []
  /** @type {Record<string, unknown>} */
  let raw = {}
  const candidates = [path.join(options.packageRoot, 'startup-animation.config.json')]
  if (typeof options.homeDir === 'string' && options.homeDir !== '') {
    candidates.push(path.join(options.homeDir, 'startup-animation.json'))
  }
  for (const file of candidates) {
    const parsed = readJsonFile(file)
    if (parsed === undefined) continue
    sources.push(file)
    const boot = parsed.boot
    if (typeof boot === 'object' && boot !== null && !Array.isArray(boot)) {
      raw = { ...raw, ...boot }
    }
  }
  return { raw, sources }
}

/**
 * 端到端：读配置文件 → 合并默认值 → 夹取 → 解析素材。
 * 每次索引渲染都会调用（很便宜），所以改完 JSON 刷新/重启即可生效。
 *
 * 顺带把合并前的 `raw` 段与命中的 `sources` 一起返回：调用方经常两者都要
 * （管理接口要 `file`/`audioFile`/`deleted` 原值，启动日志要"配置来源"），
 * 再单独调一次 `loadRawBoot` 就是同一份文件读两遍。
 *
 * @param {{ packageRoot: string, homeDir?: string, route: string }} options 位置。
 * @returns {{ client: Record<string, unknown>, assetPath: string | undefined, warnings: string[], raw: Record<string, unknown>, sources: string[] }} 运行时配置。
 */
export function loadConfig(options) {
  const warnings = []
  const { raw, sources } = loadRawBoot(options)
  const d = DEFAULT_CONFIG

  /** @type {string | undefined} */
  let assetPath
  /** @type {string} */
  let mode = 'css'
  /** @type {boolean} */
  let still = false
  const file = pickString(raw.file, d.file)
  if (file !== '' && raw.enabled !== false) {
    try {
      assetPath = resolveAssetFile(file, options.packageRoot)
      if (assetPath !== undefined) {
        const kind = ASSET_KINDS[path.extname(assetPath).toLowerCase()]
        if (kind === undefined || kind === 'audio') {
          warnings.push(`boot.file: unsupported type "${path.extname(assetPath) || '?'}" — 启动画面支持 mp4/webm/ogv/ogg 视频与 gif/apng/webp/png/jpg 图片（音频请在"开机音频"里选择），已回落到内置动画`)
          assetPath = undefined
        } else {
          // 运行时只认 video/image 两种素材模式；'still'（png/jpg）是 image 的静帧子类，
          // 走 image 分支（叠加 cfg.still 控制缓慢呼吸），否则图片素材根本不会被挂出来。
          mode = kind === 'still' ? 'image' : kind
          still = kind === 'still'
        }
      }
    } catch (error) {
      warnings.push(`boot.file: ${describe(error)} — 已回落到内置动画`)
      assetPath = undefined
      mode = 'css'
      still = false
    }
  }

  // ── 开机音频域：开关 + 素材（只收音频类型；经 ?path= 通道取流）──
  const audioEnabled = raw.audioEnabled === true
  /** @type {string} */
  let audioSrc = ''
  /** @type {string} */
  let audioName = ''
  /** @type {boolean} */
  let audioBuiltin = false
  if (audioEnabled) {
    const af = pickString(raw.audioFile, d.audioFile)
    if (af !== '') {
      try {
        const abs = resolveAssetFile(af, options.packageRoot)
        if (ASSET_KINDS[path.extname(abs).toLowerCase()] === 'audio') {
          audioSrc = `${options.route}?path=${encodeURIComponent(af)}`
          audioName = path.basename(abs)
          audioBuiltin = af.replace(/\\/g, '/').startsWith(`${BUILTIN_DIR_NAME}/`)
        } else {
          warnings.push(`boot.audioFile: "${path.extname(abs) || '?'}" 不是音频（支持 mp3/wav/m4a/aac/flac/opus），已忽略`)
        }
      } catch (error) {
        warnings.push(`boot.audioFile: ${describe(error)} — 已忽略`)
      }
    }
  }

  // 共用主配置：MP4 与壁纸素材的最短展示时长 = durationSec（3–30 秒，点击跳过不受它限制）。
  // 内置 CSS 动画维持短 minMs（够看出动画即可，防止一闪而过）。
  const durationSec = clampDurationSec(raw.durationSec, d.durationSec)
  const minMs =
    mode === 'video' || mode === 'image'
      ? durationSec * 1000
      : clampNumber(raw.minMs, d.minMs, 0, 30000)

  const client = {
    version: VERSION,
    enabled: raw.enabled !== false,
    mode,
    still,
    /** 素材路由（mode 非 css 时页面请求它）；无素材为 ''。 */
    src: assetPath === undefined ? '' : options.route,
    title: pickString(raw.title, d.title),
    sound: raw.sound === true,
    volume: clampNumber(raw.volume, d.volume, 0, 1),
    audioEnabled,
    audioSrc,
    audioVolume: clampNumber(raw.audioVolume, d.audioVolume, 0, 1),
    fadeMs: clampNumber(raw.fadeMs, d.fadeMs, 100, 6000),
    skipFadeMs: clampNumber(raw.skipFadeMs, d.skipFadeMs, 60, 2000),
    minMs,
    durationSec,
    holdMs: clampNumber(raw.holdMs, d.holdMs, 2000, 120000),
    holdGraceMs: clampNumber(raw.holdGraceMs, d.holdGraceMs, 0, 30000),
    noFrameMs: clampNumber(raw.noFrameMs, d.noFrameMs, 1500, 30000),
    endlessMs: clampNumber(raw.endlessMs, d.endlessMs, 3000, 60000),
    progress: raw.progress !== false,
    hint: pickString(raw.hint, ''),
    skipLabel: pickString(raw.skipLabel, ''),
    soundLabel: pickString(raw.soundLabel, ''),
  }

  return { client, assetPath, warnings, raw, sources }
}

/**
 * 造一个"按 mtime+size 缓存"的运行时文件读取器。
 *
 * 缓存的意义不只是省 IO：桌面壳只在宿主启动时收集一次注入表，所以运行时文本是否
 * 新鲜由那次收集决定；每次收集都会 stat 一次，改了文件重启即可生效。
 *
 * @param {string} packageRoot 包根目录。
 * @returns {(file: string) => string} 读取器（读不到时抛出，由调用方降级）。
 */
function makeRuntimeReader(packageRoot) {
  const cache = new Map()
  return (file) => {
    const target = path.join(packageRoot, 'runtime', file)
    const stat = fs.statSync(target)
    const hit = cache.get(file)
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
    const text = fs.readFileSync(target, 'utf8')
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text })
    return text
  }
}

/** 让出事件循环 await 用（删除重试必须让发送流的 fd 异步关闭）。 */
const sleepMs = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

/** 正在发送中的素材流：filePath → Set<stream>。删除前先释放，避免 Windows 句柄占用 → EPERM。 */
const ACTIVE_STREAMS = new Map()

/**
 * 登记一条发送流，并在流关闭时自动注销。
 * @param {string} filePath 素材路径。 @param {import('node:fs').ReadStream} stream 读取流。
 */
export function trackStream(filePath, stream) {
  let set = ACTIVE_STREAMS.get(filePath)
  if (set === undefined) {
    set = new Set()
    ACTIVE_STREAMS.set(filePath, set)
  }
  set.add(stream)
  stream.once('close', () => {
    set.delete(stream)
    if (set.size === 0) ACTIVE_STREAMS.delete(filePath)
  })
}

/**
 * 释放某个文件的全部发送流（真删素材前调用）。
 * @param {string} filePath 素材路径。 @returns {number} 被销毁的流数量。
 */
export function releaseStreams(filePath) {
  const set = ACTIVE_STREAMS.get(filePath)
  if (set === undefined) return 0
  const streams = [...set]
  ACTIVE_STREAMS.delete(filePath)
  for (const stream of streams) {
    try {
      stream.destroy()
    } catch {
      /* 已关闭 */
    }
  }
  return streams.length
}

/**
 * 发送流打开/读取失败的统一处理：响应头还没出去 → 回 404 文本（客户端 onerror
 * 优雅隐藏预览，而不是"空响应断连"）；头已出去 → 只能断连。
 * @param {import('node:http').ServerResponse} res 响应对象。
 */
function failStream(res) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  try {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('startup animation asset unreadable')
  } catch {
    res.destroy()
  }
}

/**
 * 把一个文件按 HTTP 语义发给浏览器：ETag + Range + HEAD。
 *
 * 缓存头分两种：
 *   - **整片**响应用 `no-cache` + `ETag`：要回源校验一次，没换素材就是 304，秒回；
 *   - **切片（206）**响应用 `no-store`：绝不允许播放器把部分响应当完整资源缓存，
 *     否则下次会拿到截断副本（表现为黑屏，硬刷新却正常）。
 *
 * @param {import('node:http').IncomingMessage} req 入站请求。
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {string} filePath 素材的绝对路径。
 */
export function serveAsset(req, res, filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('startup animation asset not found')
    return
  }

  const size = stat.size
  const etag = `"${size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`
  const range = parseRange(req.headers.range, size)

  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
    res.end()
    return
  }

  /** @type {Record<string, string | number>} */
  const headers = {
    'Content-Type': contentTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    ETag: etag,
  }

  if (range !== null) {
    headers['Cache-Control'] = 'no-store'
    headers['Content-Length'] = range.end - range.start + 1
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    res.writeHead(206, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end })
    stream.on('error', () => failStream(res))
    // 客户端中途断开（视频 seek 取消/页面卸载）→ 立刻销毁源流，否则句柄泄漏
    // 会让该文件在 Windows 上永远删不掉（EPERM）。
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy()
    })
    trackStream(filePath, stream)
    stream.pipe(res)
    return
  }

  headers['Cache-Control'] = 'no-cache'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['Content-Length'] = size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(filePath)
  stream.on('error', () => failStream(res))
  res.on('close', () => {
    if (!res.writableEnded) stream.destroy()
  })
  trackStream(filePath, stream)
  stream.pipe(res)
}

/**
 * 解析单段 Range 头。
 * @param {unknown} value `Range` 请求头。
 * @param {number} size 文件大小。
 * @returns {null | { start: number, end: number } | 'unsatisfiable'} null = 没有/忽略 Range。
 */
export function parseRange(value, size) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^bytes=/i.test(trimmed)) return null
  const spec = trimmed.slice(6).trim()
  if (spec === '' || spec.includes(',')) return null
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 素材扩展名 → Content-Type。
 * @param {string} filePath 文件路径。
 * @returns {string} MIME。
 */
export function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.ogv':
    case '.ogg':
      return 'video/ogg'
    case '.gif':
      return 'image/gif'
    case '.apng':
      return 'image/apng'
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.opus':
      return 'audio/opus'
    default:
      return 'application/octet-stream'
  }
}

/** 卡片/小预览用的缩略图目录名（包内每个素材分类下都有一份）。 */
export const THUMB_DIR_NAME = '.thumbs'

/** 图片类素材才做缩略图（视频走浏览器自己的封面帧）。 */
const THUMBABLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.apng'])

/** 视频手工封面目录名（与图片缩略图并列放在素材分类下）。 */
export const POSTER_DIR_NAME = '.posters'

/**
 * 找一段视频的**手工封面**（`builtin/<分类>/.posters/<素材名>.jpg`）。
 *
 * 为什么手工封面和自动挑帧都要有：
 *   自动挑帧（客户端）解决的是"开头是黑场"这类通用问题；但它只会选最亮的那帧，
 *   而有的素材最亮的那段恰恰是特效/转场（《dsh-大肥鱼》先走线稿发光，再变正片），
 *   亮 ≠ 好看。这种"人眼才知道哪帧好看"的情况，就固定一张事先挑好的封面。
 *
 * 优先级：手工封面 > 客户端自动挑帧 > 浏览器首帧。三者都拿不到也照样能显示。
 *
 * @param {string} filePath 视频的绝对路径。
 * @returns {string | undefined} 封面图绝对路径。
 */
export function posterFor(filePath) {
  const dir = path.join(path.dirname(filePath), POSTER_DIR_NAME)
  const stem = path.parse(filePath).name
  // `.web.mp4` 的分发名要回溯到逻辑名，才能对上 `.posters/<逻辑名>.jpg`。
  const logicalStem = stem.endsWith('.web') ? stem.slice(0, -4) : stem
  for (const candidate of [`${stem}.jpg`, `${logicalStem}.jpg`, `${stem}.png`, `${logicalStem}.png`]) {
    const abs = path.join(dir, candidate)
    try {
      if (fs.statSync(abs).isFile()) return abs
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 找一张图片素材的缩略图（构建期由 tools/make-thumbs.mjs 生成，随包分发）。
 *
 * 存在性和命名规则都在这一个地方：`<同名>.<内容哈希前8位>.jpg`。找不到就返回
 * `undefined`，调用方回落到原图 —— 缩略图是性能优化，绝不能成为"素材显示不出来"的原因。
 *
 * @param {string} filePath 素材的绝对路径。
 * @returns {string | undefined} 缩略图绝对路径。
 */
export function thumbnailFor(filePath) {
  if (!THUMBABLE.has(path.extname(filePath).toLowerCase())) return undefined
  const dir = path.join(path.dirname(filePath), THUMB_DIR_NAME)
  const prefix = `${path.parse(filePath).name}.`
  for (const entry of thumbFiles(dir)) {
    if (entry.startsWith(prefix)) return path.join(dir, entry)
  }
  return undefined
}

/** 缩略图目录索引缓存：目录路径 → { mtimeMs, files }。 */
const THUMB_FILE_CACHE = new Map()
/** 目录不存在/读不到时的共享空表（只读，别往里 push）。 */
const NO_THUMB_FILES = []

/**
 * 列一个缩略图目录里的 .jpg 文件，按目录 mtime 缓存。
 *
 * 为什么值得缓存：素材网格一次渲染要对同一批素材各查一遍缩略图，原先是
 * 每查一次就 `readdirSync` + 逐个 `statSync` —— 7 张壁纸等于 7 次目录扫描。
 * 目录 mtime 一变（重新生成缩略图、增删素材）缓存自然失效，不需要手动清。
 *
 * @param {string} dir 缩略图目录。
 * @returns {string[]} 目录内的 .jpg 文件名。
 */
function thumbFiles(dir) {
  let mtimeMs
  try {
    mtimeMs = fs.statSync(dir).mtimeMs
  } catch {
    return NO_THUMB_FILES
  }
  const hit = THUMB_FILE_CACHE.get(dir)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.files
  /** @type {string[]} */
  let files = NO_THUMB_FILES
  try {
    files = fs.readdirSync(dir).filter((entry) => {
      if (!entry.endsWith('.jpg')) return false
      try {
        return fs.statSync(path.join(dir, entry)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    files = NO_THUMB_FILES
  }
  THUMB_FILE_CACHE.set(dir, { mtimeMs, files })
  return files
}

/**
 * 清掉素材目录里遗留的上传临时文件（`.upload-*.part`）。
 *
 * 崩溃/断电/进程被杀都会留下半截临时文件；它们不参与列表，只会一直占着几十 MB。
 * 启动时扫一次，超过 1 天的才删（避免误删另一个仍在进行的慢速上传）。
 *
 * @param {string | undefined} homeDir DSH_HOME。
 * @returns {number} 删除的文件数。
 */
export function sweepUploadTempFiles(homeDir) {
  if (typeof homeDir !== 'string' || homeDir === '') return 0
  const dir = path.join(homeDir, MEDIA_DIR_NAME)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of entries) {
    if (!name.startsWith('.upload-') || !name.endsWith('.part')) continue
    const abs = path.join(dir, name)
    try {
      if (fs.statSync(abs).mtimeMs > cutoff) continue
      fs.rmSync(abs, { force: true })
      removed += 1
    } catch {
      /* 尽力而为 */
    }
  }
  return removed
}

/**
 * 把 `boot` 段的改动合并写进 `$DSH_HOME/startup-animation.json`（其余键原样保留）。
 * `patch` 里的 `undefined` 与 `removes` 中的键都表示删除（回到默认值）。
 *
 * 为什么走文件而不是浏览器存储：桌面壳页面的存储可用性取决于自定义协议是否被注册成
 * privileged，不确定的事不押注；文件在哪个形态下都一样，而且用户能直接打开看/改。
 *
 * @param {string | undefined} homeDir DSH_HOME。
 * @param {Record<string, unknown>} patch 要写入的 boot 键。
 * @param {string[]} [removes] 要删除的 boot 键。
 * @returns {string} 写入的文件绝对路径。
 */
export function writeHomeBootPatch(homeDir, patch, removes = []) {
  if (typeof homeDir !== 'string' || homeDir === '') throw new Error('DSH_HOME is unavailable')
  const file = path.join(homeDir, 'startup-animation.json')
  const current = readJsonFile(file) ?? {}
  const existing = typeof current.boot === 'object' && current.boot !== null && !Array.isArray(current.boot) ? current.boot : {}
  /** @type {Record<string, unknown>} */
  const boot = { ...existing }
  for (const key of removes) delete boot[key]
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete boot[key]
    else boot[key] = value
  }
  const next = { ...current }
  if (Object.keys(boot).length === 0) delete next.boot
  else next.boot = boot
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 原子写：管理接口是并发可达的（多个页面同时开着设置页），直接 writeFileSync
  // 有截断窗口 —— 崩在中间会让配置文件变成半截 JSON，下次 loadConfig 读不出任何
  // 配置（用户视角是"动画突然全没了"）。实现与 profile 清单共用一份。
  return writeJsonAtomic(file, next)
}

/**
 * 从文件名挑扩展名；不在白名单里直接拒绝（与其让用户面对黑屏，不如当场说清楚）。
 * @param {string} filename 客户端文件名。
 * @returns {string | undefined} 带点的扩展名。
 */
export function pickMediaExtension(filename) {
  const ext = path.extname(String(filename ?? '')).toLowerCase()
  return Object.hasOwn(ASSET_KINDS, ext) ? ext : undefined
}

/**
 * 上传落盘文件名净化：保留用户原始文件名（含中文），只去掉路径与非法字符。
 * 去掉任何目录部分、控制符与 Windows 非法字符（`<>:"|?*`），限长 110；
 * 结果为空（如 `..`）时返回 ''，由调用方兜底命名。
 *
 * 还要绕过 Windows 的**设备名**：`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` /
 * `LPT1-9` 不管带不带扩展名都被当成设备，`fs.linkSync` 会 EPERM，用户看到的
 * 只是"保存失败" —— 而文件名本身完全合法，没人会想到是名字的问题。
 *
 * @param {string} filename 客户端上传的原始文件名。
 * @returns {string} 净化后的文件名（不含目录）。
 */
export function sanitizeUploadName(filename) {
  const base = path.basename(String(filename ?? '').replace(/\\/g, '/'))
  let name = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim()
  name = name.replace(/^\.+/, '')
  if (name === '' || name === '.' || name === '..') return ''
  const ext = path.extname(name)
  if (name.length > 110) name = name.slice(0, Math.max(1, 110 - ext.length)) + ext
  return avoidWindowsDeviceName(name)
}

/** Windows 保留设备名（大小写不敏感，且只看第一个点之前的部分）。 */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 给撞上设备名的文件加一个下划线前缀。
 * 判据用"第一个点之前"而不是 `path.extname` 的 stem：Windows 对
 * `con.tar.gz` 一样当设备，取 stem 会漏。
 * @param {string} name 已净化的文件名。
 * @returns {string} 可落盘的文件名。
 */
function avoidWindowsDeviceName(name) {
  if (!WINDOWS_DEVICE_NAME.test(name.split('.')[0])) return name
  return `_${name}`
}

/**
 * 列出素材库（内置 + 上传合并）：
 *   - `builtin/` 下每个子目录是一个内置分类（如 MP4、图片）；tombstone 条目不出现；
 *   - `$DSH_HOME/startup-animation-media/` 里的用户上传文件**按扩展名自动归类**：
 *     视频 → MP4 分类，图片 → 图片（壁纸）分类，条目标记 `uploaded: true`。
 *
 * "删除内置"只写 tombstone（包内文件保留，宣传仓库完整）；上传素材的删除是真删（见 removeUploadedFile）。
 *
 * @param {string} packageRoot 包根。
 * @param {string[]} [deleted] 已移除（tombstone）的内置相对路径列表。
 * @param {string} [homeDir] DSH_HOME（提供后才扫描上传目录）。
 * @returns {Array<{ id: string, files: Array<{ path: string, name: string, size: number, uploaded?: boolean }> }>} 分类列表。
 */
export function scanLibrary(packageRoot, deleted = [], homeDir) {
  const hidden = new Set(deleted)
  const rootDir = path.join(packageRoot, BUILTIN_DIR_NAME)
  /** @type {Array<{ id: string, files: Array<{ path: string, name: string, size: number, uploaded?: boolean }> }>} */
  const categories = []
  let dirs
  try {
    dirs = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch {
    dirs = []
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    // 宠物动画不是启动素材：它们只有三个固定文件，由宠物浮层按 PET_CLIPS 取用。
    // 列进素材库只会让用户在"MP4"分类里点到一个 3:4 的小动物。
    if (dir.name === PET_DIR_NAME) continue
    const catDir = path.join(rootDir, dir.name)
    let files
    try {
      files = fs.readdirSync(catDir, { withFileTypes: true })
    } catch {
      continue
    }
    /** @type {Array<{ path: string, name: string, size: number, uploaded?: boolean }>} */
    const items = []
    // 内置视频的原片与网页版变体（`*.web.mp4`）在用户眼里是**同一个素材**：
    // 对外只报原片的名字（配置里写的、tombstone 记的都是它），体积按实际分发的
    // 文件算。这样开发仓库（两份都在）与发布包（只有变体）看到的是同一份列表，
    // 用户以前标记移除过的条目也不会因为改名而"复活"。
    // 直接枚举"逻辑条目"：每个逻辑名对应一个实际分发文件。
    //   - 有 `X.web.mp4` → 逻辑名 `X.mp4`，分发 `X.web.mp4`（发布包只有这一份）
    //   - 只有 `X.mp4`   → 逻辑名 `X.mp4`，分发 `X.mp4`（开发期的 4K 母版，URL 仍可访问）
    /** @type {Map<string, string>} 逻辑名 → 分发文件名 */
    const videoEntries = new Map()
    for (const file of files) {
      if (!file.isFile()) continue
      const lower = file.name.toLowerCase()
      if (lower.endsWith(WEB_VARIANT_SUFFIX)) {
        videoEntries.set(`${file.name.slice(0, -WEB_VARIANT_SUFFIX.length)}.mp4`, file.name)
      }
    }
    for (const file of files) {
      if (!file.isFile()) continue
      const lower = file.name.toLowerCase()
      if (lower.endsWith(WEB_VARIANT_SUFFIX)) continue
      if (path.extname(lower) !== '.mp4') continue
      if (!videoEntries.has(file.name)) videoEntries.set(file.name, file.name)
    }

    // 视频：每个逻辑条目一条（不会把母版和变体各列一次）。
    for (const [logicalName, servedName] of videoEntries) {
      const rel = `${BUILTIN_DIR_NAME}/${dir.name}/${logicalName}`
      if (hidden.has(rel)) continue
      let size = 0
      try {
        size = fs.statSync(path.join(catDir, servedName)).size
      } catch {
        continue
      }
      items.push({ path: rel, name: logicalName, size })
    }
    // 非视频素材：逐个列。
    for (const file of files) {
      if (!file.isFile()) continue
      if (file.name.toLowerCase().endsWith(WEB_VARIANT_SUFFIX)) continue
      const ext = path.extname(file.name).toLowerCase()
      if (!Object.hasOwn(ASSET_KINDS, ext)) continue
      if (ext === '.mp4') continue
      const rel = `${BUILTIN_DIR_NAME}/${dir.name}/${file.name}`
      if (hidden.has(rel)) continue
      let size = 0
      try {
        size = fs.statSync(path.join(catDir, file.name)).size
      } catch {
        continue
      }
      items.push({ path: rel, name: file.name, size })
    }
    items.sort(byName)
    if (items.length > 0) categories.push({ id: dir.name, files: items })
  }

  // ── 用户上传的素材：单目录存放，按扩展名自动分入 MP4 / 图片（壁纸）两个分类 ──
  if (typeof homeDir === 'string' && homeDir !== '') {
    const uploadDir = path.join(homeDir, MEDIA_DIR_NAME)
    /** @type {import('node:fs').Dirent[]} */
    let uploads = []
    try {
      uploads = fs.readdirSync(uploadDir, { withFileTypes: true })
    } catch {
      uploads = []
    }
    for (const file of uploads) {
      if (!file.isFile() || file.name.startsWith('.')) continue
      const ext = path.extname(file.name).toLowerCase()
      const kind = ASSET_KINDS[ext]
      if (kind === undefined) continue
      const abs = path.join(uploadDir, file.name)
      if (hidden.has(abs)) continue
      let size = 0
      try {
        size = fs.statSync(abs).size
      } catch {
        continue
      }
      if (size <= 0) continue
      const catId = kind === 'audio' ? '音频' : kind === 'video' ? 'MP4' : '图片'
      let cat = categories.find((entry) => entry.id === catId)
      if (cat === undefined) {
        cat = { id: catId, files: [] }
        categories.push(cat)
      }
      cat.files.push({ path: abs, name: file.name, size, uploaded: true })
    }
  }

  for (const cat of categories) cat.files.sort(byName)
  categories.sort((a, b) => a.id.localeCompare(b.id))
  return categories
}

/**
 * 复制一份环境变量表，去掉指定键。
 *
 * 为什么不能直接 `env: { ...process.env, KEY: undefined }`：Node 会把 `undefined`
 * 当成字符串 "undefined" 传给子进程，而且在某些平台上 spawn 会直接抛 EINVAL。
 * 要删键就得真的删掉。
 *
 * @param {NodeJS.ProcessEnv} source 原环境变量表。
 * @param {string} key 要去掉的键。
 * @returns {NodeJS.ProcessEnv} 新的环境变量表。
 */
export function withoutEnv(source, key) {
  const out = { ...source }
  delete out[key]
  return out
}

/**
 * 在 profile 目录里跑一条 pnpm 命令，返回退出码与输出。
 *
 * 为什么插件要自己跑 pnpm：宿主插件管理器的 `removeBundle()` 在 profile
 * 没启用 HMR 时会拒绝卸载"正在使用的包"（`stop-profile`）—— 桌面 profile
 * 默认没有 HMR，所以设置页里的卸载按钮必然失败。而 `dsh plugin --profile
 * desktop remove <pkg>` 走的正是这条路（跑 pnpm 改磁盘），实测在应用运行
 * 时完全正常。
 *
 * @param {string} profileDir profile 目录（pnpm 在这里跑）。
 * @param {string[]} args pnpm 参数。
 * @param {number} [timeoutMs] 超时上限。
 * @returns {Promise<{ code: number, output: string }>} 退出码与合并后的输出。
 */
export function runProfilePnpm(profileDir, args_, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const pnpm = findPnpm()
    if (pnpm === undefined) {
      resolve({ code: 127, output: 'pnpm not found: install pnpm or use `dsh plugin` instead' })
      return
    }
    let child
    try {
      // Windows 上 `.cmd` 必须走 shell 才能被执行（直接 spawn 会 EINVAL）。
      //
      // 安全：走 shell 时参数不转义就有注入面（Node 警告 DEP0190）。这里的
      // 参数全是固定字面量（'remove' + 本插件包名，见 PACKAGE_NAME），没有
      // 用户输入，但按"有用户输入"的规格处理：整条命令行自己拼、自己引好，
      // 作为一个字符串交给 shell —— 这是 Node 官方对 shell:true 的用法
      // （此时第二个参数必须是空数组）。
      //
      // cmd.exe 的转义规则：双引号内部用 "" 表示一个字面引号；路径含空格
      // 必须整体加引号（"C:\Program Files\nodejs\pnpm.cmd"）。
      const shell = pnpm.shell === true
      const quote = (value) => `"${String(value).replace(/"/g, '""')}"`
      const argv = [...pnpm.args, ...args_]
      // 非 shell：command + 参数数组（Node 负责引用，无注入面）。
      // shell：一条拼好引号的完整命令行 + 空参数数组。
      const command = shell
        ? [quote(pnpm.command), ...argv.map(quote)].join(' ')
        : pnpm.command
      child = spawn(command, shell ? [] : argv, {
        cwd: profileDir,
        windowsHide: true,
        shell,
        // 宿主自己的 pnpm 调用会带上这套环境变量；这里至少要保证
        // ELECTRON_RUN_AS_NODE 不被继承（否则 node 会被当成 Electron 启动）。
        //
        // 注意：不能给 env 里放 `undefined` 的键 —— Node 会把它变成字符串
        // "undefined"，更糟的是在某些平台上直接让 spawn 抛 EINVAL。
        // 要删键就构造一份新对象。
        env: withoutEnv(process.env, 'ELECTRON_RUN_AS_NODE'),
      })
    } catch (error) {
      resolve({ code: 127, output: `cannot start pnpm: ${describe(error)}` })
      return
    }
    let output = ''
    const collect = (chunk) => {
      output += String(chunk)
      // 输出只用于回显给用户，截断避免把整屏日志塞进 JSON。
      if (output.length > 16384) output = output.slice(-16384)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    let timer = null
    let settled = false
    /** 只认第一次落地：error / close / 超时兜底三条路都会走到这里。 */
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      // 只杀直接子进程不够：shell 模式下那是 cmd.exe，pnpm 自己的 node 子进程
      // 会活下来继续改 profile —— 用户看到「更新失败」，磁盘却已经被改了一半，
      // 下一次启动就是一个半新半旧的插件。
      // Windows 用 taskkill /T 连整棵进程树一起收。
      // （POSIX 不用 process.kill(-pid)：没 detached 的子进程不单独成组，
      //   负 pid 会打到调用者自己的进程组，那才是真事故。）
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.on('error', () => {
            /* 退回到下面的单进程 kill */
          })
        } catch {
          /* 退回到下面的单进程 kill */
        }
      }
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      // taskkill 也可能失败（进程已消失、权限不足）：再给 3 秒兜底，
      // 绝不让这个 Promise 永远挂着 —— 设置页会一直转圈到用户重开页面。
      setTimeout(() => {
        finish({ code: 124, output: `${output}\n(timed out after ${timeoutMs}ms)` })
      }, 3000).unref?.()
    }, timeoutMs)
    child.on('error', (error) => {
      finish({ code: 127, output: `cannot run pnpm: ${describe(error)}` })
    })
    child.on('close', (code) => {
      finish({ code: code ?? 1, output })
    })
  })
}

/** 目录联接被占用时的重试间隔（毫秒）与次数。DSH 运行中会一直占着，别把它拖成几十秒。 */
const LINK_CLEANUP_ATTEMPTS = 6
const LINK_CLEANUP_DELAY_MS = 120

/**
 * 清掉 pnpm 没删掉的 `node_modules/<包名>` 链接。
 *
 * 为什么需要：用 `link:` 装进来的插件在 `node_modules` 里是一个**目录联接**。
 * DSH 正跑着时它被当作模块根打开，Windows 下 pnpm 删除它可能失败，于是卸载后
 * 留下一个指向源码目录的联接。下一次安装 pnpm 会把包 import 到
 * `<包名>_tmp_<pid>_<n>` 再 `rename` 过去 —— 覆盖联接点会 EPERM，而宿主给出的
 * 报错是「没有写入权限，无法安装」，看着像权限问题，其实是这个陈旧链接在挡路。
 *
 * 只删**链接**：`rmdirSync` 对联接点/符号链接只移除链接本身、绝不跟进目标；
 * 对真实目录要么删掉空目录（无害），要么 ENOTEMPTY 直接放弃。
 *
 * @param {string} profileDir profile 目录。
 * @returns {Promise<{ removed: boolean, blocked: boolean }>} removed=已清理；blocked=链接还在（多半被 DSH 占用）。
 */
export async function cleanupLinkedInstall(profileDir) {
  const target = path.join(profileDir, 'node_modules', PACKAGE_NAME)
  let stats
  try {
    stats = fs.lstatSync(target)
  } catch {
    return { removed: false, blocked: false } // 本来就不存在
  }
  // 真实目录 = 装好的包，不碰（删了就是破坏）。
  if (stats.isDirectory() && !stats.isSymbolicLink()) return { removed: false, blocked: false }

  for (let attempt = 0; attempt < LINK_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      fs.rmdirSync(target)
      return { removed: true, blocked: false }
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : ''
      if (code === 'ENOENT') return { removed: true, blocked: false }
      // ENOTEMPTY/EACCES 之外的意外错误不重试，如实报 blocked。
      if (code !== 'EPERM' && code !== 'EBUSY') return { removed: false, blocked: true }
    }
    await new Promise((resolve) => setTimeout(resolve, LINK_CLEANUP_DELAY_MS))
  }
  return { removed: false, blocked: true }
}

/**
 * 卸载本插件。
 *
 * 做的四件事，顺序有意义：
 *   1. **先把 bundle 从 profile 的选择列表里去掉** —— 不做的话，依赖被删了
 *      但列表里还留着它，宿主下次启动会报 "not a profile layer"，插件加载失败
 *      （悬空条目）。宿主自己的移除路径也是"先 deselect，再跑 pnpm"。
 *   2. 跑 `pnpm remove` 把依赖与 node_modules 里的链接清掉。
 *   3. pnpm 失败 → 把 bundles 列表**恢复原样**（不能让用户落到半卸载状态）。
 *   4. **不删用户数据**：配置与上传素材留在原地，路径在结果里告诉用户。
 *
 * 桌面没有 HMR，改动要重启 DSH 才生效 —— 结果里如实说明。
 *
 * @param {{ profileDir: string, homeDir?: string }} options 位置。
 * @returns {Promise<{ ok: boolean, restartRequired: boolean, message: string, details?: string, userData?: { config: string, media: string } }>} 结果。
 */
export async function uninstallSelf(options) {
  const profileDir = options.profileDir
  const manifest = readProfileManifest(profileDir)
  if (manifest === undefined) {
    return { ok: false, restartRequired: false, message: '无法读取 profile 的 package.json' }
  }
  const state = describeSelfInstall(manifest)
  if (!state.installed) {
    return { ok: false, restartRequired: false, message: '本插件不在当前 profile 的依赖里' }
  }

  const previousBundles = readBundleSelection(manifest)
  const { bundles: nextBundles, changed: bundlesChanged } = withoutSelf(previousBundles)
  if (bundlesChanged) writeBundleSelection(manifest, nextBundles)
  try {
    writeProfileManifest(profileDir, manifest)
  } catch (error) {
    return { ok: false, restartRequired: false, message: `无法更新 profile 清单：${describe(error)}` }
  }

  // 卸载只是"改磁盘"，不需要重新下载任何东西 —— 先按离线跑（最快，也不怕
  // 用户断网）。但离线模式要求 lockfile 的元数据都在本地缓存里，个别机器上
  // 会因为缓存缺口报 ERR_PNPM_NO_OFFLINE_META —— 所以失败后**去掉离线再试
  // 一次**：能走通的路都走通，不让"卸载"因为一个性能开关而失败。
  let result = await runProfilePnpm(profileDir, ['remove', PACKAGE_NAME, '--config.offline=true'])
  if (result.code !== 0) {
    result = await runProfilePnpm(profileDir, ['remove', PACKAGE_NAME])
  }
  if (result.code !== 0) {
    // 失败回滚：把 bundles 列表写回去，不留半卸载状态。
    const rollback = readProfileManifest(profileDir)
    if (rollback !== undefined) {
      writeBundleSelection(rollback, previousBundles)
      try {
        writeProfileManifest(profileDir, rollback)
      } catch {
        /* 回滚也失败就只能如实报出去 */
      }
    }
    return {
      ok: false,
      restartRequired: false,
      message: '卸载失败，已恢复原有配置',
      details: result.output.slice(-2000),
    }
  }

  // pnpm 成功后再确认一次清单（pnpm 可能重写了 package.json）。
  const after = readProfileManifest(profileDir)
  if (after !== undefined) {
    const stillSelected = readBundleSelection(after).includes(PACKAGE_NAME)
    if (stillSelected) {
      writeBundleSelection(after, withoutSelf(readBundleSelection(after)).bundles)
      try {
        writeProfileManifest(profileDir, after)
      } catch (error) {
        return {
          ok: false,
          restartRequired: true,
          message: `已移除依赖，但未能清理 bundle 选择：${describe(error)}`,
        }
      }
    }
  }

  // pnpm 有时删不掉 node_modules 里的联接（DSH 运行中它被开着）。留着它，
  // 用户下次安装就会撞上 `rename` 覆盖联接点的 EPERM，被宿主报成「没有写入
  // 权限」—— 一个看起来像权限、实际是残留链接的坑。这里补一刀。
  const link = await cleanupLinkedInstall(profileDir)

  return {
    ok: true,
    restartRequired: true,
    message: link.blocked
      ? '已卸载。重启 DSH 后完全生效；node_modules 里还有个链接被占用，重启后删除它再安装。'
      : '已卸载。重启 DSH 后完全生效。',
    userData: userDataPaths(options.homeDir),
  }
}

/**
 * 更新本插件：把依赖换成指定的 spec，并跑 `pnpm install` 装上。
 *
 * 为什么不在设置页里直接下载新版本：更新要走包管理器（校验完整性、跑
 * prepare 脚本、处理依赖树），那是 pnpm 的活。这里只负责把"换成哪个版本"
 * 这件事翻译成一条 pnpm 命令。
 *
 * @param {{ profileDir: string, spec: string }} options 位置与目标 spec。
 * @returns {Promise<{ ok: boolean, restartRequired: boolean, message: string, details?: string }>} 结果。
 */
export async function updateSelf(options) {
  const profileDir = options.profileDir
  const spec = options.spec
  const manifest = readProfileManifest(profileDir)
  if (manifest === undefined) {
    return { ok: false, restartRequired: false, message: '无法读取 profile 的 package.json' }
  }

  // 先把 bundle 放回选择列表 —— pnpm 装完还得让它在列表里才生效。
  // 只在**真的缺**时写清单：省一次磁盘写，也避免无谓地触发宿主的文件监听。
  const previousBundles = readBundleSelection(manifest)
  const { bundles: nextBundles, changed: bundlesChanged } = withSelf(previousBundles)
  if (bundlesChanged) {
    writeBundleSelection(manifest, nextBundles)
    try {
      writeProfileManifest(profileDir, manifest)
    } catch (error) {
      return { ok: false, restartRequired: false, message: `无法更新 profile 清单：${describe(error)}` }
    }
  }

  const result = await runProfilePnpm(profileDir, ['add', spec])
  if (result.code !== 0) {
    // pnpm 失败时把 bundles 列表恢复原样（只有上面真的改过它才需要）。
    if (bundlesChanged) {
      const rollback = readProfileManifest(profileDir)
      if (rollback !== undefined) {
        writeBundleSelection(rollback, previousBundles)
        try {
          writeProfileManifest(profileDir, rollback)
        } catch {
          /* 回滚也失败就只能如实报出去 */
        }
      }
    }
    return {
      ok: false,
      restartRequired: false,
      message: '更新失败',
      details: result.output.slice(-2000),
    }
  }
  // 与卸载同款收尾：pnpm 覆盖 `node_modules` 里的旧联接时同样可能留下
  // `<包名>_tmp_<pid>_<n>` 或没删干净的联接，下一次安装就撞 EPERM，被宿主报成
  // 「没有写入权限」。清理失败不影响"已更新"这个结论，只如实提醒一句。
  const link = await cleanupLinkedInstall(profileDir)
  return {
    ok: true,
    restartRequired: true,
    message: link.blocked
      ? '已更新。重启 DSH 后生效；node_modules 里还有个链接被占用，重启后删除它再更新。'
      : '已更新。重启 DSH 后生效。',
  }
}

/**
 * 本插件在当前 profile 里的安装形态（供设置页显示按钮用）。
 *
 * @param {{ profileDir: string }} options 位置。
 * @returns {{ installed: boolean, selected: boolean, spec: string | undefined }} 安装形态。
 */
export function selfInstallState(options) {
  const manifest = readProfileManifest(options.profileDir)
  if (manifest === undefined) return { installed: false, selected: false, spec: undefined }
  const state = describeSelfInstall(manifest)
  return { installed: state.installed, selected: state.selected, spec: state.spec }
}

/**
 * 校验一个"使用内置素材"的请求：路径必须落在包内 `builtin/` 下、
 * 类型在白名单内、没有被用户移除。不合法直接抛出（信息原样回给客户端）。
 *
 * @param {string} packageRoot 包根。
 * @param {unknown} rel 客户端给的相对路径。
 * @param {string[]} [deleted] tombstone 列表。
 * @returns {string} 规范化后的相对路径（正斜杠，可直接写进配置）。
 * @throws {Error} 校验失败。
 */
export function assertBuiltinFile(packageRoot, rel, deleted = []) {
  if (typeof rel !== 'string' || rel === '') throw new Error('素材路径无效')
  const normalized = rel.replace(/\\/g, '/')
  if (!normalized.startsWith(`${BUILTIN_DIR_NAME}/`)) throw new Error('素材路径无效')
  if (normalized.split('/').includes('..')) throw new Error('素材路径无效')
  const ext = path.extname(normalized).toLowerCase()
  if (!Object.hasOwn(ASSET_KINDS, ext)) throw new Error('不支持的素材类型')
  if (deleted.includes(normalized)) throw new Error('该内置素材已被移除')
  const abs = resolveInsidePackage(packageRoot, normalized)
  const root = path.join(packageRoot, BUILTIN_DIR_NAME)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('素材路径无效')
  // 视频的原片可能在发布包里不存在（只发 .web.mp4 变体）：按"实际分发文件"存在性判断。
  const effective = preferredAssetPath(abs, packageRoot)
  let stat
  try {
    stat = fs.statSync(effective)
  } catch {
    throw new Error(`内置素材不存在：${normalized}`)
  }
  if (!stat.isFile() || stat.size <= 0) throw new Error(`内置素材不存在：${normalized}`)
  return normalized
}

/**
 * 校验一个"上传素材"的引用：必须是落在 `$DSH_HOME/startup-animation-media/` 内的
 * 绝对路径、类型在白名单内、文件真实存在。不合法直接抛出（信息原样回给客户端）。
 *
 * @param {string | undefined} homeDir DSH_HOME。
 * @param {unknown} value 客户端给的绝对路径。
 * @returns {string} 规范化后的绝对路径。
 * @throws {Error} 校验失败。
 */
export function assertUploadedFile(homeDir, value) {
  if (typeof homeDir !== 'string' || homeDir === '') throw new Error('DSH_HOME 不可用')
  if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) throw new Error('素材路径无效')
  const root = path.join(homeDir, MEDIA_DIR_NAME)
  const abs = path.normalize(value)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('素材路径无效')
  const ext = path.extname(abs).toLowerCase()
  if (!Object.hasOwn(ASSET_KINDS, ext)) throw new Error('不支持的素材类型')
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    throw new Error(`上传素材不存在：${path.basename(abs)}`)
  }
  if (!stat.isFile() || stat.size <= 0) throw new Error(`上传素材不存在：${path.basename(abs)}`)
  return abs
}

/**
 * 删除一个用户上传的素材文件（真删 —— 上传素材是用户自己的数据，不是宣传素材）。
 * 校验同 {@link assertUploadedFile}，删不存在的文件不报错（幂等）。
 *
 * @param {string | undefined} homeDir DSH_HOME。
 * @param {unknown} value 客户端给的绝对路径。
 * @returns {string} 被删除文件的规范化绝对路径。
 */
export function removeUploadedFile(homeDir, value) {
  const abs = assertUploadedFile(homeDir, value)
  fs.rmSync(abs, { force: true })
  return abs
}

/**
 * 当前管理状态（界面上"上传/开关/恢复/素材库"的回显）。
 * @param {{ packageRoot: string, homeDir?: string, route: string }} options 位置。
 * @returns {Record<string, unknown>} 状态对象。
 */
export function manageStatus(options) {
  // 一次 loadConfig 就够：`raw` 与 `sources` 已经在里面读好了。
  const { client, assetPath, warnings, raw } = loadConfig(options)
  // 宠物包只扫一次：设置页的宠物卡、浮层的动作表都从它来（每个动作要 stat）。
  const petPacks = listPetPacks(options.packageRoot)
  const wantedPack = typeof raw.petPack === 'string' ? raw.petPack : ''
  const activePack = petPacks.find((pack) => pack.id === wantedPack) ?? petPacks[0] ?? null
  const fileRaw = typeof raw.file === 'string' ? raw.file : ''
  const audioFileRaw = typeof raw.audioFile === 'string' ? raw.audioFile : ''
  const deleted = Array.isArray(raw.deleted)
    ? raw.deleted.filter((value) => typeof value === 'string' && value !== '')
    : []
  return {
    ok: true,
    /** 当前**安装的**版本（实时读 package.json；更新后不必重启即可显示新版本）。 */
    version: installedVersion(options.packageRoot),
    /** 更新检查所需的仓库信息；前端只用它拼 GitHub 链接，不做任何写操作。 */
    repo: REPO_URL,
    releasesUrl: `${REPO_URL}/releases`,
    enabled: client.enabled === true,
    sound: client.sound === true,
    mode: client.mode,
    /** 展示时长（秒，3–30）：MP4 与壁纸共用的主配置。 */
    durationSec: client.durationSec,
    custom: assetPath !== undefined,
    // 界面上显示的名字用"逻辑名"：内置视频分发的是 *.web.mp4 变体，但对用户来说
    // 素材就叫《多重影像.mp4》——内部变体名不该漏到 UI 上。
    name:
      assetPath === undefined
        ? ''
        : path.basename(assetPath).replace(new RegExp(`${WEB_VARIANT_SUFFIX.replace('.', '\\.')}$`, 'i'), '.mp4'),
    /** 配置里原始的素材引用：包内相对路径（内置）或绝对路径（上传）。 */
    file: fileRaw,
    builtin: fileRaw.startsWith(`${BUILTIN_DIR_NAME}/`),
    // ── 开机音频域 ──
    audioEnabled: client.audioEnabled === true,
    audioFile: audioFileRaw,
    audioName: client.audioSrc === '' ? '' : path.basename(audioFileRaw.replace(/\\/g, '/')),
    audioBuiltin: audioFileRaw.replace(/\\/g, '/').startsWith(`${BUILTIN_DIR_NAME}/`),
    audioVolume: client.audioVolume,
    /** 用户从列表移除的内置素材（tombstone）。 */
    deleted,
    /** 素材库：内置 + 上传合并，上传按扩展名自动归入 MP4/图片/音频分类；已排除 tombstone。 */
    library: scanLibrary(options.packageRoot, deleted, options.homeDir),
    limitBytes: MEDIA_LIMIT_BYTES,
    /**
     * 桌面宠物域：开关 / 大小 / 位置 / 当前宠物 / 可用宠物包。
     *
     * `clips[].file` 是包内相对路径，客户端拼成 `ASSET?path=…` 取流 —— 复用既有的
     * 素材路由（它有 Range、ETag、逃逸防护），不为宠物再开一条发文件的通道。
     * 封面同理（`cover` 是图片路径），缩略图不会额外做一份。
     *
     * 包内 `roles` 是**语义**：哪个动作待机、点击时随机播哪几个、拖动时播哪个，
     * 由宿主读 `pet.json` 决定，客户端照用 —— 换一套素材不用动前端。
     */
    pet: {
      enabled: raw.petEnabled === true,
      size: clampNumber(raw.petSize, DEFAULT_CONFIG.petSize, 100, 320),
      x: clampNumber(raw.petX, DEFAULT_CONFIG.petX, 0, 100),
      y: clampNumber(raw.petY, DEFAULT_CONFIG.petY, 0, 100),
      /** 当前宠物的包 id；没有包时 `''`（客户端不建浮层）。 */
      pack: activePack === null ? '' : activePack.id,
      packs: petPacks,
    },
    /**
     * 开机动画运行时的完整配置（boot.js 每次页面加载实时读取它 —— 桌面注入表是宿主
     * 启动时的一次性快照，配置改动必须走实时通道才能"刷新即生效"）。
     */
    cfg: client,
    warnings,
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  const packageRoot = fileURLToPath(new URL('.', import.meta.url))
  const homeDir = resolveDshHome(process.env, os.homedir)
  const readRuntime = makeRuntimeReader(packageRoot)

  /**
   * 每次都重新解析配置：注入行在收集时解析，素材路由在每次请求时解析。
   * @returns {ReturnType<typeof loadConfig>} 解析结果。
   */
  const current = () => loadConfig({ packageRoot, homeDir, route: ASSET_ROUTE })

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[${name}] ${message}`)
    } catch {
      /* 日志都不该成为失败原因 */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`[${name}] ${message}`)
    } catch {
      /* 同上 */
    }
  }

  // ── ⓪ 运行环境自述（只写日志，不参与任何功能判断）──
  //
  // 这个插件横跨两个内核扩展点：`webserver/index-inject`（注入行）与 `webServer.register`
  // （路由）。它们都不是公开稳定 API，DSH 小版本间可能改名/换签名。策略是**探测式降级**
  // 而不是版本号判断：
  //   - 注入点没了 → 页面只是没有动画，内核启动页照常（注册本身包在 try 里）；
  //   - webServer 服务没了 → `ctx.inject(['webServer'])` 根本不回调，插件安静地不提供设置页；
  //   - 任何一处签名变了 → 都走"只 warn、不抛"的路径，绝不让内核起不来。
  // 把宿主版本打进日志，是为了用户报"升级 DSH 后动画没了"时能一眼对上是哪一版。
  try {
    const hostVersion = (() => {
      try {
        // 从内核自己的 package.json 读版本；读不到就算了，不是启动依赖。
        for (const candidate of [
          new URL('./node_modules/@deepseek-ai/dsh/package.json', import.meta.url),
          new URL('./node_modules/@deepseek-ai/dsh-desktop-runtime/package.json', import.meta.url),
        ]) {
          try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
            if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
          } catch {
            /* 换下一个候选 */
          }
        }
      } catch {
        /* 读不到就不报版本 */
      }
      return ''
    })()
    info(`v${VERSION} 已加载${hostVersion === '' ? '' : `（宿主内核 ${hostVersion}）`}`)
  } catch {
    /* 自述失败不影响任何功能 */
  }

  // ── ① 注入行：必须**同步**注册，且不能等到任何服务就绪 ──
  //
  // v1.5.0 关键事实（决定注入策略）：桌面壳把注入表在宿主启动时**收集一次**并缓存
  // （Electron main：`injections = ready.injections` 单次赋值，页面每次加载的 IPC boot
  // 返回同一份缓存），页面刷新不会重新收集。所以这里**无条件注入**三行；
  // "显示不显示 / 用什么素材 / 多久"由运行时（boot.js）**每次页面加载实时读取** manage 接口的
  // cfg 决定 —— 开关、素材、时长等配置改动**刷新页面即生效**，无需重启。
  // global 行仅作为实时读取失败（宿主忙/超时）时的兜底快照。
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      try {
        const { client, warnings } = current()
        for (const warning of warnings) warn(warning)
        // 先把两份运行时文本都读出来，读不到就整体放弃（绝不推半截行）。
        const cssText = readRuntime('boot.css')
        const jsText = readRuntime('boot.js')
        table.push(
          // global 行在 head，脚本在 body：读它的脚本一定在其后执行。
          { kind: 'global', name: BOOT_GLOBAL, value: client },
          { kind: 'style', text: cssText },
          { kind: 'script', placement: 'body', text: jsText },
        )
      } catch (error) {
        // 注入行生成失败只是"没有开机动画"，绝不能让索引渲染失败。
        warn(`注入行生成失败，页面回落到内核原生启动页：${describe(error)}`)
      }
    })
  } catch (error) {
    // 注入事件本身注册失败（未来内核改了事件名/签名）：只是没有开机动画，
    // 内核页面完全正常。绝不能在这里抛 —— apply 抛异常会让整个插件被判 failed。
    warn(`注入事件注册失败，本次启动没有开机动画：${describe(error)}`)
  }

  // ── ② profile 上下文：卸载/更新要知道自己在哪个 profile 里 ──
  //
  // 宿主注入 profileContext（{ name, dir, startedBundles, ... }）。没有它也能活
  // —— 只是"卸载/更新"会用 DSH_HOME/profiles/<name> 兜底推断。
  //
  // 注意：ctx.inject 的回调是**异步**的（依赖就绪才触发），所以这里只把
  // fiber 留着，路由在**请求时**再读 —— 那时值早就到了。
  /** @type {{ name?: string, dir?: string, startedBundles?: string[] } | undefined} */
  let profileContext
  try {
    ctx.inject(['profileContext'], (value) => {
      profileContext = value
    })
  } catch (error) {
    warn(`profileContext 不可用，卸载/更新将按默认 profile 处理：${describe(error)}`)
  }

  // ── ③ 素材路由 + 管理路由：webServer 是可选能力，晚到就晚接，不阻塞 apply ──
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      /** @type {Array<() => void>} */
      const disposers = []

      /** JSON 应答的小工具。 */
      const reply = (res, status, body) => {
        const text = JSON.stringify(body)
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
          'Cache-Control': 'no-store',
        })
        res.end(text)
      }

      /**
       * 取一个查询参数。`req.url` 是 origin-form（`/path?x=1`），必须给个 base 才能
       * `new URL`；这个 base 不参与任何网络动作，只用于解析。解析失败一律当"没这个参数"。
       * @param {import('node:http').IncomingMessage} req 请求。
       * @param {string} key 参数名。
       * @returns {string | null} 参数值（缺省/解析失败为 null）。
       */
      const requestParam = (req, key) => {
        try {
          return new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get(key)
        } catch {
          return null
        }
      }

      /** 布尔开关：`?k=1` 为真，其余（含解析失败）为假。 */
      const requestFlag = (req, key) => requestParam(req, key) === '1'

      /**
       * 跨站写请求拦截。
       *
       * `/manage` 的写操作能跑 pnpm 改磁盘（卸载/更新），是这个插件唯一"能提权"
       * 的入口。它现在靠"自定义头 + JSON Content-Type 需要 CORS 预检"隐含挡着
       * 跨站表单 —— 但那只是浏览器当前实现的副产品，不是我们能承诺的语义。
       * 显式看 `Sec-Fetch-Site` 更直接：浏览器只在真的跨站时才给 `cross-site`。
       *
       * 缺这个头时**放行**：老浏览器、curl、测试工具都没有它，加严会把合法
       * 调用一起挡掉，而它们本来也不受浏览器同源策略保护。
       * @param {import('node:http').IncomingMessage} req 请求。
       * @returns {boolean} 是否应拒绝。
       */
      const isCrossSite = (req) => {
        const site = req.headers['sec-fetch-site']
        return typeof site === 'string' && site.trim().toLowerCase() === 'cross-site'
      }

      // 素材本体：每次请求都重新解析配置。无参数 = 当前选用的素材（开机动画自身）；
      // `?path=` = 列表预览用的任意受校验素材（内置 rel 或 media 目录内绝对路径）。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: ASSET_ROUTE,
          handler: (req, res) => {
            let filePath
            try {
              const wanted = requestParam(req, 'path')
              if (wanted !== null && wanted !== '') {
                if (path.isAbsolute(wanted)) {
                  filePath = assertUploadedFile(homeDir, wanted)
                } else {
                  const { raw } = loadRawBoot({ packageRoot, homeDir })
                  const deleted = Array.isArray(raw.deleted)
                    ? raw.deleted.filter((value) => typeof value === 'string' && value !== '')
                    : []
                  const rel = assertBuiltinFile(packageRoot, wanted, deleted)
                  filePath = preferredAssetPath(resolveInsidePackage(packageRoot, rel), packageRoot)
                }
              } else {
                const { client, assetPath } = current()
                if (client.mode !== 'css' && assetPath !== undefined) filePath = assetPath
              }
            } catch (error) {
              warn(`素材解析失败：${describe(error)}`)
            }
            if (filePath === undefined) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('startup animation asset is unavailable')
              return
            }
            // `?thumb=1`：卡片/小预览要的是 480px 的小图，不是 8000px 的原图。
            // 有预生成缩略图（内置素材）就用它；没有（用户上传）就照常发原图。
            if (requestFlag(req, 'thumb')) {
              const small = thumbnailFor(filePath)
              if (small !== undefined) filePath = small
            }
            // `?poster=1`：视频要一张手工封面（人挑好的那一帧），
            // 因为自动挑帧只会选最亮的，而最亮的不一定是最好看的。
            // 没有手工封面就回 404 —— 以前这里回的是视频本体，客户端再把几 MB
            // 视频塞进 <img> 当封面用（必然解码失败，还要白下一段流量）。
            if (requestFlag(req, 'poster')) {
              const still = posterFor(filePath)
              if (still === undefined) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('no manual poster for this asset')
                return
              }
              filePath = still
            }
            serveAsset(req, res, filePath)
          },
        }),
      )

      // profile 目录：宿主注入的 profileContext 给出当前 profile。
      // 没有它（比如跑在 web 宿主上）就退回 DSH_HOME/profiles/<name>。
      // 自我管理（卸载/更新）也用它 —— 所以提到外面，两个路由共用一份口径。
      const currentProfileDir = () => {
        const profileName = profileContext?.name ?? 'desktop'
        return typeof profileContext?.dir === 'string' && profileContext.dir !== ''
          ? profileContext.dir
          : path.join(homeDir ?? resolveDshHome(process.env, os.homedir) ?? '', 'profiles', profileName)
      }

      // 管理面：GET 状态 / POST(JSON) 开关 / POST(二进制) 上传 / DELETE 恢复默认。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: MANAGE_ROUTE,
          // async 只因为上传分支要 await 临时文件真正打开；cookies 路由那边
          // （webServer）会 await handler，所以这里返回 Promise 是安全的。
          handler: async (req, res) => {
            const options = () => ({ packageRoot, homeDir, route: ASSET_ROUTE })
            // 一个请求里 status() 可能被调用多次（成功分支 + 兜底分支），而每次 manageStatus
            // 都要重扫素材库（stat 每个内置文件）。同一次写操作之后状态只变一次，缓存一份即可；
            // 任何写操作都会 invalidate，不会读到旧值。
            /** @type {{ value: Record<string, unknown> } | null} */
            let statusCache = null
            const invalidate = () => {
              statusCache = null
            }
            const status = () => {
              if (statusCache !== null) return statusCache.value
              let value
              try {
                value = manageStatus(options())
              } catch (error) {
                value = { ok: false, error: describe(error) }
              }
              statusCache = { value }
              return value
            }
            const method = String(req.method ?? 'GET').toUpperCase()

            // 写操作一律先过同源检查（GET 只读，放行）。
            if (method !== 'GET' && method !== 'HEAD' && isCrossSite(req)) {
              reply(res, 403, { ok: false, error: 'cross-site request rejected' })
              req.resume()
              return
            }

            if (method === 'GET') {
              // 开机动画每加载一次页面都会打这个接口（boot.js 的实时配置通道），而
              // 完整 manageStatus 要重扫素材库、stat 每个内置文件 —— 对一个只想要
              // `cfg` 的调用方是白花的 IO。`?cfg=1` 给全屏动画用的精简回包。
              if (requestFlag(req, 'cfg')) {
                try {
                  const { client } = loadConfig(options())
                  reply(res, 200, { ok: true, cfg: client })
                } catch (error) {
                  reply(res, 500, { ok: false, error: describe(error) })
                }
                return
              }
              // 自我管理状态一起回：以前它是单独的 `/self` 端点，但在某些宿主上
              // 那条路由会被别的东西吃掉（GET/POST 都直接 400、连 body 都没有），
              // 设置页因此读不到状态，卸载/更新按钮整块不显示。并进一条已经验证
              // 可用的路由，少一条路由就少一种失败模式。
              const payload = status()
              let self = null
              try {
                self = selfInstallState({ profileDir: currentProfileDir() })
              } catch {
                self = null
              }
              reply(res, payload.ok === false ? 500 : 200, self === null ? payload : { ...payload, self })
              return
            }

            if (method === 'DELETE') {
              // 恢复默认 = 删掉配置里的 file；已上传的文件留在磁盘上，不替用户销毁数据。
              try {
                writeHomeBootPatch(homeDir, {}, ['file'])
                invalidate()
                reply(res, 200, status())
              } catch (error) {
                reply(res, 500, { ok: false, error: `恢复默认失败：${describe(error)}` })
              }
              return
            }

            if (method !== 'POST') {
              reply(res, 405, { ok: false, error: 'use GET, POST or DELETE' })
              return
            }

            const type = String(req.headers['content-type'] ?? '').toLowerCase()

            // ① JSON 体：布尔开关（enabled / sound）或素材库操作（use / forget）。
            if (type.startsWith('application/json')) {
              /** @type {Buffer[]} */
              const chunks = []
              let size = 0
              let aborted = false
              req.on('error', () => {
                if (!aborted) reply(res, 400, { ok: false, error: 'request stream failed' })
              })
              req.on('data', (chunk) => {
                if (aborted) return
                size += chunk.length
                if (size > 4096) {
                  aborted = true
                  reply(res, 413, { ok: false, error: 'body too large' })
                  req.destroy()
                  return
                }
                chunks.push(chunk)
              })
              req.on('end', () => {
                if (aborted) return
                void (async () => {
                  /** @type {Record<string, unknown>} */
                  const body = {}
                  try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) Object.assign(body, parsed)
                  } catch (error) {
                    reply(res, 400, { ok: false, error: 'invalid JSON' })
                    return
                  }

                  // 自我管理动作（卸载 / 更新）：和设置在**同一条路由**上 ——
                  // 独立那条 `/self` 在某些宿主上会被吃掉（400 且无 body），
                  // 设置页读不到状态，卸载/更新按钮整块消失。
                  if (typeof body.action === 'string' && body.action !== '') {
                    const action = body.action
                    if (action === 'uninstall') {
                      void uninstallSelf({ profileDir: currentProfileDir(), homeDir })
                        .then((result) => {
                          reply(res, result.ok ? 200 : 400, {
                            ...result,
                            self: { installed: false, selected: false, spec: undefined },
                          })
                        })
                        .catch((error) => reply(res, 500, { ok: false, message: describe(error) }))
                      return
                    }
                    if (action === 'update') {
                      const target =
                        typeof body.spec === 'string' && body.spec !== '' ? body.spec : UPDATE_SPEC
                      if (!isAllowedUpdateSpec(target)) {
                        reply(res, 400, { ok: false, message: `不支持的更新目标：${target}` })
                        return
                      }
                      void updateSelf({ profileDir: currentProfileDir(), spec: target })
                        .then((result) => {
                          // 换版本成功 → 丢掉"已是最新"的旧结论，别让用户
                          // 刷新后还被告知是最新。
                          if (result.ok) resetUpdateCache()
                          reply(res, result.ok ? 200 : 400, result)
                        })
                        .catch((error) => reply(res, 500, { ok: false, message: describe(error) }))
                      return
                    }
                    reply(res, 400, { ok: false, message: `不支持的动作：${action}` })
                    return
                  }

                  // 素材库操作：use / useAudio = 从列表选用（内置或上传）；forget = 从列表移除。
                  if (body.use !== undefined || body.useAudio !== undefined || body.forget !== undefined) {
                    try {
                      const { raw } = loadRawBoot({ packageRoot, homeDir })
                      const deleted = Array.isArray(raw.deleted)
                        ? raw.deleted.filter((value) => typeof value === 'string' && value !== '')
                        : []
                      const rawFile = typeof raw.file === 'string' ? raw.file : ''
                      const rawAudio = typeof raw.audioFile === 'string' ? raw.audioFile : ''
                      if (body.use !== undefined || body.useAudio !== undefined) {
                        const isAudio = body.use !== undefined ? false : true
                        const given = body.use !== undefined ? body.use : body.useAudio
                        // 绝对路径 = 上传素材；相对路径 = 内置素材（两者校验口径不同）。
                        const target =
                          typeof given === 'string' && path.isAbsolute(given)
                            ? assertUploadedFile(homeDir, given)
                            : assertBuiltinFile(packageRoot, given, deleted)
                        // 音频槽只收音频类型（视频/图片误点会被拒；反之 boot.file 忽略 audio kind）。
                        const kind = ASSET_KINDS[path.extname(target).toLowerCase()]
                        if (isAudio && kind !== 'audio') throw new Error('这不是音频素材')
                        if (!isAudio && kind === 'audio') throw new Error('音频请在"开机音频"里选择')
                        // 同一请求里也可能带着开关/音量（前端可以一次写完）：与选用合并成一次写入。
                        /** @type {Record<string, unknown>} */
                        const libraryPatch = isAudio ? { audioFile: target } : { file: target }
                        // 选中音频即视为要用它；显式 false 仍尊重调用方。
                        if (isAudio) {
                          if (typeof body.audioEnabled === 'boolean') libraryPatch.audioEnabled = body.audioEnabled
                          else libraryPatch.audioEnabled = true
                        }
                        // 视频分支也要认这些开关：以前它们只在选音频时生效，
                        // 于是 `{use: 视频, sound: true}` 里的 sound 被静默丢弃。
                        if (typeof body.sound === 'boolean') libraryPatch.sound = body.sound
                        if (typeof body.enabled === 'boolean') libraryPatch.enabled = body.enabled
                        if (typeof body.audioEnabled === 'boolean' && !isAudio) {
                          libraryPatch.audioEnabled = body.audioEnabled
                        }
                        if (
                          typeof body.audioVolume === 'number' &&
                          Number.isFinite(body.audioVolume)
                        ) {
                          libraryPatch.audioVolume = Math.min(1, Math.max(0, body.audioVolume))
                        }
                        if (typeof body.durationSec === 'number' && Number.isFinite(body.durationSec)) {
                          libraryPatch.durationSec = clampDurationSec(body.durationSec)
                        }
                        writeHomeBootPatch(homeDir, libraryPatch)
                      } else if (typeof body.forget === 'string' && path.isAbsolute(body.forget)) {
                        // ── 上传素材删除（Windows 上文件句柄/权限会导致 EPERM）──
                        // ① 先释放本进程对该文件的全部发送流；② 真删并重试 6 次
                        //    （每次让出事件循环，等流的 fd 异步关闭）；③ 仍失败 → 从列表
                        //    隐藏（写 tombstone，磁盘文件保留），界面提示"仅隐藏"，绝不裸抛错误。
                        const norm = path.normalize(String(body.forget))
                        releaseStreams(norm)
                        let removed = false
                        let lastErr = null
                        for (let attempt = 0; attempt < 6 && !removed; attempt += 1) {
                          try {
                            removeUploadedFile(homeDir, norm)
                            removed = true
                          } catch (error) {
                            lastErr = error
                            if (attempt < 5) await sleepMs(250)
                          }
                        }
                        if (removed) {
                          /** @type {Record<string, undefined>} */
                          const cleared = {}
                          if (rawFile === norm) cleared.file = undefined
                          if (rawAudio === norm) cleared.audioFile = undefined
                          if (Object.keys(cleared).length > 0) writeHomeBootPatch(homeDir, cleared)
                        } else {
                          const next = deleted.includes(norm) ? deleted : [...deleted, norm]
                          /** @type {Record<string, unknown>} */
                          const patch = { deleted: next }
                          if (rawFile === norm) patch.file = undefined
                          if (rawAudio === norm) patch.audioFile = undefined
                          writeHomeBootPatch(homeDir, patch)
                          warn(`上传素材真删失败，已从列表隐藏（磁盘保留）：${describe(lastErr)}`)
                          reply(res, 200, { ...status(), hiddenOnly: true, deleteError: describe(lastErr) })
                          return
                        }
                      } else {
                        if (typeof body.forget !== 'string' || body.forget === '') throw new Error('素材路径无效')
                        const norm = body.forget.replace(/\\/g, '/')
                        if (!norm.startsWith(`${BUILTIN_DIR_NAME}/`) || norm.split('/').includes('..')) {
                          throw new Error('素材路径无效')
                        }
                        // 内置素材：只写 tombstone（隐藏，不删包内文件）。
                        const next = deleted.includes(norm) ? deleted : [...deleted, norm]
                        /** @type {Record<string, unknown>} */
                        const patch = { deleted: next }
                        // 正在使用的素材被移除 → 一并退回（视频/图片→原版标配，音频→不播），不留悬空引用。
                        if (rawFile === norm) patch.file = undefined
                        if (rawAudio === norm) patch.audioFile = undefined
                        writeHomeBootPatch(homeDir, patch)
                      }
                      invalidate()
                      reply(res, 200, status())
                    } catch (error) {
                      reply(res, 400, { ok: false, error: describe(error) })
                    }
                    return
                  }

                  /** @type {Record<string, unknown>} */
                  const patch = {}
                  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
                  if (typeof body.sound === 'boolean') patch.sound = body.sound
                  if (typeof body.audioEnabled === 'boolean') patch.audioEnabled = body.audioEnabled
                  if (body.audioVolume !== undefined) {
                    if (typeof body.audioVolume !== 'number' || !Number.isFinite(body.audioVolume)) {
                      reply(res, 400, { ok: false, error: '音量必须是 0–1 的数字' })
                      return
                    }
                    patch.audioVolume = Math.min(1, Math.max(0, body.audioVolume))
                  }
                  // 展示时长（秒，共用主配置）：必须是数字，写入前夹到 3–30。
                  if (body.durationSec !== undefined) {
                    if (typeof body.durationSec !== 'number' || !Number.isFinite(body.durationSec)) {
                      reply(res, 400, { ok: false, error: '展示时长必须是 3–30 的数字（秒）' })
                      return
                    }
                    patch.durationSec = clampDurationSec(body.durationSec)
                  }
                  // ── 宠物域：开关 / 大小 / 位置 ──
                  // 大小与位置照旧"服务端夹取不给商用"：越界的值就地夹好，不报错 ——
                  // 拖到屏幕边缘时客户端算出的百分比偶尔会是 100.4 这种数。
                  if (typeof body.petEnabled === 'boolean') patch.petEnabled = body.petEnabled
                  if (body.petSize !== undefined) {
                    if (typeof body.petSize !== 'number' || !Number.isFinite(body.petSize)) {
                      reply(res, 400, { ok: false, error: '宠物大小必须是 100–320 的数字（px）' })
                      return
                    }
                    patch.petSize = clampNumber(body.petSize, DEFAULT_CONFIG.petSize, 100, 320)
                  }
                  for (const key of ['petX', 'petY']) {
                    if (body[key] === undefined) continue
                    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
                      reply(res, 400, { ok: false, error: '宠物位置必须是 0–100 的数字' })
                      return
                    }
                    patch[key] = clampNumber(body[key], DEFAULT_CONFIG[key], 0, 100)
                  }
                  // 换宠物：必须是当前安装里真实存在的包 id，否则下次 manage 会静默回落到第一个。
                  if (body.petPack !== undefined) {
                    if (typeof body.petPack !== 'string') {
                      reply(res, 400, { ok: false, error: '宠物选择必须是宠物包 id' })
                      return
                    }
                    if (body.petPack !== '' && !listPetPacks(packageRoot).some((pack) => pack.id === body.petPack)) {
                      reply(res, 400, { ok: false, error: `没有这个宠物包：${body.petPack}` })
                      return
                    }
                    patch.petPack = body.petPack
                  }
                  if (Object.keys(patch).length === 0) {
                    reply(res, 400, { ok: false, error: 'expected "enabled", "sound", "audioEnabled", "audioVolume", "durationSec", "petEnabled", "petSize", "petX", "petY", "petPack", "use", "useAudio" or "forget"' })
                    return
                  }
                  try {
                    writeHomeBootPatch(homeDir, patch)
                    invalidate()
                    reply(res, 200, status())
                  } catch (error) {
                    reply(res, 500, { ok: false, error: `保存失败：${describe(error)}` })
                  }
                })().catch((error) => {
                  // 异步体的兜底：任何未捕获异常 → 400（已应答则忽略，避免二次写头）。
                  try {
                    reply(res, 400, { ok: false, error: describe(error) })
                  } catch {
                    /* 已应答 */
                  }
                })
              })
              return
            }

            // ② 二进制体：上传动画素材。
            const rawName = String(req.headers['x-dsh-filename'] ?? '')
            let filename = rawName
            try {
              filename = decodeURIComponent(rawName)
            } catch {
              /* 传什么用什么 */
            }
            const extension = pickMediaExtension(filename)
            if (extension === undefined) {
              reply(res, 415, {
                ok: false,
                error: '不支持的类型：支持 mp4/webm/ogv/ogg/m4v 视频与 gif/apng/webp/png/jpg 图片',
                filename,
              })
              req.resume()
              return
            }
            if (typeof homeDir !== 'string' || homeDir === '') {
              reply(res, 500, { ok: false, error: 'DSH_HOME 不可用，无法保存素材' })
              req.resume()
              return
            }

            const root = path.join(homeDir, MEDIA_DIR_NAME)
            // 临时名必须唯一到"每次请求"：原先只有 pid+Date.now()，同一毫秒内两个并发上传
            // （同一用户开了两个设置页）会抢同一个 .part 文件，互相覆盖/互删。
            const tempPath = path.join(
              root,
              `.upload-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.part`,
            )
            let failed = false
            /** @type {import('node:fs').WriteStream | null} */
            let sink = null
            /**
             * 建临时文件，并**等它真的打开**再返回。
             *
             * `fs.createWriteStream` 是异步 open：在 open 完成前 `destroy()`，
             * 打开动作照样会完成并把文件创建出来 —— 于是在 Windows 上就出现
             * "撤销得比创建还早"的鬼文件：删除发生在文件存在之前，`.part`
             * 永久留在素材目录里。所以这里显式 await 'open'，失败/撤销都排在它之后。
             * @returns {Promise<import('node:fs').WriteStream | null>} 已打开的流。
             */
            const openSink = () => new Promise((resolve) => {
              let stream
              try {
                stream = fs.createWriteStream(tempPath)
              } catch {
                resolve(null)
                return
              }
              const settle = (ok) => {
                stream.removeListener('open', onOpen)
                stream.removeListener('error', onError)
                resolve(ok ? stream : null)
              }
              const onOpen = () => settle(true)
              const onError = () => {
                try {
                  stream.destroy()
                } catch {
                  /* ignore */
                }
                settle(false)
              }
              stream.once('open', onOpen)
              stream.once('error', onError)
              sink = stream
            })

            const removeTemp = () => {
              const purge = () => {
                try {
                  fs.rmSync(tempPath, { force: true })
                } catch {
                  /* 尽力而为 */
                }
              }
              purge()
              // 句柄可能还在关：再挂一次（close 之后文件才真正可删）。
              if (sink !== null && sink.closed === false) {
                sink.once('close', purge)
                setTimeout(purge, 400).unref?.()
              }
            }
            const cleanup = () => {
              try {
                sink?.destroy()
              } catch {
                /* ignore */
              }
              removeTemp()
            }
            const fail = (status_, body, skipCleanup = false) => {
              if (failed) return
              failed = true
              if (!skipCleanup) cleanup()
              reply(res, status_, body)
            }
            try {
              fs.mkdirSync(root, { recursive: true })
            } catch (error) {
              fail(500, { ok: false, error: `无法创建素材目录：${describe(error)}` })
              return
            }
            sink = await openSink()
            if (sink === null) {
              fail(500, { ok: false, error: '无法创建临时文件' })
              return
            }

            // 上传文件名 = 用户原始文件名（净化 + 重名去重），不用内容哈希命名。
            let received = 0
            sink.on('error', (error) => fail(500, { ok: false, error: `写文件失败：${describe(error)}` }))
            req.on('aborted', () => fail(400, { ok: false, error: 'upload aborted' }))
            req.on('error', () => fail(400, { ok: false, error: 'request stream failed' }))
            req.on('data', (chunk) => {
              if (failed) return
              received += chunk.length
              if (received > MEDIA_LIMIT_BYTES) {
                // 超限：先停写盘、删临时文件（cleanup 会等 fd 关闭后再删），
                // 再回应答，最后才掐连接 —— 顺序反了会在 Windows 上留下 .part。
                fail(413, { ok: false, error: `文件太大（上限 ${Math.round(MEDIA_LIMIT_BYTES / 1024 / 1024)} MiB）` })
                res.once('finish', () => {
                  try {
                    req.destroy()
                  } catch {
                    /* 已经断开 */
                  }
                })
                return
              }
              if (sink !== null && !sink.write(chunk)) {
                req.pause()
                sink.once('drain', () => req.resume())
              }
            })
            req.on('end', () => {
              if (failed || sink === null) return
              if (received === 0) {
                fail(400, { ok: false, error: 'empty file' })
                return
              }
              sink.end(() => {
                if (failed) return
                // 保留用户原始文件名（净化非法字符 + 重名加序号），列表展示即真实文件名。
                const safeName = sanitizeUploadName(filename)
                // 落盘要**原子且不覆盖**：`rename` 在 Windows 上会静默覆盖同名文件
                // （POSIX 也是），所以两个并发同名上传会互相吞掉对方的文件。
                // 先 `link(temp → target)`（目标已存在必然失败，等于"只在不存在时创建"），
                // 成功后删掉临时名；撞名就换下一个序号重试。这条路径没有覆盖窗口。
                let placed = false
                let lastError = null
                const desired = safeName === '' ? `upload${extension}` : safeName
                const stem = path.parse(desired).name
                const ext = path.extname(desired)
                // 从当前空闲序号开始，每次 EEXIST 就跳到下一个序号 —— 不能重试同一个
                // 候选名（另一路并发上传正好赢了它，重试只会一直 EEXIST）。
                let nextIndex = 0
                for (let attempt = 0; attempt < 200 && !placed; attempt += 1) {
                  const candidate =
                    nextIndex === 0 ? desired : `${stem} (${nextIndex})${ext}`
                  nextIndex += 1
                  const target = path.join(root, candidate)
                  try {
                    // link 只在目标不存在时成功，天然没有"检查后使用"的窗口。
                    fs.linkSync(tempPath, target)
                    placed = true
                  } catch (error) {
                    lastError = error
                    if (error && error.code !== 'EEXIST') break
                  }
                }
                if (!placed) {
                  fail(500, { ok: false, error: `保存失败：${describe(lastError)}` })
                  return
                }
                try {
                  fs.rmSync(tempPath, { force: true })
                } catch {
                  /* 临时名删不掉不影响成品；启动清理会兜底 */
                }
                // 上传**只入库不选用**：文件按扩展名自动归入对应分类，用户再从列表点"使用"。
                invalidate()
                reply(res, 200, status())
              })
            })
          },
        }),
      )

      // 更新检查：只读，不写任何文件。界面用它显示标题旁的小字与「有新版本」提示。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: UPDATE_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method !== 'GET' && method !== 'HEAD') {
              reply(res, 405, { ok: false, error: 'use GET' })
              return
            }
            const force = requestFlag(req, 'force')
            // 用**磁盘上**的版本，不是内存里的 VERSION：更新完（磁盘已换新、进程没重启）
            // 时前者是用户真正装上的版本，后者还停在旧值 —— 用旧的比就会一直喊"有新版本"。
            const current = installedVersion(packageRoot)
            // 网络失败不抛：checkForUpdate 已经把任何异常归一成 reachable:false。
            void checkForUpdate({ currentVersion: current, repoUrl: REPO_URL, force })
              .then((result) => {
                reply(res, 200, { ok: true, version: current, repo: REPO_URL, ...result })
              })
              .catch((error) => {
                reply(res, 200, {
                  ok: true,
                  version: current,
                  repo: REPO_URL,
                  reachable: false,
                  reason: describe(error),
                  current,
                  latest: null,
                  updateAvailable: false,
                })
              })
          },
        }),
      )


      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已经注销 */
          }
        }
      }
    })
  })

  try {
    const { client, sources, warnings } = loadConfig({ packageRoot, homeDir, route: ASSET_ROUTE })
    for (const warning of warnings) warn(warning)
    // 崩溃留下的半截上传文件：启动时收一次，别让它们一直占盘。
    try {
      const swept = sweepUploadTempFiles(homeDir)
      if (swept > 0) info(`清理了 ${swept} 个遗留的上传临时文件`)
    } catch {
      /* 清理失败不影响启动 */
    }
    info(
      `已就绪：动画 ${client.enabled === false ? '关闭' : client.mode} · 素材 ${client.src === '' ? '无（原版标配）' : '自定义'}（配置来源：${sources.length === 0 ? '默认值' : sources.join(' → ')}）`,
    )
  } catch (error) {
    warn(`配置读取失败，将使用默认值：${describe(error)}`)
  }
}
