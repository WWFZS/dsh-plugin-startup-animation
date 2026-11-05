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

export function deriveTokens(decision, preset = {}, opts = {}) {
  const dark = opts.dark === true
  // 地板色永远站在字色那一侧：深色主题压近黑、浅色主题压白。
  // 这条与"墨色"（字是亮还是暗）是两件事 —— 地板保的是"面板底足够实"，
  // 墨色保的是"字在面板上够亮"。两者混用会在金色壁纸上翻车。
  const floorRgb = parseHex(dark ? FLOOR_BASE.dark : FLOOR_BASE.light)
  const floor = dark ? READABILITY_FLOOR_DARK : READABILITY_FLOOR
  const tintRgb = parseHex(preset.glassTint) ?? parseHex(decision.tint) ?? { r: 255, g: 255, b: 255 }
  const glassAlpha = clampRange(Number.isFinite(preset.glassAlpha) ? preset.glassAlpha : 0.4, SCREEN_LIMITS.glass)
  const surfaceBlur = Math.round(clampRange(Number.isFinite(preset.surfaceBlur) ? preset.surfaceBlur : 20, SCREEN_LIMITS.surfaceBlur))
  const accent = preset.accent ?? '#4f8cff'
  // 三级玻璃：层 2 / 层 3 在层 1 之上再抬亮一档，抬亮的方式是**多掺一点玻璃色**，
  // 不是硬加不透明度 —— 这样"面上的面"有层次，而不是一块实色盖住。
  const g1 = glassMix(floorRgb, floor, tintRgb, glassAlpha)
  const g2 = glassMix(floorRgb, floor, tintRgb, Math.min(1, glassAlpha * 1.12))
  const g3 = glassMix(floorRgb, floor, tintRgb, Math.min(1, glassAlpha * 1.28))
  // 字色：地板决定了面板底的亮度，字必须站到它的**对面**。
  // 这一条比 decideTheme 的墨色更硬：墨色管的是壁纸，这里管的是面板。
  // 两者打架时以面板为准 —— 字压在面板上，不是压在壁纸上。
  const inkLight = g1.lum < 0.35
  const ink = inkLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(14, 16, 22, 0.95)'
  const dim = inkLight ? 'rgba(255, 255, 255, 0.76)' : 'rgba(14, 16, 22, 0.70)'
  const faint = inkLight ? 'rgba(255, 255, 255, 0.58)' : 'rgba(14, 16, 22, 0.54)'
  return {
    'dsa-wall-ink': ink,
    'dsa-wall-ink-dim': dim,
    'dsa-wall-ink-faint': faint,
    'dsa-wall-scrim': String(decision.scrim),
    'dsa-wall-glass-1': g1.final,
    'dsa-wall-glass-2': g2.final,
    'dsa-wall-glass-3': g3.final,
    'dsa-wall-glass-solid': toHex(mixRgb(g1Rgb(g1.final), floorRgb, floor * 0.5)),
    'dsa-wall-surface-blur': `${surfaceBlur}px`,
    'dsa-wall-accent': accent,
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
    // 对比度实报（字 vs 玻璃面）：预设卡和滑杆提示都读它。
    'dsa-wall-contrast': String(Math.round(contrastRatio(parseHex(inkLight ? INK.light : INK.dark), parseHex(g1.final)) * 100) / 100),
  }
}

/** `#rrggbb` → rgb 对象（glassMix 的输出必然可解析，解析不了就退回黑）。 */
function g1Rgb(hex) {
  return parseHex(hex) ?? { r: 0, g: 0, b: 0 }
}

/**
 * 生成一条玻璃色：地板色 @floor 压在玻璃色之上。
 *
 * 两步都是纯算术（不依赖浏览器的 color-mix），所以 node 里能直接单测出最终对比度：
 *
 *   1. 玻璃色按 alpha 掺进地板色   → 面板的"釉"
 *   2. 结果再被地板色抬到 floor   → 可读性下限，权重不归任何滑杆管
 *
 * @param {{ r: number, g: number, b: number }} floorRgb
 * @param {number} floor 0–1
 * @param {{ r: number, g: number, b: number }} tintRgb
 * @param {number} alpha 玻璃自身的覆盖权重
 * @returns {{ final: string, lum: number }} 最终色 + 它的相对亮度（供渲染层判断要不要翻字色）。
 */
function glassMix(floorRgb, floor, tintRgb, alpha) {
  const base = mixRgb(floorRgb, tintRgb, alpha)
  const final = mixRgb(base, floorRgb, floor)
  return { final: toHex(final), lum: relativeLuminance(final) }
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
