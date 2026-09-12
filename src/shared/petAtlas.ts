/**
 * Codex 桌宠精灵图集的格式契约 —— **纯数据 + 纯函数，可单测**。
 *
 * ── 这份规范从哪来 ──
 *
 * 不是猜的，也不是我从参考图量的。它来自 Codex 官方 `hatch-pet-v2` skill 里的
 * `references/codex-pet-contract.md` 与 `references/animation-rows.md`
 * （随 `legeling/awesome-codex-pet` 一并分发，Apache-2.0）。
 * 校验器 `validate_pet_package.py` 的硬判据也逐条抄在这里，见 `validateAtlas`。
 *
 * ── 为什么值得单独一个文件 ──
 *
 * 与 `PET_GEOMETRY` 同级：它是"精灵图长什么样"的**唯一真相**。
 * 渲染器、命中蒙版提取、验证脚本、图集生成器全部读它，
 * 于是"渲染的格"与"判定命中用的格"不可能漂移——这正是本项目在
 * `docs/RECON.md` 里记过的头号 bug 来源（命中区与可见形象脱节）。
 *
 * ⚠️ **不要把这份契约与我们的 `PET_GEOMETRY` 混起来**：
 *    - `PET_GEOMETRY` 描述**程序化小奇**的形状（椭圆并集），用于几何命中；
 *    - 这里描述**图集**的网格，用于纹理切帧与 alpha 蒙版命中。
 *    两者是两条独立的渲染后端，各自与自己的命中方式配套。
 */

/** 图集版本。V2 比 V1 多两行（16 个注视方向）。 */
export type SpriteVersion = 1 | 2

/** 标准动作名（行 0–8）。**名字就是契约**，不要自创同义词。 */
export type CodexAnimationName =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

/** 一个动作的定义。 */
export interface AnimationSpec {
  /** 所在行（0 基）。 */
  readonly row: number
  /** 有效帧数（从第 0 列起）。 */
  readonly frames: number
  /**
   * 每帧显示时长（毫秒），长度等于 `frames`。
   *
   * ⚠️ 这张表**在我们这边**，不在图集里 —— 规范明确写着
   * 「客户端不读取自定义逐帧时长」。所以换图集时节奏不变，
   * 而换节奏必须改这里的代码（这是刻意的：节奏属于宿主，不属于素材）。
   */
  readonly frameDurations: readonly number[]
}

/** 图集契约。 */
export interface PetSpriteAtlas {
  readonly version: SpriteVersion
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  /** 图集应有的像素尺寸（由网格推出，供校验与生成使用）。 */
  readonly atlasWidth: number
  readonly atlasHeight: number
  readonly animations: Readonly<Record<CodexAnimationName, AnimationSpec>>
}

/** 8 个标准动作（行 0–8）。帧数与时长照抄规范。 */
const STANDARD_ANIMATIONS = {
  idle: { row: 0, frames: 6, frameDurations: [280, 110, 110, 140, 140, 320] },
  'running-right': {
    row: 1,
    frames: 8,
    frameDurations: [120, 120, 120, 120, 120, 120, 120, 220],
  },
  'running-left': {
    row: 2,
    frames: 8,
    frameDurations: [120, 120, 120, 120, 120, 120, 120, 220],
  },
  waving: { row: 3, frames: 4, frameDurations: [140, 140, 140, 280] },
  jumping: { row: 4, frames: 5, frameDurations: [140, 140, 140, 140, 280] },
  failed: {
    row: 5,
    frames: 8,
    frameDurations: [140, 140, 140, 140, 140, 140, 140, 240],
  },
  waiting: { row: 6, frames: 6, frameDurations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, frames: 6, frameDurations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, frames: 6, frameDurations: [150, 150, 150, 150, 150, 280] },
} as const satisfies Record<CodexAnimationName, AnimationSpec>

/** 单格尺寸（规范硬要求，V1/V2 相同）。 */
export const CELL_WIDTH = 192
export const CELL_HEIGHT = 208

