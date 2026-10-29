/**
 * startup-animation —— 浏览器半边：设置页。
 *
 * **一个** settings.section 条目（侧栏只显示「启动动画」），页面自上而下：
 *   1. 设置区（常驻）：总开关、声音、展示时长（共用主配置，3–30 秒）、当前素材预览 + 恢复默认；
 *   2. 分类切换器 [MP4 | 壁纸 | 音频 | 更新公告]；
 *   3. 分类区：上传（按文件类型自动归入本分类）+ 该分类素材**卡片网格**（点卡片即用，悬停出删除）。
 *      「更新公告」不是素材分类：它渲染 `/update` 顺手带回的 Release 正文（parseReleaseNotes）。
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
    }
    /** 分类状态 → 包内目录 id（host scanLibrary 的分类键）。 */
    const CATEGORY_ID = { mp4: 'MP4', wall: '图片', audio: '音频' }

    const STYLE = `
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

    /**
     * 「启动动画」页：常驻设置区 + 下方 [MP4|壁纸|音频|更新公告] 分类切换器与内容面板。
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
        // ── 卸载 / 更新（v1.11.0）──
        // 自管状态：宿主在 profile 里有没有装我们、有没有选中、装的是什么形态。
        const [selfState, setSelfState] = React.useState(null)
        const [selfBusy, setSelfBusy] = React.useState('')

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
        const categoryLabel = category === 'mp4' ? t('catMp4') : category === 'wall' ? t('catWall') : t('catAudio')
        const isAudioCat = category === 'audio'
        // 第四个页签不是素材分类：它没有上传、没有卡片，内容是 /update 带回的 Release 正文。
        const isReleaseCat = category === 'release'

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
          // ── 分类切换器：[MP4 | 壁纸 | 音频 | 更新公告]（素材三类 + 一个信息页）──
          h(
            'div',
            { className: 'dsa-set-tabs', role: 'tablist', 'aria-label': t('title') },
            [
              { id: 'mp4', label: t('catMp4') },
              { id: 'wall', label: t('catWall') },
              { id: 'audio', label: t('catAudio') },
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
          isReleaseCat ? releasePanel : categoryPanel,
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
