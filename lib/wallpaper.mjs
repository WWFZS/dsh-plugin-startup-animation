/**
 * 壁纸主题的**纯决策层**：给一个画面（图/视频帧/取色样本），算出"文字要怎么配色、
 * 壁纸上面那层幕要压多厚、面板要不要变实"，以及出厂预设表。
 *
 * 为什么单独成文件：
 * - 这里全是纯函数，不碰 DOM、不碰网络、不认识 DSH —— 所以能在 node 里直接单测
 *   （`node lib/wallpaper-test.mjs`），也能被宿主与浏览器两边共用。
 * - "字看不看得清"必须可复算。用户换一张壁纸时，结论应该是算出来的，而不是
 *   让人去拖一根滑杆碰运气。
 *
 * 三件套（顺序不能反）：
 *   1. `analyzePixels` / `analyzeColors`  → 画面摘要（平均色、亮度、暗部占比、分散度）
 *   2. `decideTheme`                      → 决定"字用亮色还是暗色"+ 需要的幕浓度
 *   3. `deriveTokens`                     → 把决定翻成一组 CSS 变量值，交给渲染层落地
 *
 * 关于字体的边界：这些函数**从不产生**字号、字族、行高。文字的"大小与形状"归用户
 * （DSH 的 ui-theme 里有独立设置），壁纸只允许影响**颜色**与壁纸自己那层的遮罩。
 */

// ─────────────────────────────────────────────── 常量 ───────────────────────────────────────────────

/** WCAG 2.x 正文对比度下限。 */
export const CONTRAST_BODY = 4.5
/** 大字号/次要文字的下限。 */
export const CONTRAST_LARGE = 3
/** 菜单、输入框这类"薄底"界面元素的下限 —— 它保的是**底**，不是字。 */
export const CONTRAST_SURFACE = 3

/**
 * 浅色字 / 深色字两套基准。用接近纯黑的 `#111` 而不是 `#000`：纯黑落在壁纸的深色区
 * 会像一块洞，`#111` 观感更接近"墨水"。
 */
export const INK = Object.freeze({ light: '#ffffff', dark: '#111111' })

/**
 * 玻璃面的**可读性下限**（这一套观感的命根子）。
 *
 * 面板不再是"不透明实色块"，而是「玻璃色 @ 透明度 + 背景模糊」——壁纸被模糊后透上来。
 * 透明度一高，壁纸上最亮/最暗的那块像素就会顶穿文字。夹透明度救不了：
 *
 * - 深色主题下玻璃是**白色釉面**，叠在最亮的壁纸像素上，无论多小的 alpha 都会合成到白，
 *   白字恒为 1.00:1；
 * - 浅色主题下夹 alpha 得夹到 0.44，高于滑杆能到的任何值，滑杆会被压死。
 *
 * 所以下限是**另外压一层固定的主题底色**，权重不归任何滑杆管：
 *
 *     有效覆盖 = floor + a×(1−floor) ≥ floor
 *
 * 数值来自实测网格（玻璃透明度 {0,15,30,45,60} × 主题 × 背景），取最坏底色算到 ≥4.5:1：
 * 浅色侧精确解 0.44194 → 0.45，深色侧 0.58136 → 0.59。
 * 这两条与参考实现（dsh-wallpaper-engine）的 READABILITY_FLOOR 同源。
 */
export const READABILITY_FLOOR = 0.45
export const READABILITY_FLOOR_DARK = 0.59

/** 玻璃层之上那层"地板"的色：浅色主题压白、深色主题压黑 —— 永远站在字色那一侧。 */
export const FLOOR_BASE = Object.freeze({ light: '#ffffff', dark: '#0b0d12' })

/**
 * 三列（侧栏 / 会话区 / 底栏）的不透明度下限。
 *
 * 再低就不是"玻璃"而是"没有"了：壁纸直接扎在字后面，任何前景色都救不回来。
 * 参考实现里 `sidebarFullClear` 这类"全透明"档也是要用户自己开的危险开关，
 * 这里干脆不给那扇门 —— 观感靠预设与模糊去调，不靠把面板做没。
 */
const WALL_ALPHA_MIN = 0.35

/**
 * 出厂预设。除了幕（`scrim`）、壁纸模糊（`blur`）、色彩浓度（`saturate`），
 * 每个预设还带一套**玻璃配方**，这正是"七套预设看起来完全不一样"的来源：
 *
 * - `glassTint`   玻璃面的色（面板/卡片/菜单/气泡都染它）
 * - `glassAlpha`  玻璃面的不透明度 0–1
 * - `surfaceBlur` 面板背后那层的模糊半径（px）—— 越大越像磨砂玻璃
 * - `text`        字色策略：`auto` 跟着画面算 / `light`/`dark` 强制 / `keep` 不碰
 * - `accent`      强调色（按钮、链接、选中态）
 *
 * `scrim` 是**下限**：算出来需要更厚的幕时取更厚的那个。观感与可读性在这一层不冲突 ——
 * 因为最后还有 FLOOR 兜底。
 */
