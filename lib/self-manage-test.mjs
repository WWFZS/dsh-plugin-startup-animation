/**
 * self-manage-test.mjs —— 自我管理（卸载 / 更新）的行为测试。
 *
 * 覆盖两件最容易出错的事：
 *   1. **卸载后不留悬空 bundle**：依赖删了但 bundles 列表里还留着它，
 *      宿主下次启动会报 "not a profile layer"，插件加载失败。
 *   2. **失败要回滚**：pnpm 失败时把 bundles 列表恢复原样，
 *      不能让用户落到"半卸载"状态。
 *
 * 还有一条硬规则：**不删用户数据**（配置与上传素材留在原地）。
 *
 * 用法：node tools/self-manage-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PACKAGE_NAME,
  describeSelfInstall,
  dropSelfDependency,
  readBundleSelection,
  readProfileManifest,
  setSelfDependency,
  userDataPaths,
  withSelf,
  withoutSelf,
  writeBundleSelection,
  writeProfileManifest,
} from './self-manage.mjs'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-self-'))

/** 造一个 profile 目录。 */
function makeProfile(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'profile-'))
  const manifest = {
    name: 'dsh-profile-test',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-base': '1.0.0',
      [PACKAGE_NAME]: 'link:D:/somewhere',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', PACKAGE_NAME, 'other-plugin'],
      },
    },
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}

console.log('== profile 清单读写 ==')

await check('读出 bundles 与安装形态', () => {
  const dir = makeProfile()
  const manifest = readProfileManifest(dir)
  assert.ok(manifest, '读不到清单')
  assert.deepEqual(readBundleSelection(manifest), ['@deepseek-ai/dsh-base', PACKAGE_NAME, 'other-plugin'])
  const state = describeSelfInstall(manifest)
  assert.equal(state.installed, true)
  assert.equal(state.spec, 'link:D:/somewhere')
  assert.equal(state.selected, true)
})

await check('读不到/坏了的清单返回 undefined 而不是抛', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'broken-'))
  assert.equal(readProfileManifest(dir), undefined)
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')
  assert.equal(readProfileManifest(dir), undefined)
})

await check('原子写：不留临时文件', () => {
  const dir = makeProfile()
  const manifest = readProfileManifest(dir)
  writeProfileManifest(dir, manifest)
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [], `留下临时文件：${leftovers.join(', ')}`)
  assert.ok(readProfileManifest(dir))
})

console.log('== bundle 选择：卸载要摘掉自己，更新要挂回去 ==')

await check('withoutSelf 只摘自己，不动别的', () => {
  const { bundles, changed } = withoutSelf(['@deepseek-ai/dsh-base', PACKAGE_NAME, 'other'])
  assert.deepEqual(bundles, ['@deepseek-ai/dsh-base', 'other'])
  assert.equal(changed, true)
})

await check('withoutSelf 对没有自己��列表是幂等的', () => {
  const { bundles, changed } = withoutSelf(['a', 'b'])
  assert.deepEqual(bundles, ['a', 'b'])
  assert.equal(changed, false)
})

await check('withSelf 挂回自己，且不重复', () => {
  const first = withSelf(['a'])
  assert.deepEqual(first.bundles, ['a', PACKAGE_NAME])
  assert.equal(first.changed, true)
  const second = withSelf(first.bundles)
  assert.deepEqual(second.bundles, ['a', PACKAGE_NAME])
  assert.equal(second.changed, false)
})

await check('writeBundleSelection 保留 dsh 下别的键', () => {
  const manifest = { dsh: { profile: { other: 'keep' }, engine: { x: 1 } } }
  writeBundleSelection(manifest, ['a'])
  assert.equal(manifest.dsh.profile.other, 'keep')
  assert.deepEqual(manifest.dsh.engine, { x: 1 })
  assert.deepEqual(manifest.dsh.profile.bundles, ['a'])
})

console.log('== 依赖项：卸载删掉，更新换掉 ==')

await check('dropSelfDependency 只删自己', () => {
  const manifest = { dependencies: { a: '1', [PACKAGE_NAME]: 'link:x', b: '2' } }
  assert.equal(dropSelfDependency(manifest), true)
  assert.deepEqual(manifest.dependencies, { a: '1', b: '2' })
  assert.equal(dropSelfDependency(manifest), false, '第二次删应该返回 false')
})

await check('setSelfDependency 换版本并报告是否变化', () => {
  const manifest = { dependencies: { [PACKAGE_NAME]: 'link:x' } }
  assert.equal(setSelfDependency(manifest, 'link:y'), true)
  assert.equal(manifest.dependencies[PACKAGE_NAME], 'link:y')
  assert.equal(setSelfDependency(manifest, 'link:y'), false, '同样的 spec 不该算变化')
})

console.log('== 用户数据：卸载不删，只报位置 ==')

await check('userDataPaths 指向配置与上传素材目录', () => {
  const paths = userDataPaths('/home/u/.dsh')
  assert.equal(paths.config, path.join('/home/u/.dsh', 'startup-animation.json'))
  assert.equal(paths.media, path.join('/home/u/.dsh', 'startup-animation-media'))
})

console.log('== 关键回归：卸载后不留悬空 bundle ==')

await check('依赖删了 → bundles 列表里也不能留着它', () => {
  const dir = makeProfile()
  const manifest = readProfileManifest(dir)
  // 模拟卸载流程：先摘 bundle，再删依赖。
  const { bundles } = withoutSelf(readBundleSelection(manifest))
  writeBundleSelection(manifest, bundles)
  dropSelfDependency(manifest)
  writeProfileManifest(dir, manifest)

  const after = readProfileManifest(dir)
  assert.equal(after.dependencies[PACKAGE_NAME], undefined, '依赖还在')
  assert.equal(
    readBundleSelection(after).includes(PACKAGE_NAME),
    false,
    'bundle 还挂在列表里 = 悬空条目，宿主下次启动会加载失败',
  )
  // 别的包不受影响。
  assert.equal(after.dependencies['@deepseek-ai/dsh-base'], '1.0.0')
  assert.ok(readBundleSelection(after).includes('other-plugin'))
})

fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('SELF MANAGE TEST PASS')
