/**
 * 把八种情绪与三种关系基调的截图拼成一张对比图。
 *
 * ── 为什么需要它 ──
 *
 * 「好看」这件事最终只能由人判断，而判断需要**并排看**。
 * 单张 220×220 的图要来回切八次才能比较，很难看出
 * "这八种表情到底有没有区别"。
 *
 * 这个脚本把 `docs/evidence/runtime/emotions/*.png` 与
 * `docs/evidence/runtime/m2/mood-*.png` 拼成一张带标签的总览图，
 * 让"长什么样"一眼可见，也顺带成为一份可提交的视觉证据。
 *
 * 实现上**不用任何图形库**：PNG 解码/编码自己写（zlib + CRC32），
 * 与 `scripts/generate-icons.mjs` 同一套做法。
 * 理由也一样：本机没有 C++ 编译器，原生图形库装不上，
 * 而"为了拼一张图"引入一个带二进制的依赖不划算。
 *
 * 用法：node scripts/make-visual-gallery.mjs
 */

import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EMOTIONS = ['happy', 'calm', 'sleepy', 'focused', 'aggrieved', 'surprised', 'close', 'bored']
const MOODS = ['reserved', 'warm', 'attached']

const evidenceDir = join(process.cwd(), 'docs', 'evidence')
const outPath = join(evidenceDir, 'pet-gallery.png')

// ── 最小 PNG 解码（只支持 8 位 RGBA / RGB，无隔行）──

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function readChunks(buf) {
  const chunks = []
  let off = 8 // 跳过签名
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    chunks.push({ type, data })
    off += 12 + len
  }
  return chunks
}

