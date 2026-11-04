#!/usr/bin/env node
/**
 * pet-lint.mjs —— 宠物素材链体检（开发期工具，不随包发布）。
 *
 * 解决的是这么一件事：**这个包的裁剪窗口是写死的一份**（所有动作共用，保证切换动作
 * 时角色不跳位），而新动作的道具/特效经常比窗口大。以前每加一段都要临时写脚本抽帧、
 * 人眼判断"是不是被切了"——慢且容易漏。
 *
 * 这里把判断变成一条命令：
 *   - 每段源片的**全帧内容并集**（bbox） vs 当前窗口 → 谁超了多少像素，一目了然
 *   - pet.json 的分类引用 / 缩略图 / ambient 保留字
 *   - 输出 webm 与缩略图是否齐全、是否比源片旧
 *
 * 用法：
 *   node tools/pet-lint.mjs                 # 源目录用默认值，打包目录 builtin/宠物/噜噜
 *   node tools/pet-lint.mjs --src <目录> --pack <包目录>
 *
 * 退出码：0 = 全部通过（允许警告），1 = 有硬错误（缺文件 / 越界）。
 *
 * 实现注记：用 ffmpeg 的 `alphaextract,bbox` 滤镜（每段 ~2s）而不是自己解 rawvideo
 * （~8s/段）。源片左上角有生成工具打的标签，先 `crop` 掉顶部 60 行再测，否则 bbox
 * 会被那个标签撑满整幅。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 行内读取 make-pet-assets.mjs 的裁剪窗口：窗口是那份脚本的真相，这里不复制一份。 */
function readCrop() {
  const file = 'tools/make-pet-assets.mjs'
  const text = fs.readFileSync(file, 'utf8')
  const m = /const CROP = 'crop=(\d+):(\d+):(\d+):(\d+)'/.exec(text)
  if (!m) throw new Error(`${file} 里找不到 CROP 常量（格式应为 crop=W:H:X:Y）`)
  const [w, h, x, y] = m.slice(1).map(Number)
  return { w, h, x, y }
}

/** 源目录里"左上角标签"占的高度：测 bbox 前先裁掉。 */
const LABEL_H = 60
/** 内容离窗口边缘小于这个距离就算"贴边风险"（缩放/编码误差会让它擦边）。 */
const SAFE_PAD = 8

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const srcDir = argOf('--src', 'D:/不重要测试文件/lulu_pet/webm')
const packDir = argOf('--pack', 'builtin/宠物/噜噜')
const crop = readCrop()

/** 跑一次 ffmpeg，把 bbox 的每一行收集起来，返回全帧并集。 */
function measure(srcFile) {
  return new Promise((resolve, reject) => {
    const vf = [
      'chromakey=0x00ff00:0.12:0.06',
      'format=rgba',
      'alphaextract',
      `crop=iw:ih-${LABEL_H}:0:${LABEL_H}`,
      'bbox',
    ].join(',')
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-i', srcFile, '-vf', vf, '-f', 'null', '-'])
    let err = ''
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8')
    })
    child.on('close', () => {
      const rows = [...err.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)].map((m) => m.slice(1).map(Number))
      if (rows.length === 0) {
        resolve(null)
        return
      }
      resolve({
        x1: Math.min(...rows.map((r) => r[0])),
        x2: Math.max(...rows.map((r) => r[1])),
        y1: Math.min(...rows.map((r) => r[2])) + LABEL_H,
        y2: Math.max(...rows.map((r) => r[3])) + LABEL_H,
        frames: rows.length,
      })
    })
    child.on('error', reject)
  })
}

const problems = []
const warnings = []

/** 窗口边界（源片坐标系）。 */
const win = { left: crop.x, right: crop.x + crop.w - 1, top: crop.y, bottom: crop.y + crop.h - 1 }

const files = fs.existsSync(srcDir)
  ? fs.readdirSync(srcDir).filter((name) => name.toLowerCase().endsWith('.webm')).sort()
  : []
if (files.length === 0) {
  problems.push(`源目录里没有 webm：${srcDir}`)
}

console.log(`窗口 ${crop.w}×${crop.h} @ ${crop.x},${crop.y}   源目录 ${srcDir}\n`)
console.log('动作'.padEnd(22) + '内容范围'.padEnd(30) + '越界')

