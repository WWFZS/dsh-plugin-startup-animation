/**
 * host-smoke.mjs —— 用假 ctx 驱动真实的路由处理器，端到端跑一遍
 * 上传 / 选用 / 移除 / 恢复默认 / 素材服务。仅开发期使用，不随包分发。
 *
 * 用法：node tools/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-host-smoke-'))
process.env.DSH_HOME = path.join(tmp, 'home')

const { apply, MANAGE_ROUTE, ASSET_ROUTE, UPDATE_ROUTE, VERSION } = await import(
  new URL('../index.js', import.meta.url)
)

/** 收集 apply 注册的路由。 */
const routes = new Map()
const warnings = []
let injectHandler = null

const ctx = {
  logger: {
    warn: (msg) => warnings.push(String(msg)),
    info: () => {},
  },
  on: (event, cb) => {
    if (event === 'webserver/index-inject') cb(injectTable)
    return () => {}
  },
  inject: (deps, cb) => {
    assert.deepEqual(deps, ['webServer'])
    injectHandler = cb
    return () => {}
  },
}

const injectTable = []

const child = {
  effect: (fn) => {
    const dispose = fn()
    return dispose
  },
  webServer: {
    register: (route) => {
      assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

apply(ctx)
assert.ok(injectHandler, 'apply 没有注册 webServer 注入')
injectHandler(child)
assert.ok(routes.has(MANAGE_ROUTE), '缺少管理路由')
assert.ok(routes.has(ASSET_ROUTE), '缺少素材路由')
assert.ok(routes.has(UPDATE_ROUTE), '缺少更新检查路由')

// ── 注入行结构 ──
assert.equal(injectTable.length, 3, `注入行数量 ${injectTable.length}`)
assert.equal(injectTable[0].kind, 'global')
assert.equal(injectTable[0].name, '__DSA_BOOT__')
assert.equal(injectTable[1].kind, 'style')
assert.equal(injectTable[2].kind, 'script')
assert.equal(injectTable[2].placement, 'body')
console.log('  ok   注入行：global + style + script(body)')

// ── 起真服务器 ──
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const handler = routes.get(url.pathname)
  if (!handler) {
    res.writeHead(404)
    res.end()
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const call = (pathname, init = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, init, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }),
      )
    })
    req.on('error', reject)
    if (init.body !== undefined && typeof init.body !== 'string' && !Buffer.isBuffer(init.body)) {
      req.write(init.body)
    } else if (init.body !== undefined) req.write(init.body)
    req.end()
  })

