/**
 * make-posters.mjs —— 为内置视频预生成卡片封面（开发期工具，不进发布包）。
 *
 * 用法：node tools/make-posters.mjs [--force]
 *
 * 为什么需要：没有手工封面时，客户端要先把视频拉进 <video>、等元数据、再在
 * canvas 里自动挑帧，卡片才有画面 —— 列表打开的那一秒就是白的。
 * 内置素材是固定的，抠一帧存成 `builtin/MP4/.posters/<素材名>.jpg` 即可
 * （服务端 `?poster=1` 会优先发它，见 index.js 的 posterFor）。
 *
 * 挑帧规则与客户端 `pickCoverTime` 一致：取 25% / 50% / 75% 三帧，选平均亮度
 * 最高的一帧 —— "最亮"通常就是主体最清楚的那帧。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const posterDir = path.join(root, 'builtin', 'MP4', '.posters')
const videoDir = path.join(root, 'builtin', 'MP4')
const force = process.argv.includes('--force')

/** `.web.mp4` 是分发变体，封面要按逻辑名（去掉 .web）存。 */
function logicalStem(filename) {
  const base = filename.replace(/\.web\.mp4$/i, '').replace(/\.mp4$/i, '')
  return base
}

// 同一段素材可能同时有母版 `.mp4` 与分发变体 `.web.mp4`，只按逻辑名处理一次，
// 并优先用变体（更小，解码更快）。
const byStem = new Map()
for (const name of fs
  .readdirSync(videoDir)
  .filter((entry) => /\.mp4$/i.test(entry) && fs.statSync(path.join(videoDir, entry)).isFile())
  .sort()) {
  const stem = logicalStem(name)
  const previous = byStem.get(stem)
  if (previous === undefined || /\.web\.mp4$/i.test(name)) byStem.set(stem, name)
}
const videos = [...byStem.entries()].map(([stem, name]) => ({ stem, name }))

if (videos.length === 0) {
  console.error('builtin/MP4 下没有视频')
  process.exit(2)
}

// ── 静态服务（带 Range：<video> 定位必须靠它） ──────────────────────────────
const types = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png' }

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"></body>')
    return
  }
  const file = path.join(root, decodeURIComponent(url.pathname))
  if (!file.startsWith(root)) {
    res.writeHead(403)
    res.end()
    return
  }
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (!stat.isFile()) {
    res.writeHead(404)
    res.end()
    return
  }
  const type = types[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range !== null) {
    const start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1])
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    })
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size })
  fs.createReadStream(file).pipe(res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

// ── 无头浏览器（复用 tools/shot.mjs 的 CDP 连法） ───────────────────────────
const candidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browserPath = candidates.find((candidate) => fs.existsSync(candidate))
if (browserPath === undefined) {
  console.error('没有找到 Edge/Chrome')
  server.close()
  process.exit(2)
}

const debugPort = 9400 + Math.floor(Math.random() * 200)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-poster-'))
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findPage() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page !== undefined) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('CDP 没有就绪')
}

const target = await findPage()
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('timeout ' + method))
      }
    }, 30000)
  })
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
await sleep(400)

/** 在页面里：三帧取样选最亮的一帧，画到 480px 宽的 canvas，回 dataURL。 */
const capture = (videoUrl) => `
(async () => {
  const video = document.createElement('video')
  video.src = ${JSON.stringify(videoUrl)}
  video.muted = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  document.body.appendChild(video)
  const once = (target, name) => new Promise((ok, no) => {
    target.addEventListener(name, ok, { once: true })
    target.addEventListener('error', () => no(new Error('media error')), { once: true })
  })
  if (video.readyState < 1) await once(video, 'loadedmetadata')
  if (!video.videoWidth || !video.videoHeight) throw new Error('no intrinsic size')

  const seek = async (time) => {
    video.currentTime = time
    await once(video, 'seeked')
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
  }

  const luma = (width, height) => {
    const probe = document.createElement('canvas')
    probe.width = width
    probe.height = height
    const context = probe.getContext('2d')
    context.drawImage(video, 0, 0, width, height)
    const data = context.getImageData(0, 0, width, height).data
    let total = 0
    for (let index = 0; index < data.length; index += 4) {
      total += 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]
    }
    return total / (data.length / 4)
  }

  let best = { score: -1, time: video.duration * 0.25 }
  for (const ratio of [0.25, 0.5, 0.75]) {
    await seek(Math.min(video.duration * ratio, Math.max(video.duration - 0.05, 0)))
    const score = luma(32, 18)
    if (score > best.score) best = { score, time: video.currentTime }
  }
  await seek(best.time)

  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = Math.round((480 * video.videoHeight) / video.videoWidth)
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
  video.remove()
  return canvas.toDataURL('image/jpeg', 0.86)
})()
`

fs.mkdirSync(posterDir, { recursive: true })

let written = 0
for (const { stem, name } of videos) {
  const out = path.join(posterDir, `${stem}.jpg`)
  if (!force && fs.existsSync(out)) {
    console.log(`skip  ${stem}（已有封面，--force 可覆盖）`)
    continue
  }
  const result = await send('Runtime.evaluate', {
    expression: capture(`http://127.0.0.1:${port}/builtin/MP4/${encodeURIComponent(name)}`),
    returnByValue: true,
    awaitPromise: true,
  })
  const value = result.result?.result?.value
  if (typeof value !== 'string' || !value.startsWith('data:image/jpeg;base64,')) {
    console.error(`FAIL  ${name}: ${result.result?.exceptionDetails?.text ?? 'no dataUrl'}`)
    continue
  }
  fs.writeFileSync(out, Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64'))
  console.log(`write ${stem}.jpg  ${fs.statSync(out).size} B`)
  written += 1
}

socket.close()
browser.kill()
server.close()
console.log(`done: ${written} poster(s) → builtin/MP4/.posters/`)
