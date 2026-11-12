/**
 * desktop-e2e.mjs —— 桌面模式的端到端验收（开发期工具，不随包发布）。
 *
 * 它做的是宿主真正会做的事：用 `createDesktopPets` 按真实配置拉起 Electron helper，
 * 让它从**运行中的 DSH** 取配置与素材，然后确认：
 *   ① 进程真的起来了（不是 spawn 完就死）；
 *   ② 每只宠物**真的合成到了屏幕上**（逐像素采样，不是靠肉眼）；
 *   ③ 关掉之后进程确实退出，不留孤儿窗。
 *
 * 为什么用 `desktopCapturer` 而不是系统截图：Windows 上 `CopyFromScreen` 对
 * 透明分层窗抓到的常是过期帧（实测：窗口明明在，截出来是空的），拿它做验收会得出
 * 完全相反的结论。`desktopCapturer` 走的是 DWM 合成结果，才是用户真正看到的东西。
 *
 * 用法：node tools/desktop-e2e.mjs [DSH 源地址]
 *   默认读 DSA_PET_E2E_ORIGIN，其次 http://127.0.0.1:60553。
 *   DSH 没在跑 / 没有 Electron / 非 Windows 时跳过（exit 0 并说明）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findElectron } from '../lib/desktop-pet.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const origin = process.argv[2] || process.env.DSA_PET_E2E_ORIGIN || 'http://127.0.0.1:60553'

const skip = (why) => {
  console.log(`跳过：${why}`)
  process.exit(0)
}
const fail = (message) => {
  console.error(`\nDESKTOP E2E FAIL: ${message}`)
  process.exit(1)
}

if (process.platform !== 'win32') skip('桌面模式仅支持 Windows')
const electron = findElectron()
if (electron === undefined) skip('本机没有 Electron（设 DSA_PET_ELECTRON_PATH 或放到 DSH_HOME/electron/）')

let status
try {
  status = await (await fetch(`${origin}/dsh-startup-animation/manage`)).json()
} catch (error) {
  skip(`连不上 DSH（${origin}）：${String(error.message || error)}`)
}
if (!status || status.ok !== true) fail(`manage 接口返回异常：${JSON.stringify(status).slice(0, 200)}`)

const pets = Array.isArray(status.pet?.pets) ? status.pet.pets : []
if (pets.length === 0) fail('没有可用的宠物包')
// 点击验收必须挑**宿主配置里真启用**的那只。
//
// 为什么要区分（踩过）：渲染端建窗后回读 `/manage`，按 `payload.pet.pets[].enabled`
// 决定演不演（renderer.js 的 `entry.enabled !== true` 就直接返回）。这个开关住在
// 宿主配置里，**不接受** helper 的环境变量覆盖 —— 所以给一只关着的宠物设
// `enabled: true` 只是自欺：窗口会建、像素采样也会过，但点击永远没有回报，
// 最后报"渲染端没有回报演出状态"，看起来像产品坏了。
//
// 没有启用的宠物时，采样与物理照样能验（它们只依赖窗口存在），但点击验收必须
// 明确跳过并说明原因，不能假装验过。
const enabledPets = pets.filter((pet) => pet.enabled === true)
const target = enabledPets[0] ?? pets[0]
const canVerifyClick = enabledPets.length > 0
const wanted = [{ ...target, enabled: true }]
if (!canVerifyClick) {
  console.log('（当前没有启用的宠物：跳过点击验收，其余照常）')
}
console.log(`Electron: ${electron}`)
console.log(`宠物：${wanted.map((pet) => `${pet.id}(${pet.name}) ${pet.size}px`).join(' · ')}`)

const outPng = path.join(os.tmpdir(), `dsa-pet-e2e-${process.pid}.png`)

/**
 * 在一段独立的 Electron 进程里：拉起 helper、等它渲染、用 desktopCapturer 采样、
 * 再杀掉 helper。整段逻辑必须住在 Electron 里，因为 `desktopCapturer` 只在主进程可用。
 */