export const PRESETS = Object.freeze([
  { id: 'readable', name: '可读优先', scrim: 0.25, blur: 0, saturate: 1, glassTint: '#ffffff', glassAlpha: 0.4, surfaceBlur: 24, accent: '#4f8cff', text: 'auto', surface: 'solid', desc: '白釉玻璃，正文优先' },
  { id: 'frosted', name: '重磨砂', scrim: 0.25, blur: 0, saturate: 1, glassTint: '#ffffff', glassAlpha: 0.45, surfaceBlur: 36, accent: '#4f8cff', text: 'auto', surface: 'solid', desc: '大半径磨砂，动态也稳' },
  { id: 'night', name: '暗夜釉色', scrim: 0.25, blur: 0, saturate: 1, glassTint: '#0d1524', glassAlpha: 0.6, surfaceBlur: 22, accent: '#4f8cff', text: 'light', surface: 'solid', desc: '深蓝釉面，夜景' },
  { id: 'vivid', name: '原色直出', scrim: 0.25, blur: 0, saturate: 1, glassTint: '#67dce7', glassAlpha: 0.5, surfaceBlur: 18, accent: '#4f8cff', text: 'auto', surface: 'solid', desc: '青色玻璃，壁纸颜色不被压' },
  { id: 'author', name: '作者自用', scrim: 0.5, blur: 0, saturate: 1, glassTint: '#0d1524', glassAlpha: 0.4, surfaceBlur: 9, accent: '#67dce7', text: 'light', surface: 'solid', desc: '壁纸压一半，面板薄' },
  { id: 'hacker', name: '黑客绿(Fish)', scrim: 0.6, blur: 0, saturate: 1, glassTint: '#266d3c', glassAlpha: 0.8, surfaceBlur: 9, accent: '#00c800', text: 'light', surface: 'solid', desc: '终端绿，几乎不透' },
  { id: 'violet', name: '紫色心情', scrim: 0.5, blur: 0, saturate: 1, glassTint: '#533b78', glassAlpha: 0.8, surfaceBlur: 9, accent: '#b388ff', text: 'light', surface: 'solid', desc: '紫釉玻璃，几乎不透' },
])

/** 默认预设 id：装上就有合理观感，不逼用户先选一套。 */
export const DEFAULT_PRESET_ID = 'readable'

/** 用户改动过的安全区间（服务端也用这几个数夹取，两边一致）。 */
export const SCREEN_LIMITS = Object.freeze({
  scrim: [0, 0.92],
  blur: [0, 32],
  saturate: [0.3, 1.6],
  opacity: [0.15, 0.92],
  // 玻璃面透明度：上限 0.92 —— 留一点缝让壁纸透出来，同时地板层仍在托底。
  glass: [0, 0.92],
  // 面板背后那层的模糊半径。
  surfaceBlur: [0, 40],
})

// ─────────────────────────────────────────────── 颜色数学 ───────────────────────────────────────────────

/** 0–255 夹取（输入可能来自浮点运算）。 */
const byte = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(255, Math.round(n)))
}

/**
 * `#rrggbb` / `#rgb` → `{ r, g, b }`（0–255）。不认识就 null（调用方走保底）。
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number } | null}
 */
export function parseHex(hex) {
  if (typeof hex !== 'string') return null
  const text = hex.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text)
  if (short !== null) {
    return { r: parseInt(short[1] + short[1], 16), g: parseInt(short[2] + short[2], 16), b: parseInt(short[3] + short[3], 16) }
  }
  const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text)
  if (full !== null) return { r: parseInt(full[1], 16), g: parseInt(full[2], 16), b: parseInt(full[3], 16) }
  return null
}

/** `{ r, g, b }`（0–255，可浮点）→ `#rrggbb`。 */
export function toHex(rgb) {
  return `#${byte(rgb.r).toString(16).padStart(2, '0')}${byte(rgb.g).toString(16).padStart(2, '0')}${byte(rgb.b).toString(16).padStart(2, '0')}`
}

/** `rgba()` 字符串：壁纸接管用的 token 多数是半透明层。 */
export function rgba(rgb, alpha) {
  const a = Math.max(0, Math.min(1, Number(alpha) || 0))
  return `rgba(${byte(rgb.r)}, ${byte(rgb.g)}, ${byte(rgb.b)}, ${Math.round(a * 1000) / 1000})`
}

/**
 * WCAG 相对亮度（sRGB → 线性 → 加权）。这是对比度公式的中间量，
 * **不是**"看起来多亮"——所以取色时也算一次，观感与标准用的是同一个数。
 * @param {{ r: number, g: number, b: number }} rgb 0–255。
 * @returns {number} 0–1。
 */
