'use strict'
/**
 * 桌面宠物窗的渲染端：只演，不管窗口。
 *
 * 和浏览器浮层（client.js 的 createPetInstance）是**同一套观感**，但职责更小：
 *   · 窗口位置由主进程管（它要跟系统光标），这里只管"演哪一段"；
 *   · 右键菜单**由主进程画原生菜单**（透明小窗里画 HTML 菜单会被窗口边界裁掉，
 *     女仆 109 段动作的二级菜单根本放不下）；这里负责两件事：把动作表上报给主进程
 *     （分类/动作名只有这份配置里有），以及把菜单点选结果落到演出上。
 *
 * 数据来自宿主已有的 `/manage`（与浏览器浮层同一个接口），素材走 `/asset`；
 * 两者都经 `dsa-pet://` 协议转发，因为本页面是 file:// 源，直连会被 CORS 挡掉。
 *
 * @module runtime/pet-desktop/renderer
 */
;(() => {
  /** 待机多久演一个小动作（与浏览器浮层一致：时间固定、动作随机）。 */
  const IDLE_MS = 15000
  /** 动作演完到回待机的停顿：直接跳回会在最后一帧闪一下。 */
  const RETURN_MS = 550

  const params = new URLSearchParams(location.search)
  const PACK_ID = params.get('pack') || ''
  const ROUTE = params.get('route') || '/dsh-startup-animation'
  const BASE = `dsa-pet://local${ROUTE}`

  const videos = [document.getElementById('a'), document.getElementById('b')]
  const stage = document.getElementById('stage')
  const hit = document.getElementById('hit')

  /** 当前宠物包（宿主给的完整结构）。 */
  let pack = null
  let active = 0
  let currentId = ''
  /** 'idle' | 'action' | 'drag' */
  let mode = 'idle'
  let idleTimer = 0
  let returnTimer = 0
  let lastRandomId = ''
  let alive = true

  const assetUrl = (file) => `${BASE}/asset?path=${encodeURIComponent(file)}`

  /** 音效播放次数：验收用（能证明"点了确实响了"）。 */
  let clickSounds = 0

  /**
   * 回报演出状态（只用于开发期验收，正常运行时主进程丢掉它）。
   *
   * 必须定义在 `show()` 之前：`show` 每次切段都会调它，而 `show` 是个箭头函数，
   * 首次调用经由 load → startIdle 发生在模块求值之后 —— 但把定义放前面，
   * 就不必依赖那个时序（TDZ 报错会被 try/catch 静默吞掉，很难查）。
   */
  const report = () => {
    if (window.dsaPet === undefined) return
    window.dsaPet.report({ mode, id: currentId, clickSounds })
  }

  const clipById = (id) => (pack === null ? null : (pack.clips.find((clip) => clip.id === id) ?? null))

  const idleId = () => {
    if (pack === null) return ''
    if (clipById(pack.roles.idle) !== null) return pack.roles.idle
    return pack.clips.length > 0 ? pack.clips[0].id : ''
  }

  const clipsOf = (ids) => (Array.isArray(ids) ? ids.map(clipById).filter((clip) => clip !== null) : [])

  /** 参与随机待机的动作：事件类（余额/工作/睡觉…）不参与，随机出现会很怪。 */
  const ambientClips = () => {
    if (pack === null) return []
    const eventIds = ['balance', 'whisper', 'work', 'sleep', 'other']
    const wanted =
      Array.isArray(pack.ambient) && pack.ambient.length > 0
        ? pack.ambient
        : pack.categories.map((category) => category.id).filter((id) => !eventIds.includes(id))
    const clips = pack.categories
      .filter((category) => wanted.includes(category.id))
      .flatMap((category) => clipsOf(category.clips))
    if (clips.length > 0) return clips
    return pack.clips.filter((clip) => clip.id !== idleId() && clip.id !== pack.roles.drag)
  }

  const randomClip = (clips) => {
    if (clips.length === 0) return null
    const pool = clips.length > 1 ? clips.filter((clip) => clip.id !== lastRandomId) : clips
    const picked = pool[Math.floor(Math.random() * pool.length)] ?? clips[0]
    lastRandomId = picked.id
    return picked
  }

  const clearIdle = () => {
    if (idleTimer !== 0) {
      clearTimeout(idleTimer)
      idleTimer = 0
    }
  }
  const clearReturn = () => {
    if (returnTimer !== 0) {
      clearTimeout(returnTimer)
      returnTimer = 0
    }
  }

  /** 演一段：两个槽位交替，切换只改 opacity。 */
  const show = (id, loop) => {
    const clip = clipById(id)
    if (clip === null) return
    const prev = active
    active = 1 - prev
    const incoming = videos[active]
    const outgoing = videos[prev]
    const url = assetUrl(clip.file)
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
    setTimeout(() => {
      if (videos[active] !== outgoing) {
        try {
          outgoing.pause()
        } catch {
          /* 已停 */
        }
      }
    }, 200)
    currentId = id
    report()
  }

  const scheduleIdle = () => {
    clearIdle()
    if (pack === null) return
    idleTimer = setTimeout(() => {
      idleTimer = 0
      if (!alive || mode !== 'idle' || pack === null) return
      const clip = randomClip(ambientClips())
      if (clip !== null) playAction(clip.id)
      else scheduleIdle()
    }, IDLE_MS)
  }

  const startIdle = () => {
    if (pack === null) return
    clearReturn()
    clearIdle()
    mode = 'idle'
    const id = idleId()
    if (id === '') return
    show(id, true)
    scheduleIdle()
  }

  const playAction = (id) => {
    if (pack === null || clipById(id) === null) {
      startIdle()
      return
    }
    clearIdle()
    clearReturn()
    mode = 'action'
    show(id, false)
  }

  /** 一次性动作播完 → 停顿一下回待机。 */
  const onEnded = (video) => {
    if (mode !== 'action' || videos[active] !== video) return
    clearReturn()
    returnTimer = setTimeout(() => {
      returnTimer = 0
      if (alive && mode === 'action') startIdle()
    }, RETURN_MS)
  }

  for (const video of videos) video.addEventListener('ended', () => onEnded(video))

  let clickAudio = null

  /**
   * 点击音效：与浏览器浮层同一份素材（`pet.json` 的包内音效，没有就用共享的 click.wav）。
   *
   * 复用一个 `Audio` 元素：连点不会叠成一片。播不了（没有设备、被策略拦）就安静跳过 ——
   * 动作照演，不该为了听个响把点击整条链路搞挂。
   */
  const playClickSound = () => {
    if (typeof Audio !== 'function' || pack === null) return
    const file = typeof pack.clickSound === 'string' ? pack.clickSound : ''
    if (file === '') return
    try {
      if (clickAudio === null) {
        clickAudio = new Audio(assetUrl(file))
        clickAudio.volume = 1
      }
      clickAudio.currentTime = 0
      const played = clickAudio.play()
      if (played && typeof played.catch === 'function') played.catch(() => {})
      clickSounds += 1
    } catch {
      /* 播不了就算了 */
    }
  }

  /** 左键点一下：随机一段回应动作，同时「咔哒」一声。 */
  const playClick = () => {
    if (pack === null) return
    playClickSound()
    const clicks = clipsOf(pack.roles.clicks)
    const clip = randomClip(clicks.length > 0 ? clicks : ambientClips())
    if (clip !== null) playAction(clip.id)
  }

  // ── 拖拽 ──
  // 窗口位置由主进程跟着系统光标挪；这里只负责"告诉主进程开始/结束"和播拖拽动作。
  // 甩抛/反弹也在主进程（它才是移窗口的那一方），这里只接两个通知：
  //   pet:bump   → 撞到边缘，挤压一下
  //   pet:landed → 停稳了，回待机
  let pressed = false

  /** 撞墙挤压：和浏览器浮层同一套（压扁 0.88x1.12，140ms 后恢复）。 */
  let squashTimer = 0
  const squash = () => {
    if (stage === null) return
    stage.dataset.squash = '1'
    if (squashTimer !== 0) clearTimeout(squashTimer)
    squashTimer = setTimeout(() => {
      squashTimer = 0
      if (stage !== null) delete stage.dataset.squash
    }, 140)
  }

  hit.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pack === null) return
    pressed = true
    hit.dataset.drag = '1'
    clearIdle()
    clearReturn()
    if (clipById(pack.roles.drag) !== null) {
      mode = 'drag'
      show(pack.roles.drag, true)
    }
    try {
      hit.setPointerCapture(event.pointerId)
    } catch {
      /* 某些环境下非活动指针会抛，拖拽仍可用 */
    }
    if (window.dsaPet !== undefined) window.dsaPet.dragStart()
    event.preventDefault()
  })

  const release = (event) => {
    if (!pressed) return
    pressed = false
    hit.dataset.drag = '0'
    if (stage !== null) stage.style.transform = ''
    try {
      hit.releasePointerCapture(event.pointerId)
    } catch {
      /* 已经释放 */
    }
    // 拖拽/点击的判定归主进程：拖了就飞，没拖就回一句 pet:tap 让它演回应。
    // **这里不要先回待机**：那样点击时会先闪回待机、再被 playClick 顶掉，
    // 看起来就是动作"顿一下才出来"。回待机由 pet:landed / 动作演完负责。
    if (window.dsaPet !== undefined) window.dsaPet.dragEnd()
  }
  hit.addEventListener('pointerup', release)
  hit.addEventListener('pointercancel', release)

  if (window.dsaPet !== undefined) {
    window.dsaPet.onTap(() => {
      if (pack !== null) playClick()
    })
    window.dsaPet.onBump(() => {
      // 飞行中才有意义：静止时被通知（比如拖动途中刚好压到边）不该抖一下。
      if (mode === 'drag' || mode === 'action' || !pressed) squash()
    })
    window.dsaPet.onLanded(() => {
      if (stage !== null) delete stage.dataset.squash
      // **只收拖拽这条线**：飞行结束该回待机，但"回应动作"（mode === 'action'）
      // 得让它自己演完 —— 那条 IPC 是异步的，晚到时正好撞上点击刚触发的动作，
      // 无条件 startIdle() 会把动画切成待机，看起来就是"点了没展开"。
      if (mode === 'drag') startIdle()
    })
    // 原生菜单的点选：归位/隐藏由主进程自己处理，这里只收"演哪段"。
    if (typeof window.dsaPet.onMenuAction === 'function') {
      window.dsaPet.onMenuAction((msg) => {
        if (pack === null || msg === null || typeof msg !== 'object') return
        if (msg.type === 'play' && typeof msg.id === 'string') playAction(msg.id)
        else if (msg.type === 'random') {
          const clip = randomClip(ambientClips())
          if (clip !== null) playAction(clip.id)
        }
      })
    }
  }

  /**
   * 把动作表上报给主进程（右键菜单的数据源）。
   *
   * 菜单画在 OS 弹层里（窗口自己放不下几十条动作），但分类与动作名只有这份配置里有 ——
   * 主进程手上只有 id/尺寸/位置。再让它扫一遍素材目录就是第二份数据源，素材一改就漂移。
   */
  const sendMenuData = () => {
    if (window.dsaPet === undefined || typeof window.dsaPet.menuReady !== 'function') return
    if (pack === null) return
    const categories = (Array.isArray(pack.categories) ? pack.categories : [])
      .map((category) => ({
        name: typeof category.name === 'string' ? category.name : category.id,
        clips: (Array.isArray(category.clips) ? category.clips : [])
          .map((id) => clipById(id))
          .filter((clip) => clip !== null)
          .map((clip) => ({ id: clip.id, name: clip.name })),
      }))
      .filter((category) => category.clips.length > 0)
    window.dsaPet.menuReady({ categories })
  }

  /**
   * 取一次配置，建好就开演。失败就什么都不做（桌面上少一只宠物，不该弹错误）。
   *
   * **只在建窗时取一次**：落地、点击、拖动这些高频动作一律不再取数（它们全是本地状态）。
   * 这一步是冷启动唯一的等待点，所以不要往里加东西。
   */
  const load = async () => {
    try {
      const res = await fetch(`${BASE}/manage`, { cache: 'no-store' })
      const payload = await res.json()
      const list = payload && payload.pet && Array.isArray(payload.pet.pets) ? payload.pet.pets : []
      const entry = list.find((item) => item.id === PACK_ID)
      if (entry === undefined) return
      // 总开关关着、或这一只被关掉：不演。窗口是主进程建的，这里再挡一道，
      // 保证"没启用就不显示"在每一层都成立（关掉之后不该还有一帧残留在播）。
      if (payload.pet.enabled !== true || entry.enabled !== true) return
      pack = entry
      sendMenuData()
      startIdle()
    } catch (error) {
      console.error('[dsa-pet-desktop] 配置读取失败：', error)
    }
  }

  void load()
})()