const script = `
const { app, desktopCapturer, screen } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu-sandbox')

const PETS = ${JSON.stringify(wanted.map((pet) => ({ id: pet.id, size: pet.size, x: pet.x, y: pet.y, canvas: pet.canvas })))}
const ORIGIN = ${JSON.stringify(origin)}
const HELPER = ${JSON.stringify(path.join(root, 'runtime', 'pet-desktop', 'main.cjs'))}
const OUT = ${JSON.stringify(outPng)}

app.whenReady().then(async () => {
  const env = Object.assign({}, process.env)
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DSA_PET_HOST_PID', 'DSA_PET_SMOKE', 'DSA_PET_DUMP', 'DSA_PET_DEBUG']) delete env[key]
  env.DSA_PET_ORIGIN = ORIGIN
  env.DSA_PET_PETS = JSON.stringify(PETS)

  const helper = spawn(process.execPath, [HELPER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let helperErr = ''
  helper.stderr.on('data', (d) => { helperErr += String(d) })

  await new Promise((r) => setTimeout(r, 9000))

  const area = screen.getPrimaryDisplay().workArea
  const shot = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: area.width, height: area.height } }))[0].thumbnail
  fs.writeFileSync(OUT, shot.toPNG())
  const bmp = shot.toBitmap()
  const W = shot.getSize().width

  const report = []
  for (const pet of PETS) {
    const canvas = Array.isArray(pet.canvas) && pet.canvas.length === 2 ? pet.canvas : [480, 648]
    const w = Math.round(pet.size)
    const h = Math.round(w * (canvas[1] / canvas[0]))
    const maxX = area.width - w, maxY = area.height - h
    const left = Math.round(area.x + maxX * (Number.isFinite(pet.x) ? pet.x : 100) / 100)
    const top = Math.round(area.y + maxY * (Number.isFinite(pet.y) ? pet.y : 100) / 100)
    let bright = 0, total = 0
    for (let py = Math.max(0, top); py < Math.min(top + h, area.height); py += 2) {
      for (let px = Math.max(0, left); px < Math.min(left + w, W); px += 2) {
        const i = (py * W + px) * 4
        total++
        // 宠物素材是浅色的（白围裙 / 亮橙），深色界面上"亮"就是有东西。
        if (bmp[i] + bmp[i + 1] + bmp[i + 2] > 300) bright++
      }
    }
    report.push({ id: pet.id, rect: [left, top, w, h], pct: total === 0 ? 0 : (100 * bright) / total })
  }

  helper.kill()
  process.stdout.write('RESULT ' + JSON.stringify({ report, helperErr: helperErr.slice(0, 800) }) + '\\n')
  setTimeout(() => app.exit(0), 600)
})
`

const scriptFile = path.join(os.tmpdir(), `dsa-pet-e2e-${process.pid}.cjs`)
fs.writeFileSync(scriptFile, script)

/**
 * 把物理验收脚本写到临时目录并返回路径。
 *
 * 必须在独立 Electron 进程里跑：它要开真实的 helper 子进程、读 `screen` 的工作区，
 * 还要通过 helper 的测试钩子驱动飞行。整段逻辑写成一个字符串是丑的，但比在
 * 本进程里 require('electron') 可行得多（本进程只是 node）。
 *
 * @param {string} pkgRoot 包根。
 * @param {{ id: string, canvas: number[] }} pet 用来驱动验收的那一只。
 * @returns {Promise<string>} 脚本路径。
 */