export function relativeLuminance(rgb) {
  const channel = (v) => {
    const s = byte(v) / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/**
 * 两色对比度（1–21）。
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 在两套墨色里挑对比度更高的那个。
 * @param {{ r: number, g: number, b: number }} bg
 * @returns {'light' | 'dark'}
 */
export function pickInk(bg) {
  const light = contrastRatio(parseHex(INK.light), bg)
  const dark = contrastRatio(parseHex(INK.dark), bg)
  // 相等时选浅色字：暗色壁纸占绝对多数，少一次"该翻而没翻"的意外。
  return light >= dark ? 'light' : 'dark'
}

/**
 * 在"背景色 → 目标墨色"之间插一层**中性幕**（不是纯黑），把对比度抬到 target。
 *
 * 为什么用二分而不是解析解：对比度公式里有一段 gamma 曲线，解析解要解四次方程，
 * 不值得。单调性保证二分必然收敛，30 次就够到浮点精度。
 *
 * 幕的方向：补到**偏暗**那一侧 —— 往墨色的反方向压，白的壁纸压黑字更清楚，
 * 黑的壁纸压黑幕加白字也更清楚。`mode` 允许指定 `light`（压白幕）。
 *
 * @param {{ r: number, g: number, b: number }} bg 壁纸平均色。
 * @param {'light' | 'dark'} ink 文字用哪套墨。
 * @param {number} target 目标对比度。
 * @param {{ mode?: 'light' | 'dark' }} [opts] `mode` = 幕往哪边压，默认与 ink 相反。
 * @returns {number} 需要的幕浓度 0–1（0 = 不用压）。
 */
export function solveScrim(bg, ink, target, opts = {}) {
  const inkRgb = parseHex(INK[ink])
  const scrimMode = opts.mode ?? (ink === 'light' ? 'dark' : 'dark')
  const scrimRgb = scrimMode === 'light' ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
  if (contrastRatio(inkRgb, bg) >= target) return 0
  const mix = (alpha) => ({
    r: bg.r + (scrimRgb.r - bg.r) * alpha,
    g: bg.g + (scrimRgb.g - bg.g) * alpha,
    b: bg.b + (scrimRgb.b - bg.b) * alpha,
  })
  // 满幕都够不着（目标定太高时的病态输入）：直接返回 1，别返回一个假的"刚够"。
  if (contrastRatio(inkRgb, mix(1)) < target) return 1
  // 二分：lo 侧永远不达标、hi 侧永远达标。
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2
    if (contrastRatio(inkRgb, mix(mid)) >= target) hi = mid
    else lo = mid
  }
  // **往上取整**：精确解常带 0.6173… 这种尾巴，四舍五入会把它掉到目标线下面。
  // 幕多压 0.001 看不出来，少压一点字就糊了 —— 宁可往厚的方向错。
  return Math.min(1, Math.ceil(hi * 1000) / 1000)
}

// ─────────────────────────────────────────────── 画面摘要 ───────────────────────────────────────────────

/**
 * 把"一张图的像素"压成摘要。
 *
 * @param {Uint8ClampedArray | number[]} data RGBA 连续排列（canvas `getImageData().data`）。
 * @param {{ step?: number }} [opts] `step` = 采样步长（像素），>1 时抽稀。
 * @returns {{ mean: { r: number, g: number, b: number }, luminance: number, darkShare: number, spread: number, samples: number } | null}
 *   全透明/空输入返回 null。
 */
export function analyzePixels(data, opts = {}) {
  if (data === null || data === undefined || typeof data.length !== 'number') return null
  const step = Math.max(1, Math.floor(opts.step ?? 1))
  const stride = 4 * step
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  let dark = 0
  /** 每个像素的亮度也留着算分散度 —— 平均色会藏住"半黑半白"这种最坏情况。 */
  const lums = []
  for (let i = 0; i + 3 < data.length; i += stride) {
    const alpha = data[i + 3]
    if (alpha < 8) continue
    const pr = data[i]
    const pg = data[i + 1]
    const pb = data[i + 2]
    r += pr
    g += pg
    b += pb
    count += 1
    const lum = relativeLuminance({ r: pr, g: pg, b: pb })
    lums.push(lum)
    if (lum < 0.12) dark += 1
  }
  if (count === 0) return null
  const mean = { r: r / count, g: g / count, b: b / count }
  let variance = 0
  for (const lum of lums) variance += (lum - relativeLuminance(mean)) ** 2
  variance /= lums.length
  return {
    mean,
    luminance: relativeLuminance(mean),
    // 暗部占比：> 0.5 说明画面大面积是暗的，"白字"几乎是必然选择，可以少压幕。
    darkShare: dark / count,
    // 分散度（亮度标准差）：越大说明画面明暗夹杂，只在平均色上算对比度是骗子，
    // 幕必须更厚才能让**每一块**区域都清楚。
    spread: Math.sqrt(variance),
    samples: count,
  }
}

/**
 * 从一串颜色直接出摘要（内置素材出厂预设可以写死几个代表色，省一次解码）。
 * @param {string[]} hexes
 * @returns {ReturnType<typeof analyzePixels>}
 */
export function analyzeColors(hexes) {
  if (!Array.isArray(hexes) || hexes.length === 0) return null
  const data = []
  for (const hex of hexes) {
    const rgb = parseHex(hex)
    if (rgb === null) continue
    data.push(rgb.r, rgb.g, rgb.b, 255)
  }
  if (data.length === 0) return null
  return analyzePixels(data)
}

// ─────────────────────────────────────────────── 决策 ───────────────────────────────────────────────

/**
 * 合并预设与用户微调后的"有效参数"。
 *
 * 用户的微调永远是**相对预设**的：换预设时不该把用户之前拖的滑杆带过去。
 * 所以存盘的是 `{ preset, scrim?, blur?, saturate?, glassAlpha?, surfaceBlur? }`，
 * 没有写的字段就取预设值。
 *
 * @param {{ preset?: string, scrim?: number, blur?: number, saturate?: number, opacity?: number, glassAlpha?: number, surfaceBlur?: number, text?: string, surface?: string }} tweak
 * @returns {typeof PRESETS[number]}
 */
export function resolvePreset(tweak = {}) {
  const found = PRESETS.find((item) => item.id === tweak.preset)
  const base = found ?? PRESETS.find((item) => item.id === DEFAULT_PRESET_ID)
  const out = { ...base }
  if (Number.isFinite(tweak.scrim)) out.scrim = clampRange(tweak.scrim, SCREEN_LIMITS.scrim)
  if (Number.isFinite(tweak.blur)) out.blur = clampRange(tweak.blur, SCREEN_LIMITS.blur)
  if (Number.isFinite(tweak.saturate)) out.saturate = clampRange(tweak.saturate, SCREEN_LIMITS.saturate)
  if (Number.isFinite(tweak.opacity)) out.opacity = clampRange(tweak.opacity, SCREEN_LIMITS.opacity)
  if (Number.isFinite(tweak.glassAlpha)) out.glassAlpha = clampRange(tweak.glassAlpha, SCREEN_LIMITS.glass)
  if (Number.isFinite(tweak.surfaceBlur)) out.surfaceBlur = clampRange(tweak.surfaceBlur, SCREEN_LIMITS.surfaceBlur)
  if (typeof tweak.text === 'string' && ['auto', 'light', 'dark', 'keep'].includes(tweak.text)) out.text = tweak.text
  if (typeof tweak.surface === 'string' && ['solid', 'soft', 'clear'].includes(tweak.surface)) out.surface = tweak.surface
  return out
}

/** 把 n 夹进 [min, max]。 */
function clampRange(n, [min, max]) {
  return Math.max(min, Math.min(max, Number(n)))
}

/**
 * 核心决策：给画面摘要 + 预设，算出"字用哪套墨"和"需要多厚的幕"。
 *
 * @param {ReturnType<typeof analyzePixels>} analysis 摘要；null 时按"深色画面"保底。
 * @param {ReturnType<typeof resolvePreset>} preset 有效预设。
 * @param {{ preference?: 'light' | 'dark' | 'system' }} [opts] 用户的主题偏好，只作输入。
 * @returns {{ ink: 'light' | 'dark', tint: string, scrim: number, required: number, surface: 'solid' | 'soft' | 'clear', contrast: number, reason: string }}
 */
export function decideTheme(analysis, preset, opts = {}) {
  const safe = analysis ?? { mean: { r: 18, g: 18, b: 24 }, luminance: 0.01, darkShare: 1, spread: 0, samples: 0 }
  const autoInk = pickInk(safe.mean)
  let ink = preset.text === 'light' ? 'light' : preset.text === 'dark' ? 'dark' : autoInk
  // `keep`：不碰字色 —— 交给 DSH 自己的主题，但仍然算"最多长出一层什么样的幕"。
  const keeps = preset.text === 'keep'
  if (!keeps && preset.text === 'auto' && opts.preference === 'dark' && safe.luminance > 0.35) {
    // 亮壁纸 + 用户偏好深色：仍然按画面走（深色字），偏好只是"打平时偏向谁"的参考，
    // 绝不反过来把字硬生生调成看不清的白。
    ink = autoInk
  }

  const inkRgb = parseHex(INK[ink])
  const baseContrast = contrastRatio(inkRgb, safe.mean)
  // 分散度高 → 平均色的对比度不可信，目标抬一档（最差区域也要过线）。
  const target = CONTRAST_BODY + Math.min(0.9, safe.spread * 2.2)
  // 预设给的幕是**下限**（观感），算出来的幕是**需求**（可读），取大。
  const required = solveScrim(safe.mean, ink, target)
  const scrim = Math.max(preset.scrim, required)
  // 幕一律压向"墨色的反方向"：浅色字压暗幕，深色字压亮幕。压反了会越压越糊。
  const scrimRgb = ink === 'light' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
  const contrast = contrastRatio(inkRgb, mixColor(safe.mean, scrim, scrimRgb))
  return {
    ink,
    tint: toHex(safe.mean),
    scrim,
    required,
    surface: preset.surface ?? 'solid',
    contrast: Math.round(contrast * 100) / 100,
    reason: keeps ? 'keep' : preset.text === 'auto' ? 'auto' : 'forced',
  }
}

/** 在 bg 上按 alpha 叠一层 scrim 色。 */
function mixColor(bg, alpha, scrim) {
  const a = Math.max(0, Math.min(1, alpha))
  return {
    r: bg.r + (scrim.r - bg.r) * a,
    g: bg.g + (scrim.g - bg.g) * a,
    b: bg.b + (scrim.b - bg.b) * a,
  }
}

/**
 * 把决策翻成一组 CSS 变量。
 *
 * 渲染层只认"名字 → 字符串"，不认业务含义：这样以后内核换 token 名、或者要补某个面，
 * 改的是这张表，而不是渲染代码。
 *
 * 玻璃配方的落点（照抄 dsh-wallpaper-engine 的结构）：
 *
 *   glass = color-mix(in srgb, 地板色 floor%, 玻璃色 (1-floor)%)
 *
 * color-mix 在预乘空间按权重插值，等于"地板色 @floor 压在玻璃色之上"，所以
 * **有效覆盖 = floor + a×(1−floor) ≥ floor** —— 玻璃透明度无论怎么调，都不会把字压糊。
 *
 * @param {ReturnType<typeof decideTheme>} decision
 * @param {{ tint?: string, glassTint?: string, glassAlpha?: number, surfaceBlur?: number, accent?: string, gray?: boolean }} [preset] 预设（取玻璃配方）。
 * @param {{ dark?: boolean }} [opts] `dark` = 系统/DSH 当前是深色主题（决定地板色）。
 * @returns {Record<string, string>}
 */
/** 垫底色的"过亮夹子"：壁纸太亮时往这个暗色方向压，保证掉层时不会闪白。 */
const UNDERLAY_CAP = Object.freeze({ r: 18, g: 20, b: 26 })

/**
 * 面板背后那道**实景模糊**能给出的曝光。
 *
 * 玻璃面是不透明的（地板色 + 一点釉，见下），壁纸的颜色**只**通过面板后面的
 * `backdrop-filter: blur()` 透上来。而模糊只是把壁纸糊匀，它**不会**把壁纸的曝光
 * 带进面板：一块压暗到 `#1a1a1a` 的面板，底下是什么颜色的壁纸，看得见的部分都还是
 * `#1a1a1a` 的调子。所以"壁纸透过面板能看见多少"由这个数决定 —— 它是模糊之后
 * 面板色与真实壁纸色的混合比，与玻璃面的透明度是两件事。
 *
 * 0.55 是拿来对齐参考实现观感的：它的玻璃面是**半透明**的玻璃色，壁纸颜色本来就
 * 透得很足；我们这边面板必须不透明（否则截屏/掉层时会穿帮成一片透明），就只能由
 * 这一层补回同样的"壁纸感"。
 */
const GLASS_SHOW_THROUGH = 0.55

export function deriveTokens(decision, preset = {}, opts = {}) {
  const dark = opts.dark === true
  // 玻璃配方只出现在预设里（七套各自一套釉色）。预设没给釉色时不能拿**壁纸的画面色**
  // 顶替 —— 那是壁纸的主色，压成不透明面板会变成一整块纯色块（深色壁纸 ⇒ 全黑界面）。
  // 这种情形退回"当前主题的原生釉"：浅色白釉、深色近黑釉。
  const nativeTint = dark ? FLOOR_BASE.dark : FLOOR_BASE.light
  // 地板色永远站在字色那一侧：深色主题压近黑、浅色主题压白。
  // 这条与"墨色"（字是亮还是暗）是两件事 —— 地板保的是"面板底足够实"，
  // 墨色保的是"字在面板上够亮"。两者混用会在金色壁纸上翻车。
  const floorRgb = parseHex(dark ? FLOOR_BASE.dark : FLOOR_BASE.light)
  const floor = dark ? READABILITY_FLOOR_DARK : READABILITY_FLOOR
  const tintRgb = parseHex(preset.glassTint) ?? parseHex(nativeTint) ?? { r: 255, g: 255, b: 255 }
  // 玻璃色必须**先钳到可读**再下锅：`glassTint` 可能是直接传进来的裸配方（单测、外部
  // 调用都不走 PRESETS），不能指望它是出厂的七种之一。#00c800 这种本身就是 2.27:1 的
  // 釉色如果原样掺进去，任何 alpha 都救不回来。
  const safeTintRgb = clampSurfaceColor(tintRgb, dark, decision.tint)
  const glassAlpha = clampRange(Number.isFinite(preset.glassAlpha) ? preset.glassAlpha : 0.4, SCREEN_LIMITS.glass)
  const surfaceBlur = Math.round(clampRange(Number.isFinite(preset.surfaceBlur) ? preset.surfaceBlur : 20, SCREEN_LIMITS.surfaceBlur))
  const accent = preset.accent ?? '#4f8cff'
  // 地板色 = 预设的玻璃色经亮度钳制：色相听预设的（七套各有自己的调子），亮度必须
  // 过 4.6:1 那条线。直接拿玻璃色当釉去混白/黑地板是不行的 —— 两者都往中间走，
  // 深色主题下白色釉在 0.59 的地板上只剩 `#333539`，比宿主原生底色还亮，
  // 七套预设于是糊成同一片灰，这就是"参数全拉低也看不见"。
  //
  // 最透那一档（玻璃厚度滑杆拉到 0）用的釉色比例极小，只要地板本身够深就守得住；
  // 层 2/3 掺的釉更多，所以它们各自再钳一次 —— 但**幅度要小**：钳得太狠，
  // 深色主题下三层会被压成同一个近黑色，"面上的面"就没有层次了。
  const baseRgb = clampSurfaceColor(safeTintRgb, dark, decision.tint)
  const alpha1 = glassAlpha
  const alpha2 = Math.min(1, glassAlpha * 1.35 + 0.04)
  const alpha3 = Math.min(1, glassAlpha * 1.7 + 0.08)
  const g1 = glassMix(baseRgb, safeTintRgb, alpha1)
  // 三级玻璃：层 2 / 层 3 是浮在层 1 之上的浮层（菜单、弹窗、选中态）。
  //
  // 它们的差别**不是颜色**，而是背后模糊的**清晰度**：浮层越靠前，透过它的壁纸
  // 越糊、越看不清 —— 这正是真实玻璃桌面的观感来源（参考实现里每层一个权重，
  // 我们换成一个更容易理解的量：模糊半径）。
  //
  // 为什么不靠改颜色来分层：面板底色的亮度被可读性下限锁死了（钳制之后亮釉基本都
  // 顶到纯白、暗釉顶到近黑），再想拉开就只能往中间灰走 —— 而中间灰上白字黑字都
  // 只有 4:1 左右，等于拿"看得清"去换"有层次"。这笔账不划算。
  const layerBlur = (base, factor) => {
    const value = Math.round(clampRange(base * factor, SCREEN_LIMITS.surfaceBlur))
    return `${value}px`
  }
  // 字色：按**实际对比度**验出来（谁清楚用谁），不是按面板亮度猜。
  // 面板只有一层，所以字色只需要对这一次负责；浮层的区别落在模糊半径上。
  //
  // 有一条护栏：`#ffffff` 面板上"白字"和"黑字"的对比度是 1.00 对 18.88，比较本身不会错；
  // 但灰面板（比如 #808080）上两者可能只差 0.01，此时按亮度兜底，避免因为取整抖动
  // 把字色和面刷成同一个颜色。
  const whiteOnGlass = contrastRatio(parseHex(INK.light), parseHex(g1.final))
  const darkOnGlass = contrastRatio(parseHex(INK.dark), parseHex(g1.final))
  const inkLight = darkOnGlass > whiteOnGlass ? false : whiteOnGlass > darkOnGlass ? true : g1.lum < 0.18
  // 列底不透明度：按**幕布之后**的壁纸反推，而不是按裸壁纸的极端反推。
  //
  // 壁纸层上本来就压着一层幕（`dsa-wall-scrim`，浓度 = decision.scrim，方向跟墨色），
  // 它把壁纸的亮度范围压过一遍。列底只需要扛住**压过之后的那个范围** —— 之前按裸壁纸
  // 的纯黑/纯白反推，等于把幕的活儿让列再干一遍，面板被算得死实（用户看到的
  // "背景不明显"就是这个）。
  const scrimRgb = decision.ink === 'light' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
  const scrimmedLo = mixColor({ r: 0, g: 0, b: 0 }, decision.scrim, scrimRgb)
  const scrimmedHi = mixColor({ r: 255, g: 255, b: 255 }, decision.scrim, scrimRgb)
  const glassInk = parseHex(inkLight ? INK.light : INK.dark) ?? scrimmedLo
  const wallWorst = contrastRatio(scrimmedLo, glassInk) <= contrastRatio(scrimmedHi, glassInk) ? scrimmedLo : scrimmedHi
  // 列底能"藏"多少，由**玻璃厚度**决定 —— 这是它存在的唯一理由。
  //
  // 只看 4.5:1 的话，算出来的不透明度几乎永远落在下限 0.35（窗子太宽），滑杆也就
  // 永远看不出反应 —— 这正是用户说的"玻璃厚度没效果"。所以这里把玻璃厚度翻译成
  // **面板能藏住多少壁纸**：玻璃越厚，成品色越靠近玻璃色、越远离壁纸。
  //
  // 上下限都压在 0.55–0.9：0.55 保证成品始终看得出玻璃色，0.9 保证再厚也还剩一点
  // 壁纸透上来（否则跟没开壁纸一样）。安全性算出来更高时以安全值为准。
  const SHELL_MIN = 0.55
  const SHELL_MAX = 0.9
  const shellTarget = SHELL_MIN + clampRange(glassAlpha, [0, 1]) * (SHELL_MAX - SHELL_MIN)
  // 悬停/选中的高亮面：不参与可读性主线，但也不能是"纯白或纯黑"跳变 —— 壁纸越亮，
  // 高亮就该越淡，否则白面板上的白色悬停块会直接吞掉壁纸。
  const wallLum = relativeLuminance(parseHex(decision.tint) ?? g1Rgb(g1.final))
  const hoverAlpha = clampRange(0.1 - wallLum * 0.08, [0.02, 0.1])
  const hover = mixRgb(g1Rgb(g1.final), parseHex(decision.tint) ?? g1Rgb(g1.final), hoverAlpha)
  const wallAlpha = Math.max(
    shellTarget,
    solveWallAlpha(parseHex(g1.final) ?? wallWorst, glassInk, wallWorst),
  )
  const ink = inkLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(14, 16, 22, 0.95)'
  const dim = inkLight ? 'rgba(255, 255, 255, 0.76)' : 'rgba(14, 16, 22, 0.70)'
  const faint = inkLight ? 'rgba(255, 255, 255, 0.58)' : 'rgba(14, 16, 22, 0.54)'
  // 面板背后要糊成什么样：把**真实壁纸色**按透底量掺进玻璃面 ——
  // 这就是面板后面看到的那层"壁纸雾"，也是七套预设肉眼能分开的最后一把力。
  //
  // 透底量跟着**列底实际留了多少空**走：列底 alpha=1（安全值推满）时壁纸本来就看不见，
  // 再把雾掺进去只是让颜色偏脏；列底很透时（玻璃厚度 0）壁纸才是画面主角。
  const frost = mixRgb(g1Rgb(g1.final), parseHex(decision.tint) ?? g1Rgb(g1.final), clampRange(1 - wallAlpha, [0, GLASS_SHOW_THROUGH]))
  return {
    'dsa-wall-ink': ink,
    'dsa-wall-ink-dim': dim,
    'dsa-wall-ink-faint': faint,
    'dsa-wall-scrim': String(decision.scrim),
    'dsa-wall-glass-1': g1.final,
    'dsa-wall-glass-2': g1.final,
    'dsa-wall-glass-3': g1.final,
    'dsa-wall-glass-solid': toHex(mixRgb(g1Rgb(g1.final), parseHex(dark ? FLOOR_BASE.dark : FLOOR_BASE.light) ?? g1Rgb(g1.final), floor * 0.5)),
    'dsa-wall-frost': toHex(frost),
    'dsa-wall-surface-blur': `${surfaceBlur}px`,
    // 浮层的模糊：层越高，透过它看到的壁纸越糊 —— 这才是"浮起来的"观感。
    'dsa-wall-blur-1': `${surfaceBlur}px`,
    'dsa-wall-blur-2': layerBlur(surfaceBlur, 1.25),
    'dsa-wall-blur-3': layerBlur(surfaceBlur, 1.5),
    'dsa-wall-accent': accent,
    // 三列的不透明度：`max(玻璃厚度, 安全性算出来的下限)`。
    // 玻璃厚度决定"面板藏住多少壁纸"，安全性决定"最少要藏多少"，取严的那个。
    'dsa-wall-wall-alpha': String(Math.round(wallAlpha * 100) / 100),
    'dsa-wall-wall': rgba(g1Rgb(g1.final), wallAlpha),
    // 悬停/选中的高亮面：同样半透明，压在列底之上仍然透壁纸。
    'dsa-wall-hover': rgba(hover, 0.85),
    'dsa-wall-border': inkLight ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.12)',
    // 壁纸层自己的垫底色：画面没送到屏上时退化成这个颜色，而不是白闪。
    // 往地板色压六成；纯白壁纸再单独压暗一档 —— 混色的目标就是地板色本身，
    // 否则 #fff 混 #fff 还是 #fff，掉层时那一眼照样闪白。
    'dsa-wall-underlay': toHex(
      mixRgb(
        parseHex(decision.tint) ?? floorRgb,
        relativeLuminance(parseHex(decision.tint) ?? floorRgb) > 0.6 ? UNDERLAY_CAP : floorRgb,
        0.6,
      ),
    ),
    // 对比度实报（字 vs 面板）：预设卡和滑杆提示都读它。
    'dsa-wall-contrast': String(Math.round(contrastRatio(parseHex(inkLight ? INK.light : INK.dark), parseHex(g1.final)) * 100) / 100),
  }
}

