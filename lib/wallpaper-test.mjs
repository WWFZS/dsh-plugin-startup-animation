/**
 * lib/wallpaper.mjs 的单测：node lib/wallpaper-test.mjs
 *
 * 断言的重点不是"公式对不对"（那是 WCAG 的定义），而是**可读性的承诺**：
 * 不管喂什么画面，`decideTheme` 出来的结论都必须真的把字压在 ≥ 4.5:1 上，
 * 除非预设明确要求"别碰字色"（keep）。
 */
import assert from 'node:assert/strict'

import {
  CONTRAST_BODY,
  DEFAULT_PRESET_ID,
  INK,
  PRESETS,
  analyzeColors,
  analyzePixels,
  contrastRatio,
  decideTheme,
  deriveTokens,
  layerStyle,
  parseHex,
  pickInk,
  relativeLuminance,
  resolvePreset,
  rgba,
  sanitizeTweak,
  solveScrim,
  toHex,
  SCREEN_LIMITS,
} from './wallpaper.mjs'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('== 颜色基础 ==')
check('#rgb 与 #rrggbb', () => {
  assert.deepEqual(parseHex('#fff'), { r: 255, g: 255, b: 255 })
  assert.deepEqual(parseHex('#151517'), { r: 21, g: 21, b: 23 })
  assert.equal(parseHex('nope'), null)
  assert.equal(parseHex(undefined), null)
})
check('toHex 往返', () => {
  for (const hex of ['#000000', '#ffffff', '#7c5cff', '#0a141e']) {
    assert.equal(toHex(parseHex(hex)), hex)
  }
})
check('rgba 夹取 alpha', () => {
  assert.equal(rgba({ r: 1, g: 2, b: 3 }, 2), 'rgba(1, 2, 3, 1)')
  assert.equal(rgba({ r: 1, g: 2, b: 3 }, -1), 'rgba(1, 2, 3, 0)')
  assert.equal(rgba({ r: 1.4, g: 2.6, b: 3 }, 0.5), 'rgba(1, 3, 3, 0.5)')
})
check('相对亮度端点', () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0)
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1)
})
check('黑白对比度 21:1', () => {
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21)
})
check('pickInk 选得对', () => {
  assert.equal(pickInk({ r: 8, g: 8, b: 12 }), 'light')
  assert.equal(pickInk({ r: 245, g: 240, b: 230 }), 'dark')
})

console.log('== 幕浓度求解 ==')
check('本来就够 → 0', () => {
  assert.equal(solveScrim({ r: 0, g: 0, b: 0 }, 'light', CONTRAST_BODY), 0)
})
check('够不着 → 1（不撒谎）', () => {
  // 白字压白幕，目标 21 —— 永远够不着。
  assert.equal(solveScrim({ r: 255, g: 255, b: 255 }, 'light', 21, { mode: 'light' }), 1)
})
check('解出来的浓度确实达标', () => {
  const bg = { r: 128, g: 128, b: 128 }
  const alpha = solveScrim(bg, 'light', CONTRAST_BODY)
  const mixed = {
    r: bg.r * (1 - alpha),
    g: bg.g * (1 - alpha),
    b: bg.b * (1 - alpha),
  }
  assert.ok(contrastRatio(parseHex(INK.light), mixed) >= CONTRAST_BODY - 0.01)
})
check('单调：幕越厚越清楚', () => {
  const bg = { r: 200, g: 90, b: 60 }
  let last = 0
  for (const a of [0, 0.2, 0.5, 0.8, 1]) {
    const mixed = { r: bg.r * (1 - a), g: bg.g * (1 - a), b: bg.b * (1 - a) }
    const c = contrastRatio(parseHex(INK.light), mixed)
    assert.ok(c >= last)
    last = c
  }
})

console.log('== 画面摘要 ==')
check('空输入 → null', () => {
  assert.equal(analyzePixels(null), null)
  assert.equal(analyzePixels([]), null)
  assert.equal(analyzeColors([]), null)
})
check('全透明 → null', () => {
  assert.equal(analyzePixels(new Uint8ClampedArray(16)), null)
})
check('纯黑像素', () => {
  const data = new Uint8ClampedArray(4 * 25)
  for (let i = 0; i < 25; i += 1) data[i * 4 + 3] = 255
  const a = analyzePixels(data)
  assert.equal(a.luminance, 0)
  assert.equal(a.darkShare, 1)
  assert.equal(a.spread, 0)
  assert.equal(a.samples, 25)
})
check('step 抽稀', () => {
  const data = new Uint8ClampedArray(4 * 100)
  for (let i = 0; i < 100; i += 1) {
    data[i * 4] = 255
    data[i * 4 + 3] = 255
  }
  const a = analyzePixels(data, { step: 10 })
  assert.equal(a.samples, 10)
  assert.equal(a.mean.r, 255)
})
check('半黑半白：平均色是灰、分散度高', () => {
  const a = analyzeColors(['#000000', '#000000', '#ffffff', '#ffffff'])
  assert.equal(Math.round(a.mean.r), 128)
  assert.ok(a.spread > 0.4)
  assert.equal(a.darkShare, 0.5)
})

