/**
 * 从 **WebP 文件头**读出像素尺寸 —— 纯字节解析，可单测。
 *
 * ── 为什么需要它 ──
 *
 * `pet.json` 里的 `spriteVersionNumber` 决定了图集**应该**是多少像素
 * （V1 = 1536×1872，V2 = 1536×2288），而版本写错的表现是"整张图按错误的
 * 格高切分"——宠物每隔几帧跳到别的动作上去。看着像渲染 bug，实际是元数据错。
 *
 * 主进程想在**开窗之前**发现这件事，但主进程没有图片解码器
 * （Chromium 的解码在渲染进程里，而 `sharp` 这类原生模块本机装不了：
 * 没有 C++ 工具链）。所以退一步：只读文件头。
 *
 * WebP 的三种格式**都把尺寸放在头部**：
 *
 * ```
 * RIFF <u32 长度> WEBP
 *   ├─ "VP8 "  ← 有损：尺寸在帧头里，14 位，需要乘 2 且取低 14 位
 *   ├─ "VP8L"  ← 无损：尺寸打包在 4 字节里（14 位宽 + 14 位高）
 *   └─ "VP8X"  ← 扩展：24 位宽高（各减 1），后面才是真正的图像块
 * ```
 *
 * ⚠️ **读不出来一律返回 null，不抛错**：这是"锦上添花"的校验，
 *    读不到就跳过（渲染进程解码后还会再校验一次）。为了一个可选校验
 *    让宠物启动失败是本末倒置。
 *
 * ⚠️ VP8X（扩展格式）的宽高是 **24 位、存储值 = 实际 - 1**，
 *    漏掉那个 `+1` 会让 1536 变成 1535，于是"合规的图被判成不合规"。
 *    这是本文件最容易写错的一处，测试里专门钉住。
 */

/** 解析结果。`null` 表示"读不出来"（格式不认识或数据太短）。 */
export interface ImageSize {
  readonly width: number
  readonly height: number
  /** 命中的容器格式，供日志与测试区分。 */
  readonly format: 'VP8' | 'VP8L' | 'VP8X' | 'PNG'
}

/** 按小端读一个 u32。 */
function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

/** 按小端读一个 u24（VP8X 用）。 */
function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

/** 在 `offset` 处是否是给定的 4 个 ASCII 字符。 */
function hasTag(bytes: Uint8Array, offset: number, tag: string): boolean {
  if (offset + 4 > bytes.length) return false
  for (let i = 0; i < 4; i++) {
    if (bytes[offset + i] !== tag.charCodeAt(i)) return false
  }
  return true
}

/**
 * 读 WebP 的像素尺寸。
 *
 * 只要求传入文件**开头**的一小段（前 64 字节足够覆盖三种格式的头部）。
 */
export function parseWebpSize(bytes: Uint8Array | Uint8ClampedArray): ImageSize | null {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer.slice(0))

  // RIFF....WEBP
  if (data.length < 16) return null
  if (!hasTag(data, 0, 'RIFF') || !hasTag(data, 8, 'WEBP')) return null

  const chunk = 12

  if (hasTag(data, chunk, 'VP8X')) {
    // 扩展格式的块体（依据 RIFF 容器规范 "Extended WebP file header"）：
    //
    //   偏移 +0 : 1 字节   Rsv(2) | I | L | E | X | A | R
    //   偏移 +1 : 3 字节   保留（MUST be 0）
    //   偏移 +4 : 3 字节   Canvas Width  Minus One（**1-based**）
    //   偏移 +7 : 3 字节   Canvas Height Minus One（**1-based**）
    //
    // 所以：块头 8 字节 + 标志 4 字节 = 12 字节之后才是宽，再 3 字节是高。
    // ⚠️ 宽高都是 **1-based**（存的是"实际 - 1"）——漏掉 `+1` 会让
    //    1536 读成 1535，于是"合规的图被判成不合规、宠物干脆不加载"。
    if (data.length < chunk + 12 + 3) return null
    const width = readUint24LE(data, chunk + 8 + 4) + 1
    const height = readUint24LE(data, chunk + 8 + 4 + 3) + 1
    if (width <= 0 || height <= 0) return null
    return { width, height, format: 'VP8X' }
  }

  if (hasTag(data, chunk, 'VP8L')) {
    // 无损格式：'VP8L' + u32 块长度 + 1 字节签名(0x2f) + 4 字节打包尺寸
    if (data.length < chunk + 8 + 5) return null
    if (data[chunk + 8] !== 0x2f) return null
    const packed = readUint32LE(data, chunk + 8 + 1)
    // 低 14 位宽、次 14 位高（各存的是"实际 - 1"）
    const width = (packed & 0x3fff) + 1
    const height = ((packed >> 14) & 0x3fff) + 1
    if (width <= 0 || height <= 0) return null
    return { width, height, format: 'VP8L' }
  }

  if (hasTag(data, chunk, 'VP8 ')) {
    // 有损格式：'VP8 ' + u32 块长度 + 3 字节帧标签 + 3 字节起始码(0x9d 0x01 0x2a)
    //           + u16 宽（低 14 位有效） + u16 高
    if (data.length < chunk + 8 + 10) return null
    if (
      data[chunk + 8 + 3] !== 0x9d ||
      data[chunk + 8 + 4] !== 0x01 ||
      data[chunk + 8 + 5] !== 0x2a
    ) {
      return null
    }
    const width = (data[chunk + 8 + 6] ?? 0) | ((data[chunk + 8 + 7] ?? 0) << 8)
    const height = (data[chunk + 8 + 8] ?? 0) | ((data[chunk + 8 + 9] ?? 0) << 8)
    const w = width & 0x3fff
    const h = height & 0x3fff
    if (w <= 0 || h <= 0) return null
    return { width: w, height: h, format: 'VP8' }
  }

  return null
}

/**
 * PNG 的像素尺寸（备用格式：规范也允许 PNG）。
 *
 * PNG 的结构简单得多：8 字节签名 + 长度(4) + 'IHDR' + 宽(4) + 高(4)。
 * 宽高是**大端** u32，与 WebP 相反——写反了会得到天文数字般的尺寸。
 */
export function parsePngSize(bytes: Uint8Array | Uint8ClampedArray): ImageSize | null {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer.slice(0))
  if (data.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i++) {
    if (data[i] !== signature[i]) return null
  }
  if (!hasTag(data, 12, 'IHDR')) return null
  const width =
    ((data[16] ?? 0) << 24) | ((data[17] ?? 0) << 16) | ((data[18] ?? 0) << 8) | (data[19] ?? 0)
  const height =
    ((data[20] ?? 0) << 24) | ((data[21] ?? 0) << 16) | ((data[22] ?? 0) << 8) | (data[23] ?? 0)
  if (width <= 0 || height <= 0) return null
  return { width, height, format: 'PNG' }
}

/** 按文件名猜格式并读尺寸（`.png` 走 PNG，其余按 WebP）。 */
export function parseImageSize(
  bytes: Uint8Array | Uint8ClampedArray,
  fileName: string,
): ImageSize | null {
  return fileName.toLowerCase().endsWith('.png') ? parsePngSize(bytes) : parseWebpSize(bytes)
}
