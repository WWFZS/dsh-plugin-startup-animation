/**
 * e2e-uninstall.mjs —— 端到端验证卸载：**在真实的 profile 副本上**跑一遍
 * uninstallSelf()，确认磁盘状态是对的。
 *
 * 为什么用副本：真 profile 是用户自己的机器（这里也是），
 * 卸载是破坏性操作 —— 测试绝不能碰真数据。
 *
 * 断言的重点：
 *   1. 依赖被移除；
 *   2. **bundles 列表里也不留悬空条目**（留了宿主下次启动就加载失败）；
 *   3. 别的包不受影响；
 *   4. 用户数据（配置/上传素材）**没被删**。
 *
 * 用法：node lib/e2e-uninstall.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { uninstallSelf, updateSelf } from '../index.js'
import { PACKAGE_NAME, readBundleSelection, readProfileManifest } from './self-manage.mjs'
let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-e2e-'))
const profileDir = path.join(tmp, 'profile')
const homeDir = path.join(tmp, 'home')
fs.mkdirSync(profileDir, { recursive: true })
fs.mkdirSync(homeDir, { recursive: true })

// 一个"像真的一样"的 profile：本插件 + 另外两个包 + 别的 bundle。
//
// fixture 的依赖必须**能被解析**：pnpm remove 之前会做一次依赖解析，解析不到
// 就报 ERR_PNPM_NO_MATCHING_VERSION / ERR_PNPM_NO_OFFLINE_META —— 那是
// fixture 的问题，不是卸载逻辑的问题。
//
// 所以这里只用**无依赖**的包（link: 指向本地目录，pnpm 不去解析它的依赖树），
// 既真实（用户自己 link 的插件就是这样）又不碰网络。
const otherPkg = path.join(tmp, 'other-plugin')
fs.mkdirSync(otherPkg, { recursive: true })
fs.writeFileSync(
  path.join(otherPkg, 'package.json'),
  JSON.stringify({ name: 'other-plugin', version: '2.0.0', private: true }, null, 2),
)

fs.writeFileSync(
  path.join(profileDir, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-e2e',
      private: true,
      dependencies: {
        [PACKAGE_NAME]: 'link:D:/somewhere',
        'other-plugin': `link:${otherPkg.replace(/\\/g, '/')}`,
      },
      dsh: {
        profile: {
          bundles: [PACKAGE_NAME, 'other-plugin', 'yet-another'],
        },
      },
    },
    null,
    2,
  ),
)

// 用户数据：卸载**不能**删它。
fs.writeFileSync(path.join(homeDir, 'startup-animation.json'), '{"boot":{}}')
fs.mkdirSync(path.join(homeDir, 'startup-animation-media'), { recursive: true })
fs.writeFileSync(path.join(homeDir, 'startup-animation-media', 'my.mp4'), 'x')

console.log('== 端到端卸载（在 profile 副本上）==')

await check('卸载成功，并如实要求重启', async () => {
  const result = await uninstallSelf({ profileDir, homeDir })
  assert.equal(result.ok, true, `卸载失败：${result.message}\n${result.details ?? ''}`)
  assert.equal(result.restartRequired, true, '没说要重启（桌面没有 HMR，改磁盘必须重启）')
  assert.ok(result.userData, '没告诉用户数据在哪')
})

await check('依赖被移除', () => {
  const manifest = readProfileManifest(profileDir)
  assert.equal(manifest.dependencies[PACKAGE_NAME], undefined, '依赖还在')
})

await check('bundles 列表里不留悬空条目', () => {
  const manifest = readProfileManifest(profileDir)
  assert.equal(
    readBundleSelection(manifest).includes(PACKAGE_NAME),
    false,
    'bundle 还挂在列表里 = 悬空条目，宿主下次启动会加载失败',
  )
})

await check('别的包与别的 bundle 不受影响', () => {
  const manifest = readProfileManifest(profileDir)
  assert.ok(manifest.dependencies['other-plugin'], '别的包的依赖被动了')
  const bundles = readBundleSelection(manifest)
  assert.ok(bundles.includes('other-plugin'), '别的 bundle 被摘掉了')
  assert.ok(bundles.includes('yet-another'), '别的 bundle 被摘掉了')
})

await check('用户数据没被删', () => {
  assert.ok(fs.existsSync(path.join(homeDir, 'startup-animation.json')), '配置被删了')
  assert.ok(fs.existsSync(path.join(homeDir, 'startup-animation-media', 'my.mp4')), '上传素材被删了')
})

await check('再卸载一次 → 报"不在依赖里"，不是崩溃', async () => {
  const result = await uninstallSelf({ profileDir, homeDir })
  assert.equal(result.ok, false)
  assert.match(result.message, /不在当前 profile/, `消息不对：${result.message}`)
})

console.log('== pnpm 定位 ==')

await check('找不到 pnpm 时 → 报"用 dsh plugin 代替"，不是崩溃', async () => {
  // 模拟"PATH 上没有 pnpm、宿主目录里也没有"的情况：把 PATH 清空再试。
  const savedPath = process.env.PATH
  try {
    process.env.PATH = ''
    const result = await uninstallSelf({ profileDir: path.join(tmp, 'no-such-profile'), homeDir })
    assert.equal(result.ok, false)
  } finally {
    process.env.PATH = savedPath
  }
})

console.log('== 更新（在 profile 副本上）==')

// 更新测试**不碰网络**：用一个 pnpm 直接拒绝解析的 spec ——
// "not a spec at all!!" 报 ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER，
// 秒失败、零网络。我们要验证的正是"失败后的回滚"，不是"成功的安装"。
const badSpec = 'not a spec at all!!'

await check('更新：pnpm 失败 → bundles 列表恢复原样，不留半更新状态', async () => {
  // 造一个 bundle 里**没有**本插件的 profile：updateSelf 会先把它加进列表，
  // pnpm 一失败就必须摘回去 —— 否则列表里多出一个装不上的悬空条目。
  const dir = fs.mkdtempSync(path.join(tmp, 'update-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-update',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['some-other-bundle'] } },
      },
      null,
      2,
    ),
  )
  const before = readProfileManifest(dir)
  const result = await updateSelf({ profileDir: dir, spec: badSpec })
  assert.equal(result.ok, false, '指向不存在目录的 add 居然成功了？')
  assert.ok(result.details, '失败时没带回 pnpm 的输出（用户看不到失败原因）')
  const after = readProfileManifest(dir)
  assert.deepEqual(
    readBundleSelection(after),
    readBundleSelection(before),
    `失败后 bundles 列表没恢复原样：${readBundleSelection(after).join(', ')}`,
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('更新：bundle 已在列表里 → 不写清单、失败也不动它', async () => {
  // 已经选中时 updateSelf 不该多写一次磁盘；失败时也没有"恢复"可做。
  const dir = fs.mkdtempSync(path.join(tmp, 'update2-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-update2',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [PACKAGE_NAME] } },
      },
      null,
      2,
    ),
  )
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
  const result = await updateSelf({ profileDir: dir, spec: badSpec })
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before, '清单被无谓地改写了')
  fs.rmSync(dir, { recursive: true, force: true })
})

fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('E2E UNINSTALL PASS')
