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
  cleanupLinkedInstall,
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
  writeHomeBootPatch,
  ASSET_ROUTE,
  REPO_URL,
  UPDATE_ROUTE,
  VERSION,
  checkForUpdate,
  compareVersions,
  resetUpdateCache,
} from './index.js'

const packageRoot = fileURLToPath(new URL('./', import.meta.url))
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
  await check('库扫描：MP4 与图片分类齐全', () => {
    const lib = scanLibrary(packageRoot)
    const mp4 = lib.find((c) => c.id === 'MP4')
    const img = lib.find((c) => c.id === '图片')
    assert.ok(mp4, '缺少 MP4 分类')
    assert.ok(img, '缺少 图片 分类')
    assert.ok(mp4.files.length >= 4, `MP4 条目偏少：${mp4.files.length}`)
    assert.equal(img.files.length, 7)
    assert.ok(mp4.files.every((f) => f.path.startsWith('builtin/MP4/') && f.size > 0))
  })
  await check('tombstone 从列表隐藏', () => {
    // 相对断言：隐藏一个就少一个，不写死总数（内置素材会随版本增减）。
    const before = scanLibrary(packageRoot).find((c) => c.id === 'MP4').files.length
    const lib = scanLibrary(packageRoot, ['builtin/MP4/多重影像.mp4'])
    const after = lib.find((c) => c.id === 'MP4').files.length
    assert.equal(after, before - 1)
    assert.ok(!lib.find((c) => c.id === 'MP4').files.some((f) => f.path === 'builtin/MP4/多重影像.mp4'))
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
  await check('css 模式维持 900ms；未发布的旧分类键不再被读取', () => {
    let r = loadConfig(opts)
    assert.equal(r.client.minMs, 900)
    assert.equal(r.client.durationSec, 5)
    // AGENTS.md 规则 3：不写历史数据兼容分支。videoSec/imageSec 是未发布过的
    // 中间版本键名，读它只会让配置语义含糊（旧键值悄悄盖住新键）。
    writeHomeBootPatch(home, { videoSec: 9 })
    r = loadConfig(opts)
    assert.equal(r.client.durationSec, 5, '未发布的旧分类键仍在生效')
    writeHomeBootPatch(home, {}, ['videoSec'])
  })
  await check('status 回显 durationSec', () => {
    writeHomeBootPatch(home, { durationSec: 15 })
    assert.equal(manageStatus(opts).durationSec, 15)
    writeHomeBootPatch(home, {}, ['durationSec'])
  })
  await check('status 携带 version / repo / releasesUrl', () => {
    const st = manageStatus(opts)
    assert.equal(st.version, VERSION)
    assert.equal(st.repo, REPO_URL)
    assert.equal(st.releasesUrl, `${REPO_URL}/releases`)
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
    // 内置素材不受上传影响：上传只新增条目，内置数量保持不变。
    const builtinCount = scanLibrary(packageRoot).find((c) => c.id === 'MP4').files.length
    assert.equal(mp4.files.filter((f) => f.uploaded !== true).length, builtinCount)
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
    const src = fs.readFileSync(new URL('./runtime/boot.js', import.meta.url), 'utf8')
    // 精简回包：开机动画只要 cfg，不该顺带让宿主重扫一遍素材库。
    assert.ok(src.includes('/dsh-startup-animation/manage?cfg=1'), '缺少实时配置端点（精简回包）')
    assert.ok(src.includes('function beginWithConfig(cfg)'), '缺少配置包装')
    // 每条 early-return 都要顺手摘掉解析期打的遮罩，否则关掉开关就是一块纯色。
    const closed = src.slice(src.indexOf('function beginWithConfig(cfg)'), src.indexOf('var fadeMs ='))
    assert.ok(/cfg\.enabled === false[\s\S]{0,80}setCover\(false\)/.test(closed), '缺少关闭政策（或没摘遮罩）')
    // 素材模式缺素材 → 不挂载（只剩永远"加载中"的空屏）。css 模式**要**挂载：
    // 那是内置动画，"零配置"承诺的那一份。行为由 tools/boot-runtime.mjs 实测。
    assert.ok(
      /mode !== 'css' && src === ""[\s\S]{0,80}setCover\(false\)/.test(closed),
      '缺少"素材模式缺素材不挂载"政策（或没摘遮罩）',
    )
    assert.ok(
      !src.includes('if (!(cfg.mode === "video" || cfg.mode === "image")) return'),
      '仍有"css 模式不挂载"的 early-return —— 内置动画会永远出不来',
    )
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
  await check('落盘用 link 原子创建：同名不覆盖，序号递增', () => {
    // 上传落盘走 `link(temp → target)`：目标已存在必然失败（EEXIST），
    // 于是"只在不存在时创建"这件事没有任何检查后使用（TOCTOU）窗口。
    // 这个性质没法靠"挑一个不冲突的名字"的辅助函数保证 —— 那正是被删掉的那个
    // 死代码（旧函数先 existsSync 再返回，调用方并没有用它）。
    const dir = path.join(tmp, 'uniq')
    fs.mkdirSync(dir, { recursive: true })
    const temp = path.join(dir, '.upload-test.part')
    fs.writeFileSync(temp, 'payload')
    const place = (name) => {
      const target = path.join(dir, name)
      try {
        fs.linkSync(temp, target)
        return true
      } catch (error) {
        if (error && error.code === 'EEXIST') return false
        throw error
      }
    }
    assert.equal(place('开场.mp4'), true)
    assert.equal(place('开场.mp4'), false, '同名覆盖了已存在的文件')
    assert.equal(place('开场 (1).mp4'), true)
    assert.equal(fs.readFileSync(path.join(dir, '开场.mp4'), 'utf8'), 'payload')
    assert.equal(fs.readFileSync(path.join(dir, '开场 (1).mp4'), 'utf8'), 'payload')
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
    const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
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
    const src = fs.readFileSync(new URL('./runtime/boot.js', import.meta.url), 'utf8')
    assert.ok(src.includes('playStartupAudio'), '缺少起播函数')
    assert.ok(src.includes('fadeStartupAudio(ms)'), '缺少退场淡停调用')
    // 回归（v1.9.1）：早期版本在开机音频开启时强制静音视频，这违背了"两路声音
    // 各自由用户决定"。现在两者独立，且不得再出现这行强制静音。
    assert.ok(!src.includes('if (audioOn) wantSound = false'), '仍存在"音频开启→视频强制静音"')
    assert.ok(src.includes('var wantSound = cfg.sound === true'), '视频声音应直接跟随 cfg.sound')
    assert.ok(src.includes('var audioOn = cfg.audioEnabled === true'), '音频开关应直接跟随 cfg.audioEnabled')
    assert.ok(src.includes('cfg.audioEnabled === true'), '缺少音频开关判定')
    // 揭幕门控：音频与标题栏按住都发生在"第一帧就位"，不是挂载瞬间。
    const mark = src.slice(src.indexOf('function markMediaOk'), src.indexOf('function whenFramePresents'))
    assert.ok(mark.includes('playStartupAudio()'), 'markMediaOk 未起播音频')
    assert.ok(mark.includes('holdTitlebar()'), 'markMediaOk 未按住标题栏浮层')
    assert.ok(!src.includes('watchHold()\n        playStartupAudio()'), 'begin 仍在挂载瞬间放音')
    // 最短展示从出画起算。
    assert.ok(src.includes('state.revealedAt !== null ? state.revealedAt : state.startAt'), 'minMs 未从出画起算')
  })
  await check('boot.css 素材未出画时也不透明（静态锚点）', () => {
    const css = fs.readFileSync(new URL('./runtime/boot.css', import.meta.url), 'utf8')
    // loading 必须**不**透明：否则素材解码那几百毫秒里原生启动卡会露出来，
    // 就是用户看到的"闪一下原生动画"。只有素材彻底失败（gone）才让开。
    // 注意锚点要卡在根节点规则上 —— HUD 那条 `[data-media="loading"] … .dsa-hud`
    // 里也有 opacity: 0，那是"让 HUD 跟着素材一起淡入"，不是根节点透明。
    assert.ok(!/\.dsa-root\[data-media="loading"\]\s*\{[^}]*opacity: 0/.test(css), 'loading 态根节点仍透明')
    assert.ok(/\.dsa-root\[data-media="gone"\]\s*\{[\s\S]{0,120}opacity: 0/.test(css), 'gone 态未透明')
    assert.ok(css.includes('pointer-events: none'), '透明期未关闭点击拦截')
  })
  await check('boot.css 素材模式不出现内置徽标场景（静态锚点）', () => {
    const css = fs.readFileSync(new URL('./runtime/boot.css', import.meta.url), 'utf8')
    // 素材模式从挂载到出画都不许用徽标顶班：用户要的是"黑一下就出自己的画面"，
    // 不是先闪一张 DeepSeek Harness 标题页。徽标场景只属于 css 模式。
    assert.ok(
      /\.dsa-root\[data-mode="media"\]\s+\.dsa-scene\s*\{[^}]*display: none/.test(css),
      '素材模式仍会显示内置徽标场景',
    )
    assert.ok(
      /\.dsa-root\[data-mode="media"\]\[data-media="loading"\]\s+\.dsa-hud\s*\{[^}]*opacity: 0/.test(css),
      'HUD 未跟随素材淡入（会在空背景上先冒出一条进度条）',
    )
  })
  await check('boot.css 动画可见时隐藏原生启动卡（静态锚点）', () => {
    const css = fs.readFileSync(new URL('./runtime/boot.css', import.meta.url), 'utf8')
    // 覆盖层不透明（挂载起，含 loading）→ [data-dsh-boot] 必须被藏起来；
    // gone 是唯一的排除项 —— 那是"素材挂掉时原生页照常"的保证。
    assert.ok(
      /html:has\(\.dsa-root:not\(\[data-media="gone"\]\)\)\s*\[data-dsh-boot\][\s\S]{0,80}display: none/.test(css),
      '缺少"动画可见时隐藏原生启动卡"规则，或未排除 gone 态',
    )
  })
  await check('boot.css 首帧遮罩：解析期就能铺满并藏卡', () => {
    const css = fs.readFileSync(new URL('./runtime/boot.css', import.meta.url), 'utf8')
    // 覆盖层要等一次 fetch 才挂得上；这中间原生卡已经被画出来了。脚本在解析期
    // 打 data-dsa-cover，样式同步铺满 —— 真正的覆盖层一出现（:has 命中）就撤。
    assert.ok(
      /html\[data-dsa-cover\]:not\(:has\(\.dsa-root\)\)::before\s*\{[\s\S]{0,200}position: fixed/.test(css),
      '缺少首帧遮罩的铺满规则',
    )
    assert.ok(
      /html\[data-dsa-cover\]\s*\[data-dsh-boot\][\s\S]{0,80}display: none/.test(css),
      '缺少首帧遮罩期间的藏卡规则',
    )
    const src = fs.readFileSync(new URL('./runtime/boot.js', import.meta.url), 'utf8')
    assert.ok(src.includes("COVER_ATTR = 'data-dsa-cover'"), 'boot.js 未定义遮罩标记')
    assert.ok(src.includes('setCover(true)'), 'boot.js 未在解析期打开遮罩')
    // 遮罩不能只看素材模式：默认配置 file='' → mode='css'（内置动画），
    // 那时同样要先遮 —— 否则默认体验恰好是"原生启动卡闪一帧再被盖住"。
    assert.ok(
      /baked\.enabled !== false\)\s*setCover\(true\)/.test(src),
      '首帧遮罩又变回只在 video/image 打开（默认配置会闪原生启动页）',
    )
    // 失败与退场必须摘标记，否则原生启动页被一直藏到动画消失。
    assert.ok(src.includes("mediaGone('mount-throw')"), '挂载失败路径仍在')
    assert.ok(src.includes('setCover(false)'), 'boot.js 未关闭遮罩')
    // 致命异常路径（beginWithConfig 抛）也必须摘：规则是 display:none !important，
    // 只藏卡不解卡 —— 内核启动失败时用户会看到一块纯色，连失败原因都读不到。
    assert.ok(
      /try \{\s*beginWithConfig\(cfg\)[\s\S]{0,400}?setCover\(false\)/.test(src),
      '致命异常路径没摘首帧遮罩（内核失败时会变纯色屏）',
    )
  })
  await check('资源接口：?poster=1 没有手工封面时回 404', () => {
    const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    // 以前这里回的是视频本体，客户端再把几 MB 视频塞进 <img> 当封面 —— 必然
    // 解码失败，还白下一段流量，卡片于是先空一秒再突然出现画面。
    // 断言只锚"poster 分支存在"与"posterFor 之后紧跟 404"，不锚 if 的具体写法 ——
    // 上一版锚的是 `if (poster) {`，查询参数解析一抽公共就误报。
    assert.ok(src.includes("requestFlag(req, 'poster')"), '?poster=1 分支没了')
    assert.ok(/posterFor\(filePath\)[\s\S]{0,300}?404/.test(src), '?poster=1 缺失时未回 404')
    const client = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
    assert.ok(client.includes('useState(null)'), 'VideoCover 未在探测期留空')
    assert.ok(/hasManual === null/.test(client), 'VideoCover 探测期仍在画媒体元素')
  })
  await check('client.js 音频设置（静态锚点）', () => {
    const src = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
    assert.ok(src.includes('useAudio:'), '缺少 useAudio 选用')
    assert.ok(src.includes("id: 'audio'"), '缺少音频页签')
    assert.ok(src.includes('audioVolume'), '缺少音量滑杆')
    assert.ok(src.includes('audioEnabled'), '缺少开关')
  })

  console.log('== 客户端开关字段映射（静态回归）==')
  await check('enable→enabled 映射存在、未再用 state[key] 直取', () => {
    // 回归（v1.4.0 的"开机动画关不掉"）：toggle('enable') 曾读 state['enable']（undefined），
    // !undefined 恒为 true → 永远写回 enabled:true。
    // 注意：tools/client-test.mjs 已经用**真实渲染**覆盖了这条（点开关 → 断言
    // 请求体是 {enabled:false}）；这里保留源码断言作为双保险，但**不是**唯一防线。
    const src = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
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

console.log('== 版本号与更新检查 ==')
await check('VERSION 与 package.json 一致（唯一来源）', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
  assert.match(VERSION, /^\d+\.\d+\.\d+/, `版本号格式异常：${VERSION}`)
})
await check('compareVersions 比较数字段、剥离 v 前缀', () => {
  assert.equal(compareVersions('1.9.0', '1.9.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('v2.0.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.9.0', '2.0.0'), -1)
  assert.equal(compareVersions('1.9', '1.9.0'), 0)
  // 无法解析的版本不制造假"有更新"。
  assert.equal(compareVersions('garbage', '1.0.0'), 0)
})
await check('更新检查：有新版本 → updateAvailable', async () => {
  resetUpdateCache()
  const fake = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9' }) })
  const r = await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: fake, force: true })
  assert.equal(r.reachable, true)
  assert.equal(r.latest, '9.9.9')
  assert.equal(r.updateAvailable, true)
})
await check('更新检查：Release 正文随结果带回（「更新公告」的内容源）', async () => {
  resetUpdateCache()
  const body = '## 开机动画 v9.9.9\n\n### 改了什么\n\n- 一行要点'
  const fake = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9', body }) })
  const r = await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: fake, force: true })
  assert.equal(r.notes, body, '没有把 Release 正文带回，更新公告就没有内容源')
})
await check('更新检查：回退 tags（没有 Release）→ 正文为空串，不编造公告', async () => {
  resetUpdateCache()
  const fake = async (url) => {
    if (String(url).includes('/releases/latest')) return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => [{ name: 'v3.0.0' }] }
  }
  const r = await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: fake, force: true })
  assert.equal(r.latest, '3.0.0')
  assert.equal(r.notes, '', `tags 回退不该带正文：${JSON.stringify(r.notes)}`)
})
await check('更新检查：本地已最新 → 不提示', async () => {
  resetUpdateCache()
  const fake = async () => ({ ok: true, json: async () => ({ tag_name: 'v1.9.0' }) })
  const r = await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: fake, force: true })
  assert.equal(r.updateAvailable, false)
})
await check('更新检查：本地版本更高 → 不提示降级', async () => {
  resetUpdateCache()
  const fake = async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.0' }) })
  const r = await checkForUpdate({ currentVersion: '2.0.0', repoUrl: REPO_URL, fetchImpl: fake, force: true })
  assert.equal(r.updateAvailable, false)
})
await check('更新检查：网络失败不报错、只是 reachable=false', async () => {
  resetUpdateCache()
  const boom = async () => { throw new Error('offline') }
  const r = await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: boom, force: true })
  assert.equal(r.ok, true, '网络失败不该让 ok=false')
  assert.equal(r.reachable, false)
  assert.equal(r.updateAvailable, false)
  assert.equal(r.reason, 'network')
})
await check('更新检查：无 fetch 能力 → no-fetch（不触及全局 fetch）', async () => {
  resetUpdateCache()
  const r = await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: null, force: true })
  assert.equal(r.reachable, false)
  assert.equal(r.reason, 'no-fetch')
})
await check('更新检查：Release 缺失 → 回退 tags', async () => {
  resetUpdateCache()
  const fake = async (url) => {
    if (String(url).includes('/releases/latest')) return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => [{ name: 'v3.0.0' }] }
  }
  const r = await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: fake, force: true })
  assert.equal(r.latest, '3.0.0')
  assert.equal(r.updateAvailable, true)
})
await check('更新检查：限流/异常应答 → bad-response（不是 no-release）', async () => {
  resetUpdateCache()
  const limited = async () => ({ ok: false, status: 429, json: async () => ({}) })
  const r = await checkForUpdate({ currentVersion: '1.0.0', repoUrl: REPO_URL, fetchImpl: limited, force: true })
  assert.equal(r.reachable, false)
  assert.equal(r.reason, 'bad-response')
})
await check('更新检查：仓库没有 Release → no-release（正常状态）', async () => {
  resetUpdateCache()
  const empty = async () => ({ ok: false, status: 404, json: async () => [] })
  const r = await checkForUpdate({ currentVersion: '1.0.0', repoUrl: REPO_URL, fetchImpl: empty, force: true })
  assert.equal(r.reachable, false)
  assert.equal(r.reason, 'no-release')
})
await check('更新检查缓存：命中期内不再请求', async () => {
  resetUpdateCache()
  let calls = 0
  const fake = async () => { calls += 1; return { ok: true, json: async () => ({ tag_name: 'v1.9.0' }) } }
  await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: fake, force: true })
  await checkForUpdate({ currentVersion: '1.9.0', repoUrl: REPO_URL, fetchImpl: fake })
  assert.equal(calls, 1, `缓存未生效，请求了 ${calls} 次`)
})
await check('发布包必须自带 package.json（否则版本会变成 0.0.0）', () => {
  // 回归：files 白名单曾漏掉 package.json，make-release 按白名单复制，
  // 结果用户装到的包读不到自己的版本 → VERSION 回落 '0.0.0'，
  // 并把每个真实 Release 都判成"有新版本"。
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('package.json'), 'files 未包含 package.json')
  // VERSION 依赖能读到自己的清单：这里直接验证读取路径成立。
  assert.equal(VERSION, pkg.version)
})
await check('files 白名单不会带上 4K 母版（GitHub 安装少下 57 MB）', () => {
  // 回归：`builtin/**/*` 会把 4K 母版一起分发 —— 从 git 安装是按 files 剪裁的，
  // 所以用户会白下 57 MB 永远不会播的文件。
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const files = pkg.files
  assert.ok(!files.some((f) => f === 'builtin/**/*' || f === 'builtin/**'), 'files 仍用 builtin/**/* 通配')
  // 只检查**视频**条目：`.posters/*`（手工封面图）与视频同目录，但它不是视频。
  const videoPatterns = files.filter((f) => f.includes('builtin/MP4') && f.endsWith('.mp4'))
  assert.ok(videoPatterns.length > 0, 'files 未声明任何 MP4')
  for (const pattern of videoPatterns) {
    assert.ok(pattern.endsWith('.web.mp4'), `MP4 白名单应只含 .web.mp4，实际：${pattern}`)
  }
  // 手工封面目录要随包分发，否则视频卡片没有封面可显示。
  assert.ok(
    files.some((f) => f.includes('builtin/MP4/.posters')),
    'files 缺少 builtin/MP4/.posters（视频手工封面）',
  )
  // 图片/音频分类允许通配（它们没有母版/变体之分）。
  assert.ok(files.includes('builtin/图片/**/*'), '缺少 图片 分类')
  assert.ok(files.includes('builtin/音频/**/*'), '缺少 音频 分类')
})
await check('运行期 import 的文件都在发布白名单里（否则装完就崩）', () => {
  // 回归（v1.11.0）：index.js 新增了 `import ... from './lib/self-manage.mjs'`，
  // 但 files 白名单里没有 lib/ —— 发布包少了这个文件，装完插件直接起不来。
  // 这类问题**只有**在发布目录里才看得出来，所以这里直接按白名单校验：
  // 每个相对 import 的目标都必须被某个 files 图案覆盖。
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const files = pkg.files

  /** 白名单是否覆盖某个包内相对路径。 */
  const covered = (rel) =>
    files.some((pattern) => {
      if (pattern === rel) return true
      if (pattern.endsWith('/**/*')) return rel.startsWith(`${pattern.slice(0, -5)}/`)
      if (pattern.endsWith('/*')) return rel.slice(0, rel.lastIndexOf('/')) === pattern.slice(0, -2)
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
      return new RegExp(`^${escaped}$`).test(rel)
    })

  for (const file of ['index.js', 'client.js', 'lib/self-manage.mjs']) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    const imports = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1])
    for (const spec of imports) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
      assert.ok(covered(resolved), `${file} 导入了 ${spec}，但发布白名单没带上它（装完会崩）`)
    }
  }
  // lib/ 下的运行期模块必须在白名单里。
  assert.ok(files.includes('lib/self-manage.mjs'), 'files 缺少 lib/self-manage.mjs')
})
await check('内置视频必须是 H.264（HEVC 在 Chromium 里解不了 → 黑屏）', () => {
  // 回归：新增内置视频时曾拿到 HEVC/H.265 源文件，那段素材放进包里
  // 只会表现为"启动时黑屏/一帧都不出"，而代码层面一切正常，很难查。
  // 这里直接读 MP4 的 stsd 四字符码，钉死必须是 Chromium 能解的编码。
  const MP4_CODECS_OK = new Set(['avc1', 'avc3', 'hvc1', 'hev1'])
  const dir = new URL('./builtin/MP4/', import.meta.url)
  const variants = fs.readdirSync(dir).filter((n) => n.endsWith('.web.mp4'))
  assert.ok(variants.length > 0, '内置视频目录为空')
  for (const name of variants) {
    const buf = fs.readFileSync(new URL(name, dir))
    // 'stsd' 之后：4 字节 version/flags + 4 字节 entry count + 4 字节 entry size
    // + 4 字节 fourcc（+16 处），与 QuickTime/ISO-BMFF 的 sample entry 布局一致。
    const at = buf.indexOf('stsd')
    assert.ok(at > 0, `${name}: 找不到 stsd box`)
    const codec = buf.toString('latin1', at + 16, at + 20)
    assert.ok(codec === 'avc1' || codec === 'avc3', `${name} 的编码是 ${codec}，必须是 H.264（avc1/avc3）`)
    // faststart：moov 必须在第一个 mdat 之前，否则浏览器要读完整个文件才能起播。
    const moovAt = buf.indexOf('moov')
    const mdatAt = buf.indexOf('mdat')
    assert.ok(moovAt > 0 && moovAt < mdatAt, `${name}: moov 不在 mdat 之前（不是 faststart）`)
  }
})
await check('视频卡片的封面不能固定取首帧（淡入素材会全黑）', () => {
  // 回归：《大肥鱼-欢迎回来》从黑场淡入，t=0.1 平均亮度只有 16（约等于纯黑），
  // 卡片看起来像"素材坏了"。修法是逐帧采样挑最亮的一帧，而不是钉死一个时间点。
  const src = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('pickCoverTime'), '缺少封面挑帧函数')
  assert.ok(src.includes('duration * 0.25') && src.includes('duration * 0.75'), '挑帧候选点不足（应覆盖 25/50/75%）')
  assert.ok(src.includes('getImageData'), '未做亮度采样，无法判断哪一帧更亮')
  assert.ok(src.includes('VideoCover'), '缺少视频封面组件')
  // 图片仍然直接显示，不该被拖进挑帧流程。
  assert.ok(src.includes("if (!isVideo)"), '图片分支缺失')
})
await check('REPO_URL 指向真实仓库（不是占位符）', () => {
  assert.ok(!REPO_URL.includes('CHANGE_ME'), '仓库地址仍是占位符')
  assert.match(REPO_URL, /^https:\/\/github\.com\/[^/]+\/[^/]+$/)
})
await check('UPDATE_ROUTE 已注册到路由清单（静态锚点）', () => {
  const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("export const UPDATE_ROUTE = '/dsh-startup-animation/update'"))
  assert.ok(src.includes('path: UPDATE_ROUTE'), '更新路由未注册')
})
await check('client.js 版本小字（静态锚点）', () => {
  const src = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('useVersionInfo'), '缺少版本 hook')
  assert.ok(src.includes('dsa-set-ver'), '缺少版本小字样式')
  // 回归：t() 不做插值，必须用 .replace。
  assert.ok(src.includes("t('updateNow').replace('{version}'"), '更新按钮文案未做变量替换')
  assert.ok(!src.includes("t('updateNow', {"), '仍在给 t() 传插值参数')
  // 回归：有新版本时版本小字必须变成**就地更新**按钮，而不是跳转 GitHub。
  // 跳转（window.open + releasesUrl）是旧交互，留一条就是一条死路。
  assert.ok(src.includes('onClick: doUpdate'), '版本小字没有接上一键更新')
  assert.ok(!src.includes("window.open(releaseUrl"), '版本小字仍在跳转 Release 页')
  assert.ok(!src.includes('updateAvailable:'), 'updateAvailable 键已无人使用（应删）')
})