/** `#rrggbb` → rgb 对象（glassMix 的输出必然可解析，解析不了就退回黑）。 */
function g1Rgb(hex) {
  return parseHex(hex) ?? { r: 0, g: 0, b: 0 }
}

/**
 * 反推"三列该有多不透明"，让壁纸透上来的同时字站得住。
 *
 * 列底 = 玻璃色 @alpha 压在壁纸之上。壁纸取**最坏的那一档**（浅色主题取纯黑、
 * 深色主题取纯白），因为用户可能换任何一张壁纸，而这条线不能靠运气。
 * 二分出"刚好过 4.5:1"的那一档，再留 0.02 余量防取整误差。
 *
 * @param {{ r: number, g: number, b: number }} glass 玻璃色（面板色）
 * @param {{ r: number, g: number, b: number }} ink 字色
 * @param {{ r: number, g: number, b: number }} worst 最坏壁纸色
 * @param {{ tintHex?: string, hoverHex?: string }} [opts] 真实壁纸色与悬停面（核对"实际画面"那一档）
 * @returns {number} 0.35–1 之间的不透明度
 */
function solveWallAlpha(glass, ink, worst) {
  const at = (alpha) => contrastRatio(mixRgb(worst, glass, alpha), ink)
  if (at(WALL_ALPHA_MIN) >= CONTRAST_BODY) return WALL_ALPHA_MIN
  if (at(1) < CONTRAST_BODY) return 1
  let lo = WALL_ALPHA_MIN
  let hi = 1
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2
    if (at(mid) >= CONTRAST_BODY) hi = mid
    else lo = mid
  }
  // 向上取整到 0.01：往下取会让面板比安全线还透。
  return Math.min(1, Math.ceil((hi + 0.02) * 100) / 100)
}

