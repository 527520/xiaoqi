/**
 * 极简 PNG 解码（只支持 8 位 RGB / RGBA、非隔行）—— **只给验证脚本用**。
 *
 * ── 为什么要自己写 ──
 *
 * 像素判据必须走 `Page.captureScreenshot`（合成结果），而它是 PNG；
 * 于是验证脚本需要一个解码器。三条路都不通：
 * - 读页面 canvas：WebGL 的 drawing buffer 合成后就被清空，
 *   拿到的**永远是全透明**（`docs/RETRO.md` 记过这个误判）；
 * - 装 `pngjs` / `sharp`：本机没有 C++ 编译器，而且为了几行采样
 *   引入依赖不划算；
 * - 不解码只比字节：两张图的字节差异说明不了"差在哪、差多少"，
 *   也证明不了"透明区域仍然透明"。
 *
 * 所以照 `scripts/make-visual-gallery.mjs` 的做法自己解——
 * PNG 的滤波是 5 条固定公式，规模很小，而且**没有依赖**。
 */

/** PNG 的四种滤波类型（0 = none）。 */
const FILTER_NONE = 0
const FILTER_SUB = 1
const FILTER_UP = 2
const FILTER_AVERAGE = 3
const FILTER_PAETH = 4

/** 解码后的位图：RGBA，每像素 4 字节。 */
export function decodePng(buffer) {
  const chunks = []
  let off = 8 // 跳过 8 字节签名
  while (off + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(off)
    const type = buffer.toString('ascii', off + 4, off + 8)
    chunks.push({ type, data: buffer.subarray(off + 8, off + 8 + length) })
    off += 12 + length
  }

  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr) throw new Error('PNG 缺少 IHDR')
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]

  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，收到 ${String(bitDepth)}`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  if (colorType !== 6 && colorType !== 2 && colorType !== 0) {
    throw new Error(`只支持 RGBA(6) / RGB(2) / 灰度(0)，收到 ${String(colorType)}`)
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  const raw = inflate(idat)

  const stride = width * channels
  const rgba = new Uint8Array(width * height * 4)
  const line = new Uint8Array(stride)
  const prev = new Uint8Array(stride)

  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    for (let i = 0; i < stride; i++) line[i] = raw[pos + i]
    pos += stride

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === FILTER_SUB) value += a
      else if (filter === FILTER_UP) value += b
      else if (filter === FILTER_AVERAGE) value += (a + b) >> 1
      else if (filter === FILTER_PAETH) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== FILTER_NONE) {
        throw new Error(`未知的 PNG 滤波类型 ${String(filter)}`)
      }
      line[i] = value & 0xff
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      if (channels === 4) {
        rgba[d] = line[s]
        rgba[d + 1] = line[s + 1]
        rgba[d + 2] = line[s + 2]
        rgba[d + 3] = line[s + 3]
      } else if (channels === 3) {
        rgba[d] = line[s]
        rgba[d + 1] = line[s + 1]
        rgba[d + 2] = line[s + 2]
        rgba[d + 3] = 255
      } else {
        rgba[d] = line[s]
        rgba[d + 1] = line[s]
        rgba[d + 2] = line[s]
        rgba[d + 3] = 255
      }
    }
    prev.set(line)
  }

  return { width, height, rgba }
}

// zlib 的解码：直接用 node:zlib，不自己写 inflate（那是几千行）。
import { inflateSync } from 'node:zlib'

function inflate(data) {
  return inflateSync(data)
}

/** 取某个像素的 `[r,g,b,a]`。越界会抛——越界通常意味着坐标算错了。 */
export function pixelAt(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new Error(
      `像素坐标越界：(${String(x)}, ${String(y)}) 画布 ${String(image.width)}×${String(image.height)}`,
    )
  }
  const i = (y * image.width + x) * 4
  return [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], image.rgba[i + 3]]
}

/**
 * 统计一张图的像素特征 —— 探针与像素判据共用。
 *
 * `cornerInset` 用于避开抗锯齿边缘：四角往内缩几个像素再采样。
 */
export function summarize(image, { cornerInset = 2, alphaThreshold = 8 } = {}) {
  const { width, height, rgba } = image
  let opaque = 0
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] > alphaThreshold) opaque++
  }

  const at = (x, y) => pixelAt(image, x, y)
  const corners = [
    at(cornerInset, cornerInset),
    at(width - 1 - cornerInset, cornerInset),
    at(cornerInset, height - 1 - cornerInset),
    at(width - 1 - cornerInset, height - 1 - cornerInset),
  ]

  return {
    size: [width, height],
    opaquePixels: opaque,
    totalPixels: width * height,
    corners,
    /** 沿水平中线每隔 2px 采样一次，用于比较两张图的差异。 */
    midRow: Array.from({ length: Math.ceil(width / 2) }, (_, i) =>
      at(Math.min(i * 2, width - 1), Math.floor(height / 2)),
    ),
  }
}

/** 两张图在中线上的最大通道差与"有差异的采样点数"。 */
export function compareMidRows(a, b, threshold = 6) {
  let differing = 0
  let maxDelta = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    // 只比较两边都不透明的点：把"透明区域相同"算成差异会得出假结论。
    if (a[i][3] < 200 || b[i][3] < 200) continue
    const delta = Math.max(
      Math.abs(a[i][0] - b[i][0]),
      Math.abs(a[i][1] - b[i][1]),
      Math.abs(a[i][2] - b[i][2]),
    )
    if (delta > threshold) differing++
    if (delta > maxDelta) maxDelta = delta
  }
  return { differing, maxDelta }
}
