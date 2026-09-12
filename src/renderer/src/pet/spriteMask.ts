import { frameRect, type CodexAnimationName, type PetSpriteAtlas } from '@shared/petAtlas'
import {
  ALPHA_THRESHOLD,
  encodeMaskRow,
  FULL_CELL_GRID,
  MASK_COLS,
  MASK_ROWS,
  type AnimationMask,
  type MaskGrid,
  type SpriteMask,
} from '@shared/spriteMask'

/**
 * 从图集的像素里提取 **alpha 命中蒙版** —— 纯函数，可单测。
 *
 * ── 它解决的矛盾 ──
 *
 * 命中判定在**主进程**（那里每 80ms 轮询光标），而图集在**渲染进程**
 * （那里才有解码后的像素）。所以剪影必须从这边传到那边，
 * 用的网格定义与位序来自 `@shared/spriteMask`（两边同一份）。
 *
 * 不能传整张图（1536×2288×4 ≈ 14MB），所以下采样成点阵，
 * 9 个动作合计约 600 字节。
 *
 * ── ⚠️ 这里唯一的采样常量：STRIDE ──
 *
 * 采样步长是**假阴性**与**开机耗时**之间的取舍。点阵在整格上是
 * 13×16，一点约 14.8×13 像素。若在点内隔 16 像素采一次，
 * 一条**宽不到 16 像素的细肢体**（尾巴尖、胡须、抬起的爪子）
 * 可能整条落在采样点之间 → 那个点亮不起来 → 用户"点尾巴没反应"。
 *
 * 这属于**系统性**缺陷（不是偶发），所以宁可多花点时间：
 * 步长取 4，即一点内约 3.7×3.3 个采样点。整张图集的采样量
 * 约 15 万次读像素，开机时一次，实测量级在几十毫秒。
 */
const STRIDE = 4

/**
 * 计算点阵区域时的对齐粒度（精灵像素）。
 *
 * 区域边界会吸附到这个粒度上，这样同一批素材每次运行的网格都一样——
 * 蒙版跨进程传输、验证脚本复算时才有可比性。
 */
const GRID_SNAP = 4

/**
 * 点阵区域的最小跨度（精灵像素）。
 *
 * 区域太小时点会变粗，判定就退化成"一大块都算命中"。
 * 取 `4 × 列数` / `4 × 行数` 的最小倍数，保证点不大于约 16 像素。
 */
const MIN_GRID_WIDTH = MASK_COLS * 4
const MIN_GRID_HEIGHT = MASK_ROWS * 4

/**
 * 区域相对内容边界的留白（精灵像素）。
 *
 * 0 会导致"边缘那一列点只有半个点宽"——轮廓刻意画到格子边上时，
 * 最外侧的像素落在网格之外，表现为"最边上一条点不到"。
 */
const GRID_PADDING = 8

/** 图集像素数据（与 `ImageData` 同形，但不依赖 DOM，便于单测）。 */
export interface PixelSource {
  readonly width: number
  readonly height: number
  /** RGBA，每像素 4 字节。 */
  readonly data: Uint8ClampedArray | Uint8Array
}

/** 读某点的 alpha；越界返回 0（透明），不抛错。 */
function alphaAt(pixels: PixelSource, x: number, y: number): number {
  const px = Math.trunc(x)
  const py = Math.trunc(y)
  if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) return 0
  return pixels.data[(py * pixels.width + px) * 4 + 3] ?? 0
}

/** 一个矩形（精灵像素）。 */
interface PixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 一个动作第 0..frames-1 帧覆盖的列范围。 */
function rowRect(atlas: PetSpriteAtlas, animation: CodexAnimationName, frames: number): PixelRect {
  const spec = atlas.animations[animation]
  const safeFrames = Math.max(1, Math.min(frames, spec.frames))
  return {
    x: 0,
    y: spec.row * atlas.cellHeight,
    width: safeFrames * atlas.cellWidth,
    height: atlas.cellHeight,
  }
}

