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
  body: { cx: 110, cy: 139, rx: 53, ry: 59 },
  earLeft: { cx: 84, cy: 90, r: 19 },
  earRight: { cx: 136, cy: 90, r: 19 },
  // 尾巴只用于核对（宠物本体把它画成"从身后探出的尖椭圆"，
  // 在托盘图标的 16px 尺度上根本看不见，所以图标里不画它）。
  // 保留在核对表里是为了：改尾巴位置时这里会立刻报错，提醒同步。
  tailTip: { cx: 186, cy: 186, r: 16 },
}

/**
 * 图标里**不绘制**尾巴。
 *
 * 原因：尾巴是从身体后面探出的一个小尖椭圆，在 16–32px 的托盘尺度上
 * 只会变成体侧一个模糊的凸起，反而破坏剪影的干净。
 * 托盘图标要的是"一眼认出是它"，不是"细节齐全"。
 */
const DRAW_TAIL_IN_ICON = false

/**
 * 眼睛与腮红的位置。
 *
 * ⚠️ 这两组必须与 `src/shared/palette.ts` 的 `PET_FACE` **保持一致**：
 *    图标得看起来像那只宠物，否则托盘图标就成了一块无关的图形。
 *    它们不做自动核对（`PET_FACE` 不在 PET_GEOMETRY 里、正则也不好取），
 *    所以改宠物五官时**记得回来同步这里**——这一步漏了不会有任何报错。
 */
const EYES = {
  left: { cx: 91, cy: 136, r: 10.5 },
  right: { cx: 129, cy: 136, r: 10.5 },
}

const CHEEKS = {
  left: { cx: 71, cy: 154, rx: 9.5, ry: 6 },
  right: { cx: 149, cy: 154, rx: 9.5, ry: 6 },
}