const postJson = (body) =>
  call(MANAGE_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// ── 1. 初始状态 ──
const s0 = (await call(MANAGE_ROUTE)).json()
assert.equal(s0.ok, true)
assert.equal(s0.mode, 'css')
assert.equal(s0.enabled, true)
console.log('  ok   GET 初始状态')

// ── 2. 上传视频 ──
const mp4 = Buffer.alloc(200000, 7)
const up = await call(MANAGE_ROUTE, {
  method: 'POST',
  headers: { 'Content-Type': 'video/mp4', 'X-Dsh-Filename': encodeURIComponent('我的 开场.mp4') },
  body: mp4,
})
assert.equal(up.status, 200, `上传失败 ${up.status} ${up.body.toString()}`)
const upState = up.json()
const uploaded = upState.library
  .find((c) => c.id === 'MP4')
  .files.find((f) => f.uploaded === true)
assert.ok(uploaded, '上传后素材库没有该条目')
assert.equal(uploaded.name, '我的 开场.mp4')
console.log('  ok   上传视频 → 入库（原始文件名）')

// ── 3. 选用上传素材 ──
const use = await postJson({ use: uploaded.path })
assert.equal(use.status, 200)
assert.equal(use.json().mode, 'video')
assert.equal(use.json().file, uploaded.path)
console.log('  ok   选用上传素材 → mode=video')

// ── 4. 素材路由能取到字节 ──
const asset = await call(ASSET_ROUTE)
assert.equal(asset.status, 200, `素材路由 ${asset.status}`)
assert.equal(asset.body.length, mp4.length)
assert.equal(asset.headers['content-type'], 'video/mp4')
console.log('  ok   素材路由返回视频字节')

// ── 5. Range 请求（播放器 seek）──
const range = await call(ASSET_ROUTE, { headers: { Range: 'bytes=100-199' } })
assert.equal(range.status, 206)
assert.equal(range.body.length, 100)
console.log('  ok   Range 206')

// ── 6. 删除上传素材：真删 + 配置回落 ──
const del = await postJson({ forget: uploaded.path })
assert.equal(del.status, 200)
const delState = del.json()
assert.equal(delState.hiddenOnly, undefined, '不应走仅隐藏')
assert.equal(fs.existsSync(uploaded.path), false, '磁盘文件没删掉')
assert.equal(delState.mode, 'css', '删除使用中的素材后未回落')
assert.equal(delState.file, '')
console.log('  ok   删除上传素材：真删 + 回落')

// ── 7. 内置素材选用 + 预览 ──
const builtinMp4 = 'builtin/MP4/傍晚海风-海边.mp4'
const useB = await postJson({ use: builtinMp4 })
assert.equal(useB.status, 200, useB.body.toString())
const libState = useB.json()
const assetB = await call(`${ASSET_ROUTE}?path=${encodeURIComponent(builtinMp4)}`)
assert.equal(assetB.status, 200)
// 实际分发的是 1080p faststart 变体（*.web.mp4），不是 4K 原片。
const builtinMp4OnDisk = path.join(packageRoot, builtinMp4.replace(/\.mp4$/, '.web.mp4'))
const expectedBytes = fs.existsSync(builtinMp4OnDisk)
  ? fs.statSync(builtinMp4OnDisk).size
  : fs.statSync(path.join(packageRoot, builtinMp4)).size
assert.equal(Number(assetB.headers['content-length']), expectedBytes)
assert.ok(expectedBytes < fs.statSync(path.join(packageRoot, builtinMp4)).size, '内置视频没有走压缩变体')
console.log('  ok   内置素材选用 + 预览取流（走 .web.mp4 变体）')

// ── 7b. 缩略图：内置图片走预生成的 480px JPEG，且明显小于原图 ──
const builtinImg = 'builtin/图片/创意拼贴-彼得帕克.jpg'
const fullImg = await call(`${ASSET_ROUTE}?path=${encodeURIComponent(builtinImg)}`)
const smallImg = await call(`${ASSET_ROUTE}?path=${encodeURIComponent(builtinImg)}&thumb=1`)
assert.equal(smallImg.status, 200)
assert.equal(smallImg.headers['content-type'], 'image/jpeg')
assert.ok(smallImg.body.length < fullImg.body.length / 4, `缩略图没变小：${smallImg.body.length} vs ${fullImg.body.length}`)
// 上传图片没有预生成缩略图 → 回落原图（不能因此 404）。
const wall = Buffer.alloc(90000, 2)
const upWall = await call(MANAGE_ROUTE, {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg', 'X-Dsh-Filename': encodeURIComponent('我的壁纸.jpg') },
  body: wall,
})
assert.equal(upWall.status, 200, upWall.body.toString())
const upWallPath = upWall.json().library.find((c) => c.id === '图片').files.find((f) => f.uploaded === true).path
const upWallThumb = await call(`${ASSET_ROUTE}?path=${encodeURIComponent(upWallPath)}&thumb=1`)
assert.equal(upWallThumb.status, 200, `上传图片缩略图回落失败 ${upWallThumb.status}`)
assert.equal(upWallThumb.body.length, wall.length)
// 视频请求 thumb=1 不会出错（视频只做首帧，不缩略）。
const videoThumb = await call(`${ASSET_ROUTE}?path=${encodeURIComponent(builtinMp4)}&thumb=1`)
assert.equal(videoThumb.status, 200)
console.log('  ok   缩略图：内置图片变小 / 上传回落原图 / 视频不受影响')

// ── 8. 移除内置素材（tombstone，包内文件保留）──
const forgetB = await postJson({ forget: builtinMp4 })
assert.equal(forgetB.status, 200)
assert.equal(forgetB.json().deleted.includes(builtinMp4), true)
assert.equal(forgetB.json().file, '', '移除使用中的内置素材后未回落')
assert.equal(fs.existsSync(path.join(packageRoot, builtinMp4)), true, '内置素材文件不应被删除')
const again = await call(`${ASSET_ROUTE}?path=${encodeURIComponent(builtinMp4)}`)
assert.equal(again.status, 404, '已移除的内置素材仍可访问')
console.log('  ok   内置素材 tombstone + 拒绝再取流')

// ── 9. 时长 / 开关 ──
const dur = await postJson({ durationSec: 99 })
assert.equal(dur.status, 200)
assert.equal(dur.json().durationSec, 15)
const bad = await postJson({ durationSec: 'x' })
assert.equal(bad.status, 400)
const off = await postJson({ enabled: false })
assert.equal(off.json().enabled, false)
assert.equal(off.json().cfg.enabled, false)
console.log('  ok   时长夹取 / 非法值 400 / 开关')

// ── 10. 音频域 ──
const audioFile = Buffer.alloc(5000, 3)
const upAudio = await call(MANAGE_ROUTE, {
  method: 'POST',
  headers: { 'Content-Type': 'audio/mpeg', 'X-Dsh-Filename': encodeURIComponent('提示音.mp3') },
  body: audioFile,
})
assert.equal(upAudio.status, 200, upAudio.body.toString())
const audioEntry = upAudio.json().library.find((c) => c.id === '音频').files.find((f) => f.uploaded)
assert.ok(audioEntry, '音频上传未入 音频 分类')
// 界面上的顺序：先选素材，再开开关（两步各自一个请求）。
const useA1 = await postJson({ useAudio: audioEntry.path })
assert.equal(useA1.status, 200, useA1.body.toString())
assert.equal(useA1.json().audioFile, audioEntry.path)
const useA = await postJson({ audioEnabled: true, audioVolume: 0.4 })
assert.equal(useA.status, 200, useA.body.toString())
assert.equal(useA.json().audioEnabled, true)
assert.ok(useA.json().cfg.audioSrc.includes('?path='), 'cfg.audioSrc 未带上 path')
assert.equal(useA.json().cfg.audioVolume, 0.4)
// 音频槽拒收视频
const useWrong = await postJson({ useAudio: 'builtin/MP4/多重影像.mp4' })
assert.equal(useWrong.status, 400)
// 视频槽拒收音频
const useWrong2 = await postJson({ use: audioEntry.path })
assert.equal(useWrong2.status, 400)
const audioBytes = await call(useA.json().cfg.audioSrc)
assert.equal(audioBytes.status, 200)
assert.equal(audioBytes.headers['content-type'], 'audio/mpeg')
console.log('  ok   音频：上传/选用/取流/跨槽拒绝')

// ── 11. 非法上传与越权路径 ──
const exe = await call(MANAGE_ROUTE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Dsh-Filename': encodeURIComponent('bad.exe') },
  body: Buffer.alloc(64, 1),
})
assert.equal(exe.status, 415)
const traversal = await call(`${ASSET_ROUTE}?path=${encodeURIComponent('builtin/../../index.js')}`)
assert.equal(traversal.status, 404)
const outside = await call(`${ASSET_ROUTE}?path=${encodeURIComponent(path.join(tmp, 'x.mp4'))}`)
assert.equal(outside.status, 404)
console.log('  ok   非法类型 415 / 路径穿越与目录外引用被拒')

