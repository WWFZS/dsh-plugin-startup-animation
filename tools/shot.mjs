/**
 * shot.mjs —— 无头 Edge 截图（开发期工具）。
 *
 * 用法：node tools/shot.mjs <out.png> <url> [width] [height] [delayMs]
 *
 * 为什么不用现成的 shot-take.mjs：那个是给素材库截图专用的（端口、尺寸、
 * 滚动位置都写死）。这里要通用一点，好让"内置动画长什么样"这种检查
 * 也能直接跑。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [outPng, url, widthArg, heightArg, delayArg, evalExpr] = process.argv.slice(2)
if (!url) {
  console.error('usage: node tools/shot.mjs <out.png|-> <url> [width] [height] [delayMs] [expr]')
  console.error('  out.png 写 "-" 表示只求值不截图')
  process.exit(2)
}
const screenshot = outPng !== undefined && outPng !== '-' && outPng !== ''

const width = Number(widthArg || 1040)
const height = Number(heightArg || 800)
const delay = Number(delayArg || 900)

const edgeCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const edge = edgeCandidates.find((candidate) => fs.existsSync(candidate))
if (edge === undefined) {
  console.error('没有找到 Edge/Chrome')
  process.exit(2)
}

const port = 9340 + Math.floor(Math.random() * 200)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-shot-'))

const browser = spawn(
  edge,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 找到页面 target 的 CDP websocket 地址。 */
async function findPageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
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

const target = await findPageTarget()
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
    }, 15000)
  })
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url })
await sleep(delay)

// 可选：在页面里求值（最后一个位置参数给表达式），把结果打到 stdout。
// 用途：断言"某条 CSS 到底有没有生效"—— getComputedStyle 只有真浏览器能给。
if (evalExpr !== undefined && evalExpr !== '') {
  const result = await send('Runtime.evaluate', {
    expression: evalExpr,
    returnByValue: true,
    awaitPromise: true,
  })
  console.log(JSON.stringify(result.result?.result?.value ?? result.result, null, 2))
}

if (screenshot) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
  console.log(`saved ${outPng}`)
}

socket.close()
browser.kill()
process.exit(0)
