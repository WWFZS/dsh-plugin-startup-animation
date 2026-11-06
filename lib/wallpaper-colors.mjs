/**
 * 内置素材的取色表：**每个内置壁纸/视频在出厂时就告诉引擎"这画面是什么颜色"**。
 *
 * 为什么要有这个文件：
 * - 浏览器侧本来就会对实际画面取样（`sampleImage` / `sampleVideoFrame`），
 *   但那是**运行时**才知道的事：壁纸还没加载完之前，页面得先决定用哪套字色，
 *   否则会先闪一下错色的界面再纠正。
 * - 视频第一次取帧要解码，慢；这里给一组代表色，就能在挂上第一帧之前
 *   先把 token 定好，取帧结果到了再覆盖（如果和代表色差得远）。
 *
 * 数据格式故意极简：`文件名 → 几个代表色（看画面凭感觉取，取偏差了不影响可读性，
 * 因为最终仍会用实际画面校正）`。没有条目 = 全部交给运行时取样，不会出错。
 *
 * 加素材时顺手填一行；不填也能用（宿主会把 `analysis` 留空，浏览器自己算）。
 */

/** 内置素材的代表色（按面积从大到小随便挑 3–5 个）。 */
export const BUILTIN_WALLPAPER_COLORS = Object.freeze({
  // ── 图片 ──
  '包臀裙-卧室-好看.jpg': ['#3a2b2a', '#6b4a3f', '#d8b9a8', '#1b1214'],
  '创意拼贴-彼得帕克.jpg': ['#1d2a3a', '#c0392b', '#2c3e50', '#e8d9c0'],
  '党徽-共产主义接班人.png': ['#c8102e', '#f5d000', '#8b0000', '#ffffff'],
  '卷发美女-哥特风.jpg': ['#1a1a1f', '#3b2f3a', '#8a6b5c', '#0d0b0e'],
  '漫威-漫威宇宙.jpg': ['#0b1a2a', '#c8102e', '#1e3a5f', '#d4af37'],
  '写真-壁纸-性感.jpg': ['#2a1f1c', '#5c4038', '#c9a68f', '#141010'],
  '中华人民共和国-五星.jpg': ['#de2910', '#ffde00', '#b21f0d', '#ffffff'],
  'Windows-微软.jpg': ['#0a1f2f', '#102736', '#496e7e', '#162f3f'],
  '八骏图-地毯-坐姿.jpg': ['#fffefd', '#ede6dd', '#d5c2ae', '#1a0e05'],
  // ── 视频（取主要场景的平均观感）──
  '多重影像.mp4': ['#12161f', '#2b3a55', '#7c93b8', '#05070c'],
  '亭台-侠客-古月方源.mp4': ['#2a3729', '#3d4e3b', '#859f80', '#51644e'],
  '傍晚海风-海边.mp4': ['#1f2d3d', '#4a6b8a', '#d9a66c', '#0e151f'],
  '光影-动漫美女-彩色.mp4': ['#2a1a3a', '#7c4dff', '#ff6fa8', '#120a1c'],
  '少司缘.mp4': ['#1b1420', '#4a2f3f', '#c98a9a', '#0c080f'],
  'girl-black.mp4': ['#0b0a0c', '#8e8f93', '#d8d5d0', '#2a2629'],
  '薰衣草花语-等你爱我.mp4': ['#3a2f5a', '#8a7ac8', '#c8b8e8', '#1a1428'],
  'dsh-大肥鱼.mp4': ['#0a1a2a', '#1e4a6b', '#5ab0d8', '#04101a'],
  '550C-赛博控制台.mp4': ['#050a0f', '#0f8b8d', '#39e0e8', '#020507'],
})

/**
 * 查一个素材的代表色。文件名可能带 `.web.mp4` 变体后缀，退一步按逻辑名再查一次。
 * @param {string} fileName 素材文件名（不含目录）。
 * @returns {string[]} 没记录时返回空数组。
 */
export function builtinColors(fileName) {
  const direct = BUILTIN_WALLPAPER_COLORS[fileName]
  if (Array.isArray(direct)) return direct
  const logical = String(fileName).replace(/\.web\.mp4$/i, '.mp4')
  const fallback = BUILTIN_WALLPAPER_COLORS[logical]
  return Array.isArray(fallback) ? fallback : []
}