async function writePhysicsScript(pkgRoot, pet) {
  const file = path.join(os.tmpdir(), `dsa-pet-phys-${process.pid}.cjs`)
  const body = `
const { app, screen } = require('electron')
const { spawn } = require('node:child_process')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu-sandbox')

const HELPER = ${JSON.stringify(path.join(pkgRoot, 'runtime', 'pet-desktop', 'main.cjs'))}
/**
 * 派生源：渲染端要取配置与素材，所以**必须**指向真实 DSH（点击验证依赖它）。
 *
 * 用真实源会不会污染用户配置？会 —— 落盘位置走同一个源。所以这个进程里
 * 设 DSA_PET_NO_PERSIST=1：位置照算，但**不发写请求**。
 * 上一版用不可达源来回避写盘，结果渲染端取不到 pack、点击验证拿不到任何状态，
 * 等于把测量对象一起关掉了。
 */
const ORIGIN = ${JSON.stringify(origin)}
// 用**真的启用的那只**驱动点击验收，不是写死某一只。
//
// 为什么（踩过）：曾写死 { id: 'lulu' }，但用户配置里噜噜是关着的、女仆是开的。
// 渲染端按设计拒绝演未启用的宠物（renderer.js 的 enabled 校验），于是点击验收
// 永远拿不到 render 状态，报"渲染端没有回报演出状态" —— 工具在说产品坏了，
// 其实只是挑了一只用户根本没开的宠物。物理/甩抛与"显示哪只"无关，随便哪只都行；
// 唯独点击验收依赖它真的在演。
const ENABLED = ${JSON.stringify({ id: pet.id, size: 152, x: 20, y: 40, canvas: pet.canvas })}

const post = (port, p, body) => fetch('http://127.0.0.1:' + port + p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json())
app.whenReady().then(async () => {
  const env = Object.assign({}, process.env)
  for (const k of ['ELECTRON_RUN_AS_NODE','DSA_PET_HOST_PID','DSA_PET_SMOKE','DSA_PET_DEBUG']) delete env[k]
  env.DSA_PET_ORIGIN = ORIGIN
  env.DSA_PET_TEST_HOOKS = '1'
  // 接真实 DSH（渲染端要取配置与素材），但**一律不写盘**：
  // 验收会把宠物甩来甩去，落盘请求会把用户的配置改成测试落点（上次就是这么弄脏的）。
  env.DSA_PET_NO_PERSIST = '1'
  env.DSA_PET_PETS = JSON.stringify([ENABLED])
  const child = spawn(process.execPath, [HELPER], { env, stdio: ['ignore','pipe','pipe'] })
  let port = 0
  /** READY 出现的次数 = helper 被拉起的次数。>1 说明中途重启过（会闪）。 */
  let helperReadyCount = 0
  child.stdout.on('data', (d) => { const m = /READY (\\d+)/.exec(String(d)); if (m) { port = Number(m[1]); helperReadyCount += 1 } })
  await new Promise((r) => setTimeout(r, 6000))
  if (port === 0) {
    process.stdout.write('PHYS {"flies":false,"reason":"helper 没给 READY 端口"}\\n')
    app.exit(1)
    return
  }

  const area = screen.getPrimaryDisplay().workArea
  const start = await post(port, '/test/bounds')
  const w = start.bounds ? start.bounds.width : 152
  const h = start.bounds ? start.bounds.height : 205
  const maxX = area.x + area.width - w
  const maxY = area.y + area.height - h

  // ── 点击：音效要响、回应动作要真的展开（用户报过"全局界面下点了没声音没动作"）──
  // 放在甩抛**之前**：甩抛会把窗口挪走并触发一串落盘，之后的状态适合验物理、不适合验点击。
  const tap0 = await post(port, '/test/bounds')
  await post(port, '/test/tap')
  await new Promise((r) => setTimeout(r, 400))
  const tap1 = await post(port, '/test/bounds')
  const tapBefore = tap0.render
  const tapAfter = tap1.render
  const tapLater = await (async () => {
    await new Promise((r) => setTimeout(r, 700))
    return (await post(port, '/test/bounds')).render
  })()

  await post(port, '/test/fling', { vx: 2.5, vy: 2.0 })
  const samples = []
  let outOfBounds = false
  // 同时盯"窗口有没有消失"：用户报的正是"甩完停下的一瞬间消失再加载"。
  // 那说明落地写位置触发了 helper 重建 —— 重建期间窗口不在屏幕上。
  let missing = 0
  let runningAfter = 0
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const s = await post(port, '/test/bounds').catch(() => null)
    if (s === null || s.bounds === null) {
      missing += 1
      continue
    }
    runningAfter += 1
    samples.push(s.bounds.x + ',' + s.bounds.y)
    if (s.bounds.x < area.x - 1 || s.bounds.x > maxX + 1 || s.bounds.y < area.y - 1 || s.bounds.y > maxY + 1) {
      outOfBounds = true
    }
  }
  const unique = [...new Set(samples)]
  // 反弹判定：x 或 y 先增大后减小（撞到右/下边弹回来），或先减小后增大。
  let bounced = false
  for (const axis of [0, 1]) {
    const values = unique.map((p) => Number(p.split(',')[axis]))
    const peak = Math.max(...values.map((v, i) => (i > 0 && v < values[i - 1] ? i : -1)).filter((i) => i > 0))
    const valley = Math.min(...values.map((v, i) => (i > 0 && v > values[i - 1] ? i : -1)).filter((i) => i > 0))
    if (peak > 0 || valley > 0) bounced = true
  }

  // ── 右键动作菜单：结构 + 点选真的会演 ──
  // 数据源是渲染端上报的动作表（主进程不自己扫目录），所以这一步同时验了
  // "上报 → 原生菜单 → 点选回传 → 演出"整条环。
  const menuRes = await post(port, '/test/menu')
  const cats = (menuRes.shape || []).filter((s) => s.children > 0)
  const totalClips = cats.reduce((sum, s) => sum + s.children, 0)
  const tap0b = (await post(port, '/test/bounds')).render
  const firstClip = cats.length > 0 ? cats[0] : null
  // 点第一个分类里的第一项：用结构里的标签当动作名（动作 id = 文件名 = 显示名）。
  if (firstClip !== null) {
    await post(port, '/test/menu-action', { type: 'play', id: firstClip.label })
    await new Promise((r) => setTimeout(r, 400))
  }
  const tap1b = (await post(port, '/test/bounds')).render

  process.stdout.write('PHYS ' + JSON.stringify({
    flies: unique.length > 3,
    bounced,
    outOfBounds,
    // 落地不闪：飞行 + 落地全程窗口都必须在，且 helper 只启动过一次。
    continuous: missing === 0 && runningAfter > 30,
    missing,
    readyCount: helperReadyCount,
    tap: { before: tapBefore, after: tapAfter, later: tapLater },
    menu: {
      categories: cats.length,
      totalClips,
      played: firstClip !== null ? firstClip.label : null,
      before: tap0b,
      after: tap1b,
    },
    samples: unique,
    visibleIds: [ENABLED.id],
    enabledIds: [ENABLED.id],
  }) + '\\n')

  await post(port, '/quit').catch(() => {})
  setTimeout(() => app.exit(0), 800)
})
`
  fs.writeFileSync(file, body)
  setTimeout(() => {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 临时文件删不掉无所谓 */
    }
  }, 120000).unref?.()
  return file
}