console.log('== 决策：可读性是硬承诺 ==')
check('出厂每个预设、一堆极端画面都能过线', () => {
  const screens = ['#000000', '#ffffff', '#1a1a2e', '#c8b89a', '#ff0000', '#00ff00', '#808080', '#2b3a55', '#e8e8e8']
  for (const preset of PRESETS) {
    for (const hex of screens) {
      const analysis = analyzeColors([hex])
      const decision = decideTheme(analysis, resolvePreset({ preset: preset.id }))
      if (preset.text === 'keep') continue
      const inkRgb = parseHex(INK[decision.ink])
      // 幕的方向必须跟着墨色走（浅色字压暗幕、深色字压亮幕），压反了就是 bug。
      const scrimRgb = decision.ink === 'light' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
      const mixed = {
        r: analysis.mean.r + (scrimRgb.r - analysis.mean.r) * decision.scrim,
        g: analysis.mean.g + (scrimRgb.g - analysis.mean.g) * decision.scrim,
        b: analysis.mean.b + (scrimRgb.b - analysis.mean.b) * decision.scrim,
      }
      const final = contrastRatio(inkRgb, mixed)
      assert.ok(
        final >= CONTRAST_BODY - 0.02,
        `${preset.id} on ${hex}: ${final.toFixed(2)} < ${CONTRAST_BODY}`,
      )
    }
  }
})
check('决策自报的 contrast 与复算一致', () => {
  for (const hex of ['#000000', '#ffffff', '#808080', '#7c5cff']) {
    const analysis = analyzeColors([hex])
    const decision = decideTheme(analysis, resolvePreset({ preset: 'readable' }))
    const inkRgb = parseHex(INK[decision.ink])
    const scrimRgb = decision.ink === 'light' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
    const mixed = {
      r: analysis.mean.r + (scrimRgb.r - analysis.mean.r) * decision.scrim,
      g: analysis.mean.g + (scrimRgb.g - analysis.mean.g) * decision.scrim,
      b: analysis.mean.b + (scrimRgb.b - analysis.mean.b) * decision.scrim,
    }
    assert.ok(Math.abs(contrastRatio(inkRgb, mixed) - decision.contrast) < 0.02, hex)
  }
})
check('暗壁纸不多压幕', () => {
  const d = decideTheme(analyzeColors(['#05060a']), resolvePreset({ preset: 'readable' }))
  assert.equal(d.ink, 'light')
  assert.ok(d.scrim <= 0.55, `scrim=${d.scrim}`)
})
check('亮壁纸自动翻成深色字', () => {
  const d = decideTheme(analyzeColors(['#f2ede2']), resolvePreset({ preset: 'readable' }))
  assert.equal(d.ink, 'dark')
  assert.ok(d.contrast >= CONTRAST_BODY)
})
check('强制 light 的预设不会被自动翻掉', () => {
  const d = decideTheme(analyzeColors(['#f2ede2']), resolvePreset({ preset: 'night' }))
  assert.equal(d.ink, 'light')
  assert.equal(d.reason, 'forced')
})
check('keep 不碰字色', () => {
  const d = decideTheme(analyzeColors(['#000000']), resolvePreset({ preset: 'readable', text: 'keep' }))
  assert.equal(d.reason, 'keep')
})
check('用户偏好不推翻画面结论', () => {
  const bright = decideTheme(analyzeColors(['#ffffff']), resolvePreset({ preset: 'readable' }), { preference: 'dark' })
  assert.equal(bright.ink, 'dark')
})
check('没有画面时按深色保底', () => {
  const d = decideTheme(null, resolvePreset({}))
  assert.equal(d.ink, 'light')
  assert.ok(d.scrim >= 0 && d.scrim <= 1)
})

