import { describe, expect, it } from 'vitest'

import { CODEX_V1_ATLAS, CODEX_V2_ATLAS, type CodexAnimationName } from '@shared/petAtlas'
import {
  ALPHA_THRESHOLD,
  decodeMaskRow,
  hasMask,
  hitTestSpriteMask,
  MASK_COLS,
  MASK_ROWS,
  validateMask,
  type MaskGrid,
} from '@shared/spriteMask'
import {
  countFramesInRow,
  dwellBounds,
  extractAnimationMask,
  extractSpriteMask,
  selectMaskGrid,
  type PixelSource,
} from './spriteMask'

/**
 * 蒙版提取的测试。
 *
 * ── 为什么这些测试值得写 ──
 *
 * 提取出来的点阵**看不见**。它错的时候不会崩、不会警告，只会表现为
 * "点猫耳朵没反应"或者"点猫旁边的空气有反应"。这类缺陷在人工试用时
 * 极难定位（你会先怀疑鼠标、再怀疑缩放），所以必须在这里用
 * **已知形状 → 已知位**的断言钉住。
 *
 * 因此下面的图集是**手工摆的**：形状的位置精确到像素，
 * 断言直接由坐标算出来，不抄实现里的中间量。
 */

const ATLAS = CODEX_V1_ATLAS
const CW = ATLAS.cellWidth
const CH = ATLAS.cellHeight

/** 造一张空图集画布。 */
function blankAtlas(atlas = ATLAS): { pixels: PixelSource; canvas: Uint8ClampedArray } {
  const canvas = new Uint8ClampedArray(atlas.atlasWidth * atlas.atlasHeight * 4)
  return { pixels: { width: atlas.atlasWidth, height: atlas.atlasHeight, data: canvas }, canvas }
}

/** 在画布上刷一个实心圆（alpha = 255）。 */
function paintCircle(
  pixels: PixelSource,
  cx: number,
  cy: number,
  radius: number,
  alpha = 255,
): void {
  const data = pixels.data as Uint8ClampedArray
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > radius * radius) continue
      const offset = (y * pixels.width + x) * 4
      data[offset] = 200
      data[offset + 1] = 100
      data[offset + 2] = 50
      data[offset + 3] = alpha
    }
  }
}

/**
 * 在图集里放一只"假的宠物"：每个动作的前 `frames` 格各画一个圆，
 * 圆心落在格内 `(cx, cy)`（相对格子左上角）。
 */
function paintPet(
  pixels: PixelSource,
  opts: {
    readonly animation: CodexAnimationName
    readonly frames: number
    readonly cx: number
    readonly cy: number
    readonly radius: number
    readonly atlas?: typeof ATLAS
  },
): void {
  const atlas = opts.atlas ?? ATLAS
  const row = atlas.animations[opts.animation].row
  for (let col = 0; col < opts.frames; col++) {
    paintCircle(pixels, col * CW + opts.cx, row * CH + opts.cy, opts.radius)
  }
}

describe('countFramesInRow：占格扫描', () => {
  it('连续非空格的数量就是可用帧数', () => {
    const { pixels } = blankAtlas()
    paintPet(pixels, { animation: 'idle', frames: 3, cx: 96, cy: 104, radius: 40 })
    expect(countFramesInRow(pixels, ATLAS, 'idle')).toBe(3)
  })

  it('空图集算 0 帧', () => {
    const { pixels } = blankAtlas()
    expect(countFramesInRow(pixels, ATLAS, 'idle')).toBe(0)
  })

  it('★ 中间断一格就停（契约要求帧从第 0 列起连续）', () => {
    const { pixels } = blankAtlas()
    // 只画第 0 与第 2 格，跳过第 1 格
    paintCircle(pixels, CW / 2, CH / 2, 40)
    paintCircle(pixels, 2 * CW + CW / 2, CH / 2, 40)
    expect(countFramesInRow(pixels, ATLAS, 'idle')).toBe(1)
  })

  it('★ 只有极淡的抗锯齿残影不算非空（阈值以下）', () => {
    const { pixels } = blankAtlas()
    paintCircle(pixels, CW / 2, CH / 2, 40, ALPHA_THRESHOLD - 1)
    expect(countFramesInRow(pixels, ATLAS, 'idle')).toBe(0)
    // 恰好等于阈值算非空（判据是 >=）
    paintCircle(pixels, CW / 2, CH / 2, 40, ALPHA_THRESHOLD)
    expect(countFramesInRow(pixels, ATLAS, 'idle')).toBe(1)
  })

  it('★ 只看自己那一行（别的动作画了东西不影响）', () => {
    const { pixels } = blankAtlas()
    paintPet(pixels, { animation: 'waving', frames: 4, cx: 96, cy: 104, radius: 40 })
    expect(countFramesInRow(pixels, ATLAS, 'waving')).toBe(4)
    expect(countFramesInRow(pixels, ATLAS, 'idle')).toBe(0)
  })
})