/**
 * 生成一条玻璃色：**钳制过亮度的地板色**打底，再掺一点预设自己的釉色。
 *
 * 三步纯算术（不依赖浏览器的 color-mix），所以 node 里能直接单测出最终对比度：
 *
 *   1. 地板色 = 玻璃色经亮度钳制（`clampSurfaceColor`）→ 色相听预设，亮度过 4.6:1
 *   2. 釉色按 alpha 掺进地板色              → 面板的"釉"，七套预设在这一步分开
 *   3. 字色取步骤 2 的亮度                 → 深釉配白字、亮釉配黑字
 *
 * 可读性下限由**步骤 1** 兑现：地板色本身就已经过线，釉色不管怎么掺，字色
 * 都会跟着面板亮度翻到对面，所以"玻璃厚度拉到 0 也看不清"这种事不会发生。
 *
 * @param {{ r: number, g: number, b: number }} baseRgb 已钳制的地板色
 * @param {{ r: number, g: number, b: number }} tintRgb 预设的釉色
 * @param {number} alpha 釉色权重
 * @returns {{ final: string, lum: number }} 最终色 + 它的相对亮度（供渲染层判断要不要翻字色）。
 */
function glassMix(baseRgb, tintRgb, alpha) {
  const final = mixRgb(baseRgb, tintRgb, alpha)
  return { final: toHex(final), lum: relativeLuminance(final) }
}

