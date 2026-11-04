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
 *   默认源目录 tools/pet-src/lulu（仓库内，13 MB）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 源文件 → 输出名（动作名）。输出名即运行时契约：显示名、动作 id 都是它。 */
const CLIPS = [
  { src: '01_待机呼吸休闲.webm', out: '待机.webm', footY: 596 },
  { src: '02_点击回应-开心跃动.webm', out: '点击回应.webm' },
  { src: '03_点击回应-害羞捂脸.webm', out: '害羞捂脸.webm' },
  { src: '05_被鼠标拖拽悬空反馈.webm', out: '拖拽悬空.webm' },
  { src: '07_原地踏步.webm', out: '原地踏步.webm' },
  { src: '08_吃橘子小零食.webm', out: '吃橘子.webm' },
  { src: '09_挥手打招呼.webm', out: '挥手打招呼.webm' },
  { src: '06_原地小憩沉眠.webm', out: '原地小憩.webm' },
  { src: '10_泡温泉.webm', out: '泡温泉.webm' },
  { src: '11_工作玩笔记本电脑.webm', out: '玩电脑.webm' },
  { src: '12_换上圣诞主题皮肤.webm', out: '圣诞换装.webm' },
  { src: '13_收红包.webm', out: '收红包.webm' },
  { src: '14_堆雪人.webm', out: '堆雪人.webm' },
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
/** alphaKiller 比 SHADOW_Y 高一行起算：y595 那行经 despill 中和后同样满足灰白判据，
 *  卡 596 会给它留一条 1px 的白虚线尾巴。 */
const KILL_Y = 595
/** 饱和度的上限：低于它算"灰"，会被当成阴影染绿。角色是橙色（sat≈190），白短裤（sat≈10，但在 596 以上）。 */
const SAT_MAX = 90
/** 绿幕抠像参数：容差比默认宽一些，用来吃掉阴影被染绿后的边缘过渡色。
 *
 *  **不要为了"抠干净脚下的暗绿幕"把 similarity 调大**（试过 0.30）：容差一宽，角色
 *  边缘的抗锯齿像素也被判绿，整只宠物 alpha 掉到 0.7 左右，看上去整体发暗 —— 这个
 *  副作用比脚下一圈残影严重得多。暗绿幕残留只能靠底色修，见 shadowPainter。 */
const CHROMAKEY = 'chromakey=0x00ff00:0.22:0.10'
const DESPILL = 'despill=type=green:mix=0.5:expand=0'

/**
 * 源片目录。
 *
 * 默认就是仓库里的 `tools/pet-src/lulu/` —— 源片一共 13 MB（1280×720 VP9，单段 ~1 MB），
 * 放仓库里比放在外面某个"测试文件"目录靠谱：换机器、重装、协作者都能直接跑转码，
 * 不必再问"素材在哪"。`tools/` 不在 package.json 的 files 里，所以不会被打进 npm 包。
 *
 * 想用别的目录：`--src <目录>`。
 */
const srcDir = (() => {
  const at = process.argv.indexOf('--src')
  return at >= 0 ? process.argv[at + 1] : 'tools/pet-src/lulu'
})()

/** geq 表达式：把「Y≥SHADOW_Y 且 低饱和 且 明显偏绿」的像素写成纯绿，其余原样。
 *
 *  两条边界条件都是踩出来的：
 *  - `gt(G-R,12)` 而不是 `lte(R,G)`：白色/灰色的道具（比如"玩电脑"的笔记本）R≈G，
 *    用 `lte(R,G)` 会把它们一并当成地面投影染绿抠掉，道具就"缺一块"。
 *  - 木桶箍是深棕色（sat≈55，R 最大），`G-R` 为负，同样不会被误伤。
 *  - **`gte(G,B)` 不能省**：雪是"亮白偏蓝"（rgb≈203,216,244，B 最大），它的 `G-R` 也有
 *    13 左右，光靠 `G-R>12` 会被当投影染绿 —— 表现就是"堆雪人的雪堆下半截被吃掉，
 *    只剩一排灰白碎片"。绿幕上的阴影一定是绿调（G 最大），雪的 B 一定压过 G，这条能分开。
 *  绿幕上的阴影始终是绿的，G 比 R 高出 20–40，卡 12 够分辨。
 *
 * ③ **`待机` 段单独多染一条「暖白投影带」**。只有这一段，脚下有一条灰白/暖白投影
 *    （y596–608，两脚之间和两侧，R≥G、B 接近 G），`G-R>12` 完全抓不到（它是负的），
 *    `G-R>4` 也不命中 —— 上一轮就是这么失败的。补的条件是 `Y≥SHADOW_Y 且低饱和 且
 *    R≥G 且 B≥G-30`：橙色脚底（sat 130+）不满足低饱和；白短裤在 y596 以上够不着；
 *    其他段画面下部有笔记本、木桶箍（都是 R≥G 的暖灰），不能加这条，所以只挂在待机。
 *
 * ④ **`待机` 段的 sat 上限单独放宽**。这段脚下有一整条偏暗黄的绿幕（rgb≈153,234,131，
 *    sat 101-109），被 SAT_MAX=90 挡在染绿条件外，chromakey 0.22 又抠不净它 —— 深色
 *    背景下就是一条扎眼的白色虚线横带。放宽到 130 能盖住它；橙色本体 sat 130+ 不命中。
 *    （不能靠调大 chromakey similarity 解决：试过 0.30，角色边缘抗锯齿像素全部变半透，
 *    整只宠物发暗 —— 见 CHROMAKEY 注释。） */
function shadowPainter(footY) {
  const R = 'r(X,Y)'
  const G = 'g(X,Y)'
  const B = 'b(X,Y)'
  const sat = `max(max(${R},${G}),${B})-min(min(${R},${G}),${B})`
  const green = `gte(Y,${SHADOW_Y})*lt(${sat},${footY ? 130 : SAT_MAX})*gt(${G}-${R},12)*gte(${G},${B})`
  const warm = `+gte(Y,${SHADOW_Y})*lt(${sat},${SAT_MAX})*(gte(${B},${G}-30)*between(${G}-${R},-40,12)+between(${G}-${R},4,60))`
  const cond = green + (footY ? warm : '')
  return `geq=r='if(${cond},0,${R})':g='if(${cond},255,${G})':b='if(${cond},0,${B})'`
}

/** 待机段专用：chromakey/despill **之后**再跑一遍 alpha 清零。
 *
 *  前置的 shadowPainter 只染绿（让 chromakey 把它当背景），但 chromakey 0.22 对那条
 *  偏暗黄的绿幕（rgb≈153,234,131）抠不干净、despill 又把边缘洗成中性灰白，深色背景
 *  下仍是一条白色虚线。在链尾按同样判据把 alpha 直接清零才是真正拿掉。
 *  注意 geq 挪到链尾时输入已是 yuva420p 后的 rgba——色阶对得上（format=rgba 保证）。 */
function alphaKiller(footY) {
  if (!footY) return null
  const R = 'r(X,Y)'
  const G = 'g(X,Y)'
  const B = 'b(X,Y)'
  const sat = `max(max(${R},${G}),${B})-min(min(${R},${G}),${B})`
  const green = `gte(Y,${KILL_Y})*lt(${sat},130)*gt(${G}-${R},12)`
  const warm = `+gte(Y,${KILL_Y})*lt(${sat},${SAT_MAX})*(gte(${B},${G}-30)*between(${G}-${R},-40,12)+between(${G}-${R},4,60))`
  return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${green}${warm},0,alpha(X,Y))'`
}