console.log('== 预设与微调 ==')
check('默认预设存在', () => {
  assert.ok(PRESETS.some((p) => p.id === DEFAULT_PRESET_ID))
})
check('未知预设退回默认', () => {
  assert.equal(resolvePreset({ preset: 'nope' }).id, DEFAULT_PRESET_ID)
})
check('微调被夹进安全区间', () => {
  const p = resolvePreset({ preset: 'readable', scrim: 99, blur: -4, saturate: 5, glassAlpha: 9, surfaceBlur: -9 })
  assert.equal(p.scrim, SCREEN_LIMITS.scrim[1])
  assert.equal(p.blur, SCREEN_LIMITS.blur[0])
  assert.equal(p.saturate, SCREEN_LIMITS.saturate[1])
  assert.equal(p.glassAlpha, SCREEN_LIMITS.glass[1])
  assert.equal(p.surfaceBlur, SCREEN_LIMITS.surfaceBlur[0])
})
check('非法 text/surface 不写进去', () => {
  const p = resolvePreset({ preset: 'readable', text: 'banana', surface: 'banana' })
  assert.equal(p.text, 'auto')
  assert.equal(p.surface, 'solid')
})
check('sanitizeTweak 形状稳定', () => {
  const s = sanitizeTweak({ preset: 'frosted', scrim: 0.5 })
  assert.deepEqual(Object.keys(s).sort(), ['blur', 'glassAlpha', 'opacity', 'preset', 'saturate', 'scrim', 'surface', 'surfaceBlur', 'text'])
  assert.equal(s.preset, 'frosted')
  assert.equal(s.scrim, 0.5)
})
check('每套预设只负责颜色（透明度归滑杆）', () => {
  const seen = new Set()
  for (const p of PRESETS) {
    assert.ok(typeof p.glassTint === 'string' && /^#[0-9a-f]{6}$/i.test(p.glassTint), `${p.id} glassTint`)
    // 出厂预设一律"不动遮挡"：scrim 0、glassAlpha 0。想加遮挡是用户拖滑杆的事，
    // 预设不该替用户预先压暗画面 —— 否则"参数全 0"就得手动拉，等于没给默认值。
    assert.equal(p.scrim, 0, `${p.id} 预设不该自带遮罩`)
    assert.equal(p.glassAlpha, 0, `${p.id} 预设不该自带玻璃遮挡`)
    assert.ok(Number.isFinite(p.surfaceBlur) && p.surfaceBlur > 0, `${p.id} surfaceBlur`)
    assert.ok(typeof p.accent === 'string' && /^#[0-9a-f]{6}$/i.test(p.accent), `${p.id} accent`)
    // 七套必须真的不一样：单测就盯住"换预设看不出来"这件事。
    // （可读优先/重磨砂共用白釉，区别在磨砂半径 —— 参考实现也是这么分的，所以按
    // 釉色 + 强调色 + 磨砂半径三者一起认。）
    seen.add(`${p.glassTint}/${p.accent}/${p.surfaceBlur}`)
  }
  assert.equal(seen.size, PRESETS.length, '有两套预设的颜色完全相同')
})

console.log('== 变量输出 ==')
check('deriveTokens 只出颜色与数字，不出字号/字族', () => {
  const d = decideTheme(analyzeColors(['#101018']), resolvePreset({}))
  const tokens = deriveTokens(d, {})
  for (const [name, value] of Object.entries(tokens)) {
    assert.ok(name.startsWith('dsa-wall-'), name)
    assert.ok(!/font|size|height|line/.test(name), `不该出现 ${name}`)
    assert.ok(typeof value === 'string' && value.length > 0)
  }
  assert.ok(!('font-size' in tokens))
})
check('玻璃配方：每套预设、两种主题下都过 4.5:1（可读性下限是硬承诺）', () => {
  const backdrops = ['#000000', '#ffffff', '#808080', '#2a1f2e']
  for (const p of PRESETS) {
    for (const hex of backdrops) {
      const d = decideTheme(analyzeColors([hex]), resolvePreset({ preset: p.id }))
      for (const dark of [false, true]) {
        for (const glassAlpha of [0, p.glassAlpha, SCREEN_LIMITS.glass[1]]) {
          const tokens = deriveTokens(d, resolvePreset({ preset: p.id, glassAlpha }), { dark })
          const glass = parseHex(tokens['dsa-wall-glass-1'])
          const inkHex = tokens['dsa-wall-ink'].includes('255, 255, 255') ? INK.light : INK.dark
          const c = contrastRatio(parseHex(inkHex), glass)
          assert.ok(
            c >= CONTRAST_BODY,
            `${p.id} @${hex} dark=${dark} alpha=${glassAlpha}: ${c.toFixed(2)} < ${CONTRAST_BODY}`,
          )
          // 自报的对比度必须与复算一致（预设卡上显示的就是它）。
          if (glassAlpha === p.glassAlpha) {
            assert.ok(Math.abs(Number(tokens['dsa-wall-contrast']) - c) < 0.05, `${p.id} 自报对比度不符`)
          }
        }
      }
    }
  }
})
check('玻璃厚度拉到任何一档都不破下限（地板那一项不归滑杆管）', () => {
  const d = decideTheme(analyzeColors(['#000000']), resolvePreset({}))
  for (const tint of ['#ffffff', '#0d1524', '#67dce7', '#00c800']) {
    for (const alpha of [0, 0.3, 0.6, SCREEN_LIMITS.glass[1]]) {
      for (const dark of [false, true]) {
        const tokens = deriveTokens(d, { glassTint: tint, glassAlpha: alpha }, { dark })
        const glass = parseHex(tokens['dsa-wall-glass-1'])
        const inkHex = tokens['dsa-wall-ink'].includes('255, 255, 255') ? INK.light : INK.dark
        const c = contrastRatio(parseHex(inkHex), glass)
        assert.ok(c >= CONTRAST_BODY, `tint=${tint} alpha=${alpha} dark=${dark}: ${c.toFixed(2)}`)
      }
    }
  }
})
check('玻璃层有层次：layer-3 不比 layer-1 暗（越靠前的面越亮）', () => {
  const d = decideTheme(analyzeColors(['#101018']), resolvePreset({}))
  // 用亮釉预设（可读优先），釉色淡时层 2/3 才掺得出层次；
  // 深釉预设（暗夜釉色）本来就接近纯黑，三层压成同一个黑是合理的。
  const t = deriveTokens(d, PRESETS.find((p) => p.id === 'readable'), { dark: true })
  const l1 = relativeLuminance(parseHex(t['dsa-wall-glass-1']))
  const l3 = relativeLuminance(parseHex(t['dsa-wall-glass-3']))
  assert.ok(l3 >= l1, `${l3} 不应小于 ${l1}`)
})
check('列底不透明度只在往上加遮挡时才实起来，且始终留缝', () => {
  for (const p of PRESETS) {
    for (const dark of [false, true]) {
      const preset = resolvePreset({ preset: p.id })
      const decision = decideTheme(analyzeColors(['#808080']), preset)
      // 出厂（glass 0）：完全不盖，壁纸原样。
      assert.equal(Number(deriveTokens(decision, preset, { dark })['dsa-wall-wall-alpha']), 0)
      // 往上加：0 < alpha < 1，永远留一点壁纸色，不到实色。
      for (const glassAlpha of [0.3, 0.6, 1]) {
        const tuned = resolvePreset({ preset: p.id, glassAlpha })
        const alpha = Number(deriveTokens(decision, tuned, { dark })['dsa-wall-wall-alpha'])
        assert.ok(alpha > 0 && alpha < 1, `${p.id} dark=${dark} glass=${glassAlpha} 不透明度越界：${alpha}`)
        assert.ok(alpha < 0.95, `${p.id} dark=${dark} glass=${glassAlpha} 太实了：${alpha}`)
      }
    }
  }
})
check('壁纸真的透得出来：出厂状态下三列完全不盖', () => {
  for (const p of PRESETS) {
    for (const dark of [false, true]) {
      const preset = resolvePreset({ preset: p.id })
      const tokens = deriveTokens(decideTheme(analyzeColors(['#101018']), preset), preset, { dark })
      // 出厂预设不带任何遮挡（glassAlpha 0）⇒ 面板必须是 transparent，
      // 壁纸原样透出来。要遮挡是用户往上加，不是出厂先盖一层。
      assert.equal(tokens['dsa-wall-wall'], 'transparent', `${p.id} dark=${dark}：出厂状态列底还在盖`)
      assert.equal(tokens['dsa-wall-wall-alpha'], '0')
    }
  }
})
check('往上加玻璃厚度 → 列底才实起来，且始终留缝', () => {
  const preset = resolvePreset({ preset: 'readable' })
  const d = decideTheme(analyzeColors(['#101018']), preset)
  const alpha = (glass) =>
    Number(deriveTokens(d, resolvePreset({ preset: 'readable', glassAlpha: glass }), { dark: false })['dsa-wall-wall-alpha'])
  assert.equal(alpha(0), 0)
  assert.ok(alpha(0.5) > 0.3, `中间档应该明显盖住一部分：${alpha(0.5)}`)
  assert.ok(alpha(1) > 0.6, `拉满应该有分量：${alpha(1)}`)
  assert.ok(alpha(1) < 1, '再厚也留一点壁纸色，不到实色')
})
check('面板底色听预设的：白釉仍是白板，暗釉仍是暗板（不跟主题翻）', () => {
  const d = decideTheme(analyzeColors(['#101018']), resolvePreset({}))
  const white = PRESETS.find((p) => p.id === 'readable')
  const night = PRESETS.find((p) => p.id === 'night')
  // 参考实现里 factory-readable 的玻璃色浅/深都是 #ffffff —— 白釉在深色主题下
  // 仍然是一块白面板、字翻成深色。这不是 bug，是这套预设的性格（它叫"可读优先"）。
  const light = parseHex(deriveTokens(d, white, { dark: false })['dsa-wall-glass-1'])
  const dark = parseHex(deriveTokens(d, white, { dark: true })['dsa-wall-glass-1'])
  assert.ok(relativeLuminance(light) > 0.9, '浅色主题的白釉面板应该接近纯白')
  assert.ok(relativeLuminance(dark) > 0.6, '深色主题的白釉面板也应该偏亮（白板配深字）')
  // 暗釉反过来：**两种主题下都是暗板**，字都是白的。
  // 以前这里要求"浅色主题下把暗釉提亮"，结果就是 `#5d6064` 那种擦着 5.1:1 的中间灰 ——
  // 面板看着够、字仍发虚。颜色归预设，字色按实测选，才是"换预设也看得清"的正解。
  const nightLight = parseHex(deriveTokens(d, night, { dark: false })['dsa-wall-glass-1'])
  const nightDark = parseHex(deriveTokens(d, night, { dark: true })['dsa-wall-glass-1'])
  assert.ok(relativeLuminance(nightDark) < 0.05, `暗釉在深色主题下应该接近黑：${relativeLuminance(nightDark).toFixed(3)}`)
  assert.ok(relativeLuminance(nightLight) < 0.09, `暗釉在浅色主题下也应保持暗板（靠白字兜）：${relativeLuminance(nightLight).toFixed(3)}`)
})
check('七套预设 × 任意壁纸：面包底与字色同侧判定，正文一律 ≥4.5:1', () => {
  const backdrops = ['#000000', '#ffffff', '#808080', '#1f2d3d', '#d07831']
  for (const preset of PRESETS) {
    for (const hex of backdrops) {
      const d = decideTheme(analyzeColors([hex]), resolvePreset({ preset: preset.id }))
      for (const dark of [false, true]) {
        const tokens = deriveTokens(d, resolvePreset({ preset: preset.id }), { dark })
        const contrast = Number(tokens['dsa-wall-contrast'])
        // 换预设就看不清的那一批，全部卡在这里。
        assert.ok(contrast >= CONTRAST_BODY, `${preset.id} @${hex} dark=${dark}: ${contrast} < ${CONTRAST_BODY}`)
      }
    }
  }
})
check('七套预设的玻璃面各不相同，且都带一层"壁纸雾"', () => {
  const d = decideTheme(analyzeColors(['#2a1f2e', '#c94f7c', '#f0c9a0']), resolvePreset({}))
  for (const dark of [false, true]) {
    const seen = new Set()
    for (const p of PRESETS) {
      const tokens = deriveTokens(d, resolvePreset({ preset: p.id }), { dark })
      seen.add(tokens['dsa-wall-glass-1'] + tokens['dsa-wall-frost'])
      assert.match(tokens['dsa-wall-frost'], /^#[0-9a-f]{6}$/)
    }
    // 参考实现里"可读优先"和"重磨砂"只在模糊半径上不同，玻璃色相同 —— 这是它的设计，
    // 不是 bug。所以这里只要求**至少五种不同的观感**，而不是七种全不同。
    assert.ok(seen.size >= 5, `换预设看不出来：只有 ${seen.size} 种观感（dark=${dark}）`)
  }
})
check('壁纸垫底色不出白闪（不等于纯白）', () => {
  const d = decideTheme(analyzeColors(['#ffffff']), resolvePreset({}))
  const underlay = deriveTokens(d, {}, { dark: false })['dsa-wall-underlay']
  assert.notEqual(underlay.toLowerCase(), '#ffffff')
  assert.match(underlay, /^#[0-9a-f]{6}$/)
})
check('layerStyle 带上面板模糊与补偿缩放', () => {
  assert.match(layerStyle({ preset: 'frosted' }), /blur\(36px\)/)
  assert.match(layerStyle({ preset: 'frosted' }), /scale\(1\.06\)/)
  assert.match(layerStyle({ preset: 'night' }), /blur\(22px\)/)
})

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