/** 设计用色：与渲染进程 PixiJS 那边（`src/shared/palette.ts`）同一套。 */
const PALETTE = {
  bodyTop: [232, 238, 245],
  bodyBottom: [185, 199, 217],
  outline: [47, 58, 77],
  eye: [58, 36, 22],
  iris: [217, 138, 63],
  catchlight: [255, 255, 255],
  cheek: [232, 154, 154],
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

/**
 * 尖耳的轮廓，用**与宠物本体完全相同的二次贝塞尔**描述。
 *
 * `PET_GEOMETRY.earLeft/earRight` 存的是**圆**（命中测试用，圆最快也够准），
 * 但视觉上是圆角三角。图标必须与本体同形，否则托盘图标看着像另一个角色。
 *
 * 关键做法：这里不"近似"那条曲线，而是**采样真实曲线**再做点在多边形内判定。
 * 用直线多边形近似会在小尺寸下露出折角（试过，图标上的耳朵是方的）。
 */
function earPath(ear, scale = 1) {
  const { cx, cy, r } = ear
  /** 把比例坐标缩放到目标尺寸。 */
  const at = (dx, dy) => ({ x: cx + dx * r * scale, y: cy + dy * r * scale })

  // 与 PetStage#drawEars 的四段一致
  const p0 = at(-0.92, 0.55)
  const c0 = at(-0.78, -0.85)
  const p1 = at(0, -1.0)
  const c1 = at(0.78, -0.85)
  const p2 = at(0.92, 0.55)

  const points = [p0]
  const STEPS = 12
  // 两段二次贝塞尔：p0 →(c0) p1，p1 →(c1) p2
  for (const [from, ctrl, to] of [
    [p0, c0, p1],
    [p1, c1, p2],
  ]) {
    for (let i = 1; i <= STEPS; i++) {
      const u = i / STEPS
      const inv = 1 - u
      points.push({
        x: inv * inv * from.x + 2 * inv * u * ctrl.x + u * u * to.x,
        y: inv * inv * from.y + 2 * inv * u * ctrl.y + u * u * to.y,
      })
    }
  }
  return points
}

/** 射线法判断点是否在多边形内。 */
function inPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/** 耳朵是否命中。`scale < 1` 得到内耳（同形而缩小）。 */
function inEar(x, y, ear, scale = 1) {
  return inPolygon(x, y, earPath(ear, scale))
}

/** 宠物整体轮廓（身体 ∪ 双耳尖角 ∪ 尾巴）。 */
function inSilhouette(x, y) {
  return (
    inEllipse(x, y, GEOMETRY.body) ||
    inEar(x, y, GEOMETRY.earLeft) ||
    inEar(x, y, GEOMETRY.earRight) ||
    (DRAW_TAIL_IN_ICON && inCircle(x, y, GEOMETRY.tailTip))
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
    // 耳朵用按比例缩小来近似"内缩"，尖角的偏移没法用统一 inset 表达
    inEar(x, y, GEOMETRY.earLeft, 1 - inset / GEOMETRY.earLeft.r) ||
    inEar(x, y, GEOMETRY.earRight, 1 - inset / GEOMETRY.earRight.r) ||
    (DRAW_TAIL_IN_ICON && inCircle(x, y, { ...GEOMETRY.tailTip, r: GEOMETRY.tailTip.r - inset }))
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
  // 五官在最上层（与渲染进程的图层顺序一致：身体 → 腮红 → 眼睛）
  for (const eye of [EYES.left, EYES.right]) {
    // 虹膜（琥珀）在外，瞳孔（深棕）在内，再点一个高光——
    // 与宠物本体同一套画法，托盘图标才不会看起来像另一个角色。
    if (inCircle(x, y, { cx: eye.cx + 1.2, cy: eye.cy + 1.0, r: eye.r * 0.42 })) return PALETTE.eye
    if (inCircle(x, y, { cx: eye.cx + 3.2, cy: eye.cy - 3.8, r: eye.r * 0.22 })) {
      return PALETTE.catchlight
    }
    if (inCircle(x, y, eye)) return PALETTE.iris
  }

  if (!inSilhouette(x, y)) return null

  // 描边 = 轮廓内、但不在"向内收 OUTLINE_WIDTH"的轮廓内
  if (!inInner(x, y, OUTLINE_WIDTH)) return PALETTE.outline

  // 腮红：只在身体上，且要在眼睛下方
  for (const cheek of [CHEEKS.left, CHEEKS.right]) {
    if (inEllipse(x, y, cheek)) return PALETTE.cheek
  }

  // 身体：自上而下的渐变（与 PixiJS 那边的 FillGradient 一致）
  const body = GEOMETRY.body
  const t = Math.min(1, Math.max(0, (y - (body.cy - body.ry)) / (body.ry * 2)))
  // 与渲染一致：0 到 0.58 保持顶部色，之后过渡到底部色
  const k = t <= 0.58 ? 0 : (t - 0.58) / 0.42
  return [
    Math.round(PALETTE.bodyTop[0] + (PALETTE.bodyBottom[0] - PALETTE.bodyTop[0]) * k),
    Math.round(PALETTE.bodyTop[1] + (PALETTE.bodyBottom[1] - PALETTE.bodyTop[1]) * k),
    Math.round(PALETTE.bodyTop[2] + (PALETTE.bodyBottom[2] - PALETTE.bodyTop[2]) * k),
  ]
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
    // ⚠️ 用 `[^{}]*` 而不是 `[^}]*`：后者会**跨过形状边界**，
    //    于是 `tailTip` 的 `cx` 会匹配到文件里第一个 `cx`（也就是 body 的），
    //    核对结果碰巧通过、却完全没在核对它以为在核对的东西。
    //    这个 bug 是靠"故意改错一个字段看它会不会报"发现的——
    //    一个永远为真的守卫比没有守卫更危险。
    const pattern = new RegExp(`${shape}:\\s*\\{[^{}]*${field}:\\s*(-?[\\d.]+)`, 's')
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

  // 窗口尺寸在设计空间里等于设计边长；constants.ts 用 `PET_DESIGN_SIZE` 常量表达，
  // 所以这里核对的是**那个常量的值**，而不是写法。之前写死了
  // `window: { width: <数字> }` 的模式，改成常量引用后就再也匹配不上——
  // 而"守卫因为被守卫的代码换了写法而失效"正是最该避免的一类静默失效。
  const designSizeMatch = /export\s+const\s+PET_DESIGN_SIZE\s*=\s*(\d+)/.exec(source)
  if (!designSizeMatch) {
    problems.push('constants.ts 里找不到 PET_DESIGN_SIZE 的值')
  } else if (Number(designSizeMatch[1]) !== DESIGN_SIZE) {
    problems.push(`PET_DESIGN_SIZE 是 ${designSizeMatch[1]}，本脚本按 ${DESIGN_SIZE} 绘制`)
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