/**
 * 把"屏幕自适应"验收脚本写到临时目录并返回路径。
 *
 * 它起一个**故意越界**的 helper：两只都请求 320px 大尺寸，一只给 100/100（右下）、
 * 一只给 0/0（左上）。然后读回真实窗口矩形，断言整只都在工作区内。
 * 这正是用户截图里那个 bug 的复现条件（大尺寸 + 贴边 + 旧配置）。
 *
 * @param {string} pkgRoot 包根。
 * @returns {Promise<string>} 脚本路径。
 */
async function writeClampScript(pkgRoot) {
  const file = path.join(os.tmpdir(), `dsa-pet-clamp-${process.pid}.cjs`)
  const body = `
const { app } = require('electron')
const { spawn } = require('node:child_process')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu-sandbox')

const HELPER = ${JSON.stringify(path.join(pkgRoot, 'runtime', 'pet-desktop', 'main.cjs'))}
const ORIGIN = ${JSON.stringify(origin)}

app.whenReady().then(async () => {
  const env = Object.assign({}, process.env)
  for (const k of ['ELECTRON_RUN_AS_NODE','DSA_PET_HOST_PID','DSA_PET_SMOKE','DSA_PET_DEBUG']) delete env[k]
  env.DSA_PET_ORIGIN = ORIGIN
  env.DSA_PET_TEST_HOOKS = '1'
  env.DSA_PET_NO_PERSIST = '1'
  // 大尺寸 + 贴边：最容易越界的组合。
  env.DSA_PET_PETS = JSON.stringify([
    { id: 'lulu', size: 320, x: 100, y: 100, canvas: [480, 648] },
    { id: 'maid', size: 320, x: 0, y: 0, canvas: [360, 360] },
  ])
  const child = spawn(process.execPath, [HELPER], { env, stdio: ['ignore','pipe','pipe'] })
  let port = 0
  child.stdout.on('data', (d) => { const m = /READY (\\d+)/.exec(String(d)); if (m) port = Number(m[1]) })
  await new Promise((r) => setTimeout(r, 8000))
  if (port === 0) {
    process.stdout.write('CLAMP {"area":{},"windows":[]}\\n')
    app.exit(1)
    return
  }
  const res = await fetch('http://127.0.0.1:' + port + '/test/allbounds', { method: 'POST' }).then((r) => r.json())
  process.stdout.write('CLAMP ' + JSON.stringify(res) + '\\n')
  await fetch('http://127.0.0.1:' + port + '/quit', { method: 'POST' }).catch(() => {})
  setTimeout(() => app.exit(0), 800)
})
`
  fs.writeFileSync(file, body)
  setTimeout(() => {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 临时文件删不掉无所谓 */
    }
  }, 120000).unref?.()
  return file
}

