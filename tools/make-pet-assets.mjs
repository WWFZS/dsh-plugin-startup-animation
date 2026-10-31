/**
 * make-pet-assets.mjs —— 把作者的绿幕源片转成宠物要用的透明 webm（开发期工具，不随包发布）。
 *
 * 源片是 1280×720 的绿幕视频，没有 alpha；宠物的三段动作必须是带透明通道的 VP9。
 * 这条链有两个坑，都踩过了，写在这里免得下次重踩：
 *
 * ① **`format=yuva420p` 必须打在链首**。源片带 `ALPHA_MODE=1` 标记，解码出来是有 alpha
 *    平面的（全不透明），chromakey 才有地方写 alpha；中间文件（png/mp4/webm）没这个平面时，
 *    chromakey 的 alpha 会被编码器丢掉 —— 文件里 tag 照样写 `ALPHA_MODE=1`，但 Chrome
 *    渲染出来是黑底。ffprobe 看不出来，只能用浏览器验。
 * ② **脚下那块"地面投影"要单独处理**。chromakey 只抠绿，灰色阴影会跟着人物一起留下，
 *    看上去像宠物站在地上。做法是抠像前把「人物下沿以下 + 低饱和」的像素**染成纯绿**，
 *    让 chromakey 把它当背景一起抠掉 —— 比事后修 alpha 稳得多（geq 会把 alpha 重置）。
 *
 * 用法：node tools/make-pet-assets.mjs [--src <目录>]
 *   默认源目录 D:/不重要测试文件/lulu_pet/webm
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 源文件 → 输出名（动作名）。输出名即运行时契约：显示名、动作 id 都是它。 */
const CLIPS = [
  { src: '01_待机呼吸休闲.webm', out: '待机.webm' },
  { src: '02_点击回应-开心跃动.webm', out: '点击回应.webm' },
  { src: '03_点击回应-害羞捂脸.webm', out: '害羞捂脸.webm' },
  { src: '05_被鼠标拖拽悬空反馈.webm', out: '拖拽悬空.webm' },
  { src: '07_原地踏步.webm', out: '原地踏步.webm' },
  { src: '08_吃橘子小零食.webm', out: '吃橘子.webm' },
  { src: '09_挥手打招呼.webm', out: '挥手打招呼.webm' },
  { src: '06_原地小憩沉眠.webm', out: '原地小憩.webm' },
  { src: '10_泡温泉.webm', out: '泡温泉.webm' },
]

/**
 * 统一裁剪窗口：九段共用，切换动作时人物不会跳位。
 *
 * 宽度只给 480（x 390–870）：人物本体横向跨度 421–822，两边各留 30 余量刚好。
 * 试过放宽到 560 去装"小憩"的 Zzz 和"吃橘子"飞出去的果皮，代价是同尺寸下角色
 * 小 17%（角色在画布里只占 64%）—— 宠物本来就只有一百多像素，这个代价不值。
 * Zzz 主体落在 830 以内，尾巴被裁一点点，看不出来。
 *
 * 高度给到 648：泡温泉的木桶底到 643，640 会切掉桶底。
 * 宽高比 480:648 要和 client.js 的 `PET_ASPECT` 保持一致。
 */
const CROP = 'crop=480:648:390:0'
/** 阴影开始的行（脚底 612、`待机` 短裤下沿 534；596 是脚底上方一点）。 */
const SHADOW_Y = 596
/** 饱和度的上限：低于它算"灰"，会被当成阴影染绿。角色是橙色（sat≈190），白短裤（sat≈10，但在 596 以上）。 */
const SAT_MAX = 90
/** 绿幕抠像参数：容差比默认宽一些，用来吃掉阴影被染绿后的边缘过渡色。 */
const CHROMAKEY = 'chromakey=0x00ff00:0.22:0.10'
const DESPILL = 'despill=type=green:mix=0.5:expand=0'

const srcDir = (() => {
  const at = process.argv.indexOf('--src')
  return at >= 0 ? process.argv[at + 1] : 'D:/不重要测试文件/lulu_pet/webm'
})()

/** geq 表达式：把「Y≥SHADOW_Y 且 低饱和」的像素写成纯绿，其余原样。 */
function shadowPainter() {
  const R = 'r(X,Y)'
  const G = 'g(X,Y)'
  const B = 'b(X,Y)'
  const sat = `max(max(${R},${G}),${B})-min(min(${R},${G}),${B})`
  const cond = `gte(Y,${SHADOW_Y})*lt(${sat},${SAT_MAX})`
  return `geq=r='if(${cond},0,${R})':g='if(${cond},255,${G})':b='if(${cond},0,${B})'`
}

const vf = [CROP, 'format=yuva420p', shadowPainter(), CHROMAKEY, DESPILL].join(',')

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'inherit' })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))))
  })

const outDir = 'builtin/宠物'
fs.mkdirSync(outDir, { recursive: true })

for (const clip of CLIPS) {
  const src = path.join(srcDir, clip.src)
  const out = path.join(outDir, clip.out)
  if (!fs.existsSync(src)) {
    console.error(`跳过（源文件不存在）：${src}`)
    continue
  }
  process.stdout.write(`→ ${clip.out} … `)
  await run([
    '-v', 'error',
    '-i', src,
    '-vf', vf,
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', '32',
    '-row-mt', '1', '-cpu-used', '2',
    '-an', '-y', out,
  ])
  const size = fs.statSync(out).size
  console.log(`${(size / 1024).toFixed(0)} KB`)
}
