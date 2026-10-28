/**
 * self-manage.mjs —— 插件的**自我管理**（卸载 / 更新）逻辑。
 *
 * 背景：
 *
 * 宿主插件管理器的 `removeBundle()` 在 **profile 没启用 HMR** 时会拒绝卸载
 * "正在使用的包"（抛 `stop-profile`）。桌面 profile 默认没有 HMR，所以用户在
 * **设置 → 插件** 里点卸载必然失败 —— 宿主给的提示是
 * "这个 profile 没有启用 HMR，正在使用的包要停止后用 dsh plugin 卸载"。
 *
 * 但那条约束只管"从运行中的进程里卸载"。**改磁盘**是另一回事：
 * `dsh plugin --profile desktop remove <pkg>` 就是直接跑 pnpm 改 profile 目录，
 * 实测在应用运行时完全正常（依赖和 bundles 列表都会被清掉）。
 *
 * 所以这个模块做的是：把那条"用户不一定知道的命令行"变成设置页里的一个按钮。
 *
 * 设计约束：
 *   - **不碰用户数据**：`$DSH_HOME/startup-animation.json` 和
 *     `startup-animation-media/` 是用户的东西，卸载时不删，只在结果里说明。
 *   - **只动自己**：只改 profile 清单里**本插件**的那一项，绝不碰别的包。
 *   - **改完不假装生效**：桌面没有 HMR，磁盘改动要重启 DSH 才生效 ——
 *     结果里如实带上 `restartRequired`。
 *   - **零依赖**：宿主半边只用 node: 内建（插件的硬约束）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 本插件的包名（清单里依赖项的键，也是 bundles 列表里的名字）。 */
export const PACKAGE_NAME = 'dsh-plugin-startup-animation'

/**
 * 读 profile 的 package.json。
 * @param {string} profileDir profile 目录。
 * @returns {Record<string, unknown> | undefined} 解析后的清单；读不到/坏了返回 undefined。
 */
export function readProfileManifest(profileDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 取 bundles 列表。
 * @param {Record<string, unknown>} manifest profile 清单。
 * @returns {string[]} bundles 名称列表。
 */
export function readBundleSelection(manifest) {
  const dsh = manifest.dsh
  if (typeof dsh !== 'object' || dsh === null) return []
  const profile = dsh.profile
  if (typeof profile !== 'object' || profile === null) return []
  const bundles = profile.bundles
  return Array.isArray(bundles) ? bundles.filter((item) => typeof item === 'string') : []
}

/**
 * 把 bundles 列表里本插件的名字去掉（卸载时用）。
 * @param {string[]} bundles 原列表。
 * @returns {{ bundles: string[], changed: boolean }} 去掉之后的新列表与是否变化。
 */
export function withoutSelf(bundles) {
  const next = bundles.filter((name) => name !== PACKAGE_NAME)
  return { bundles: next, changed: next.length !== bundles.length }
}

/**
 * 把 bundles 列表里本插件的名字**加回去**（更新/重装时用）。
 * @param {string[]} bundles 原列表。
 * @returns {{ bundles: string[], changed: boolean }} 加好之后的新列表与是否变化。
 */
export function withSelf(bundles) {
  if (bundles.includes(PACKAGE_NAME)) return { bundles: [...bundles], changed: false }
  // 追加到末尾：与宿主"安装后把 bundle 追加到选择末尾"的语义一致
  // （宿主 README：installation selects the bundle after pnpm succeeds）。
  return { bundles: [...bundles, PACKAGE_NAME], changed: true }
}

/**
 * 原子写一个 JSON 文件（先写同目录临时文件，再 rename 覆盖）。
 *
 * 为什么自己写而不复用宿主的 atomic-write：宿主那份在 app.asar 里，插件不能
 * import 它（插件的依赖表是空的，import 宿主内部包在发布包里必然失败）。
 *
 * 读者要么看到旧的完整内容，要么看到新的 —— 没有半截 JSON 的窗口。
 * 配置写到一半崩掉，用户视角就是"动画突然全没了"，所以这条语义不能省。
 *
 * @param {string} file 目标文件绝对路径（父目录必须已存在）。
 * @param {unknown} value 要序列化的值（2 空格缩进 + 末尾换行）。
 * @returns {string} 写入的文件绝对路径。
 */
export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* 临时名删不掉不影响主流程 */
    }
    throw error
  }
  return file
}

/**
 * 原子写 profile 的 package.json。
 * @param {string} profileDir profile 目录。
 * @param {Record<string, unknown>} manifest 要写的清单。
 * @returns {string} 写入的文件绝对路径。
 */
export function writeProfileManifest(profileDir, manifest) {
  return writeJsonAtomic(path.join(profileDir, 'package.json'), manifest)
}

/**
 * 插件在当前 profile 里的安装形态。
 * @param {Record<string, unknown>} manifest profile 清单。
 * @returns {{ installed: boolean, spec: string | undefined, selected: boolean }} 安装形态。
 */
export function describeSelfInstall(manifest) {
  const dependencies = manifest.dependencies
  const spec =
    typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)
      ? dependencies[PACKAGE_NAME]
      : undefined
  return {
    installed: typeof spec === 'string',
    spec: typeof spec === 'string' ? spec : undefined,
    selected: readBundleSelection(manifest).includes(PACKAGE_NAME),
  }
}

