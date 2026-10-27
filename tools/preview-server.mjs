/**
 * preview-server.mjs —— 开发期静态服务器：给仓库根目录提供文件。
 *
 * 用途：内置动画、设置页这类"要眼睛看"的东西，需要一个能直接打开的 URL
 * （截图工具、浏览器验证都靠它）。插件运行期不需要这个 —— 它只是开发工具。
 *
 * 用法：node tools/preview-server.mjs [port]
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = Number(process.argv[2] || 8791)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const file = path.join(root, decodeURIComponent(url.pathname))
    if (!file.startsWith(root)) {
      res.writeHead(403)
      res.end()
      return
    }
    fs.readFile(file, (error, buffer) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404 ' + url.pathname)
        return
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
      res.end(buffer)
    })
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`preview: http://127.0.0.1:${port}/compile-cache/boot-scene.html`)
  })
