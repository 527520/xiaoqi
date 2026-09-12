import { describe, expect, it } from 'vitest'

import { CODEX_V2_ATLAS } from './petAtlas'
import { parseImageSize, parsePngSize, parseWebpSize } from './webpSize'

/**
 * 图集文件头尺寸解析的测试。
 *
 * ── 为什么值得测 ──
 *
 * 这个函数存在的唯一目的是"在开窗之前发现图集尺寸不对"。它**静默失效**的
 * 方式是返回 null 或返回一个错的数：
 *   - 返回 null → 校验被跳过（我们以为查过了，其实没有）；
 *   - 返回错的数 → 合规的图被判成不合规，宠物直接不加载。
 *
 * 两种都不会抛错、都不会有日志，所以只能靠测试钉住。
 * 三种 WebP 格式（有损/无损/扩展）的头部布局**各不相同**，
 * 而"文件头写错"是极容易犯的错（比如 VP8X 的宽高是"实际 - 1"）。
 */

/** 造一个 RIFF/WEBP 容器骨架：12 字节 RIFF 头 + 8 字节块头 + 块体。 */
function riff(chunkTag: string, chunkBody: Uint8Array): Uint8Array {
  const out = new Uint8Array(20 + chunkBody.length)
  const put = (text: string, at: number): void => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i)
  }
  put('RIFF', 0)
  // RIFF 长度字段（本文件不校验它，写个近似值即可）
  const riffSize = out.length - 8
  out[4] = riffSize & 0xff
  out[5] = (riffSize >> 8) & 0xff
  out[6] = (riffSize >> 16) & 0xff
  out[7] = (riffSize >> 24) & 0xff
  put('WEBP', 8)
  put(chunkTag, 12)
  const size = chunkBody.length
  out[16] = size & 0xff
  out[17] = (size >> 8) & 0xff
  out[18] = (size >> 16) & 0xff
  out[19] = (size >> 24) & 0xff
  out.set(chunkBody, 20)
  return out
}

/** 造一个 VP8L（无损）块体。 */
function vp8lBody(width: number, height: number): Uint8Array {
  const body = new Uint8Array(5)
  body[0] = 0x2f // 签名
  const packed = (width - 1) | ((height - 1) << 14)
  body[1] = packed & 0xff
  body[2] = (packed >> 8) & 0xff
  body[3] = (packed >> 16) & 0xff
  body[4] = (packed >> 24) & 0xff
  return body
}

/** 造一个 VP8X（扩展）块体。 */
function vp8xBody(width: number, height: number): Uint8Array {
  const body = new Uint8Array(4 + 3 + 3)
  // 1 字节标志 + 3 字节保留（共 4 字节），然后 u24 宽、u24 高，都是"实际 - 1"
  const w = width - 1
  const h = height - 1
  body[4] = w & 0xff
  body[5] = (w >> 8) & 0xff
  body[6] = (w >> 16) & 0xff
  body[7] = h & 0xff
  body[8] = (h >> 8) & 0xff
  body[9] = (h >> 16) & 0xff
  return body
}

/** 造一个 VP8（有损）块体。 */
function vp8Body(width: number, height: number): Uint8Array {
  const body = new Uint8Array(10)
  // 前 3 字节是帧标签（内容无关），接着是 3 字节起始码
  body[3] = 0x9d
  body[4] = 0x01
  body[5] = 0x2a
  body[6] = width & 0xff
  body[7] = (width >> 8) & 0xff
  body[8] = height & 0xff
  body[9] = (height >> 8) & 0xff
  return body
}

describe('parseWebpSize：三种容器格式', () => {
  it('VP8L（无损）：14 位打包，值 = 实际 - 1', () => {
    const size = parseWebpSize(riff('VP8L', vp8lBody(1536, 2288)))
    expect(size).toEqual({ width: 1536, height: 2288, format: 'VP8L' })
  })

  it('★ VP8X（扩展）：24 位宽高，值 = 实际 - 1（漏掉 +1 会让 1536 变 1535）', () => {
    const size = parseWebpSize(riff('VP8X', vp8xBody(1536, 2288)))
    expect(size?.format).toBe('VP8X')
    expect(size?.width).toBe(1536)
    expect(size?.height).toBe(2288)
  })

  it('VP8（有损）：低 14 位有效（高位是缩放提示位，必须掩掉）', () => {
    const body = vp8Body(1536, 2288)
    // 把高位（缩放假号）置起来，正确实现仍然要读出 1536×2288
    body[7] = (body[7] ?? 0) | 0xc0
    body[9] = (body[9] ?? 0) | 0xc0
    const size = parseWebpSize(riff('VP8 ', body))
    expect(size).toEqual({ width: 1536, height: 2288, format: 'VP8' })
  })

  it('★ 三种格式解出的尺寸必须一致（同一张图换个编码器不该读出不同的数）', () => {
    const lossy = parseWebpSize(riff('VP8 ', vp8Body(192, 208)))
    const lossless = parseWebpSize(riff('VP8L', vp8lBody(192, 208)))
    const extended = parseWebpSize(riff('VP8X', vp8xBody(192, 208)))
    expect(lossy?.width).toBe(192)
    expect(lossless?.width).toBe(192)
    expect(extended?.width).toBe(192)
    expect(lossy?.height).toBe(208)
    expect(lossless?.height).toBe(208)
    expect(extended?.height).toBe(208)
  })

  it('尺寸 1×1 也要读对（0 值 + 1 是最容易写成 0 的边界）', () => {
    expect(parseWebpSize(riff('VP8L', vp8lBody(1, 1)))).toEqual({
      width: 1,
      height: 1,
      format: 'VP8L',
    })
  })
})