/**
 * 一个动作的可用帧数：从第 0 列起连续有多少列**非空**。
 *
 * 与 `hatch-pet` 校验器的"占格扫描"同一套判据（它要求
 * `col < expected` 的格必须非空、其余必须全空）。
 * 这里宽松一些：只要求"用到的那几列非空"，多出来的列不报错。
 */
export function countFramesInRow(
  pixels: PixelSource,
  atlas: PetSpriteAtlas,
  animation: CodexAnimationName,
): number {
  const spec = atlas.animations[animation]
  let count = 0
  for (let col = 0; col < spec.frames; col++) {
    const rect = frameRect(atlas, animation, col)
    if (cellIsEmpty(pixels, rect)) break
    count++
  }
  return count
}

/** 一格（或一段连续格）是否完全透明。 */
function cellIsEmpty(pixels: PixelSource, rect: PixelRect): boolean {
  // 与提取蒙版用同一个 STRIDE：判据一致，才能保证"扫出来非空"的格
  // 一定能在蒙版里点亮至少一个点。
  for (let y = rect.y; y < rect.y + rect.height; y += STRIDE) {
    for (let x = rect.x; x < rect.x + rect.width; x += STRIDE) {
      if (alphaAt(pixels, x, y) >= ALPHA_THRESHOLD) return false
    }
  }
  return true
}

/**
 * 全部动作所有有效帧的**并集边界**（相对格子左上角，精灵像素）。
 *
 * 返回 `null` 表示整张图集所有帧都是空的（素材坏了）。
 *
 * 为什么按"全部动作"取并集而不是每个动作各算一个区域：
 * 区域是随蒙版一起传的**一个**字段。若每个动作各有区域，
 * 要么改协议，要么让主进程按动作切换基准——前者简单得多。
 * 代价是"某个动作只占很小一块时，它的点会偏粗"，
 * 这对桌宠可接受（同一只宠物各动作的占地本来就差不多）。
 */