/**
 * 把清单里本插件的**依赖项**删掉（卸载时用）。
 * @param {Record<string, unknown>} manifest profile 清单（原地修改）。
 * @returns {boolean} 是否真的删掉了。
 */
export function dropSelfDependency(manifest) {
  const dependencies = manifest.dependencies
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) return false
  if (!(PACKAGE_NAME in dependencies)) return false
  delete dependencies[PACKAGE_NAME]
  return true
}

/**
 * 把清单里本插件的**依赖项**设成给定的 spec（更新时用）。
 * @param {Record<string, unknown>} manifest profile 清单（原地修改）。
 * @param {string} spec 新的依赖声明。
 * @returns {boolean} 是否发生了变化。
 */
export function setSelfDependency(manifest, spec) {
  const dependencies = manifest.dependencies
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
    manifest.dependencies = { [PACKAGE_NAME]: spec }
    return true
  }
  if (dependencies[PACKAGE_NAME] === spec) return false
  dependencies[PACKAGE_NAME] = spec
  return true
}

/**
 * 把 bundles 列表写回清单。
 * @param {Record<string, unknown>} manifest profile 清单（原地修改）。
 * @param {string[]} bundles 新的列表。
 */
export function writeBundleSelection(manifest, bundles) {
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh : {}
  const profile = typeof dsh.profile === 'object' && dsh.profile !== null ? dsh.profile : {}
  manifest.dsh = { ...dsh, profile: { ...profile, bundles } }
}

/**
 * 用户数据的位置（卸载时**不删**，只告诉用户在哪）。
 * @param {string | undefined} homeDir DSH_HOME。
 * @returns {{ config: string, media: string }} 配置与上传素材的路径。
 */
export function userDataPaths(homeDir) {
  const base = typeof homeDir === 'string' && homeDir !== '' ? homeDir : ''
  return {
    config: path.join(base, 'startup-animation.json'),
    media: path.join(base, 'startup-animation-media'),
  }
}

/**
 * 找一个可用的 pnpm。
 *
 * 查找顺序：
 *   1. PATH 上的 pnpm（用户自己装的，最常见）；
 *   2. DSH 自带的 pnpm —— 相对宿主可执行文件（`process.execPath`）找：
 *      桌面版是 `<install>/DeepSeek Harness.exe`，pnpm 在
 *      `<install>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`。
 *
 * 为什么不用宿主那条 `packageManager` 配置：那是宿主自己跑 pnpm 用的，
 * 插件拿不到（它在 profileContext 之外），而且它带的是宿主自己的参数。
 * 插件要做的只是"在 profile 目录跑一条 pnpm 命令"，用 pnpm.mjs 直接跑即可。
 *
 * **Windows 上不能直接 spawn `.cmd`**：`spawn('pnpm.cmd', …)` 会抛 EINVAL
 * （Windows 只认可执行文件；`.cmd`/`.bat` 必须走 shell）。而 PATH 上的
 * `pnpm`（无扩展名）通常是 **POSIX shell 脚本**（`#!/bin/sh`），在 Windows 上
 * 同样不能直接 spawn。
 *
 * 所以 Windows 上有三种形态：
 *   - `pnpm.mjs` → 用 node 跑（**最好**：不经 shell，没有引号/转义/注入面）；
 *   - `pnpm.exe` → 直接 spawn；
 *   - `pnpm.cmd` → 必须走 shell（Node 会警告参数未转义 —— 我们的参数全是
 *     固定值，没有用户输入，但能用前者就不用后者）。
 *
 * @param {string} [execPath] 宿主可执行文件路径（默认 process.execPath）。
 * @returns {{ command: string, args: string[], shell: boolean } | undefined} 可用的 pnpm 调用方式。
 */
export function findPnpm(execPath = process.execPath) {
  // ── 1. 宿主自带的 pnpm（最稳：用 node 跑 pnpm.mjs，没有 shell 的坑）──
  const roots = []
  const execDir = path.dirname(execPath)
  roots.push(execDir, path.dirname(execDir))
  for (const root of roots) {
    for (const relative of [
      path.join('resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
      path.join('resources', 'runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
      path.join('runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
      path.join('runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    ]) {
      const candidate = path.join(root, relative)
      try {
        if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate], shell: false }
      } catch {
        /* 不可读就跳过 */
      }
    }
  }

  // ── 2. PATH 上的 pnpm ──
  /** @type {Array<{ command: string, args: string[], shell: boolean }>} */
  const found = []
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '')
  for (const dir of pathDirs) {
    // .exe：Windows 上可直接执行。
    const exe = path.join(dir, 'pnpm.exe')
    try {
      if (fs.existsSync(exe)) found.push({ command: exe, args: [], shell: false })
    } catch {
      /* 不可读就跳过 */
    }
    // .cmd / 无扩展名的脚本：需要 shell。
    for (const name of ['pnpm.cmd', 'pnpm']) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate)) found.push({ command: candidate, args: [], shell: true })
      } catch {
        /* 不可读就跳过 */
      }
    }
  }
  if (found.length > 0) {
    // 可直接执行的排前面（shell 模式有引号/转义的坑，能不用就不用）。
    found.sort((a, b) => Number(a.shell) - Number(b.shell))
    return found[0]
  }
  return undefined
}
