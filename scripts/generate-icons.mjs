/**
 * 程序化生成托盘图标与应用图标。
 *
 * ── 为什么要"生成"而不是"放一张图" ──
 *
 * 图标与宠物的几何定义**同源**：同一个椭圆身体、同一对耳朵、同一双眼睛。
 * 这样改了宠物形状后重跑本脚本，图标跟着变，不会出现
 * "图标和宠物长得不一样"这种漂移。手绘位图做不到这一点。
 *
 * 另外它让仓库里不需要出现"来源不明的二进制素材"——
 * 所有图形都由代码描述，许可证干净。
 *
 * ── 用法 ──
 *
 *   node scripts/generate-icons.mjs
 *
 * 产物（已提交进仓库，打包时直接用，因此开发机不需要跑这一步）：
 *   resources/icons/tray.png        32×32   托盘图标
 *   resources/icons/icon-256.png    256×256 打包用应用图标
 *
 * ── 零依赖 ──
 *
 * PNG 编码用 Node 内置 zlib 手写（IHDR/IDAT/IEND + CRC32）。
 * 不引入 sharp / canvas：本机没有 C++ 编译器，原生图形库装不上，
 * 而这个需求（几种纯色椭圆的合成）远没到需要图形库的复杂度。
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

// ────────────────────────────────────────────────────────────────────────────
// 宠物几何：与 src/shared/constants.ts 的 PET_GEOMETRY 保持一致
// ────────────────────────────────────────────────────────────────────────────

/**
 * 这里是 `src/shared/constants.ts` 里 `PET_GEOMETRY` 的**镜像**。
 *
 * 之所以镜像而不是 import：本脚本是 `.mjs`（构建期工具），
 * 而几何定义在 `.ts` 里，直接 import 需要额外的转译步骤。
 *
 * 为了防止漂移，脚本启动时会**读真源并逐字段核对**，
 * 不一致就直接报错退出（见 assertGeometryInSync）。
 */
const DESIGN_SIZE = 220

const GEOMETRY = {
  body: { cx: 110, cy: 138, rx: 56, ry: 60 },
  earLeft: { cx: 80, cy: 86, r: 20 },
  earRight: { cx: 140, cy: 86, r: 20 },
  tailTip: { cx: 172, cy: 166, r: 18 },
}

/** 眼睛位置与大小不在 PET_GEOMETRY 里（命中测试不需要它们），此处自行定义。 */
const EYES = {
  left: { cx: 90, cy: 134, r: 9 },
  right: { cx: 130, cy: 134, r: 9 },
}

/** 设计用色：与渲染进程 PixiJS 那边保持同一套。 */
const PALETTE = {
  body: [255, 244, 214],
  outline: [90, 70, 50],
  eye: [58, 44, 32],
  cheek: [255, 176, 168],
}

// ────────────────────────────────────────────────────────────────────────────
// 几何判定
// ────────────────────────────────────────────────────────────────────────────

function inEllipse(x, y, e) {
  const dx = (x - e.cx) / e.rx
  const dy = (y - e.cy) / e.ry
  return dx * dx + dy * dy <= 1
}

function inCircle(x, y, c) {
  const dx = x - c.cx
  const dy = y - c.cy
  return dx * dx + dy * dy <= c.r * c.r
}

/** 宠物整体轮廓（身体 ∪ 双耳 ∪ 尾巴）。 */
function inSilhouette(x, y) {
  return (
    inEllipse(x, y, GEOMETRY.body) ||
    inCircle(x, y, GEOMETRY.earLeft) ||
    inCircle(x, y, GEOMETRY.earRight) ||
    inCircle(x, y, GEOMETRY.tailTip)
  )
}

/** 内缩的轮廓，用来画描边：内层填充色，外层留作描边。 */
function inInner(x, y, inset) {
  return (
    inEllipse(x, y, {
      cx: GEOMETRY.body.cx,
      cy: GEOMETRY.body.cy,
      rx: GEOMETRY.body.rx - inset,
      ry: GEOMETRY.body.ry - inset,
    }) ||
    inCircle(x, y, { ...GEOMETRY.earLeft, r: GEOMETRY.earLeft.r - inset }) ||
    inCircle(x, y, { ...GEOMETRY.earRight, r: GEOMETRY.earRight.r - inset }) ||
    inCircle(x, y, { ...GEOMETRY.tailTip, r: GEOMETRY.tailTip.r - inset })
  )
}

// ────────────────────────────────────────────────────────────────────────────
// 光栅化（超采样抗锯齿）
// ────────────────────────────────────────────────────────────────────────────

const SUBSAMPLES = 4

/**
 * 把 220×220 设计坐标系下的一帧渲染成 RGBA 像素。
 *
 * 每像素做 SUBSAMPLES² 次采样并按覆盖率混合，得到带 alpha 的平滑边缘。
 * 对"几个纯色椭圆"这种图形，这比引入任何图形库都简单且结果一致。
 */
