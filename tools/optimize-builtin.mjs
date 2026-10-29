/**
 * optimize-builtin.mjs —— 把内置 MP4 转成"开机动画真的能秒开"的版本（构建期）。
 *
 * 为什么要做：内置素材原先是 4K60、码率 8–32 Mbps，单个 13–25 MB。开机动画的素材
 * 请求发生在页面启动脚本阶段，这直接变成"启动要等视频下载"。而且
 * `光影-动漫美女-彩色.mp4` 的 moov 在文件尾 —— 浏览器要读到最后才拿到时长和索引，
 * 最坏情况就是黑屏/一帧都出不来（boot.js 的 noFrame 看门狗会放弃该素材）。
 *
 * 做法（不改原始文件，另存 `*.web.mp4`）：
 *   - 分辨率长边封顶 1920（开机动画是全屏封面，卡片还更小）；
 *   - H.264 High profile + yuv420p（Chromium 一定解）；
 *   - `-movflags +faststart`：moov 前置，可流式播放；
 *   - CRF 23：肉眼几乎无差的体积削减；
 *   - 去掉音轨（开机画面不走视频声；"开机音频"是独立素材），省一大截。
 *
 * 素材选择时优先 `*.web.mp4`（见 index.js 的 WEB_VARIANT_SUFFIX），原始 4K 仍然
 * 留在仓库里作为源素材，但不参与分发。
 *
 * 用法：node tools/optimize-builtin.mjs [--force]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const mp4Dir = path.join(packageRoot, 'builtin', 'MP4')
const SUFFIX = '.web.mp4'
const MAX_LONG_EDGE = 1920
/** 内置素材默认只做 8 秒：展示时长可调 3–30 秒，更长是靠循环铺满的，压那么长纯属白占体积。 */
const MAX_SECONDS = 8

/**
 * 个别素材越过默认上限。
 *
 * 1.12.4 起展示时长能设到 30 秒，"长素材"不再只是浪费 —— 有的素材本身就是一条完整叙事
 * （《550C》16 秒、《剑一》14 秒），截到 8 秒会把结尾的落版切掉。按素材名单独放宽，
 * 不动全局上限，免得哪天有人塞个 4K 母版进来把包撑爆。
 */
const SECONDS_OVERRIDE = new Map([
  ['550C-赛博控制台', 16],
  ['剑一', 14],
])
const force = process.argv.includes('--force')

/**
 * 哪些内置视频要**保留音轨**。
 *
 * 默认去音轨：开机动画是装饰画面，"视频声音"本来就不是它的职责，去掉能省一大截体积。
 * 但有的素材本身就是在说话（带对白/旁白的那种），去掉音轨等于把内容删了 ——
 * 这类必须保留。按文件名列在这里，重跑构建时不会被无声抹掉。
 */
const KEEP_AUDIO = new Set(['dsh-大肥鱼', '剑一'])

/** 用 ffmpeg 压一版网页友好的 faststart mp4（按素材决定是否保留音轨）。 */
function transcode(source, target) {
  const stem = path.parse(source).name
  const keepAudio = KEEP_AUDIO.has(stem)
  const limit = SECONDS_OVERRIDE.get(stem) ?? MAX_SECONDS
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', source,
      ...(keepAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
      '-t', String(limit),
      '-vf', `scale='if(gt(iw,ih),min(${MAX_LONG_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_LONG_EDGE},ih))'`,
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-preset', 'medium',
      '-movflags', '+faststart',
      target,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
}

/** 读 moov 的位置，确认 faststart 生效。 */
function moovAtHead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(64)
    fs.readSync(fd, head, 0, 64, 0)
    let pos = 0
    while (pos + 8 <= 64) {
      const size = head.readUInt32BE(pos)
      const type = head.toString('latin1', pos + 4, pos + 8)
      if (type === 'moov') return true
      if (size < 8) break
      pos += size
    }
    return false
  } finally {
    fs.closeSync(fd)
  }
}

const sources = fs
  .readdirSync(mp4Dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.mp4$/i.test(entry.name) && !entry.name.endsWith(SUFFIX))

let saved = 0
for (const entry of sources) {
  const source = path.join(mp4Dir, entry.name)
  const target = path.join(mp4Dir, entry.name.replace(/\.mp4$/i, SUFFIX))
  const before = fs.statSync(source).size
  if (!force && fs.existsSync(target)) {
    console.log(`  跳过（已存在）  ${path.basename(target)}`)
  } else {
    transcode(source, target)
  }
  const after = fs.statSync(target).size
  saved += before - after
  const faststart = moovAtHead(target)
  console.log(
    `  ${path.basename(entry.name)}: ${(before / 1048576).toFixed(1)} MB → ` +
      `${(after / 1048576).toFixed(1)} MB  (moov 前置=${faststart ? '是' : '否'})`,
  )
  if (!faststart) {
    console.error(`  ! ${path.basename(target)} 不是 faststart，浏览器无法流式播放`)
    process.exitCode = 1
  }
}

console.log(`\n共节省 ${(saved / 1048576).toFixed(1)} MB`)