// ── 12. 空文件与超限 ──
const empty = await call(MANAGE_ROUTE, {
  method: 'POST',
  headers: { 'Content-Type': 'video/mp4', 'X-Dsh-Filename': encodeURIComponent('empty.mp4') },
  body: Buffer.alloc(0),
})
assert.equal(empty.status, 400)
console.log('  ok   空文件 400')

// ── 13. 方法矩阵 ──
const put = await call(MANAGE_ROUTE, { method: 'PUT' })
assert.equal(put.status, 405)
console.log('  ok   PUT → 405')

// ── 14. 精简配置回包（开机动画专用）──
const cfgOnly = await call(`${MANAGE_ROUTE}?cfg=1`)
assert.equal(cfgOnly.status, 200)
const cfgPayload = cfgOnly.json()
assert.equal(cfgPayload.ok, true)
assert.ok(cfgPayload.cfg, '?cfg=1 未返回 cfg')
assert.equal(cfgPayload.library, undefined, '?cfg=1 不该带素材库（那会白扫一遍磁盘）')
assert.equal(typeof cfgPayload.cfg.mode, 'string')
console.log('  ok   GET ?cfg=1 只回配置、不扫素材库')

// ── 15. 配置写入是原子的：不会留下半截 JSON ──
{
  const settings = path.join(process.env.DSH_HOME, 'startup-animation.json')
  for (let i = 0; i < 20; i += 1) await postJson({ durationSec: (i % 12) + 3 })
  const text = fs.readFileSync(settings, 'utf8')
  const parsed = JSON.parse(text)
  assert.ok(parsed.boot, '配置被写坏')
  const leftovers = fs.readdirSync(path.dirname(settings)).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `留下了临时文件：${leftovers.join(',')}`)
  console.log('  ok   配置原子写（无残留临时文件、内容始终可解析）')
}