function rasterize(size) {
  const pixels = new Uint8Array(size * size * 4)
  const scale = size / DESIGN_SIZE

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0

      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const fx = (px + (sx + 0.5) / SUBSAMPLES) / scale
          const fy = (py + (sy + 0.5) / SUBSAMPLES) / scale

          const sample = sampleColor(fx, fy)
          if (!sample) continue

          r += sample[0]
          g += sample[1]
          b += sample[2]
          hits++
        }
      }

      if (hits === 0) continue

      // 颜色 = 命中样本的均值；alpha = 覆盖率（命中数 / 总采样数）。
      // 注意两者用的除数不同：颜色除以 hits，alpha 除以总数。
      const total = SUBSAMPLES * SUBSAMPLES
      const idx = (py * size + px) * 4
      pixels[idx] = Math.round(r / hits)
      pixels[idx + 1] = Math.round(g / hits)
      pixels[idx + 2] = Math.round(b / hits)
      pixels[idx + 3] = Math.round((hits / total) * 255)
    }
  }

  return pixels
}

/** 描边宽度（以设计坐标 220 计）。 */
const OUTLINE_WIDTH = 1.8

/** 返回该设计坐标点的颜色；`null` = 透明。 */
function sampleColor(x, y) {
  // 眼睛在最上层
  if (inCircle(x, y, EYES.left) || inCircle(x, y, EYES.right)) return PALETTE.eye

  if (!inSilhouette(x, y)) return null

  // 描边 = 轮廓内、但不在"向内收 OUTLINE_WIDTH"的轮廓内
  if (!inInner(x, y, OUTLINE_WIDTH)) return PALETTE.outline

  return PALETTE.body
}

// ────────────────────────────────────────────────────────────────────────────
// PNG 编码（零依赖）
// ────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type 6 = RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ────────────────────────────────────────────────────────────────────────────
// 防漂移自检
// ────────────────────────────────────────────────────────────────────────────

/**
 * 读 `src/shared/constants.ts` 的真源，逐字段核对本脚本的镜像。
 *
 * 这是本脚本唯一"聪明"的地方：它让"改了宠物几何但忘了重新生成图标"
 * 变成一次**响亮的构建失败**，而不是一个没人注意到的视觉不一致。
 */
function assertGeometryInSync() {
  const source = readFileSync(join(rootDir, 'src', 'shared', 'constants.ts'), 'utf8')

  const expectations = [
    ['body', 'cx', GEOMETRY.body.cx],
    ['body', 'cy', GEOMETRY.body.cy],
    ['body', 'rx', GEOMETRY.body.rx],
    ['body', 'ry', GEOMETRY.body.ry],
    ['earLeft', 'cx', GEOMETRY.earLeft.cx],
    ['earLeft', 'cy', GEOMETRY.earLeft.cy],
    ['earLeft', 'r', GEOMETRY.earLeft.r],
    ['earRight', 'cx', GEOMETRY.earRight.cx],
    ['earRight', 'cy', GEOMETRY.earRight.cy],
    ['earRight', 'r', GEOMETRY.earRight.r],
    ['tailTip', 'cx', GEOMETRY.tailTip.cx],
    ['tailTip', 'cy', GEOMETRY.tailTip.cy],
    ['tailTip', 'r', GEOMETRY.tailTip.r],
  ]

  const problems = []
  for (const [shape, field, expected] of expectations) {
    const pattern = new RegExp(`${shape}:\\s*\\{[^}]*${field}:\\s*(-?[\\d.]+)`, 's')
    const match = pattern.exec(source)
    if (!match) {
      problems.push(`PET_GEOMETRY.${shape}.${field} 在 constants.ts 里找不到（正则未命中）`)
      continue
    }
    if (Number(match[1]) !== expected) {
      problems.push(
        `PET_GEOMETRY.${shape}.${field}: constants.ts 是 ${match[1]}，本脚本是 ${expected}`,
      )
    }
  }

  const windowMatch = /window:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)/s.exec(source)
  if (!windowMatch) {
    problems.push('PET_GEOMETRY.window 在 constants.ts 里找不到')
  } else if (Number(windowMatch[1]) !== DESIGN_SIZE || Number(windowMatch[2]) !== DESIGN_SIZE) {
    problems.push(
      `PET_GEOMETRY.window 是 ${windowMatch[1]}×${windowMatch[2]}，本脚本按 ${DESIGN_SIZE}×${DESIGN_SIZE} 绘制`,
    )
  }

  if (problems.length > 0) {
    console.error('✗ 图标生成脚本与 src/shared/constants.ts 的宠物几何已漂移：')
    for (const p of problems) console.error(`   - ${p}`)
    console.error('\n请同步本脚本顶部的 GEOMETRY 常量后重跑。')
    process.exit(1)
  }
}

// ────────────────────────────────────────────────────────────────────────────

function main() {
  assertGeometryInSync()

  const outDir = join(rootDir, 'resources', 'icons')
  mkdirSync(outDir, { recursive: true })

  const targets = [
    { name: 'tray.png', size: 32 },
    { name: 'icon-256.png', size: 256 },
  ]

  for (const target of targets) {
    const pixels = rasterize(target.size)
    const png = encodePng(target.size, target.size, pixels)
    const path = join(outDir, target.name)
    writeFileSync(path, png)
    console.log(`✓ ${target.name}  ${target.size}×${target.size}  ${png.length} 字节`)
  }

  console.log(`\n已写入 ${outDir}`)
}

main()
