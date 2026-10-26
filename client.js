/**
 * startup-animation —— 浏览器半边：设置页。
 *
 * **一个** settings.section 条目（侧栏只显示「启动动画」），页面自上而下：
 *   1. 设置区（常驻）：总开关、声音、展示时长（共用主配置，3–15 秒）、当前素材预览 + 恢复默认；
 *   2. 分类切换器 [MP4 | 壁纸]；
 *   3. 分类区：上传（按文件类型自动归入本分类）+ 该分类素材**卡片网格**（点卡片即用，悬停出删除）。
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

    const DICT_ZH = {
      nav: '启动动画',
      title: '开机动画',
      desc: '启动 Harness 时可显示全屏动画：在下方选用或上传素材后，点右上角「立即刷新」即可看到效果，无需重启。关闭开关或恢复默认时显示原版标配启动页。',
      enable: '显示开机动画',
      sound: '视频带声播放',
      asset: '启动画面素材',
      stockLabel: '原版标配 · 不显示开机动画',
      usingCustom: '自定义',
      usingBuiltin: '内置',
      catMp4: 'MP4',
      catWall: '壁纸',
      video: '视频',
      image: '图片',
      use: '使用',
      using: '使用中',
      remove: '删除',
      removed: '已从列表移除',
      deletedFile: '已删除上传的文件',
      deleteHidden: '文件被占用，已从列表隐藏（磁盘文件保留）',
      libraryDesc: '点卡片设为启动画面；悬停卡片右上角删除（内置素材仅隐藏，上传素材删除文件）。',
      libEmpty: '这个分类目前没有可展示的素材',
      uploadInto: '上传视频',
      uploadWall: '上传壁纸',
      uploaded: '已上传 · 点卡片生效',
      duration: '展示时长',
      secUnit: ' 秒',
      audio: '开机音频',
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
      restored: '已恢复原版标配 · 点右上角「立即刷新」生效',
      refresh: '立即刷新',
      tooBig: '文件太大（上限 128 MiB）',
      badType: '不支持的文件类型',
      loadFail: '读取状态失败',
      netFail: '无法连接宿主',
      fail: '操作失败',
      versionLabel: '版本',
      updateChecking: '检查更新中…',
      updateAvailable: '有新版本 {latest}',
      updateLatest: '已是最新',
      updateUnknown: '检查不到更新',
      updateFailed: '更新检查失败',
      viewRelease: '查看更新',
    }

    const DICT_EN = {
      nav: 'Startup Animation',
      title: 'Startup animation',
      desc: 'Optionally show a full-screen animation when Harness starts: pick or upload media below, then click "Refresh now" (top right) to see it — no restart needed. With the toggle off or nothing selected, the stock boot screen shows.',
      enable: 'Show the startup animation',
      sound: 'Play video with sound',
      asset: 'Startup visual',
      stockLabel: 'Stock boot · no animation',
      usingCustom: 'Custom',
      usingBuiltin: 'Built-in',
      catMp4: 'MP4',
      catWall: 'Wallpaper',
      video: 'Video',
      image: 'Image',
      use: 'Use',
      using: 'In use',
      remove: 'Delete',
      removed: 'Removed from the list',
      deletedFile: 'Uploaded file deleted',
      deleteHidden: 'File in use — hidden from the list (file kept on disk)',
      libraryDesc: 'Click a card to set the startup visual; hover a card and use its top-right button to delete (built-ins are only hidden, uploaded files are removed).',
      libEmpty: 'No media left in this category',
      uploadInto: 'Upload video',
      uploadWall: 'Upload wallpaper',
      uploaded: 'Uploaded — click the card to apply',
      duration: 'Display duration',
      secUnit: ' s',
      audio: 'Startup audio',
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
      restored: 'Restored to stock — click "Refresh now" to apply',
      refresh: 'Refresh now',
      tooBig: 'File too large (128 MiB max)',
      badType: 'Unsupported file type',
      loadFail: 'Failed to read status',
      netFail: 'Cannot reach the host',
      fail: 'Action failed',
      versionLabel: 'v',
      updateChecking: 'Checking for updates…',
      updateAvailable: 'Version {latest} available',
      updateLatest: 'Up to date',
      updateUnknown: 'Update check unavailable',
      updateFailed: 'Update check failed',
      viewRelease: 'View release',
    }

    /** 三个分类的 accept：MP4 只收视频，壁纸只收图片，音频只收音频（后端仍按扩展名归类兜底）。 */
    const ACCEPT_BY_CATEGORY = {
      mp4: 'video/mp4,video/webm,video/ogg',
      wall: 'image/gif,image/apng,image/webp,image/png,image/jpeg',
      audio: 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/flac,audio/ogg,audio/opus',
    }
    /** 分类状态 → 包内目录 id（host scanLibrary 的分类键）。 */
    const CATEGORY_ID = { mp4: 'MP4', wall: '图片', audio: '音频' }

    const STYLE = `
.dsa-set-wrap { display: flex; flex-direction: column; gap: 4px; }
.dsa-set-titlebar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 2px; }
.dsa-set-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.dsa-set-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
/* 版本小字：贴着标题，不抢视觉重量；可点击时打开 Release 页。 */
.dsa-set-ver { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsa-set-ver[data-update="1"] { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsa-set-ver-btn { font: inherit; font-size: 11.5px; padding: 0; border: none; background: none; color: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.dsa-set-ver-btn:hover { color: var(--dsw-alias-brand-primary); }
.dsa-set-ver-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }
.dsa-set-tabs { display: flex; gap: 4px; padding: 3px; margin: 14px 0 8px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; align-self: flex-start; }
.dsa-set-tab { font: inherit; font-size: 13px; padding: 6px 18px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.dsa-set-tab:hover { color: var(--dsw-alias-label-primary); }
.dsa-set-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsa-set-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-panel { display: flex; flex-direction: column; }
.dsa-set-desc { font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); margin-bottom: 10px; max-width: 720px; }
.dsa-set-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsa-set-row:last-of-type { border-bottom: none; }
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
.dsa-set-status { min-height: 18px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); margin-top: 10px; }
.dsa-set-status[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.dsa-set-status[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); }
.dsa-set-sec { font-size: 13px; color: var(--dsw-alias-label-primary); min-width: 52px; text-align: right; font-variant-numeric: tabular-nums; }
.dsa-set-range { width: 180px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.dsa-set-range:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
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
.dsa-set-card-type { position: absolute; top: 7px; left: 7px; font-size: 11px; color: var(--dsw-alias-label-primary); background: rgba(0, 0, 0, 0.55); border-radius: 6px; padding: 2px 7px; pointer-events: none; }
.dsa-set-card-using { position: absolute; top: 7px; left: 7px; font-size: 11px; color: #fff; background: var(--dsw-alias-brand-primary); border-radius: 6px; padding: 2px 7px; pointer-events: none; }
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

      const send = (init, successText) => {
        setBusy(true)
        setMessage({ text: '', kind: '' })
        fetch(MANAGE, init)
          .then((res) => res.json().catch(() => null))
          .then((payload) => {
            setBusy(false)
            if (payload && payload.ok) {
              setState(payload)
              setMessage({
                // 成功文案可以是函数：按回包内容区分（如"已删除" vs "被占用仅隐藏"）。
                text: typeof successText === 'function' ? successText(payload) : successText,
                kind: 'ok',
              })
            } else {
              setMessage({ text: (payload && payload.error) || t('fail'), kind: 'error' })
            }
          })
          .catch(() => {
            setBusy(false)
            setMessage({ text: t('netFail'), kind: 'error' })
          })
      }

      return { state, busy, message, setMessage, send }
    }

    /**
     * 版本 + 更新检查状态。
     *
     * 设计取舍：
     *   - **不阻塞页面**：先渲染"版本 x.y.z"，更新检查在后台跑，回来再补提示；
     *   - **失败不报错**：离线/墙内/GitHub 挂了都只显示"检查不到更新"，
     *     因为这只是个提示，不该让设置页看起来像坏了；
     *   - 检查结果由宿主的 `/update` 端点给出（宿主有缓存，不会每次开页面都打 GitHub）。
     *
     * @param {(key: string) => string} t 翻译。
     * @returns {{ version: string, update: object | null, checking: boolean }} 版本状态。
     */
    function useVersionInfo(t) {
      const [version, setVersion] = React.useState('')
      const [update, setUpdate] = React.useState(null)
      const [checking, setChecking] = React.useState(true)

      React.useEffect(() => {
        let alive = true
        fetch(`${UPDATE}?check=1`, { cache: 'no-store' })
          .then((res) => res.json())
          .then((payload) => {
            if (!alive) return
            setChecking(false)
            if (payload && typeof payload === 'object') {
              if (typeof payload.version === 'string' && payload.version !== '') setVersion(payload.version)
              if (typeof payload.current === 'string' && payload.current !== '') setVersion(payload.current)
              setUpdate(payload)
            }
          })
          .catch(() => {
            if (alive) setChecking(false)
          })
        return () => {
          alive = false
        }
      }, [])

      return { version, update, checking }
    }

    /** POST 一个 JSON 载荷（开关/时长/素材库操作共用）。 */
    function postJson(send, body, okText) {
      send(
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
    /**
     * 视频封面取帧点：在 25% / 50% / 75% 三个候选位置里，选**画面最亮**的那一帧。
     *
     * 为什么不能固定取首帧：素材常从黑场淡入（《大肥鱼-欢迎回来》前几秒几乎全黑），
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
     * 视频封面：先按原来的方式挂上去（首帧可见），元数据到了之后再挑更好的帧。
     * 这样即便挑帧失败，卡片也还是"有画面"的，不会白屏。
     */
    function VideoCover(props) {
      const ref = React.useRef(null)
      const [poster, setPoster] = React.useState('')
      React.useEffect(() => {
        const video = ref.current
        if (!video) return undefined
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
      }, [props.src])

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
     * 「启动动画」页：常驻设置区 + 下方 [MP4|壁纸] 分类切换器与素材列表。
     * @param {(key: string) => string} t 翻译。
     * @returns {React.ComponentType} 页面组件。
     */
    function makeStartupAnimationPage(t) {
      return function StartupAnimationPage() {
        const { state, busy, message, setMessage, send } = useStatus(t)
        const { version: localVersion, update, checking: updateChecking } = useVersionInfo(t)
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

        // 状态到达后同步滑杆位置（共用主配置 durationSec / audioVolume）。
        React.useEffect(() => {
          if (state && typeof state.durationSec === 'number') setSec(state.durationSec)
          if (state && typeof state.audioVolume === 'number') setAvol(Math.round(state.audioVolume * 100))
        }, [state])

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

        // 卸载时清掉未触发的防抖提交与试听播放。
        React.useEffect(
          () => () => {
            if (commitRef.current !== null) clearTimeout(commitRef.current)
            if (avolRef.current !== null) clearTimeout(avolRef.current)
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
          const next = Math.min(15, Math.max(3, Math.round(Number(value))))
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

        /** 试听/停止一条音频（列表内点击，不影响开机配置）。 */
        const togglePlay = (file) => {
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
        const categoryLabel = category === 'mp4' ? t('catMp4') : category === 'wall' ? t('catWall') : t('catAudio')
        const isAudioCat = category === 'audio'

        /**
         * 标题旁的版本小字。
         *
         * 三种状态：
         *   - 有新版本 → 可点击，打开 GitHub Release 页（**不自动下载**：更新由用户决定）；
         *   - 已是最新 → 灰字"已是最新"；
         *   - 检查不到（离线/GitHub 不可达）→ 灰字，不给红色错误（这不是插件故障）。
         * 版本号本身永远显示，即便更新检查失败 —— 它是用户确认"装的是哪一版"的唯一依据。
         */
        const versionBadge = () => {
          const text = localVersion === '' ? '' : `${t('versionLabel')} ${localVersion}`
          if (text === '') return null
          const hasUpdate = update !== null && update.updateAvailable === true
          const reachable = update !== null && update.reachable === true
          /**
           * 副标签只在**真的需要用户行动**时出现。
           *
           * 平时标题旁只留一枚安静的版本号。只有两种情况会加字：
           *   - 有新版本 → 「有新版本 x.y.z」，可点，打开 Release 页；
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
              ? t('updateAvailable').replace('{latest}', update.latest)
              : reachable
                ? t('updateLatest')
                : t('updateUnknown')
          const showNote = updateChecking || hasUpdate
          const releaseUrl =
            hasUpdate && typeof update?.releasesUrl === 'string' && update.releasesUrl !== ''
              ? update.releasesUrl
              : ''
          return h(
            'span',
            { className: 'dsa-set-ver', 'data-update': hasUpdate ? '1' : '0', title: note },
            releaseUrl === ''
              ? showNote
                ? `${text} · ${note}`
                : text
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa-set-ver-btn',
                    onClick: () => window.open(releaseUrl, '_blank', 'noopener'),
                  },
                  `${text} · ${note}`,
                ),
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
                            'aria-label': `${t('remove')} ${file.name}`,
                            title: t('remove'),
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
                      const isVideo = VIDEO_EXT.test(file.name)
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
                            : thumbEl(file.path, isVideo, 'dsa-set-card-media', (event) => {
                                event.currentTarget.style.display = 'none'
                              }),
                          h(
                            'span',
                            { className: active ? 'dsa-set-card-using' : 'dsa-set-card-type' },
                            active ? t('using') : isVideo ? t('video') : t('image'),
                          ),
                          // 来源标记：内置与上传可能同名（用户上传过同一段素材时），
                          // 只显示素材名会让人分不清选的是哪一个 —— 内置随包走、上传在 DSH_HOME。
                          h(
                            'span',
                            { className: 'dsa-set-card-name', title: displayName(file.name) },
                            displayName(file.name),
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
                            'aria-label': `${t('remove')} ${file.name}`,
                            title: t('remove'),
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

        return h(
          'div',
          { className: 'dsa-set-wrap', 'data-busy': busy ? '1' : '0' },
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
                max: 15,
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
          // ── 分类切换器：[MP4 | 壁纸 | 音频]（三个独立功能的入口，位于设置区下方）──
          h(
            'div',
            { className: 'dsa-set-tabs', role: 'tablist', 'aria-label': t('title') },
            [
              { id: 'mp4', label: t('catMp4') },
              { id: 'wall', label: t('catWall') },
              { id: 'audio', label: t('catAudio') },
            ].map((entry) =>
              h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  className: 'dsa-set-tab',
                  role: 'tab',
                  'aria-selected': category === entry.id ? 'true' : 'false',
                  onClick: () => setCategory(entry.id),
                },
                entry.label,
              ),
            ),
          ),
          categoryPanel,
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

          return () => {
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