/**
 * 把预设的釉色钳到"在当前主题下当面板底还看得清字"的亮度上。
 *
 * 判据是**界面真实合成**：面板背后是壁纸（已被 scrim / 地板压过），玻璃厚度拉到 0
 * 那档仍会透出一点点壁纸色，所以判的是 `面板 (1−s) + 壁纸 s` 的亮度，然后再看
 * 白字与黑字里哪个能到 4.6:1（比 4.5 多留 0.1 给 hex 量化）。
 *
 * - 深色主题：太亮的釉会被往黑压（`#ffffff → #3d3e3e`）；
 * - 浅色主题：太暗的釉会被往白提（`#0d1524 → #d0d2d5`）。
 *
 * 保住色相的**方向**：七套预设仍是七种调子，只是亮度过线，不会糊成一片灰。
 * 参考实现把这一项叫 `weClampSurfaceColor`，判的是同一条网格（正文 vs 面板合成到
 * 最坏背衬 ≥4.5:1，最透档 alpha 取 0.10）。
 *
 * @param {{ r: number, g: number, b: number }} rgb 预设的玻璃色
 * @param {boolean} dark 当前是不是深色主题
 * @param {string} [backdropHex] 壁纸色（不传就用地板色）
 * @param {number} [alpha] 这一层要掺多少釉（层 2/3 掺得更多，判据得跟着它走）
 * @returns {{ r: number, g: number, b: number }}
 */