await check('cleanupLinkedInstall：只删链接，绝不动真实目录与目标', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-profile-'))
  const nodeModules = path.join(profile, 'node_modules')
  fs.mkdirSync(nodeModules, { recursive: true })
  const linkPath = path.join(nodeModules, 'dsh-plugin-startup-animation')
  const source = path.join(profile, 'source-repo')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'index.js'), '// source\n')

  // 1) 本来就不存在 → 什么都不做，也不算 blocked
  assert.deepEqual(await cleanupLinkedInstall(profile), { removed: false, blocked: false })

  // 2) 真实目录（装好的包）→ 不碰
  fs.mkdirSync(linkPath, { recursive: true })
  fs.writeFileSync(path.join(linkPath, 'index.js'), '// real package\n')
  assert.deepEqual(await cleanupLinkedInstall(profile), { removed: false, blocked: false })
  assert.ok(fs.existsSync(path.join(linkPath, 'index.js')), '真实目录被误删')
  fs.rmSync(linkPath, { recursive: true, force: true })

  // 3) 目录联接 → 删掉链接本身，目标目录原样保留（这次踩的坑）
  fs.symlinkSync(source, linkPath, 'junction')
  assert.deepEqual(await cleanupLinkedInstall(profile), { removed: true, blocked: false })
  assert.ok(!fs.existsSync(linkPath), '联接没删掉')
  assert.ok(fs.existsSync(path.join(source, 'index.js')), '删联接时连带删了目标目录')

  fs.rmSync(profile, { recursive: true, force: true })
})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