/** 解码为 { width, height, rgba: Uint8Array }。 */
function decodePng(buf) {
  const chunks = readChunks(buf)
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr) throw new Error('PNG 缺少 IHDR')
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]
  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，收到 ${String(bitDepth)}`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`只支持 RGBA(6) / RGB(2)，收到 ${String(colorType)}`)
  }

  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  const line = new Uint8Array(stride)
  const prev = new Uint8Array(stride)

  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    for (let i = 0; i < stride; i++) line[i] = raw[pos + i]
    pos += stride
    // 反滤波（PNG 的 5 种滤波器）
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = value & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      out[d] = line[s]
      out[d + 1] = line[s + 1]
      out[d + 2] = line[s + 2]
      out[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    prev.set(line)
  }
  return { width, height, rgba: out }
}

// ── 最小 PNG 编码（RGBA，无滤波）──

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 拼图 ──

const COLS = 4
/** 截图都是 220×220，但宠物本体并不占满——格子留点余量，视觉上才不会顶到边。 */
const CELL_W = 220
/**
 * 行高固定为 220（截图的原始尺寸）。
 *
 * 曾经想按"非透明内容包围盒"动态算行高，结果更糟：
 * 三张 mood 图是**缩小后**的宠物（为了截图好看把窗口调小了），
 * 它们的内容包围盒比情绪图小得多，于是那一行被排得很矮、
 * 标签离图老远，整张图看起来散架了。
 *
 * 统一格子还带来一个好处：宠物在两行里**大小与位置一致**，
 * 可以直接上下对比表情——这正是这张图存在的理由。
 */
const CELL_H = 220
const GAP_X = 4
const GAP_Y = 10
const PAD = 16
/** 标题占的高度。 */
const TITLE_H = 30
/** 图与它下面那行标签之间的间隙。 */
const LABEL_GAP = 6
/** 点阵字高 7 像素 × scale 2。 */
const LABEL_TEXT_H = 14
const LABEL_H = LABEL_TEXT_H + LABEL_GAP

const ROWS = Math.ceil((EMOTIONS.length + MOODS.length) / COLS)

const sources = [
  ...EMOTIONS.map((name) => ({
    label: name,
    file: join(evidenceDir, 'runtime', 'emotions', `${name}.png`),
  })),
  ...MOODS.map((name) => ({
    label: `MOOD ${name}`,
    file: join(evidenceDir, 'runtime', 'm2', `mood-${name}.png`),
  })),
]

const decoded = sources.map((source) => ({
  ...source,
  image: decodePng(readFileSync(source.file)),
}))

const width = PAD * 2 + COLS * CELL_W + (COLS - 1) * GAP_X
const height = PAD * 2 + TITLE_H + ROWS * (CELL_H + LABEL_H) + (ROWS - 1) * GAP_Y

const canvas = new Uint8Array(width * height * 4)
// 背景：与宠物配色同族的浅纸色，让图本身也像这个项目的产物。
for (let i = 0; i < canvas.length; i += 4) {
  canvas[i] = 0xee
  canvas[i + 1] = 0xf2
  canvas[i + 2] = 0xf7
  canvas[i + 3] = 255
}

/** 极简 5×7 点阵字体：只要够画出标签里的 ASCII 与分隔符。 */
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '11111', '10001', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10011', '01111'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}

function drawText(text, x0, y0, scale, color) {
  let cursor = x0
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = cursor + col * scale + dx
            const py = y0 + row * scale + dy
            if (px < 0 || py < 0 || px >= width || py >= height) continue
            const i = (py * width + px) * 4
            canvas[i] = color[0]
            canvas[i + 1] = color[1]
            canvas[i + 2] = color[2]
            canvas[i + 3] = 255
          }
        }
      }
    }
    cursor += 6 * scale
  }
}

const INK = [0x2f, 0x3a, 0x4d]
const SOFT = [0x64, 0x74, 0x8b]
let placed = 0

// 标题。字号 2 时每个字符宽 6×2=12px，够画下整行。
drawText('XIAOQI  /  8 EMOTIONS  +  3 MOODS', PAD, PAD, 2, INK)
const gridTop = PAD + TITLE_H

for (const [index, item] of decoded.entries()) {
  const col = index % COLS
  const row = Math.floor(index / COLS)
  const cellX = PAD + col * (CELL_W + GAP_X)
  const cellY = gridTop + row * (CELL_H + LABEL_H + GAP_Y)

  // 缩放并居中贴进格子。截图尺寸并不统一（情绪图 440×440、
  // 关系基调图 220×220），不缩放的话前者会溢出格子压到邻居身上。
  blitFitted(item.image, cellX, cellY, CELL_W, CELL_H)
  drawText(item.label, cellX + 2, cellY + CELL_H + LABEL_GAP, 2, SOFT)
  placed++
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(outPath, encodePng(width, height, canvas))
console.log(`已生成 ${outPath}`)
console.log(`  ${String(width)}×${String(height)}，共拼入 ${String(placed)} 张截图`)

/**
 * 把一张图**缩放并居中**贴进一个格子。
 *
 * ⚠️ 必须缩放：本目录里的截图尺寸并不统一——
 *    情绪图是 440×440（当时窗口是 2 倍缩放拍的），
 *    关系基调图是 220×220。直接按原尺寸贴，前者会溢出格子、
 *    压到邻居身上，整张拼图糊成一片（第一版就是这样）。
 *    统一缩放进格子之后，两行宠物大小一致，可以直接对比表情。
 *
 * 用最近邻采样：这些图是程序化几何形状，最近邻在整数倍缩放下
 * 与双线性几乎无差别，而实现只有几行、不需要额外的重采样逻辑。
 */
function blitFitted(image, cellX, cellY, cellW, cellH) {
  const k = Math.min(cellW / image.width, cellH / image.height, 1)
  const drawW = Math.max(1, Math.round(image.width * k))
  const drawH = Math.max(1, Math.round(image.height * k))
  const offsetX = cellX + Math.round((cellW - drawW) / 2)
  const offsetY = cellY + Math.round((cellH - drawH) / 2)

  for (let y = 0; y < drawH; y++) {
    const srcY = Math.min(image.height - 1, Math.floor(y / k))
    for (let x = 0; x < drawW; x++) {
      const srcX = Math.min(image.width - 1, Math.floor(x / k))
      const s = (srcY * image.width + srcX) * 4
      const alpha = image.rgba[s + 3] / 255
      if (alpha === 0) continue
      const px = offsetX + x
      const py = offsetY + y
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      const d = (py * width + px) * 4
      for (let channel = 0; channel < 3; channel++) {
        canvas[d + channel] = Math.round(
          image.rgba[s + channel] * alpha + canvas[d + channel] * (1 - alpha),
        )
      }
      canvas[d + 3] = 255
    }
  }
}