function clampSurfaceColor(rgb, dark, backdropHex, alpha = 0, showThrough = 0.08) {
  const backdrop = parseHex(backdropHex ?? '') ?? parseHex(dark ? FLOOR_BASE.dark : FLOOR_BASE.light) ?? { r: 0, g: 0, b: 0 }
  // 最透那一档：玻璃厚度 0 时面板与壁纸的混合比。壁纸越亮，透底越强，面板色就越要让位
  // —— 由调用方按壁纸亮度传进来（列上真要透多少看 SHELL 那一档，这里是判据用的）。
  const leak = showThrough
  // 判据是**掺完这层釉之后**的合成亮度：
  //   · 主题定方向（深色用白字、浅色用黑字）先判；
  //   · 到不了 4.6:1 才允许翻面（深色主题的亮釉面板配深字）。翻面的代价是那层
  //     上面要换一套字色，所以它被限制在原文就在 0.15–0.85 之间的"中间调"上 ——
  //     纯黑/纯白这类极端色不翻，否则深色主题会被白釉整片刷成白色界面。
  const composedOf = (color) => relativeLuminance(mixRgb(mixRgb(color, rgb, alpha), backdrop, leak))
  const contrastPair = (lum) => ({ white: 1.05 / (lum + 0.05), black: (lum + 0.05) / 0.05 })
  const passes = (color) => {
    const { white, black } = contrastPair(composedOf(color))
    if ((dark ? white : black) >= 4.6) return true
    const lum = relativeLuminance(color)
    const flippable = lum > 0.15 && lum < 0.9
    return flippable && (dark ? black : white) >= 4.6
  }
  // 原色合格就原样用；不合格才沿"往纯黑/纯白"的轴找第一个合格点。
  const target = dark ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
  const blend = (t) => mixRgb(rgb, target, t)
  // 原色合格就直接用（保住色相）。注意这里**不能只信 passes**：
  // 判据允许"亮面配深字"的翻面，而字色是三层联合决定的，单层合格不代表整块面板
  // 都能用同一套字色。所以直接沿轴扫，接受"可读且字色固定"的第一点。
  // alpha≈0 时釉色几乎不参与合成，面板颜色就等于这个返回值本身 —— 于是要求
  // **面板自己**也过线，否则"墙一样厚的玻璃拖到 0"就会露出 4:1 的灰面。
  const passesSelf = (color) => {
    const lum = relativeLuminance(color)
    return Math.max(1.05 / (lum + 0.05), (lum + 0.05) / 0.05) >= 4.6
  }
  for (let i = 0; i <= 100; i += 1) {
    const t = i / 100
    const candidate = blend(t)
    if (!passes(candidate)) continue
    // 只收"面板本身对比度也够"的点。阈值 4.8 比 4.5 留余量：玻璃厚度拉到 0 时面板
    // 颜色就等于这儿返回的值，擦线的点遇上一轮 hex 取整就会掉回线下。
    const lum = relativeLuminance(candidate)
    if (Math.max(1.05 / (lum + 0.05), (lum + 0.05) / 0.05) >= 4.8) return byte3(candidate)
  }
  // 主题那一侧怎么都到不了：退到最极端的那头，由调用方按实际亮度重定字色。
  return byte3(blend(1))
}

