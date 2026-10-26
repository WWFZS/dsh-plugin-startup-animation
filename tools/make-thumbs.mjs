/**
 * make-thumbs.mjs —— 为内置素材生成卡片/预览用的缩略图（构建期一次性，随包分发）。
 *
 * 为什么需要：设置页的素材卡片是 16:9 的小格子，但内置壁纸是 1600×2848 起、
 * 最长边 8000px（单张解码 ≈ 20–100 MB）。浏览器图片解码缓存只有约 20–30 MB，
 * 7 张卡片一次性铺开会互相挤出缓存，表现为"卡片破图/整页卡顿"。
 *
 * 产物：builtin/<分类>/.thumbs/<原文件名>.<hash>.jpg（宽 480，JPEG q=80，约 20–40 KB）。
 * 文件名带内容哈希：用户换素材时 URL 自然变化，不需要清缓存。
 * 不改动原始素材；宿主只在请求 `?thumb=1` 且存在对应文件时才用它。
 *
 * 用法：node tools/make-thumbs.mjs [--force]
 * 依赖：PATH 上的 ffmpeg（开发期工具，不是插件运行期依赖）。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../startup-animation/', import.meta.url))
const builtinRoot = path.join(packageRoot, 'builtin')
const THUMB_DIR = '.thumbs'
const THUMB_WIDTH = 480
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.apng'])
const force = process.argv.includes('--force')

/** 一条 ffmpeg 命令：等比缩到宽 480，转 JPEG（-2 保持偶数高度，避免 yuvj 约束）。 */
function renderThumb(source, target) {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', source,
      // 只取第一帧（gif/apng 也一样），等比缩放。
      '-frames:v', '1',
      '-vf', `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
      '-q:v', '4',
      target,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
}

/** 内容哈希取前 8 位十六进制。 */
function hashOf(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex').slice(0, 8)
}

let made = 0
let skipped = 0
const failures = []

for (const category of fs.readdirSync(builtinRoot, { withFileTypes: true })) {
  if (!category.isDirectory()) continue
  const categoryDir = path.join(builtinRoot, category.name)
  const thumbDir = path.join(categoryDir, THUMB_DIR)
  const images = fs
    .readdirSync(categoryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase()))
  if (images.length === 0) continue
  fs.mkdirSync(thumbDir, { recursive: true })
  // 先清掉本目录的旧缩略图（源文件改名/删除后不留孤儿）。
  for (const stale of fs.readdirSync(thumbDir)) fs.rmSync(path.join(thumbDir, stale), { force: true })
  for (const image of images) {
    const source = path.join(categoryDir, image.name)
    const stem = path.parse(image.name).name
    const target = path.join(thumbDir, `${stem}.${hashOf(source)}.jpg`)
    try {
      renderThumb(source, target)
      const size = fs.statSync(target).size
      console.log(`  ${String(size).padStart(7)} B  ${path.relative(packageRoot, target)}`)
      made += 1
    } catch (error) {
      failures.push(`${image.name}: ${error.message}`)
      skipped += 1
    }
  }
}

console.log(`\n缩略图：生成 ${made}，失败 ${skipped}${force ? '（--force）' : ''}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ! ${failure}`)
  process.exit(1)
}