export function dwellBounds(
  pixels: PixelSource,
  atlas: PetSpriteAtlas,
  availableFrames: Partial<Record<CodexAnimationName, number>>,
): PixelRect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
    const frames = availableFrames[name] ?? atlas.animations[name].frames
    if (frames <= 0) continue
    const rect = rowRect(atlas, name, frames)
    for (let y = rect.y; y < rect.y + rect.height; y += STRIDE) {
      for (let x = rect.x; x < rect.x + rect.width; x += STRIDE) {
        if (alphaAt(pixels, x, y) < ALPHA_THRESHOLD) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null

  // ★ 换算到"相对格子左上角"。
  //
  // 绝不能只对 y 减一次行偏移：图集有 11 行，扫描会在**所有行**上跑，
  // minY 落在哪一行都不一定，而 x 同样要取模（帧越靠右，x 越大）。
  // 取模之后得到的才是"宠物在单格里的占地"，这才是点阵网格要覆盖的区域。
  const cellX = minX % atlas.cellWidth
  const cellY = minY % atlas.cellHeight
  return {
    x: cellX,
    y: cellY,
    // 模运算会让跨界的内容"折回"，于是宽度可能算多——多算只会让
    // 区域偏大（判定点偏粗），少算才会切掉轮廓，所以取保守的一侧。
    width: Math.min(maxX - minX + 1, atlas.cellWidth),
    height: Math.min(maxY - minY + 1, atlas.cellHeight),
  }
}

/**
 * 由内容边界算出点阵区域。
 *
 * 步骤：加留白 → 吸附到 `GRID_SNAP` → 撑到最小跨度 → 钳进格子。
 * 钳进格子时会**向另一侧扩**（而不是缩），免得内容刚好贴着边时
 * 把最外一圈切掉。
 */
export function selectMaskGrid(
  atlas: PetSpriteAtlas,
  bounds: PixelRect | null,
): MaskGrid {
  if (!bounds) return FULL_CELL_GRID

  const snap = (value: number): number => Math.round(value / GRID_SNAP) * GRID_SNAP

  let width = Math.max(MIN_GRID_WIDTH, snap(bounds.width + GRID_PADDING * 2))
  let height = Math.max(MIN_GRID_HEIGHT, snap(bounds.height + GRID_PADDING * 2))
  width = Math.min(width, atlas.cellWidth)
  height = Math.min(height, atlas.cellHeight)

  // 以内容中心为中心摆放
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  let x = snap(centerX - width / 2)
  let y = snap(centerY - height / 2)

  // 钳进格子，并向另一侧扩（保持跨度）
  if (x < 0) x = 0
  if (y < 0) y = 0
  if (x + width > atlas.cellWidth) x = atlas.cellWidth - width
  if (y + height > atlas.cellHeight) y = atlas.cellHeight - height

  return { x, y, width, height }
}

/**
 * 把一个动作**所有有效帧的并集**下采样成蒙版。
 *
 * 并集而不是取中间帧：抬手/抬脚的帧会超出静止帧的范围，
 * 取并集能保证"看得见的都能点"，代价是"极少数只在一帧出现的
 * 空隙点不到"。两害相权，前者更不容易被用户察觉。
 */
export function extractAnimationMask(
  pixels: PixelSource,
  atlas: PetSpriteAtlas,
  animation: CodexAnimationName,
  frames: number,
  grid: MaskGrid,
): AnimationMask {
  const rows: string[] = []
  const frameCount = Math.max(1, Math.min(frames, atlas.animations[animation].frames))
  const rowTop = atlas.animations[animation].row * atlas.cellHeight

  for (let row = 0; row < MASK_ROWS; row++) {
    const bits: boolean[] = []
    // 该行覆盖的精灵像素范围（相对格子左上角）
    const y0 = grid.y + (row * grid.height) / MASK_ROWS
    const y1 = grid.y + ((row + 1) * grid.height) / MASK_ROWS

    for (let col = 0; col < MASK_COLS; col++) {
      const x0 = grid.x + (col * grid.width) / MASK_COLS
      const x1 = grid.x + ((col + 1) * grid.width) / MASK_COLS

      let hit = false
      for (let frame = 0; frame < frameCount && !hit; frame++) {
        // ★ 帧内位置 = 帧在图集里的左上角 + 格内偏移。
        //   横向偏移随帧号推进，纵向只由该动作所在行决定——写成
        //   `host.y + y` 会把"格内 y"和"整图 y"混起来（11 行图集上
        //   第 5 行会偏出 5 个格高，扫到别的动作上去）。
        const originX = frame * atlas.cellWidth
        for (let y = y0; y < y1 && !hit; y += STRIDE) {
          for (let x = x0; x < x1; x += STRIDE) {
            if (alphaAt(pixels, originX + x, rowTop + y) >= ALPHA_THRESHOLD) {
              hit = true
              break
            }
          }
        }
      }
      bits.push(hit)
    }
    rows.push(encodeMaskRow(bits))
  }

  return { rows }
}

/**
 * 提取整套蒙版（全部标准动作）。
 *
 * @param availableFrames 每个动作实际可用的帧数；缺省按契约帧数。
 *        传 0 的动作会被跳过（图集里没这个动作）。
 */
export function extractSpriteMask(options: {
  readonly pixels: PixelSource
  readonly atlas: PetSpriteAtlas
  readonly availableFrames?: Partial<Record<CodexAnimationName, number>>
}): SpriteMask {
  const { pixels, atlas } = options
  const availableFrames = options.availableFrames ?? {}

  // 缺省的可用帧数要先补齐，否则 dwellBounds 与下面的循环会用不同的帧集
  const frames: Partial<Record<CodexAnimationName, number>> = {}
  for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
    frames[name] = availableFrames[name] ?? atlas.animations[name].frames
  }

  const grid = selectMaskGrid(atlas, dwellBounds(pixels, atlas, frames))

  const masks: Partial<Record<CodexAnimationName, AnimationMask>> = {}
  for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
    const count = frames[name] ?? 0
    if (count <= 0) continue
    masks[name] = extractAnimationMask(pixels, atlas, name, count, grid)
  }

  return { kind: 'sprite', atlasVersion: atlas.version, grid, masks }
}
