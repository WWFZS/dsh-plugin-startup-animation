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
 * 出厂预设。`surface` 只描述"面板底"的策略，`text` 描述"字色"的策略：
 *
 * - `auto`       跟着画面算（分析结果说了算）
 * - `light`/`dark` 强制浅色字/深色字，不因为画面变亮变暗
 * - `keep`       完全不碰字色，交给 DSH 自己的主题
 *
 * `scrim` 是**下限**：算出来需要更厚的幕时，取更厚的那个（下限只为观感服务，
 * 上限为可读性服务 —— 两者不冲突）。
 */
export const PRESETS = Object.freeze([
  { id: 'readable', name: '可读优先', scrim: 0.52, blur: 0, saturate: 1, text: 'auto', surface: 'solid', desc: '按画面算字色，壁纸压一层浅幕' },
  { id: 'matte', name: '重磨砂', scrim: 0.34, blur: 18, saturate: 1.05, text: 'auto', surface: 'solid', desc: '大模糊，动态也稳' },
  { id: 'glaze', name: '暗夜釉色', scrim: 0.72, blur: 6, saturate: 0.9, text: 'light', surface: 'solid', desc: '深色压幕，白字保底' },
  { id: 'vivid', name: '原色直出', scrim: 0.08, blur: 0, saturate: 1.15, text: 'auto', surface: 'clear', desc: '几乎不压幕，面板透出壁纸' },
  { id: 'hacker', name: '黑客绿', scrim: 0.8, blur: 2, saturate: 0.6, text: 'light', surface: 'solid', desc: '终端绿配色' },
  { id: 'violet', name: '紫色心情', scrim: 0.6, blur: 10, saturate: 1.2, tint: '#7c5cff', text: 'light', surface: 'solid', desc: '紫色偏色幕' },
  { id: 'clear', name: '清透', scrim: 0.16, blur: 4, saturate: 1, text: 'auto', surface: 'soft', desc: '面板半透，壁纸仍可辨' },
])

/** 默认预设 id：装上就有合理观感，不逼用户先选一套。 */
export const DEFAULT_PRESET_ID = 'readable'

/** 用户改动过的安全区间（服务端也用这几个数夹取，两边一致）。 */
export const SCREEN_LIMITS = Object.freeze({
  scrim: [0, 0.92],
  blur: [0, 32],
  saturate: [0.3, 1.6],
  opacity: [0.15, 0.92],
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
 * 用户的微调永远是**相对预设**的：换预设时不该把用户之前拖的 3 根滑杆带过去。
 * 所以存盘的是 `{ preset, scrim?, blur?, saturate? }`，没有写的字段就取预设值。
 *
 * @param {{ preset?: string, scrim?: number, blur?: number, saturate?: number, opacity?: number, text?: string, surface?: string }} tweak
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
 * 返回的 key 是 CSS 自定义属性名（不含 `--`），值是合法的 color。
 *
 * @param {ReturnType<typeof decideTheme>} decision
 * @param {{ tint?: string }} [preset] 预设（取 tint / surface）。
 * @returns {Record<string, string>}
 */
export function deriveTokens(decision, preset = {}) {
  const ink = decision.ink === 'light' ? 'rgba(255, 255, 255, 0.94)' : 'rgba(20, 20, 24, 0.92)'
  const dim = decision.ink === 'light' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(20, 20, 24, 0.68)'
  const faint = decision.ink === 'light' ? 'rgba(255, 255, 255, 0.55)' : 'rgba(20, 20, 24, 0.52)'
  const tintRgb = parseHex(preset.tint ?? decision.tint) ?? { r: 0, g: 0, b: 0 }
  const surface = preset.surface ?? decision.surface ?? 'solid'
  // 面板底必须是"文字能与壁纸分开的那一侧"：浅色字 → 面板压到接近黑，深色字 → 压到接近白。
  // 直接用壁纸平均色当面板底是错的 —— 那会让面板和壁纸糊成一片，越描越看不见。
  const surfaceBase = decision.ink === 'light' ? { r: 12, g: 13, b: 18 } : { r: 248, g: 246, b: 242 }
  // solid 实心感最强；soft 半透；clear 几乎全透（壁纸透到面板里，靠这层幕撑住字）。
  const surfaceAlpha = surface === 'clear' ? 0.18 : surface === 'soft' ? 0.5 : 0.82
  return {
    'dsa-wall-ink': ink,
    'dsa-wall-ink-dim': dim,
    'dsa-wall-ink-faint': faint,
    'dsa-wall-scrim': String(decision.scrim),
    'dsa-wall-surface': rgba(surfaceBase, surfaceAlpha),
    'dsa-wall-surface-strong': rgba(surfaceBase, Math.min(0.94, surfaceAlpha + 0.12)),
    'dsa-wall-border': decision.ink === 'light' ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.14)',
  }
}

/** 壁纸层自己的样式（不含页面让位）：渲染层直接贴到 `style` 上。 */
export function layerStyle(preset) {
  const p = resolvePreset(preset)
  return [
    `filter: blur(${p.blur}px) saturate(${p.saturate})`,
    // 模糊会把边缘吸进来一圈透明，放大一点补掉。
    `transform: scale(${p.blur > 0 ? 1.06 : 1})`,
  ].join('; ')
}

/**
 * 服务端也用它夹取（与浏览器算出来的完全同源）。
 * @param {{ preset?: string, scrim?: number, blur?: number, saturate?: number, opacity?: number, text?: string, surface?: string }} tweak
 * @returns {{ preset: string, scrim: number, blur: number, saturate: number, opacity: number, text: string, surface: string }}
 */
export function sanitizeTweak(tweak = {}) {
  const p = resolvePreset(tweak)
  return {
    preset: p.id,
    scrim: Math.round(p.scrim * 1000) / 1000,
    blur: Math.round(p.blur),
    saturate: Math.round(p.saturate * 1000) / 1000,
    opacity: Math.round(clampRange(Number.isFinite(p.opacity) ? p.opacity : 0.72, SCREEN_LIMITS.opacity) * 1000) / 1000,
    text: p.text ?? 'auto',
    surface: p.surface ?? 'solid',
  }
}