describe('parseWebpSize：坏输入一律返回 null，不抛错', () => {
  it('太短的数据', () => {
    for (const length of [0, 4, 12, 15]) {
      expect(parseWebpSize(new Uint8Array(length)), `长度 ${String(length)}`).toBeNull()
    }
  })

  it('不是 RIFF/WEBP', () => {
    const bytes = riff('VP8L', vp8lBody(10, 10))
    bytes[0] = 0x58 // 破坏 'R'
    expect(parseWebpSize(bytes)).toBeNull()
  })

  it('WEBP 标记被破坏', () => {
    const bytes = riff('VP8L', vp8lBody(10, 10))
    bytes[8] = 0x58
    expect(parseWebpSize(bytes)).toBeNull()
  })

  it('块类型不认识', () => {
    expect(parseWebpSize(riff('JUNK', vp8lBody(10, 10)))).toBeNull()
  })

  it('★ VP8L 签名不对（0x2f）就拒收，而不是硬把后面 4 字节当尺寸', () => {
    const body = vp8lBody(1536, 2288)
    body[0] = 0x00
    expect(parseWebpSize(riff('VP8L', body))).toBeNull()
  })

  it('★ VP8 起始码不对（0x9d 0x01 0x2a）就拒收', () => {
    const body = vp8Body(1536, 2288)
    body[3] = 0x00
    expect(parseWebpSize(riff('VP8 ', body))).toBeNull()
  })

  it('块体被截断（数据刚好差一个字节）', () => {
    const full = riff('VP8L', vp8lBody(1536, 2288))
    // VP8L 需要 块头(8) + 签名(1) + 打包尺寸(4) = 自偏移 12 起 13 字节
    expect(parseWebpSize(full.subarray(0, 12 + 12))).toBeNull()
    expect(parseWebpSize(full.subarray(0, 12 + 13))).not.toBeNull()
  })

  it('Uint8ClampedArray 也能吃（与 ImageData 同源的数据）', () => {
    const bytes = riff('VP8L', vp8lBody(1536, 2288))
    const clamped = new Uint8ClampedArray(bytes)
    expect(parseWebpSize(clamped)?.width).toBe(1536)
  })
})

describe('parsePngSize', () => {
  /** 造一份最小 PNG 头。 */
  function png(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(24)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
    // 宽高是**大端**——与 WebP 相反
    bytes[16] = (width >>> 24) & 0xff
    bytes[17] = (width >>> 16) & 0xff
    bytes[18] = (width >>> 8) & 0xff
    bytes[19] = width & 0xff
    bytes[20] = (height >>> 24) & 0xff
    bytes[21] = (height >>> 16) & 0xff
    bytes[22] = (height >>> 8) & 0xff
    bytes[23] = height & 0xff
    return bytes
  }

  it('★ 大端读宽高（写成小端会得到天文数字）', () => {
    expect(parsePngSize(png(1536, 2288))).toEqual({
      width: 1536,
      height: 2288,
      format: 'PNG',
    })
  })

  it('签名或 IHDR 不对就返回 null', () => {
    const bad = png(10, 10)
    bad[0] = 0x00
    expect(parsePngSize(bad)).toBeNull()
    const noIhdr = png(10, 10)
    noIhdr[12] = 0x00
    expect(parsePngSize(noIhdr)).toBeNull()
  })

  it('太短返回 null', () => {
    expect(parsePngSize(new Uint8Array(20))).toBeNull()
  })

  it('parseImageSize 按扩展名分派', () => {
    expect(parseImageSize(png(192, 208), 'spritesheet.png')?.format).toBe('PNG')
    expect(parseImageSize(riff('VP8L', vp8lBody(192, 208)), 'spritesheet.webp')?.format).toBe(
      'VP8L',
    )
    // 大写扩展名也要认
    expect(parseImageSize(png(192, 208), 'SPRITESHEET.PNG')?.format).toBe('PNG')
  })
})

/**
 * ⚠️ 这里**刻意不**去读真实文件。
 *
 * `src/shared/**` 同时被 `tsconfig.web.json`（渲染进程，`types: ["vite/client"]`）
 * 与 `tsconfig.node.json` 检查，所以这个目录里的测试**不能 import `node:fs`**——
 * 渲染进程那一侧没有 Node 类型，会直接编译失败。
 *
 * "拿 Pillow 真写出来的文件验一遍"这条更重要的检查放在
 * `scripts/verify-sprite.mjs` 里：那个脚本本来就跑在 Node 下，
 * 而且它同时验证了整条装配链路（读 pet.json → 校验尺寸 → 切帧 → 判命中）。
 */
describe('与契约的交叉检查', () => {
  it('★ 解析出来的尺寸能直接与图集契约比对（这就是它存在的用途）', () => {
    const size = parseWebpSize(
      riff('VP8L', vp8lBody(CODEX_V2_ATLAS.atlasWidth, CODEX_V2_ATLAS.atlasHeight)),
    )
    expect(size?.width).toBe(CODEX_V2_ATLAS.atlasWidth)
    expect(size?.height).toBe(CODEX_V2_ATLAS.atlasHeight)
    // V1 与 V2 的差别只在行数（高度），宽度相同——所以只比宽度是查不出问题的
    expect(CODEX_V2_ATLAS.atlasWidth).toBe(1536)
    expect(CODEX_V2_ATLAS.atlasHeight).toBe(2288)
  })
})
