/**
 * asar-extract.mjs —— 从 .asar 里取文件（处理 UTF-16 / BOM 编码）。
 *
 * 用途：开发期把宿主里的某个模块取出来读或跑（比如验证 cordis 的
 * ctx.inject 行为）。不是插件运行期的一部分。
 *
 * 用法：node tools/asar-extract.mjs <asar> <path-in-asar> <out-file>
 */
import fs from 'node:fs'

const [, , asarPath, innerPath, outPath] = process.argv
if (!asarPath || !innerPath || !outPath) {
  console.error('usage: node tools/asar-extract.mjs <asar> <path-in-asar> <out-file>')
  process.exit(2)
}

const buf = fs.readFileSync(asarPath)
const headerPickleSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
const dataOffset = 8 + headerPickleSize

const files = []
;(function walk(node, prefix) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, `${prefix}/${name}`)
    return
  }
  files.push({ path: prefix, size: Number(node.size), offset: Number(node.offset) })
})(header, '')

const hit = files.find((entry) => entry.path === innerPath)
if (hit === undefined) {
  console.error(`not found in asar: ${innerPath}`)
  process.exit(1)
}

const raw = buf.subarray(dataOffset + hit.offset, dataOffset + hit.offset + hit.size)

// 宿主里有些文件是 UTF-16LE（带 BOM）—— 读成 utf8 会满屏乱码。
let text = raw.toString('utf8')
if (text.charCodeAt(0) === 0xfeff || text.includes('\u0000')) {
  const decoded = raw.toString('utf16le')
  if (decoded.charCodeAt(0) === 0xfeff) text = decoded.slice(1)
}

fs.writeFileSync(outPath, text, 'utf8')
console.log(`${outPath}  ${text.length} bytes`)
