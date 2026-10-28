/*
 * startup-animation —— 注入到 index.html 的浏览器运行时。
 *
 * 这个文件是**脚本文本**，不是模块：宿主把它整个读出来，作为一个
 * `{ kind: 'script', placement: 'body' }` 的结构化注入行塞进 index.html。
 *
 * 为什么是内联文本行而不是 script-src 行（硬约束）：
 *   kind:'script'     → createElement + textContent + append，没有 await，不可能失败；
 *   kind:'script-src' → await loadScript(src)，失败即 reject，而那个 reject 会把
 *                       __DSH_BOOT_READY__ 打掉 ⇒ 整个应用起不来。
 * 所以：永远不要改用 script-src，也不要让本文件在求值时抛异常。
 *
 * 它只做一件事：**开机动画覆盖层**。设计原则（多数来自 dsh-video-skin 踩过的坑）：
 *   - 这块屏是装饰品，没有任何一种失败可以合理地扣住用户：素材请求挂住、一帧都出不来、
 *     内核一直不就绪、内核启动失败——每一条都有上界，点击/按键在任何阶段都能立刻进入；
 *   - 淡出是一个"整体"：所有层一起淡，淡完把节点从 DOM 移除，不留任何盖住界面的东西；
 *   - 淡出时长**永远是配置里的固定值**，不是"距离就绪还剩多久"（否则会缩成硬切）；
 *   - 覆盖层挂在 document.body 上、**不放进 #root**：内核用 hydrateRoot 接管 #root 里
 *     已有的启动页 DOM，往里塞节点会造成 hydration 内容不匹配；
 *   - 就绪判据不是"#root 有内容"——页面刚加载时 #root 是空的；真正的信号是
 *     **内核启动页 [data-dsh-boot] 出现过、然后被应用树替换掉**。
 *   - 配置是**实时**的：桌面壳注入表是宿主启动时的一次性快照（刷新不重新收集），
 *     所以脚本每次页面加载先 GET 管理接口拿当前配置（500ms 上限，失败退回快照）——
 *     开关/素材/时长改完点“立即刷新”即生效；关闭开关或素材模式缺素材时不挂载
 *     （显示内核原生启动页）。
 */

