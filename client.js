/**
 * startup-animation —— 浏览器半边：设置页。
 *
 * **一个** settings.section 条目（侧栏只显示「启动动画」），页面自上而下：
 *   1. 设置区（常驻）：总开关、声音、展示时长（共用主配置，3–30 秒）、当前素材预览 + 恢复默认；
 *   2. 分类切换器 [MP4 | 壁纸 | 音频 | 宠物 | 更新公告]；
 *   3. 分类区：上传（按文件类型自动归入本分类）+ 该分类素材**卡片网格**（点卡片即用，悬停出删除）。
 *      「更新公告」不是素材分类：它渲染 `/update` 顺手带回的 Release 正文（parseReleaseNotes）。
 *      「宠物」也不是素材分类：它是宠物开关 / 大小 / 动作预览，真身是页面右下角那只浮层。
 *
 * 宠物浮层（createPetLayer）在 apply 阶段挂到 document.body 上，与设置页渲染树无关：
 * 关掉设置页它也还在，靠 window 事件（dsa:pet-sync / -play / -reset）和设置页通信。
 *
 * 素材**只在** MP4 / 壁纸卡片里选用：上传只入库不生效，点卡片才写入配置。
 * 删除语义：内置素材 = 从列表隐藏（包内文件保留）；上传素材 = 真删文件。
 *
 * 开机动画本体不走这里（它在页面启动脚本阶段，见 runtime/boot.js）；整页"自取状态 +
 * 统一回读"：GET /dsh-startup-animation/manage 拿状态，POST 写配置，切换分类共享同一份状态。
 *
 * 约定：
 *   - React 来自浏览器模块表，不重复安装、不引 CDN；
 *   - 组件局部样式作为 React 元素渲染，卸载即移除；
 *   - 可见文字全部走 ctx.locale（zh/en 两份字典在 apply 里注册）；
 *   - 样式只用 --dsw-alias-* 主题 token（控件层；启动画面本身的配色是艺术品层）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-startup-animation',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MANAGE = '/dsh-startup-animation/manage'
    const UPDATE = '/dsh-startup-animation/update'
    const ASSET = '/dsh-startup-animation/asset'
    const NS = 'startup-animation'

// >>> INLINE lib/wallpaper.mjs（由 tools/sync-wallpaper-inline.mjs 生成，勿手改）
    // 真源：lib/wallpaper.mjs（与宿主、单测共用同一份算法，改那边再跑同步脚本）。
    // 导出（供 client-test 校验）：CONTRAST_BODY, CONTRAST_LARGE, CONTRAST_SURFACE, INK, READABILITY_FLOOR, READABILITY_FLOOR_DARK, FLOOR_BASE, PRESETS, DEFAULT_PRESET_ID, SCREEN_LIMITS, parseHex, toHex, rgba, relativeLuminance, contrastRatio, pickInk, solveScrim, analyzePixels, analyzeColors, resolvePreset, decideTheme, deriveTokens, layerStyle, sanitizeTweak
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
    const CONTRAST_BODY = 4.5
    /** 大字号/次要文字的下限。 */
    const CONTRAST_LARGE = 3
    /** 菜单、输入框这类"薄底"界面元素的下限 —— 它保的是**底**，不是字。 */
    const CONTRAST_SURFACE = 3

    /**
     * 浅色字 / 深色字两套基准。用接近纯黑的 `#111` 而不是 `#000`：纯黑落在壁纸的深色区
     * 会像一块洞，`#111` 观感更接近"墨水"。
     */
    const INK = Object.freeze({ light: '#ffffff', dark: '#111111' })

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
    const READABILITY_FLOOR = 0.45
    const READABILITY_FLOOR_DARK = 0.59

    /** 玻璃层之上那层"地板"的色：浅色主题压白、深色主题压黑 —— 永远站在字色那一侧。 */
    const FLOOR_BASE = Object.freeze({ light: '#ffffff', dark: '#0b0d12' })

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
     * 每个预设还带一套**玻璃配方**，这正是"五套预设看起来完全不一样"的来源：
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
    const PRESETS = Object.freeze([
      { id: 'frosted', name: '亮', scrim: 0, blur: 0, saturate: 1, glassTint: '#ffffff', glassAlpha: 0, surfaceBlur: 36, accent: '#4f8cff', text: 'auto', surface: 'solid', desc: '白釉亮面板' },
      { id: 'night', name: '暗', scrim: 0, blur: 0, saturate: 1, glassTint: '#0d1524', glassAlpha: 0, surfaceBlur: 22, accent: '#4f8cff', text: 'light', surface: 'solid', desc: '深蓝釉面' },
      { id: 'vivid', name: '原图', scrim: 0, blur: 0, saturate: 1, glassTint: '#67dce7', glassAlpha: 0, surfaceBlur: 18, accent: '#4f8cff', text: 'auto', surface: 'solid', desc: '青色透明釉，壁纸颜色不被压' },
      { id: 'hacker', name: '通用（绿）', scrim: 0, blur: 0, saturate: 1, glassTint: '#266d3c', glassAlpha: 0, surfaceBlur: 9, accent: '#00c800', text: 'light', surface: 'solid', desc: '终端绿' },
      { id: 'violet', name: '通用（紫）', scrim: 0, blur: 0, saturate: 1, glassTint: '#533b78', glassAlpha: 0, surfaceBlur: 9, accent: '#b388ff', text: 'light', surface: 'solid', desc: '紫釉玻璃' },
    ])

    /** 默认预设 id：装上就有合理观感，不逼用户先选一套。 */
    const DEFAULT_PRESET_ID = 'frosted'

    /** 用户改动过的安全区间（服务端也用这几个数夹取，两边一致）。 */
    const SCREEN_LIMITS = Object.freeze({
      scrim: [0, 0.8],
      blur: [0, 10],
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
    function parseHex(hex) {
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
    function toHex(rgb) {
      return `#${byte(rgb.r).toString(16).padStart(2, '0')}${byte(rgb.g).toString(16).padStart(2, '0')}${byte(rgb.b).toString(16).padStart(2, '0')}`
    }

    /** `rgba()` 字符串：壁纸接管用的 token 多数是半透明层。 */
    function rgba(rgb, alpha) {
      const a = Math.max(0, Math.min(1, Number(alpha) || 0))
      return `rgba(${byte(rgb.r)}, ${byte(rgb.g)}, ${byte(rgb.b)}, ${Math.round(a * 1000) / 1000})`
    }

    /**
     * WCAG 相对亮度（sRGB → 线性 → 加权）。这是对比度公式的中间量，
     * **不是**"看起来多亮"——所以取色时也算一次，观感与标准用的是同一个数。
     * @param {{ r: number, g: number, b: number }} rgb 0–255。
     * @returns {number} 0–1。
     */
    function relativeLuminance(rgb) {
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
    function contrastRatio(a, b) {
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
    function pickInk(bg) {
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
    function solveScrim(bg, ink, target, opts = {}) {
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
    function analyzePixels(data, opts = {}) {
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
      // 亮度分位数：平均色只说明"整体偏亮还是偏暗"，说明不了"画面里最亮的一块有多亮"。
      // 面板能不能做得很透，全看后者 —— 壁纸上那块最亮的区域正好垫在面板下面时，
      // 它才是最坏情况。用 p95/p5 取两端，比 max/min 稳（单点高光、字幕白边不算数）。
      const sorted = lums.slice().sort((x, y) => x - y)
      const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
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
        // 两端分位亮度（0–1 的 y，不是 0–255）。
        p95: pick(0.95),
        p05: pick(0.05),
        samples: count,
      }
    }

    /**
     * 从一串颜色直接出摘要（内置素材出厂预设可以写死几个代表色，省一次解码）。
     * @param {string[]} hexes
     * @returns {ReturnType<typeof analyzePixels>}
     */
    function analyzeColors(hexes) {
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
    function resolvePreset(tweak = {}) {
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
    function decideTheme(analysis, preset, opts = {}) {
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
        // 画面最亮/最暗那一档的亮度（取不到分位就退回平均亮度）。
        // 下游用它判断"面板能透到什么程度"：壁纸整体偏暗，就该让面板更透。
        p95: Number.isFinite(safe.p95) ? safe.p95 : safe.luminance,
        p05: Number.isFinite(safe.p05) ? safe.p05 : safe.luminance,
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

    function deriveTokens(decision, preset = {}, opts = {}) {
      const dark = opts.dark === true
      // 玻璃配方只出现在预设里（每套一套釉色）。预设没给釉色时不能拿**壁纸的画面色**
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
      // 地板色 = 预设的玻璃色经亮度钳制：色相听预设的（每套有自己的调子），亮度必须
      // 过 4.6:1 那条线。直接拿玻璃色当釉去混白/黑地板是不行的 —— 两者都往中间走，
      // 深色主题下白色釉在 0.59 的地板上只剩 `#333539`，比宿主原生底色还亮，
      // 五套预设于是糊成同一片灰，这就是"参数全拉低也看不见"。
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
      // 字色：按**实际对比度**验出来（谁清楚用谁），不是按面板亮度猜，也不是按主题猜。
      //
      // 这是"换预设就看不清"的最后一道闸：以前 clampSurfaceColor 按主题方向挑颜色，
      // 暗釉在浅色主题下会被顶到 `#5d6064`（白字 5.1:1 擦线），而擦线在真实界面上是
      // 不够的。现在颜色交给预设（保住色相），字色在这里按实测选 —— 面板够暗就上白字、
      // 够亮就上深字，两边都够不着的情况由 clampSurfaceColor 的 4.8:1 余量挡住。
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
      // 最坏壁纸色 = **这张壁纸**压过幕之后最亮/最暗的那一块（p95/p05），而不是纯黑/纯白。
      //
      // 之前按裸极端色反推，等于假设"壁纸随时可能是纯白"，面板就被算得死实 ——
      // 用户看到的就是"参数全拉到底，壁纸还是透不出来"。但壁纸是确定的：它最亮的
      // 那一块有多少亮度，是从画面里量出来的。按量出来的反推，暗壁纸的面板才敢做透。
      //
      // 兜底：没有画面摘要（视频还没解码）时退回纯极端色，宁可保守也不出错。
      //
      // 具体做法：把 p95/p05 这个 0–1 的亮度还原成一块 0–255 的灰（这才是"最亮那块
      // 长什么样"的近似），再压上同一层幕 —— 幕是按墨色方向加的，在两端颜色上
      // 只会把范围再收窄一点。
      const lumToRgb = (lum) => {
        const v = Math.round(Math.sqrt(clampRange(lum, [0, 1])) * 255)
        return { r: v, g: v, b: v }
      }
      const hasPercentiles = Number.isFinite(decision.p95) && Number.isFinite(decision.p05)
      const wallLo = mixColor(hasPercentiles ? lumToRgb(decision.p05) : { r: 0, g: 0, b: 0 }, decision.scrim, scrimRgb)
      const wallHi = mixColor(hasPercentiles ? lumToRgb(decision.p95) : { r: 255, g: 255, b: 255 }, decision.scrim, scrimRgb)
      const wallWorst = contrastRatio(wallLo, glassInk) <= contrastRatio(wallHi, glassInk) ? wallLo : wallHi
      // 列底能"藏"多少，由**玻璃厚度**决定 —— 这是它存在的唯一理由。
      //
      // 只看 4.5:1 的话，算出来的不透明度几乎永远落在下限（窗子太宽），滑杆也就永远
      // 看不出反应 —— 这正是用户说的"玻璃厚度没效果"。所以这里把玻璃厚度翻译成
      // **面板能藏住多少壁纸**：玻璃越厚，成品色越靠近玻璃色、越远离壁纸。
      //
      // 下限是 0：**出厂就是最透的那一档**（面板不盖、壁纸原样）。道理很简单 ——
      // 想看原样的壁纸，不该先把滑杆拖到底；遮挡是往"上"加，不是从满格往下减。
      //
      // glass = 0 时**不做任何安全反推**：用户明确要求"一点不盖"，这时候面板就该是
      // transparent。安全线不是删掉了，而是搬到了字底下的保险层（`dsa-wall-reading`）——
      // 面板可以全透，但字仍然压在 ≥4.5:1 的实底上。这个分工是整套观感的关键：
      // 一份面负责"看见壁纸"，另一份小面积的面负责"看清字"。
      const SHELL_MIN = 0
      const SHELL_MAX = 0.9
      const shellTarget = SHELL_MIN + clampRange(glassAlpha, [0, 1]) * (SHELL_MAX - SHELL_MIN)
      // 悬停/选中的高亮面：不参与可读性主线，但也不能是"纯白或纯黑"跳变 —— 壁纸越亮，
      // 高亮就该越淡，否则白面板上的白色悬停块会直接吞掉壁纸。
      const wallLum = relativeLuminance(parseHex(decision.tint) ?? g1Rgb(g1.final))
      const hoverAlpha = clampRange(0.1 - wallLum * 0.08, [0.02, 0.1])
      const hover = mixRgb(g1Rgb(g1.final), parseHex(decision.tint) ?? g1Rgb(g1.final), hoverAlpha)
      // 面板底色**跟壁纸主色走**，不是预设釉色。
      //
      // 为什么：釉色是白的时候（重磨砂），面板就是一层 46% 的白压在整个界面上，
      // 壁纸透上来先被掺白 —— 用户看到的就是"色彩灰蒙、不够鲜亮"。面板底色跟着壁纸主色，
      // 透上来的是**这颜色自己的加强版**，画面不褪色，字也仍然站在同一条色相当上。
      const wallBase = parseHex(decision.tint) ?? g1Rgb(g1.final)
      const wallAlpha = shellTarget <= 0.001
        ? 0
        : // 上限压在 0.9：到不了实色，永远留一点壁纸色。安全值想顶到 1 也不给 ——
          // 面板做全实色等于"没开壁纸"，那不是用户要的东西。
          Math.min(0.9, Math.max(shellTarget, solveWallAlpha(wallBase, glassInk, wallWorst)))
      // 面板实际用的颜色：壁纸主色按"墙面透明度"往预设釉色里掺一档，让五套预设仍有区分，
      // 但主调是壁纸自己的颜色。
      const sheetRgb = byte3(mixRgb(g1Rgb(g1.final), wallBase, 0.62))
      const ink = inkLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(14, 16, 22, 0.95)'
      const dim = inkLight ? 'rgba(255, 255, 255, 0.76)' : 'rgba(14, 16, 22, 0.70)'
      const faint = inkLight ? 'rgba(255, 255, 255, 0.58)' : 'rgba(14, 16, 22, 0.54)'
      // 面板背后要糊成什么样：把**真实壁纸色**按透底量掺进玻璃面 ——
      // 这就是面板后面看到的那层"壁纸雾"，也是五套预设肉眼能分开的最后一把力。
      //
      // 透底量跟着**列底实际留了多少空**走：列底 alpha=1（安全值推满）时壁纸本来就看不见，
      // 再把雾掺进去只是让颜色偏脏；列底很透时（玻璃厚度 0）壁纸才是画面主角。
      const frostRgb = byte3(mixRgb(g1Rgb(g1.final), parseHex(decision.tint) ?? g1Rgb(g1.final), clampRange(1 - wallAlpha, [0, GLASS_SHOW_THROUGH])))
      // 文字保险层：贴在文字后面的一块实底（气泡、选中行、输入框里）。
      //
      // 为什么需要它：面板做到 0.3 时，壁纸原样透上来 —— 那才是"看得清壁纸"。但字压在这层
      // 薄玻璃上，壁纸里一块亮区飘过去就可能把字吃掉。所以把"看画面"和"读文字"拆开：
      // 面板保持清澈，只在字底下垫一层接近实色的底。它对壁纸的遮挡面积小得多，
      // 视觉上仍是"壁纸铺满整个界面"，而字永远站在 ≥4.5:1 的面上。
      const reading = mixRgb(g1Rgb(g1.final), parseHex(dark ? FLOOR_BASE.dark : FLOOR_BASE.light) ?? g1Rgb(g1.final), 0.12)
      // 浮层色：除了"壁纸雾"，还有一条**离壁纸越远越白**的台阶。
      //
      // 只看雾的话，同釉色的几套面板完全一样，
      // 换预设只剩滑杆在动 —— 那正是"换预设看不出来"。所以浮层在雾的上面再按层级
      // 往地板色方向抬一点点：层 3 是菜单/弹层，最实也最亮；地图上它还是同一条色相，
      // 但肉眼能分出"浮起来了"。
      // 浮层色：除了"壁纸雾"，还有一条**离壁纸越远越向主题地板靠**的台阶。
      //
      // 只看雾的话，同釉色的几套面板完全一样，
      // 换预设只剩滑杆在动 —— 那正是"换预设看不出来"。所以浮层在雾的上面再按层级
      // 走一步：层 3 是菜单/弹层，离壁纸最远、最接近主题地板；层 1 还是壁纸雾本身。
      // 台阶只做一级（0 → 0.10 → 0.20），再多就成"三块不同的颜色"了。
      //
      // 方向**一律朝主题地板**：浅色主题往白抬、深色主题往暗压。反方向（浅色主题往下压暗）
      // 会让浮层比面板还深，弹窗看起来像凹进去的，而且暗色层上白字的余量也会被吃掉。
      const floorRgbForLift = parseHex(dark ? FLOOR_BASE.dark : FLOOR_BASE.light) ?? frostRgb
      const liftStep = (rgb, amount) => toHex(mixRgb(rgb, floorRgbForLift, clampRange(amount, [0, 1])))
      const frost2Hex = liftStep(frostRgb, 0.05)
      const frost3Hex = liftStep(frostRgb, 0.1)
      // 文字保险层多实：面板本身不够用时（wallAlpha 低于 0.6）才逐步实起来；
      // 面板本来就够实的时候（0.85 以上）它退到和面板一样，界面上不多一层"补丁"。
      const readingAlpha = clampRange(wallAlpha + (1 - wallAlpha) * 0.55, [0.5, 0.95])
      return {
        'dsa-wall-ink': ink,
        'dsa-wall-ink-dim': dim,
        'dsa-wall-ink-faint': faint,
        'dsa-wall-scrim': String(decision.scrim),
        'dsa-wall-glass-1': g1.final,
        'dsa-wall-glass-2': g1.final,
        'dsa-wall-glass-3': g1.final,
        'dsa-wall-glass-solid': toHex(mixRgb(g1Rgb(g1.final), parseHex(dark ? FLOOR_BASE.dark : FLOOR_BASE.light) ?? g1Rgb(g1.final), floor * 0.5)),
        'dsa-wall-frost': toHex(frostRgb),
        'dsa-wall-frost-2': frost2Hex,
        'dsa-wall-frost-3': frost3Hex,
        'dsa-wall-surface-blur': `${surfaceBlur}px`,
        // 浮层的模糊：层越高，透过它看到的壁纸越糊 —— 这才是"浮起来的"观感。
        'dsa-wall-blur-1': `${surfaceBlur}px`,
        'dsa-wall-blur-2': layerBlur(surfaceBlur, 1.25),
        'dsa-wall-blur-3': layerBlur(surfaceBlur, 1.5),
        'dsa-wall-accent': accent,
        // 三列的不透明度：`max(玻璃厚度, 安全性算出来的下限)`。
        // 玻璃厚度决定"面板藏住多少壁纸"，安全性决定"最少要藏多少"，取严的那个。
        'dsa-wall-wall-alpha': String(Math.round(wallAlpha * 100) / 100),
        'dsa-wall-wall': wallAlpha <= 0.001 ? 'transparent' : rgba(sheetRgb, wallAlpha),
        // 悬停/选中的高亮面：同样半透明，压在列底之上仍然透壁纸。
        'dsa-wall-hover': rgba(hover, 0.85),
        // 卡片式布局里那几块"实心卡片"的底色。
        //
        // 卡片内部要能放任何字（正文、气泡、菜单），所以它必须比列底更实：先把地板色压到
        // 0.92 的不透明度，再掺一点 glassTint 让每套预设仍有自己的调子。剩下的 8% 是给
        // 浮层做台阶用的（面板/卡片/菜单各差一档），不是留给壁纸透的 —— 壁纸的可见面积
        // 靠卡片之间的缝隙,不靠让卡片变透。
        'dsa-wall-card': toHex(mixRgb(floorRgbForLift, tintRgb ?? floorRgbForLift, 0.14)),
        'dsa-wall-card-alpha': '0.92',
        // 文字后面的实底：只有"壁纸透得太狠、字真的会看不清"时才实起来，
        // 其余时候跟着面板走（不能平白无故把气泡涂白）。
        'dsa-wall-reading': rgba(reading, readingAlpha),
        'dsa-wall-reading-alpha': String(Math.round(readingAlpha * 100) / 100),
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
     *   2. 釉色按 alpha 掺进地板色              → 面板的"釉"，五套预设在这一步分开
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
     * 保住色相的**方向**：五套预设仍是七种调子，只是亮度过线，不会糊成一片灰。
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
      // 判据是**掺完这层釉之后**的合成亮度：只要白字或黑字有一侧够 4.6:1 就放行。
      //
      // 这里刻意不按"主题方向优先"挑：那样会让暗釉色在浅色主题下被一路顶到 `#5d6064`
      // 这种擦着 5.1:1 的中间灰 —— 面板看着够，字却发虚（用户实测:同一张壁纸换到
      // 暗夜釉色/黑客绿/紫色心情就看不清）。**色相是预设的，字色是算出来的**，
      // 两件事分开之后，面板就能保住预设的颜色，字由到底用白还是黑来兜。
      const composedOf = (color) => relativeLuminance(mixRgb(mixRgb(color, rgb, alpha), backdrop, leak))
      const contrastPair = (lum) => ({ white: 1.05 / (lum + 0.05), black: (lum + 0.05) / 0.05 })
      const passes = (color) => {
        const { white, black } = contrastPair(composedOf(color))
        return Math.max(white, black) >= 4.6
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
        // 阈值 4.8 比 4.5 留余量：玻璃厚度拉到 0 时面板颜色就等于这儿返回的值，
        // 擦线的点遇上一轮 hex 取整就会掉回线下。
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
    function layerStyle(preset) {
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
    function sanitizeTweak(tweak = {}) {
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
// <<< INLINE lib/wallpaper.mjs

    const DICT_ZH = {
      nav: '启动动画',
      title: '开机动画',
      desc: '选好素材后点右上角「立即刷新」即可预览，无需重启。',
      enable: '显示开机动画',
      sound: '视频带声播放',
      asset: '启动画面素材',
      stockLabel: '内置动画',
      usingCustom: '自定义',
      usingBuiltin: '内置',
      catMp4: 'MP4',
      catWall: '壁纸',
      video: '视频',
      image: '图片',
      use: '使用',
      using: '使用中',
      // ── 主题（壁纸/视频铺进界面）──
      catTheme: '主题',
      wallpaper: '当壁纸',
      wallEnable: '界面壁纸',
      wallPreset: '观感预设',
      wallPresetHint: '一键套用整套配色',
      wallContrast: '当前文字对比度',
      wallScrim: '遮罩厚度',
      wallBlur: '壁纸模糊',
      wallSaturate: '色彩浓度',
      wallPick: '壁纸素材',
      wallUse: '当壁纸',
      wallUsing: '主题使用中',
      wallSaved: '已设为界面壁纸',
      removeBuiltin: '从列表移除（内置素材保留在包内）',
      removeUploaded: '删除文件',
      removed: '已从列表移除',
      deletedFile: '已删除上传的文件',
      deleteHidden: '文件被占用，已从列表隐藏（磁盘文件保留）',
      libraryDesc: '点卡片选用；悬停卡片右上角删除。',
      libEmpty: '这个分类目前没有可展示的素材',
      uploadInto: '上传视频',
      uploadWall: '上传壁纸',
      uploaded: '已上传 · 点卡片生效',
      duration: '展示时长',
      secUnit: ' 秒',
      audioEnable: '播放开机音频',
      audioNote: '动画期间播放所选音频；与「视频带声播放」相互独立，可以同时开。跳过动画时一起停止。',
      audioAsset: '音频素材',
      audioNone: '未选择',
      audioVolume: '音频音量',
      audioEmpty: '还没有音频 · 在下方"开机音频"分类里上传',
      catAudio: '音频',
      audioType: '音频',
      badgeUploaded: '上传',
      badgeBuiltin: '内置',
      audioUploaded: '已上传 · 点卡片生效',
      uploadAudio: '上传音频',
      upload: '选择文件…',
      restore: '恢复默认',
      uploading: '上传中…',
      saved: '已保存 · 点右上角「立即刷新」查看启动效果',
      restored: '已恢复内置动画 · 点右上角「立即刷新」生效',
      refresh: '立即刷新',
      tooBig: '文件太大（上限 128 MiB）',
      loadFail: '读取状态失败',
      netFail: '无法连接宿主',
      fail: '操作失败',
      versionLabel: 'v',
      updateChecking: '检查更新中…',
      updateLatest: '已是最新',
      updateUnknown: '检查不到更新',
      // ── 宠物（第三个页签；浮层与设置区的文案）──
      catPet: '宠物',
      petEnable: '显示桌面宠物',
      petEnableAll: '显示所有宠物',
      petSize: '宠物大小',
      petAction: '动作',
      petPick: '宠物',
      petWhere: '显示位置',
      petWherePage: 'DSH界面',
      petWhereGlobal: '全局界面',
      petUnit: '个动作',
      petRandom: '随机一个',
      petSearch: '搜索动作',
      petNoMatch: '没有匹配的动作',
      petNow: '正在演',
      petLoop: '循环',
      petOnce: '单次',
      petReset: '归位',
      petHide: '隐藏',
      petMenuActions: '动作',
      petEmpty: '没有找到宠物素材（builtin/宠物）',
      petSaved: '已保存',
      // ── 更新公告（第四个页签；正文来自 /update 带回的 Release body）──
      catRelease: '更新公告',
      annHead: 'v{version} 更新了什么',
      // ── 卸载 / 更新（v1.11.0）──
      uninstall: '卸载插件',
      uninstallConfirm: '确认卸载？插件会从 DSH 里移除，需要重启 DSH 才完全生效。你的设置与上传素材会保留在磁盘上。',
      uninstalling: '卸载中…',
      uninstalled: '已卸载 · 重启 DSH 后生效',
      uninstallFailed: '卸载失败',
      updateNow: '更新到 {version}',
      updating: '更新中…',
      updated: '已更新 · 重启 DSH 后生效',
      updateFailed: '更新失败',
      keepData: '设置与素材仍保留在 {path}',
      manageTitle: '卸载 / 更新',
      manageNote: '卸载会移除插件本身；设置与上传素材留在磁盘上，重装后还在。',
    }

    const DICT_EN = {
      nav: 'Startup Animation',
      title: 'Startup animation',
      desc: 'Pick your media, then click "Refresh now" (top right) to preview — no restart needed.',
      enable: 'Show the startup animation',
      sound: 'Play video with sound',
      asset: 'Startup visual',
      stockLabel: 'Built-in animation',
      usingCustom: 'Custom',
      usingBuiltin: 'Built-in',
      catMp4: 'MP4',
      catWall: 'Wallpaper',
      video: 'Video',
      image: 'Image',
      use: 'Use',
      using: 'In use',
      // ── Theme (video/image behind the UI) ──
      catTheme: 'Theme',
      wallpaper: 'Wallpaper',
      wallEnable: 'Interface wallpaper',
      wallPreset: 'Look preset',
      wallPresetHint: 'One tap applies the whole palette',
      wallContrast: 'Text contrast',
      wallScrim: 'Scrim',
      wallBlur: 'Blur',
      wallSaturate: 'Saturation',
      wallPick: 'Wallpaper media',
      wallUse: 'Use as wallpaper',
      wallUsing: 'Theme in use',
      wallSaved: 'Set as interface wallpaper',
      removeBuiltin: 'Remove from the list (the file stays in the package)',
      removeUploaded: 'Delete the file',
      removed: 'Removed from the list',
      deletedFile: 'Uploaded file deleted',
      deleteHidden: 'File in use — hidden from the list (file kept on disk)',
      libraryDesc: 'Click a card to apply it; hover a card to delete it.',
      libEmpty: 'No media left in this category',
      uploadInto: 'Upload video',
      uploadWall: 'Upload wallpaper',
      uploaded: 'Uploaded — click the card to apply',
      duration: 'Display duration',
      secUnit: ' s',
      audioEnable: 'Play startup audio',
      audioNote: 'Plays the picked audio during the animation. Independent of "Play video with sound" — both can be on at once. Skipping the animation stops it.',
      audioAsset: 'Audio clip',
      audioNone: 'None selected',
      audioVolume: 'Audio volume',
      audioEmpty: 'No audio yet — upload one in the Startup audio category below',
      catAudio: 'Audio',
      audioType: 'Audio',
      badgeUploaded: 'Uploaded',
      badgeBuiltin: 'Built-in',
      audioUploaded: 'Uploaded — click the card to apply',
      uploadAudio: 'Upload audio',
      upload: 'Choose file…',
      restore: 'Restore default',
      uploading: 'Uploading…',
      saved: 'Saved — click "Refresh now" (top right) to preview',
      restored: 'Restored to the built-in animation — click "Refresh now" to apply',
      refresh: 'Refresh now',
      tooBig: 'File too large (128 MiB max)',
      loadFail: 'Failed to read status',
      netFail: 'Cannot reach the host',
      fail: 'Action failed',
      versionLabel: 'v',
      updateChecking: 'Checking for updates…',
      updateLatest: 'Up to date',
      updateUnknown: 'Update check unavailable',
      // ── Pet (third tab; overlay + settings copy) ──
      catPet: 'Pet',
      petEnable: 'Show desktop pet',
      petEnableAll: 'Show all pets',
      petSize: 'Pet size',
      petAction: 'Actions',
      petPick: 'Pets',
      petWhere: 'Show on',
      petWherePage: 'DSH window',
      petWhereGlobal: 'Global',
      petUnit: 'actions',
      petRandom: 'Play a random one',
      petSearch: 'Search actions',
      petNoMatch: 'No matching action',
      petNow: 'Now playing',
      petLoop: 'loop',
      petOnce: 'once',
      petReset: 'Reset position',
      petHide: 'Hide',
      petMenuActions: 'Actions',
      petEmpty: 'No pet clips found (builtin/宠物)',
      petSaved: 'Saved',
      // ── What's new (fourth tab; body comes from the Release notes /update returns) ──
      catRelease: "What's new",
      annHead: 'What changed in v{version}',
      // ── Uninstall / update (v1.11.0) ──
      uninstall: 'Uninstall plugin',
      uninstallConfirm:
        'Uninstall? The plugin is removed from DSH; restart DSH for it to fully take effect. Your settings and uploaded media stay on disk.',
      uninstalling: 'Uninstalling…',
      uninstalled: 'Uninstalled · restart DSH to apply',
      uninstallFailed: 'Uninstall failed',
      updateNow: 'Update to {version}',
      updating: 'Updating…',
      updated: 'Updated · restart DSH to apply',
      updateFailed: 'Update failed',
      keepData: 'Settings and media stay in {path}',
      manageTitle: 'Uninstall / update',
      manageNote: 'Uninstalling removes the plugin itself; settings and uploads stay on disk.',
    }

    /** 三个分类的 accept：MP4 只收视频，壁纸只收图片，音频只收音频（后端仍按扩展名归类兜底）。 */
    const ACCEPT_BY_CATEGORY = {
      mp4: 'video/mp4,video/webm,video/ogg',
      wall: 'image/gif,image/apng,image/webp,image/png,image/jpeg',
      audio: 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/flac,audio/ogg,audio/opus',
      // 主题页签不接收上传（素材走上面两个分类），但上传 input 始终挂着，
      // 缺这个键会让 accept 变成 undefined（浏览器就什么都能选了）。
      theme: '',
    }
    /** 分类状态 → 包内目录 id（host scanLibrary 的分类键）。 */
    const CATEGORY_ID = { mp4: 'MP4', wall: '图片', audio: '音频' }

    const STYLE = `
/* ── 全局：壁纸开启时的"清晰区"（v1.26.8）──
   主题令牌是**全局**的，一改，设置页也跟着变：下拉、按钮、输入框全变成玻璃色，
   字也跟着翻面 —— 在设置页里调主题等于在看自己的倒影。

   所以凡是我们自己画的界面，一律按**原生外观**上色：底色与字色都读插件自己的
   --dsa-ui-* 变量（由壁纸层在开启时写入），而不是主题令牌。这些规则只落在
   [data-dsa-ui] 作用域里，绝不外溢到宿主界面。 */
.dsa-set-wrap {
  color: var(--dsa-ui-ink, var(--dsw-alias-label-primary));
  --dsa-ui-bg: var(--dsa-ui-bg-base, var(--dsw-alias-bg-base));
  --dsa-ui-layer: var(--dsa-ui-bg-layer, var(--dsw-alias-bg-layer-1));
  --dsa-ui-line: var(--dsa-ui-border, var(--dsw-alias-border-l1));
  --dsa-ui-ink-2: var(--dsa-ui-ink-dim, var(--dsw-alias-label-secondary));
  --dsa-ui-ink-3: var(--dsa-ui-ink-faint, var(--dsw-alias-label-tertiary));
}[data-dsa-ui] .dsa-set-title, [data-dsa-ui] .dsa-set-label { color: var(--dsa-ui-ink); }
[data-dsa-ui] .dsa-set-ver, [data-dsa-ui] .dsa-set-note { color: var(--dsa-ui-ink-3); }
[data-dsa-ui] .dsa-set-desc { color: var(--dsa-ui-ink-2); }
[data-dsa-ui] .dsa-set-tabs { background: var(--dsa-ui-layer); border-color: var(--dsa-ui-line); }
[data-dsa-ui] .dsa-set-tab { color: var(--dsa-ui-ink-2); }
[data-dsa-ui] .dsa-set-tab:hover, [data-dsa-ui] .dsa-set-tab[aria-selected="true"] { color: var(--dsa-ui-ink); }
[data-dsa-ui] .dsa-set-tab[aria-selected="true"] { background: var(--dsa-ui-bg); }
[data-dsa-ui] .dsa-set-segs { background: var(--dsa-ui-layer); border-color: var(--dsa-ui-line); }
[data-dsa-ui] .dsa-set-seg { color: var(--dsa-ui-ink-2); }
[data-dsa-ui] .dsa-set-seg:hover:not(:disabled), [data-dsa-ui] .dsa-set-seg[data-on="1"] { color: var(--dsa-ui-ink); }
[data-dsa-ui] .dsa-set-seg[data-on="1"] { background: var(--dsa-ui-bg); }
[data-dsa-ui] .dsa-set-row, [data-dsa-ui] .dsa-set-stack, [data-dsa-ui] .dsa-set-self { border-color: var(--dsa-ui-line); }
[data-dsa-ui] .dsa-set-btn { color: var(--dsa-ui-ink); background: var(--dsa-ui-layer); border-color: var(--dsa-ui-line); }
[data-dsa-ui] .dsa-set-btn:hover { background: var(--dsa-ui-bg); }
[data-dsa-ui] .dsa-set-knob { background: var(--dsa-ui-bg); }
/* 纵向滚动条会跟着主题变亮/变暗 —— 壁纸主题下它是一根浅色小棍，很扎眼。 */
.dsa-set-wrap ::-webkit-scrollbar-thumb { background: var(--dsa-ui-line); }

.dsa-set-wrap { display: flex; flex-direction: column; gap: 4px; }
.dsa-set-titlebar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 2px; }
.dsa-set-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.dsa-set-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
/* 版本小字：贴着标题，不抢视觉重量；有新版本时整个变成"就地更新"按钮。 */
.dsa-set-ver { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsa-set-ver[data-update="1"] { color: var(--dsw-alias-brand-primary); font-weight: 600; }
/* 更新按钮形态：和「立即刷新」同级的小药丸 —— 它现在是页面上的主行动点。 */
.dsa-set-ver-btn { font: inherit; font-size: 11.5px; padding: 4px 10px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); cursor: pointer; white-space: nowrap; transition: filter 120ms ease; }
.dsa-set-ver-btn:hover { filter: brightness(1.1); }
.dsa-set-ver-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 999px; }
.dsa-set-ver-btn:disabled { opacity: 0.55; cursor: default; }
.dsa-set-tabs { display: flex; gap: 4px; padding: 3px; margin: 14px 0 8px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; align-self: flex-start; }
.dsa-set-tab { font: inherit; font-size: 13px; padding: 6px 18px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.dsa-set-tab:hover { color: var(--dsw-alias-label-primary); }
.dsa-set-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsa-set-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* 分段选择（显示位置）：与页签同一套观感，但更紧凑 —— 它嵌在一行里，不是页面级导航。 */
.dsa-set-segs { display: flex; gap: 2px; padding: 2px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.dsa-set-seg { font: inherit; font-size: 12.5px; padding: 4px 12px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; transition: background 120ms ease, color 120ms ease; }
.dsa-set-seg:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsa-set-seg[data-on="1"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsa-set-seg:disabled { opacity: 0.45; cursor: default; }
.dsa-set-seg:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-panel { display: flex; flex-direction: column; }
.dsa-set-desc { font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); margin-bottom: 10px; max-width: 720px; }
.dsa-set-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsa-set-row:last-of-type { border-bottom: none; }
/* 动作区：标题行 + 整宽的卡片网格（动作数量跟着素材目录长，不用改代码）。 */
.dsa-set-stack { padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsa-set-stack-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dsa-set-label { font-size: 13.5px; color: var(--dsw-alias-label-primary); }
.dsa-set-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 3px; }
.dsa-set-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.dsa-set-switch { position: relative; width: 36px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0; transition: background 140ms ease; flex-shrink: 0; }
.dsa-set-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsa-set-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsa-set-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform 140ms ease; }
.dsa-set-switch[aria-checked="true"] .dsa-set-knob { transform: translateX(16px); }
.dsa-set-btn { font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.dsa-set-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-set-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-btn:disabled, .dsa-set-wrap[data-busy="1"] .dsa-set-btn { opacity: 0.55; cursor: default; pointer-events: none; }
/* 卸载是破坏性动作：和普通按钮区分开，但不用刺眼的红底（整行变红太吵）。 */
.dsa-set-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsa-set-btn-danger:hover { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); }
/* ── 卸载 / 更新 区（v1.11.0）── */
.dsa-set-self { margin: 14px 0 4px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsa-set-self-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dsa-set-status { min-height: 18px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); margin-top: 10px; }
.dsa-set-status[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.dsa-set-status[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); }
.dsa-set-sec { font-size: 13px; color: var(--dsw-alias-label-primary); min-width: 52px; text-align: right; font-variant-numeric: tabular-nums; }
.dsa-set-range { width: 180px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.dsa-set-range:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
/* 动作列表：一格一个动作，缩略图 + 名字；正在演的那个描边高亮。 */
.dsa-set-acts { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; margin-top: 12px; }
.dsa-set-act { display: flex; flex-direction: column; gap: 6px; align-items: stretch; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); font: inherit; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.dsa-set-act:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-set-act:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-act[data-on="1"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsa-set-act:disabled { opacity: 0.55; cursor: default; pointer-events: none; }
.dsa-set-act-thumb { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); display: block; }
.dsa-set-act-name { font-size: 13px; line-height: 1.4; }
.dsa-set-act-kind { font-size: 11.5px; line-height: 1.2; color: var(--dsw-alias-label-tertiary); }
/* 宠物卡：封面 + 名字 + 动作数 + 开关。外壳是容器，里面"选中"和"开关"各是一个按钮。 */
.dsa-set-pets { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; margin-top: 12px; }
.dsa-set-pet { position: relative; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); transition: border-color 120ms ease, background 120ms ease; }
.dsa-set-pet:hover { background: var(--dsw-alias-bg-layer-2); }
/* 选中的那只：描边主色。开着的卡用实线、关着的不抢眼（视觉上先分清"在不在显示"）。 */
.dsa-set-pet[data-on="1"] { border-color: var(--dsw-alias-brand-primary); }
.dsa-set-pet[data-live="0"] { opacity: 0.62; }
.dsa-set-pet-hit { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 8px; background: none; border: 0; border-radius: 10px; font: inherit; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; }
.dsa-set-pet-hit:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-pet-hit:disabled { opacity: 0.55; cursor: default; pointer-events: none; }
/* 开关压在封面右上角，不占卡片高度 */
.dsa-set-pet-switch { position: absolute; top: 8px; right: 8px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); }
.dsa-set-pet-cover { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); display: block; }
.dsa-set-pet-name { font-size: 13px; line-height: 1.4; }
.dsa-set-pet-count { font-size: 11.5px; line-height: 1.2; color: var(--dsw-alias-label-tertiary); }
/* 行标题右侧的一句小提示（多宠物时用来解释"点卡=看，开关=显示"） */
.dsa-set-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
/* 分类卡：动作多的包按分类挑，点一下随机演这个分类里的一个。 */
.dsa-set-cats { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; margin-top: 12px; }
.dsa-set-cat { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); font: inherit; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.dsa-set-cat:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-set-cat:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-cat[data-on="1"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsa-set-cat:disabled { opacity: 0.55; cursor: default; pointer-events: none; }
.dsa-set-cat-cover { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); display: block; }
.dsa-set-cat-name { font-size: 13px; line-height: 1.4; }
.dsa-set-cat-count { font-size: 11.5px; line-height: 1.2; color: var(--dsw-alias-label-tertiary); }
/* 搜索 + 结果 chip：一百多个动作时按名字找，命中的列成一行短标签。 */
.dsa-set-search { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.dsa-set-input { font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 10px; width: 100%; max-width: 320px; }
.dsa-set-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.dsa-set-chip { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 5px 10px; cursor: pointer; }
.dsa-set-chip-thumb { width: 22px; height: 22px; margin-left: -4px; object-fit: contain; border-radius: 50%; background: var(--dsw-alias-bg-layer-2); display: block; }
.dsa-set-chip:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-set-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-chip[data-on="1"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsa-set-chip:disabled { opacity: 0.55; cursor: default; pointer-events: none; }
.dsa-set-now { margin-top: 10px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.dsa-set-empty { font-size: 12.5px; color: var(--dsw-alias-label-tertiary); padding: 10px 0; }
/* ── 当前素材预览（设置区素材行）── */
.dsa-set-cur { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsa-set-cur-thumb { width: 88px; height: 50px; flex-shrink: 0; object-fit: cover; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); display: block; }
.dsa-set-cur-info { min-width: 0; }
.dsa-set-cur-name { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ── 素材卡片网格（点卡片即用）── */
.dsa-set-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px; margin-top: 10px; }
.dsa-set-card { position: relative; margin: 0; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); cursor: pointer; overflow: hidden; text-align: left; font: inherit; color: inherit; transition: border-color 120ms ease, transform 120ms ease; }
.dsa-set-card:hover { border-color: var(--dsw-alias-border-l2); }
.dsa-set-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsa-set-card[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); }
.dsa-set-card-hit { display: block; width: 100%; padding: 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsa-set-card-hit:disabled { cursor: default; }
.dsa-set-card-hit:focus-visible { outline: none; }
.dsa-set-card-media { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: var(--dsw-alias-bg-layer-2); }
.dsa-set-card-ph { display: flex; align-items: center; justify-content: center; width: 100%; aspect-ratio: 16 / 9; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsa-set-card-src { margin-left: 6px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dsa-set-card-name { display: block; padding: 7px 9px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsa-set-card-type { position: absolute; top: 7px; left: 7px; font-size: 11px; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); background: rgba(0, 0, 0, 0.55); border-radius: 6px; padding: 2px 7px; pointer-events: none; }
/* 角标：底色一律用深色半透明，字径用固定值 —— 品牌色在浅色主题下是亮蓝，
   白字压上去只有 3:1 左右，缩略图再亮一点就彻底糊了。 */
.dsa-set-card-using { position: absolute; top: 7px; left: 7px; font-size: 11px; font-weight: 600; color: #fff; background: rgba(0, 0, 0, 0.72); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 6px; padding: 2px 7px; pointer-events: none; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
.dsa-set-card-del { position: absolute; top: 6px; right: 6px; z-index: 2; width: 24px; height: 24px; display: none; align-items: center; justify-content: center; border: none; border-radius: 7px; background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 14px; line-height: 1; cursor: pointer; padding: 0; }
.dsa-set-card:hover .dsa-set-card-del, .dsa-set-card:focus-within .dsa-set-card-del { display: flex; }
.dsa-set-card-del:hover { background: var(--dsw-alias-state-error-primary); }
.dsa-set-card-del:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* 音频卡片：与壁纸同款网格 —— 16:9 画面区放音乐图标（无封面）；试听/删除都悬停才出现。 */
.dsa-set-amedia { display: flex; align-items: center; justify-content: center; width: 100%; aspect-ratio: 16 / 9; background: radial-gradient(420px 260px at 50% 42%, #131a2e, #05070d 78%); color: rgba(255, 255, 255, 0.5); font-size: 40px; }
.dsa-set-aplay { position: absolute; left: 50%; top: calc(50% - 14px); transform: translate(-50%, -50%); width: 40px; height: 40px; display: none; align-items: center; justify-content: center; border: none; border-radius: 50%; background: rgba(0, 0, 0, 0.5); color: #fff; font-size: 15px; cursor: pointer; padding: 0; transition: background 120ms ease; }
/* 平时不显示（与壁纸卡片观感一致）；悬停/聚焦出现；正在播放时常显（知道哪条在响、可随时停）。 */
.dsa-set-card:hover .dsa-set-aplay, .dsa-set-card:focus-within .dsa-set-aplay, .dsa-set-aplay[data-on="1"] { display: flex; }
.dsa-set-aplay:hover { background: var(--dsw-alias-brand-primary); }
.dsa-set-aplay:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
/* ── 主题页签：预设九宫格 ── */
/* 每格都是一张"迷你界面"：底色是当前壁纸、字色是预设算出来的墨色。
   九宫格（auto-fill 自适应）与素材卡片同一套栅格节拍，视觉上属于同一个页面。 */
.dsa-set-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; margin-top: 12px; }
.dsa-set-preset { position: relative; display: flex; flex-direction: column; gap: 5px; padding: 8px 8px 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); cursor: pointer; text-align: left; font: inherit; color: inherit; transition: border-color 120ms ease; }
.dsa-set-preset:hover { border-color: var(--dsw-alias-border-l2); }
.dsa-set-preset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsa-set-preset[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); }
/* 预览块：底纹模仿"壁纸 + 幕"，上面的 Aa 就是读者会看到的字色。 */
.dsa-set-preset-art { position: relative; display: flex; align-items: center; justify-content: center; height: 34px; border-radius: 6px; overflow: hidden;
  background: repeating-linear-gradient(115deg, #4a6b8a 0 6px, #2b3a55 6px 12px, #7c93b8 12px 18px); }
.dsa-set-preset-scrim { position: absolute; inset: 0; }
.dsa-set-preset-ink { position: relative; font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
.dsa-set-preset-name { font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsa-set-preset-ratio { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* 卡片右上角的「当壁纸」：与删除键同位置节拍，悬停才出现（平时别抢视线）。 */
/* 删除键在右上角，壁纸键让到它左边 —— 两个都在悬停时出现，不能叠在一起。 */
/* ── 更新公告（Release 正文渲染：抬头 + 小标题 + 要点条目）── */
.dsa-set-ann { display: flex; flex-direction: column; gap: 6px; max-width: 720px; }
.dsa-set-ann-head { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsa-set-ann-h { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsa-set-ann-item { position: relative; padding-left: 15px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dsa-set-ann-item::before { content: ''; position: absolute; left: 4px; top: 8px; width: 4px; height: 4px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.dsa-set-ann-text { font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
`

    /**
     * 页面共用的状态获取/写回。GET 拉状态；所有写操作 POST/DELETE 后统一用回包刷新。
     * 设置区与两个分类共享同一份状态 —— 切分类不重新拉取。
     * @param {(key: string) => string} t 翻译。
     * @returns {{ state: object | null, busy: boolean, message: { text: string, kind: string }, setMessage: Function, send: Function }} 页面状态。
     */
    function useStatus(t) {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState({ text: '', kind: '' })

      React.useEffect(() => {
        let alive = true
        fetch(MANAGE, { cache: 'no-store' })
          .then((res) => res.json())
          .then((payload) => {
            if (!alive) return
            if (payload && payload.ok) setState(payload)
            else setMessage({ text: (payload && payload.error) || t('loadFail'), kind: 'error' })
          })
          .catch(() => {
            if (alive) setMessage({ text: t('loadFail'), kind: 'error' })
          })
        return () => {
          alive = false
        }
      }, [])

      /**
       * 发一个管理请求。
       * @param {RequestInit} init 请求参数。
       * @param {string | ((payload: object) => string)} successText 成功文案（可传函数按回包定制）。
       * @returns {Promise<object | null>} 回包；网络失败为 null。
       */
      const send = (init, successText) => {
        setBusy(true)
        setMessage({ text: '', kind: '' })
        return fetch(MANAGE, init)
          .then((res) => res.json().catch(() => null))
          .then((payload) => {
            setBusy(false)
            if (payload && payload.ok) {
              setState(payload)
              // 壁纸背景层是常驻的独立实例，不共享 React 状态 —— 任何一次写操作回包都
              // 顺手广播一次，换预设/换素材/开关才不用等刷新页面才生效。
              // 回包与当前画面一致时由背景层的 sameAs 短路，不会白算。
              if (payload.wallpaper) {
                window.dispatchEvent(new CustomEvent('dsa:wall-sync', { detail: payload.wallpaper }))
              }
              setMessage({
                // 成功文案可以是函数：按回包内容区分（如"已删除" vs "被占用仅隐藏"）。
                text: typeof successText === 'function' ? successText(payload) : successText,
                kind: 'ok',
              })
            } else {
              setMessage({ text: (payload && payload.error) || t('fail'), kind: 'error' })
            }
            return payload
          })
          .catch(() => {
            setBusy(false)
            setMessage({ text: t('netFail'), kind: 'error' })
            return null
          })
      }

      return { state, busy, message, setMessage, send }
    }

    /** 更新检查的强制窗口：同一会话 60 秒内只强制一次。 */
    const UPDATE_FORCE_KEY = 'dsa:update-forced-at'
    const UPDATE_FORCE_WINDOW_MS = 60000

    /**
     * 这次更新检查要不要 `?force=1`（绕过宿主 15 分钟缓存）。
     *
     * 存储不可用时（自定义协议、隐私模式）退回"每次都强制" —— 那是改动前的
     * 行为，宁可多打一次请求，也不要让功能在环境受限时静默退化。
     * @returns {boolean} 是否强制。
     */
    function shouldForceUpdateCheck() {
      try {
        const last = Number(window.sessionStorage.getItem(UPDATE_FORCE_KEY) || 0)
        if (Number.isFinite(last) && Date.now() - last < UPDATE_FORCE_WINDOW_MS) return false
        window.sessionStorage.setItem(UPDATE_FORCE_KEY, String(Date.now()))
        return true
      } catch {
        return true
      }
    }

    /**
     * 版本 + 更新检查状态。
     *
     * 设计取舍：
     *   - **不阻塞页面**：先渲染"版本 x.y.z"，更新检查在后台跑，回来再补提示；
     *   - **失败不报错**：离线/墙内/GitHub 挂了都只显示"检查不到更新"，
     *     因为这只是个提示，不该让设置页看起来像坏了；
     *   - 检查结果由宿主的 `/update` 端点给出。打开设置页**强制查一次**
     *     （`?force=1`）：宿主那层有 15 分钟缓存，用它兜底会让"刚发了新版"
     *     的用户在缓存窗口里看到"已是最新" —— 这个按钮存在的意义就没了。
     *     但不在 60 秒内重复强制：反复开关设置页会把 GitHub 匿名配额（60 次/小时）
     *     刷光，之后所有用户都只能看到"检查不到更新"，比缓存陈旧更糟。
     *
     * @param {(key: string) => string} t 翻译。
     * @returns {{ version: string, update: object | null, checking: boolean, reload: (options?: { force?: boolean, silent?: boolean }) => Promise<object | null> }} 版本状态。
     */
    function useVersionInfo(t) {
      const [version, setVersion] = React.useState('')
      const [update, setUpdate] = React.useState(null)
      const [checking, setChecking] = React.useState(true)

      /**
       * 重新取版本与更新状态。
       *
       * `force` 同时绕过两层缓存：宿主 `/update` 的（15 分钟）和客户端的 60 秒节流。
       * 一键更新之后必须用它 —— 否则刷新回来的还是"有新版本"的旧结论，
       * 界面看起来像更新失败了。
       * `silent` 不显示"检查更新中"：更新刚成功时不该先闪一下加载态再变好。
       *
       * @param {{ force?: boolean, silent?: boolean }} [options] 选项。
       * @returns {Promise<object | null>} 回包（失败为 null）。
       */
      const reload = (options) => {
        const force = options !== undefined && options.force === true
        const silent = options !== undefined && options.silent === true
        if (!silent) setChecking(true)
        const query = force || shouldForceUpdateCheck() ? '?force=1' : ''
        return fetch(`${UPDATE}${query}`, { cache: 'no-store' })
          .then((res) => res.json())
          .then((payload) => {
            setChecking(false)
            if (payload && typeof payload === 'object') {
              if (typeof payload.version === 'string' && payload.version !== '') setVersion(payload.version)
              if (typeof payload.current === 'string' && payload.current !== '') setVersion(payload.current)
              setUpdate(payload)
            }
            return payload
          })
          .catch(() => {
            setChecking(false)
            return null
          })
      }

      React.useEffect(() => {
        void reload()
        // 只在挂载时查一次：reload 是稳定引用（不依赖任何 state），不用进依赖表。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      return { version, update, checking, reload }
    }

    /** POST 一个 JSON 载荷（开关/时长/素材库操作共用），返回 send 的 Promise。 */
    function postJson(send, body, okText) {
      return send(
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        okText,
      )
    }

    const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|ogg)$/i

    /**
     * 显示用文件名：去掉扩展名（.mp4/.jpg 等一律不显示；后台配置与请求仍用完整路径）。
     * @param {string} name 原始文件名。
     * @returns {string} 无扩展名显示名。
     */
    function displayName(name) {
      const text = String(name ?? '')
      const dot = text.lastIndexOf('.')
      return dot > 0 ? text.slice(0, dot) : text
    }

    /**
     * 视频时长标签：`8s` / `24s` / `1:05`。
     *
     * 不足一分钟只写秒（启动动画本来就短，`8s` 比 `0:08` 好读）；
     * 超过一分钟才用分:秒。向上取整：播放器里 0.6 秒也会被当成"1 秒"，
     * 标成 `16.1s` 反而让人以为素材没播完。
     * @param {number} seconds 时长（秒，宿主从 MP4 的 mvhd 读出来的）。
     * @returns {string} 标签文本。
     */
    function durationLabel(seconds) {
      const total = Math.max(1, Math.round(seconds))
      if (total < 60) return `${total}s`
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }

    /**
     * `<img>` 的浏览器端解码缓存上限约 20–30 MB（取决于设备与是否 2D canvas）：
     * 内置壁纸动辄 1600×2848 起（单张解码 ≈ 18–35 MB），7 张卡片一次性加载就会
     * 把早先的图片移出缓存、表现为卡片"破图"或整页发卡。卡片只显示 16:9 的小格子，
     * 所以卡片与小预览一律请求服务端缩略图（`&thumb=1`，内置素材有预生成的 480px
     * JPEG；用户上传的图片由宿主回落到原图）。
     * @param {string} path 素材引用（内置 rel 或 media 绝对路径）。
     * @returns {string} 带缩略图参数的 URL。
     */
    function thumbSrc(path) {
      return `${ASSET}?path=${encodeURIComponent(path)}&thumb=1`
    }

    /**
     * 素材 URL 追加一个查询参数（`?` 还是 `&` 取决于已有的 query）。
     *
     * 卡片传进来的 `src` 已经带 `?path=...`，直接再拼 `?poster=1` 会得到
     * 两个 `?`、参数被吞掉 —— 手工封面就永远探测不到。
     * @param {string} src 已有 URL。 @param {string} param 形如 `poster=1`。
     * @returns {string} 追加后的 URL。
     */
    function withParam(src, param) {
      return `${src}${src.includes('?') ? '&' : '?'}${param}`
    }

    /**
     * 视频封面取帧点：在 25% / 50% / 75% 三个候选位置里，选**画面最亮**的那一帧。
     *
     * 为什么不能固定取首帧：素材常从黑场淡入（前一两秒几乎全黑），
     * 固定取 0.1s 会得到一张纯黑卡片，看起来像素材坏了。也不能只取中点 ——
     * 中间恰好是转场/黑场的视频同样会黑。
     *
     * 做法：把三帧各画到一张 32×18 的小画布上，算平均亮度，选亮的那个。
     * 纯前端、无额外请求（复用同一个 <video> 资源），失败就退回原来的首帧行为。
     *
     * @param {HTMLVideoElement} video 已加载元数据的视频元素。
     * @returns {Promise<number | null>} 选中的秒数；无法判断时 null。
     */
    async function pickCoverTime(video) {
      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0.4) return null
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 18
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx === null) return null

      /** 等到 seek 落定。每次 seek 只触发一次 seeked。 */
      const seekTo = (time) =>
        new Promise((resolve) => {
          let done = false
          let timer = null
          const finish = () => {
            if (done) return
            done = true
            if (timer !== null) clearTimeout(timer)
            video.removeEventListener('seeked', finish)
            resolve()
          }
          video.addEventListener('seeked', finish)
          // 兜底：某些编码 seek 卡住时别把整页吊死。
          timer = setTimeout(finish, 1200)
          try {
            video.currentTime = time
          } catch {
            finish()
          }
        })

      // 候选：避开最开头（常是黑场）和最末尾（可能是淡出/留白）。
      const candidates = [duration * 0.25, duration * 0.5, duration * 0.75]
      let best = null
      let bestScore = -1
      for (const time of candidates) {
        await seekTo(time)
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
          let sum = 0
          for (let i = 0; i < data.length; i += 4) {
            sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
          }
          const score = sum / (data.length / 4)
          if (score > bestScore) {
            bestScore = score
            best = time
          }
        } catch {
          /* 跨域/解码失败：当作这一帧不可用 */
        }
      }
      // 三帧都太暗（整段就是暗色调素材）时也不要瞎选，交给调用方保底。
      if (best === null || bestScore < 8) return null
      return best
    }

    /**
     * 缩略图预览元素。图片直接显示；视频用「亮度采样」自动挑一帧当封面。
     * 加载失败回调 onBroken（卡片隐藏媒体块占位，当前预览退回文字行）。
     * @param {string} path 素材引用。
     * @param {boolean} isVideo 按扩展名判定。
     * @param {string} cls 媒体元素 class。
     * @param {(event: any) => void} onBroken 加载失败处理。
     * @returns {any} video/img 元素。
     */
    function thumbEl(path, isVideo, cls, onBroken) {
      const src = thumbSrc(path)
      if (!isVideo) {
        return h('img', {
          className: cls,
          src,
          loading: 'lazy',
          decoding: 'async',
          alt: '',
          'aria-hidden': true,
          onError: onBroken,
        })
      }
      return h(VideoCover, { className: cls, src, onBroken })
    }

    /**
     * 视频封面：有手工封面就用它，没有才用「亮度采样」自动挑一帧。
     * 探测（HEAD）出结果之前**什么都不画** —— 以前默认按"有封面"先挂一张
     * `<img src="…?poster=1">`，而没有手工封面时那个 URL 回的是视频本体，
     * 浏览器得先下一段视频才判定解码失败：卡片于是先空一秒、再突然出现画面。
     */
    function VideoCover(props) {
      const ref = React.useRef(null)
      const [poster, setPoster] = React.useState('')
      const manualPoster = withParam(props.src, 'poster=1')
      // null = 还在探测；false = 没有手工封面，走自动挑帧。
      const [hasManual, setHasManual] = React.useState(null)
      React.useEffect(() => {
        const video = ref.current
        if (!video || hasManual !== false) return undefined
        let alive = true
        const onMeta = () => {
          void (async () => {
            const time = await pickCoverTime(video)
            if (!alive || time === null) return
            try {
              video.currentTime = time
            } catch {
              /* 保持原位 */
            }
            // 把当前帧冻成 poster，之后再把画面收回第一帧也不影响展示，
            // 同时避免卡片在列表里持续解码视频。
            try {
              const canvas = document.createElement('canvas')
              canvas.width = video.videoWidth || 320
              canvas.height = video.videoHeight || 180
              const ctx = canvas.getContext('2d')
              if (ctx !== null && canvas.width > 0 && canvas.height > 0) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                if (alive) setPoster(canvas.toDataURL('image/jpeg', 0.8))
              }
            } catch {
              /* 出不来 poster 也无所谓，视频本身就停在好那帧上 */
            }
          })()
        }
        video.addEventListener('loadedmetadata', onMeta)
        if (video.readyState >= 1) onMeta()
        return () => {
          alive = false
          video.removeEventListener('loadedmetadata', onMeta)
        }
      }, [props.src, hasManual])

      // 先探测一次手工封面是否存在（HEAD，只回一个头，不下载内容）。
      React.useEffect(() => {
        let alive = true
        fetch(manualPoster, { method: 'HEAD', cache: 'no-store' })
          .then((res) => {
            if (alive) setHasManual(res.ok)
          })
          .catch(() => {
            if (alive) setHasManual(false)
          })
        return () => {
          alive = false
        }
      }, [manualPoster])

      // 探测期间占位（保持卡片尺寸，不画任何媒体元素）。
      if (hasManual === null) return h('div', { className: props.className, 'aria-hidden': true })

      if (hasManual) {
        return h('img', {
          className: props.className,
          src: manualPoster,
          loading: 'lazy',
          decoding: 'async',
          alt: '',
          'aria-hidden': true,
          // 探测成功但取图失败（文件被删等）→ 退回自动挑帧。
          onError: () => setHasManual(false),
        })
      }

      return h('video', {
        ref,
        className: props.className,
        src: `${props.src}#t=0.1`,
        poster: poster || undefined,
        preload: 'metadata',
        muted: true,
        playsInline: true,
        'aria-hidden': true,
        onError: props.onBroken,
      })
    }

    /**
     * GitHub Release 正文（markdown）→ 「更新公告」要渲染的行。
     *
     * 公告内容**不在代码里抄一份**：Release 正文就是更新记录的唯一事实来源，
     * `/update` 检查更新时顺手把它带回来（不额外发请求），这里只做三件事：
     *   1. 去掉 markdown 装饰（标题符号、加粗、行内代码、链接、图片）——设置页不渲染富文本；
     *   2. 丢掉代码块与表格：公告是"这次改了什么"，命令示例属于安装说明；
     *   3. 碰到「安装 / Install」标题就停 —— 后面是下载链接，不是本次更新内容。
     * Release 标题行（`开机动画 v1.12.0`）与面板抬头重复，跳过。
     *
     * 解析不出内容（离线、还没有 Release、正文为空）返回 []，调用方按
     * "检查不到更新"显示 —— 公告是锦上添花，不该让设置页看起来像坏了。
     *
     * @param {string} [raw] Release 正文。
     * @returns {{ kind: 'head' | 'item' | 'text', text: string }[]} 渲染行。
     */
    function parseReleaseNotes(raw) {
      /** 去 markdown 装饰，只留可读文字。 */
      const plain = (text) =>
        text
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/`([^`]*)`/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
          .replace(/<[^>]+>/g, '')
          .trim()

      const lines = []
      let inFence = false
      for (const line of String(raw ?? '').split(/\r?\n/)) {
        const text = line.trim()
        if (text.startsWith('```')) {
          inFence = !inFence
          continue
        }
        if (inFence || text === '') continue
        const heading = /^#{1,6}\s+(.*)$/.exec(text)
        if (heading !== null) {
          const title = plain(heading[1])
          // 注意：**不能用 \b** —— 中文字符不是"词"，`安装` 后面接行尾没有词边界。
          if (/^(安装|install)/i.test(title)) break
          if (/^(开机动画|startup animation)\s*v\d/i.test(title)) continue
          if (title !== '') lines.push({ kind: 'head', text: title })
          continue
        }
        if (text.startsWith('|')) continue // 表格行：公告里不占位置
        const bullet = /^[-*+]\s+(.*)$/.exec(text) ?? /^\d+[.)]\s+(.*)$/.exec(text)
        const body = bullet === null ? plain(text) : plain(bullet[1])
        if (body === '' || /^https?:\/\/\S+$/.test(body)) continue
        lines.push({ kind: bullet === null ? 'text' : 'item', text: body })
      }
      return lines
    }

    // ──────────────────────────────────────────────────────────────
    // 宠物浮层
    // ──────────────────────────────────────────────────────────────

    /** 待机多久演一个小动作：固定 15 秒，**动作本身随机挑**（这样每只宠物的节奏一致）。 */
    const PET_IDLE_MS = 15000
    /** 动作演完到回待机的停顿：直接跳回待机会在最后一帧上"啪"地一闪。 */
    const PET_RETURN_MS = 550

    /**
     * 甩抛物理：松手后按手部速度飞出去，撞视口边缘反弹，衰减到停下。
     *
     * 四个数值都是手调的手感，不是物理常数：
     * - `SPEED_KEEP` 每秒保留多少速度，决定"能飞多远、弹几下"；
     * - `BOUNCE` 撞墙后保留多少速度（0.82 ≈ 撞五次还剩三成，弹得很"活"）；
     * - `STOP` 低于这个速度（px/ms）就算停了，避免无限拖一条零头在飘；
     * - `MAX` 速度上限，防止一次抽搐把宠物甩到屏幕另一头。
     */
    const PET_SPEED_KEEP = 0.16
    const PET_BOUNCE = 0.82
    const PET_STOP_SPEED = 0.06
    const PET_MAX_SPEED = 4
    /** 取样窗口：只拿最近这段的手部位移算速度 —— 松手前停住不动就不该起飞。 */
    const PET_VELOCITY_WINDOW_MS = 100

    /** 浮层样式。挂 body 的常驻元素，不走组件局部样式，单独注入一份 <style>。 */
    const PET_STYLE = `
.dsa-pet { position: fixed; left: 0; top: 0; z-index: 999999; pointer-events: none; }
.dsa-pet[data-on="0"] { display: none; }
.dsa-pet-stage { position: relative; width: 100%; pointer-events: auto; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; transform-origin: 50% 88%; transition: transform 210ms cubic-bezier(.22, 1.4, .36, 1); }
.dsa-pet-stage[data-drag="1"] { cursor: grabbing; transition: none; }
/* 两只 video 叠在同一格交替：切换只改 opacity。一次只挂两段素材 —— 全建元素会一口气解码几十 MB。 */
.dsa-pet-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 160ms linear; pointer-events: none; }
.dsa-pet-video[data-on="1"] { opacity: 1; }
/* 右键菜单：跟随应用深浅色（同一份文档，--dsw-alias-* 全局可用）。 */
.dsa-pet-menu { position: fixed; z-index: 1000000; min-width: 150px; max-height: 62vh; overflow: auto; overscroll-behavior: contain; padding: 6px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16); }
.dsa-pet-menu-head { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); padding: 4px 8px 2px; }
.dsa-pet-menu-item { display: block; width: 100%; text-align: left; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary, #333); background: none; border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; white-space: nowrap; }
.dsa-pet-menu-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12)); }
.dsa-pet-menu-item[data-on="1"] { color: var(--dsw-alias-brand-primary, #4b6bfb); }
.dsa-pet-menu-sep { height: 1px; margin: 5px 6px; background: var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.25)); }
/* 二级菜单的返回行：看起来像标题，点一下回上一级 */
.dsa-pet-menu-back { display: block; width: 100%; text-align: left; font: inherit; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #666); background: none; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.25)); padding: 4px 8px 6px; margin-bottom: 3px; cursor: pointer; white-space: nowrap; }
.dsa-pet-menu-back:hover { color: var(--dsw-alias-label-primary, #333); }
.dsa-pet-menu-count { color: var(--dsw-alias-label-tertiary, #999); font-size: 11px; margin-left: 4px; }
`

    /**
     * 一只宠物的浮层实例。
     *
     * 为什么不用 React：它挂在 `document.body` 上，生命周期跨整个应用，和设置页的
     * 渲染树没有关系（关掉设置页宠物还在）。原生 DOM 让"进设置页才创建、退出就
     * 销毁"这类错误不可能发生，也省掉一次 createRoot。
     *
     * 一只 = 一个 host + 一个舞台 + 两个 video 槽位 + 一套自己的节奏与物理状态。
     * 多只同屏就是多个实例，彼此不共享任何可变状态（大小除外，那是全局的）。
     *
     * 节奏：待机动作循环；每隔 15–35 秒随机演一个分类里的动作，演完回待机；
     * 左键随机回应、拖拽时循环"拖拽悬空"、右键按分类点播。
     *
     * 位置口径：`x/y` 是 0–100 的百分比，表示"在可移动区间里的比例"
     * （0 = 贴左/贴上，100 = 贴右/贴下），所以窗口缩放后宠物仍然贴着同一角，
     * 也不会跑到屏幕外。像素位置 = 百分比 × (视口 − 宠物尺寸)。
     *
     * @param {{ entry: object, size: number, t: (key: string) => string, onPersist: (patch: object) => void, onMenuOpen: () => void }} options
     *   入口配置（宠物包 + 它的位置）、共用大小、文案、落盘回调、开菜单前通知外层。
     * @returns {{ update: (entry: object) => void, setSize: (size: number) => void, play: (id: string) => void, playCategory: (id: string) => void, random: () => void, report: () => void, reset: () => void, closeMenu: () => void, destroy: () => void }} 实例控制器。
     */
    function createPetInstance(options) {
      const onPersist = options.onPersist
      const t = options.t
      /** 这只宠物的包（每次 sync 换成最新的那份对象，内容不变时不动 DOM）。 */
      let entry = options.entry
      /** @type {HTMLStyleElement | null} */
      let styleEl = null
      /** @type {HTMLDivElement | null} */
      let host = null
      /** @type {HTMLDivElement | null} */
      let stage = null
      /** @type {HTMLVideoElement[]} 两个槽位：一个在演，一个在预载下一段。 */
      const videos = []
      let active = 0
      /** 已构建的包指纹：换宠物（或素材数变了）才重置 DOM。 */
      let builtKey = ''
      /** 这一只自己的位置与大小（大小是全层共用的，由 setSize 推下来）。 */
      let pet = { size: options.size, x: entry.x, y: entry.y }
      /** @type {any} 当前宠物包（宿主给的完整结构）。 */
      let pack = null
      let currentId = ''
      let mode = 'idle'
      /** 随机待机计时器（0 = 没排）。 */
      let ambienceTimer = 0
      /** "演完了回待机"的计时器。 */
      let returnTimer = 0
      let lastRandomId = ''
      /** @type {{ id: number, dx: number, dy: number, startX: number, startY: number, moved: boolean, samples: { x: number, y: number, t: number }[] } | null} */
      let drag = null
      /** @type {{ vx: number, vy: number, raf: number, last: number } | null} 松手后的惯性飞行。 */
      let flight = null
      let frame = 0
      /** @type {HTMLDivElement | null} 右键菜单（同一时刻至多一个）。 */
      let menu = null
      /** @type {HTMLAudioElement | null} 点击音效（复用一个元素：连点不会叠成一片）。 */
      let clickAudio = null

      /** 注入一次样式（重复调用安全）。 */
      const ensureStyle = () => {
        if (styleEl !== null) return
        styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsa-pet', '')
        styleEl.textContent = PET_STYLE
        document.head.appendChild(styleEl)
      }

      const clipById = (id) => {
        if (pack === null) return null
        return pack.clips.find((clip) => clip.id === id) ?? null
      }
      const idleId = () => {
        if (pack === null) return ''
        if (clipById(pack.roles.idle) !== null) return pack.roles.idle
        return pack.clips.length > 0 ? pack.clips[0].id : ''
      }
      const clipsOf = (ids) => (Array.isArray(ids) ? ids.map(clipById).filter((clip) => clip !== null) : [])
      /** 参与随机待机的动作：分类里有、但不是"事件"类（余额/工作/睡觉随机出现会很怪）。 */
      const ambientClips = () => {
        if (pack === null) return []
        const eventIds = ['balance', 'whisper', 'work', 'sleep', 'other']
        const wanted = Array.isArray(pack.ambient) && pack.ambient.length > 0
          ? pack.ambient
          : pack.categories.map((category) => category.id).filter((id) => !eventIds.includes(id))
        const clips = pack.categories
          .filter((category) => wanted.includes(category.id))
          .flatMap((category) => clipsOf(category.clips))
        if (clips.length > 0) return clips
        return pack.clips.filter((clip) => clip.id !== idleId() && clip.id !== pack.roles.drag)
      }
      /** 随机取一个，尽量不连着演同一个。 */
      const randomClip = (clips) => {
        if (clips.length === 0) return null
        const pool = clips.length > 1 ? clips.filter((clip) => clip.id !== lastRandomId) : clips
        const picked = pool[Math.floor(Math.random() * pool.length)] ?? clips[0]
        lastRandomId = picked.id
        return picked
      }

      const clearAmbience = () => {
        if (ambienceTimer !== 0) {
          window.clearTimeout(ambienceTimer)
          ambienceTimer = 0
        }
      }
      const clearReturn = () => {
        if (returnTimer !== 0) {
          window.clearTimeout(returnTimer)
          returnTimer = 0
        }
      }

      /**
       * 按当前宠物包准备 DOM：宿主、舞台、两只 video。
       *
       * 只建一次。换宠物时会清掉 video 的 src，但**保留元素** —— 重建元素意味着
       * 重新申请解码器，切换宠物时会白屏一下。
       */
      const build = () => {
        const next = entry
        const key = `${next.id}:${next.clips.length}:${next.canvas.join('x')}`
        if (key === builtKey) {
          // 内容没变（每次回包都是新对象）：更新引用就够了，别重建 DOM。
          pack = next
          return
        }
        builtKey = key
        pack = next
        clearAmbience()
        clearReturn()
        stopFlight()
        currentId = ''
        mode = 'idle'
        lastRandomId = ''
        if (pack === null) {
          if (host !== null) host.dataset.on = '0'
          return
        }
        ensureStyle()
        if (host === null) {
          host = document.createElement('div')
          host.className = 'dsa-pet'
          host.dataset.on = '0'
          stage = document.createElement('div')
          stage.className = 'dsa-pet-stage'
          host.appendChild(stage)
          document.body.appendChild(host)
          for (let index = 0; index < 2; index += 1) {
            const video = document.createElement('video')
            video.className = 'dsa-pet-video'
            video.muted = true
            video.playsInline = true
            video.preload = 'none'
            video.setAttribute('aria-hidden', 'true')
            // 只有"主动演的一次性动作"需要 ended；循环的待机/拖拽不会触发它。
            video.addEventListener('ended', () => {
              if (mode !== 'action' || videos[active] !== video) return
              scheduleReturn()
            })
            stage.appendChild(video)
            videos.push(video)
          }
          bindStage()
        }
        if (stage !== null) {
          stage.style.aspectRatio = `${pack.canvas[0]} / ${pack.canvas[1]}`
        }
        for (const video of videos) {
          video.dataset.on = '0'
          video.pause()
          video.removeAttribute('src')
          video.load()
        }
        active = 0
      }

      /** 把百分比位置换算成像素并应用（窗口尺寸变了就重算）。 */
      const layout = () => {
        if (host === null || pack === null) return
        const width = pet.size
        const height = Math.round((width * pack.canvas[1]) / pack.canvas[0])
        const maxLeft = Math.max(0, window.innerWidth - width)
        const maxTop = Math.max(0, window.innerHeight - height)
        host.style.width = `${width}px`
        host.style.left = `${Math.round((maxLeft * pet.x) / 100)}px`
        host.style.top = `${Math.round((maxTop * pet.y) / 100)}px`
      }

      /** 暂停所有视频（关掉宠物时调用：不在后台白烧解码）。 */
      const pauseAll = () => {
        for (const video of videos) {
          try {
            video.pause()
          } catch {
            /* 已停 */
          }
        }
      }

      /**
       * 演一个动作。
       * @param {string} id 动作 id（素材文件名去扩展名）。
       * @param {boolean} loop 是否循环。
       * @param {boolean} once 是否在演完后回待机（一次性动作）。
       */
      const show = (id, loop, once) => {
        const clip = clipById(id)
        if (clip === null || videos.length < 2) {
          if (!once) return
          if (mode !== 'idle') startIdle()
          return
        }
        const prev = active
        active = 1 - prev
        const incoming = videos[active]
        const outgoing = videos[prev]
        const url = `${ASSET}?path=${encodeURIComponent(clip.file)}`
        if (incoming.getAttribute('src') !== url) {
          incoming.src = url
          incoming.preload = 'auto'
        }
        incoming.loop = loop
        incoming.dataset.on = '1'
        outgoing.dataset.on = '0'
        try {
          incoming.currentTime = 0
        } catch {
          /* 还没元数据，play 之后自己从头播 */
        }
        const played = incoming.play()
        if (played && typeof played.catch === 'function') played.catch(() => {})
        // 淡出跑完再暂停：立刻 pause 会让上一段定在最后一帧，交叉时看得见。
        window.setTimeout(() => {
          if (videos[active] !== outgoing) {
            try {
              outgoing.pause()
            } catch {
              /* 已停 */
            }
          }
        }, 200)
        currentId = id
        // **不在这里改 mode**：调用方比这里更清楚这次是"待机""一次性动作"还是"拖拽"。
        // 以前在这里按 loop/once 反推，会把待机（loop=true）写成 'loop'，
        // 于是 15 秒后的随机回调一看到 `mode !== 'idle'` 就早退 —— 随机动作永远不触发。
        // 告诉设置页"现在在演哪一段"（宠物自己切的时候也要高亮到对的位置）。
        window.dispatchEvent(
          new CustomEvent('dsa:pet-state', { detail: { id, name: clip.name, pack: pack.id, loop } }),
        )
      }

      /** 回待机：循环 idle 动作，并重新排下一次随机。 */
      const startIdle = () => {
        if (pack === null) return
        clearReturn()
        clearAmbience()
        mode = 'idle'
        const id = idleId()
        if (id === '') return
        show(id, true, false)
        scheduleAmbience()
      }

      /** 演一个一次性动作，演完回待机。 */
      const playAction = (id) => {
        if (pack === null) return
        const clip = clipById(id)
        if (clip === null) {
          startIdle()
          return
        }
        clearAmbience()
        clearReturn()
        mode = 'action'
        show(id, false, true)
      }

      /** 一次性动作演完（ended）后隔一小会儿回待机。 */
      function scheduleReturn() {
        clearReturn()
        returnTimer = window.setTimeout(() => {
          returnTimer = 0
          if (mode === 'action' && pack !== null) startIdle()
        }, PET_RETURN_MS)
      }

      /** 待机满 15 秒就随机演一个小动作（动作随机、时间固定）；演的时候不排，回待机再排。 */
      function scheduleAmbience() {
        clearAmbience()
        if (pack === null) return
        ambienceTimer = window.setTimeout(() => {
          ambienceTimer = 0
          if (mode !== 'idle' || pack === null) return
          const clip = randomClip(ambientClips())
          if (clip !== null) playAction(clip.id)
          else scheduleAmbience()
        }, PET_IDLE_MS)
      }

      /** 设置页"随机一个"：立刻插播。 */
      const random = () => {
        if (pack === null) return
        const clip = randomClip(ambientClips())
        if (clip !== null) playAction(clip.id)
      }

      /** 按分类随机点播（右键菜单与设置页的分类卡）。 */
      const playCategory = (categoryId) => {
        if (pack === null) return
        const category = pack.categories.find((item) => item.id === categoryId)
        if (category === undefined) return
        const clip = randomClip(clipsOf(category.clips))
        if (clip !== null) playAction(clip.id)
      }

      /**
       * 点击音效：每只宠物都该有反馈声，素材来自 `pet.json` 或共享的 `click.wav`。
       *
       * 浏览器拦掉播放（没有用户手势、页面被静音）就安静跳过 —— 动作照演，
       * 不该为了听个响把点击整条链路搞挂。
       */
      const playClickSound = () => {
        if (typeof Audio !== 'function' || pack === null) return
        const file = typeof pack.clickSound === 'string' ? pack.clickSound : ''
        if (file === '') return
        try {
          if (clickAudio === null) clickAudio = new Audio(`${ASSET}?path=${encodeURIComponent(file)}`)
          clickAudio.currentTime = 0
          const played = clickAudio.play()
          if (played && typeof played.catch === 'function') played.catch(() => {})
        } catch {
          /* 播不了就算了 */
        }
      }

      /** 左键点击：随机一个回应动作；没有回应角色就随机一个待机动作。 */
      const playClick = () => {
        if (pack === null) return
        playClickSound()
        const clicks = clipsOf(pack.roles.clicks)
        const clip = randomClip(clicks.length > 0 ? clicks : ambientClips())
        if (clip !== null) playAction(clip.id)
      }

      /**
       * 回报当前动作（设置页刚挂载时问一次）。
       *
       * 为什么需要：宠物在页面加载时就开播待机了，那一刻设置页还没渲染，事件没人听；
       * 等用户翻到宠物页签时，高亮会是空的。让设置页主动问一声，两边状态就对齐了。
       */
      const report = () => {
        if (currentId === '' || pack === null) return
        const clip = clipById(currentId)
        window.dispatchEvent(
          new CustomEvent('dsa:pet-state', {
            detail: { id: currentId, name: clip === null ? currentId : clip.name, pack: pack.id, loop: mode !== 'action' },
          }),
        )
      }

      // ── 右键菜单 ──

      const closeMenu = () => {
        if (menu !== null) {
          menu.remove()
          menu = null
          document.removeEventListener('pointerdown', onMenuDocDown, true)
        }
      }

      /** 点菜单以外的地方就收起（capture 阶段拦，抢在拖拽/点击处理之前）。 */
      const onMenuDocDown = (event) => {
        if (menu !== null && event.target instanceof Node && !menu.contains(event.target)) closeMenu()
      }

      const menuItem = (label, onClick, count, active = false) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'dsa-pet-menu-item'
        item.textContent = label
        if (active) item.dataset.on = '1'
        if (typeof count === 'number') {
          const badge = document.createElement('span')
          badge.className = 'dsa-pet-menu-count'
          badge.textContent = String(count)
          item.appendChild(badge)
        }
        item.addEventListener('click', () => {
          closeMenu()
          onClick()
        })
        return item
      }

      const menuSep = () => Object.assign(document.createElement('div'), { className: 'dsa-pet-menu-sep' })

      /**
       * 右键菜单：**两级**。
       *
       * 一级是分类（互动 4 / 休闲 4 / 工作 1）；点进去是二级 —— 那个分类里每个动作的
       * 完整名字，点哪条演哪条，正在演的那条标色。
       *
       * 为什么不用"悬停弹出子菜单"：动作名长短差很多（「动作001」到「换上圣诞主题皮肤」），
       * 悬浮子菜单要处理贴边翻向、触摸屏还根本没有 hover；点进去 + 返回更稳，也照样能滚。
       *
       * @param {number} x 贴着鼠标展开的横坐标。
       * @param {number} y 纵坐标。
       * @param {object | null} category 已进入的分类；null = 一级。
       */
      const openMenu = (x, y, category = null) => {
        if (pack === null) return
        closeMenu()
        ensureStyle()
        menu = document.createElement('div')
        menu.className = 'dsa-pet-menu'
        if (category === null) {
          const head = document.createElement('div')
          head.className = 'dsa-pet-menu-head'
          head.textContent = t('petMenuActions')
          menu.appendChild(head)
          for (const item of pack.categories) {
            // 点分类 = 进它的二级，不直接演（演哪个由用户在二级里挑）。
            menu.appendChild(menuItem(item.name, () => openMenu(x, y, item), item.clips.length))
          }
          menu.appendChild(menuItem(t('petRandom'), random))
          menu.appendChild(menuSep())
          menu.appendChild(menuItem(t('petReset'), reset))
          menu.appendChild(menuItem(t('petHide'), hideSelf))
        } else {
          // 标题行就是"返回"：点它回一级。
          const back = document.createElement('button')
          back.type = 'button'
          back.className = 'dsa-pet-menu-back'
          back.textContent = `‹ ${category.name}`
          back.addEventListener('click', () => openMenu(x, y, null))
          menu.appendChild(back)
          for (const id of category.clips) {
            const clip = clipById(id)
            if (clip === null) continue
            menu.appendChild(menuItem(clip.name, () => playAction(clip.id), undefined, clip.id === currentId))
          }
          menu.appendChild(menuSep())
          menu.appendChild(menuItem(t('petRandom'), () => playCategory(category.id)))
        }
        document.body.appendChild(menu)
        // 贴着鼠标展开，但不许出屏（二级更高，每级都重新夹一遍）。
        const rect = menu.getBoundingClientRect()
        const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
        const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
        menu.style.left = `${Math.round(left)}px`
        menu.style.top = `${Math.round(top)}px`
        document.addEventListener('pointerdown', onMenuDocDown, true)
      }

      /** 菜单里的"隐藏"：只关这一只（总开关不动，别的宠物不受影响）。 */
      const hideSelf = () => {
        clearAmbience()
        clearReturn()
        if (pack !== null) onPersist({ petToggle: { pack: pack.id, enabled: false } })
      }

      /** 把当前像素位置写回百分比并落盘（拖动结束时调用）。 */
      const commitPosition = () => {
        if (host === null || pack === null) return
        const width = pet.size
        const height = Math.round((width * pack.canvas[1]) / pack.canvas[0])
        const maxLeft = Math.max(1, window.innerWidth - width)
        const maxTop = Math.max(1, window.innerHeight - height)
        const left = Number.parseFloat(host.style.left) || 0
        const top = Number.parseFloat(host.style.top) || 0
        pet.x = Math.max(0, Math.min(100, Math.round((left / maxLeft) * 1000) / 10))
        pet.y = Math.max(0, Math.min(100, Math.round((top / maxTop) * 1000) / 10))
        onPersist({ petMove: { pack: pack.id, x: pet.x, y: pet.y } })
      }

      // ── 甩抛 / 反弹 ──
      //
      // 松手时按最后 100ms 的手部位移算速度；够快就"扔出去"：每帧按速度推进，
      // 指数衰减，撞到视口边缘反向并按 BOUNCE 打折。速度掉到 STOP 以下就停稳，
      // 落盘位置、回待机。飞行期间继续演「拖拽悬空」——被扔出去的样子就该还是它。

      /** 宠物当前的尺寸与可移动范围（飞行/拖拽/布局共用一套口径）。 */
      const bounds = () => {
        const width = pet.size
        const height = pack === null ? width : Math.round((width * pack.canvas[1]) / pack.canvas[0])
        return {
          width,
          height,
          maxLeft: Math.max(0, window.innerWidth - width),
          maxTop: Math.max(0, window.innerHeight - height),
        }
      }

      /** 撞墙那一下的挤压：给个明确的"弹到了"的反馈，飞行结束自己会清掉。 */
      const bump = () => {
        if (stage === null) return
        stage.style.transform = 'scale(0.88, 1.12)'
        window.setTimeout(() => {
          if (stage !== null && flight !== null) stage.style.transform = ''
        }, 140)
      }

      /** 停稳：落盘位置、清掉飞行状态、回待机。 */
      const finishFlight = () => {
        if (flight !== null && flight.raf !== 0) window.cancelAnimationFrame(flight.raf)
        flight = null
        if (stage !== null) stage.style.transform = ''
        commitPosition()
        if (pack !== null) startIdle()
      }

      /** 一帧物理：推进 → 撞边反弹 → 衰减 → 判定停下。 */
      const stepFlight = (now) => {
        if (flight === null || host === null) return
        // 掉帧保护：dt 太大（切后台回来）会让宠物一帧瞬移出屏幕，按 48ms 封顶。
        const dt = Math.min(48, Math.max(1, now - flight.last))
        flight.last = now
        const { maxLeft, maxTop } = bounds()
        let left = (Number.parseFloat(host.style.left) || 0) + flight.vx * dt
        let top = (Number.parseFloat(host.style.top) || 0) + flight.vy * dt
        let hit = false
        if (left < 0) {
          left = -left
          flight.vx = -flight.vx * PET_BOUNCE
          hit = true
        } else if (left > maxLeft) {
          left = maxLeft * 2 - left
          flight.vx = -flight.vx * PET_BOUNCE
          hit = true
        }
        if (top < 0) {
          top = -top
          flight.vy = -flight.vy * PET_BOUNCE
          hit = true
        } else if (top > maxTop) {
          top = maxTop * 2 - top
          flight.vy = -flight.vy * PET_BOUNCE
          hit = true
        }
        // 一帧位移超过整块屏幕时（极端速度 + 长帧）上面那套镜像会算到边界外，贴回去。
        left = Math.max(0, Math.min(maxLeft, left))
        top = Math.max(0, Math.min(maxTop, top))
        host.style.left = `${Math.round(left)}px`
        host.style.top = `${Math.round(top)}px`
        if (hit) bump()
        if (Math.hypot(flight.vx, flight.vy) < PET_STOP_SPEED) {
          finishFlight()
          return
        }
        // 按真实时间衰减：掉帧时速度曲线不会变形（固定按帧乘会把慢机器的宠物甩更远）。
        const decay = Math.pow(PET_SPEED_KEEP, dt / 1000)
        flight.vx *= decay
        flight.vy *= decay
        flight.raf = window.requestAnimationFrame(stepFlight)
      }

      /**
       * 起飞。
       * @param {number} vx 水平速度（px/ms）。
       * @param {number} vy 垂直速度（px/ms）。
       */
      const startFlight = (vx, vy) => {
        if (host === null) return
        const speed = Math.hypot(vx, vy)
        // 没甩（慢慢拖到位置就松手）：不算飞，直接收尾。
        if (speed < PET_STOP_SPEED) {
          commitPosition()
          if (pack !== null) startIdle()
          return
        }
        const cap = Math.min(1, PET_MAX_SPEED / speed)
        flight = { vx: vx * cap, vy: vy * cap, raf: 0, last: performance.now() }
        if (stage !== null) {
          stage.dataset.drag = '0'
          stage.style.transform = ''
        }
        // 飞行期间保持"被扔出去"的动作；没有拖拽角色就演当前那段，别中途乱切。
        flight.raf = window.requestAnimationFrame(stepFlight)
      }

      /** 打断飞行（用户又抓住了它 / 关掉宠物）：位置不落盘，等松手时统一提交。 */
      const stopFlight = () => {
        if (flight !== null && flight.raf !== 0) window.cancelAnimationFrame(flight.raf)
        flight = null
        if (stage !== null) stage.style.transform = ''
      }

      /** 拖动开始：接管指针、切到拖拽动作。 */
      const onPointerDown = (event) => {
        if (event.button !== 0 || host === null || pack === null) return
        closeMenu()
        // 飞行中又被抓住：钉在当前位置，先落盘 —— 用户抓到的就是它此刻待的地方。
        if (flight !== null) {
          stopFlight()
          commitPosition()
        }
        const rect = host.getBoundingClientRect()
        drag = {
          id: event.pointerId,
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          // 手部位移采样：松手时用最近 100ms 这段算甩出去的速度。
          samples: [{ x: event.clientX, y: event.clientY, t: performance.now() }],
        }
        stage.dataset.drag = '1'
        try {
          stage.setPointerCapture(event.pointerId)
        } catch {
          /* 某些浏览器对非活动指针会抛，拖拽仍可用 */
        }
        // 拖拽接管节奏：被拎着的时候循环演"拖拽悬空"（没有这个角色就保持当前动作）。
        clearAmbience()
        clearReturn()
        if (clipById(pack.roles.drag) !== null) {
          mode = 'drag'
          show(pack.roles.drag, true, false)
        }
        event.preventDefault()
      }

      const onPointerMove = (event) => {
        if (drag === null || event.pointerId !== drag.id || host === null || pack === null) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        // 采样先于门槛：门槛只决定"算不算拖拽"，速度还要靠这些点。
        drag.samples.push({ x: event.clientX, y: event.clientY, t: performance.now() })
        const cutoff = performance.now() - PET_VELOCITY_WINDOW_MS
        while (drag.samples.length > 2 && drag.samples[0].t < cutoff) drag.samples.shift()
        // 4px 门槛：点击时手会抖一两像素，不该被当成拖拽。
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        const { maxLeft, maxTop } = bounds()
        const left = Math.max(0, Math.min(maxLeft, event.clientX - drag.dx))
        const top = Math.max(0, Math.min(maxTop, event.clientY - drag.dy))
        host.style.left = `${Math.round(left)}px`
        host.style.top = `${Math.round(top)}px`
        // 被拎起来的那点手感：往哪边甩就往哪边倒，最多 9°。
        stage.style.transform = `rotate(${Math.max(-9, Math.min(9, dx * 0.12)).toFixed(1)}deg)`
      }

      const onPointerUp = (event) => {
        if (drag === null || event.pointerId !== drag.id) return
        const moved = drag.moved
        const samples = drag.samples
        drag = null
        if (stage !== null) {
          stage.dataset.drag = '0'
          stage.style.transform = ''
        }
        try {
          stage.releasePointerCapture(event.pointerId)
        } catch {
          /* 已经释放 */
        }
        if (moved) {
          // 用最近这段采样的平均速度当作甩出去的速度（单次位移噪声太大）。
          const last = samples[samples.length - 1]
          let vx = 0
          let vy = 0
          if (samples.length >= 2 && last !== undefined) {
            const cutoff = last.t - PET_VELOCITY_WINDOW_MS
            const first = samples.find((sample) => sample.t >= cutoff) ?? samples[0]
            const dt = last.t - first.t
            if (dt > 0) {
              vx = (last.x - first.x) / dt
              vy = (last.y - first.y) / dt
            }
          }
          startFlight(vx, vy)
        } else {
          playClick()
        }
      }

      const onResize = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          // 飞行中视口变了：不能走 layout（它会用旧的百分比坐标覆盖飞行位置），
          // 只把当前位置夹回新边界，飞完再落盘。
          if (flight !== null && host !== null) {
            const { maxLeft, maxTop } = bounds()
            const left = Number.parseFloat(host.style.left) || 0
            const top = Number.parseFloat(host.style.top) || 0
            host.style.left = `${Math.round(Math.max(0, Math.min(maxLeft, left)))}px`
            host.style.top = `${Math.round(Math.max(0, Math.min(maxTop, top)))}px`
            return
          }
          layout()
        })
      }

      /** 舞台事件只绑一次（host 建好后）。 */
      function bindStage() {
        if (stage === null) return
        stage.addEventListener('pointerdown', onPointerDown)
        stage.addEventListener('pointermove', onPointerMove)
        stage.addEventListener('pointerup', onPointerUp)
        stage.addEventListener('pointercancel', onPointerUp)
        stage.addEventListener('contextmenu', (event) => {
          if (pack === null) return
          event.preventDefault()
          // 多只同屏时只留一个菜单：先请外层关掉别人的。
          options.onMenuOpen()
          openMenu(event.clientX, event.clientY)
        })
        window.addEventListener('resize', onResize)
      }

      /**
       * 应用一份新配置（这只宠物的包内容）。
       *
       * **不采纳 x/y**：位置由本实例独占（拖动后自己写盘）。设置页每次写别的字段都会
       * 拿到一份状态回包，如果那份回包里的旧坐标也被应用，宠物会被拽回上一次保存的位置。
       *
       * @param {object} next 服务端给的这一只的状态（包内容 + x/y，但 x/y 忽略）。
       */
      const update = (next) => {
        if (!next || typeof next !== 'object') return
        entry = next
        build()
        if (pack === null) return
        layout()
        if (host !== null) host.dataset.on = '1'
        // 正在演就接着演；首次建好或换了包，才重新起待机。
        if (currentId === '' || clipById(currentId) === null) startIdle()
      }

      /** 全局大小变了：重算高度与可移动范围（所有实例一起变）。一帧最多排一次布局。 */
      let sizeFrame = 0
      const setSize = (size) => {
        if (typeof size !== 'number' || !Number.isFinite(size) || size === pet.size) return
        pet.size = size
        if (sizeFrame !== 0) return
        sizeFrame = window.requestAnimationFrame(() => {
          sizeFrame = 0
          layout()
        })
      }

      /** 归位：回到右下角并落盘。 */
      const reset = () => {
        pet.x = 100
        pet.y = 100
        layout()
        if (pack !== null) onPersist({ petMove: { pack: pack.id, x: 100, y: 100 } })
      }

      const destroy = () => {
        window.removeEventListener('resize', onResize)
        if (frame !== 0) window.cancelAnimationFrame(frame)
        frame = 0
        if (sizeFrame !== 0) window.cancelAnimationFrame(sizeFrame)
        sizeFrame = 0
        clearAmbience()
        clearReturn()
        closeMenu()
        stopFlight()
        pauseAll()
        videos.length = 0
        if (host !== null) host.remove()
        if (styleEl !== null) styleEl.remove()
        host = null
        stage = null
        styleEl = null
        pack = null
        builtKey = ''
      }

      // play = 指定动作：设置页的动作卡和搜索都走这条 —— 演一遍然后回待机。
      return { update, setSize, play: playAction, playCategory, random, report, reset, closeMenu, destroy }
    }

    /**
     * 壁纸主题层：把视频/图片铺在 DSH 界面背后，并**接管背景色让页面让位**。
     *
     * 为什么不是"在 DOM 最后面塞一个 div"：DSH 的三列是**不透明**的（`--dsw-alias-bg-base`
     * 与 `--dsw-specific-sidebar-fill` 都是实色），无论节点放哪、z-index 多少，壁纸都会被
     * 挡住。正确顺序是：
     *
     *   ① 挂一层固定的 `<img>` / `<video>`（pointer-events:none，盖在最底）；
     *   ② 在 `body` 上把若干 `--dsw-*` 背景 token 改成半透明/透明 —— 页面于是"让开"，
     *      壁纸透出来。**只动背景与文字颜色，绝不动 `--dsh-*` 字号/字族**（那是用户自己的
     *      设置，改它就是"影响用户看字"）。
     *
     * 文字看不看得清不靠滑杆碰运气：取样 → 算对比度 → 反推幕浓度，算法在
     * `lib/wallpaper.mjs`（内联在本文件顶部），这里只负责把结论贴上页。
     *
     * @param {{ t: (key: string) => string, onDecision?: (info: object) => void }} options 文案 + 回调。
     * @returns {{ load: () => Promise<void>, sync: (cfg: object) => void, destroy: () => void }} 层控制。
     */
    /** 壁纸层的诊断输出：`localStorage.dsaDebug='1'` 后刷新页面才说话，平时一句不刷。 */
    let wallDebug = null
    const debugOn = () => {
      // 开关只读一次：这函数在拖滑杆时每帧都会被叫到，不能每帧去碰 localStorage。
      if (wallDebug === null) {
        try {
          wallDebug = window.localStorage.getItem('dsaDebug') === '1'
        } catch {
          wallDebug = false
        }
      }
      return wallDebug === true
    }
    const wallLog = (...args) => {
      if (debugOn()) console.log('[dsa-wall]', ...args)
    }

    function createWallpaperLayer(options) {
      const onDecision = options.onDecision
      /** 当前状态：来自 manage 的 wallpaper 段（形状见 index.js resolveWallpaper）。 */
      let cfg = null
      /** 上一次铺的是哪一份素材：`file|kind` —— 变了才重挂 DOM。 */
      let mountedKey = ''
      /** 壁纸层容器（固定定位，盖在最底）。 */
      let base = null
      /** 幕（半透明覆盖层）与素材本体分开：改浓度只需要改幕的 opacity。 */
      let scrimEl = null
      let mediaEl = null
      /** 最后一次决策（设置页要显示"当前对比度"）。 */
      let lastDecision = null
      /**
       * 深浅色主题变化时的重算，看下面 `onThemeChange`。
       *
       * 这里原先写着"不需要监听：决策只取决于壁纸画面"——那是错的。
       * 壁纸画面决定的是**墨色**（亮壁纸配深色字），而**地板色**（面板底压哪一侧）
       * 由主题深浅决定，两者在 `deriveTokens` 里是分开的参数。漏掉后者就会出现
       * "切了深浅色，面板还停在上一套地板色"。
       */
      let alive = true
      /** 壁纸层与"让位变量"合并进同一条样式表的挂载点（见 ensureLive）。 */
      let sheetEl = null
      /** 我们写进那条样式表的内容 —— 和上一份一样就整段跳过，这是拖滑杆不卡的关键。 */
      let lastCss = ''

      /**
       * 抄一份**原生外观**：内核写在 body 内联样式上的那批令牌，此刻还是原值。
       *
       * 为什么需要：主题令牌是全局的，壁纸一开，设置页也跟着变成半透明玻璃色 ——
       * 用户在设置页里调主题，看到的却是调暗之后的自己。插件自己的界面必须按原生
       * 外观画，否则越调越看不清。这份快照写进 `--dsa-native-*`，只被
       * `[data-dsa-ui]` 作用域消费，绝不外溢到宿主界面。
       */
      const snapshotNative = () => {
        try {
          const read = (name, fallback) => {
            const value = getComputedStyle(document.body).getPropertyValue(name).trim()
            return value === '' ? fallback : value
          }
          const map = {
            '--dsa-native-bg': read('--dsw-alias-bg-base', '#ffffff'),
            '--dsa-native-layer': read('--dsw-alias-bg-layer-1', '#f2f4f7'),
            '--dsa-native-border': read('--dsw-alias-border-l1', 'rgba(0, 0, 0, 0.12)'),
            '--dsa-native-ink': read('--dsw-alias-label-primary', '#0f1115'),
            '--dsa-native-ink-dim': read('--dsw-alias-label-secondary', '#5b616b'),
            '--dsa-native-ink-faint': read('--dsw-alias-label-tertiary', '#8b919b'),
          }
          for (const [name, value] of Object.entries(map)) {
            document.documentElement.style.setProperty(name, value)
          }
          wallLog('原生外观快照', map)
        } catch (error) {
          // 读不到就退回 CSS 里的兜底色，设置页仍是实底，不会跟着壁纸翻面。
          wallLog('原生外观快照失败', error)
        }
      }

      const ensureStyle = () => {
        if (base !== null) return
        // 先把"原生外观"抄一份存起来。必须在**第一次写让位令牌之前**做，而且整个页面
        // 生命周期只做一次：那时读到的就是内核真正的不透明底色。
        // 设置页要按原生外观上色（见 paintCss 里的 --dsa-ui-*），靠的就是这份快照。
        snapshotNative()
        base = document.createElement('div')
        base.className = 'dsa-wall'
        base.setAttribute('aria-hidden', 'true')
        // 层叠与尺寸都在 ensureLive 的样式表里，这里一句内联都不写。
        mediaEl = document.createElement('img')
        mediaEl.className = 'dsa-wall-cover'
        mediaEl.alt = ''
        scrimEl = document.createElement('div')
        scrimEl.className = 'dsa-wall-scrim'
        // 幕的浓度每帧都要动，留 inline（它只是两个简单属性，且只在这一个自绘元素上）。
        scrimEl.style.cssText = 'background:#000;opacity:0'
        base.appendChild(mediaEl)
        base.appendChild(scrimEl)
        document.body.appendChild(base)
      }

      /**
       * 一条样式表管两件事：壁纸层自己的层叠与尺寸 + 覆盖应用的让位变量。
       *
       * 为什么不用 body 内联样式（ThemePresenter 那种做法）：
       *   - 内联改一个变量，浏览器要把整棵树的依赖了它的样式重算一遍；拖滑杆时每帧都来一次；
       *   - 用一条样式表就**换掉整段文本**，只有依赖这些变量的规则重新匹配。
       * 还有一点更重要：作用域是 `body`，比应用写在自己元素上的变量低一档 ——
       * 只顶掉"应用没写死的地方"，不去和组件自己设的局部值硬碰。
       */
      const ensureLive = () => {
        if (sheetEl === null) {
          sheetEl = document.createElement('style')
          sheetEl.setAttribute('data-dsa-wall', '')
          document.head.appendChild(sheetEl)
        }
        return sheetEl
      }

      const dropMedia = () => {
        if (base === null) return
        // 视频要显式 pause + 清 src，否则元素移除后解码器仍可能挂一会儿。
        if (mediaEl !== null && mediaEl.tagName === 'VIDEO') {
          try {
            mediaEl.pause()
            mediaEl.removeAttribute('src')
            mediaEl.load()
          } catch {
            /* 已经停了 */
          }
        }
        base.remove()
        base = null
        mediaEl = null
        scrimEl = null
        mountedKey = ''
      }

      /**
       * 把"壁纸层骨架 + 颜色变量"整段写进样式表。
       *
       * @param {Record<string, string>} tokens deriveTokens 的输出。
       * @param {{ blur: number, saturate: number }} resolved 已解析的预设参数。
       */
      const paintCss = (tokens, resolved) => {
        const vars = layoutVars(tokens)
        const css = [
          // 层叠：负 z-index 是唯一"垫在所有列之下、又不脱离 body 定位"的位置。
          // 它画在画布背景之上、正常流内容之下 —— 正好是壁纸该待的地方。
          // 壁纸层自己的背景色用**垫底色**，不是纯黑：画面还没解码出来、或者视频卡住时，
          // 露出来的应该是"有点像壁纸的颜色"，而不是一块黑 —— 黑底会把整个界面压暗，
          // 用户看到的就是"壁纸没显示、界面也变得很闷"。
          `.dsa-wall{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;background:${tokens['dsa-wall-underlay']};`,
          // 磨砂只跟**壁纸模糊**这根滑杆走：它是用户唯一能控制的"壁纸本体多虚"。
          // 这里绝不能用 surfaceBlur —— 那是预设的"面板磨砂"档，之前用它做主模糊，
          // 结果可读优先预设一上来就把壁纸糊掉 24px，用户看到的是"背景不显示"。
          `filter:blur(${resolved.blur}px) saturate(${resolved.saturate});transform:scale(${resolved.blur > 0 ? 1.06 : 1});}`,
          '.dsa-wall-cover{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}',
          '.dsa-wall-scrim{position:absolute;inset:0;}',
          // 画布本身也放空。body 的底色就是 var(--dsw-alias-bg-base)，令牌顶掉之后它自己就透了，
          // 这行是兜底（主题插件的首帧 CSS 会直接写死 background-color）。
          //
          // 另外给 html 一个**不透明的壁纸代表色**：窗口最小化 → 还原、被遮挡、后台节流后
          // 回来时，根帧可能拿不到壁纸层已提交的像素，此时露出来的是窗口底板（Electron 缺省
          // #FFF）—— 就是"整块白闪"。垫一层同色底，掉层时退化成"有点像壁纸的颜色"。
          `html{background-color:${tokens['dsa-wall-underlay']} !important;}`,
          'html,body{background-image:none !important;}',
          `body{background:transparent !important;}`,
          // ── 卡片式布局 ──
          //
          // 壁纸铺满整个窗口，三列各自收成一块**独立卡片**，卡片间留 10px 的缝，壁纸从缝里
          // 露出来。卡片是实底（0.92），所以卡片里的字永远清楚；壁纸的可见面积靠"缝隙 +
          // 窗口留白"，不靠把卡片做透 —— 这就是"字清楚"与"壁纸鲜亮"能同时成立的地方。
          //
          // 选择器只认结构（`[data-shell-overlay]` 的父节点是 frame），不认 CSS module 的
          // 哈希类名（`mP3x-q_frame`），内核升级也不会失效。
          '[data-shell-overlay]{gap:var(--dsa-card-gap,10px);padding:var(--dsa-card-gap,10px);}',
          '[data-shell-overlay]>*{border-radius:16px;overflow:hidden;background:var(--dsa-card);',
          'background-color:var(--dsa-card);isolation:isolate;',
          'box-shadow:0 6px 24px rgba(0,0,0,0.18),0 0 0 1px rgba(255,255,255,0.08) inset;}',
          // 底栏是同一条横贯的卡片，左右对齐、下面留一条缝。
          '[data-shell-bottom]{border-radius:14px;overflow:hidden;background:var(--dsa-card);',
          'margin:0 var(--dsa-card-gap,10px) var(--dsa-card-gap,10px);}',
          // 一条规则都不留 backdrop-filter：它糊的是元素背后的**所有内容，包括列里自己的
          // 正文**。之前把它挂在 shell.overlay / 三列上，用户看到的就是"设置页的字清楚，
          // 对话窗口整个是模糊的"。壁纸要透上来，只靠列的底色半透明（下面的 wallAlpha）；
          // 想要"磨砂"的质感，让壁纸层自己去糊（`filter:blur()` 在壁纸层上，不影响字）。
          'body{',
          // 全部带 !important：内核把主题令牌以**内联样式**写在 body 上（ThemePresenter），
          // 普通作者声明必输给内联。这里只压 body 这一个元素上的同名变量，组件写在自己
          // 元素上的局部变量照旧继承生效 —— 单向让位，不去和组件硬碰。
          Object.entries(vars)
            .map(([name, value]) => `${name}:${value} !important;`)
            .join(''),
          // 插件自己的界面（设置页）按**原生外观**上色：主题令牌是全局的，一改，设置页
          // 也跟着变成玻璃色、字跟着翻面 —— 在设置页里调主题等于在看自己的倒影。
          // 这几个变量只被 [data-dsa-ui] 作用域消费，不会外溢到宿主界面。
          //
          // 原生底色直接读内核写的不透明值（`--dsa-native-*`，由 client.js 启动时写入），
          // 所以哪怕主题令牌已经被我们顶成半透明，设置页里仍是干干净净的实底。
          `--dsa-ui-bg-base:var(--dsa-native-bg, #ffffff) !important;`,
          `--dsa-ui-bg-layer:var(--dsa-native-layer, #f2f4f7) !important;`,
          `--dsa-ui-border:var(--dsa-native-border, rgba(0, 0, 0, 0.12)) !important;`,
          `--dsa-ui-ink:var(--dsa-native-ink, #0f1115) !important;`,
          `--dsa-ui-ink-dim:var(--dsa-native-ink-dim, #5b616b) !important;`,
          `--dsa-ui-ink-faint:var(--dsa-native-ink-faint, #8b919b) !important;`,
          '}',
        ].join('')
        if (css === lastCss) return
        lastCss = css
        ensureLive().textContent = css
        wallLog('paint', base === null ? '还没有层' : base.isConnected ? '已挂' : '未挂', css.slice(0, 120))
      }

      /** 还原：把那条样式表清空 —— 应用自己写的变量一个都不动，壁纸层也一并消失。 */
      const clearVars = () => {
        // 变量全在那条样式表里：清空文本就是"回到原生外观"。
        lastCss = ''
        if (sheetEl !== null) sheetEl.textContent = ''
      }

      /**
       * 让位变量表：把"页面自己画的底色"改成玻璃配方。
       *
       * 这是整套观感的核心 —— 面板不再是实色块，而是「玻璃色 + 背后模糊」，
       * 壁纸被模糊后透上来。每一条的覆盖率都不低于 READABILITY_FLOOR
       * （在 lib/wallpaper.mjs 的 deriveTokens 里就把地板色混进去了），
       * 所以"玻璃透明度"滑杆怎么拖都不会把字压糊。
       *
       * 这些**只出现在壁纸开启时**，关掉立即还原。
       *
       * @param {Record<string, string>} tokens deriveTokens 的输出。
       * @returns {Record<string, string>}
       */
      const layoutVars = (tokens) => ({
        // 三列与底栏：半透明，壁纸从这个缝里透上来。
        //
        // 这里**不是** `transparent`。彻底留空虽然最"透"，但壁纸的亮部会直接扎在字后面，
        // 而列的底色是唯一能同时做到"壁纸可见"和"字站得住"的东西：给它一个不透明度
        // （tokens['dsa-wall-wall-alpha']），壁纸就从这层底下透出来 —— 参考实现的玻璃
        // 令牌全是 `color-mix(..., transparent)`，同一回事。
        //
        // 不透明度是按最坏壁纸算出来的（浅色主题对纯黑、深色主题对纯白），所以七套预设
        // 各有各的值：面板越亮的预设，越不能透 —— 白玻璃透在白底上会把字吃掉。
        '--dsw-alias-bg-base': tokens['dsa-wall-wall'],
        '--dsw-specific-sidebar-fill': tokens['dsa-wall-wall'],
        // 卡片式布局：壁纸铺满整个窗口，三列各自变成一块**独立的实心卡片**，
        // 卡片之间留出缝，壁纸就从缝里露出来。
        //
        // 为什么这样才不"闷"：字不再压在壁纸的任意一小块上，而是压在卡片内部统一的面
        // 上 —— 所以卡片可以做得比"毛玻璃"实得多（字更清楚），同时整屏的壁纸面积仍然
        // 很大（2/3 以上在缝隙里），观感不灰。这是拿"每一像素都半透"换"整块面清楚"。
        //
        // 卡片不需要读壁纸取样：它只要站在主题那一侧（深色主题→深卡、浅色→浅卡），
        // 内部用哪套字色就由 deriveTokens 决定，和壁纸本身长什么样无关。
        // 卡片底色：**不透明**。之前给的是 `#ffffff`（浅色主题）+ 92% 不透明度 ——
        // 那 8% 的缝在亮壁纸上看不出来，在黑壁纸上却让整张卡片掉到 #ebebeb 灰，深色字
        // 压上去发闷。卡片这块面不需要透：壁纸的可见面积靠卡片之间的缝，不靠卡片本身。
        '--dsa-card': tokens['dsa-wall-card'],
        '--dsa-card-gap': '10px',
        // 面上的面：层 1 是大面板（卡片、行、列表），层 2/3 是浮在它上面的菜单、弹层、
        // 选中态。三层用的是**同一族壁纸雾**，越靠前越往地板色抬一档 —— 这样"浮起来"
        // 是看得见的，而不是三层糊成一个色。
        '--dsw-alias-bg-layer-1': tokens['dsa-wall-frost'],
        '--dsw-alias-bg-layer-2': tokens['dsa-wall-frost-2'],
        '--dsw-alias-bg-layer-3': tokens['dsa-wall-frost-3'],
        // 面板背后那层"壁纸雾"。
        //
        // 不能拿 frost 当 `bg-overlay`：frost 是「玻璃面掺一点壁纸色」的中间调，
        // 糊在浮层上就是整片看不见。浮层自己也得站得住字，所以跟层 2/3 用同一个玻璃色。
        '--dsw-alias-bg-conversation': tokens['dsa-wall-frost'],
        '--dsw-alias-bg-overlay': tokens['dsa-wall-frost-3'],
        '--dsw-alias-bg-module-platform': tokens['dsa-wall-frost-2'],
        '--dsw-alias-bg-multi-select': tokens['dsa-wall-frost-2'],
        // 抬高的按钮（侧栏「新建会话」、重命名输入框）：比最高那层再亮半档。
        '--dsw-alias-button-elevated-fill': tokens['dsa-wall-frost-3'],
        '--dsw-alias-button-floating-fill': tokens['dsa-wall-frost-3'],
        // 字色：由玻璃面的实际亮度决定（deriveTokens 里算过），不是拍脑袋。
        '--dsw-alias-label-primary': tokens['dsa-wall-ink'],
        '--dsw-alias-label-secondary': tokens['dsa-wall-ink-dim'],
        '--dsw-alias-label-tertiary': tokens['dsa-wall-ink-faint'],
        '--dsw-alias-label-caption': tokens['dsa-wall-ink-faint'],
        '--dsw-alias-border-l1': tokens['dsa-wall-border'],
        '--dsw-alias-border-l2': tokens['dsa-wall-border'],
        // 代码：这几个是**自成一套底色**的令牌，必须一起接管。
        //
        // 行内 code 是 `background: var(--dsw-alias-markdown-inline-code)` + `color: inherit`
        // —— 只要底还停在内核那套浅色静态值（#f1f3f5），字却被我们改成浅墨，就成了
        // "白底白字"。代码块同理（label-primary 做字色 + code-block 做底）。
        '--dsw-alias-markdown-inline-code': tokens['dsa-wall-frost-2'],
        '--dsw-alias-markdown-code-block': tokens['dsa-wall-frost'],
        '--dsw-alias-markdown-tag': tokens['dsa-wall-frost-2'],
        '--dsw-alias-markdown-code-block-banner': tokens['dsa-wall-frost-2'],
        // 用户消息气泡：底色是独立的 --dsw-specific-bubble（static-deepseek-50 浅蓝），
        // 字色却是 label-primary。壁纸把字改成浅色而气泡仍是浅蓝底 → 浅字浅底。
        '--dsw-specific-bubble': tokens['dsa-wall-frost-2'],
        '--dsw-specific-bubble-highlight': tokens['dsa-wall-glass-2'],
        // 菜单 / 输入区 / 悬浮层：自成一个面，同样必须跟着走。
        '--dsw-specific-menu': tokens['dsa-wall-glass-3'],
        '--dsw-specific-input-major': tokens['dsa-wall-glass-2'],
        '--dsw-alias-interactive-bg-hover': tokens['dsa-wall-hover'],
        '--dsw-alias-interactive-bg-hover-solid': tokens['dsa-wall-hover'],
        // 强调色：按钮、链接、选中态。预设自带，换预设立刻换调子。
        '--dsw-alias-brand-primary': tokens['dsa-wall-accent'],
        '--dsw-alias-link': tokens['dsa-wall-accent'],
      })

      /**
       * 拿当前素材当作画面样本 → 决策 → 贴页。
       *
       * 内置素材带 `hint`（出厂代表色），所以第一帧之前就能定色；上传的素材没有 hint，
       * 退到"按深色保底"（绝大多数壁纸是暗的，先按暗的排，取样到了再纠正）。
       */
      const decideAndApply = (analysis) => {
        if (cfg === null) return
        const preset = {
          preset: cfg.preset,
          scrim: cfg.scrim,
          blur: cfg.blur,
          saturate: cfg.saturate,
          glassAlpha: cfg.glassAlpha,
          surfaceBlur: cfg.surfaceBlur,
        }
        const resolved = resolvePreset(preset)
        const decision = decideTheme(analysis, resolved)
        // 地板色站在**主题**那一侧（深色主题压近黑、浅色压白），不是站在墨色那一侧。
        // 判定读 documentElement 上的 data-ds-theme-source / body 的 data-ds-dark-theme
        // —— 那正是内核 ThemePresenter 写的两个稳定属性。
        const tokens = deriveTokens(decision, resolved, { dark: themeIsDark() })
        lastDecision = { ...decision, analysis, tokens }
        paintCss(tokens, resolved)
        // 只动幕的浓度/颜色 —— 这两个属性挂在自绘的幕元素上，不影响应用任何样式。
        if (scrimEl !== null) {
          // 幕的颜色跟墨色走：浅色字压暗幕，深色字压亮幕。
          scrimEl.style.background = decision.ink === 'light' ? '#000' : '#fff'
          scrimEl.style.opacity = String(decision.scrim)
        }
        if (typeof onDecision === 'function') onDecision(lastDecision)
      }

      /**
       * 现在是不是深色主题。
       *
       * 内核 `ThemePresenter` 会写两个稳定属性：`<html data-ds-theme-source>`（'light'|'dark'）
       * 与 `<body data-ds-dark-theme>`（存在即深色）。两个都读不到时按深色处理 ——
       * 壁纸几乎都是暗的，押深色出错最少。
       */
      const themeIsDark = () => {
        try {
          const root = document.documentElement
          if (root !== null && root !== undefined) {
            const source = root.getAttribute('data-ds-theme-source')
            if (source === 'light') return false
            if (source === 'dark') return true
          }
          const body = document.body
          if (body !== null && body !== undefined && typeof body.hasAttribute === 'function') {
            return body.hasAttribute('data-ds-dark-theme')
          }
        } catch {
          // 沙盒 / 早期页面：读不到就当深色。
        }
        return true
      }

      /**
       * 排查用：把"到底铺上去了没有"压成几行能对照的事实。
       *
       * 只在 `localStorage.dsaDebug === '1'` 时说话。查的是三个独立的层次：
       *   ① 让位到底有没有生效 —— frame 的实算底色是不是透了；
       *   ② 壁纸层在不在、尺寸对不对；
       *   ③ 那条样式表在不在、有没有内容。
       * 三者一对，就能分清是"层没挂"、"挂了但被盖住"还是"变量没顶掉"。
       */
      const probe = () => {
        if (!debugOn()) return
        try {
          const overlay = document.querySelector('[data-shell-overlay]')
          const frame = overlay === null ? null : overlay.parentElement
          const read = (el, name) => (el === null ? '找不到' : getComputedStyle(el).getPropertyValue(name).trim() || '空')
          const rect = base === null ? null : base.getBoundingClientRect()
          wallLog('probe', {
            'frame 底色': read(frame, 'background-color'),
            'frame 看的令牌': read(frame, '--dsw-alias-bg-base'),
            'body 底色': getComputedStyle(document.body).backgroundColor,
            '层尺寸': rect === null ? '还没有层' : `${Math.round(rect.width)}×${Math.round(rect.height)}`,
            '样式表': sheetEl === null ? '没有' : `${sheetEl.textContent.length} 字符`,
            '视频在放': mediaEl !== null && mediaEl.tagName === 'VIDEO' ? !mediaEl.paused : '不是视频',
          })
        } catch (error) {
          wallLog('probe 失败', error)
        }
      }

      /** 从一张已加载的图/视频帧取样（缩到 32×18 —— 决策只需要平均观感）。 */
      const sampleFrom = (el) => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = 32
          canvas.height = 18
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (ctx === null) return null
          ctx.drawImage(el, 0, 0, 32, 18)
          return analyzePixels(ctx.getImageData(0, 0, 32, 18).data)
        } catch {
          // 跨域/解码失败：保留 hint 的结论，不因为取样失败把界面弄花。
          return null
        }
      }

      /** 挂素材本体；图与视频分两路（视频要静音循环 + 失败降级）。 */
      const mountMedia = () => {
        if (cfg === null || base === null) return
        // 只跟素材有关。换预设/拖滑杆只改颜色与幕，不要碰素材本体 ——
        // 视频重挂要重新解码，拖一下滑杆就黑一帧，看着就是"卡"。
        const key = `${cfg.file}|${cfg.kind}`
        if (key === mountedKey) return
        mountedKey = key
        const old = mediaEl
        const next = cfg.kind === 'video' ? document.createElement('video') : document.createElement('img')
        next.className = 'dsa-wall-cover'
        // 样式全部走下面那条样式表（.dsa-wall / .dsa-wall-cover / .dsa-wall-scrim），
        // 不走内联：内联改一次就要重新计算整棵树，拖滑杆时最贵的就是它。
        next.setAttribute('aria-hidden', 'true')
        if (next.tagName === 'VIDEO') {
          next.muted = true
          next.loop = true
          next.autoplay = true
          next.playsInline = true
          next.preload = 'auto'
          // 尊重系统"减少动态效果"：退到静帧（后台标签页也照此处理，见 visibilitychange）。
          if (window.matchMedia !== undefined && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            next.autoplay = false
            next.loop = false
          }
        }
        next.src = cfg.src
        next.onloadeddata = () => {
          if (!alive) return
          // 图/视频都取一次样：hint 只是"第一时间不要闪错色"，实际画面才是结论。
          const analysis = sampleFrom(next)
          if (analysis !== null) decideAndApply(analysis)
        }
        next.onerror = () => {
          // 素材坏了：把壁纸撤掉，界面回到原生外观 —— 比留一片黑好。
          clearAll()
        }
        base.replaceChild(next, old)
        mediaEl = next
      }

      const clearAll = () => {
        clearVars()
        dropMedia()
        lastDecision = null
        if (typeof onDecision === 'function') onDecision(null)
      }

      /** 应用一份新的 wallpaper 配置（来自 manage）。 */
      const sync = (next) => {
        if (!alive) return
        const changed =
          cfg === null ||
          cfg.enabled !== next.enabled ||
          cfg.file !== next.file ||
          cfg.preset !== next.preset ||
          cfg.scrim !== next.scrim ||
          cfg.blur !== next.blur ||
          cfg.saturate !== next.saturate ||
          (cfg.glassAlpha ?? 0) !== (next.glassAlpha ?? 0) ||
          (cfg.surfaceBlur ?? 0) !== (next.surfaceBlur ?? 0)
        cfg = next
        wallLog('sync', { enabled: next.enabled, src: next.src, changed })
        if (next.enabled !== true || next.src === '') {
          clearAll()
          return
        }
        ensureStyle()
        // 画面摘要优先用"真取样到的那份"：换预设/换素材都不该把已经量到的画面丢掉 ——
        // 丢掉的后果是对比度退回出厂代表色去算，和眼前的实际观感对不上。
        // mountedKey 还是上一份素材的键，所以"新配置的键和它一样"就等于没换素材。
        const sameMedia = mountedKey === `${next.file}|${next.kind}`
        const hint = Array.isArray(next.hint) ? next.hint : []
        const sampled = sameMedia && lastDecision !== null ? lastDecision.analysis : null
        const analysis = sampled ?? (hint.length > 0 ? analyzeColors(hint) : null)
        if (changed || lastDecision === null) {
          decideAndApply(analysis)
        } else if (typeof onDecision === 'function') {
          // 配置没变就不重算，但**要再报一次**：设置页是后起来的（它挂载时会
          // `dsa:wall-query` 问一句），若这里闷着不吭声，设置页永远拿不到画面摘要，
          // 预设卡上就没有对比度数字，滑杆下限也退回预设值。
          onDecision(lastDecision)
        }
        mountMedia()
        probe()
        // 布局稳定后再探一次：首帧时 frame 可能还在挂载中，早看会误判"层没铺上"。
        window.setTimeout(() => {
          if (alive && cfg !== null && cfg.enabled === true) probe()
        }, 1200)
        if (mediaEl !== null && mediaEl.tagName === 'VIDEO' && mediaEl.paused && mediaEl.autoplay) {
          const played = mediaEl.play()
          if (played !== undefined && typeof played.catch === 'function') played.catch(() => {})
        }
      }

      /** 后台标签页/失焦：暂停视频 —— 别在用户看不见的时候烧 GPU。 */
      const onVisibility = () => {
        if (mediaEl === null || mediaEl.tagName !== 'VIDEO') return
        if (document.hidden) {
          try {
            mediaEl.pause()
          } catch {
            /* 已暂停 */
          }
        } else if (mediaEl.autoplay) {
          const played = mediaEl.play()
          if (played !== undefined && typeof played.catch === 'function') played.catch(() => {})
        }
      }
      document.addEventListener('visibilitychange', onVisibility)

      /**
       * 深浅色主题变化后重新决策一次。
       *
       * 为什么必须监听（原先"决策只取决于壁纸画面"的说法是错的）：
       * `deriveTokens(decision, preset, { dark })` 里的 `dark` 决定**地板色**
       * （深色压近黑 `FLOOR_BASE.dark`、浅色压白）、可读性下限、以及釉色的钳制方向。
       * 也就是说同一个壁纸画面上，深色主题和浅色主题产出的令牌本来就不同。
       * 不重算的话，用户切了深浅色，界面面板还停在上一套地板色上，
       * 设置页显示的对比度读数也跟着失真 —— 只有改一次预设或滑杆才纠正。
       *
       * 为什么要延迟：内核写属性与重算样式不在同一帧的保证里。读属性本身
       * （`themeIsDark`）没问题，但 `snapshotNative` 读的是 **computed** 令牌 ——
       * 那边 `--dsw-alias-*` 还是旧主题的值。所以先记下"要重算"，等两帧再动手。
       */
      let themeObserver = null
      let themeFrame = 0
      const onThemeChange = () => {
        if (!alive || themeFrame !== 0) return
        themeFrame = window.setTimeout(() => {
          themeFrame = 0
          if (!alive || cfg === null || cfg.enabled !== true) return
          wallLog('深浅色变化 → 重新决策')
          // 地板色变了 → 快照也要重抄（否则设置页用的是旧主题的原生色）。
          snapshotNative()
          decideAndApply(lastDecision !== null && lastDecision.analysis ? lastDecision.analysis : null)
        }, 32)
      }
      if (typeof MutationObserver === 'function') {
        themeObserver = new MutationObserver(onThemeChange)
        // 内核 ThemePresenter 只写这两个属性（见 themeIsDark）：
        //   <html data-ds-theme-source="light|dark">、<body data-ds-dark-theme>
        const host = document.documentElement
        if (host !== null && host !== undefined) {
          themeObserver.observe(host, { attributes: true, attributeFilter: ['data-ds-theme-source'] })
        }
        if (document.body !== null && document.body !== undefined) {
          themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-ds-dark-theme'],
          })
        }
      }

      return {
        async load() {
          try {
            const res = await fetch(MANAGE, { cache: 'no-store' })
            const payload = await res.json()
            wallLog('load', res.status, payload && payload.wallpaper)
            if (alive && payload && payload.wallpaper) sync(payload.wallpaper)
          } catch (error) {
            wallLog('load 失败', error)
          }
        },
        /**
         * 这份配置和当前生效的那份一样吗？（只看影响画面的键）
         *
         * @param {object} next manage 回包里的 wallpaper 段。
         * @returns {boolean}
         */
        sameAs(next) {
          if (cfg === null || next === null || typeof next !== 'object') return false
          // 挡板要跟"画面由什么决定"对齐：少了 glassAlpha / surfaceBlur，
          // 换预设（只改这两个 + 釉色）会被当成"没变"直接跳过 —— 那正是
          // "点了预设，卡片变了但界面没动"。
          return (
            cfg.enabled === next.enabled &&
            cfg.file === next.file &&
            cfg.preset === next.preset &&
            cfg.scrim === next.scrim &&
            cfg.blur === next.blur &&
            cfg.saturate === next.saturate &&
            (cfg.glassAlpha ?? 0) === (next.glassAlpha ?? 0) &&
            (cfg.surfaceBlur ?? 0) === (next.surfaceBlur ?? 0)
          )
        },
        sync,
        /**
         * 拖滑杆时的"预览一步"：只改这一份配置里的微调，不重新挂素材、不落盘。
         *
         * 拖拽过程由设置页本地驱动 + rAF 合并，这里每帧最多跑一次 resolve+decide+paint，
         * 全是纯计算加一次 `textContent` 赋值 —— 不会触发应用任何组件重渲染。
         *
         * @param {{ scrim?: number | 'auto', blur?: number | 'auto', saturate?: number | 'auto', preset?: string }} tweak 只含变了的键。
         */
        preview(tweak) {
          if (!alive || cfg === null || cfg.enabled !== true) return
          if (tweak === null || typeof tweak !== 'object') return
          // 只覆盖五根滑杆能碰的键。sanitizeTweak 是整份配置的规范形，直接展开会把
          // text/surface/opacity 这些派生值一起"钉死"，换预设时就再也回不到预设自带的策略。
          const clean = sanitizeTweak({
            preset: cfg.preset,
            scrim: Number.isFinite(tweak.scrim) ? tweak.scrim : cfg.scrim,
            blur: Number.isFinite(tweak.blur) ? tweak.blur : cfg.blur,
            saturate: Number.isFinite(tweak.saturate) ? tweak.saturate : cfg.saturate,
            glassAlpha: Number.isFinite(tweak.glassAlpha) ? tweak.glassAlpha : cfg.glassAlpha,
            surfaceBlur: Number.isFinite(tweak.surfaceBlur) ? tweak.surfaceBlur : cfg.surfaceBlur,
          })
          cfg = {
            ...cfg,
            scrim: clean.scrim,
            blur: clean.blur,
            saturate: clean.saturate,
            glassAlpha: clean.glassAlpha,
            surfaceBlur: clean.surfaceBlur,
          }
          const resolved = resolvePreset(cfg)
          const hint = Array.isArray(cfg.hint) ? cfg.hint : []
          // 有画面摘要就用真画面，否则退回出厂代表色（两者都比"什么都不算"准）。
          const analysis = lastDecision !== null && lastDecision.analysis ? lastDecision.analysis : hint.length > 0 ? analyzeColors(hint) : null
          decideAndApply(analysis)
        },
        destroy() {
          alive = false
          document.removeEventListener('visibilitychange', onVisibility)
          if (themeObserver !== null) {
            themeObserver.disconnect()
            themeObserver = null
          }
          if (themeFrame !== 0) {
            window.clearTimeout(themeFrame)
            themeFrame = 0
          }
          clearAll()
          if (sheetEl !== null) {
            sheetEl.remove()
            sheetEl = null
          }
          lastCss = ''
          cfg = null
        },
      }
    }

    /**
     * 多只宠物的管理器。
     *
     * 职责只有三件：**哪几只该活着**（按 `pet.pets[].enabled` 增删实例）、
     * 共享的大小与总开关、菜单互斥。每只宠物自己的节奏、物理、位置都在实例里，
     * 互不干扰 —— 一只在飞，另一只照样待机。
     *
     * @param {{ onPersist: (patch: object) => void, t: (key: string) => string }} options 落盘回调 + 文案。
     * @returns {{ load: () => Promise<void>, sync: (pet: object) => void, play: (pack: string, id: string) => void, playCategory: (pack: string, id: string) => void, random: (pack: string) => void, report: () => void, reset: () => void, destroy: () => void }} 管理层。
     */
    function createPetLayer(options) {
      const onPersist = options.onPersist
      const t = options.t
      /** 全局：总开关 + 每只的状态（大小也是每只自己的，见 entry.size）。 */
      let pet = { enabled: false, display: 'page', pets: [] }
      /** @type {Map<string, ReturnType<typeof createPetInstance>>} */
      const instances = new Map()

      /** 关掉所有实例的右键菜单（开新菜单、收起宠物时用）。 */
      const closeMenus = () => {
        for (const instance of instances.values()) instance.closeMenu()
      }

      /** 把当前所有实例都收掉（总开关关掉 / 没有可显示的宠物）。 */
      const dropAll = () => {
        for (const instance of instances.values()) instance.destroy()
        instances.clear()
      }

      const sync = (next) => {
        if (!next || typeof next !== 'object') return
        pet.enabled = next.enabled === true
        pet.display = typeof next.display === 'string' ? next.display : 'page'
        // 每只的大小不在这里采纳：它由设置页的滑杆独占（拖的时候一路推 `dsa:pet-size`）。
        // 每次回包都应用一次旧值的话，拖着滑杆的宠物会被拽回上一个尺寸 —— 看着就是卡。
        if (Array.isArray(next.pets)) pet.pets = next.pets
        // 总开关关着、选了"全局界面"、或一个宠物包都没有：不建 DOM。
        // 素材几十 MB，不该占带宽和内存；"全局界面"下页面里再出现一只就是同一只宠物
        // 被复制成两份（两只各演各的），所以这里必须**互斥**。
        if (!pet.enabled || pet.display === 'global' || pet.pets.length === 0) {
          dropAll()
          return
        }
        const wanted = new Set(pet.pets.filter((item) => item.enabled === true).map((item) => item.id))
        for (const [id, instance] of [...instances]) {
          if (!wanted.has(id)) {
            instance.destroy()
            instances.delete(id)
          }
        }
        for (const entry of pet.pets) {
          if (entry.enabled !== true) continue
          const existing = instances.get(entry.id)
          if (existing === undefined) {
            // 新建时用**它自己的**大小；之后只认滑杆推过来的值。
            const instance = createPetInstance({
              entry,
              size: typeof entry.size === 'number' ? entry.size : 176,
              t,
              onPersist,
              onMenuOpen: closeMenus,
            })
            instance.update(entry)
            instances.set(entry.id, instance)
          } else {
            existing.update(entry)
          }
        }
      }

      /** 首次从服务端取状态（失败就安静地不出现 —— 宠物是装饰，不该报错）。 */
      const load = () =>
        fetch(MANAGE, { cache: 'no-store' })
          .then((res) => res.json())
          .then((payload) => {
            if (!payload || !payload.ok || !payload.pet) return
            sync(payload.pet)
          })
          .catch(() => {})

      /** 设置页拖滑杆时实时推过来的大小：只改那一只，**不落盘**。 */
      const setSize = (packId, size) => {
        if (typeof size !== 'number' || !Number.isFinite(size)) return
        withInstance(packId, (instance) => instance.setSize(size))
      }

      /** 对某一只动手；包不在场（还没开/已关）就什么都不做。 */
      const withInstance = (packId, run) => {
        const instance = instances.get(packId)
        if (instance !== undefined) run(instance)
      }

      return {
        load,
        sync,
        play: (packId, id) => withInstance(packId, (instance) => instance.play(id)),
        playCategory: (packId, id) => withInstance(packId, (instance) => instance.playCategory(id)),
        random: (packId) => withInstance(packId, (instance) => instance.random()),
        /** 滑杆实时推过来的大小：所有实例一起变（不落盘，落盘走原来的防抖 POST）。 */
        setSize,
        /** 每只自己报一次，设置页按 pack 挑它关心的那条。 */
        report: () => {
          for (const instance of instances.values()) instance.report()
        },
        /** 归位：**所有**宠物一起回右下角（一只飞出屏幕就不用逐只点了）。 */
        reset: () => {
          for (const instance of instances.values()) instance.reset()
        },
        destroy: () => {
          dropAll()
        },
      }
    }
    /**
     * 「启动动画」页：常驻设置区 + 下方 [MP4|壁纸|音频|宠物|更新公告] 分类切换器与内容面板。
     * @param {(key: string) => string} t 翻译。
     * @returns {React.ComponentType} 页面组件。
     */
    function makeStartupAnimationPage(t) {
      return function StartupAnimationPage() {
        const { state, busy, message, setMessage, send } = useStatus(t)
        const {
          version: localVersion,
          update,
          checking: updateChecking,
          reload: reloadVersion,
        } = useVersionInfo(t)
        const [category, setCategory] = React.useState('mp4')
        // 删除上传素材前先本地撤掉预览（中断浏览器对该文件的请求，给服务端释放句柄的窗口）。
        const [previewHidden, setPreviewHidden] = React.useState([])
        const syncedRef = React.useRef(false)
        const fileRef = React.useRef(null)
        const [sec, setSec] = React.useState(5)
        const commitRef = React.useRef(null)
        // 开机音频：音量滑杆 + 试听播放（同一时刻至多一条）。
        const [avol, setAvol] = React.useState(100)
        const avolRef = React.useRef(null)
        const [playingPath, setPlayingPath] = React.useState('')
        const audioElRef = React.useRef(null)
        // 宠物：大小滑杆的本地读数（拖动时只改本地，停手再提交）。
        const [petSize, setPetSize] = React.useState(176)
        const petSizeRef = React.useRef(null)
        // 全局界面下的实时尺寸预览：一帧最多一次 POST（16ms 定时器合并），
        // 以及"这一帧最后拖到的那一格"（回调发最新值，不是排队时的旧值）。
        const petPreviewFrame = React.useRef(0)
        const petPreviewNext = React.useRef(null)
        /** 宠物此刻在演哪个动作 —— 由浮层回报，用来高亮动作列表（它自己也会切，比如回应播完）。 */
        const [activeClip, setActiveClip] = React.useState('')
        /** 大宠物包（动作多）的搜索词；换宠物时清空。 */
        const [petQuery, setPetQuery] = React.useState('')
        /** 设置页"正在看"的那只（只影响下面展示谁的动作，不写配置）。 */
        const [selectedPack, setSelectedPack] = React.useState('')
        const petsAll = state && state.pet && Array.isArray(state.pet.pets) ? state.pet.pets : []
        const petSelectedId = (() => {
          if (petsAll.some((item) => item.id === selectedPack)) return selectedPack
          // 没选过 / 选中的那只被删了：优先落在"开着的第一只"，都关着就第一只。
          const on = petsAll.find((item) => item.enabled === true)
          return on !== undefined ? on.id : petsAll[0] !== undefined ? petsAll[0].id : ''
        })()
        // ── 卸载 / 更新（v1.11.0）──
        // 自管状态：宿主在 profile 里有没有装我们、有没有选中、装的是什么形态。
        const [selfState, setSelfState] = React.useState(null)
        const [selfBusy, setSelfBusy] = React.useState('')

        // 状态到达后同步滑杆位置（共用主配置 durationSec / audioVolume）。
        React.useEffect(() => {
          if (state && typeof state.durationSec === 'number') setSec(state.durationSec)
          if (state && typeof state.audioVolume === 'number') setAvol(Math.round(state.audioVolume * 100))
        }, [state])

        // 宠物大小滑杆跟着"当前看的那只"走：每只各记各的，切宠物就换成那只的值。
        // 只在选中这一只时同步（拖动过程中别被回包的旧值拽回去）。
        React.useEffect(() => {
          const target = petsAll.find((item) => item.id === petSelectedId)
          if (target === undefined || typeof target.size !== 'number') return
          setPetSize(target.size)
        }, [petSelectedId])

        // 设置页里的改动（开关 / 大小）要立刻反映到浮层上：两边不在同一棵渲染树上，
        // 用一条 window 事件桥接。浮层只取 enabled/size/pets，位置它自己管。
        React.useEffect(() => {
          if (!state || !state.pet) return
          window.dispatchEvent(new CustomEvent('dsa:pet-sync', { detail: state.pet }))
        }, [state])

        // 反过来：浮层切了动作就回报一声，列表跟着高亮（多只时只认当前看的那只）。
        // 用 ref 读"正在看哪只"：effect 只注册一次，避免闭包里拿到过期的那只。
        const petSelectedRef = React.useRef('')
        petSelectedRef.current = petSelectedId
        React.useEffect(() => {
          const onState = (event) => {
            const detail = event.detail
            if (detail === null || typeof detail !== 'object') return
            if (String(detail.pack || '') !== petSelectedRef.current) return
            setActiveClip(String(detail.id || ''))
          }
          window.addEventListener('dsa:pet-state', onState)
          // 先挂监听再问：宠物在页面加载时就开播了，那会儿没人听。
          window.dispatchEvent(new CustomEvent('dsa:pet-query'))
          return () => window.removeEventListener('dsa:pet-state', onState)
        }, [])

        // 换宠物后搜索词没有意义了（旧宠物的动作名对新宠物多半是空结果）。
        React.useEffect(() => {
          setPetQuery('')
          setActiveClip('')
          // 问一句"你现在在演哪个"，换到的那只立刻能对上高亮。
          window.dispatchEvent(new CustomEvent('dsa:pet-query'))
        }, [petSelectedId])

        // 首次拿到状态时，把分类切换器对齐到当前使用的素材（只做一次，之后尊重手动切换）。
        React.useEffect(() => {
          if (!state || syncedRef.current) return
          syncedRef.current = true
          const active = state.file || ''
          if (active.includes(`/${CATEGORY_ID.wall}/`) || active.startsWith(`${CATEGORY_ID.wall}/`)) {
            setCategory('wall')
            return
          }
          if (state.mode === 'image') setCategory('wall')
          else if (state.mode === 'video') setCategory('mp4')
        }, [state])

        // 卸载 / 更新要知道自己有没有被装在当前 profile 里。
        // 状态跟着 manage 的状态回包一起来（以前是单独的 /self 端点，但那条
        // 路由在某些宿主上会被吃掉 —— 400 且没有 body —— 于是按钮整块消失）。
        // 这里**不**再把它拷进独立 state：直接从 `state.self` 派生，少一次
        // 渲染回合，也少一处可能对不上的副本。`selfState` 只用来放"刚卸载完"
        // 这种本地覆盖。

        // 卸载时清掉未触发的防抖提交与试听播放。
        React.useEffect(
          () => () => {
            if (commitRef.current !== null) clearTimeout(commitRef.current)
            if (avolRef.current !== null) clearTimeout(avolRef.current)
            if (petSizeRef.current !== null) clearTimeout(petSizeRef.current)
            if (audioElRef.current !== null) {
              try {
                audioElRef.current.pause()
              } catch {
                /* 已停 */
              }
              audioElRef.current = null
            }
          },
          [],
        )

        // 拖动只改本地读数，停手 350ms 后提交一次 —— 不把每个像素都打成请求。
        const onSlide = (value) => {
          const next = Math.min(30, Math.max(3, Math.round(Number(value))))
          setSec(next)
          if (commitRef.current !== null) clearTimeout(commitRef.current)
          commitRef.current = setTimeout(() => {
            commitRef.current = null
            postJson(send, { durationSec: next }, t('saved'))
          }, 350)
        }

        const toggle = (key) => {
          if (!state) return
          // UI 开关键名 → 状态字段名：enable 必须映射到 enabled。
          // 回归（v1.4.0）：曾直接读 state['enable']（undefined），!undefined 恒为 true，
          // 导致"显示开机动画"永远写回 true、开关关不掉。
          const field = key === 'enable' ? 'enabled' : key
          postJson(send, { [field]: !state[field] }, t('saved'))
        }

        // 音量滑杆：同展示时长的防抖方式（停手 350ms 提交一次）。
        const onVolSlide = (value) => {
          const next = Math.min(100, Math.max(0, Math.round(Number(value))))
          setAvol(next)
          if (avolRef.current !== null) clearTimeout(avolRef.current)
          avolRef.current = setTimeout(() => {
            avolRef.current = null
            postJson(send, { audioVolume: next / 100 }, t('saved'))
          }, 350)
        }

        // 宠物大小：滑杆每动一格都**立刻**推给浮层（不落盘），停手 350ms 再提交一次。
        //
        // 为什么不能等回包再变：拖滑杆时宠物要是不跟手，手感就是"卡"——用户看到的是
        // 一个 350ms 的静止 + 一次跳变。落盘与显示解耦，拖起来才是连续的。
        // 大小是**每只自己的**，所以事件和落盘都带上当前选中的 pack。
        //
        // 「全局界面」下还要多一条实时通道：桌面 helper 是独立进程，收不到窗口内的
        // `dsa:pet-size` 事件。以前它只能等 350ms 落盘 → 宿主 sync → 大小在重建指纹里
        // → 整个 Electron 进程被停掉重开，用户看到的就是"拖的时候没反应，停手闪没
        // 一秒再长回来"。现在每帧顺带 POST 一次 `petPreview`（不写盘，helper 当场改
        // 窗口大小），两档手感一致。页面档不发这个请求 —— 浮层已经跟着走了。
        const onPetSize = (value) => {
          const next = Math.min(320, Math.max(100, Math.round(Number(value))))
          setPetSize(next)
          const packId = petSelectedId
          window.dispatchEvent(
            new CustomEvent('dsa:pet-size', { detail: { pack: packId, size: next } }),
          )
          // 停手 350ms 落盘一次（每格都写盘会把配置刷成一片中间值）。
          if (petSizeRef.current !== null) clearTimeout(petSizeRef.current)
          petSizeRef.current = setTimeout(() => {
            petSizeRef.current = null
            postJson(send, { petResize: { pack: packId, size: next } }, t('petSaved'))
          }, 350)
          if (!(state && state.pet && state.pet.display === 'global')) return
          // 记住这一帧的最新值：range 的 change 比帧还密，回调要发"最后拖到的那格"，
          // 不是发排队时的第一格（那样宠物会永远慢半拍，且松手前最后一格丢帧）。
          petPreviewNext.current = { pack: packId, size: next }
          if (petPreviewFrame.current !== 0) return
          petPreviewFrame.current = window.setTimeout(() => {
            petPreviewFrame.current = 0
            const latest = petPreviewNext.current
            if (latest === null) return
            petPreviewNext.current = null
            // 不写盘、不回状态：helper 收到就改窗口，一句 {ok} 就回。
            void fetch(MANAGE, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ petPreview: latest }),
            })
              .then((res) => res.json())
              // helper 没在跑（刚切档 / 还没拉起来）就什么都不做：
              // 尺寸由随后那次 petResize 落盘，重建时自然带上。
              .catch(() => {})
          }, 16)
        }

        /** 宠物开关：字段在 state.pet 里，不走通用 toggle（那个读的是顶层字段）。 */
        const togglePet = () => {
          if (!state || !state.pet) return
          postJson(send, { petEnabled: !state.pet.enabled }, t('petSaved'))
        }

        /**
         * 保证某一只在显示，然后执行动作。
         *
         * 宠物没开（总开关或这一只）就先打开它 —— 用户按了按钮就是要看。总开关关着时
         * 先开总开关；这一只关着时再单独开它。两次回包都会把新状态推给浮层，
         * 所以要在 `fire` 之前等它到位。
         *
         * @param {(payload: object | null) => void} fire 真正发事件的回调。
         */
        const withPetOn = (fire) => {
          if (!state || !state.pet) return
          const target = petsAll.find((item) => item.id === petSelectedId)
          const needMaster = state.pet.enabled !== true
          const needThis = target !== undefined && target.enabled !== true
          if (!needMaster && !needThis) {
            fire(null)
            return
          }
          const first = needMaster ? { petEnabled: true } : { petToggle: { pack: petSelectedId, enabled: true } }
          void postJson(send, first, t('petSaved')).then((payload) => {
            if (!payload || !payload.ok) return
            if (payload.pet) window.dispatchEvent(new CustomEvent('dsa:pet-sync', { detail: payload.pet }))
            // 总开关刚打开时，这一只可能还是关的，补一刀再播。
            if (needThis && needMaster) {
              void postJson(send, { petToggle: { pack: petSelectedId, enabled: true } }, t('petSaved')).then((second) => {
                if (second && second.ok && second.pet) {
                  window.dispatchEvent(new CustomEvent('dsa:pet-sync', { detail: second.pet }))
                }
                setTimeout(() => fire(second), 60)
              })
              return
            }
            setTimeout(() => fire(payload), 60)
          })
        }

        /** 指定动作：演一遍回待机（不写配置，纯预览）。 */
        const previewPet = (id) =>
          withPetOn(() =>
            window.dispatchEvent(new CustomEvent('dsa:pet-play', { detail: { pack: petSelectedId, id } })),
          )

        /** 分类卡：让浮层在这个分类里随机挑一个。 */
        const previewPetCategory = (id) =>
          withPetOn(() =>
            window.dispatchEvent(new CustomEvent('dsa:pet-category', { detail: { pack: petSelectedId, id } })),
          )

        /** 「随机一个」：从全体待机动作里抽。 */
        const previewPetRandom = () =>
          withPetOn(() => window.dispatchEvent(new CustomEvent('dsa:pet-random', { detail: { pack: petSelectedId } })))

        /** 开/关某一只：只动这一只，别的宠物不受影响。 */
        const togglePack = (id, enabled) => {
          if (!state || !state.pet) return
          postJson(send, { petToggle: { pack: id, enabled } }, t('petSaved'))
        }

        /** 试听/停止一条音频（列表内点击，不影响开机配置）。 */        const togglePlay = (file) => {
          if (audioElRef.current !== null) {
            try {
              audioElRef.current.pause()
            } catch {
              /* 已停 */
            }
            audioElRef.current = null
          }
          if (playingPath === file.path) {
            setPlayingPath('')
            return
          }
          const node = new Audio(`${ASSET}?path=${encodeURIComponent(file.path)}`)
          node.volume = Math.min(1, Math.max(0, avol / 100))
          node.addEventListener('ended', () => {
            if (audioElRef.current === node) audioElRef.current = null
            setPlayingPath('')
          })
          node.addEventListener('error', () => {
            if (audioElRef.current === node) audioElRef.current = null
            setPlayingPath('')
          })
          audioElRef.current = node
          setPlayingPath(file.path)
          const played = node.play()
          if (played && typeof played.catch === 'function') {
            played.catch(() => {
              audioElRef.current = null
              setPlayingPath('')
            })
          }
        }

        const onFile = (event) => {
          const input = event.target
          const file = input.files && input.files.length > 0 ? input.files[0] : null
          input.value = ''
          if (!file) return
          const limit = (state && state.limitBytes) || 128 * 1024 * 1024
          if (file.size > limit) {
            setMessage({ text: t('tooBig'), kind: 'error' })
            return
          }
          // 上传只入库不选用：宿主按扩展名自动归类，用户再从列表点"使用"。
          send(
            {
              method: 'POST',
              headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'X-Dsh-Filename': encodeURIComponent(file.name || ''),
              },
              body: file,
            },
            category === 'audio' ? t('audioUploaded') : t('uploaded'),
          )
        }

        /**
         * 删除素材。
         * 上传素材：先本地撤下预览（浏览器中断对该文件的请求 → 服务端发送流关闭 → 释放句柄），
         * 等 250ms 再发删除；服务端真删重试后仍被系统占用时会回 hiddenOnly → 提示"仅隐藏"。
         */
        const deleteFile = (file) => {
          if (file.uploaded !== true) {
            postJson(send, { forget: file.path }, t('removed'))
            return
          }
          setPreviewHidden((prev) => (prev.includes(file.path) ? prev : prev.concat(file.path)))
          setTimeout(() => {
            postJson(send, { forget: file.path }, (payload) =>
              payload && payload.hiddenOnly ? t('deleteHidden') : t('deletedFile'),
            )
          }, 250)
        }

        /**
         * 自我管理动作的提交口：只发请求、只管拿到回包。
         *
         * 不复用 `send` —— 那条路会改 `busy` 并把 `error` 当成失败文案，
         * 而卸载/更新要的是 `message` + `details`，并且自己管 `selfBusy`。
         * @param {object} body 动作载荷（`{action:'uninstall'}` 等）。
         * @returns {Promise<object|null>} 回包，拿不到就是 null。
         */
        const postSelf = (body) =>
          fetch(MANAGE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).then((res) => res.json().catch(() => null))

        /**
         * 卸载本插件。
         *
         * 走插件自己的 manage 端点（不是插件管理器的卸载按钮 —— 那条路在没有
         * HMR 的桌面 profile 上必然被拒）。
         * 卸载会改磁盘上的 profile 清单，所以要重启 DSH 才完全生效。
         */
        const doUninstall = () => {
          if (!globalThis.confirm(t('uninstallConfirm'))) return
          setSelfBusy('uninstall')
          setMessage({ text: '', kind: '' })
          postSelf({ action: 'uninstall' })
            .then((payload) => {
              setSelfBusy('')
              if (payload && payload.ok) {
                const where = payload.userData ? t('keepData').replace('{path}', payload.userData.config) : ''
                setMessage({
                  text: where === '' ? t('uninstalled') : `${t('uninstalled')} · ${where}`,
                  kind: 'ok',
                })
                setSelfState({ installed: false, selected: false })
              } else {
                const detail = payload && payload.details ? `\n${String(payload.details).slice(-400)}` : ''
                setMessage({
                  text: `${t('uninstallFailed')}${payload && payload.message ? `：${payload.message}` : ''}${detail}`,
                  kind: 'error',
                })
              }
            })
            .catch(() => {
              setSelfBusy('')
              setMessage({ text: t('netFail'), kind: 'error' })
            })
        }

        /**
         * 更新本插件到最新版。
         *
         * 目标 spec 由宿主决定（Release 的 tgz 直链）—— 客户端不拼 URL，
         * 免得白名单在两边各写一份、慢慢走样。
         * 磁盘改动要重启 DSH 才生效。
         */
        const doUpdate = () => {
          setSelfBusy('update')
          setMessage({ text: '', kind: '' })
          postSelf({ action: 'update' })
            .then((payload) => {
              setSelfBusy('')
              if (payload && payload.ok) {
                setMessage({ text: t('updated'), kind: 'ok' })
                // 立刻重取版本：宿主那边已经用**磁盘上的**新版本应答，
                // 这里刷新一次就能把标题换成新版本号、"更新到 x"的按钮也随之消失。
                // 不刷新的话，用户会看到"更新成功"却仍挂着"更新到 1.12.2"，以为没生效。
                void reloadVersion({ force: true, silent: true })
              } else {
                const detail = payload && payload.details ? `\n${String(payload.details).slice(-400)}` : ''
                setMessage({
                  text: `${t('updateFailed')}${payload && payload.message ? `：${payload.message}` : ''}${detail}`,
                  kind: 'error',
                })
              }
            })
            .catch(() => {
              setSelfBusy('')
              setMessage({ text: t('netFail'), kind: 'error' })
            })
        }

        const switch_ = (key, checked) =>
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-set-switch',
              role: 'switch',
              'aria-checked': checked ? 'true' : 'false',
              'aria-label': key === 'enable' ? t('enable') : key === 'audioEnabled' ? t('audioEnable') : t('sound'),
              disabled: busy,
              onClick: () => toggle(key),
            },
            h('span', { className: 'dsa-set-knob' }),
          )

        const assetText = !state
          ? ''
          : state.custom
            ? `${state.builtin ? t('usingBuiltin') : t('usingCustom')} · ${displayName(state.name)}`
            : t('stockLabel')

        // 当前素材预览：有素材时显示媒体块（加载失败退回纯文字行）。
        const [curBroken, setCurBroken] = React.useState(false)
        const curIsVideo = !!(state && state.custom) && VIDEO_EXT.test(state.name || '')
        const showCurPreview = !!state && state.custom && !curBroken
        React.useEffect(() => {
          setCurBroken(false)
        }, [state && state.file])

        // ── 分类区数据 ──
        const catId = CATEGORY_ID[category]
        const categoryData = state ? ((state.library || []).find((cat) => cat.id === catId) || null) : null
        const files = categoryData ? categoryData.files : []
        const activeFile = state ? state.file : ''
        const activeAudio = state ? state.audioFile : ''
        const categoryLabel =
          category === 'pet'
            ? t('catPet')
            : category === 'mp4'
              ? t('catMp4')
              : category === 'wall'
                ? t('catWall')
                : t('catAudio')
        const isAudioCat = category === 'audio'
        // 第四个页签不是素材分类：它没有上传、没有卡片，内容是 /update 带回的 Release 正文。
        const isReleaseCat = category === 'release'
        // 宠物页签同理：长得像分类，其实是"宠物设置 + 动作预览"。
        const isPetCat = category === 'pet'
        // 主题页签：壁纸/视频铺进界面。同样是设置页，不是素材库。
        const isThemeCat = category === 'theme'

        /**
         * 壁纸主题状态：`state.wallpaper` 是宿主的真相，`liveDecision` 是浏览器侧
         * 实际算出来的对比度（背景层按 `dsa:wall-decision` 广播）。
         *
         * 两者分开的原因：预设卡片要用"真算一遍"的结论来预览 —— 同一张壁纸上
         * 七个预设各是什么效果，光看名字看不出来，能算出对比度就看出来了。
         */
        const wallpaper = state && state.wallpaper ? state.wallpaper : null
        const [liveDecision, setLiveDecision] = React.useState(null)
        React.useEffect(() => {
          const onDecision = (event) => setLiveDecision(event.detail || null)
          window.addEventListener('dsa:wall-decision', onDecision)
          // 挂载时主动问一次：背景层可能早就算完了（它比设置页先起来）。
          window.dispatchEvent(new CustomEvent('dsa:wall-query'))
          return () => window.removeEventListener('dsa:wall-decision', onDecision)
        }, [])
        /** 壁纸开着才谈得上调它自己的参数（与开机动画的 cfg.enabled 无关）。 */
        const wallpaperOn = wallpaper !== null && wallpaper.enabled === true

        /**
         * 对**当前这张壁纸**算一遍每个预设：拿背景层已经取样到的画面摘要，
         * 逐个 decideTheme → 得到"字色 + 幕浓度 + 实际对比度"。
         *
         * 画面摘要（`analysis`）是唯一的外部输入，两个来源，按可信度排：
         *   ① 背景层真取样到的画面（`dsa:wall-decision` 广播）；
         *   ② 内置素材的出厂代表色（`wallpaper.hint`）—— 背景层要是还没起来、
         *      或者根本没收到广播，就用它兜底。**不能返回 null**：那样七格预设一个
         *      数字都没有，用户看到的就是"这些卡片是死的"。
         */
        const presetPreview = (presetId) => {
          const sampled = liveDecision && liveDecision.analysis ? liveDecision.analysis : null
          const hint = wallpaper !== null && Array.isArray(wallpaper.hint) ? wallpaper.hint : []
          const analysis = sampled !== null ? sampled : hint.length > 0 ? analyzeColors(hint) : null
          if (analysis === null) return null
          const resolved = resolvePreset({ preset: presetId, scrim: 'auto', blur: 'auto', saturate: 'auto' })
          try {
            return decideTheme(analysis, resolved)
          } catch {
            return null
          }
        }

        /**
         * 点了就画：先把这份补丁合并进背景层，再落盘。
         *
         * 宿主是本地进程，回包通常只有几毫秒 —— 但那几毫秒是"点了没动静"的全部观感，
         * 而且一旦回包慢/丢了（宿主重启、路由 500），用户只会得到"点了没反应"。
         * 服务器仍是唯一真相：回包到了会再同步一次，值一样就被背景层的 sameAs 短路。
         *
         * 只做**不换素材**的补丁（预设、滑杆、开关）：换素材要先由宿主校验文件类型、
         * 算出 src 与 kind，本地猜一遍只会猜错。
         *
         * @param {object} patch 提交给宿主的那份补丁（wallpaperPreset / wallpaper* 键）。
         */
        const paintNow = (patch) => {
          if (wallpaper === null) return
          // 换素材不本地预演：文件类型要宿主判、src 要宿主拼，猜错了就是先闪一张旧的再换。
          if ('wallpaperFile' in patch) return
          const next = { ...wallpaper }
          const switchingPreset = typeof patch.wallpaperPreset === 'string' && patch.wallpaperPreset !== next.preset
          if (switchingPreset) {
            next.preset = patch.wallpaperPreset
            // 换预设 = 换整套观感：把旧预设的微调（磨砂半径、遮挡）一并清掉，
            // 否则残留值会盖住新预设 —— 用户看到的还是上一套的磨砂。
            next.surfaceBlur = 'auto'
            next.scrim = 'auto'
            next.glassAlpha = 'auto'
            next.blur = 'auto'
            next.saturate = 'auto'
            // 画面摘要要重算：磨砂半径现在是预设自带的观感，而 hint（出厂代表色）
            // 算出来的摘要跟真画面算出来的可能不一样 —— 不换的话换预设只改了卡片。
            const hint = Array.isArray(next.hint) ? next.hint : []
            next.analysis = hint.length > 0 ? analyzeColors(hint) : null
          }
          // 'auto' 与"没传"都表示"回到预设自带的值"：交给 sanitizeTweak 就不必在
          // 这里重写一遍优先级（它内部就是 resolvePreset，非有限数即跳过）。
          const sliderKeys = [
            ['wallpaperScrim', 'scrim'],
            ['wallpaperBlur', 'blur'],
            ['wallpaperSaturate', 'saturate'],
          ]
          for (const [from, to] of sliderKeys) {
            // `switchingPreset` 刚把那几个键清成 'auto'：这里要**跳过**，不能改回去。
            if (switchingPreset && to !== 'preset') continue
            if (patch[from] === 'auto') next[to] = 'auto'
            else if (Number.isFinite(patch[from])) next[to] = patch[from]
          }
          if (typeof patch.wallpaperEnabled === 'boolean') next.enabled = patch.wallpaperEnabled
          const tweak = sanitizeTweak({
            preset: next.preset,
            scrim: next.scrim,
            blur: next.blur,
            saturate: next.saturate,
            glassAlpha: next.glassAlpha,
            surfaceBlur: next.surfaceBlur,
          })
          window.dispatchEvent(
            new CustomEvent('dsa:wall-sync', {
              detail: { ...next, ...tweak, enabled: next.enabled === true && next.src !== '' },
            }),
          )
        }

        const wallCfg = (patch, okText) => {
          paintNow(patch)
          return postJson(send, patch, okText)
        }

        /**
         * 标题旁的版本小字。
         *
         * 有新版本时它就是「更新」按钮本体 —— 点一下直接更新（manage 路由的
         * `{action:'update'}`，宿主拿 Release tgz 跑 pnpm），不再跳转 GitHub
         * 让用户自己下包。当前版本号永远显示，用户确认装的是哪一版只看这里。
         *
         *   - 有新版本 → 按钮亮起「v1.2.3 · 更新到 1.2.4」，点了就地更新；
         *   - 更新中 → 转成「更新中…」；
         *   - 已是最新 / 检查不到 → 安静的版本号（不给红色错误）。
         */
        const versionBadge = () => {
          // 安装形态：selfState（刚卸载后的本地覆盖）优先，否则取 manage 状态里的 self。
          const info = selfState !== null ? selfState : state && typeof state.self === 'object' ? state.self : null
          // 版本前缀两语共用「v」，和版本号之间不留空格：`v1.11.0`。
          const text = localVersion === '' ? '' : `${t('versionLabel')}${localVersion}`
          if (text === '') return null
          const hasUpdate = update !== null && update.updateAvailable === true
          const reachable = update !== null && update.reachable === true
          /**
           * 副标签只在**真的需要用户行动**时出现。
           *
           * 平时标题旁只留一枚安静的版本号。只有两种情况会加字：
           *   - 有新版本 → 「更新到 x.y.z」（就在这个按钮上，点了直接更新）；
           *   - 检查中 → 「检查更新中…」，仅在没有缓存结果的首帧出现。
           * 「已是最新」「检查不到」都不加字：用户没装新版时不需要被打扰，
           * 而离线时把"检查不到"挂在标题上只会让人以为插件坏了。
           * 这两种状态仍然在 title 属性里，鼠标悬停可查。
           */
          const note = updateChecking
            ? t('updateChecking')
            : hasUpdate && typeof update.latest === 'string'
              // t() 不做变量插值（生态通行做法是 .replace）：直接给它第二参数
              // 只会原样显示 "{latest}"，所以这里必须自己替换。
              ? t('updateNow').replace('{version}', update.latest)
              : reachable
                ? t('updateLatest')
                : t('updateUnknown')
          const showNote = updateChecking || hasUpdate

          // 有新版本 → 版本小字整个变成按钮：点一下就地更新，不跳 GitHub。
          // 不满足更新条件的（link: 安装、更新中、还没拿到安装形态）保持纯文字，
          // selfPanel 里那颗大按钮是同一条 doUpdate，行为完全一致。
          if (hasUpdate && info !== null && info.installed === true) {
            const linked = typeof info.spec === 'string' && info.spec.startsWith('link:')
            if (!linked) {
              return h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-set-ver-btn',
                  'data-update': '1',
                  title: `${text} · ${t('updateNow').replace('{version}', update.latest)}`,
                  disabled: selfBusy !== '',
                  onClick: doUpdate,
                },
                selfBusy === 'update' ? t('updating') : `${text} · ${note}`,
              )
            }
          }

          return h(
            'span',
            { className: 'dsa-set-ver', 'data-update': hasUpdate ? '1' : '0', title: note },
            showNote ? `${text} · ${note}` : text,
          )
        }

        /**
         * 卸载 / 更新 这一块。
         *
         * 只在插件**确实装在当前 profile 里**时才出现（selfState.installed）——
         * 读不到状态就不显示，不给用户一个按了没用的按钮。
         *
         * 「更新」按钮只在真的有新版本时出现；「卸载」一直在（用户不需要插件时
         * 最需要的就是它）。
         *
         * `link:` 安装（开发时把 profile 指向源码目录）不给「更新」：那条依赖
         * 不指向任何版本，用 tgz 覆盖会把开发链接换成发行包 —— 不是用户想要的。
         */
        const selfPanel = () => {
          const info = selfState !== null ? selfState : state && typeof state.self === 'object' ? state.self : null
          if (!info || info.installed !== true) return null
          const hasUpdate = update !== null && update.updateAvailable === true
          const latest = hasUpdate && typeof update.latest === 'string' ? update.latest : ''
          const linked = typeof info.spec === 'string' && info.spec.startsWith('link:')
          return h(
            'div',
            { className: 'dsa-set-self' },
            h(
              'div',
              { className: 'dsa-set-self-head' },
              h('div', { className: 'dsa-set-label' }, t('manageTitle')),
              h(
                'div',
                { className: 'dsa-set-right' },
                hasUpdate && latest !== '' && !linked
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsa-set-btn',
                        disabled: selfBusy !== '' || busy,
                        onClick: doUpdate,
                      },
                      selfBusy === 'update' ? t('updating') : t('updateNow').replace('{version}', latest),
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa-set-btn dsa-set-btn-danger',
                    disabled: selfBusy !== '' || busy,
                    onClick: doUninstall,
                  },
                  selfBusy === 'uninstall' ? t('uninstalling') : t('uninstall'),
                ),
              ),
            ),
            h('div', { className: 'dsa-set-note' }, t('manageNote')),
          )
        }

        const categoryPanel = h(
          'div',
          { className: 'dsa-set-panel', role: 'tabpanel', 'aria-label': categoryLabel },
          h('div', { className: 'dsa-set-desc' }, isAudioCat ? t('audioNote') : t('libraryDesc')),
          h(
            'div',
            { className: 'dsa-set-row' },
            h(
              'div',
              { className: 'dsa-set-label' },
              isAudioCat ? t('uploadAudio') : category === 'wall' ? t('uploadWall') : t('uploadInto'),
            ),
            h(
              'div',
              { className: 'dsa-set-right' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-set-btn',
                  disabled: busy,
                  onClick: () => !busy && fileRef.current && fileRef.current.click(),
                },
                busy ? t('uploading') : t('upload'),
              ),
            ),
          ),
          state === null
            ? null
            : files.length === 0
              ? h('div', { className: 'dsa-set-empty' }, isAudioCat ? t('audioEmpty') : t('libEmpty'))
              : isAudioCat
                ? h(
                    // 音频分类：与壁纸同款卡片网格 —— 无封面，画面区放音乐图标；
                    // 点卡片选用，中央 ▶ 试听（不关选用），悬停右上 × 删除。
                    'div',
                    { className: 'dsa-set-grid' },
                    files.map((file) => {
                      const active = activeAudio === file.path
                      const playing = playingPath === file.path
                      return h(
                        'div',
                        { className: 'dsa-set-card', key: file.path },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsa-set-card-hit',
                            'aria-pressed': active ? 'true' : 'false',
                            'aria-label': `${file.name} — ${active ? t('using') : t('use')}`,
                            disabled: busy,
                            onClick: () => {
                              if (!active) postJson(send, { useAudio: file.path }, t('saved'))
                            },
                          },
                          h('div', { className: 'dsa-set-amedia' }, '♪'),
                          h('span', { className: active ? 'dsa-set-card-using' : 'dsa-set-card-type' }, active ? t('using') : t('audioType')),
                          h('span', { className: 'dsa-set-card-name', title: displayName(file.name) }, displayName(file.name)),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsa-set-aplay',
                            'data-on': playing ? '1' : '0',
                            'aria-label': `${playing ? 'stop' : 'play'} ${file.name}`,
                            title: playing ? '■' : '▶',
                            onClick: (event) => {
                              event.stopPropagation()
                              if (!busy) togglePlay(file)
                            },
                          },
                          playing ? '■' : '▶',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsa-set-card-del',
                            'aria-label': `${t('removeUploaded')} ${file.name}`,
                            title: t('removeUploaded'),
                            disabled: busy,
                            onClick: (event) => {
                              event.stopPropagation()
                              deleteFile(file)
                            },
                          },
                          '×',
                        ),
                      )
                    }),
                  )
                : h(
                    'div',
                    { className: 'dsa-set-grid' },
                    files.map((file) => {
                      const active = activeFile === file.path
                      const video = VIDEO_EXT.test(file.name)
                      const hidden = previewHidden.includes(file.path)
                      return h(
                        'div',
                        { className: 'dsa-set-card', key: file.path },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsa-set-card-hit',
                            'aria-pressed': active ? 'true' : 'false',
                            'aria-label': `${file.name} — ${active ? t('using') : t('use')}`,
                            disabled: busy,
                            onClick: () => {
                              if (!active) postJson(send, { use: file.path }, t('saved'))
                            },
                          },
                          hidden
                            ? h('div', { className: 'dsa-set-card-ph' }, displayName(file.name))
                            : thumbEl(file.path, video, 'dsa-set-card-media', (event) => {
                                event.currentTarget.style.display = 'none'
                              }),
                          h(
                            'span',
                            { className: active ? 'dsa-set-card-using' : 'dsa-set-card-type' },
                            active ? t('using') : video ? t('video') : t('image'),
                          ),
                          // 来源标记：内置与上传可能同名（用户上传过同一段素材时），
                          // 只显示素材名会让人分不清选的是哪一个 —— 内置随包走、上传在 DSH_HOME。
                          // 视频再补一个时长（`12s`）：启动动画只有几秒可看，选之前就想知道多长；
                          // 读不到时长的（非 MP4/文件坏了）不显示，不占位。
                          h(
                            'span',
                            { className: 'dsa-set-card-name', title: displayName(file.name) },
                            displayName(file.name),
                            video && typeof file.duration === 'number'
                              ? h('span', { className: 'dsa-set-card-src' }, durationLabel(file.duration))
                              : null,
                            h(
                              'span',
                              { className: 'dsa-set-card-src' },
                              file.uploaded === true ? t('badgeUploaded') : t('badgeBuiltin'),
                            ),
                          ),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsa-set-card-del',
                            // 内置素材只从列表隐藏（包内文件保留），上传素材是真删文件 ——
                            // 语义不同，按钮文案就得分开，不能都写"删除"。
                            'aria-label': `${file.uploaded === true ? t('removeUploaded') : t('removeBuiltin')} ${file.name}`,
                            title: file.uploaded === true ? t('removeUploaded') : t('removeBuiltin'),
                            disabled: busy || hidden,
                            onClick: (event) => {
                              event.stopPropagation()
                              deleteFile(file)
                            },
                          },
                          '×',
                        ),
                      )
                    }),
                  ),
        )

        /**
         * 更新公告面板：渲染 `/update` 带回的 Release 正文。
         *
         * 三种安静状态，全用已有的版本检查文案，不新增报错样式：
         *   - 还在查 → "检查更新中…"；查不到正文（离线/无 Release）→ "检查不到更新"；
         *   - 查到了 → 抬头标出**是哪一版**（可能比本机新，正是值得看公告的时刻），
         *     下面按 Release 正文原样分节列要点。
         */
        const noteLines = update === null ? [] : parseReleaseNotes(update.notes)
        const releasePanel = h(
          'div',
          { className: 'dsa-set-panel', role: 'tabpanel', 'aria-label': t('catRelease') },
          updateChecking
            ? h('div', { className: 'dsa-set-empty' }, t('updateChecking'))
            : noteLines.length === 0
              ? h('div', { className: 'dsa-set-empty' }, t('updateUnknown'))
              : h(
                  'div',
                  { className: 'dsa-set-ann' },
                  h(
                    'div',
                    { className: 'dsa-set-ann-head' },
                    t('annHead').replace('{version}', String(update.latest ?? '')),
                  ),
                  noteLines.map((line, index) =>
                    line.kind === 'head'
                      ? h('div', { className: 'dsa-set-ann-h', key: index }, line.text)
                      : line.kind === 'item'
                        ? h('div', { className: 'dsa-set-ann-item', key: index }, line.text)
                        : h('div', { className: 'dsa-set-ann-text', key: index }, line.text),
                  ),
                ),
        )

        /**
         * 宠物面板：开关 + 大小 + 宠物选择 + 动作区。
         *
         * 动作**不写死**：清单来自宿主扫描 `builtin/宠物/`，丢一个新 webm 进去就多一条。
         * 动作少的包直接平铺；动作多的（女仆 109 段）按分类展示，配搜索和「随机一个」——
         * 铺一百多个格子没人看得下去。
         */
        const pet = state && state.pet && typeof state.pet === 'object' ? state.pet : null
        const petPacks = petsAll
        const petPack = petsAll.find((item) => item.id === petSelectedId) || petsAll[0] || null
        const petClips = petPack && Array.isArray(petPack.clips) ? petPack.clips : []
        const petCats = petPack && Array.isArray(petPack.categories) ? petPack.categories : []
        const petMany = petClips.length > 12
        const petKeyword = petQuery.trim()
        const petHits = petKeyword === '' ? [] : petClips.filter((clip) => clip.name.includes(petKeyword)).slice(0, 8)
        const petNow = petClips.find((clip) => clip.id === activeClip) || null
        /** 动作区标题带上宠物名：多只同屏时得知道现在看的是哪一只。 */
        const petActionTitle = petPack === null ? t('petAction') : `${t('petAction')} · ${petPack.name}`
        const petAsset = (file) => `${ASSET}?path=${encodeURIComponent(file)}`
        /**
         * 显示位置：DSH界面 / 全局界面。
         *
         * 两档都保证**有且只有一只**宠物：
         *   · DSH界面 = 浮在页面里；
         *   · 全局界面 = 一个透明置顶窗浮在所有窗口之上（DSH 里当然也看得见）。
         *
         * 为什么没有"都显示"：那会让同一只宠物同时以页面浮层和桌面窗存在，
         * 两个实例各跑一套节奏、各有一份物理 —— 用户看到的是两只一样的动物在
         * 各演各的（截图里一只在堆雪人一只在待机）。删掉这一档，动作才是一体的。
         */
        const petWhere = pet !== null && typeof pet.display === 'string' ? pet.display : 'page'
        const petDesktop = pet !== null && pet.desktop && typeof pet.desktop === 'object' ? pet.desktop : null
        const petDesktopOk = petDesktop !== null && petDesktop.available === true
        const petWhereBtn = (value, label) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              className: 'dsa-set-seg',
              'aria-pressed': petWhere === value ? 'true' : 'false',
              'data-on': petWhere === value ? '1' : '0',
              // 全局界面不可用（非 Windows / 没 Electron）时禁掉；"DSH界面"永远可用。
              disabled: busy || pet === null || (value === 'global' && !petDesktopOk),
              onClick: () => postJson(send, { petDisplay: value }, t('petSaved')),
            },
            label,
          )
        const petWhereRow = h(
          'div',
          { className: 'dsa-set-row' },
          h(
            'div',
            null,
            h('div', { className: 'dsa-set-label' }, t('petWhere')),
            petDesktopOk ? null : h('div', { className: 'dsa-set-note' }, petDesktop === null ? '' : String(petDesktop.reason || '')),
          ),
          h(
            'div',
            { className: 'dsa-set-right' },
            h(
              'div',
              { className: 'dsa-set-segs', role: 'group', 'aria-label': t('petWhere') },
              petWhereBtn('page', t('petWherePage')),
              petWhereBtn('global', t('petWhereGlobal')),
            ),
          ),
        )
        const petSwitch = h(
          'button',
          {
            type: 'button',
            className: 'dsa-set-switch',
            role: 'switch',
            'aria-checked': pet && pet.enabled ? 'true' : 'false',
            'aria-label': t('petEnableAll'),
            disabled: busy || pet === null,
            onClick: togglePet,
          },
          h('span', { className: 'dsa-set-knob' }),
        )
        const petResetBtn = h(
          'button',
          {
            type: 'button',
            className: 'dsa-set-btn',
            disabled: busy || pet === null || !pet.enabled,
            onClick: () => window.dispatchEvent(new CustomEvent('dsa:pet-reset')),
          },
          t('petReset'),
        )
        const petRandomBtn = h(
          'button',
          {
            type: 'button',
            className: 'dsa-set-btn',
            disabled: busy || pet === null,
            onClick: previewPetRandom,
          },
          t('petRandom'),
        )
        /**
         * 一个宠物 = 一张卡：封面 + 名字 + 动作数 + 右上角一个小开关。
         *
         * - 点卡本身 = **选中看它**（下面那块动作列表跟着换），不影响宠物显不显示；
         * - 点右上角的开关 = **开/关这一只**，多只可以同时开着。
         *
         * 为什么不用 button 包一层：button 里套 button 是非法嵌套，浏览器会把内层
         * 拆出来，点开关会连带触发"选中"。所以外壳是 div，里面两个各自独立的 button。
         */
        const petPackCard = (item) =>
          h(
            'div',
            {
              key: item.id,
              className: 'dsa-set-pet',
              'data-on': petPack && petPack.id === item.id ? '1' : '0',
              'data-live': item.enabled ? '1' : '0',
            },
            h(
              'button',
              {
                type: 'button',
                className: 'dsa-set-pet-hit',
                'aria-pressed': petPack && petPack.id === item.id ? 'true' : 'false',
                disabled: busy || pet === null,
                onClick: () => setSelectedPack(item.id),
              },
              item.cover
                ? h('img', { className: 'dsa-set-pet-cover', src: petAsset(item.cover), alt: '', loading: 'lazy' })
                : h('div', { className: 'dsa-set-pet-cover' }),
              h('span', { className: 'dsa-set-pet-name' }, item.name),
              h('span', { className: 'dsa-set-pet-count' }, `${item.count} ${t('petUnit')}`),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsa-set-switch dsa-set-pet-switch',
                role: 'switch',
                'aria-checked': item.enabled ? 'true' : 'false',
                'aria-label': `${t('petEnable')} · ${item.name}`,
                disabled: busy || pet === null,
                onClick: () => togglePack(item.id, !item.enabled),
              },
              h('span', { className: 'dsa-set-knob' }),
            ),
          )
        /** 一个分类 = 一张卡；按下去浮层在这个分类里随机挑一个，省得一个个点。 */
        const petCatCard = (cat) =>
          h(
            'button',
            {
              key: cat.id,
              type: 'button',
              className: 'dsa-set-cat',
              'data-on': activeClip !== '' && Array.isArray(cat.clips) && cat.clips.includes(activeClip) ? '1' : '0',
              disabled: busy || pet === null,
              onClick: () => previewPetCategory(cat.id),
            },
            cat.cover
              ? h('img', { className: 'dsa-set-cat-cover', src: petAsset(cat.cover), alt: '', loading: 'lazy' })
              : h('div', { className: 'dsa-set-cat-cover' }),
            h('span', { className: 'dsa-set-cat-name' }, cat.name),
            h('span', { className: 'dsa-set-cat-count' }, `${cat.clips.length} ${t('petUnit')}`),
          )
        /** 一个动作 = 一个格子。宠物没开也能按（会先打开它），按了就该看到反应。 */
        const petClipCard = (clip) =>
          h(
            'button',
            {
              key: clip.id,
              type: 'button',
              className: 'dsa-set-act',
              'data-on': activeClip === clip.id ? '1' : '0',
              'aria-pressed': activeClip === clip.id ? 'true' : 'false',
              disabled: busy || pet === null,
              onClick: () => previewPet(clip.id),
            },
            clip.thumb
              ? h('img', { className: 'dsa-set-act-thumb', src: petAsset(clip.thumb), alt: '', loading: 'lazy' })
              : null,
            h('span', { className: 'dsa-set-act-name' }, clip.name),
          )
        const petResults =
          petKeyword === ''
            ? null
            : h(
                'div',
                { className: 'dsa-set-chips' },
                petHits.length === 0
                  ? h('span', { className: 'dsa-set-empty' }, t('petNoMatch'))
                  : petHits.map((clip) =>
                      h(
                        'button',
                        {
                          key: clip.id,
                          type: 'button',
                          className: 'dsa-set-chip',
                          'data-on': activeClip === clip.id ? '1' : '0',
                          disabled: busy || pet === null,
                          onClick: () => previewPet(clip.id),
                        },
                        clip.thumb
                          ? h('img', { className: 'dsa-set-chip-thumb', src: petAsset(clip.thumb), alt: '', loading: 'lazy' })
                          : null,
                        clip.name,
                      ),
                    ),
              )
        /**
         * 壁纸面板：开关 + 预设 + 微调 + 素材（所有 MP4 与图片）。
         *
         * 布局顺序跟着**用户的思考顺序**走：先决定"要不要壁纸"，再挑素材，
         * 然后挑"整体观感"（预设），最后才是"手痒想微调"的滑杆。
         * 预设卡片上直接写着算出来的对比度 —— 用户选的不是名字，是"看得清"。
         */
        const wallPanel = (() => {
          const cfg = wallpaper || {
            enabled: false,
            file: '',
            src: '',
            kind: '',
            name: '',
            preset: DEFAULT_PRESET_ID,
            scrim: 0.5,
            blur: 0,
            saturate: 1,
          }
          // 素材候选：MP4 与壁纸两个分类合起来，视频在前（视频壁纸是这个功能的主角）。
          // 分类 id 是目录名（`MP4` / `图片`），不是页签名 —— 认错了整块素材区就是空的。
          const wallFiles = []
          for (const id of ['MP4', '图片']) {
            const cat = state ? (state.library || []).find((entry) => entry.id === id) : null
            // 宿主打过 `themeable: false` 的素材不参与"界面主题"的候选（比如竖屏短剧那种
            // 铺满屏幕会糊成一片的片段），但它仍然留在素材库里当开机动画用 —— 两个页签
            // 读的是同一份 library，只是主题这边筛掉。
            if (cat) for (const file of cat.files) if (file.themeable !== false) wallFiles.push(file)
          }
          /**
           * 滑杆正在被拖的键 → 拖到的那一格值。
           *
           * 为什么要本地状态：滑杆若是"纯受控"（value 只认 state），松手前每一格都要等
           * 一次 POST 回来才动 —— 滑块就滞后在自己的手指后面，看着就是不跟手。这里拖动时
           * 只用本地值绘制（立刻跟手），松手才落盘；落盘回来的数再交还给 state。
           */
          const [drag, setDrag] = React.useState(null)
          /** 合并成一帧只发一次预览的句柄（range 的 change 事件比帧还密）。 */
          const previewFrame = React.useRef(0)
          const previewNext = React.useRef(null)
          const flushPreview = () => {
            previewFrame.current = 0
            const patch = previewNext.current
            previewNext.current = null
            if (patch === null) return
            window.dispatchEvent(new CustomEvent('dsa:wall-preview', { detail: patch }))
          }
          /**
           * 线协议键 → 引擎键。**只看这张表**，别再在别处手写一遍。
           *
           * 两个名字为什么不一样：`wallpaperScrim` 是写进配置/请求体的键（宿主按它
           * 夹取、落盘），`scrim` 是壁纸引擎内部那份配置的形状（`resolvePreset` /
           * `sanitizeTweak` 都认后者）。拖动预览在浏览器内直接调引擎，走的是后者。
           *
           * 踩过的坑：`slider()` 拿的是线协议键，直接 `sendPreview(key, value)` 派发，
           * 引擎收到 `{wallpaperScrim: 0.4}` 去读 `tweak.scrim` → undefined → 回落到
           * `cfg.scrim` 用**原值**重画。于是三根滑杆拖动时界面纹丝不动，松手落盘后
           * 才跳变一次 —— 看着像"预览没实现"，其实是键名没对上。
           */
          const sliderKeys = [
            ['wallpaperScrim', 'scrim'],
            ['wallpaperBlur', 'blur'],
            ['wallpaperSaturate', 'saturate'],
          ]
          const engineKeyOf = (key) => {
            const hit = sliderKeys.find(([from]) => from === key)
            return hit === undefined ? key : hit[1]
          }
          const sendPreview = (key, value) => {
            const engineKey = engineKeyOf(key)
            previewNext.current = { ...(previewNext.current || {}), [engineKey]: value }
            if (previewFrame.current === 0) {
              previewFrame.current =
                typeof window.requestAnimationFrame === 'function'
                  ? window.requestAnimationFrame(flushPreview)
                  : window.setTimeout(flushPreview, 16)
            }
          }
          // 停手：把最后一格落盘（一次 POST，不是每格一次），再结束本地拖动。
          const commit = (key, value) => {
            if (previewFrame.current !== 0 && typeof window.cancelAnimationFrame === 'function') {
              window.cancelAnimationFrame(previewFrame.current)
              previewFrame.current = 0
            }
            previewNext.current = null
            setDrag(null)
            wallCfg({ [key]: value }, t('saved'))
          }

          const activePreset = PRESETS.find((item) => item.id === cfg.preset) || PRESETS[0]
          // 滑杆读的是"预设 + 微调"合起来的真值：用户拖到的就是他会看到的。
          const shown = resolvePreset({
            preset: cfg.preset,
            scrim: cfg.scrim,
            blur: cfg.blur,
            saturate: cfg.saturate,
            glassAlpha: cfg.glassAlpha,
            surfaceBlur: cfg.surfaceBlur,
          })
          /**
           * 幕浓度的滑杆下限：用户可以把幕调薄，但**不能薄到字看不清**。
           * 这是"壁纸不影响用户看字"这条承诺在 UI 上的落点 —— 刻度到顶就是 0.92，
           * 但下限由当前画面的决策给出（拿不到画面摘要时用预设值兜底）。
           *
           * 注意这里不直接用 `liveDecision`：那份摘要来自背景层的广播，广播链路任何
           * 一环没送到（背景层还没起来、规则被宿主拦了），下限就会退回预设值、卡片上
           * 的对比度也会整排消失 —— 看着就像"这些数字是假的"。所以统一走 presetPreview
           * （它自己会退回内置取色）。
           */
          const liveNow = presetPreview(cfg.preset)
          const liveContrast = liveNow !== null && typeof liveNow.contrast === 'number' ? liveNow.contrast : null

          const slider = (key, label, min, max, step, value, unit) => {
            const dragging = drag !== null && typeof drag[key] === 'number'
            const current = dragging ? drag[key] : value
            return h(
              'div',
              { className: 'dsa-set-row' },
              h('div', { className: 'dsa-set-label' }, label),
              h(
                'div',
                { className: 'dsa-set-right' },
                h(
                  'span',
                  { className: 'dsa-set-sec' },
                  `${Math.round(current * (unit === '%' ? 100 : 1))}${unit === '%' ? '%' : unit}`,
                ),
                h('input', {
                  type: 'range',
                  className: 'dsa-set-range',
                  min,
                  max,
                  step,
                  value: current,
                  'aria-label': label,
                  // 拖动期间不禁用：busy 一置真滑杆会自己松手，体验更差。
                  disabled: dragging ? false : busy || !wallpaperOn,
                  // 每一格：只本地记值 + 让壁纸层自己重画（不 POST，也不重渲染整页）。
                  onChange: (event) => {
                    const next = Number(event.target.value)
                    if (!Number.isFinite(next)) return
                    setDrag((prev) => ({ ...(prev || {}), [key]: next }))
                    sendPreview(key, next)
                  },
                  // 松手：一次落盘。
                  onPointerUp: (event) => {
                    const next = Number(event.target.value)
                    if (Number.isFinite(next)) commit(key, next)
                  },
                  // 键盘/无障碍路径没有 pointerup，用 change 收尾。
                  onKeyUp: (event) => {
                    const next = Number(event.target.value)
                    if (Number.isFinite(next)) commit(key, next)
                  },
                  onBlur: () => {
                    if (dragging) commit(key, current)
                  },
                }),
              ),
            )
          }

          /**
           * 预设卡片：九宫格里的一格。
           *
           * 画面上那两条字是**真的预览**，不是装饰：底色按当前壁纸的决策上色，
           * 字色是决策算出来的墨色 —— 用户看这一格就等于看"换成这个预设之后标题栏长什么样"。
           */
          const presetCard = (preset) => {
            const decision = presetPreview(preset.id)
            const active = cfg.preset === preset.id
            const ink = decision ? (decision.ink === 'light' ? '#ffffff' : '#111111') : activePreset.text === 'light' ? '#ffffff' : '#111111'
            const scrimAlpha = decision ? decision.scrim : preset.scrim
            const surface = decision ? decision.ink : preset.text === 'light' ? 'light' : 'dark'
            return h(
              'button',
              {
                key: preset.id,
                type: 'button',
                className: 'dsa-set-preset',
                'aria-pressed': active ? 'true' : 'false',
                'data-tone': surface,
                disabled: busy,
                title: decision ? `${preset.name} · ${decision.contrast.toFixed(2)}:1` : preset.name,
                // 预设是"整套观感"：必须把滑杆的残留值一并清回 auto。
                // 只写 preset 的话，之前拖过的 scrim/blur/saturate/glass 会继续
                // 盖住新预设 —— 幕浓度和玻璃纹丝不动，用户看到的就是"点了没反应"。
                onClick: () =>
                  wallCfg(
                    {
                      wallpaperPreset: preset.id,
                      wallpaperScrim: 'auto',
                      wallpaperBlur: 'auto',
                      wallpaperSaturate: 'auto',
                      wallpaperGlass: 'auto',
                    },
                    t('saved'),
                  ),
              },
              h(
                'span',
                { className: 'dsa-set-preset-art', 'aria-hidden': 'true' },
                h('span', { className: 'dsa-set-preset-scrim', style: { background: surface === 'light' ? '#000' : '#fff', opacity: String(scrimAlpha) } }),
                h('span', { className: 'dsa-set-preset-ink', style: { color: ink } }, 'Aa'),
              ),
              h('span', { className: 'dsa-set-preset-name' }, preset.name),
              decision ? h('span', { className: 'dsa-set-preset-ratio' }, `${decision.contrast.toFixed(1)}:1`) : null,
            )
          }

          return h(
            'div',
            { className: 'dsa-set-panel', role: 'tabpanel', 'aria-label': t('catTheme') },
            // ── ① 开关 ──
            h(
              'div',
              { className: 'dsa-set-row' },
              h(
                'div',
                { className: 'dsa-set-label' },
                cfg.enabled ? `${t('wallEnable')} · ${displayName(cfg.name)}` : t('wallEnable'),
              ),
              h(
                'div',
                { className: 'dsa-set-right' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa-set-switch',
                    role: 'switch',
                    'aria-checked': cfg.enabled ? 'true' : 'false',
                    'aria-label': t('wallEnable'),
                    disabled: busy || cfg.file === '',
                    onClick: () => wallCfg({ wallpaperEnabled: !cfg.enabled }, t('saved')),
                  },
                  h('span', { className: 'dsa-set-knob' }),
                ),
              ),
            ),
            // ── ② 预设：一键套用整套观感 ──
            h(
              'div',
              { className: 'dsa-set-stack' },
              h(
                'div',
                { className: 'dsa-set-stack-head' },
                h('div', { className: 'dsa-set-label' }, t('wallPreset')),
                h(
                  'div',
                  { className: 'dsa-set-right' },
                  h(
                    'span',
                    { className: 'dsa-set-hint' },
                    liveContrast === null ? t('wallPresetHint') : `${t('wallContrast')} ${liveContrast.toFixed(2)}:1`,
                  ),
                ),
              ),
              h('div', { className: 'dsa-set-presets' }, PRESETS.map(presetCard)),
            ),
            // 预设只管颜色（每套一套釉色），**遮挡**归滑杆：出厂全是 0，所以"刚装上、
            // 刚换预设"看到的一定是原样的壁纸 —— 想看更有遮挡的面板就往上加。
            //
            // 玻璃厚度那根已经收掉：实测只有 0 才看得见壁纸，往上加就是一层实色，留着只是误导。
            // 面板遮挡全靠遮罩厚度一根；可读性下限挂在引擎里，与滑杆无关。
            slider('wallpaperScrim', t('wallScrim'), SCREEN_LIMITS.scrim[0], SCREEN_LIMITS.scrim[1], 0.02, shown.scrim, '%'),
            slider('wallpaperBlur', t('wallBlur'), SCREEN_LIMITS.blur[0], SCREEN_LIMITS.blur[1], 1, shown.blur, 'px'),
            slider('wallpaperSaturate', t('wallSaturate'), SCREEN_LIMITS.saturate[0], SCREEN_LIMITS.saturate[1], 0.05, shown.saturate, '×'),
            // ── ④ 素材：所有视频与图片都能当壁纸 ──
            h(
              'div',
              { className: 'dsa-set-stack' },
              h(
                'div',
                { className: 'dsa-set-stack-head' },
                h('div', { className: 'dsa-set-label' }, t('wallPick')),
              ),
              wallFiles.length === 0
                ? h('div', { className: 'dsa-set-empty' }, t('libEmpty'))
                : h(
                    'div',
                    { className: 'dsa-set-grid' },
                    wallFiles.map((file) => {
                      const active = cfg.file === file.path
                      const video = VIDEO_EXT.test(file.name)
                      return h(
                        'div',
                        { className: 'dsa-set-card', key: `wall-${file.path}` },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsa-set-card-hit',
                            'aria-pressed': active ? 'true' : 'false',
                            'aria-label': `${file.name} — ${active ? t('using') : t('wallUse')}`,
                            disabled: busy,
                            onClick: () => {
                              if (!active) wallCfg({ wallpaperFile: file.path, wallpaperEnabled: true }, t('wallSaved'))
                            },
                          },
                          thumbEl(file.path, video, 'dsa-set-card-media', (event) => {
                            event.currentTarget.style.display = 'none'
                          }),
                          h(
                            'span',
                            { className: active ? 'dsa-set-card-using' : 'dsa-set-card-type' },
                            active ? t('wallUsing') : video ? t('video') : t('image'),
                          ),
                          h(
                            'span',
                            { className: 'dsa-set-card-name', title: displayName(file.name) },
                            displayName(file.name),
                          ),
                        ),
                      )
                    }),
                  ),
            ),
          )
        })()

        const petPanel = h(
          'div',
          { className: 'dsa-set-panel', role: 'tabpanel', 'aria-label': t('catPet') },
          h(
            'div',
            { className: 'dsa-set-row' },
            h('div', { className: 'dsa-set-label' }, t('petEnableAll')),
            h('div', { className: 'dsa-set-right' }, petSwitch),
          ),
          petWhereRow,
          h(
            'div',
            { className: 'dsa-set-row' },
            h(
              'div',
              { className: 'dsa-set-label' },
              petPack === null ? t('petSize') : `${t('petSize')} · ${petPack.name}`,
            ),
            h(
              'div',
              { className: 'dsa-set-right' },
              h('span', { className: 'dsa-set-sec' }, `${petSize}px`),
              h('input', {
                type: 'range',
                className: 'dsa-set-range',
                min: 100,
                max: 320,
                step: 4,
                value: petSize,
                'aria-label': t('petSize'),
                onChange: (event) => onPetSize(event.target.value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'dsa-set-stack' },
            h(
              'div',
              { className: 'dsa-set-stack-head' },
              h('div', { className: 'dsa-set-label' }, t('petPick')),
            ),
            petPacks.length === 0
              ? h('div', { className: 'dsa-set-empty' }, t('petEmpty'))
              : h('div', { className: 'dsa-set-pets' }, petPacks.map(petPackCard)),
          ),
          h(
            'div',
            { className: 'dsa-set-stack' },
            h(
              'div',
              { className: 'dsa-set-stack-head' },
              h('div', { className: 'dsa-set-label' }, petActionTitle),
              h('div', { className: 'dsa-set-right' }, petMany ? petRandomBtn : null, petResetBtn),
            ),
            petClips.length === 0
              ? h('div', { className: 'dsa-set-empty' }, t('petEmpty'))
              : petMany
                ? h(
                    'div',
                    { className: 'dsa-set-search' },
                    h('input', {
                      type: 'search',
                      className: 'dsa-set-input',
                      value: petQuery,
                      placeholder: t('petSearch'),
                      'aria-label': t('petSearch'),
                      onChange: (event) => setPetQuery(event.target.value),
                    }),
                    petResults,
                    petResults === null
                      ? h('div', { className: 'dsa-set-cats' }, petCats.map(petCatCard))
                      : null,
                  )
                : h('div', { className: 'dsa-set-acts' }, petClips.map(petClipCard)),
            petNow ? h('div', { className: 'dsa-set-now' }, `${t('petNow')} ${petNow.name}`) : null,
          ),
        )

        return h(
          'div',
          { className: 'dsa-set-wrap', 'data-dsa-ui': '1', 'data-busy': busy ? '1' : '0' },
          h('style', null, STYLE),
          // ── 标题栏：标题 + 版本小字 + 立即刷新（页面重载 → 运行时读到实时配置）──
          h(
            'div',
            { className: 'dsa-set-titlebar' },
            h(
              'div',
              { className: 'dsa-set-heading' },
              h('div', { className: 'dsa-set-title' }, t('title')),
              versionBadge(),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsa-set-btn',
                disabled: busy,
                onClick: () => window.location.reload(),
              },
              t('refresh'),
            ),
          ),
          // ── 卸载 / 更新（装在 profile 里才有）──
          selfPanel(),
          // ── 设置区（常驻）──
          h('div', { className: 'dsa-set-desc' }, t('desc')),
          h(
            'div',
            { className: 'dsa-set-row' },
            h('div', { className: 'dsa-set-label' }, t('enable')),
            h('div', { className: 'dsa-set-right' }, switch_('enable', !!state && state.enabled)),
          ),
          h(
            'div',
            { className: 'dsa-set-row' },
            h('div', { className: 'dsa-set-label' }, t('sound')),
            h('div', { className: 'dsa-set-right' }, switch_('sound', !!state && state.sound)),
          ),
          h(
            'div',
            { className: 'dsa-set-row' },
            h(
              'div',
              null,
              h('div', { className: 'dsa-set-label' }, t('audioEnable')),
              h('div', { className: 'dsa-set-note' }, t('audioNote')),
            ),
            h('div', { className: 'dsa-set-right' }, switch_('audioEnabled', !!state && state.audioEnabled)),
          ),
          // 音频素材行：当前音频名 + 试听 + 音量滑杆（开关开着才显示）。
          !!state && state.audioEnabled
            ? h(
                'div',
                { className: 'dsa-set-row' },
                h(
                  'div',
                  { className: 'dsa-set-cur-info' },
                  h('div', { className: 'dsa-set-label' }, t('audioAsset')),
                  h(
                    'div',
                    { className: 'dsa-set-cur-name' },
                    state.audioFile
                      ? `${state.audioBuiltin ? t('usingBuiltin') : t('usingCustom')} · ${displayName(state.audioName)}`
                      : t('audioNone'),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsa-set-right' },
                  state.audioFile
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsa-set-btn',
                          disabled: busy,
                          onClick: () =>
                            togglePlay({ path: state.audioFile, name: state.audioName }),
                        },
                        playingPath === state.audioFile ? '■' : '▶',
                      )
                    : null,
                  h('span', { className: 'dsa-set-sec' }, `${avol}%`),
                  h('input', {
                    type: 'range',
                    className: 'dsa-set-range',
                    min: 0,
                    max: 100,
                    step: 1,
                    value: avol,
                    'aria-label': t('audioVolume'),
                    onChange: (event) => onVolSlide(event.target.value),
                  }),
                ),
              )
            : null,
          h(
            'div',
            { className: 'dsa-set-row' },
            h('div', { className: 'dsa-set-label' }, t('duration')),
            h(
              'div',
              { className: 'dsa-set-right' },
              h('span', { className: 'dsa-set-sec' }, `${sec}${t('secUnit')}`),
              h('input', {
                type: 'range',
                className: 'dsa-set-range',
                min: 3,
                max: 30,
                step: 1,
                value: sec,
                'aria-label': t('duration'),
                onChange: (event) => onSlide(event.target.value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'dsa-set-row' },
            // 素材行：当前动画预览（视频取首帧 / 图片直显；无素材或加载失败退回文字行）。
            h(
              'div',
              { className: 'dsa-set-cur' },
              showCurPreview
                ? thumbEl(state.file, curIsVideo, 'dsa-set-cur-thumb', () => setCurBroken(true))
                : null,
              h(
                'div',
                { className: 'dsa-set-cur-info' },
                h('div', { className: 'dsa-set-label' }, t('asset')),
                h('div', { className: 'dsa-set-cur-name' }, assetText),
              ),
            ),
            h(
              'div',
              { className: 'dsa-set-right' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-set-btn',
                  disabled: busy || !state || !state.custom,
                  onClick: () => send({ method: 'DELETE' }, t('restored')),
                },
                t('restore'),
              ),
            ),
          ),
          // ── 分类切换器：[MP4 | 壁纸 | 音频 | 宠物 | 更新公告]（素材三类 + 宠物 + 一个信息页）──
          h(
            'div',
            { className: 'dsa-set-tabs', role: 'tablist', 'aria-label': t('title') },
            [
              { id: 'mp4', label: t('catMp4') },
              { id: 'wall', label: t('catWall') },
              // 主题：壁纸/视频铺进界面。与"壁纸"（开机动画的素材分类）同源不同事，
              // 所以分成两个页签 —— 一个管素材，一个管界面长什么样。
              { id: 'theme', label: t('catTheme') },
              { id: 'audio', label: t('catAudio') },
              { id: 'pet', label: t('catPet') },
              { id: 'release', label: t('catRelease') },
            ].map((entry) =>
              h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  className: 'dsa-set-tab',
                  role: 'tab',
                  'aria-selected': category === entry.id ? 'true' : 'false',
                  onClick: () => {
                    // 手动切过页签就放弃"自动对齐到当前素材"：状态晚到一步
                    // 会把用户正在看的页签切走（尤其是刚点开更新公告时）。
                    syncedRef.current = true
                    setCategory(entry.id)
                  },
                },
                entry.label,
              ),
            ),
          ),
          isReleaseCat ? releasePanel : isPetCat ? petPanel : isThemeCat ? wallPanel : categoryPanel,
          // 上传输入随分类切换 accept。
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: ACCEPT_BY_CATEGORY[category],
            style: { display: 'none' },
            onChange: onFile,
          }),
          h(
            'div',
            { className: 'dsa-set-status', 'data-kind': message.kind || undefined },
            message.text || '',
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', DICT_ZH)
          const offEn = ctx.locale.register(NS, 'en', DICT_EN)
          const t = ctx.locale.bind(NS)
          const Page = makeStartupAnimationPage(t)

          // 唯一的侧栏条目；MP4 / 壁纸是页内分类功能，不占用侧栏。
          const offSlots = ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'startup-animation', order: 50, label: () => t('nav') },
              Page,
            ),
          )

          // ── 桌面宠物：常驻浮层，和设置页无关（关掉设置页它还在）──
          //
          // 位置由浮层自己写盘：拖动结束时 POST 一次 petMove（带 pack）。设置页只做
          // "开关 / 大小 / 触发动作"，两边用 window 事件桥接，互不持有引用。
          // POST 的回包会广播成 dsa:pet-sync：右键菜单里"隐藏"自己之后，浮层和
          // 设置页的开关都能立刻对上，不用等用户手动刷新。
          const petLayer = createPetLayer({
            t,
            onPersist: (patch) => {
              // 纯位置写入（拖动/归位落地）：只要写盘成功，本地状态已经有了，
              // 不需要回包，也不需要再扫一遍素材库。用 `?lite=1` 拿到一句 {ok} 就走 ——
              // 完整 status 会让每次松手都多等几十上百毫秒（拖起来就是"卡一下"）。
              const positionOnly =
                Object.keys(patch).length === 1 && patch.petMove !== undefined
              void fetch(positionOnly ? `${MANAGE}?lite=1` : MANAGE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
              })
                .then((res) => res.json())
                .then((payload) => {
                  // 只有拿到完整状态时才广播同步：lite 回包没有 pet 段，
                  // 拿它去 sync 会把浮层状态清空。
                  if (payload && payload.pet) {
                    window.dispatchEvent(new CustomEvent('dsa:pet-sync', { detail: payload.pet }))
                  }
                })
                .catch(() => {})
            },
          })
          const onPetSync = (event) => petLayer.sync(event.detail)
          // 下面几条都带 pack：多只同屏时，"演这个动作"要指名是哪一只。
          const onPetPlay = (event) => {
            const detail = event.detail
            if (detail === null || typeof detail !== 'object') return
            petLayer.play(String(detail.pack || ''), String(detail.id || ''))
          }
          const onPetCategory = (event) => {
            const detail = event.detail
            if (detail === null || typeof detail !== 'object') return
            petLayer.playCategory(String(detail.pack || ''), String(detail.id || ''))
          }
          const onPetRandom = (event) => {
            const detail = event.detail
            petLayer.random(detail === null || typeof detail !== 'object' ? '' : String(detail.pack || ''))
          }
          const onPetReset = () => petLayer.reset()
          // 滑杆每动一格就推一次（带 pack）；浮层只改那一只的视觉，落盘另有 350ms 防抖。
          const onPetSize = (event) => {
            const detail = event.detail
            if (detail === null || typeof detail !== 'object') return
            petLayer.setSize(String(detail.pack || ''), Number(detail.size))
          }
          // 设置页翻到宠物页签时会问一句"现在在演哪个"，好把动作列表的高亮对上。
          const onPetQuery = () => petLayer.report()
          window.addEventListener('dsa:pet-sync', onPetSync)
          window.addEventListener('dsa:pet-play', onPetPlay)
          window.addEventListener('dsa:pet-category', onPetCategory)
          window.addEventListener('dsa:pet-random', onPetRandom)
          window.addEventListener('dsa:pet-reset', onPetReset)
          window.addEventListener('dsa:pet-size', onPetSize)
          window.addEventListener('dsa:pet-query', onPetQuery)
          void petLayer.load()

          // ── 壁纸主题：常驻背景层，和设置页无关（关掉设置页它还在）──
          //
          // 与宠物浮层同一套桥：设置页写完盘 POST 一次，回包广播成
          // `dsa:wall-sync`，背景层立刻跟着改；设置页也监听它刷新自己的卡片状态。
          const wallLayer = createWallpaperLayer({
            t,
            onDecision: (info) => {
              window.dispatchEvent(new CustomEvent('dsa:wall-decision', { detail: info }))
            },
          })
          const onWallSync = (event) => {
            const detail = event.detail
            if (detail === null || typeof detail !== 'object') return
            // 落盘回包可能和刚才拖出来的预览一模一样（滑杆停手后就是这种情况）：
            // 键都没变就什么都不做，省掉一次决策 + 一次样式表重写。
            if (wallLayer.sameAs(detail)) return
            wallLayer.sync(detail)
          }
          // 拖滑杆时的逐帧预览：只走壁纸层自己，不碰设置页 state
          // （碰了就是每帧重渲染整页 —— 那就是"滑杆不跟手"的根源）。
          const onWallPreview = (event) => {
            const detail = event.detail
            if (detail !== null && typeof detail === 'object') wallLayer.preview(detail)
          }
          const onWallQuery = () => {
            void wallLayer.load()
          }
          window.addEventListener('dsa:wall-sync', onWallSync)
          window.addEventListener('dsa:wall-preview', onWallPreview)
          window.addEventListener('dsa:wall-query', onWallQuery)
          void wallLayer.load()

          return () => {
            window.removeEventListener('dsa:wall-sync', onWallSync)
            window.removeEventListener('dsa:wall-preview', onWallPreview)
            window.removeEventListener('dsa:wall-query', onWallQuery)
            try {
              wallLayer.destroy()
            } catch {
              /* 页面卸载时可能已被清掉 */
            }
            window.removeEventListener('dsa:pet-sync', onPetSync)
            window.removeEventListener('dsa:pet-play', onPetPlay)
            window.removeEventListener('dsa:pet-category', onPetCategory)
            window.removeEventListener('dsa:pet-random', onPetRandom)
            window.removeEventListener('dsa:pet-reset', onPetReset)
            window.removeEventListener('dsa:pet-size', onPetSize)
            window.removeEventListener('dsa:pet-query', onPetQuery)
            try {
              petLayer.destroy()
            } catch {
              /* 浮层可能已经因为页面卸载被清掉 */
            }
            for (const off of [offSlots, offZh, offEn]) {
              try {
                off && off()
              } catch {
                /* 已注销 */
              }
            }
          }
        })
      },
    }
  },
})