describe('dwellBounds：内容边界', () => {
  it('空图集返回 null', () => {
    const { pixels } = blankAtlas()
    expect(dwellBounds(pixels, ATLAS, {})).toBeNull()
  })

  it('★ 返回的是**相对格子**的坐标，不是图集坐标', () => {
    const { pixels } = blankAtlas()
    // 在 idle（第 0 行）第 0 格画一个圆，圆心 (60, 40)，半径 20
    paintPet(pixels, { animation: 'idle', frames: 1, cx: 60, cy: 40, radius: 20 })
    const bounds = dwellBounds(pixels, ATLAS, { idle: 1 })
    expect(bounds).not.toBeNull()
    // 采样步长是 4，所以边界允许 ±3 像素的偏差
    expect(bounds?.x).toBeGreaterThanOrEqual(40 - 4)
    expect(bounds?.x).toBeLessThanOrEqual(40 + 4)
    expect(bounds?.y).toBeGreaterThanOrEqual(20 - 4)
    expect(bounds?.y).toBeLessThanOrEqual(20 + 4)
  })

  it('★ 第 3 行的动作也换算到"相对格子"（漏减行偏移会让 y 大到离谱）', () => {
    const { pixels } = blankAtlas()
    paintPet(pixels, { animation: 'waving', frames: 1, cx: 60, cy: 40, radius: 20 })
    const bounds = dwellBounds(pixels, ATLAS, { waving: 1 })
    // waving 在第 3 行；若没减掉行偏移，y 会是 3*208 + 20 ≈ 644
    expect(bounds?.y).toBeLessThan(CH)
    expect(bounds?.y).toBeGreaterThanOrEqual(20 - 4)
  })

  it('★ 所有动作取并集（第二个动作更大的范围要盖住第一个）', () => {
    const { pixels } = blankAtlas()
    paintPet(pixels, { animation: 'idle', frames: 1, cx: 96, cy: 104, radius: 10 })
    paintPet(pixels, { animation: 'waving', frames: 1, cx: 96, cy: 104, radius: 50 })
    const bounds = dwellBounds(pixels, ATLAS, { idle: 1, waving: 1 })
    // 半径 50 → 至少 100 宽
    expect(bounds?.width).toBeGreaterThanOrEqual(100 - 2 * 4)
  })

  it('★ availableFrames 为 0 的动作要跳过（没画的格不该进入边界）', () => {
    const { pixels } = blankAtlas()
    paintPet(pixels, { animation: 'idle', frames: 1, cx: 96, cy: 104, radius: 10 })
    // 声明 waving 有 4 帧但一格都没画；它不该把边界拉大
    const bounds = dwellBounds(pixels, ATLAS, { idle: 1, waving: 4 })
    expect(bounds?.width).toBeLessThanOrEqual(20 + 2 * 4)
  })
})

