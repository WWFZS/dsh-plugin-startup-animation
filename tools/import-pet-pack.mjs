/**
 * import-pet-pack.mjs —— 把一包 dsh-pet 素材（manifest.json + webm/）转成我们的宠物包。
 * 开发期工具，不随包发布。
 *
 * dsh-pet 的原片是 640×360、10 秒、VP9-alpha；109 段共 52.7MB，直接塞进安装包太重，
 * 而且角色只占画布中间一小块。这里做两件事：
 *
 * ① 裁成 360×360：109 段的角色本体并集是 x≈199–442、y≈60–331，取 x 140–500 留边，
 *    上限到 500 会切掉少数全屏特效的左右边缘（放烟花、蝴蝶蜜蜂环绕），角色始终完整。
 * ② 压到 90k 码率：单遍 CRF 32–40 反而比原片更大（590–749KB），因为暗部噪点和 alpha
 *    边缘很吃码率；改成限码率 `-b:v 90k -crf 47` 后每段约 200–250KB，176px 显示下
 *    与原片无差别（对比过 2× 放大帧）。109 段合计约 24MB。
 *
 * 用法：node tools/import-pet-pack.mjs --src <dsh-pet-maid 目录> --out builtin/宠物/女仆
 *       [--id maid] [--name 女仆]
 * 已存在的输出会跳过，中断后重跑即可续传。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const CROP = 'crop=360:360:140:0'
const BITRATE = '90k'
const CRF = '47'
const COVER_SIZE = 240

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : fallback
}

const srcDir = path.resolve(arg('src', 'D:/不重要测试文件/pet_assets/dsh-pet-maid'))
const outDir = path.resolve(arg('out', 'builtin/宠物/女仆'))
const packId = arg('id', 'maid')
const packName = arg('name', '女仆')
/** 只保留 N 段（0 = 全要）。角色动作（待机/拖拽/点击/转向/走动）永远保留。 */
const limit = Number(arg('limit', '0')) || 0

