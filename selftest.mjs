/**
 * startup-animation 离线自检：不经过 Harness，直接对包内纯函数做断言。
 * 覆盖：配置解析/夹取、素材路径与类型白名单、上传配置写入与恢复、Range 语义、
 * 状态回显、素材 HTTP 服务（含 206/304/416/HEAD）。
 * 运行：node selftest.mjs   （全部通过 exit 0）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertBuiltinFile,
  assertUploadedFile,
  clampDurationSec,
  loadConfig,
  manageStatus,
  parseRange,
  pickMediaExtension,
  releaseStreams,
  removeUploadedFile,
  sanitizeUploadName,
  scanLibrary,
  serveAsset,
  trackStream,
  uniqueUploadTarget,
  writeHomeBootPatch,
  ASSET_ROUTE,
} from './startup-animation/index.js'

const packageRoot = fileURLToPath(new URL('./startup-animation/', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-selftest-'))
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

try {
  console.log('== 扩展名白名单 ==')
  await check('mp4 接受', () => assert.equal(pickMediaExtension('a.MP4'), '.mp4'))
  await check('png 接受', () => assert.equal(pickMediaExtension('壁纸.png'), '.png'))
  await check('exe 拒绝', () => assert.equal(pickMediaExtension('a.exe'), undefined))
  await check('无扩展名拒绝', () => assert.equal(pickMediaExtension('noext'), undefined))

  console.log('== Range 解析 ==')
  await check('bytes=0-15', () => assert.deepEqual(parseRange('bytes=0-15', 100), { start: 0, end: 15 }))
  await check('bytes=90-', () => assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 }))
  await check('bytes=-10 后缀', () => assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 }))
  await check('超界 unsatisfiable', () => assert.equal(parseRange('bytes=200-', 100), 'unsatisfiable'))
  await check('乱值忽略', () => assert.equal(parseRange('bytes=abc', 100), null))
  await check('多段忽略', () => assert.equal(parseRange('bytes=0-1,2-3', 100), null))
  await check('无头忽略', () => assert.equal(parseRange(undefined, 100), null))

  console.log('== 默认配置（无用户文件）==')
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  const opts = { packageRoot, homeDir: home, route: ASSET_ROUTE }
  await check('默认 css 模式', () => {
    const { client, assetPath, warnings } = loadConfig(opts)
    assert.equal(client.mode, 'css')
    assert.equal(client.enabled, true)
    assert.equal(assetPath, undefined)
    assert.deepEqual(warnings, [])
  })
  await check('数值夹取 holdMs 下界', () => {
    fs.writeFileSync(path.join(home, 'startup-animation.json'), JSON.stringify({ boot: { holdMs: 5 } }))
    const { client } = loadConfig(opts)
    assert.equal(client.holdMs, 2000)
    fs.rmSync(path.join(home, 'startup-animation.json'))
  })

  console.log('== 素材解析（绝对路径 + 类型降级）==')
  const fakeMp4 = path.join(tmp, 'mine.mp4')
  const fakeExe = path.join(tmp, 'mine.exe')
  fs.writeFileSync(fakeMp4, Buffer.alloc(4096, 7))
  fs.writeFileSync(fakeExe, Buffer.alloc(16, 1))
  await check('自定义 mp4 → video', () => {
    writeHomeBootPatch(home, { file: fakeMp4 })
    const { client, assetPath } = loadConfig(opts)
    assert.equal(client.mode, 'video')
    assert.equal(client.src, ASSET_ROUTE)
    assert.equal(assetPath, fakeMp4)
  })
  await check('不支持类型 → 回落 css + 警告', () => {
    writeHomeBootPatch(home, { file: fakeExe })
    const { client, assetPath, warnings } = loadConfig(opts)
    assert.equal(client.mode, 'css')
    assert.equal(assetPath, undefined)
    assert.equal(warnings.length, 1)
  })
  await check('包内相对路径逃逸被挡', () => {
    writeHomeBootPatch(home, { file: '../outside.mp4' })
    const { client, warnings } = loadConfig(opts)
    assert.equal(client.mode, 'css')
    assert.ok(warnings[0].includes('escapes'))
  })
  await check('缺失文件 → 警告 + css', () => {
    writeHomeBootPatch(home, { file: path.join(tmp, 'missing.mp4') })
    const { client, warnings } = loadConfig(opts)
    assert.equal(client.mode, 'css')
    assert.equal(warnings.length, 1)
  })

  console.log('== 管理状态与恢复默认 ==')
  await check('恢复默认后 status 干净', () => {
    writeHomeBootPatch(home, {}, ['file'])
    const s = manageStatus(opts)
    assert.equal(s.ok, true)
    assert.equal(s.custom, false)
    assert.equal(s.mode, 'css')
    assert.equal(s.enabled, true)
  })
  await check('上传上限为 128 MiB', () => {
    const s = manageStatus(opts)
    assert.equal(s.limitBytes, 128 * 1024 * 1024)
  })
  await check('上传后 status 反映素材', () => {
    writeHomeBootPatch(home, { file: fakeMp4 })
    const s = manageStatus(opts)
    assert.equal(s.custom, true)
    assert.equal(s.name, 'mine.mp4')
    assert.equal(s.mode, 'video')
    writeHomeBootPatch(home, {}, ['file'])
  })
  await check('开关写入并保留其它键', () => {
    writeHomeBootPatch(home, { file: fakeMp4, sound: true })
    writeHomeBootPatch(home, { enabled: false })
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'startup-animation.json'), 'utf8'))
    assert.equal(raw.boot.enabled, false)
    assert.equal(raw.boot.file, fakeMp4)
    assert.equal(raw.boot.sound, true)
    writeHomeBootPatch(home, {}, ['file', 'sound'])
    writeHomeBootPatch(home, { enabled: true })
  })

  console.log('== 内置素材库 ==')
  await check('库扫描：MP4=3、图片=7', () => {
    const lib = scanLibrary(packageRoot)
    const mp4 = lib.find((c) => c.id === 'MP4')
    const img = lib.find((c) => c.id === '图片')
    assert.ok(mp4, '缺少 MP4 分类')
    assert.ok(img, '缺少 图片 分类')
    assert.equal(mp4.files.length, 3)
    assert.equal(img.files.length, 7)
    assert.ok(mp4.files.every((f) => f.path.startsWith('builtin/MP4/') && f.size > 0))
  })
  await check('tombstone 从列表隐藏', () => {
    const lib = scanLibrary(packageRoot, ['builtin/MP4/多重影像.mp4'])
    assert.equal(lib.find((c) => c.id === 'MP4').files.length, 2)
  })
  await check('assertBuiltinFile 接受合法路径', () => {
    assert.equal(
      assertBuiltinFile(packageRoot, 'builtin/MP4/多重影像.mp4'),
      'builtin/MP4/多重影像.mp4',
    )
    assert.equal(
      assertBuiltinFile(packageRoot, 'builtin/MP4\\傍晚海风-海边.mp4'),
      'builtin/MP4/傍晚海风-海边.mp4',
    )
  })
  await check('assertBuiltinFile 拒绝逃逸/错类型/已移除/不存在', () => {
    assert.throws(() => assertBuiltinFile(packageRoot, '../x.mp4'), /无效/)
    assert.throws(() => assertBuiltinFile(packageRoot, 'other/x.mp4'), /无效/)
    assert.throws(() => assertBuiltinFile(packageRoot, 'builtin/MP4/a.txt'), /类型/)
    assert.throws(
      () => assertBuiltinFile(packageRoot, 'builtin/MP4/多重影像.mp4', ['builtin/MP4/多重影像.mp4']),
      /移除/,
    )
    assert.throws(() => assertBuiltinFile(packageRoot, 'builtin/MP4/ghost.mp4'), /不存在/)
  })
  await check('status 携带 file/builtin/library', () => {
    writeHomeBootPatch(home, { file: 'builtin/MP4/多重影像.mp4' })
    const s = manageStatus(opts)
    assert.equal(s.file, 'builtin/MP4/多重影像.mp4')
    assert.equal(s.builtin, true)
    assert.equal(s.custom, true)
    assert.equal(s.name, '多重影像.mp4')
    assert.equal(s.library.length, 3)
    writeHomeBootPatch(home, {}, ['file'])
  })

  console.log('== 展示时长（共用主配置，3–15 秒）==')
  await check('clampDurationSec 夹到 3–15', () => {
    assert.equal(clampDurationSec(2), 3)
    assert.equal(clampDurationSec(-5), 3)
    assert.equal(clampDurationSec(16), 15)
    assert.equal(clampDurationSec(99), 15)
    assert.equal(clampDurationSec(7), 7)
    assert.equal(clampDurationSec(4.4), 4)
    assert.equal(clampDurationSec('x'), 5)
    assert.equal(clampDurationSec(undefined), 5)
  })
  await check('素材模式 minMs = durationSec × 1000（视频与壁纸同一键）', () => {
    const fakePng = path.join(tmp, 'wall.png')
    fs.writeFileSync(fakePng, Buffer.alloc(2048, 1))
    writeHomeBootPatch(home, { file: fakeMp4, durationSec: 12 })
    let r = loadConfig(opts)
    assert.equal(r.client.durationSec, 12)
    assert.equal(r.client.minMs, 12000)
    // png 静帧：mode 归一为 image（运行时才挂图），still 标记保留（呼吸缩放）。
    writeHomeBootPatch(home, { file: fakePng })
    r = loadConfig(opts)
    assert.equal(r.client.mode, 'image')
    assert.equal(r.client.still, true)
    assert.equal(r.client.durationSec, 12)
    assert.equal(r.client.minMs, 12000)
    writeHomeBootPatch(home, {}, ['file', 'durationSec'])
  })
  await check('css 模式维持 900ms；旧分类键回退读取', () => {
    let r = loadConfig(opts)
    assert.equal(r.client.minMs, 900)
    assert.equal(r.client.durationSec, 5)
    writeHomeBootPatch(home, { videoSec: 9 })
    r = loadConfig(opts)
    assert.equal(r.client.durationSec, 9)
    writeHomeBootPatch(home, {}, ['videoSec'])
  })
  await check('status 回显 durationSec', () => {
    writeHomeBootPatch(home, { durationSec: 15 })
    assert.equal(manageStatus(opts).durationSec, 15)
    writeHomeBootPatch(home, {}, ['durationSec'])
  })

  console.log('== 上传素材：自动归类进列表 ==')
  const uploadDir = path.join(home, 'startup-animation-media')
  fs.mkdirSync(uploadDir, { recursive: true })
  const upMp4 = path.join(uploadDir, 'aaaa1111deadbeef.mp4')
  const upJpg = path.join(uploadDir, 'bbbb2222cafebabe.jpg')
  fs.writeFileSync(upMp4, Buffer.alloc(1024, 3))
  fs.writeFileSync(upJpg, Buffer.alloc(512, 4))
  await check('上传文件按扩展名自动归入 MP4 / 图片', () => {
    const lib = scanLibrary(packageRoot, [], home)
    const mp4 = lib.find((c) => c.id === 'MP4')
    const img = lib.find((c) => c.id === '图片')
    assert.ok(mp4, '缺少 MP4 分类')
    assert.ok(img, '缺少 图片 分类')
    const inMp4 = mp4.files.find((f) => f.path === upMp4)
    const inImg = img.files.find((f) => f.path === upJpg)
    assert.ok(inMp4, '上传的 mp4 未进入 MP4 分类')
    assert.ok(inImg, '上传的 jpg 未进入 图片 分类')
    assert.equal(inMp4.uploaded, true)
    assert.equal(inImg.uploaded, true)
    // 内置素材不受上传影响（仍然 3 个）。
    assert.equal(mp4.files.filter((f) => f.uploaded !== true).length, 3)
  })
  await check('不传 homeDir 只扫内置', () => {
    const lib = scanLibrary(packageRoot)
    const mp4 = lib.find((c) => c.id === 'MP4')
    assert.ok(mp4.files.every((f) => f.uploaded !== true))
  })
  await check('assertUploadedFile 接受目录内、拒绝目录外/错类型/不存在', () => {
    assert.equal(assertUploadedFile(home, upMp4), upMp4)
    assert.throws(() => assertUploadedFile(home, fakeMp4), /无效/)
    assert.throws(() => assertUploadedFile(home, path.join(uploadDir, 'x.exe')), /类型/)
    assert.throws(() => assertUploadedFile(home, path.join(uploadDir, 'ghost.mp4')), /不存在/)
    assert.throws(() => assertUploadedFile(home, 'relative.mp4'), /无效/)
  })
  await check('removeUploadedFile 真删文件、拒绝目录外', () => {
    const doomed = path.join(uploadDir, 'doomed.webm')
    fs.writeFileSync(doomed, Buffer.alloc(64, 5))
    assert.equal(removeUploadedFile(home, doomed), doomed)
    assert.equal(fs.existsSync(doomed), false)
    assert.throws(() => removeUploadedFile(home, fakeMp4), /无效/)
    assert.equal(fs.existsSync(fakeMp4), true)
  })

  console.log('== 实时配置通道（刷新即生效，v1.5.0）==')
  await check('manageStatus 携带 cfg（运行时实时读取的完整配置）', () => {
    writeHomeBootPatch(home, { file: fakeMp4, durationSec: 7 })
    const s = manageStatus(opts)
    assert.ok(s.cfg !== null && typeof s.cfg === 'object', '缺少 cfg 字段')
    assert.equal(s.cfg.enabled, true)
    assert.equal(s.cfg.mode, 'video')
    assert.equal(s.cfg.src, ASSET_ROUTE)
    assert.equal(s.cfg.durationSec, 7)
    assert.equal(typeof s.cfg.fadeMs, 'number')
    assert.equal(typeof s.cfg.holdMs, 'number')
    writeHomeBootPatch(home, {}, ['file', 'durationSec'])
  })
  await check('关闭开关 → cfg.enabled=false（运行时按它决定不挂载）', () => {
    writeHomeBootPatch(home, { enabled: false })
    const s = manageStatus(opts)
    assert.equal(s.cfg.enabled, false)
    writeHomeBootPatch(home, { enabled: true })
  })
  await check('boot.js 运行时：实时读取 + 关闭/无素材不挂载（静态锚点）', () => {
    const src = fs.readFileSync(new URL('./startup-animation/runtime/boot.js', import.meta.url), 'utf8')
    // 精简回包：开机动画只要 cfg，不该顺带让宿主重扫一遍素材库。
    assert.ok(src.includes('/dsh-startup-animation/manage?cfg=1'), '缺少实时配置端点（精简回包）')
    assert.ok(src.includes('function beginWithConfig(cfg)'), '缺少配置包装')
    assert.ok(src.includes('if (cfg.enabled === false) return'), '缺少关闭政策')
    assert.ok(src.includes('cfg.src === ""'), '缺少无素材政策')
    assert.ok(src.includes('LIVE_TIMEOUT_MS'), '缺少实时读取超时兜底')
  })

  console.log('== 上传文件名：保留原始名 + 重名去重（v1.5.0）==')
  await check('sanitizeUploadName 保留中文原名、去路径与非法字符', () => {
    assert.equal(sanitizeUploadName('我的 开场动画.mp4'), '我的 开场动画.mp4')
    assert.equal(sanitizeUploadName('C:\\Users\\x\\壁纸1.jpg'), '壁纸1.jpg')
    assert.equal(sanitizeUploadName('a/b/c.webm'), 'c.webm')
    assert.equal(sanitizeUploadName('bad<>:"|?*.png'), 'bad_______.png')
    assert.equal(sanitizeUploadName('..'), '')
    assert.equal(sanitizeUploadName(''), '')
    const long = 'x'.repeat(200) + '.mp4'
    const trimmed = sanitizeUploadName(long)
    assert.ok(trimmed.length <= 110, `超长未截断：${trimmed.length}`)
    assert.ok(trimmed.endsWith('.mp4'), '截断丢了扩展名')
  })
  await check('uniqueUploadTarget 重名自动加 (1)/(2) 序号', () => {
    const dir = path.join(tmp, 'uniq')
    fs.mkdirSync(dir, { recursive: true })
    const first = uniqueUploadTarget(dir, '开场.mp4')
    assert.equal(path.basename(first), '开场.mp4')
    fs.writeFileSync(first, '1')
    const second = uniqueUploadTarget(dir, '开场.mp4')
    assert.equal(path.basename(second), '开场 (1).mp4')
    fs.writeFileSync(second, '2')
    const third = uniqueUploadTarget(dir, '开场.mp4')
    assert.equal(path.basename(third), '开场 (2).mp4')
  })

  console.log('== 句柄释放与真删兜底（v1.5.1）==')
  await check('trackStream/releaseStreams 释放发送流（防 Windows EPERM）', () => {
    const f = path.join(tmp, 'track.webm')
    fs.writeFileSync(f, Buffer.alloc(4096, 9))
    const s1 = fs.createReadStream(f)
    const s2 = fs.createReadStream(f)
    trackStream(f, s1)
    trackStream(f, s2)
    assert.equal(releaseStreams(f), 2)
    assert.equal(s1.destroyed, true)
    assert.equal(s2.destroyed, true)
    assert.equal(releaseStreams(f), 0)
  })
  await check('上传素材可被 tombstone 隐藏（真删失败的兜底路径）', () => {
    const lib = scanLibrary(packageRoot, [upMp4], home)
    const mp4 = lib.find((c) => c.id === 'MP4')
    const img = lib.find((c) => c.id === '图片')
    assert.ok(mp4 && img, '缺少分类')
    assert.ok(!mp4.files.some((f) => f.path === upMp4), '被隐藏的上传素材仍在 MP4 列表')
    assert.ok(img.files.some((f) => f.path === upJpg), '另一上传素材不应被误隐藏')
  })
  await check('真删失败兜底与流释放（静态锚点）', () => {
    const src = fs.readFileSync(new URL('./startup-animation/index.js', import.meta.url), 'utf8')
    assert.ok(src.includes('releaseStreams(norm)'), '删除前未释放发送流')
    assert.ok(src.includes('hiddenOnly: true'), '缺少"仅隐藏"回包')
    assert.ok(src.includes('if (!res.writableEnded) stream.destroy()'), '缺少断开即销毁源流')
    assert.ok(src.includes('attempt < 5'), '缺少真删重试')
  })

  console.log('== 开机音频域（v1.7.0）==')
  const fakeMp3 = path.join(tmp, '开机音.mp3')
  fs.writeFileSync(fakeMp3, Buffer.alloc(2048, 8))
  await check('audioEnabled+音频文件 → client.audioSrc 带 ?path=', () => {
    writeHomeBootPatch(home, { audioEnabled: true, audioFile: fakeMp3, audioVolume: 0.6 })
    const { client, warnings } = loadConfig(opts)
    assert.equal(client.audioEnabled, true)
    assert.ok(client.audioSrc.includes('?path='), `audioSrc 异常：${client.audioSrc}`)
    assert.equal(client.audioVolume, 0.6)
    assert.deepEqual(warnings, [])
  })
  await check('非音频文件被拒（警告+忽略）', () => {
    writeHomeBootPatch(home, { audioFile: fakeMp4 })
    const { client, warnings } = loadConfig(opts)
    assert.equal(client.audioSrc, '')
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('audioFile'))
  })
  await check('开关关闭 → audioSrc 为空', () => {
    writeHomeBootPatch(home, { audioEnabled: false })
    assert.equal(loadConfig(opts).client.audioSrc, '')
    writeHomeBootPatch(home, {}, ['audioEnabled', 'audioFile', 'audioVolume'])
  })
  await check('内置音频分类出现在库（9 个 mp3）', () => {
    const lib = scanLibrary(packageRoot)
    const audio = lib.find((c) => c.id === '音频')
    assert.ok(audio, '缺少 音频 分类')
    assert.equal(audio.files.length, 9)
    assert.ok(audio.files.every((f) => f.path.startsWith('builtin/音频/') && f.size > 0))
  })
  await check('status 回显音频域字段', () => {
    const rel = 'builtin/音频/秘书.mp3'
    writeHomeBootPatch(home, { audioEnabled: true, audioFile: rel })
    const s = manageStatus(opts)
    assert.equal(s.audioEnabled, true)
    assert.equal(s.audioFile, rel)
    assert.equal(s.audioName, '秘书.mp3')
    assert.equal(s.audioBuiltin, true)
    writeHomeBootPatch(home, {}, ['audioEnabled', 'audioFile'])
  })
  await check('boot.js 音频运行时（静态锚点）', () => {
    const src = fs.readFileSync(new URL('./startup-animation/runtime/boot.js', import.meta.url), 'utf8')
    assert.ok(src.includes('playStartupAudio'), '缺少起播函数')
    assert.ok(src.includes('fadeStartupAudio(ms)'), '缺少退场淡停调用')
    assert.ok(src.includes('if (audioOn) wantSound = false'), '缺少"音频开启→视频强制静音"')
    assert.ok(src.includes('cfg.audioEnabled === true'), '缺少音频开关判定')
    // 揭幕门控：音频与标题栏按住都发生在"第一帧就位"，不是挂载瞬间。
    const mark = src.slice(src.indexOf('function markMediaOk'), src.indexOf('function whenFramePresents'))
    assert.ok(mark.includes('playStartupAudio()'), 'markMediaOk 未起播音频')
    assert.ok(mark.includes('holdTitlebar()'), 'markMediaOk 未按住标题栏浮层')
    assert.ok(!src.includes('watchHold()\n        playStartupAudio()'), 'begin 仍在挂载瞬间放音')
    // 最短展示从出画起算。
    assert.ok(src.includes('state.revealedAt !== null ? state.revealedAt : state.startAt'), 'minMs 未从出画起算')
  })
  await check('boot.css 未出画=完全透明且不拦截点击（静态锚点）', () => {
    const css = fs.readFileSync(new URL('./startup-animation/runtime/boot.css', import.meta.url), 'utf8')
    assert.ok(/data-media="loading"[\s\S]{0,120}opacity: 0/.test(css), 'loading 态未透明')
    assert.ok(css.includes('pointer-events: none'), '透明期未关闭点击拦截')
  })
  await check('client.js 音频设置（静态锚点）', () => {
    const src = fs.readFileSync(new URL('./startup-animation/client.js', import.meta.url), 'utf8')
    assert.ok(src.includes('useAudio:'), '缺少 useAudio 选用')
    assert.ok(src.includes("id: 'audio'"), '缺少音频页签')
    assert.ok(src.includes('audioVolume'), '缺少音量滑杆')
    assert.ok(src.includes('audioEnabled'), '缺少开关')
  })

  console.log('== 客户端开关字段映射（静态回归）==')
  await check('enable→enabled 映射存在、未再用 state[key] 直取', () => {
    // 回归（v1.4.0 的"开机动画关不掉"）：toggle('enable') 曾读 state['enable']（undefined），
    // !undefined 恒为 true → 永远写回 enabled:true。React 组件无法离线执行，用源码断言钉死。
    const src = fs.readFileSync(new URL('./startup-animation/client.js', import.meta.url), 'utf8')
    assert.ok(src.includes("key === 'enable' ? 'enabled' : key"), '未找到 enable→enabled 映射')
    assert.ok(!src.includes('{ [key]: !state[key] }'), '仍在用 state[key] 直接取值（enable 键会读到 undefined）')
    assert.ok(!src.includes('{ [key]: !state[field] }') || src.includes('const field'), '字段映射缺失')
  })

  console.log('== 素材 HTTP 服务 ==')
  const payload = Buffer.alloc(100)
  for (let i = 0; i < 100; i += 1) payload[i] = i
  const assetFile = path.join(tmp, 'served.webm')
  fs.writeFileSync(assetFile, payload)

  const server = http.createServer((req, res) => serveAsset(req, res, assetFile))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/`

  const get = (headers = {}, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = http.request(base, { headers, method }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })

  const full = await get()
  await check('整片 200 + no-cache + ETag + MIME', () => {
    assert.equal(full.status, 200)
    assert.equal(full.headers['cache-control'], 'no-cache')
    assert.ok(full.headers.etag)
    assert.equal(full.body.length, 100)
    assert.equal(full.headers['content-type'], 'video/webm')
  })
  const conditional = await get({ 'If-None-Match': full.headers.etag })
  await check('条件请求 304', () => assert.equal(conditional.status, 304))
  const ranged = await get({ Range: 'bytes=10-19' })
  await check('Range 206 + no-store + 片段', () => {
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers['cache-control'], 'no-store')
    assert.equal(ranged.headers['content-range'], 'bytes 10-19/100')
    assert.equal(ranged.body.length, 10)
    assert.deepEqual([...ranged.body], [...payload.subarray(10, 20)])
  })
  const unsat = await get({ Range: 'bytes=500-' })
  await check('416', () => assert.equal(unsat.status, 416))
  const head = await get({}, 'HEAD')
  await check('HEAD 只要头', () => {
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(Number(head.headers['content-length']), 100)
  })
  await new Promise((resolve) => server.close(resolve))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
