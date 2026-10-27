// Dev probe: what exactly does the host inject into index.html?
// Usage: node tools/inject-probe.mjs
import { apply } from '../index.js'

const table = []
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  on: (event, cb) => {
    if (event === 'webserver/index-inject') cb(table)
    return () => {}
  },
  inject: () => () => {},
}
apply(ctx)

const script = table.find((row) => row.kind === 'script')
const style = table.find((row) => row.kind === 'style')
const global = table.find((row) => row.kind === 'global')

console.log('注入行:', table.map((row) => row.kind).join(', '))
console.log('global 快照 mode =', global?.value?.mode, '| src =', JSON.stringify(global?.value?.src))
console.log('script 含新政策 =', script.text.includes("if (mode !== 'css' && src === \"\") return"))
console.log(
  'script 含旧 early-return =',
  script.text.includes('if (!(cfg.mode === "video" || cfg.mode === "image")) return'),
)
console.log('style 含 :has() 规则 =', style.text.includes('html:has(.dsa-root'))
console.log('style 含原生启动卡选择器 =', style.text.includes('[data-dsh-boot]'))
