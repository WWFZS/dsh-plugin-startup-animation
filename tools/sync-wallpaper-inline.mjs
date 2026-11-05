/**
 * 把 lib/wallpaper.mjs 的源码嵌进 client.js 的标记段。
 *
 * 为什么是"内联"而不是 `require('./lib/wallpaper.mjs')`：
 * 浏览器半边走的是 `window.__ModuleLoader__.load({ factory(require) })`，`require`
 * 只解析**模块表里注册过的包名**，解析不了相对路径文件 —— 这个包不是构建产物，
 * 没有打包步骤，也就没有地方把 ESM 转成浏览器能读的东西。所以取最小方案：
 *
 *   lib/wallpaper.mjs（唯一真源，宿主 import 它、单测跑它）
 *        └─ tools/sync-wallpaper-inline.mjs → client.js 的 INLINE-BEGIN/END 之间
 *
 * 内联段只做一次"`export ` 去掉 + 收集导出名"，逻辑一个字不改。改完跑
 * `node tools/client-test.mjs`，它会重新对一遍，防止两份漂移。
 *
 * 运行：node tools/sync-wallpaper-inline.mjs [--check]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceFile = path.join(root, 'lib', 'wallpaper.mjs')
const clientFile = path.join(root, 'client.js')

const BEGIN = '// >>> INLINE lib/wallpaper.mjs（由 tools/sync-wallpaper-inline.mjs 生成，勿手改）'
const END = '// <<< INLINE lib/wallpaper.mjs'

/**
 * 去掉顶层 `export ` 前缀并收集导出名。源码里没有 `export default`、没有重新导出，
 * 所以这条正则足够；真出现了也会因为校验失败而当场炸掉，不会静默生成坏代码。
 * @param {string} source lib/wallpaper.mjs 全文。
 * @returns {{ code: string, names: string[] }}
 */
export function inline(source) {
  const names = []
  const code = source
    .replace(/^export const ([A-Za-z_$][\w$]*)/gm, (_, name) => {
      names.push(name)
      return `const ${name}`
    })
    .replace(/^export function ([A-Za-z_$][\w$]*)/gm, (_, name) => {
      names.push(name)
      return `function ${name}`
    })
  if (/^\s*export\s/m.test(code)) {
    throw new Error('lib/wallpaper.mjs 里出现了无法内联的 export 形式（只支持 export const / export function）')
  }
  return { code, names }
}

/** 生成要贴进 client.js 的整段文本。 */
export function render() {
  const source = fs.readFileSync(sourceFile, 'utf8')
  const { code, names } = inline(source)
  const indent = (text) => text.replace(/^(?=.)/gm, '    ')
  return [
    BEGIN,
    '    // 真源：lib/wallpaper.mjs（与宿主、单测共用同一份算法，改那边再跑同步脚本）。',
    `    // 导出（供 client-test 校验）：${names.join(', ')}`,
    indent(code.trimEnd()),
    END,
  ].join('\n')
}

/** 把渲染好的段落写回 client.js。 */
export function write() {
  const text = fs.readFileSync(clientFile, 'utf8')
  const start = text.indexOf(BEGIN)
  const stop = text.indexOf(END)
  if (start === -1 || stop === -1 || stop < start) throw new Error('client.js 里找不到内联标记段')
  const next = `${text.slice(0, start)}${render()}${text.slice(stop + END.length)}`
  fs.writeFileSync(clientFile, next)
  return next.length - text.length
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (process.argv.includes('--check')) {
    const text = fs.readFileSync(clientFile, 'utf8')
    const start = text.indexOf(BEGIN)
    const stop = text.indexOf(END)
    if (start === -1 || stop === -1) throw new Error('client.js 里找不到内联标记段')
    const current = text.slice(start, stop + END.length)
    if (current !== render()) {
      console.error('client.js 的内联段落与 lib/wallpaper.mjs 不一致，请跑 node tools/sync-wallpaper-inline.mjs')
      process.exit(1)
    }
    console.log('内联段落已同步')
  } else {
    const delta = write()
    console.log(`已同步（${delta >= 0 ? '+' : ''}${delta} 字节）`)
  }
}