// ── 16. 并发上传不会互相踩（临时名与目标名两侧唯一）──
{
  const mediaDir = path.join(process.env.DSH_HOME, 'startup-animation-media')
  const before = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((n) => n.endsWith('.part')) : []
  console.log(`    [诊断] 并发前 .part：${before.length === 0 ? '无' : before.join(',')}`)
  const payloadA = Buffer.alloc(4096, 11)
  const uploadOne = (name, body) =>
    call(MANAGE_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Dsh-Filename': encodeURIComponent(name) },
      body,
    })
  const results = await Promise.all([
    uploadOne('并发.png', payloadA),
    uploadOne('并发.png', payloadA),
    uploadOne('并发.png', payloadA),
  ])
  for (const r of results) assert.equal(r.status, 200, `并发上传失败 ${r.status}: ${r.body.toString()}`)
  const files = results[results.length - 1]
    .json()
    .library.find((c) => c.id === '图片')
    .files.filter((f) => f.uploaded && f.name.startsWith('并发'))
  assert.equal(files.length, 3, `并发上传丢文件：${files.map((f) => f.name).join(',')}`)
  for (const f of files) assert.equal(f.size, payloadA.length, '并发上传把内容写坏了')
  // 失败/成功路径都可能留下"正在关闭"的临时文件：给关闭回调一点时间再断言。
  await new Promise((resolve) => setTimeout(resolve, 600))
  const leftovers = fs
    .readdirSync(path.join(process.env.DSH_HOME, 'startup-animation-media'))
    .filter((n) => n.endsWith('.part'))
  assert.deepEqual(leftovers, [], `留下了 .part 临时文件：${leftovers.join(',')}（状态 ${results.map((r) => r.status).join(',')}）`)
  console.log('  ok   并发同名上传：3 份都落地、内容完整、无残留 .part')
}

// ── 16b. 选用素材 + 同请求里的开关必须都生效 ──
{
  // 回归：`use` 分支曾经只写 file，同请求里的 sound/audioEnabled 被静默丢弃，
  // 于是"选视频并开声音"这类组合要分两次请求才能生效。
  const combined = await postJson({
    use: 'builtin/MP4/大肥鱼-欢迎回来.mp4',
    sound: true,
    audioEnabled: true,
    durationSec: 6,
  })
  assert.equal(combined.status, 200, combined.body.toString())
  const j = combined.json()
  assert.equal(j.file, 'builtin/MP4/大肥鱼-欢迎回来.mp4')
  assert.equal(j.sound, true, '同请求里的 sound 未生效')
  assert.equal(j.durationSec, 6, '同请求里的 durationSec 未生效')
  console.log('  ok   选用素材 + 同请求开关：一起生效')
}

// ── 17. 更新检查路由 ──
{
  const r = await call(UPDATE_ROUTE)
  assert.equal(r.status, 200, `更新检查失败 ${r.status}`)
  const body = r.json()
  assert.equal(body.ok, true)
  assert.equal(body.version, VERSION)
  // 本机可能离线、仓库可能还没建：两种情况都必须是 200 + 明确原因，
  // 而不是 5xx —— 更新检查失败绝不能让设置页看起来像坏了。
  assert.equal(typeof body.reachable, 'boolean')
  assert.equal(typeof body.updateAvailable, 'boolean')
  if (body.reachable !== true) assert.ok(typeof body.reason === 'string' && body.reason !== '', '未给出不可达原因')
  const put = await call(UPDATE_ROUTE, { method: 'PUT' })
  assert.equal(put.status, 405)
  console.log('  ok   更新检查路由：200 + 明确状态，非 GET 拒绝')
}

// ── 18. manage 状态携带版本（设置页小字的数据源）──
{
  const s = (await call(MANAGE_ROUTE)).json()
  assert.equal(s.version, VERSION, '状态里缺少版本号')
  assert.ok(String(s.repo).startsWith('https://github.com/'), '缺少仓库地址')
  console.log('  ok   manage 状态携带 version / repo')
}

await new Promise((resolve) => server.close(resolve))
fs.rmSync(tmp, { recursive: true, force: true })
if (warnings.length > 0) {
  console.log(`\n  （宿主日志 ${warnings.length} 条警告，属预期）`)
  for (const w of warnings) console.log(`   · ${w}`)
}
console.log('\nHOST SMOKE PASS')