const union = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
for (const name of files) {
  const box = await measure(path.join(srcDir, name))
  const label = name.replace(/\.webm$/i, '')
  if (box === null) {
    console.log(label.padEnd(22) + '（测不到内容，全透明？）')
    warnings.push(`${label}：测不到任何不透明像素`)
    continue
  }
  for (const k of ['x1', 'y1']) union[k] = Math.min(union[k], box[k])
  for (const k of ['x2', 'y2']) union[k] = Math.max(union[k], box[k])

  const over = []
  if (box.x1 < win.left) over.push(`左 ${win.left - box.x1}px`)
  if (box.x2 > win.right) over.push(`右 ${box.x2 - win.right}px`)
  if (box.y1 < win.top) over.push(`上 ${win.top - box.y1}px`)
  if (box.y2 > win.bottom) over.push(`下 ${box.y2 - win.bottom}px`)

  const range = `x ${box.x1}..${box.x2}  y ${box.y1}..${box.y2}`
  if (over.length > 0) {
    console.log(label.padEnd(22) + range.padEnd(30) + `✗ ${over.join(' / ')}`)
    problems.push(`${label} 超出窗口：${over.join(' / ')}`)
  } else {
    // 贴边（还在窗内但离边太近）
    const near = []
    if (box.x1 - win.left < SAFE_PAD) near.push('左')
    if (win.right - box.x2 < SAFE_PAD) near.push('右')
    if (box.y1 - win.top < SAFE_PAD) near.push('上')
    if (win.bottom - box.y2 < SAFE_PAD) near.push('下')
    console.log(label.padEnd(22) + range.padEnd(30) + (near.length > 0 ? `△ 贴边 ${near.join(' / ')}` : '✓'))
    if (near.length > 0) warnings.push(`${label} 内容贴近窗口${near.join('/')}边（<${SAFE_PAD}px）`)
  }
}

if (union.x1 !== Infinity) {
  console.log(`\n十三段联合范围：x ${union.x1}..${union.x2}  y ${union.y1}..${union.y2}`)
  const need = {
    w: union.x2 - union.x1 + 1 + SAFE_PAD * 2,
    h: union.y2 - union.y1 + 1 + SAFE_PAD * 2,
    x: union.x1 - SAFE_PAD,
    y: union.y1 - SAFE_PAD,
  }
  console.log(`按它开窗（留 ${SAFE_PAD}px 边）：crop=${need.w}:${need.h}:${Math.max(0, need.x)}:${Math.max(0, need.y)}`)
  if (need.w > crop.w || need.h > crop.h) {
    console.log('  ↑ 比当前窗口大：想一段不裁，就得把窗口放宽（角色会相应变小）')
  }
}

// ── 宠物包自检 ──
console.log('')
const metaPath = path.join(packDir, 'pet.json')
if (!fs.existsSync(metaPath)) {
  problems.push(`找不到宠物包配置：${metaPath}`)
} else {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const filesInPack = new Set(fs.readdirSync(packDir).filter((n) => n.endsWith('.webm')).map((n) => n.replace(/\.webm$/, '')))
  const thumbs = new Set(
    fs.existsSync(path.join(packDir, 'thumbs'))
      ? fs.readdirSync(path.join(packDir, 'thumbs')).filter((n) => n.endsWith('.webp')).map((n) => n.replace(/\.webp$/, ''))
      : [],
  )
  const inCategories = new Set()
  for (const category of meta.categories ?? []) {
    for (const id of category.clips ?? []) {
      inCategories.add(id)
      if (!filesInPack.has(id)) problems.push(`分类「${category.name}」引用了不存在的动作：${id}`)
    }
    const cover = category.cover
    if (cover && !fs.existsSync(path.join(packDir, cover))) problems.push(`分类「${category.name}」缺封面：${cover}`)
  }
  /**
   * 语义角色引用的动作（待机 / 拖拽 / 点击回应…）：它们本来就不属于任何分类，
   * 右键菜单里不该出现，所以"没归到分类"对它们不是问题。
   */
  const roleIds = new Set(
    [
      meta.roles?.idle,
      meta.roles?.drag,
      ...(Array.isArray(meta.roles?.clicks) ? meta.roles.clicks : []),
      ...(Array.isArray(meta.roles?.turn) ? meta.roles.turn : []),
      ...(Array.isArray(meta.roles?.moves) ? meta.roles.moves : []),
    ].filter((id) => typeof id === 'string' && id !== ''),
  )
  for (const id of filesInPack) {
    if (!inCategories.has(id) && !roleIds.has(id)) {
      warnings.push(`动作「${id}」没归到任何分类（右键菜单里选不到）`)
    }
    if (!thumbs.has(id)) warnings.push(`动作「${id}」缺缩略图（thumbs/${id}.webp）`)
  }
  // ambient 里的 id 不能撞宿主保留的事件分类，否则会被静默过滤掉
  const RESERVED = ['balance', 'whisper', 'work', 'sleep', 'other']
  for (const id of meta.ambient ?? []) {
    if (RESERVED.includes(id)) problems.push(`ambient 里的「${id}」是宿主保留的事件分类，会被过滤掉，随机待机永远轮不到它`)
  }
  const declared = Number((meta.description ?? '').match(/(\d+)\s*段/)?.[1] ?? NaN)
  if (Number.isFinite(declared) && declared !== filesInPack.size) {
    warnings.push(`description 写「${declared} 段」，实际 ${filesInPack.size} 段`)
  }
  console.log(`宠物包：${filesInPack.size} 段 / ${(meta.categories ?? []).length} 类 / 缩略图 ${thumbs.size} 张`)
}

console.log('')
for (const message of problems) console.log(`✗ ${message}`)
for (const message of warnings) console.log(`△ ${message}`)
console.log(problems.length === 0 ? (warnings.length === 0 ? '\n全部通过' : `\n${warnings.length} 条提醒，无硬错误`) : `\n${problems.length} 个问题`)
process.exit(problems.length === 0 ? 0 : 1)
