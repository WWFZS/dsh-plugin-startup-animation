/**
 * pet-harness.mjs —— 宠物浮层的开发期测试台（只给开发/自测用，不随包发布）。
 *
 * 为什么需要它：宠物是挂在 `document.body` 上的全局浮层，和设置页的渲染树无关 ——
 * 在真实 DSH 里验证要装插件、重启宿主、再翻到设置页，一轮几十秒；调整动画/拖拽手感
 * 时这个成本太高。这里用 90 行把它剥出来：起一个只会三件事的服务
 * （托管 client.js / 假的 manage 接口 / 转发 builtin 素材），页面加载即挂载宠物。
 *
 * 它**不模拟** React 设置页：`require('react')` 给一个空壳，slots 注册被丢弃，
 * 这样跑起来的就是纯粹的浮层代码路径，不会把设置页的渲染混进验证结果里。
 *
 * 用法：
 *   node tools/pet-harness.mjs [port]           # 默认 8792
 *   浏览器打开 http://127.0.0.1:PORT/           # 宠物出现在右下角
 *   POST 请求会打印在终端（拖拽落位时能看到 petX/petY）
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PET_ROLES, listPetClips } from '../index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = Number(process.argv[2] || 8792)

/**
 * 动作清单**直接问宿主**（同一个 listPetClips），不在这里抄一份。
 * 抄一份的下场是：目录加了动作，测试台还显示旧的三个，白白怀疑代码。
 */
const clips = listPetClips(root)
const roleId = (want) => (clips.some((clip) => clip.id === want) ? want : '')

/** 假的管理状态：只保留浮层关心的字段。 */
const state = {
  pet: {
    enabled: true,
    size: 176,
    x: 100,
    y: 100,
    idle: roleId(PET_ROLES.idle) || (clips[0] === undefined ? '' : clips[0].id),
    click: roleId(PET_ROLES.click),
    drag: roleId(PET_ROLES.drag),
    clips,
  },
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>pet harness</title>
<style>
  html, body { margin: 0; height: 100%; font: 14px/1.5 system-ui, sans-serif; }
  body { background: #101018; color: #ddd; }
  /* 假装是 DSH 的界面：深色底 + 一块"侧栏"，方便看宠物叠在上面的效果。 */
  .fake-app { position: fixed; inset: 0; display: grid; grid-template-columns: 220px 1fr;
    background: radial-gradient(1200px 600px at 70% 20%, #1b2233, #0b0e15 70%); }
  .fake-side { background: #12151d; border-right: 1px solid #232838; padding: 18px; color: #7d8598; }
  .fake-main { padding: 24px; color: #8b93a7; }
</style></head>
<body>
<div class="fake-app">
  <div class="fake-side">侧栏占位</div>
  <div class="fake-main">正文占位 —— 宠物应该浮在右下角</div>
</div>
<script>
  // 最小的模块加载器：client.js 顶层调 load()，把 factory 攥在手里，等 DOM 就绪再执行。
  window.__ModuleLoader__ = { load(mod) { window.__dsa = mod } }
</script>
<script src="/client.js"></script>
<script>
  const off = () => {}
  const React = { createElement: () => null }
  const mod = window.__dsa.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  // 直接把浮层那半挂起来；slots 注册被丢弃（设置页不在这个页面里）。
  mod.apply({
    effect: (fn) => { fn() },
    locale: { register: () => off, bind: () => (key) => key },
    slots: { inject: (name, cb) => { cb(); return off }, register: () => off },
    // 与 apply 里的真实 onPersist 同形：POST 回包广播成 sync —— 右键"隐藏"后浮层要能自己收起来。
  })
</script>
</body></html>`

const types = {
  '.js': 'text/javascript; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8',
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'Content-Type': types['.js'] })
      res.end(fs.readFileSync(path.join(root, 'client.js')))
      return
    }
    if (url.pathname === '/dsh-startup-animation/manage') {
      if (req.method === 'POST') {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          let body = {}
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            /* 空体/坏体就当没写 */
          }
          // 配置键（petX / petEnabled…）→ 回包字段（x / enabled…），和宿主的 manage
          // 状态形状对齐：这样刷新页面还能读回上次拖到的位置，验持久化才有意义。
          const FIELDS = { petEnabled: 'enabled', petSize: 'size', petX: 'x', petY: 'y' }
          for (const [key, field] of Object.entries(FIELDS)) {
            if (body[key] !== undefined) state.pet[field] = body[key]
          }
          console.log('[manage POST]', JSON.stringify(body), '→', `x=${state.pet.x} y=${state.pet.y}`)
          res.writeHead(200, { 'Content-Type': types['.json'] })
          res.end(JSON.stringify({ ok: true, ...state }))
        })
        return
      }
      res.writeHead(200, { 'Content-Type': types['.json'] })
      res.end(JSON.stringify({ ok: true, ...state }))
      return
    }
    if (url.pathname === '/dsh-startup-animation/asset') {
      // 和宿主的素材路由同形：`?path=builtin/宠物/待机.webm` → 包内文件。
      const rel = url.searchParams.get('path') ?? ''
      const abs = path.resolve(root, rel)
      if (!abs.startsWith(path.resolve(root))) {
        res.writeHead(403)
        res.end('outside package')
        return
      }
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const type = types[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size })
      fs.createReadStream(abs).pipe(res)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`pet harness → http://127.0.0.1:${port}/`)
  })