/**
 * 滤镜链。
 *
 * **geq 前后必须夹一层 rgba**：yuva420p 是有限范围（16–235），在那里直接按 0–255
 * 读写 RGB 会被当成 full range，整帧被拉亮 —— 表现就是"脸发光、眼睛发白"。
 * 转成 rgba（full range）再 geq，色阶才对得上；算完再转回 yuva420p 走抠像编码。
 */
const vfFor = (clip) => {
  const chain = [CROP, 'format=rgba', shadowPainter(clip.footY), 'format=yuva420p',
    CHROMAKEY, DESPILL]
  const killer = alphaKiller(clip.footY)
  if (killer) chain.push('format=rgba', killer)
  return chain.join(',')
}

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'inherit' })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))))
  })

const only = (() => {
  const at = process.argv.indexOf('--only')
  return at >= 0 ? process.argv[at + 1] : ''
})()

const outDir = 'builtin/宠物/噜噜'
fs.mkdirSync(outDir, { recursive: true })

for (const clip of CLIPS) {
  if (only && !clip.out.startsWith(only)) continue
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
    '-vf', vfFor(clip),
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', '32',
    '-row-mt', '1', '-cpu-used', '2',
    '-an', '-y', out,
  ])
  const size = fs.statSync(out).size
  console.log(`${(size / 1024).toFixed(0)} KB`)
}
