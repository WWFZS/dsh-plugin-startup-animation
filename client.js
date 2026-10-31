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
 * 宠物浮层（createPetOverlay）在 apply 阶段挂到 document.body 上，与设置页渲染树无关：
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
      // ── 宠物（第三个页签；浮层与设置区的文案）──
      catPet: '宠物',
      petEnable: '显示桌面宠物',
      petNote: '宠物浮在界面右下角：拖动换位置，松手会记住；点一下它会回应，右键按分类点播。',
      petSize: '宠物大小',
      petAction: '动作',
      petPick: '宠物',
      petUnit: '个动作',
      petRandom: '随机一个',
      petSearch: '搜索动作',
      petNoMatch: '没有匹配的动作',
      petNow: '正在演',
      petCredit: '素材',
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
      petNote: 'The pet floats in the bottom-right corner: drag it to move, click it for a reaction, right-click to play an action by category.',
      petSize: 'Pet size',
      petAction: 'Actions',
      petPick: 'Pet',
      petUnit: 'actions',
      petRandom: 'Play a random one',
      petSearch: 'Search actions',
      petNoMatch: 'No matching action',
      petNow: 'Now playing',
      petCredit: 'Art by',
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
/* 动作列表：一格一个动作，名字 + 播放方式；正在演的那个描边高亮。 */
.dsa-set-acts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
.dsa-set-act { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); font: inherit; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.dsa-set-act:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-set-act:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-act[data-on="1"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsa-set-act:disabled { opacity: 0.55; cursor: default; pointer-events: none; }
.dsa-set-act-name { font-size: 13px; line-height: 1.4; }
.dsa-set-act-kind { font-size: 11.5px; line-height: 1.2; color: var(--dsw-alias-label-tertiary); }
/* 宠物卡：封面 + 名字 + 动作数，一张卡代表一只宠物。 */
.dsa-set-pets { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; margin-top: 12px; }
.dsa-set-pet { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); font: inherit; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.dsa-set-pet:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-set-pet:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-pet[data-on="1"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsa-set-pet:disabled { opacity: 0.55; cursor: default; pointer-events: none; }
.dsa-set-pet-cover { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); display: block; }
.dsa-set-pet-name { font-size: 13px; line-height: 1.4; }
.dsa-set-pet-count { font-size: 11.5px; line-height: 1.2; color: var(--dsw-alias-label-tertiary); }
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
.dsa-set-chip { font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 6px 10px; cursor: pointer; }
.dsa-set-chip:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-set-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsa-set-chip[data-on="1"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsa-set-chip:disabled { opacity: 0.55; cursor: default; pointer-events: none; }
.dsa-set-now { margin-top: 10px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.dsa-set-credit { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsa-set-credit a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
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

    // ──────────────────────────────────────────────────────────────
    // 宠物浮层
    // ──────────────────────────────────────────────────────────────

    /** 待机时两次随机动作之间的间隔（毫秒）：太密像抽风，太疏像静止。 */
    const PET_IDLE_MIN_MS = 15000
    const PET_IDLE_MAX_MS = 35000
    /** 动作演完到回待机的停顿：直接跳回待机会在最后一帧上"啪"地一闪。 */
    const PET_RETURN_MS = 550

    /** 浮层样式。挂 body 的常驻元素，不走组件局部样式，单独注入一份 <style>。 */
    const PET_STYLE = `
.dsa-pet { position: fixed; left: 0; top: 0; z-index: 999999; pointer-events: none; }
.dsa-pet[data-on="0"] { display: none; }
.dsa-pet-stage { position: relative; width: 100%; pointer-events: auto; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; transform-origin: 50% 88%; transition: transform 210ms cubic-bezier(.22, 1.4, .36, 1); }
.dsa-pet-stage[data-drag="1"] { cursor: grabbing; transition: none; }
/* 两只 video 叠在同一格交替：切换只改 opacity。一次只挂两段素材 —— 109 段全建元素会一口气解码几十 MB。 */
.dsa-pet-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 160ms linear; pointer-events: none; }
.dsa-pet-video[data-on="1"] { opacity: 1; }
/* 右键菜单：跟随应用深浅色（同一份文档，--dsw-alias-* 全局可用）。 */
.dsa-pet-menu { position: fixed; z-index: 1000000; min-width: 150px; max-height: 62vh; overflow: auto; overscroll-behavior: contain; padding: 6px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16); }
.dsa-pet-menu-head { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); padding: 4px 8px 2px; }
.dsa-pet-menu-item { display: block; width: 100%; text-align: left; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary, #333); background: none; border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; white-space: nowrap; }
.dsa-pet-menu-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12)); }
.dsa-pet-menu-item[data-on="1"] { color: var(--dsw-alias-brand-primary, #4b6bfb); }
.dsa-pet-menu-sep { height: 1px; margin: 5px 6px; background: var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.25)); }
.dsa-pet-menu-count { color: var(--dsw-alias-label-tertiary, #999); font-size: 11px; margin-left: 4px; }
`

    /**
     * 桌面宠物浮层。
     *
     * 为什么不用 React：它挂在 `document.body` 上，生命周期跨整个应用，和设置页的
     * 渲染树没有关系（关掉设置页宠物还在）。原生 DOM 让"进设置页才创建、退出就
     * 销毁"这类错误不可能发生，也省掉一次 createRoot。
     *
     * 节奏：待机动作循环；每隔 15–35 秒随机演一个分类里的动作，演完回待机；
     * 左键随机回应、拖拽时循环"拖拽悬空"、右键按分类点播。
     *
     * 位置口径：`x/y` 是 0–100 的百分比，表示"在可移动区间里的比例"
     * （0 = 贴左/贴上，100 = 贴右/贴下），所以窗口缩放后宠物仍然贴着同一角，
     * 也不会跑到屏幕外。像素位置 = 百分比 × (视口 − 宠物尺寸)。
     *
     * @param {{ onPersist: (patch: object) => void, t: (key: string) => string }} options 位置落盘回调 + 菜单文案。
     * @returns {{ load: () => Promise<void>, sync: (pet: object) => void, play: (id: string) => void, playCategory: (id: string) => void, random: () => void, report: () => void, reset: () => void, destroy: () => void }} 浮层控制器。
     */
    function createPetOverlay(options) {
      const onPersist = options.onPersist
      const t = options.t
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
      /** 当前配置快照（位置字段只在 load/reset 时采纳，见 sync 的注释）。 */
      let pet = { enabled: false, size: 176, x: 100, y: 100, pack: '', packs: [] }
      /** @type {any} 当前宠物包（宿主给的完整结构）。 */
      let pack = null
      let currentId = ''
      let mode = 'idle'
      /** 随机待机计时器（0 = 没排）。 */
      let ambienceTimer = 0
      /** "演完了回待机"的计时器。 */
      let returnTimer = 0
      let lastRandomId = ''
      /** @type {{ id: number, dx: number, dy: number, startX: number, startY: number, moved: boolean } | null} */
      let drag = null
      let frame = 0
      /** @type {HTMLDivElement | null} 右键菜单（同一时刻至多一个）。 */
      let menu = null

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
        const next = pet.packs.find((item) => item.id === pet.pack) ?? pet.packs[0] ?? null
        const key = next === null ? '' : `${next.id}:${next.clips.length}:${next.canvas.join('x')}`
        if (key === builtKey && next === pack) return
        builtKey = key
        pack = next
        clearAmbience()
        clearReturn()
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
        mode = once ? 'action' : loop ? 'loop' : 'action'
        // 告诉设置页"现在在演哪一段"（宠物自己切的时候也要高亮到对的位置）。
        window.dispatchEvent(
          new CustomEvent('dsa:pet-state', { detail: { id, name: clip.name, pack: pack.id, loop } }),
        )
      }

      /** 回待机：循环 idle 动作，并重新排下一次随机。 */
      const startIdle = () => {
        if (!pet.enabled || pack === null) return
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
        if (!pet.enabled || pack === null) return
        const clip = clipById(id)
        if (clip === null) {
          startIdle()
          return
        }
        clearAmbience()
        clearReturn()
        show(id, false, true)
      }

      /** 一次性动作演完（ended）后隔一小会儿回待机。 */
      function scheduleReturn() {
        clearReturn()
        returnTimer = window.setTimeout(() => {
          returnTimer = 0
          if (pet.enabled && mode === 'action') startIdle()
        }, PET_RETURN_MS)
      }

      /** 排下一次随机动作；已经在演一次性动作时不排（回待机时会重排）。 */
      function scheduleAmbience() {
        clearAmbience()
        if (!pet.enabled || pack === null) return
        const delay = PET_IDLE_MIN_MS + Math.random() * (PET_IDLE_MAX_MS - PET_IDLE_MIN_MS)
        ambienceTimer = window.setTimeout(() => {
          ambienceTimer = 0
          if (!pet.enabled || mode !== 'idle') return
          const clip = randomClip(ambientClips())
          if (clip !== null) playAction(clip.id)
          else scheduleAmbience()
        }, delay)
      }

      /** 设置页"随机一个"：立刻插播。 */
      const random = () => {
        if (!pet.enabled || pack === null) return
        const clip = randomClip(ambientClips())
        if (clip !== null) playAction(clip.id)
      }

      /** 按分类随机点播（右键菜单与设置页的分类卡）。 */
      const playCategory = (categoryId) => {
        if (!pet.enabled || pack === null) return
        const category = pack.categories.find((item) => item.id === categoryId)
        if (category === undefined) return
        const clip = randomClip(clipsOf(category.clips))
        if (clip !== null) playAction(clip.id)
      }

      /** 左键点击：随机一个回应动作；没有回应角色就随机一个待机动作。 */
      const playClick = () => {
        if (!pet.enabled || pack === null) return
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

      const menuItem = (label, onClick, count) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'dsa-pet-menu-item'
        item.textContent = label
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

      /**
       * 右键菜单：**按分类**点播，不是 109 条平铺。
       *
       * 109 个动作的菜单会顶出屏幕，也没人从一百条里找；分类 + 「随机一个」够用，
       * 想指定某个动作去设置页搜。
       */
      const openMenu = (x, y) => {
        if (pack === null) return
        closeMenu()
        ensureStyle()
        menu = document.createElement('div')
        menu.className = 'dsa-pet-menu'
        const head = document.createElement('div')
        head.className = 'dsa-pet-menu-head'
        head.textContent = t('petMenuActions')
        menu.appendChild(head)
        for (const category of pack.categories) {
          menu.appendChild(menuItem(category.name, () => playCategory(category.id), category.clips.length))
        }
        menu.appendChild(menuItem(t('petRandom'), random))
        menu.appendChild(Object.assign(document.createElement('div'), { className: 'dsa-pet-menu-sep' }))
        menu.appendChild(menuItem(t('petReset'), reset))
        menu.appendChild(menuItem(t('petHide'), hideSelf))
        document.body.appendChild(menu)
        // 贴着鼠标展开，但不许出屏。
        const rect = menu.getBoundingClientRect()
        const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
        const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
        menu.style.left = `${Math.round(left)}px`
        menu.style.top = `${Math.round(top)}px`
        document.addEventListener('pointerdown', onMenuDocDown, true)
      }

      /** 菜单里的"隐藏"：等于设置页那个总开关，落盘后浮层会随 sync 自己收起来。 */
      const hideSelf = () => {
        clearAmbience()
        clearReturn()
        onPersist({ petEnabled: false })
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
        onPersist({ petX: pet.x, petY: pet.y })
      }

      /** 拖动开始：接管指针、切到拖拽动作。 */
      const onPointerDown = (event) => {
        if (event.button !== 0 || host === null || !pet.enabled || pack === null) return
        closeMenu()
        const rect = host.getBoundingClientRect()
        drag = {
          id: event.pointerId,
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
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
        // 4px 门槛：点击时手会抖一两像素，不该被当成拖拽。
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        const width = pet.size
        const height = Math.round((width * pack.canvas[1]) / pack.canvas[0])
        const maxLeft = Math.max(0, window.innerWidth - width)
        const maxTop = Math.max(0, window.innerHeight - height)
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
          commitPosition()
          startIdle()
        } else {
          playClick()
        }
      }

      const onResize = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
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
          if (!pet.enabled) return
          event.preventDefault()
          openMenu(event.clientX, event.clientY)
        })
        window.addEventListener('resize', onResize)
      }

      /** 首次从服务端取状态（失败就安静地不出现 —— 宠物是装饰，不该报错）。 */
      const load = () =>
        fetch(MANAGE, { cache: 'no-store' })
          .then((res) => res.json())
          .then((payload) => {
            if (!payload || !payload.ok || !payload.pet) return
            pet.x = typeof payload.pet.x === 'number' ? payload.pet.x : pet.x
            pet.y = typeof payload.pet.y === 'number' ? payload.pet.y : pet.y
            sync(payload.pet)
          })
          .catch(() => {})

      /**
       * 应用一份新配置（开关 / 大小 / 当前宠物 / 宠物包）。
       *
       * **不采纳 x/y**：位置由本浮层独占（拖动后自己写盘）。设置页每次写别的字段都会
       * 拿到一份状态回包，如果那份回包里的旧坐标也被应用，宠物会被拽回上一次保存的位置。
       *
       * @param {object} next 服务端给的 pet 状态。
       */
      const sync = (next) => {
        if (!next || typeof next !== 'object') return
        pet.enabled = next.enabled === true
        if (typeof next.size === 'number' && Number.isFinite(next.size)) pet.size = next.size
        if (typeof next.pack === 'string') pet.pack = next.pack
        if (Array.isArray(next.packs)) pet.packs = next.packs
        // 关着的时候**不建 DOM**：宠物素材加起来几十 MB，没开就不该占带宽和内存。
        if (!pet.enabled) {
          clearAmbience()
          clearReturn()
          closeMenu()
          pauseAll()
          currentId = ''
          mode = 'idle'
          if (host !== null) host.dataset.on = '0'
          return
        }
        build()
        if (pack === null) return
        layout()
        if (host !== null) host.dataset.on = '1'
        // 正在演就接着演；从关到开、或换了宠物，才重新起待机。
        if (currentId === '' || clipById(currentId) === null) startIdle()
      }

      /** 归位：回到右下角并落盘。 */
      const reset = () => {
        pet.x = 100
        pet.y = 100
        layout()
        onPersist({ petX: 100, petY: 100 })
      }

      const destroy = () => {
        window.removeEventListener('resize', onResize)
        if (frame !== 0) window.cancelAnimationFrame(frame)
        frame = 0
        clearAmbience()
        clearReturn()
        closeMenu()
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
      return { load, sync, play: playAction, playCategory, random, report, reset, destroy }
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
        /** 宠物此刻在演哪个动作 —— 由浮层回报，用来高亮动作列表（它自己也会切，比如回应播完）。 */
        const [activeClip, setActiveClip] = React.useState('')
        /** 大宠物包（动作多）的搜索词；换宠物时清空。 */
        const [petQuery, setPetQuery] = React.useState('')
        const petPackId = state && state.pet && typeof state.pet.pack === 'string' ? state.pet.pack : ''
        // ── 卸载 / 更新（v1.11.0）──
        // 自管状态：宿主在 profile 里有没有装我们、有没有选中、装的是什么形态。
        const [selfState, setSelfState] = React.useState(null)
        const [selfBusy, setSelfBusy] = React.useState('')

        // 状态到达后同步滑杆位置（共用主配置 durationSec / audioVolume）。
        React.useEffect(() => {
          if (state && typeof state.durationSec === 'number') setSec(state.durationSec)
          if (state && typeof state.audioVolume === 'number') setAvol(Math.round(state.audioVolume * 100))
          if (state && state.pet && typeof state.pet.size === 'number') setPetSize(state.pet.size)
        }, [state])

        // 设置页里的改动（开关 / 大小）要立刻反映到浮层上：两边不在同一棵渲染树上，
        // 用一条 window 事件桥接。浮层只取 enabled/size/clips，位置它自己管。
        React.useEffect(() => {
          if (!state || !state.pet) return
          window.dispatchEvent(new CustomEvent('dsa:pet-sync', { detail: state.pet }))
        }, [state])

        // 反过来：浮层切了动作就回报一声，列表跟着高亮。
        React.useEffect(() => {
          const onState = (event) => {
            const detail = event.detail
            setActiveClip(detail && typeof detail === 'object' ? String(detail.id || '') : String(detail || ''))
          }
          window.addEventListener('dsa:pet-state', onState)
          // 先挂监听再问：宠物在页面加载时就开播了，那会儿没人听。
          window.dispatchEvent(new CustomEvent('dsa:pet-query'))
          return () => window.removeEventListener('dsa:pet-state', onState)
        }, [])

        // 换宠物后搜索词没有意义了（旧宠物的动作名对新宠物多半是空结果）。
        React.useEffect(() => {
          setPetQuery('')
        }, [petPackId])

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

        // 宠物大小：同展示时长的防抖方式（停手 350ms 提交一次）。
        const onPetSize = (value) => {
          const next = Math.min(320, Math.max(100, Math.round(Number(value))))
          setPetSize(next)
          if (petSizeRef.current !== null) clearTimeout(petSizeRef.current)
          petSizeRef.current = setTimeout(() => {
            petSizeRef.current = null
            postJson(send, { petSize: next }, t('petSaved'))
          }, 350)
        }

        /** 宠物开关：字段在 state.pet 里，不走通用 toggle（那个读的是顶层字段）。 */
        const togglePet = () => {
          if (!state || !state.pet) return
          postJson(send, { petEnabled: !state.pet.enabled }, t('petSaved'))
        }

        /**
         * 预览的统一入口：宠物没开就先打开它 —— 用户按了按钮就是要看。
         * @param {() => void} fire 真正发事件的回调（打开成功后延迟一点再发，等浮层建好 DOM）。
         */
        const withPetEnabled = (fire) => {
          if (state && state.pet && !state.pet.enabled) {
            void postJson(send, { petEnabled: true }, t('petSaved')).then((payload) => {
              if (!payload || !payload.ok) return
              // 先把新状态推给浮层（它要在这之后才有 DOM 可播），再发播放事件。
              // 只靠 effect 那条路会有一个"打开还没渲染完就播"的空窗。
              if (payload.pet) window.dispatchEvent(new CustomEvent('dsa:pet-sync', { detail: payload.pet }))
              setTimeout(fire, 60)
            })
            return
          }
          fire()
        }

        /** 指定动作：演一遍回待机（不写配置，纯预览）。 */
        const previewPet = (id) => withPetEnabled(() => window.dispatchEvent(new CustomEvent('dsa:pet-play', { detail: id })))

        /** 分类卡：让浮层在这个分类里随机挑一个。 */
        const previewPetCategory = (id) =>
          withPetEnabled(() => window.dispatchEvent(new CustomEvent('dsa:pet-category', { detail: id })))

        /** 「随机一个」：从全体待机动作里抽。 */
        const previewPetRandom = () => withPetEnabled(() => window.dispatchEvent(new CustomEvent('dsa:pet-random')))

        /** 换宠物：包 id 落盘，浮层随状态回包重建（开关状态不变）。 */
        const choosePack = (id) => {
          if (!state || !state.pet || state.pet.pack === id) return
          postJson(send, { petPack: id }, t('petSaved'))
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

        /**
         * 宠物面板：开关 + 大小 + 宠物选择 + 动作区。
         *
         * 动作**不写死**：清单来自宿主扫描 `builtin/宠物/`，丢一个新 webm 进去就多一条。
         * 动作少的包直接平铺；动作多的（女仆 109 段）按分类展示，配搜索和「随机一个」——
         * 铺一百多个格子没人看得下去。
         */
        const pet = state && state.pet && typeof state.pet === 'object' ? state.pet : null
        const petPacks = pet && Array.isArray(pet.packs) ? pet.packs : []
        const petPack = petPacks.find((item) => item.id === pet.pack) || petPacks[0] || null
        const petClips = petPack && Array.isArray(petPack.clips) ? petPack.clips : []
        const petCats = petPack && Array.isArray(petPack.categories) ? petPack.categories : []
        const petMany = petClips.length > 12
        const petKeyword = petQuery.trim()
        const petHits = petKeyword === '' ? [] : petClips.filter((clip) => clip.name.includes(petKeyword)).slice(0, 8)
        const petNow = petClips.find((clip) => clip.id === activeClip) || null
        const petAsset = (file) => `${ASSET}?path=${encodeURIComponent(file)}`
        const petSwitch = h(
          'button',
          {
            type: 'button',
            className: 'dsa-set-switch',
            role: 'switch',
            'aria-checked': pet && pet.enabled ? 'true' : 'false',
            'aria-label': t('petEnable'),
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
        /** 一个宠物 = 一张卡（封面 + 名字 + 动作数），换它就换整套素材。 */
        const petPackCard = (item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: 'dsa-set-pet',
              'data-on': petPack && petPack.id === item.id ? '1' : '0',
              'aria-pressed': petPack && petPack.id === item.id ? 'true' : 'false',
              disabled: busy || pet === null,
              onClick: () => choosePack(item.id),
            },
            item.cover
              ? h('img', { className: 'dsa-set-pet-cover', src: petAsset(item.cover), alt: '', loading: 'lazy' })
              : h('div', { className: 'dsa-set-pet-cover' }),
            h('span', { className: 'dsa-set-pet-name' }, item.name),
            h('span', { className: 'dsa-set-pet-count' }, `${item.count} ${t('petUnit')}`),
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
                        clip.name,
                      ),
                    ),
              )
        const petCredit =
          petPack && petPack.credit
            ? h(
                'div',
                { className: 'dsa-set-credit' },
                `${t('petCredit')} `,
                h(
                  'a',
                  { href: petPack.credit.url, target: '_blank', rel: 'noreferrer noopener' },
                  petPack.credit.name || petPack.credit.author || petPack.credit.url,
                ),
                petPack.credit.license ? ` · ${petPack.credit.license}` : '',
              )
            : null
        const petPanel = h(
          'div',
          { className: 'dsa-set-panel', role: 'tabpanel', 'aria-label': t('catPet') },
          h('div', { className: 'dsa-set-desc' }, t('petNote')),
          h(
            'div',
            { className: 'dsa-set-row' },
            h('div', { className: 'dsa-set-label' }, t('petEnable')),
            h('div', { className: 'dsa-set-right' }, petSwitch),
          ),
          h(
            'div',
            { className: 'dsa-set-row' },
            h('div', { className: 'dsa-set-label' }, t('petSize')),
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
            h('div', { className: 'dsa-set-stack-head' }, h('div', { className: 'dsa-set-label' }, t('petPick'))),
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
              h('div', { className: 'dsa-set-label' }, t('petAction')),
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
            petCredit,
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
          // ── 分类切换器：[MP4 | 壁纸 | 音频 | 宠物 | 更新公告]（素材三类 + 宠物 + 一个信息页）──
          h(
            'div',
            { className: 'dsa-set-tabs', role: 'tablist', 'aria-label': t('title') },
            [
              { id: 'mp4', label: t('catMp4') },
              { id: 'wall', label: t('catWall') },
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
          isReleaseCat ? releasePanel : isPetCat ? petPanel : categoryPanel,
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
          // 位置由浮层自己写盘：拖动结束时 POST 一次 petX/petY。设置页只做
          // "开关 / 大小 / 触发动作"，两边用 window 事件桥接，互不持有引用。
          // POST 的回包会广播成 dsa:pet-sync：右键菜单里"隐藏"自己之后，浮层和
          // 设置页的开关都能立刻对上，不用等用户手动刷新。
          const petLayer = createPetOverlay({
            t,
            onPersist: (patch) => {
              void fetch(MANAGE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
              })
                .then((res) => res.json())
                .then((payload) => {
                  if (payload && payload.pet) {
                    window.dispatchEvent(new CustomEvent('dsa:pet-sync', { detail: payload.pet }))
                  }
                })
                .catch(() => {})
            },
          })
          const onPetSync = (event) => petLayer.sync(event.detail)
          const onPetPlay = (event) => petLayer.play(String(event.detail || ''))
          const onPetCategory = (event) => petLayer.playCategory(String(event.detail || ''))
          const onPetRandom = () => petLayer.random()
          const onPetReset = () => petLayer.reset()
          // 设置页翻到宠物页签时会问一句"现在在演哪个"，好把动作列表的高亮对上。
          const onPetQuery = () => petLayer.report()
          window.addEventListener('dsa:pet-sync', onPetSync)
          window.addEventListener('dsa:pet-play', onPetPlay)
          window.addEventListener('dsa:pet-category', onPetCategory)
          window.addEventListener('dsa:pet-random', onPetRandom)
          window.addEventListener('dsa:pet-reset', onPetReset)
          window.addEventListener('dsa:pet-query', onPetQuery)
          void petLayer.load()

          return () => {
            window.removeEventListener('dsa:pet-sync', onPetSync)
            window.removeEventListener('dsa:pet-play', onPetPlay)
            window.removeEventListener('dsa:pet-category', onPetCategory)
            window.removeEventListener('dsa:pet-random', onPetRandom)
            window.removeEventListener('dsa:pet-reset', onPetReset)
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