/** 三个通道各自取整到 0–255。 */
function byte3(rgb) {
  return { r: byte(rgb.r), g: byte(rgb.g), b: byte(rgb.b) }
}

/** 在 bg 上按 alpha 叠一层 fg。 */
function mixRgb(bg, fg, alpha) {
  const a = Math.max(0, Math.min(1, alpha))
  return {
    r: bg.r + (fg.r - bg.r) * a,
    g: bg.g + (fg.g - bg.g) * a,
    b: bg.b + (fg.b - bg.b) * a,
  }
}

/** 壁纸层自己的样式（不含页面让位）：渲染层直接贴到 `style` 上。 */
export function layerStyle(preset) {
  const p = resolvePreset(preset)
  return [
    // 模糊半径用的是**面板背后那层**（surfaceBlur），不是壁纸本体 ——
    // 壁纸本体保持清晰才有"壁纸"的感觉，糊的是面板底下那层玻璃。
    `filter: blur(${p.surfaceBlur}px) saturate(${p.saturate})`,
    // 模糊会把边缘吸进来一圈透明，放大一点补掉。
    `transform: scale(${p.surfaceBlur > 0 ? 1.06 : 1})`,
  ].join('; ')
}

/**
 * 服务端也用它夹取（与浏览器算出来的完全同源）。
 * @param {{ preset?: string, scrim?: number, blur?: number, saturate?: number, opacity?: number, glassAlpha?: number, surfaceBlur?: number, text?: string, surface?: string }} tweak
 * @returns {{ preset: string, scrim: number, blur: number, saturate: number, opacity: number, glassAlpha: number, surfaceBlur: number, text: string, surface: string }}
 */
export function sanitizeTweak(tweak = {}) {
  const p = resolvePreset(tweak)
  return {
    preset: p.id,
    scrim: Math.round(p.scrim * 1000) / 1000,
    blur: Math.round(p.blur),
    saturate: Math.round(p.saturate * 1000) / 1000,
    opacity: Math.round(clampRange(Number.isFinite(p.opacity) ? p.opacity : 0.72, SCREEN_LIMITS.opacity) * 1000) / 1000,
    glassAlpha: Math.round(clampRange(Number.isFinite(p.glassAlpha) ? p.glassAlpha : 0.4, SCREEN_LIMITS.glass) * 1000) / 1000,
    surfaceBlur: Math.round(clampRange(Number.isFinite(p.surfaceBlur) ? p.surfaceBlur : 20, SCREEN_LIMITS.surfaceBlur)),
    text: p.text ?? 'auto',
    surface: p.surface ?? 'solid',
  }
}
