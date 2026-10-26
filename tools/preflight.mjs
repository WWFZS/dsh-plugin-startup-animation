/**
 * preflight.mjs —— 发布前一键检查（跨平台，不需要 bash）。
 *
 * 顺序：语法 → 单元测试 → 宿主路由测试 → 素材构建（有 ffmpeg 才做）→ 发布目录。
 * 任何一步非零退出即中止。
 *
 * 用法：node tools/preflight.mjs [--skip-build]
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const skipBuild = process.argv.includes('--skip-build')

/** 跑一个 node 脚本，继承输出；失败即抛出。 */
const run = (args) => {
  console.log(`\n$ node ${args.join(' ')}`)
  execFileSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' })
}

const step = (title) => console.log(`\n── ${title} ──`)

step('语法检查')
for (const file of ['index.js', 'client.js', 'runtime/boot.js']) {
  execFileSync(process.execPath, ['--check', file], { cwd: repoRoot, stdio: 'inherit' })
  console.log(`  ok  ${file}`)
}

step('单元测试')
run(['selftest.mjs'])

step('宿主路由测试')
run(['tools/host-smoke.mjs'])

step('素材构建')
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
if (skipBuild) {
  console.log('  已跳过（--skip-build）')
} else if (!hasFfmpeg) {
  console.log('  ffmpeg 不在 PATH，跳过（继续使用已有产物）')
} else {
  run(['tools/optimize-builtin.mjs'])
  run(['tools/make-thumbs.mjs'])
}

step('发布目录')
run(['tools/make-release.mjs'])

const target = path.join(repoRoot, 'dist', 'dsh-plugin-startup-animation')
if (!existsSync(target)) {
  console.error('\n发布目录没有生成')
  process.exit(1)
}
console.log('\nPREFLIGHT OK')