/** slots 里的分类键 → pet.json 的分类（id 用 ascii，name 给界面）。顺序即界面顺序。 */
const CATEGORIES = [
  { slot: 'categories.小动作', id: 'small', name: '小动作' },
  { slot: 'clicks', id: 'click', name: '点击回应' },
  { slot: 'moves', id: 'move', name: '走动' },
  { slot: 'categories.玩耍', id: 'play', name: '玩耍' },
  { slot: 'categories.吃什么', id: 'food', name: '吃什么' },
  { slot: 'categories.时节', id: 'season', name: '时节' },
  { slot: 'categories.文字', id: 'text', name: '文字' },
  { slot: 'events.balance', id: 'balance', name: '余额' },
  { slot: 'events.whisper', id: 'whisper', name: '碎碎念' },
  { slot: 'events.workStatus', id: 'work', name: '工作状态' },
]
/** 睡觉是 start/loop/end 三段，合成一张卡。 */
const SLEEP = { id: 'sleep', name: '睡觉', slots: ['sleep.0.start', 'sleep.0.loop', 'sleep.0.end'] }
/** 参与"随机待机"的分类：事件类（余额/工作状态/睡觉）不随机，免得莫名其妙掏钱袋。 */
const AMBIENT = ['small', 'play', 'food', 'season', 'text']

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}：${args.at(-1)}`))))
  })

const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'))
const byName = new Map(manifest.animations.map((a) => [a.name, a]))
const slotNames = (slot) =>
  manifest.animations.filter((a) => a.slots.includes(slot)).map((a) => a.name)
const bySlot = (slot) => {
  const hit = manifest.animations.find((a) => a.slots.includes(slot))
  return hit ? hit.name : ''
}

fs.mkdirSync(outDir, { recursive: true })

/**
 * 选哪些段：角色动作（待机/拖拽/点击/转向/走动）先占位，其余按 manifest 顺序补到 limit。
 *
 * 为什么不直接切前 N 段：manifest 是按名字排序的，前 55 段里没有待机、拖拽和点击回应
 * （它们排在「待」「被」「点」），照切会让宠物没有待机循环、点它也没反应。
 */
const roleNames = new Set(
  [bySlot('idle'), bySlot('drag'), ...slotNames('turn'), ...slotNames('clicks'), ...slotNames('moves')].filter(Boolean),
)
const ordered = manifest.animations.map((a) => a.name)
let clips = ordered
if (limit > 0 && limit < ordered.length) {
  const keep = new Set(roleNames)
  for (const name of ordered) {
    if (keep.size >= limit) break
    keep.add(name)
  }
  clips = ordered.filter((name) => keep.has(name))
}

// 上一次导出的旧素材（比如之前是全 109 段）要清掉，否则包会带着没被 pet.json 引用的文件。
for (const file of fs.readdirSync(outDir)) {
  if (!file.endsWith('.webm')) continue
  if (clips.includes(file.slice(0, -'.webm'.length))) continue
  fs.rmSync(path.join(outDir, file))
}

const targets = clips.map((name) => ({
  name,
  src: path.join(srcDir, byName.get(name).file),
  out: path.join(outDir, `${name}.webm`),
}))

const chosen = new Set(clips)
/** 只留选中段；分类里没选中的不展示，也不留空卡。 */
const slotClips = (slot) => slotNames(slot).filter((name) => chosen.has(name))

let done = 0
for (const t of targets) {
  done += 1
  if (fs.existsSync(t.out) && fs.statSync(t.out).size > 0) continue
  process.stdout.write(`[${done}/${targets.length}] ${t.name} … `)
  await run([
    '-v', 'error',
    '-c:v', 'libvpx-vp9',
    '-i', t.src,
    '-vf', CROP,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-b:v', BITRATE, '-crf', CRF,
    '-row-mt', '1', '-cpu-used', '3',
    '-an', '-y', t.out,
  ])
  console.log(`${(fs.statSync(t.out).size / 1024).toFixed(0)} KB`)
}

/** 从成片抽一帧做封面（webp 带 alpha，240×240）。 */
async function cover(clipName, file) {
  const out = path.join(outDir, file)
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return
  const src = path.join(outDir, `${clipName}.webm`)
  if (!fs.existsSync(src)) return
  await run([
    '-v', 'error',
    '-c:v', 'libvpx-vp9', '-ss', '3', '-i', src,
    '-frames:v', '1',
    '-vf', `scale=${COVER_SIZE}:${COVER_SIZE}:flags=lanczos`,
    '-c:v', 'libwebp', '-quality', '82',
    '-y', out,
  ])
}

await cover(bySlot('idle') || clips[0], 'cover.webp')
const categories = []
for (const c of CATEGORIES) {
  const list = slotClips(c.slot)
  if (!list.length) continue
  await cover(list[0], `cat-${c.id}.webp`)
  categories.push({ id: c.id, name: c.name, cover: `cat-${c.id}.webp`, clips: list })
}
const sleep = SLEEP.slots.flatMap(slotClips)
if (sleep.length) {
  await cover(sleep[0], `cat-${SLEEP.id}.webp`)
  categories.push({ id: SLEEP.id, name: SLEEP.name, cover: `cat-${SLEEP.id}.webp`, clips: sleep })
}

// manifest 里没归类的文件也要能被点播：待机/转向/拖拽这几个"角色动作"归进「小动作」，
// 剩下的真归不了类的才放「其他」—— 否则每个包都会多出一张杂项卡。
const referenced = new Set(categories.flatMap((c) => c.clips))
const extras = clips.filter((name) => !referenced.has(name))
if (extras.length) {
  const small = categories.find((c) => c.id === 'small')
  if (small) small.clips.push(...extras)
  else {
    await cover(extras[0], 'cat-other.webp')
    categories.push({ id: 'other', name: '其他', cover: 'cat-other.webp', clips: extras })
  }
}

// 换过分类后可能留下没人引用的 cat-*.webp，顺手清掉。
const usedCovers = new Set(categories.map((c) => c.cover))
for (const file of fs.readdirSync(outDir)) {
  if (file.startsWith('cat-') && file.endsWith('.webp') && !usedCovers.has(file)) {
    fs.rmSync(path.join(outDir, file))
  }
}

const pet = {
  id: packId,
  name: packName,
  description: `蓝发小女仆，${clips.length} 段动作`,
  credit: {
    author: 'PC2005-cloud',
    name: 'dsh-pet',
    url: 'https://github.com/PC2005-cloud/dsh-pet',
    license: 'CC BY-NC-SA 4.0',
  },
  canvas: [360, 360],
  cover: 'cover.webp',
  roles: {
    idle: bySlot('idle'),
    turn: slotClips('turn'),
    drag: bySlot('drag'),
    clicks: slotClips('clicks'),
    moves: slotClips('moves'),
  },
  ambient: AMBIENT,
  categories,
  clips,
}
fs.writeFileSync(path.join(outDir, 'pet.json'), `${JSON.stringify(pet, null, 2)}\n`)
const total = clips.reduce((sum, name) => sum + fs.statSync(path.join(outDir, `${name}.webm`)).size, 0)
console.log(`\n${clips.length} 段 / ${(total / 1048576).toFixed(1)} MB / ${categories.length} 个分类 → ${path.relative(process.cwd(), outDir)}`)
