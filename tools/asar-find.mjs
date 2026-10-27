// Dev helper: search an .asar archive for a literal string, list matching files, dump one file.
// Usage: node tools/asar-find.mjs <asar> <needle> [--dump path]
import fs from 'node:fs'

const [, , asarPath, needle, ...rest] = process.argv
if (!asarPath || !needle) {
  console.error('usage: node tools/asar-find.mjs <asar> <needle> [--dump path]')
  process.exit(1)
}
const buf = fs.readFileSync(asarPath)
// header: [u32 4][u32 payload][u32 payload-4][u32 jsonLen][json][pad to 4][file data]
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
const base = Math.ceil((16 + jsonLen) / 4) * 4

/** Walk the header, giving each file its absolute offset/size. */
const files = []
;(function walk(node, parts) {
  if (node.files) {
    for (const name of Object.keys(node.files)) walk(node.files[name], [...parts, name])
  } else {
    files.push({ path: parts.join('/'), offset: Number(node.offset), size: Number(node.size) })
  }
})(header, [])

console.log(`files: ${files.length}`)

const target = Buffer.from(needle, 'utf8')
const hits = []
for (const f of files) {
  if (f.size === 0 || f.size > 64 * 1024 * 1024) continue
  const slice = buf.subarray(base + f.offset, base + f.offset + f.size)
  if (slice.indexOf(target) !== -1) hits.push(f)
}
console.log(`hits: ${hits.length}`)
for (const h of hits) console.log(`  ${h.path} (${h.size} bytes)`)

const dumpIdx = rest.indexOf('--dump')
if (dumpIdx !== -1 && rest[dumpIdx + 1]) {
  const want = rest[dumpIdx + 1]
  const f = files.find((x) => x.path === want)
  if (!f) { console.error(`not found: ${want}`); process.exit(1) }
  const outPath = process.env.ASAR_DUMP_OUT || 'asar-dump.txt'
  fs.writeFileSync(outPath, buf.subarray(base + f.offset, base + f.offset + f.size))
  console.log(`dumped ${f.path} -> ${outPath}`)
}