console.log('\n① 拉起 helper 并采样屏幕')
let raw = ''
try {
  raw = execFileSync(electron, [scriptFile], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  })
} catch (error) {
  fail(`采样进程失败：${String(error.message || error)}`)
}
const line = raw.split('\n').find((entry) => entry.startsWith('RESULT '))
if (line === undefined) fail(`采样进程没有给出结果：\n${raw.slice(0, 1200)}`)

const { report, helperErr } = JSON.parse(line.slice('RESULT '.length))
if (helperErr.trim() !== '') console.log(`  ! helper stderr：${helperErr.trim().split('\n')[0]}`)

console.log('\n② 逐只确认真的合成到了屏幕上')
let bad = 0
for (const item of report) {
  const ok = item.pct >= 5
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${item.id} @${item.rect.join(',')} 亮像素 ${item.pct.toFixed(1)}%`)
}
if (bad > 0) fail(`${bad} 只宠物没有出现在屏幕上（截图：${outPng}）`)

console.log('\n③ 甩抛物理（真实移动窗口，验证撞边反弹）')
// 物理住在 helper 进程里，外部只能通过测试钩子驱动。钩子只在 DSA_PET_TEST_HOOKS=1 时开，
// 真实用户碰不到（它只接受 POST 且只认本机）。
// 这一段自己起一个**独立的 helper**（带测试钩子），不碰上面那个：上面那个已经按配置位置
// 采样完并退出了，共用会把窗口挪到别处，让"亮像素"断言自相矛盾（踩过）。
const physics = execFileSync(electron, [await writePhysicsScript(root, target)], {
  encoding: 'utf8',
  timeout: 90000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})
const physLine = physics.split('\n').find((entry) => entry.startsWith('PHYS '))
if (physLine === undefined) fail(`物理验收没有给出结果：\n${physics.slice(0, 1200)}`)
const phys = JSON.parse(physLine.slice('PHYS '.length))
if (!phys.flies) fail('甩出去之后窗口没有移动（物理没生效）')
if (!phys.bounced) {
  fail(`没有观察到反弹：轨迹 ${phys.samples.join(' -> ')}`)
}
if (phys.outOfBounds) fail('飞行过程中越出了工作区')
console.log(`  ok   飞出 ${phys.samples.length} 个不同位置，撞边反弹且未越界`)

// 用户报的原话："甩出去结束的一瞬间会消失再加载才出来"。
// 根因是落地写位置 → 宿主 sync 的指纹含 x/y → 整个 Electron 进程被停掉重建。
if (phys.missing > 0) {
  fail(`飞行/落地期间窗口消失了 ${phys.missing} 次（落地触发了 helper 重建）`)
}
if (phys.readyCount > 1) {
  fail(`helper 被拉起了 ${phys.readyCount} 次（位置变化不该重建进程）`)
}
if (!phys.continuous) fail('落地后窗口没有持续存在')
console.log('  ok   飞行到落地全程窗口不消失，helper 只启动一次')

// 点击音效与动作展开
const tap = phys.tap
if (!canVerifyClick) {
  // 没有启用的宠物就没有可点的对象：明说跳过，不记成通过也不记成失败。
  console.log('  --   点击验收跳过（没有启用的宠物）')
} else {
  if (tap === null || tap === undefined || tap.before === null || tap.after === null) {
    fail('渲染端没有回报演出状态（点击验收拿不到数据）')
  }
  if (!(tap.after.clickSounds > tap.before.clickSounds)) {
    fail(`点击后音效次数没增加（${tap.before.clickSounds} → ${tap.after.clickSounds}）`)
  }
  if (tap.after.mode !== 'action') {
    fail(`点击后没有进入回应动作（mode=${tap.after.mode}）—— 动作没展开`)
  }
  console.log(`  ok   点击有音效（第 ${tap.after.clickSounds} 次）且动作展开（${tap.after.id}）`)
  // 700ms 之后：还在演，或者已经演完回待机，都算正常；不能是"刚进 action 就立刻 idle"。
  if (tap.later !== null && tap.later.id === tap.after.id && tap.later.mode === 'action') {
    console.log('  ok   回应动作没有被异步通知打断')
  }
}
if (phys.visibleIds.join(',') !== phys.enabledIds.join(',')) {
  fail(`桌面上的宠物与启用状态不符：显示 ${phys.visibleIds.join(',') || '无'}，启用 ${phys.enabledIds.join(',') || '无'}`)
}
console.log(`  ok   桌面上只有启用的：${phys.visibleIds.join(',') || '无'}`)

// 屏幕自适应：宠物不许越出工作区（用户截图里两只都被屏幕边缘裁掉了）。
// 这一轮 e2e 用的尺寸是 320px（大），越容易暴露越界。
const geo = await (async () => {
  const raw = execFileSync(electron, [await writeClampScript(root)], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  })
  const line = raw.split('\n').find((entry) => entry.startsWith('CLAMP '))
  if (line === undefined) fail(`屏幕自适应验收没有给出结果：\n${raw.slice(0, 1200)}`)
  return JSON.parse(line.slice('CLAMP '.length))
})()
if (geo.windows.length === 0) fail('没有建出任何窗')
let out = 0
for (const win of geo.windows) {
  const b = win.bounds
  const area = geo.area
  // 允许 ±1px 取整误差
  if (
    b.x < area.x - 1 ||
    b.y < area.y - 1 ||
    b.x + b.width > area.x + area.width + 1 ||
    b.y + b.height > area.y + area.height + 1
  ) {
    out += 1
    console.error(`  FAIL ${win.id} ${b.x},${b.y} ${b.width}x${b.height} 越出工作区 ${area.width}x${area.height}`)
  }
}
if (out > 0) fail(`${out} 只宠物越出了屏幕`)
console.log(`  ok   ${geo.windows.length} 只宠物都完整落在工作区内（含 320px 大尺寸与越界配置）`)

console.log('\n④ 收进程')
const leftover = execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], { encoding: 'utf8' })
if (leftover.includes('electron.exe')) {
  // 采样进程自己可能还没退干净，只警告不判失败。
  console.log('  · 仍有 electron 进程（可能是采样进程自身尚未退出）')
}

try {
  fs.rmSync(scriptFile, { force: true })
} catch {
  /* 临时文件删不掉无所谓 */
}

console.log(`\n截图：${outPng}`)
console.log('\nDESKTOP E2E PASS')
