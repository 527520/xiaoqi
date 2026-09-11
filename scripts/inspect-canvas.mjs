/**
 * 截图取证工具：分析一张 PNG 里"到底画出了什么"。
 *
 * 为什么需要它：本项目的渲染问题**不能靠开 DevTools 排查**——
 * 施工令 §4.3② 实测 DevTools 打开时透明窗会变不透明。
 * 而肉眼看 220×220 的缩略图也分不清"没画"与"画了但被盖住"。
 * 这个脚本把定论做在像素上。
 *
 * 用法：
 *   node scripts/inspect-canvas.mjs <png>              # 颜色统计 + ASCII 概览
 *   node scripts/inspect-canvas.mjs <png> --at 90,134  # 顺便取几个点
 *
 * 截图从哪来：`node scripts/attach-cdp.mjs` 配 `XIAOQI_CDP_SCREENSHOT=名字.png`，
 * 它用 CDP 连到**真实应用**的渲染进程，因此不打开 DevTools 窗口。
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/**
 * 简易 PNG 解码：只处理 8 位、非隔行、filter 0-4。
 *
 * 支持 colorType 2（RGB）与 6（RGBA）——两种都要认：
 * - Pixi 画布经 CDP `Page.captureScreenshot` 出来的是 RGBA；
 * - Electron `NativeImage.toPNG()`（桌面取证的图）是 **RGB，没有 alpha 通道**。
 *   曾经只认 RGBA，于是读取证截图时直接抛错。
 */
function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      const colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(
          `只支持 8 位、非隔行的 RGB/RGBA PNG；实际 bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
        )
      }
      channels = colorType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  const raw = inflateSync(Buffer.concat(idat))
  const bpp = channels
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowIn = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const rowOut = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rowOut[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = rowIn[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      rowOut[x] = v & 0xff
    }
  }

  return { width, height, channels, pixels: out }
}

const pngPath = process.argv[2]
if (!pngPath) {
  console.error('用法：node scripts/inspect-canvas.mjs <png 路径> [--at x,y ...]')
  process.exit(1)
}

const { width, height, channels, pixels } = decodePng(readFileSync(pngPath))
/** 取像素，统一返回 [r,g,b,a]。RGB 图没有 alpha 通道，按完全不透明处理。 */
const at = (x, y) => {
  const i = (y * width + x) * channels
  return [pixels[i], pixels[i + 1], pixels[i + 2], channels === 4 ? pixels[i + 3] : 255]
}

console.log(`图像 ${width}×${height}（${channels === 4 ? 'RGBA' : 'RGB'}）`)

// 颜色统计 + 包围盒：能同时回答"有没有画"和"画在哪"。
const stats = new Map()
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const [r, g, b, a] = at(x, y)
    if (a < 16) continue
    const key = `${r},${g},${b}`
    let s = stats.get(key)
    if (!s) {
      s = { count: 0, minX: x, maxX: x, minY: y, maxY: y }
      stats.set(key, s)
    }
    s.count++
    if (x < s.minX) s.minX = x
    if (x > s.maxX) s.maxX = x
    if (y < s.minY) s.minY = y
    if (y > s.maxY) s.maxY = y
  }
}

console.log('\n=== 颜色统计（按像素数降序）===')
for (const [color, s] of [...stats.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(
    `  rgb(${color})  像素=${String(s.count).padStart(6)}  包围盒 x[${s.minX}..${s.maxX}] y[${s.minY}..${s.maxY}]`,
  )
}

// 指定点取样
const atArgs = process.argv.slice(3)
if (atArgs.includes('--at')) {
  console.log('\n=== 指定点取样 ===')
  for (const spec of atArgs.filter((a) => a !== '--at')) {
    const [x, y] = spec.split(',').map(Number)
    const [r, g, b, a] = at(x, y)
    console.log(`  (${x},${y}) = ${a === 0 ? 'transparent' : `rgba(${r},${g},${b},${a})`}`)
  }
}

// ASCII 概览：直观看清各图层的空间关系
console.log('\n=== ASCII 概览（# 身体 / O 描边 / E 眼睛 / c 腮红 / s 影子 / . 透明）===')
const gridW = 55
const gridH = 30
const legend = {
  '255,244,214': '#',
  '90,70,50': 'O',
  '58,44,32': 'E',
  '255,176,168': 'c',
  '255,210,191': 'c',
  '0,0,0': 's',
}
const rows = []
for (let gy = 0; gy < gridH; gy++) {
  let row = ''
  for (let gx = 0; gx < gridW; gx++) {
    const x0 = Math.floor((gx * width) / gridW)
    const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gridW))
    const y0 = Math.floor((gy * height) / gridH)
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gridH))
    const counts = new Map()
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const [r, g, b, a] = at(x, y)
        const key = a < 16 ? '.' : `${r},${g},${b}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    row += top ? (legend[top[0]] ?? '+') : ' '
  }
  rows.push(row)
}
console.log(rows.join('\n'))
