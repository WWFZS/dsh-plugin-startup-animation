#!/usr/bin/env node
/**
 * 从宠物包里的透明 webm 抽帧，生成「动作缩略图」与「宠物封面」。
 *
 * 用法：
 *   node tools/make-pet-thumbs.mjs builtin/宠物/噜噜
 *   node tools/make-pet-thumbs.mjs builtin/宠物/女仆
 *
 * 产物（都在包目录内，runtime 按同名约定读取）：
 *   thumbs/<动作>.webp   动作格与搜索 chip 的小图（200×200，紧裁到角色再居中留白）
 *   cover.webp           设置页宠物卡封面（240×240，取待机动作开头那一帧）
 *
 * 为什么要裁：webm 是 480×648 / 360×360 的整幅画面，角色周围全是透明边。
 * 直接把整帧缩成 200×200，角色只占中间一小块，缩略图看不出是什么动作。
 * 先用 alpha 通道测出角色范围（cropdetect 跑在 alphaextract 上），裁掉透明边，
 * 再等比缩进方框、补透明边——这样每张缩略图里角色大小一致。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const FFPROBE = process.env.FFPROBE || 'ffprobe'
const THUMB_SIZE = 200
const COVER_SIZE = 240
/** 裁完再往外留几像素，别把发光/描边切掉。 */
const PAD = 8

const packDir = process.argv[2]
if (!packDir) {
  console.error('用法：node tools/make-pet-thumbs.mjs <宠物包目录>')
  process.exit(1)
}
const absDir = path.resolve(packDir)
const meta = JSON.parse(fs.readFileSync(path.join(absDir, 'pet.json'), 'utf8'))
const idle = typeof meta.roles?.idle === 'string' ? meta.roles.idle : ''

const files = fs
  .readdirSync(absDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.webm'))
  .map((entry) => entry.name)
  .sort()

if (files.length === 0) {
  console.error(`没有 webm：${absDir}`)
  process.exit(1)
}

function run(args) {
  return spawnSync(args[0], args.slice(1), { encoding: 'utf8' })
}

function durationOf(file) {
  const result = run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  return Number.parseFloat(String(result.stdout).trim()) || 0
}

function sizeOf(file) {
  const result = run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'default=nw=1:nk=1', file])
  const [width, height] = String(result.stdout)
    .trim()
    .split(/\s+/)
    .map(Number)
  return { width: width || 0, height: height || 0 }
}

/**
 * 用 alpha 通道算角色包围盒。
 *
 * cropdetect 必须接在 alphaextract 后面：直接拿彩色画面测，透明区是黑色、
 * 也会被当成"有内容"，裁出来还是整幅。alphaextract 出来是灰度图，
 * 透明=0、角色=255，cropdetect 才认得边界。
 * 解 alpha 必须 `-c:v libvpx-vp9`（ffmpeg 原生 vp9 解码器不读 alpha side data）。
 */
function boxOf(file, at) {
  const result = run([
    FFMPEG,
    '-hide_banner',
    '-c:v',
    'libvpx-vp9',
    '-ss',
    String(at),
    '-i',
    file,
    '-frames:v',
    '3',
    '-vf',
    'alphaextract,cropdetect=limit=8:round=2:reset=1:skip=0',
    '-f',
    'null',
    '-',
  ])
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const hits = [...text.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
  if (hits.length === 0) return null
  const last = hits[hits.length - 1]
  return { width: Number(last[1]), height: Number(last[2]), x: Number(last[3]), y: Number(last[4]) }
}

/** 裁到角色 → 等比缩进方框 → 居中补透明边 → 单帧 webp。 */
function render(file, at, out, size) {
  const { width, height } = sizeOf(file)
  const box = boxOf(file, at)
  let crop = ''
  if (box !== null && width > 0 && height > 0) {
    const x = Math.max(0, box.x - PAD)
    const y = Math.max(0, box.y - PAD)
    const w = Math.min(width - x, box.width + PAD * 2)
    const h = Math.min(height - y, box.height + PAD * 2)
    crop = `crop=${w}:${h}:${x}:${y},`
  }
  const filter =
    `${crop}scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba`
  const result = run([
    FFMPEG,
    '-y',
    '-loglevel',
    'error',
    '-c:v',
    'libvpx-vp9',
    '-ss',
    String(at),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    filter,
    '-c:v',
    'libwebp',
    '-quality',
    '88',
    out,
  ])
  if (result.status !== 0) {
    throw new Error(`抽帧失败：${path.basename(file)}\n${result.stderr || ''}`)
  }
}

const thumbDir = path.join(absDir, 'thumbs')
fs.mkdirSync(thumbDir, { recursive: true })

let bytes = 0
for (const name of files) {
  const id = name.slice(0, -'.webm'.length)
  const file = path.join(absDir, name)
  const duration = durationOf(file)
  // 待机取开头（就是封面那一帧的姿态）；其余取动作中段，别停在起手式。
  const at = id === idle ? Math.min(0.2, duration / 4) : Math.min(Math.max(duration * 0.4, 0.5), 4)
  const out = path.join(thumbDir, `${id}.webp`)
  render(file, at, out, THUMB_SIZE)
  bytes += fs.statSync(out).size
  console.log(`  ${id}  ${fs.statSync(out).size} B`)
}

if (idle !== '' && files.includes(`${idle}.webm`)) {
  const src = path.join(absDir, `${idle}.webm`)
  const cover = path.join(absDir, meta.cover && meta.cover.endsWith('.webp') ? meta.cover : 'cover.webp')
  render(src, 0.2, cover, COVER_SIZE)
  console.log(`封面 ${path.basename(cover)}  ${fs.statSync(cover).size} B`)
}

console.log(`\n${files.length} 张缩略图，共 ${(bytes / 1024).toFixed(1)} KB → ${thumbDir}`)