; (function (global) {
  'use strict'

  var NS = '__DSA_BOOT__'

  // 重复注入/重复求值都安全忽略。
  if (global.__DSA_STARTED__ === true) return
  var baked = global[NS]
  if (baked === null || typeof baked !== 'object') return
  if (typeof global.document !== 'object' || global.document === null) return
  global.__DSA_STARTED__ = true

  var doc = global.document

  // ────────────────────────────── 首帧遮罩 ──────────────────────────────
  //
  // 覆盖层要等一次实时配置 fetch 才挂得上（见 resolveConfig），而浏览器在解析完
  // 首屏之后、那次 fetch 回来之前就已经把原生启动卡画出来了 —— 那 1–2 帧就是
  // 用户看到的"闪一下原生动画"。
  //
  // 这里在**解析期**（同一个同步执行栈里）按烤进去的配置先给 <html> 打个标记，
  // 注入的样式会立刻铺满屏幕并藏起 [data-dsh-boot]，原生卡一帧都露不出来。
  // 真正的覆盖层挂上、或决定不显示（实时配置说关掉了 / 素材失败）时立刻摘掉。
  var COVER_ATTR = 'data-dsa-cover'

  function setCover(on) {
    try {
      if (on) doc.documentElement.setAttribute(COVER_ATTR, '')
      else doc.documentElement.removeAttribute(COVER_ATTR)
    } catch (error) {
      /* 遮罩只是"少闪一下"的优化，标记失败就当没有 */
    }
  }

  try {
    if (
      baked.enabled !== false &&
      (baked.mode === 'video' || baked.mode === 'image') &&
      typeof baked.src === 'string' &&
      baked.src !== ''
    ) {
      setCover(true)
    }
  } catch (error) {
    /* 同上 */
  }

  // ────────────────────────────── 小工具 ──────────────────────────────

  function num(value, fallback, min, max) {
    var n = typeof value === 'number' ? value : Number(value)
    if (n !== n) return fallback
    if (n < min) return min
    if (n > max) return max
    return n
  }

  function pickText(value, fallback) {
    return typeof value === 'string' && value !== '' ? value : fallback
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function raf(fn) {
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(fn)
    else global.setTimeout(fn, 50)
  }

  // 文案：开机动画在应用 locale 服务之前运行，只能按浏览器语言选中/英。
  var lang = 'en'
  try {
    var nav = global.navigator
    var detected = (nav && (nav.language || (nav.languages && nav.languages[0]))) || ''
    if (/^zh/i.test(detected)) lang = 'zh'
  } catch (error) {
    lang = 'en'
  }
  var COPY = {
    zh: {
      label: '启动动画',
      hint: '正在启动…',
      skip: '点击画面跳过',
      sound: '开启声音',
      slow: '启动较慢，正在进入…',
      entering: '正在进入…',
      failed: '启动失败 · 点击查看',
      waiting: '界面就绪后自动进入',
      muted: '浏览器拦下了自动播放的声音 · 点左下角开声音',
      soundOn: '声音已开 · 点画面跳过',
      soundRefused: '系统拒绝了声音播放',
    },
    en: {
      label: 'Startup animation',
      hint: 'Starting…',
      skip: 'Click to skip',
      sound: 'Turn on sound',
      slow: 'Slow start — almost there…',
      entering: 'Entering…',
      failed: 'Startup failed · click to view',
      waiting: 'Continuing once the UI is ready',
      muted: 'Autoplay sound blocked · use the button at bottom left',
      soundOn: 'Sound on · click the screen to skip',
      soundRefused: 'The system refused sound playback',
    },
  }[lang]

  // ─────────────────── 实时配置（“改配置 → 刷新即生效”的关键）───────────────────

  var MANAGE_URL = "/dsh-startup-animation/manage?cfg=1"
  var LIVE_TIMEOUT_MS = 500

  function isObj(value) {
    return value !== null && typeof value === "object"
  }

  /** 快照在前、实时在后：实时值覆盖同名键，缺键保留快照值。 */
  function mergeCfg(base, live) {
    var out = {}
    var key
    for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key]
    for (key in live) if (Object.prototype.hasOwnProperty.call(live, key)) out[key] = live[key]
    return out
  }

  /**
   * 取实时配置：GET manage → payload.cfg（合并进快照）；失败/超时（500ms）→ 快照。
   * 桌面壳注入表 = 宿主启动一次性快照，只有实时通道能让“改配置 → 刷新”生效。
   * @param {(cfg: object) => void} done 拿到最终配置（恰好一次）。
   */
  function resolveConfig(done) {
    var settled = false
    var finish = function (cfg) {
      if (settled) return
      settled = true
      done(cfg)
    }
    var cap = global.setTimeout(function () {
      finish(baked)
    }, LIVE_TIMEOUT_MS)
    var fallback = function () {
      global.clearTimeout(cap)
      finish(baked)
    }
    try {
      if (typeof global.fetch !== "function") {
        fallback()
        return
      }
      global.fetch(MANAGE_URL, { cache: "no-store" })
        .then(function (response) {
          return response.json()
        })
        .then(function (payload) {
          global.clearTimeout(cap)
          if (isObj(payload) && payload.ok === true && isObj(payload.cfg)) {
            finish(mergeCfg(baked, payload.cfg))
          } else {
            finish(baked)
          }
        })
        .catch(fallback)
    } catch (error) {
      fallback()
    }
  }

  function beginWithConfig(cfg) {
    // ── 运行时政策：实时配置决定一切 ──
    //   关闭开关 → 不挂载（显示内核原生启动页）。
    //   素材模式（video/image）但**没有素材** → 不挂载：没有素材的素材模式只剩
    //   一块永远停在"加载中"的空屏，比原生启动页更差。
    //   其余情况一律挂载：mode='css' 是**内置动画**（原创的 CSS 场景），不是"没素材"。
    //     早先这里只放行 video/image 两种模式，css 模式直接 early-return ——
    //     于是内置动画其实**一次都没出现过**，而 README 一直写着"装上就有"。
    //     默认配置 file='' → mode='css' → 内置动画本来就是"零配置"承诺的那一份，
    //     不该被一行 early-return 挡掉。
    if (cfg === null || typeof cfg !== "object") {
      setCover(false)
      return
    }
    if (cfg.enabled === false) {
      setCover(false)
      return
    }
    var mode = cfg.mode === 'video' || cfg.mode === 'image' ? cfg.mode : 'css'
    var src = typeof cfg.src === 'string' ? cfg.src : ''
    // 解析期按快照打的首帧遮罩，在这里必须跟着实时配置的结论落地：
    // 实时配置说"关掉了 / 没选素材"→ 立刻摘掉，否则整页被我们自己盖成纯色。
    if (mode !== 'css' && src === "") {
      setCover(false)
      return
    }

    var fadeMs = num(cfg.fadeMs, 600, 100, 6000)
    var skipFadeMs = num(cfg.skipFadeMs, 240, 60, 2000)
    var minMs = num(cfg.minMs, 900, 0, 10000)
    var holdMs = num(cfg.holdMs, 20000, 2000, 120000)
    var holdGraceMs = num(cfg.holdGraceMs, 4000, 0, 30000)
    var noFrameMs = num(cfg.noFrameMs, 10000, 1500, 30000)
    var endlessMs = num(cfg.endlessMs, 20000, 3000, 60000)
    // ── 两路声音彼此独立，各自由用户决定 ──
    //   ① 视频自带的音轨 → cfg.sound（"视频尝试带声播放"）
    //   ② 独立的开机音频文件 → cfg.audioEnabled
    // 两者可以同时开：视频有音轨就放它，音频文件同时播 —— 都由用户自己勾选，
    // 插件不替用户做"开一个就关另一个"的决定（早期版本会强制静音视频，那是错的）。
    var wantSound = cfg.sound === true
    var volume = num(cfg.volume, 1, 0, 1)
    var audioOn = cfg.audioEnabled === true && typeof cfg.audioSrc === 'string' && cfg.audioSrc !== ''
    var audioVolume = num(cfg.audioVolume, 1, 0, 1)
    var showProgress = cfg.progress !== false

    var hintIdle = pickText(cfg.hint, COPY.hint)
    var skipLabel = pickText(cfg.skipLabel, COPY.skip)
    var soundLabel = pickText(cfg.soundLabel, COPY.sound)

    // ─────────────────────────── 覆盖层 DOM ───────────────────────────

    var root = el('div', 'dsa-root')
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', COPY.label)
    root.setAttribute('data-state', 'idle')
    root.setAttribute('data-mode', mode === 'css' ? 'css' : 'media')
    if (mode !== 'css') root.setAttribute('data-media', 'loading')
    if (cfg.still === true) root.setAttribute('data-still', '1')
    root.style.setProperty('--dsa-fade', fadeMs + 'ms')

    var media = el('div', 'dsa-media')

    var scene = el('div', 'dsa-scene')
    var emblem = el('div', 'dsa-emblem')
    emblem.appendChild(el('span', 'dsa-ring r1'))
    emblem.appendChild(el('span', 'dsa-ring r2'))
    emblem.appendChild(el('span', 'dsa-core'))
    scene.appendChild(emblem)
    scene.appendChild(el('div', 'dsa-title', pickText(cfg.title, 'DeepSeek Harness')))

    var hud = el('div', 'dsa-hud')
    var bar = el('div', 'dsa-bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-label', COPY.hint)
    if (showProgress) bar.setAttribute('data-indeterminate', '1')
    else bar.style.display = 'none'
    var fill = el('span', 'dsa-fill')
    bar.appendChild(fill)
    var status = el('div', 'dsa-status', hintIdle)
    var skipPill = el('div', 'dsa-skip')
    skipPill.appendChild(el('span', 'dsa-skip-glyph', '▶'))
    skipPill.appendChild(el('span', null, skipLabel))
    hud.appendChild(bar)
    hud.appendChild(status)
    hud.appendChild(skipPill)

    var soundButton = el('div', 'dsa-sound')
    soundButton.setAttribute('data-visible', '0')
    soundButton.setAttribute('role', 'button')
    soundButton.setAttribute('tabindex', '0')
    soundButton.appendChild(el('span', null, '♪'))
    soundButton.appendChild(el('span', null, soundLabel))

    // 开机音频元素：不显示、不进 #root；随覆盖层一起创建与移除。
    var audioNode = null
    if (audioOn) {
      audioNode = el('audio')
      audioNode.preload = 'auto'
      audioNode.volume = audioVolume
      audioNode.setAttribute('aria-hidden', 'true')
      audioNode.src = cfg.audioSrc
    }

    root.appendChild(media)
    root.appendChild(scene)
    root.appendChild(hud)
    root.appendChild(soundButton)
    if (audioNode !== null) root.appendChild(audioNode)

    // ─────────────────────────── 运行状态 ───────────────────────────

    var state = {
      leaving: false,
      appReady: false,
      failed: false,
      sawBoot: false,
      loaded: false,
      mediaOk: false,
      // 素材第一帧出现的时刻；null = 尚未出画（覆盖层保持透明，原生启动页照常）。
      revealedAt: null,
      mediaNode: null,
      silenced: false,
      startAt: Date.now(),
      reason: null,
      timers: [],
      intervals: [],
      observer: null,
    }

    function timer(fn, ms) {
      var id = global.setTimeout(fn, ms)
      state.timers.push(id)
      return id
    }

    function interval(fn, ms) {
      var id = global.setInterval(fn, ms)
      state.intervals.push(id)
      return id
    }

    function clearScheduling() {
      var i
      for (i = 0; i < state.timers.length; i += 1) global.clearTimeout(state.timers[i])
      state.timers.length = 0
      for (i = 0; i < state.intervals.length; i += 1) global.clearInterval(state.intervals[i])
      state.intervals.length = 0
      if (state.observer !== null) {
        try {
          state.observer.disconnect()
        } catch (error) {
          /* 已经断开 */
        }
        state.observer = null
      }
    }

    function setHint(text) {
      if (state.failed) return
      status.textContent = text
    }

    function setAttention(text) {
      state.failed = true
      root.setAttribute('data-attention', '1')
      status.textContent = text
    }

    /**
     * 原生窗口控件浮层（Electron titleBarOverlay）画在所有网页内容之上，动画盖不住它；
     * 它的底色来自 preload 探针读取的计算后 --dsw-specific-sidebar-fill（应用侧栏色）。
     * 不处理的话：动画（尤其亮色视频）期间右上角出现一块深色"黑框"，闪一下才消失。
     * 做法：动画期间在 <html> 与 <body> 上内联压这个 token 为 transparent（内联压过
     * 样式表；探针随之上报透明，浮层融入动画），并用 MutationObserver 持续重申 ——
     * 主题插件若也在内联层写这个值，会被压回来（自身写入因值相同短路，不成环）。
     * 退场时还原并主动触发一次 body[style] 变更，让探针重新读取并上报真实侧栏色。
     */
    var TITLEBAR_TOKEN = '--dsw-specific-sidebar-fill'
    var titlebarHoldOn = false
    var titlebarGuard = null
    // 按住前 html/body 上的既有内联值（皮肤/壁纸引擎可能正内联着半透明侧栏色），
    // 还原时精确写回，而不是粗暴删除别人的声明。
    var titlebarPrev = { html: '', body: '' }

    function holdTitlebar() {
      if (titlebarHoldOn) return
      titlebarHoldOn = true
      try {
        titlebarPrev.html = doc.documentElement.style.getPropertyValue(TITLEBAR_TOKEN)
        titlebarPrev.body = doc.body ? doc.body.style.getPropertyValue(TITLEBAR_TOKEN) : ''
        doc.documentElement.style.setProperty(TITLEBAR_TOKEN, 'transparent')
        if (doc.body) doc.body.style.setProperty(TITLEBAR_TOKEN, 'transparent')
      } catch (error) {
        /* 覆盖不了就算了，顶多维持旧行为 */
      }
      if (typeof global.MutationObserver === 'function') {
        try {
          titlebarGuard = new global.MutationObserver(function () {
            if (!titlebarHoldOn) return
            try {
              if (doc.documentElement.style.getPropertyValue(TITLEBAR_TOKEN) !== 'transparent') {
                doc.documentElement.style.setProperty(TITLEBAR_TOKEN, 'transparent')
              }
              if (doc.body && doc.body.style.getPropertyValue(TITLEBAR_TOKEN) !== 'transparent') {
                doc.body.style.setProperty(TITLEBAR_TOKEN, 'transparent')
              }
            } catch (error) {
              /* 尽力而为 */
            }
          })
          titlebarGuard.observe(doc.documentElement, { attributes: true, attributeFilter: ['style'] })
          if (doc.body) titlebarGuard.observe(doc.body, { attributes: true, attributeFilter: ['style'] })
        } catch (error) {
          titlebarGuard = null
        }
      }
    }

    /** 还原原生标题栏浮层的取色（见 holdTitlebar 说明）。 */
    function restoreTitlebar() {
      titlebarHoldOn = false
      if (titlebarGuard !== null) {
        try {
          titlebarGuard.disconnect()
        } catch (error) {
          /* 已断开 */
        }
        titlebarGuard = null
      }
      var restoreOne = function (node, prev) {
        if (!node) return
        if (prev !== null && prev !== '') node.style.setProperty(TITLEBAR_TOKEN, prev)
        else node.style.removeProperty(TITLEBAR_TOKEN)
      }
      try {
        restoreOne(doc.documentElement, titlebarPrev.html)
        restoreOne(doc.body, titlebarPrev.body)
        // preload 探针只观察 body 的 style 属性变化 —— 给一个无害变更触发它重新读取。
        doc.body.style.setProperty('--dsa-titlebar-nudge', '1')
        doc.body.style.removeProperty('--dsa-titlebar-nudge')
      } catch (error) {
        /* 尽力而为 */
      }
    }

    /**
     * 淡出并交接。span **永远是固定时长**（fadeMs / skipFadeMs），不是剩余时间。
     * 最短展示（minMs）在这里统一兜：没到点就顺延，不打补丁式地跳帧。
     * @param {number} span 淡出时长。 @param {string} reason 诊断标签。
     */
    function enter(span, reason) {
      if (state.leaving) return
      // 用户主动跳过（点击/按键）绕过最短展示——他们已经决定不等了；
      // 其余路径（就绪、超时、失败）统一兜 minMs，防止一闪而过。
      var voluntary = reason === 'click' || reason.indexOf('key:') === 0
      // 最短展示从"素材出画"起算：加载耗时（大文件 moov 在尾等）不吃用户的展示时长；
      // 从未出画（素材坏了/一直没等到）就用 startAt —— 反正覆盖层是透明的，让开无痕。
      var clockStart = state.revealedAt !== null ? state.revealedAt : state.startAt
      var elapsed = Date.now() - clockStart
      if (!voluntary && elapsed < minMs) {
        timer(function () {
          enter(span, reason)
        }, minMs - elapsed + 10)
        return
      }
      state.leaving = true
      state.reason = reason
      // 淡出开始即还原：浮层随动画的消散一起显出应用自己的侧栏底色，衔接自然。
      restoreTitlebar()
      // 覆盖层要淡出了 —— 首帧遮罩必须一起摘，否则原生启动页被一直藏到动画消失。
      setCover(false)
      var ms = Math.round(num(span, fadeMs, 60, 6000))
      root.style.setProperty('--dsa-fade', ms + 'ms')
      root.setAttribute('data-state', 'leaving')
      clearScheduling()
      // 退场即摘掉 document 级监听：覆盖层移除后不留死监听在应用文档上。
      try {
        doc.removeEventListener('keydown', onDocKey)
      } catch (error) {
        /* 尽力而为 */
      }
      fadeAudio(ms)
      // 开机音频与覆盖层同步退场：跳过动画 = 跳过音频（淡出后暂停）。
      fadeStartupAudio(ms)
      try {
        if (global.console && global.console.info) {
          global.console.info(
            '[startup-animation] overlay leaving: reason=' + reason + ' fade=' + ms + 'ms' +
            ' appReady=' + state.appReady + ' sawBoot=' + state.sawBoot,
          )
        }
      } catch (error) {
        /* 只是日志 */
      }
      timer(function () {
        try {
          if (root.parentNode) root.parentNode.removeChild(root)
        } catch (error) {
          /* 已经不在了 */
        }
        if (state.mediaNode !== null) {
          try {
            state.mediaNode.pause && state.mediaNode.pause()
          } catch (error) {
            /* 没在播的元素不需要 pause */
          }
        }
        global.__DSA_DONE__ = true
      }, ms + 140)
    }

    /** 交接条件：应用树挂上来（+ minMs 由 enter 统一兜）。 */
    function maybeEnter() {
      if (state.leaving || state.failed) return
      if (!state.appReady) return
      enter(fadeMs, 'ready')
    }

    function markAppReady(why) {
      if (state.appReady || state.leaving) return
      state.appReady = true
      setHint(COPY.entering)
      maybeEnter()
    }

    /**
     * 就绪判据。
     * - 正常路径：启动卡 [data-dsh-boot] 出现过（state.sawBoot），随后 #root 出现
     *   一个**没有**该属性的子节点（应用树），即为就绪；
     * - 标记漂移兜底：从未见过启动卡时，只有 window load 之后且 #root 已有内容才算，
     *   宁可慢一点也不在第一帧误判。
     */
    function inspectRoot() {
      var container = doc.getElementById('root')
      if (container === null || container === undefined) return false
      var children = container.children
      if (children === undefined || children.length === 0) return false
      var sawBootThisRound = false
      var sawNonBoot = false
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i]
        if (!child || typeof child.hasAttribute !== 'function') continue
        if (child.hasAttribute('data-dsh-boot')) sawBootThisRound = true
        else sawNonBoot = true
      }
      if (sawBootThisRound) state.sawBoot = true
      if (!sawNonBoot) return false
      if (state.sawBoot) return true
      return state.loaded === true
    }

    function watchAppReady() {
      var check = function () {
        if (state.leaving) return
        if (inspectRoot()) markAppReady('watch')
      }
      var attach = function () {
        if (state.observer !== null || typeof global.MutationObserver !== 'function') return
        var container = doc.getElementById('root')
        if (container === null || container === undefined) return
        try {
          state.observer = new global.MutationObserver(check)
          state.observer.observe(container, { childList: true })
        } catch (error) {
          state.observer = null
        }
      }
      attach()
      interval(function () {
        attach()
        check()
      }, 120)
      if (doc.readyState === 'complete') state.loaded = true
      else {
        global.addEventListener('load', function () {
          state.loaded = true
          check()
        })
      }
    }

    /** 内核启动失败：启动页列出失败清单且永远不挂应用 → 让开让用户读到原因。 */
    function watchFailure() {
      interval(function () {
        if (state.leaving || state.failed) return
        var bootEl = doc.querySelector('[data-dsh-boot]')
        if (bootEl === null || bootEl === undefined) return
        var text = bootEl.textContent || ''
        if (text.indexOf('Failed to load plugins') < 0 && text.indexOf('did not activate') < 0) return
        setAttention(COPY.failed)
        timer(function () {
          enter(fadeMs, 'kernel-failed')
        }, 2600)
      }, 400)
    }

    /** 内核真实启动进度：启动页 spinner 上的 --dsh-boot-arc（72° 空 → 288° 满）。 */
    function watchProgress() {
      if (!showProgress) return
      var arcMin = 72
      var arcSpan = 216
      var observed = false
      var sinceStart = 0
      interval(function () {
        if (state.leaving) return
        var spinner = doc.querySelector('[data-dsh-boot-spinner]')
        if (spinner !== null && spinner !== undefined && spinner.style) {
          var raw = parseFloat(
            typeof spinner.style.getPropertyValue === 'function'
              ? spinner.style.getPropertyValue('--dsh-boot-arc')
              : '',
          )
          if (isFinite(raw)) {
            var ratio = Math.min(Math.max((raw - arcMin) / arcSpan, 0), 1)
            root.style.setProperty('--dsa-prog', (Math.max(ratio, 0.04) * 100).toFixed(1) + '%')
            if (!observed) {
              observed = true
              bar.setAttribute('data-indeterminate', '0')
            }
            return
          }
        }
        // 4 秒还没见到内核进度 → 认定拿不到，转流光。
        sinceStart += 200
        if (!observed && sinceStart >= 4000 && bar.getAttribute('data-indeterminate') !== '1') {
          bar.setAttribute('data-indeterminate', '1')
        }
      }, 200)
    }

    /** 内核迟迟不就绪的两段上界：到点只提示"较慢"并乐观就绪；再宽限后才让开。 */
    function watchHold() {
      timer(function () {
        if (state.leaving || state.appReady) return
        status.textContent = COPY.slow
        root.setAttribute('data-attention', '1')
        state.appReady = true
        if (state.mediaNode !== null && typeof state.mediaNode.loop === 'boolean') {
          // 已经在循环播放，让它继续；非循环素材（图片）本就不受影响。
        }
        maybeEnter()
        if (state.leaving) return
        timer(function () {
          if (state.leaving) return
          enter(fadeMs, 'hold-grace')
        }, holdGraceMs)
      }, holdMs)
    }

    // ─────────────────────────── 音量淡出 ───────────────────────────

    function fadeAudio(ms) {
      var mediaEl = state.mediaNode
      if (mediaEl === null || mediaEl === undefined || typeof mediaEl !== 'object') return
      if (mediaEl.muted === true || mediaEl.tagName !== 'VIDEO') return
      var from
      try {
        from = mediaEl.volume
      } catch (error) {
        return
      }
      if (!(from > 0)) return
      var frames = Math.max(1, Math.round(ms / 16))
      var done = 0
      var step = function () {
        if (state.mediaNode !== mediaEl || state.leaving === false) {
          // 交接已经开始，继续把音量走完；mediaNode 被替换则停。
        }
        if (state.mediaNode !== mediaEl) return
        done += 1
        try {
          mediaEl.volume = Math.max(0, from * (1 - done / frames))
        } catch (error) {
          return
        }
        if (done < frames) raf(step)
      }
      raf(step)
    }

    // ─────────────────────────── 开机音频 ───────────────────────────

    /** 起播开机音频：被自动播放策略拦下就静默放弃（这块屏绝不扣住用户）。 */
    function playStartupAudio() {
      if (audioNode === null) return
      try {
        var played = audioNode.play()
        if (played && typeof played.catch === 'function') {
          played.catch(function () {
            // 拦下就静音放弃；再试一次 muted 播放也没意义 —— 音频是装饰。
            audioNode = null
          })
        }
      } catch (error) {
        /* 尽力而为 */
      }
    }

    /** 淡出开机音频并在淡完暂停（与覆盖层退场同步 —— 跳过动画即跳过音频）。 */
    function fadeStartupAudio(ms) {
      var node = audioNode
      if (node === null) return
      audioNode = null
      var from
      try {
        from = node.volume
      } catch (error) {
        from = 1
      }
      var frames = Math.max(1, Math.round(ms / 16))
      var done = 0
      var step = function () {
        done += 1
        try {
          node.volume = Math.max(0, from * (1 - done / frames))
        } catch (error) {
          try {
            node.pause()
          } catch (ignored) {
            /* 已经停了 */
          }
          return
        }
        if (done < frames) raf(step)
        else {
          try {
            node.pause()
          } catch (ignored2) {
            /* 已经停了 */
          }
        }
      }
      raf(step)
    }

    // ─────────────────────────── 素材层 ───────────────────────────

    /** 素材任何一条失败路径都走这里：覆盖层保持透明（= 原生启动页），退场无痕。 */
    function mediaGone(reason) {
      if (state.leaving) return
      root.setAttribute('data-media', 'gone')
      root.setAttribute('data-mode', 'css')
      state.mediaOk = false
      state.mediaNode = null
      // 从未出画 → 最短展示缩回 900ms（透明层没必要按素材时长扣着交接）。
      if (state.revealedAt === null) minMs = 900
      // 出画前失败过 → 标题栏浮层从未被按住/或按住后素材又坏了 → 还原原生取色。
      restoreTitlebar()
      // 覆盖层转透明 = 原生启动页接回来，首帧遮罩必须一起摘掉。
      setCover(false)
      try {
        if (global.console && global.console.warn) global.console.warn('[startup-animation] media dropped: ' + reason)
      } catch (error) {
        /* 只是日志 */
      }
    }

    /**
     * 素材第一帧就位：画面交叉淡入、起播开机音频（音频与画面同刻开始，不会在
     * 原生页后面干响）。标题栏浮层在 begin() 里就已经按住了，这里再调一次是
     * 幂等的兜底（覆盖层可能被别的路径重新挂过）。
     */
    function markMediaOk() {
      if (state.mediaOk || state.leaving) return
      state.mediaOk = true
      state.revealedAt = Date.now()
      holdTitlebar()
      // 淡入用短时长（退场时 enter 会把 --dsa-fade 改回配置值）。
      root.style.setProperty('--dsa-fade', '260ms')
      root.setAttribute('data-media', 'ok')
      playStartupAudio()
    }

    function whenFramePresents(node, done) {
      var fired = false
      var once = function () {
        if (fired) return
        fired = true
        done()
      }
      if (node.tagName === 'IMG') {
        if (node.complete === true && node.naturalWidth > 0) once()
        else node.addEventListener('load', once)
        // 只认 load：error 走 mediaGone（重试 → 内置动画），不能误标成"素材已就位"。
        return
      }
      if (typeof node.readyState === 'number' && node.readyState >= 2) {
        once()
        return
      }
      node.addEventListener('loadeddata', once)
      node.addEventListener('canplay', once)
      if (typeof node.requestVideoFrameCallback === 'function') node.requestVideoFrameCallback(once)
      node.addEventListener('timeupdate', function () {
        if (node.currentTime > 0) once()
      })
    }

    function mountImage() {
      var img = doc.createElement('img')
      img.className = 'dsa-img'
      img.alt = ''
      img.decoding = 'async'
      var retries = 0
      img.addEventListener('error', function () {
        if (retries >= 1) {
          mediaGone('image-error')
          return
        }
        retries += 1
        try {
          img.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'retry=' + retries
        } catch (error) {
          mediaGone('image-error-throw')
        }
      })
      media.appendChild(img)
      whenFramePresents(img, markMediaOk)
      img.src = src
      state.mediaNode = img
    }

    function mountVideo() {
      var video = doc.createElement('video')
      video.className = 'dsa-video'
      video.playsInline = true
      video.setAttribute('playsinline', '')
      video.autoplay = false
      video.preload = 'auto'
      video.loop = true // 覆盖"等待"而不是"播完"：启动可能比片子长。
      video.volume = volume
      video.muted = !wantSound
      video.defaultMuted = !wantSound
      if (!wantSound) video.setAttribute('muted', '')
      video.setAttribute('aria-hidden', 'true')
      state.mediaNode = video

      // 一帧都出不来的看门狗。
      var noFrame = timer(function () {
        mediaGone('no-frame')
      }, noFrameMs)

      // duration 未知（部分 WebM）时 never 'ended'——loop=true 下本来就靠 ready 判定，
      // 这里只兜"元数据永远不齐"的情况。
      var endless = null
      video.addEventListener('loadedmetadata', function () {
        if (isFinite(video.duration)) return
        endless = timer(function () {
          mediaGone('endless-duration')
        }, endlessMs)
      })

      // 素材出错先重试一次：宿主刚启动时素材路由偶尔应答不上。
      var errorRetries = 0
      video.addEventListener('error', function () {
        global.clearTimeout(noFrame)
        if (endless !== null) global.clearTimeout(endless)
        var code = video.error ? video.error.code : 0
        if (errorRetries >= 1) {
          mediaGone('video-error:' + code)
          return
        }
        errorRetries += 1
        try {
          video.src = src
          var again = video.play()
          if (again && typeof again.catch === 'function') again.catch(function () {})
        } catch (error) {
          mediaGone('video-error-retry-throw')
        }
        noFrame = timer(function () {
          mediaGone('no-frame-after-retry')
        }, noFrameMs)
      })

      whenFramePresents(video, function () {
        global.clearTimeout(noFrame)
        markMediaOk()
      })

      media.appendChild(video)
      video.src = src

      /**
       * 起播：**先试带声音**（桌面 Electron 默认允许），被拒才退回静音并亮出声音开关。
       * 未静音的 play() 也可能既不 resolve 也不 reject —— 给一个 1.2 秒窗口兜底。
       */
      var fallbackToMuted = function (reason) {
        state.silenced = true
        try {
          video.muted = true
          video.setAttribute('muted', '')
        } catch (error) {
          /* 尽力而为 */
        }
        soundButton.setAttribute('data-visible', '1')
        setHint(COPY.muted)
        var retry = video.play()
        if (retry && typeof retry.catch === 'function') {
          retry.catch(function () {
            mediaGone('muted-play-refused')
          })
        }
      }

      if (!wantSound) {
        var mutedPlay = video.play()
        if (mutedPlay && typeof mutedPlay.catch === 'function') {
          mutedPlay.catch(function () {
            mediaGone('muted-play-refused')
          })
        }
      } else {
        var soundWindow = timer(function () {
          fallbackToMuted('timeout')
        }, 1200)
        var settle = function (ok) {
          global.clearTimeout(soundWindow)
          if (!ok) fallbackToMuted('refused')
        }
        var started
        try {
          started = video.play()
        } catch (error) {
          started = undefined
        }
        if (started && typeof started.then === 'function') {
          started.then(
            function () {
              settle(true)
            },
            function () {
              settle(false)
            },
          )
        } else if (started === undefined) {
          settle(false)
        } else {
          settle(true)
        }
      }
    }

    // ─────────────────────────── 交互 ───────────────────────────

    soundButton.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      if (state.leaving || state.mediaNode === null) return
      var node = state.mediaNode
      if (node.tagName !== 'VIDEO') return
      try {
        node.muted = false
        node.volume = volume
      } catch (error) {
        return
      }
      var played = node.play()
      var settle = function (ok) {
        if (!ok) {
          setHint(COPY.soundRefused)
          soundButton.setAttribute('data-visible', '1')
          return
        }
        setHint(COPY.soundOn)
        soundButton.setAttribute('data-visible', '0')
      }
      if (played && typeof played.then === 'function') {
        played.then(
          function () {
            settle(true)
          },
          function () {
            settle(false)
          },
        )
      } else settle(true)
    })
    soundButton.addEventListener('keydown', function (event) {
      if (event && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        soundButton.click()
      }
    })

    // 任何点击/按键都跳过（声音开关已用 stopPropagation 独立出去）。
    root.addEventListener('click', function () {
      enter(skipFadeMs, 'click')
    })
    function onDocKey(event) {
      if (!event) return
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
        enter(skipFadeMs, 'key:' + event.key)
      }
    }
    doc.addEventListener('keydown', onDocKey)

    // ─────────────────────────── 启动 ───────────────────────────

    function begin() {
      try {
        doc.body.appendChild(root)
      } catch (error) {
        // 挂不上覆盖层 → 遮罩必须摘掉，否则整页被我们自己盖成一块纯色。
        setCover(false)
        return
      }
      // 真覆盖层已经挂上（:has 命中后铺满屏幕），首帧遮罩可以退场了。
      setCover(false)
      // 原生窗口控件浮层画在网页内容之上（动画盖不住它）——按住取色融入动画，
      // 退场时还原（机制详见 holdTitlebar/restoreTitlebar 注释）。
      // 素材模式从**挂载**起就按住：覆盖层现在一挂上就不透明，标题栏若还用它自己的
      // 侧栏色，会在动画顶部显出一条不搭的色带。
      if (mode !== 'css') holdTitlebar()
      try {
        watchAppReady()
        watchFailure()
        watchProgress()
        watchHold()
        if (mode === 'video') mountVideo()
        else if (mode === 'image') mountImage()
      } catch (error) {
        try {
          if (global.console && global.console.error) global.console.error('[startup-animation] boot', error)
        } catch (ignored) {
          /* 连日志都失败就算了 */
        }
        // 挂载骨架失败 → 走统一的"素材不可用"路径：透明、就绪判定继续、绝不整块撤掉。
        mediaGone('mount-throw')
        try {
          watchAppReady()
        } catch (ignored2) {
          // 最后兜底：30 秒后无论如何让开。
          timer(function () {
            enter(fadeMs, 'fatal-fallback')
          }, 30000)
        }
      }
    }

    if (doc.body) begin()
    else doc.addEventListener('DOMContentLoaded', begin, { once: true })
  }

  // 每次页面加载：先取实时配置（通常几毫秒，上限 500ms），再决定挂不挂 —— 配置改动刷新即生效。
  resolveConfig(function (cfg) {
    try {
      beginWithConfig(cfg)
    } catch (error) {
      try {
        if (global.console && global.console.error)
          global.console.error("[startup-animation] fatal", error)
      } catch (ignored) {
        /* 连日志都失败就算了 */
      }
    }
  })
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : typeof self !== 'undefined'
        ? self
        : this,
)