/** 注视方向的行号。 */
export const LOOK_ROW_A = 9
export const LOOK_ROW_B = 10

/**
 * 16 个顺时针注视方向（度）。
 *
 * ⚠️ `0` 表示**正上**（12 点钟），**不是**"正面"。
 *    正面是"无向量的死区"，回落到普通 idle。
 *    这条很容易搞反——搞反的表现是"光标在正上方时它看着你"，很微妙但错。
 */
export const LOOK_DIRECTIONS = [
  0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5,
] as const

export type LookDirection = (typeof LOOK_DIRECTIONS)[number]

/** V1：8 列 × 9 行，只有标准动作。 */
export const CODEX_V1_ATLAS: PetSpriteAtlas = {
  version: 1,
  columns: 8,
  rows: 9,
  cellWidth: CELL_WIDTH,
  cellHeight: CELL_HEIGHT,
  atlasWidth: CELL_WIDTH * 8,
  atlasHeight: CELL_HEIGHT * 9,
  animations: STANDARD_ANIMATIONS,
}

/** V2：8 列 × 11 行，多出两行注视方向。 */
export const CODEX_V2_ATLAS: PetSpriteAtlas = {
  version: 2,
  columns: 8,
  rows: 11,
  cellWidth: CELL_WIDTH,
  cellHeight: CELL_HEIGHT,
  atlasWidth: CELL_WIDTH * 8,
  atlasHeight: CELL_HEIGHT * 11,
  animations: STANDARD_ANIMATIONS,
}

/** 按版本取契约。 */
export function atlasForVersion(version: SpriteVersion): PetSpriteAtlas {
  return version === 2 ? CODEX_V2_ATLAS : CODEX_V1_ATLAS
}

/** 一个动作在纹理里的矩形（像素）。 */
export interface FrameRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 取某一帧在图集里的矩形。
 *
 * 越界时**钳到有效范围**而不是抛错：调用方（渲染器）每帧都会调用它，
 * 一个越界索引不该让整只宠物消失。真正的越界会被 `validateAtlas` 提前发现。
 */
export function frameRect(
  atlas: PetSpriteAtlas,
  animation: CodexAnimationName,
  frameIndex: number,
): FrameRect {
  const spec = atlas.animations[animation]
  const safeFrame = Math.min(Math.max(0, Math.trunc(frameIndex)), Math.max(0, spec.frames - 1))
  return {
    x: safeFrame * atlas.cellWidth,
    y: spec.row * atlas.cellHeight,
    width: atlas.cellWidth,
    height: atlas.cellHeight,
  }
}

/** 某个注视方向在图集里的位置。 */
export function lookFrameRect(atlas: PetSpriteAtlas, direction: LookDirection): FrameRect | null {
  // V1 没有注视行
  if (atlas.version < 2) return null
  const index = LOOK_DIRECTIONS.indexOf(direction)
  if (index < 0) return null
  const row = index < 8 ? LOOK_ROW_A : LOOK_ROW_B
  const column = index % 8
  return {
    x: column * atlas.cellWidth,
    y: row * atlas.cellHeight,
    width: atlas.cellWidth,
    height: atlas.cellHeight,
  }
}

/**
 * 由角度求最近的注视方向。
 *
 * @param degrees 0 = 正上，顺时针增加（与 `LOOK_DIRECTIONS` 同一约定）
 *
 * 这是"光标跟着转"的入口。它与 `gazeOffset`（程序化宠物用）是两条独立实现：
 * 那个算的是瞳孔偏移像素，这个算的是**换哪一格**。
 */
export function nearestLookDirection(degrees: number): LookDirection {
  if (!Number.isFinite(degrees)) return 0
  const step = 360 / LOOK_DIRECTIONS.length
  // 规范化到 [0, 360)
  const normalized = ((degrees % 360) + 360) % 360
  const index = Math.round(normalized / step) % LOOK_DIRECTIONS.length
  return LOOK_DIRECTIONS[index] ?? 0
}

