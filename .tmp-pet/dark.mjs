import { spawn } from 'node:child_process'
const W = 480, H = 648
// 直接读成品 webm 的 rgba（不落 PNG，避免丢 alpha）
const args = ['-v','error','-c:v','libvpx-vp9','-i','builtin/宠物/噜噜/堆雪人.webm','-vf','select=eq(n\\,100)','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','-']
const chunks = []
await new Promise((res) => { const c = spawn('ffmpeg', args); c.stdout.on('data', d => chunks.push(d)); c.on('close', res) })
const data = Buffer.concat(chunks)
console.log('字节数', data.length, '(应 =', W*H*4, ')')
const fs = W * H * 4
const frame = data.subarray(0, fs)
let minX = W, minY = H, maxX = -1, maxY = -1, count = 0
let sumR = 0, sumG = 0, sumB = 0
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const a = frame[i+3], r = frame[i], g = frame[i+1], b = frame[i+2]
    // 不透明且很暗 = 异常块（雪/角色都不该这么暗）
    if (a > 200 && Math.max(r,g,b) < 110) {
      count++; sumR += r; sumG += g; sumB += b
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
}
if (count === 0) console.log('没有暗色不透明像素')
else console.log(`暗色不透明块 ${count} 像素  bbox x ${minX}..${maxX}  y ${minY}..${maxY}  平均 rgb(${Math.round(sumR/count)},${Math.round(sumG/count)},${Math.round(sumB/count)})`)
