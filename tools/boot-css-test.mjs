/**
 * boot-css-test.mjs —— 用**真浏览器**校验 boot.css 里那条跨组件的规则。
 *
 * 为什么必须用浏览器：这条规则是
 *   html:has(.dsa-root:not([data-media="gone"])) [data-dsh-boot]
 * —— 选的是"宿主的原生启动卡"，靠 :has() 跨子树匹配。Node 里的 DOM 垫片没有
 * 样式引擎，测不了"选择器到底匹配不匹配"，只有 getComputedStyle 能给答案。
 *
 * 这条规则是"失败回落"原则的最后一环：动画挂上了（含素材还在加载）→ 藏掉原生
 * 启动卡（不叠显两个 logo）；动画挂了或让开了 → 选择器不再匹配 → 原生启动页
 * 自动回来。一旦这条规则写错，后果是"开机看到两个 logo"或"原生启动页永远不回来"。
 *
 * 用法：node tools/boot-css-test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

// ─────────────────────────── 静态服务器 ───────────────────────────

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const file = path.join(repoRoot, decodeURIComponent(url.pathname))
  if (!file.startsWith(repoRoot)) {
    res.writeHead(403)
    res.end()
    return
  }
  fs.readFile(file, (error, buffer) => {
    if (error) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] ?? 'text/plain' })
    res.end(buffer)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// ─────────────────────────── 无头浏览器 ───────────────────────────

const edgeCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browserPath = edgeCandidates.find((candidate) => fs.existsSync(candidate))
if (browserPath === undefined) {
  console.error('没有找到 Edge/Chrome —— 这条测试需要真浏览器')
  await new Promise((resolve) => server.close(resolve))
  process.exit(2)
}

const debugPort = 9400 + Math.floor(Math.random() * 200)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-css-'))
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
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 在一个页面里求值，返回值。
 * @param {string} url 页面地址。
 * @param {string} expression 求值表达式。
 * @returns {Promise<any>} 求值结果。
 */
async function evaluate(url, expression) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let targets
    try {
      targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    } catch {
      targets = []
    }
    const page = targets.find((target) => target.type === 'page')
    if (page === undefined) {
      await sleep(250)
      continue
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl)
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
    try {
      await send('Page.enable')
      await send('Page.navigate', { url })
      await sleep(700)
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      socket.close()
      return result.result?.result?.value
    } catch (error) {
      socket.close()
      throw error
    }
  }
  throw new Error('CDP 没有就绪')
}

const DISPLAY = "getComputedStyle(document.querySelector('[data-dsh-boot]')).display"
const OVERLAY_OPACITY = "getComputedStyle(document.querySelector('.dsa-root') ?? document.body).opacity"
const COVER = "getComputedStyle(document.documentElement, '::before').content"
const SCENE_DISPLAY = "getComputedStyle(document.querySelector('.dsa-scene')).display"
const HUD_OPACITY = "getComputedStyle(document.querySelector('.dsa-hud')).opacity"
const page = (state) => `http://127.0.0.1:${port}/compile-cache/boot-card.html?state=${state}`

console.log('== 动画挂上就藏掉宿主原生启动卡 ==')

await check('素材已出画（ok）→ 原生启动卡隐藏', async () => {
  assert.equal(await evaluate(page('ok'), DISPLAY), 'none')
})

await check('内置动画（css）→ 原生启动卡隐藏', async () => {
  // 内置动画从挂载起就不透明，同样不该和原生 logo 叠显。
  assert.equal(await evaluate(page('css'), DISPLAY), 'none')
})

await check('素材未出画（loading）→ 原生启动卡同样隐藏', async () => {
  // 这条以前是反的：loading 期覆盖层透明 → 藏了就是空白 → 只好让原生卡露出来，
  // 结果素材解码那几百毫秒里就"闪一下原生动画"。现在 loading 期覆盖层不透明，
  // 原生卡必须一直藏着。
  assert.equal(await evaluate(page('loading'), DISPLAY), 'none')
})

console.log('== 素材模式不许出现内置徽标场景 ==')

await check('素材未出画（loading）→ 徽标场景不显示、HUD 未淡入', async () => {
  // 用户要求的是"黑一下就出自己的画面"，不是先闪一张 DeepSeek Harness 标题页。
  assert.equal(await evaluate(page('loading'), SCENE_DISPLAY), 'none')
  assert.equal(await evaluate(page('loading'), HUD_OPACITY), '0')
})

await check('素材已出画（ok）→ 徽标场景也不显示（那是 css 模式的东西）', async () => {
  assert.equal(await evaluate(page('ok'), SCENE_DISPLAY), 'none')
})

await check('内置动画（css）→ 徽标场景照常显示', async () => {
  assert.notEqual(await evaluate(page('css'), SCENE_DISPLAY), 'none')
})

console.log('== 覆盖层不透明度 ==')

await check('素材未出画（loading）→ 覆盖层不透明', async () => {
  assert.equal(await evaluate(page('loading'), OVERLAY_OPACITY), '1')
})

await check('素材挂掉（gone）→ 覆盖层透明', async () => {
  assert.equal(await evaluate(page('gone'), OVERLAY_OPACITY), '0')
})

console.log('== 首帧遮罩（覆盖层还没来得及挂上）==')

await check('遮罩期：原生启动卡隐藏 + 铺满屏的伪元素在位', async () => {
  assert.equal(await evaluate(page('cover'), DISPLAY), 'none')
  assert.notEqual(await evaluate(page('cover'), COVER), 'none')
})

await check('覆盖层挂上后：遮罩让位（:has 命中即失效）', async () => {
  // 标记还没撤也不能再画 —— 否则会在真覆盖层上再盖一层纯色。
  assert.equal(await evaluate(page('cover-mounted'), COVER), 'none')
  assert.equal(await evaluate(page('cover-mounted'), DISPLAY), 'none')
})

console.log('== 失败回落：动画不可见 → 原生启动页照常 ==')

await check('素材挂掉（gone）→ 原生启动卡恢复显示', async () => {
  assert.notEqual(await evaluate(page('gone'), DISPLAY), 'none')
})

await check('覆盖层已移除（none）→ 原生启动卡恢复显示', async () => {
  assert.notEqual(await evaluate(page('none'), DISPLAY), 'none')
})

browser.kill()
await new Promise((resolve) => server.close(resolve))

console.log('')
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('BOOT CSS TEST PASS')
