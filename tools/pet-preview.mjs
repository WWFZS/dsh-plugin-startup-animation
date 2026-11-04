#!/usr/bin/env node
/**
 * pet-preview.mjs —— 宠物动作的**验收页**（开发期工具，不随包发布）。
 *
 * 为什么要有它：验收素材时最不该做的就是"抽一帧看图片"——
 *   · ffmpeg 从 VP9-alpha 抽 PNG 会丢 alpha，透明区变纯黑，看着像"黑块"；
 *   · 抽出来的单帧也不告诉你"在 176px 的宠物尺寸下、叠在浅色/深色界面上"是什么样。
 * 这两条都真把人带偏过（把雪堆被吃当成黑块、把绿幕背景看成白底）。
 *
 * 所以这里直接**按插件里的真实尺寸播放素材**：同样的 VP9-alpha 解码路径，
 * 同样的 176px 宽，背景可切浅色 / 深色 / 红底（红底用来查绿边和半透明边）。
 * 看到的就是用户装上去看到的样子，不用抽帧、不用装插件。
 *
 * 用法：
 *   node tools/pet-preview.mjs [port]        # 默认 8793，打开页面后可用 ?pack=女仆 切换
 *
 * 页面里的动作列表直接读 `builtin/宠物/<包>/pet.json`，所以加完动作刷新即可。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = Number(process.argv[2] || 8793)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.wav': 'audio/wav',
}

/** 列出现有宠物包（`builtin/宠物/<目录>/pet.json`）。 */
function listPacks() {
  const base = path.join(root, 'builtin', '宠物')
  if (!fs.existsSync(base)) return []
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(base, entry.name)
      const metaPath = path.join(dir, 'pet.json')
      if (!fs.existsSync(metaPath)) return null
      try {
        const json = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        // 动作清单直接扫目录（pet.json 里只有分类与角色，没有完整 clip 列表）。
        const files = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.webm')).map((n) => n.slice(0, -5))
        // 按分类顺序排，没归类的排在后面 —— 和右键菜单的顺序感一致。
        const ordered = []
        for (const category of json.categories ?? []) {
          for (const id of category.clips ?? []) if (files.includes(id) && !ordered.includes(id)) ordered.push(id)
        }
        for (const id of files) if (!ordered.includes(id)) ordered.push(id)
        return { dir: entry.name, id: json.id ?? entry.name, name: json.name ?? entry.name, meta: json, clips: ordered }
      } catch {
        return null
      }
    })
    .filter((item) => item !== null)
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>宠物动作验收</title>
<style>
  html, body { margin: 0; height: 100%; font: 13px/1.5 system-ui, sans-serif; }
  body { background: #f5f5f5; color: #222; transition: background 120ms; }
  body[data-bg="dark"] { background: #1e1e1e; color: #ddd; }
  body[data-bg="red"] { background: #c81e3a; color: #fff; }
  header { position: sticky; top: 0; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 14px; background: inherit; border-bottom: 1px solid rgba(128,128,128,.3); z-index: 2; }
  header b { font-size: 13px; }
  .seg { display: flex; border: 1px solid rgba(128,128,128,.45); border-radius: 8px; overflow: hidden; }
  .seg button { font: inherit; font-size: 12px; padding: 4px 10px; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .seg button[data-on="1"] { background: rgba(128,128,128,.3); }
  input[type=range] { width: 120px; }
  .grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 16px; align-items: flex-end; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 4px; align-items: center; }
  video { align-self: flex-end; display: block; }
  figcaption { font-size: 11.5px; opacity: .7; }
</style></head>
<body data-bg="light">
<header>
  <b>宠物动作验收</b>
  <div class="seg" id="bg">
    <button data-v="light" data-on="1">浅色界面</button><button data-v="dark">深色</button><button data-v="red">红底</button>
  </div>
  <label>尺寸 <input id="size" type="range" min="100" max="320" step="4" value="176"><span id="sizeText">176px</span></label>
  <span id="hint" style="opacity:.6"></span>
</header>
<div class="grid" id="grid"></div>
<script>
const params = new URLSearchParams(location.search)
const pack = params.get('pack') || ''
let meta = null
let size = 176

const grid = document.getElementById('grid')
const hint = document.getElementById('hint')

function render() {
  grid.innerHTML = ''
  const files = meta.clips
  for (const name of files) {
    const fig = document.createElement('figure')
    const v = document.createElement('video')
    v.src = '/builtin/宠物/' + encodeURIComponent(meta.dir) + '/' + encodeURIComponent(name) + '.webm'
    v.autoplay = v.muted = v.loop = v.playsInline = true
    v.style.width = size + 'px'
    v.style.height = Math.round(size * meta.canvas[1] / meta.canvas[0]) + 'px'
    // 浅色/深色背景由 body 提供，video 本身透明 —— 看到的就是叠在界面上的样子
    const cap = document.createElement('figcaption')
    cap.textContent = name
    fig.append(v, cap)
    grid.appendChild(fig)
  }
  hint.textContent = meta.name + ' · ' + files.length + ' 段 · ' + meta.canvas.join('×')
}

document.getElementById('size').addEventListener('input', (e) => {
  size = Number(e.target.value)
  document.getElementById('sizeText').textContent = size + 'px'
  for (const v of grid.querySelectorAll('video')) {
    v.style.width = size + 'px'
    v.style.height = Math.round(size * meta.canvas[1] / meta.canvas[0]) + 'px'
  }
})
document.getElementById('bg').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  for (const b of document.querySelectorAll('#bg button')) b.dataset.on = '0'
  btn.dataset.on = '1'
  document.body.dataset.bg = btn.dataset.v
})

if (pack) {
  fetch('/pets').then((r) => r.json()).then((list) => {
    const found = list.find((p) => p.id === pack || p.dir === pack) || list[0]
    if (found) { meta = found; render() }
  })
} else {
  fetch('/pets').then((r) => r.json()).then((list) => {
    if (list.length > 0) { meta = list[0]; render() }
  })
}
</script></body></html>`

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/pets') {
      const packs = listPacks().map(({ dir, id, name, meta, clips }) => ({ dir, id, name, canvas: meta.canvas, clips }))
      res.writeHead(200, { 'Content-Type': types['.json'] })
      res.end(JSON.stringify(packs))
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': types['.html'] })
      res.end(PAGE)
      return
    }
    const rel = decodeURIComponent(url.pathname)
    const abs = path.resolve(root, `.${rel}`)
    if (!abs.startsWith(path.resolve(root)) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' })
    fs.createReadStream(abs).pipe(res)
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`宠物动作验收 → http://127.0.0.1:${port}/`)
    console.log('  切换包：?pack=女仆    背景：右上角浅色/深色/红底    尺寸：滑杆（默认 176px，和插件一致）')
  })