describe('selectMaskGrid：点阵区域', () => {
  it('没有内容时回落到整格', () => {
    const grid = selectMaskGrid(ATLAS, null)
    expect(grid).toEqual({ x: 0, y: 0, width: CW, height: CH })
  })

  it('★ 区域永远在格子内（越界的区域会让主进程查到别的格）', () => {
    const cases = [
      { x: 0, y: 0, width: 20, height: 20 },
      { x: CW - 1, y: CH - 1, width: 1, height: 1 },
      { x: 0, y: CH - 30, width: 40, height: 30 },
      { x: CW - 40, y: 0, width: 40, height: 30 },
    ]
    for (const bounds of cases) {
      const grid = selectMaskGrid(ATLAS, bounds)
      expect(grid.x, `x 下界 ${JSON.stringify(bounds)}`).toBeGreaterThanOrEqual(0)
      expect(grid.y, `y 下界 ${JSON.stringify(bounds)}`).toBeGreaterThanOrEqual(0)
      expect(grid.x + grid.width, `x 上界 ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(CW)
      expect(grid.y + grid.height, `y 上界 ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(CH)
    }
  })

  it('★ 区域至少够 13×16 个点（太小时判定会退化成"一大块都算命中"）', () => {
    const grid = selectMaskGrid(ATLAS, { x: 90, y: 100, width: 4, height: 4 })
    // 点不大于约 16 像素
    expect(grid.width / MASK_COLS).toBeLessThanOrEqual(16)
    expect(grid.height / MASK_ROWS).toBeLessThanOrEqual(16)
  })

  it('★ 内容包在区域里（切掉内容会让最外侧一圈永远点不到）', () => {
    const bounds = { x: 40, y: 30, width: 80, height: 120 }
    const grid = selectMaskGrid(ATLAS, bounds)
    expect(grid.x).toBeLessThanOrEqual(bounds.x)
    expect(grid.y).toBeLessThanOrEqual(bounds.y)
    expect(grid.x + grid.width).toBeGreaterThanOrEqual(bounds.x + bounds.width)
    expect(grid.y + grid.height).toBeGreaterThanOrEqual(bounds.y + bounds.height)
  })

  it('★ 居中的内容得到偏移的网格（说明它真的在贴内容，而不是铺满整格）', () => {
    // 内容集中在格子右下：x 100..180, y 110..200
    const grid = selectMaskGrid(ATLAS, { x: 100, y: 110, width: 80, height: 90 })
    expect(grid.x).toBeGreaterThan(0)
    expect(grid.y).toBeGreaterThan(0)
    // 而整格网格是 0,0 —— 两者必须不同，否则"偏移"这个机制等于没写
    expect(grid).not.toEqual({ x: 0, y: 0, width: CW, height: CH })
  })
})

describe('extractAnimationMask：已知形状 → 已知位', () => {
  it('★ 左上角的小圆只点亮左上角的点', () => {
    const { pixels } = blankAtlas()
    // 半径 20 的圆放在格内 (40, 40)：网格铺满整格时
    // 列 = 40/(192/13) ≈ 2.7，行 = 40/(208/16) ≈ 3.1
    paintCircle(pixels, 40, 40, 20)
    const grid: MaskGrid = { x: 0, y: 0, width: CW, height: CH }
    const mask = extractAnimationMask(pixels, ATLAS, 'idle', 1, grid)

    const col = Math.floor(40 / (CW / MASK_COLS))
    const row = Math.floor(40 / (CH / MASK_ROWS))
    expect(decodeMaskRow(mask.rows[row] ?? '')[col]).toBe(true)

    // 对角（右下）必须是暗的
    const farRow = MASK_ROWS - 1
    const farCol = MASK_COLS - 1
    expect(decodeMaskRow(mask.rows[farRow] ?? '')[farCol]).toBe(false)
  })

  it('★ 空图集 → 全零蒙版（不是全一，也不是 undefined）', () => {
    const { pixels } = blankAtlas()
    const grid: MaskGrid = { x: 0, y: 0, width: CW, height: CH }
    const mask = extractAnimationMask(pixels, ATLAS, 'idle', 1, grid)
    expect(mask.rows).toHaveLength(MASK_ROWS)
    for (const row of mask.rows) {
      expect(decodeMaskRow(row).some(Boolean)).toBe(false)
    }
  })

  it('★ 阈值以下的像素点不亮（抗锯齿外圈不能把剪影撑胖）', () => {
    const { pixels } = blankAtlas()
    paintCircle(pixels, 96, 104, 30, ALPHA_THRESHOLD - 1)
    const grid: MaskGrid = { x: 0, y: 0, width: CW, height: CH }
    const mask = extractAnimationMask(pixels, ATLAS, 'idle', 1, grid)
    expect(mask.rows.every((row) => !decodeMaskRow(row).some(Boolean))).toBe(true)
  })

  it('★ 只出现在后面某一帧的特征也要点亮（并集，不是取中间帧）', () => {
    const { pixels } = blankAtlas()
    // 第 0 格画一个居中的圆；第 4 格才在右下角多画一个
    paintCircle(pixels, 96, 104, 30)
    paintCircle(pixels, 4 * CW + 170, 190, 12)
    const grid: MaskGrid = { x: 0, y: 0, width: CW, height: CH }

    const union = extractAnimationMask(pixels, ATLAS, 'idle', 5, grid)
    const onlyFirst = extractAnimationMask(pixels, ATLAS, 'idle', 1, grid)

    const col = Math.floor(170 / (CW / MASK_COLS))
    const row = Math.floor(190 / (CH / MASK_ROWS))
    expect(decodeMaskRow(onlyFirst.rows[row] ?? '')[col]).toBe(false)
    expect(decodeMaskRow(union.rows[row] ?? '')[col]).toBe(true)
  })

  it('★ 用第 5 行（failed）的形状验证"纵向基准只由动作行决定"', () => {
    const { pixels } = blankAtlas()
    // 在 failed（第 5 行）第 0 格画一个贴格子顶部的圆。
    // 圆心 y=32、半径 10 → 覆盖 y 22..42，稳稳落在第 1 行（13..26）里，
    // 既碰不到第 0 行也碰不到更下面的行（这样"行号错了"才有可观测差异）。
    paintPet(pixels, { animation: 'failed', frames: 1, cx: 96, cy: 32, radius: 10 })
    const grid: MaskGrid = { x: 0, y: 0, width: CW, height: CH }
    const mask = extractAnimationMask(pixels, ATLAS, 'failed', 1, grid)

    // y=32 → 第 2 行（32/(208/16) = 2.46）
    const expectedRow = Math.floor(32 / (CH / MASK_ROWS))
    expect(expectedRow).toBe(2)
    const col = Math.floor(96 / (CW / MASK_COLS))
    expect(decodeMaskRow(mask.rows[expectedRow] ?? '')[col]).toBe(true)

    // 若把"格内 y"当成"整图 y"，第 5 行的形状会整体下移 5 个格高，
    // 那时顶部这几行全是暗的 —— 这两条断言就是防它。
    expect(decodeMaskRow(mask.rows[0] ?? '')[col]).toBe(false)
    expect(decodeMaskRow(mask.rows[expectedRow + 5] ?? '')[col]).toBe(false)
  })
})

describe('extractSpriteMask：整套蒙版', () => {
  /** 造一只"真"宠物的图集：每个动作都在格内居中画圆。 */
  function fullPetAtlas(atlas = ATLAS): PixelSource {
    const { pixels } = blankAtlas(atlas)
    for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
      paintPet(pixels, {
        animation: name,
        frames: atlas.animations[name].frames,
        cx: 96,
        cy: 110,
        radius: 70,
        atlas,
      })
    }
    return pixels
  }

  it('★ 结构合规：validateMask 通过、每个动作都有蒙版', () => {
    const mask = extractSpriteMask({ pixels: fullPetAtlas(), atlas: ATLAS })
    expect(validateMask(mask)).toEqual({ usable: true })
    for (const name of Object.keys(ATLAS.animations) as CodexAnimationName[]) {
      expect(hasMask(mask, name), name).toBe(true)
    }
  })

  it('★ 每个非空动作的蒙版都点得亮（空蒙版等于命中判定失效）', () => {
    const mask = extractSpriteMask({ pixels: fullPetAtlas(), atlas: ATLAS })
    for (const name of Object.keys(ATLAS.animations) as CodexAnimationName[]) {
      const bits = (mask.masks[name]?.rows ?? []).flatMap((row) => decodeMaskRow(row))
      expect(bits.filter(Boolean).length, `${name} 亮起的点数`).toBeGreaterThan(0)
    }
  })

  it('★ 蒙版与命中判定串起来：圆心命中、格子四角穿透', () => {
    const pixels = fullPetAtlas()
    const mask = extractSpriteMask({ pixels, atlas: ATLAS })
    const idle = mask.masks.idle

    // 圆心（格内 96,110）必须命中
    expect(hitTestSpriteMask(idle, 96, 110, CW, CH, mask.grid), '圆心应命中').toBe(true)

    // 四角是空的（圆半径 70，格子 192×208，四角离圆心 > 100）
    for (const [x, y] of [
      [2, 2],
      [CW - 2, 2],
      [2, CH - 2],
      [CW - 2, CH - 2],
    ] as const) {
      expect(
        hitTestSpriteMask(idle, x, y, CW, CH, mask.grid),
        `角 (${String(x)},${String(y)}) 应穿透`,
      ).toBe(false)
    }
  })

  it('★ 没有蒙版的动作用 undefined 查 → 一律穿透（安全侧）', () => {
    const mask = extractSpriteMask({ pixels: fullPetAtlas(), atlas: ATLAS })
    expect(hitTestSpriteMask(mask.masks['running-left'], 96, 110, CW, CH, mask.grid)).toBe(true)
    expect(hitTestSpriteMask(undefined, 96, 110, CW, CH, mask.grid)).toBe(false)
  })

  it('★ availableFrames 为 0 的动作不进蒙版（图集里没这个动作）', () => {
    const pixels = fullPetAtlas()
    const mask = extractSpriteMask({ pixels, atlas: ATLAS, availableFrames: { jumping: 0 } })
    expect(hasMask(mask, 'jumping')).toBe(false)
    // 其他动作不受影响
    expect(hasMask(mask, 'idle')).toBe(true)
    // 但整份蒙版仍然是合法的（缺动作是允许的）
    expect(validateMask(mask).usable).toBe(true)
  })

  it('★ 部分帧可用时只扫那几帧（少画帧不该把区域撑到空帧上）', () => {
    const { pixels } = blankAtlas()
    // idle 只在第 0 格画，第 1..5 格留空
    paintPet(pixels, { animation: 'idle', frames: 1, cx: 96, cy: 110, radius: 40 })
    const mask = extractSpriteMask({ pixels, atlas: ATLAS, availableFrames: { idle: 1 } })
    expect(hasMask(mask, 'idle')).toBe(true)
    const bits = (mask.masks.idle?.rows ?? []).flatMap((row) => decodeMaskRow(row))
    expect(bits.filter(Boolean).length).toBeGreaterThan(0)
  })

  it('★ V2 图集：11 行全部按行号定位（行号错会让注视方向拿到 idle 的蒙版）', () => {
    const pixels = fullPetAtlas(CODEX_V2_ATLAS)
    const mask = extractSpriteMask({ pixels, atlas: CODEX_V2_ATLAS })
    expect(mask.atlasVersion).toBe(2)
    expect(validateMask(mask).usable).toBe(true)
    // 每个标准动作都应该有蒙版且非空
    for (const name of Object.keys(CODEX_V2_ATLAS.animations) as CodexAnimationName[]) {
      const bits = (mask.masks[name]?.rows ?? []).flatMap((row) => decodeMaskRow(row))
      expect(bits.filter(Boolean).length, `${name} 亮起的点数`).toBeGreaterThan(0)
    }
  })

  it('★ 空图集不抛错，得到"合法但没有点"的蒙版', () => {
    const { pixels } = blankAtlas()
    const mask = extractSpriteMask({ pixels, atlas: ATLAS })
    expect(validateMask(mask).usable).toBe(true)
    const bits = Object.values(mask.masks).flatMap((entry) =>
      entry.rows.flatMap((row) => decodeMaskRow(row)),
    )
    expect(bits.some(Boolean)).toBe(false)
  })

  it('★ 数据量在可接受范围（这是"下采样而不是传整图"的存在理由）', () => {
    const mask = extractSpriteMask({ pixels: fullPetAtlas(), atlas: ATLAS })
    const bytes = JSON.stringify(mask).length
    // 9 个动作 × 16 行 × 4 字符 ≈ 600 字节；给足余量但必须远小于一张图集
    expect(bytes).toBeLessThan(4096)
  })
})