/** 一个动作循环一轮的总时长（毫秒）。 */
export function animationDuration(atlas: PetSpriteAtlas, animation: CodexAnimationName): number {
  const spec = atlas.animations[animation]
  return spec.frameDurations.reduce((sum, ms) => sum + ms, 0)
}

/**
 * 由"已经过去多久"求当前帧号。**纯函数，假时钟可测**。
 *
 * 循环播放（所有标准动作都是循环的）。
 * `elapsedMs` 为负或非有限时返回 0——不抛错，避免一个坏时钟让宠物消失。
 */
export function frameAt(
  atlas: PetSpriteAtlas,
  animation: CodexAnimationName,
  elapsedMs: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const spec = atlas.animations[animation]
  const total = animationDuration(atlas, animation)
  if (total <= 0) return 0

  let cursor = elapsedMs % total
  for (let i = 0; i < spec.frames; i++) {
    const duration = spec.frameDurations[i] ?? 0
    if (cursor < duration) return i
    cursor -= duration
  }
  // 浮点边界兜底：落回最后一帧而不是越界
  return Math.max(0, spec.frames - 1)
}

/** 校验结果。`usable` 为 false 时调用方应回落到程序化宠物。 */
export interface AtlasValidation {
  readonly usable: boolean
  /** 致命问题（图集根本不能用）。 */
  readonly errors: readonly string[]
  /**
   * 非致命问题（能降级使用）。
   *
   * ⚠️ 与参考实现的关键差别：`hatch-pet` 的校验器是**严格**的，
   * 不合格直接拒绝——因为它是**创作工具**，要保证产出合规。
   * 我们是**运行时宿主**，用户丢进来一个略有瑕疵的图集时，
   * 正确反应是"尽量用起来 + 说清楚哪里不对"，而不是黑屏。
   */
  readonly warnings: readonly string[]
}

/**
 * 按规范校验图集元数据。
 *
 * 判据逐条对齐 `validate_pet_package.py`（但它还需要真实像素，
 * 那部分在 `scripts/verify-sprite.mjs` 里用像素断言覆盖）。
 */
export function validateAtlas(input: {
  readonly version: SpriteVersion
  readonly width: number
  readonly height: number
  /** 每个动作实际可用的帧数（由像素占格扫描得出）。缺省表示不检查。 */
  readonly availableFrames?: Partial<Record<CodexAnimationName, number>>
}): AtlasValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const atlas = atlasForVersion(input.version)

  if (input.width !== atlas.atlasWidth || input.height !== atlas.atlasHeight) {
    errors.push(
      `图集尺寸应为 ${String(atlas.atlasWidth)}×${String(atlas.atlasHeight)}，实际 ${String(
        input.width,
      )}×${String(input.height)}`,
    )
  }

  // 帧数不足 → 降级（不是致命）
  const available = input.availableFrames
  if (available) {
    for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
      const have = available[name]
      if (have === undefined) continue
      const need = atlas.animations[name].frames
      if (have < need) {
        warnings.push(
          `动作 ${name} 只有 ${String(have)} 帧，规范要求 ${String(need)} 帧（按实际帧数播放）`,
        )
      }
    }
  }

  return { usable: errors.length === 0, errors, warnings }
}

/**
 * 把"实际可用帧数"钳进动作定义。
 *
 * 用于宽容降级：图集某个动作少画了两帧时，按实际帧数播放，
 * 而不是播放到空白的透明格（那看起来像宠物在闪）。
 */
export function clampFrames(spec: AnimationSpec, availableFrames: number): AnimationSpec {
  if (!Number.isFinite(availableFrames) || availableFrames <= 0) return spec
  const frames = Math.min(spec.frames, Math.trunc(availableFrames))
  if (frames === spec.frames) return spec
  return { ...spec, frames, frameDurations: spec.frameDurations.slice(0, frames) }
}
