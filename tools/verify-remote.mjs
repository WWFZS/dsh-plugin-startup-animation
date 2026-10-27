/**
 * verify-remote.mjs —— 逐文件核对远程分支与本地 HEAD 是否一致。
 *
 * 为什么需要它：GitHub 的 Git Data API 推送**会静默地**毁掉仓库 ——
 * 一次错误的树构建就能把根目录的文件全删掉，而推送本身返回 200、不报错。
 * 所以"推完了"不能当作"推对了"，
 * 必须有人真的去比对一遍。
 *
 * 核对三件事：
 *   1. 本地每个文件在远程都有，且 blob sha 完全一致；
 *   2. 远程没有本地没有的文件（远程多出来的要么是历史遗留，要么是脏数据）；
 *   3. 远程的提交历史接得上（parent 链没有断）。
 *
 * 用法：GH_TOKEN=... node tools/verify-remote.mjs <owner> <repo> [branch]
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const [owner, repo, branchArg] = process.argv.slice(2)
const branch = branchArg ?? 'master'
const token = process.env.GH_TOKEN

if (!owner || !repo) {
  console.error('usage: GH_TOKEN=... node tools/verify-remote.mjs <owner> <repo> [branch]')
  process.exit(2)
}

const API = 'https://api.github.com'
const redact = (text) =>
  String(text).replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, '$1_***REDACTED***')

const request = async (method, url) => {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-plugin-startup-animation-verify',
    },
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${redact(text).slice(0, 300)}`)
  return text === '' ? {} : JSON.parse(text)
}

const git = (...args) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString()

// ── 本地 ──
const localFiles = new Map(
  git('ls-tree', '-r', 'HEAD')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [meta, filePath] = line.split('\t')
      return [filePath, meta.split(/\s+/)[2]]
    }),
)

// ── 远程 ──
const head = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
const remoteHead = head.object.sha
const commit = await request('GET', `/repos/${owner}/${repo}/git/commits/${remoteHead}`)
const tree = await request('GET', `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`)
const remoteFiles = new Map(
  tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]),
)

console.log(`本地 HEAD   = ${git('rev-parse', 'HEAD').trim()}`)
console.log(`远程 ${branch} = ${remoteHead}`)
console.log('')

const missing = []
const differ = []
for (const [filePath, sha] of localFiles) {
  if (!remoteFiles.has(filePath)) missing.push(filePath)
  else if (remoteFiles.get(filePath) !== sha) differ.push(filePath)
}
const extra = [...remoteFiles.keys()].filter((filePath) => !localFiles.has(filePath))

console.log(`本地文件 = ${localFiles.size}    远程 blob = ${remoteFiles.size}`)
console.log(`本地缺失于远程 = ${missing.length}`)
for (const filePath of missing) console.log(`  ! 缺失: ${filePath}`)
console.log(`内容不一致     = ${differ.length}`)
for (const filePath of differ) console.log(`  ! 不一致: ${filePath}`)
console.log(`远程多出       = ${extra.length}`)
for (const filePath of extra) console.log(`  ? 多出: ${filePath}`)

// ── 历史链 ──
//
// 用 /commits/<sha> 端点（它返回 commit 对象，含 message 与 parents）。
// 注意：/git/commits/<sha> 返回的是**裸 commit 对象**（没有 commit 包装层），
// 两者形状不同 —— 别混用。
let cursor = remoteHead
let depth = 0
const chain = []
while (cursor !== undefined && depth < 12) {
  const node = await request('GET', `/repos/${owner}/${repo}/commits/${cursor}`)
  chain.push(`${node.sha.slice(0, 8)}  ${node.commit.message.split('\n')[0]}`)
  cursor = node.parents[0]?.sha
  depth += 1
}
console.log('\n远程提交链：')
for (const line of chain) console.log(`  ${line}`)

const ok = missing.length === 0 && differ.length === 0 && extra.length === 0
console.log('')
if (!ok) {
  console.error('核对失败：远程与本地不一致')
  process.exit(1)
}
console.log('核对通过：远程与本地逐文件完全一致')
