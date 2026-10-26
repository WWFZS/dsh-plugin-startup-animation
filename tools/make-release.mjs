/**
 * make-release.mjs —— 从工作仓库生成"可以直接发布"的目录。
 *
 * 为什么不直接 `npm publish` 当前目录：仓库里同时放着 4K 母版（约 57 MB）与
 * 1080p 分发版（约 13 MB）。母版是源素材，不该进包 —— 否则用户下载 67 MB，
 * 其中 44 MB 是他们永远不会播的文件。
 *
 * 产物：dist/dsh-plugin-startup-animation/
 *   - 只含运行期文件 + 文档 + 图标 + license
 *   - builtin/ 只保留 *.web.mp4，丢掉 4K 原片
 *   - 校验：包名/patch/client id 三者一致；manifest files 覆盖所有运行期文件
 *
 * 用法：node tools/make-release.mjs [--out <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
// 包就在仓库根目录：这样用户能直接 `github:user/repo` 安装，不带 #path: 后缀。
const sourceDir = repoRoot
const outFlag = process.argv.indexOf('--out')
const outRoot =
  outFlag >= 0 && process.argv[outFlag + 1] !== undefined
    ? path.resolve(process.argv[outFlag + 1])
    : path.join(repoRoot, 'dist')

const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'))
const clientSrc = fs.readFileSync(path.join(sourceDir, 'client.js'), 'utf8')
const patchSrc = fs.readFileSync(path.join(sourceDir, 'cordis.patch.yml'), 'utf8')

const problems = []
const note = (message) => problems.push(message)

// ── 1. 三处名字必须一致 ──
const clientId = /id:\s*'([^']+)'/.exec(clientSrc)?.[1]
const patchName = /name:\s*'([^']+)'/.exec(patchSrc)?.[1]
if (clientId !== manifest.name) note(`client.js 模块 id "${clientId}" ≠ 包名 "${manifest.name}"`)
if (patchName !== manifest.name) note(`cordis.patch.yml 行名 "${patchName}" ≠ 包名 "${manifest.name}"`)

// ── 2. 运行期文件都要在 files 里 ──
const REQUIRED = ['index.js', 'client.js', 'cordis.patch.yml', 'runtime/boot.css', 'runtime/boot.js', 'icon.svg']
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(sourceDir, rel))) note(`缺少运行期文件：${rel}`)
  const covered = (manifest.files ?? []).some((pattern) => {
    if (pattern === rel) return true
    if (pattern.endsWith('/**/*')) return rel.startsWith(pattern.slice(0, -5))
    if (pattern.endsWith('/*')) return path.dirname(rel) === pattern.slice(0, -2)
    return false
  })
  if (!covered) note(`files 未覆盖运行期文件：${rel}`)
}
for (const locale of ['locale/zh.json', 'locale/en.json']) {
  if (!fs.existsSync(path.join(sourceDir, locale))) note(`缺少语言文件：${locale}`)
}

// ── 3. 导出必须齐全（插件的素材/图标依赖它们） ──
for (const key of ['.', './client', './icon', './locale/*.json', './package.json']) {
  if (manifest.exports?.[key] === undefined) note(`exports 缺少 "${key}"`)
}

// ── 4. dsh 段 ──
if (manifest.dsh?.bundle?.patch === undefined) note('dsh.bundle.patch 缺失（不会成为 bundle）')
if (manifest.dsh?.client?.platform !== 'web') note('dsh.client.platform 必须是 "web"')

// ── 5. engines ──
if (manifest.engines?.dsh === undefined) note('engines.dsh 缺失（市场无法判断兼容性）')

if (problems.length > 0) {
  console.error('发布前检查未通过：')
  for (const problem of problems) console.error(`  ! ${problem}`)
  process.exit(1)
}

// ── 复制 ──
const target = path.join(outRoot, manifest.name)
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })

/**
 * 按 package.json 的 `files` 白名单复制。
 *
 * 包搬到仓库根目录后不能再"整目录递归复制" —— 那样会把 tools/、selftest.mjs、
 * dist/、.git/ 全打进发布包。白名单是唯一的事实来源：它决定 npm 发什么，
 * 也决定这里复制什么，两边同名规则。
 */
const matches = (relPosix, pattern) => {
  if (pattern.startsWith('!')) return false
  if (pattern === relPosix) return true
  if (pattern.endsWith('/**/*')) {
    const base = pattern.slice(0, -5)
    return relPosix === base || relPosix.startsWith(`${base}/`)
  }
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2)
    return relPosix.startsWith(`${base}/`) && !relPosix.slice(base.length + 1).includes('/')
  }
  return false
}

const files = manifest.files ?? []
const copied = []
const copyFile = (rel) => {
  const src = path.join(sourceDir, rel)
  const dst = path.join(target, rel)
  // 4K 母版不进发布包：对应的 *.web.mp4 已在白名单里单独命中。
  if (/[\\/]\.upload-|\.tmp$/.test(rel)) return
  if (/\.mp4$/i.test(rel) && !rel.toLowerCase().endsWith('.web.mp4')) return
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  copied.push(rel)
}

const walkSource = (dir, prefix) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // 只在某个白名单模式可能命中该子树时才递归。
      const hitsDir = files.some((pattern) => {
        const base = pattern.replace(/\/\*\*\/\*$/, '').replace(/\/\*$/, '')
        return rel === base || rel.startsWith(`${base}/`) || base.startsWith(`${rel}/`)
      })
      if (hitsDir) walkSource(abs, rel)
    } else if (files.some((pattern) => matches(rel, pattern))) {
      copyFile(rel)
    }
  }
}
walkSource(sourceDir, '')

// 白名单里点名的单个文件（不含通配）必然要复制过来。
for (const pattern of files) {
  if (pattern.includes('*')) continue
  if (!copied.includes(pattern) && fs.existsSync(path.join(sourceDir, pattern))) copyFile(pattern)
}

// package.json 是包的元数据（版本号、dsh 段、exports 全靠它），任何情况下都必须带。
// npm 自己总会包含它，但这里是按白名单复制的，漏掉就会出现"装好即 0.0.0"。
if (!copied.includes('package.json')) copyFile('package.json')

// ── 统计 ──
const walk = (dir) => {
  let bytes = 0
  let files = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = walk(abs)
      bytes += sub.bytes
      files += sub.files
    } else {
      bytes += fs.statSync(abs).size
      files += 1
    }
  }
  return { bytes, files }
}
const total = walk(target)
console.log(`发布目录：${path.relative(repoRoot, target)}`)
console.log(`文件数：${total.files}，总大小：${(total.bytes / 1048576).toFixed(1)} MB`)
console.log(`\n检查通过：包名 "${manifest.name}"、patch、client id 一致；files/exports/engines 齐全。`)
