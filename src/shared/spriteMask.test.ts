import { describe, expect, it } from 'vitest'

import { CELL_HEIGHT, CELL_WIDTH } from '@shared/petAtlas'
import {
  ALPHA_THRESHOLD,
  decodeMaskRow,
  encodeMaskRow,
  FULL_CELL_GRID,
  hasMask,
  hitTestSpriteMask,
  MASK_COLS,
  MASK_ROW_HEX_LEN,
  MASK_ROWS,
  spriteWindowSize,
  validateMask,
  type AnimationMask,
  type MaskGrid,
  type SpriteMask,
} from './spriteMask'

/**
 * 精灵图 alpha 蒙版的测试。
 *
 * ⚠️ 这里最要紧的一条是**"没有蒙版时判穿透"**（安全侧）。
 *    搞反的后果是宠物挡住下层窗口却点不动——那是直接卸载级别的故障；
 *    而反过来只是宠物暂时点不到几百毫秒。
 *
 * 第二要紧的是**"不在剪影上必须判假"**。命中测试写错时的默认故障是
 * "恒为真"（整格都可点），那时它看起来"能用"，但透明边角开始吃点击。
 * 所以下面的用例大量采用"点亮一个点 → 断言它的邻居是假"的写法。
 */

/** 造一个"全空"的蒙版。 */
function emptyMask(): AnimationMask {
  return { rows: Array.from({ length: MASK_ROWS }, () => '0'.repeat(MASK_ROW_HEX_LEN)) }
}

/** 铺满整格的区域（把点阵对齐到整格，便于用像素坐标直接推预期）。 */
const CELL_GRID: MaskGrid = { x: 0, y: 0, width: CELL_WIDTH, height: CELL_HEIGHT }

/**
 * 点阵区域里第 col 列、第 row 行对应的**格子像素**坐标（点中心）。
 *
 * ⚠️ 返回值是**格子像素**，不是窗口 DIP：窗口局部坐标 = 格子像素 × 缩放倍数。
 *    测试里显式乘缩放，免得"缩放"这件事被藏进辅助函数，两边一起算错却互相印证。
 */
function dotCenterIn(grid: MaskGrid, col: number, row: number): { x: number; y: number } {
  return {
    x: grid.x + (col + 0.5) * (grid.width / MASK_COLS),
    y: grid.y + (row + 0.5) * (grid.height / MASK_ROWS),
  }
}

/** 铺满整格时第 col 列、第 row 行的点中心。 */
function cellDot(col: number, row: number): { x: number; y: number } {
  return dotCenterIn(CELL_GRID, col, row)
}

/** 造一个"只有 (col,row) 一个点亮"的蒙版。 */
function maskWithDot(col: number, row: number): AnimationMask {
  const rows = Array.from({ length: MASK_ROWS }, () => '0'.repeat(MASK_ROW_HEX_LEN))
  const bits = Array.from({ length: MASK_COLS }, (_, i) => i === col)
  rows[row] = encodeMaskRow(bits)
  return { rows }
}

/** 造一个坐标系：窗口按 scale 放大，覆盖整格。 */
function windowFor(scale: number): { width: number; height: number } {
  return { width: CELL_WIDTH * scale, height: CELL_HEIGHT * scale }
}

describe('行编解码（低位 = 左列）', () => {
  it('往返一致', () => {
    const bits = Array.from({ length: MASK_COLS }, (_, i) => i % 3 === 0)
    expect(decodeMaskRow(encodeMaskRow(bits))).toEqual(bits)
  })

  it('★ 位序是"低位对应左列"（搞反会让命中左右镜像）', () => {
    // 只有第 0 列亮 → 数值 1
    const leftOnly = Array.from({ length: MASK_COLS }, (_, i) => i === 0)
    expect(encodeMaskRow(leftOnly)).toBe('1'.padStart(MASK_ROW_HEX_LEN, '0'))
    expect(decodeMaskRow(encodeMaskRow(leftOnly))[0]).toBe(true)
    expect(decodeMaskRow(encodeMaskRow(leftOnly))[1]).toBe(false)

    // 只有最后一列亮 → 数值 1 << (COLS-1)
    const rightOnly = Array.from({ length: MASK_COLS }, (_, i) => i === MASK_COLS - 1)
    const decoded = decodeMaskRow(encodeMaskRow(rightOnly))
    expect(decoded[MASK_COLS - 1]).toBe(true)
    expect(decoded[MASK_COLS - 2]).toBe(false)
  })

  it('编码长度恒为 MASK_ROW_HEX_LEN（左侧补零，IPC 传输时长度可预测）', () => {
    for (let col = 0; col < MASK_COLS; col++) {
      const bits = Array.from({ length: MASK_COLS }, (_, i) => i === col)
      expect(encodeMaskRow(bits)).toHaveLength(MASK_ROW_HEX_LEN)
    }
    expect(encodeMaskRow(Array.from({ length: MASK_COLS }, () => false))).toHaveLength(
      MASK_ROW_HEX_LEN,
    )
  })

  it('解码长度恒为 MASK_COLS（不足右侧补 false）', () => {
    expect(decodeMaskRow('1')).toHaveLength(MASK_COLS)
    expect(decodeMaskRow('')).toHaveLength(MASK_COLS)
  })

  it('非法十六进制解成全 false，不抛错', () => {
    // ★ 这一条防的是静默故障：NaN >> n === 0，不检查就会"永远穿透"而不报错
    expect(decodeMaskRow('zz')).toEqual(Array.from({ length: MASK_COLS }, () => false))
    expect(decodeMaskRow('-1')).toEqual(Array.from({ length: MASK_COLS }, () => false))
    expect(decodeMaskRow('0x1')).toEqual(Array.from({ length: MASK_COLS }, () => false))
  })

  it('★ 点阵必须能塞进 32 位（位运算 `<< col` 会在大数上悄悄回绕）', () => {
    expect(MASK_COLS).toBeLessThanOrEqual(32)
    expect(MASK_ROW_HEX_LEN).toBe(Math.ceil(MASK_COLS / 4))
  })
})

describe('★ hitTestSpriteMask：没有蒙版必须判穿透（安全侧）', () => {
  it('★ mask 为 undefined → false（宁可暂时点不到，也不要挡住下层窗口点不动）', () => {
    expect(hitTestSpriteMask(undefined, 96, 104, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(false)
  })

  it('★ 空蒙版 → 全 false', () => {
    expect(hitTestSpriteMask(emptyMask(), 96, 104, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(false)
  })

  it('窗口外一律 false', () => {
    const mask = maskWithDot(6, 8)
    expect(hitTestSpriteMask(mask, -1, 100, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(false)
    expect(hitTestSpriteMask(mask, 100, -1, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(false)
    expect(hitTestSpriteMask(mask, CELL_WIDTH, 100, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(false)
    expect(hitTestSpriteMask(mask, 100, CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(false)
  })

  it('尺寸非法时返回 false，不抛错（穿透轮询每 80ms 跑一次，抛错会停摆）', () => {
    const mask = maskWithDot(6, 8)
    expect(hitTestSpriteMask(mask, 10, 10, 0, CELL_HEIGHT, CELL_GRID)).toBe(false)
    expect(hitTestSpriteMask(mask, 10, 10, CELL_WIDTH, 0, CELL_GRID)).toBe(false)
    expect(hitTestSpriteMask(mask, 10, 10, -1, CELL_HEIGHT, CELL_GRID)).toBe(false)
    expect(hitTestSpriteMask(mask, Number.NaN, 10, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(false)
    expect(hitTestSpriteMask(mask, 10, Number.POSITIVE_INFINITY, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(
      false,
    )
    // 网格退化
    expect(
      hitTestSpriteMask(mask, 10, 10, CELL_WIDTH, CELL_HEIGHT, { x: 0, y: 0, width: 0, height: 0 }),
    ).toBe(false)
  })
})

describe('★ hitTestSpriteMask：坐标 → 点阵的换算', () => {
  it('点中心命中', () => {
    const mask = maskWithDot(3, 4)
    const center = cellDot(3, 4)
    expect(hitTestSpriteMask(mask, center.x, center.y, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(true)
  })

  it('★ 相邻点为 false（证明是查表而不是恒真）', () => {
    const mask = maskWithDot(3, 4)
    const nextCol = cellDot(4, 4)
    const nextRow = cellDot(3, 5)
    expect(hitTestSpriteMask(mask, nextCol.x, nextCol.y, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(
      false,
    )
    expect(hitTestSpriteMask(mask, nextRow.x, nextRow.y, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(
      false,
    )
  })

  it('★ 每一列/行都能被独立命中（穷举，防换算写错比例）', () => {
    for (let col = 0; col < MASK_COLS; col++) {
      for (let row = 0; row < MASK_ROWS; row++) {
        const mask = maskWithDot(col, row)
        const center = cellDot(col, row)
        expect(
          hitTestSpriteMask(mask, center.x, center.y, CELL_WIDTH, CELL_HEIGHT, CELL_GRID),
          `格 (${String(col)},${String(row)})`,
        ).toBe(true)
      }
    }
  })

  it('右边界落在最后一列（不越界，且不是"越界后靠 Math.min 兜住"）', () => {
    // 只有最后一列亮；窗口最右一个像素必须命中
    const mask = maskWithDot(MASK_COLS - 1, MASK_ROWS - 1)
    expect(
      hitTestSpriteMask(mask, CELL_WIDTH - 0.5, CELL_HEIGHT - 0.5, CELL_WIDTH, CELL_HEIGHT, CELL_GRID),
    ).toBe(true)
    // 而第 0 列是假的，说明它确实是查表查出来的
    expect(hitTestSpriteMask(mask, 0.5, CELL_HEIGHT - 0.5, CELL_WIDTH, CELL_HEIGHT, CELL_GRID)).toBe(
      false,
    )
  })

  it('★ 缩放后仍按比例换算（窗口尺寸变了，判定形状不变）', () => {
    for (const scale of [0.5, 1, 1.5, 2, 3]) {
      const mask = maskWithDot(6, 8)
      const window = windowFor(scale)
      const center = cellDot(6, 8)
      // 点中心在两种坐标系里是同一点（局部 DIP = 格子像素 × scale）
      expect(
        hitTestSpriteMask(mask, center.x * scale, center.y * scale, window.width, window.height, CELL_GRID),
        `scale ${String(scale)}`,
      ).toBe(true)
      // 邻居仍为假
      const neighbour = cellDot(6, 9)
      expect(
        hitTestSpriteMask(
          mask,
          neighbour.x * scale,
          neighbour.y * scale,
          window.width,
          window.height,
          CELL_GRID,
        ),
        `scale ${String(scale)} 邻居`,
      ).toBe(false)
    }
  })
})

describe('★ hitTestSpriteMask：点阵区域带偏移（贴着宠物而不是铺满整格）', () => {
  // 一个"宠物只占右下半部分"的区域：水平 96..192，垂直 104..208
  const offsetGrid: MaskGrid = { x: 96, y: 104, width: 96, height: 104 }

  it('★ 区域内的点能命中，区域外的同一格不能（证明偏移真的生效）', () => {
    const mask = maskWithDot(0, 0)
    const inRegion = dotCenterIn(offsetGrid, 0, 0)
    expect(
      hitTestSpriteMask(mask, inRegion.x, inRegion.y, CELL_WIDTH, CELL_HEIGHT, offsetGrid),
    ).toBe(true)

    // 同样的 (0,0) 点若按整格解释，落在左上角——那正是"宠物不在这里"的位置
    const wrongRegion = cellDot(0, 0)
    expect(
      hitTestSpriteMask(mask, wrongRegion.x, wrongRegion.y, CELL_WIDTH, CELL_HEIGHT, offsetGrid),
    ).toBe(false)
  })

  it('区域最右一列是最后一列，再往右就是穿透', () => {
    const mask = maskWithDot(MASK_COLS - 1, 0)
    const edge = dotCenterIn(offsetGrid, MASK_COLS - 1, 0)
    expect(hitTestSpriteMask(mask, edge.x, edge.y, CELL_WIDTH, CELL_HEIGHT, offsetGrid)).toBe(true)
    // 区域右边界之外（还在格子里）→ 穿透
    const outside = offsetGrid.x + offsetGrid.width + 1
    expect(hitTestSpriteMask(mask, outside, edge.y, CELL_WIDTH, CELL_HEIGHT, offsetGrid)).toBe(false)
  })

  it('★ 偏移网格在缩放后依然对齐（缩放不改变区域在格内的位置）', () => {
    const mask = maskWithDot(4, 5)
    const window = windowFor(2)
    const center = dotCenterIn(offsetGrid, 4, 5)
    expect(
      hitTestSpriteMask(mask, center.x * 2, center.y * 2, window.width, window.height, offsetGrid),
    ).toBe(true)
    const neighbour = dotCenterIn(offsetGrid, 4, 6)
    expect(
      hitTestSpriteMask(
        mask,
        neighbour.x * 2,
        neighbour.y * 2,
        window.width,
        window.height,
        offsetGrid,
      ),
    ).toBe(false)
  })
})

describe('hasMask', () => {
  const full: SpriteMask = {
    kind: 'sprite',
    atlasVersion: 2,
    grid: CELL_GRID,
    masks: { idle: emptyMask(), waving: emptyMask() },
  }

  it('有蒙版动作为 true', () => {
    expect(hasMask(full, 'idle')).toBe(true)
    expect(hasMask(full, 'waving')).toBe(true)
  })

  it('没蒙版动作为 false', () => {
    expect(hasMask(full, 'jumping')).toBe(false)
    expect(hasMask(null, 'idle')).toBe(false)
  })

  it('★ 行数不对 / 行长不对 / 含非法字符都算"没有蒙版"', () => {
    // 行数不足
    const short: SpriteMask = { ...full, masks: { idle: { rows: ['1'] } } }
    expect(hasMask(short, 'idle')).toBe(false)
    // 行长不足（会被 hitTest 的位运算静默吞掉）
    const truncated: SpriteMask = {
      ...full,
      masks: { idle: { rows: Array.from({ length: MASK_ROWS }, () => '0') } },
    }
    expect(hasMask(truncated, 'idle')).toBe(false)
    // 含非十六进制字符
    const dirty: SpriteMask = {
      ...full,
      masks: { idle: { rows: Array.from({ length: MASK_ROWS }, () => 'zzzz') } },
    }
    expect(hasMask(dirty, 'idle')).toBe(false)
  })
})

describe('validateMask：宽容但不含糊', () => {
  const good = { kind: 'sprite', atlasVersion: 2, grid: CELL_GRID, masks: { idle: emptyMask() } }

  it('合法的蒙版通过，且判为可用', () => {
    const result = validateMask(good)
    expect(result).toEqual({ usable: true })
    // 通过校验的蒙版必须真的能被 hasMask 认出来（两道关不能各说各话）
    expect(hasMask(good as SpriteMask, 'idle')).toBe(true)
  })

  it('★ 行数不对要能说出来（否则主进程会拿到半张表）', () => {
    const result = validateMask({ ...good, masks: { idle: { rows: ['1', '2'] } } })
    expect(result.usable).toBe(false)
    expect(result.reason).toContain('idle')
    expect(result.reason).toContain(String(MASK_ROWS))
  })

  it('★ 行内容非法要能说出来（NaN 位运算会静默变成"永远穿透"）', () => {
    const dirty = {
      ...good,
      masks: { idle: { rows: Array.from({ length: MASK_ROWS }, () => 'zz') } },
    }
    const result = validateMask(dirty)
    expect(result.usable).toBe(false)
    expect(result.reason).toContain('idle')
  })

  it('★ 缺 grid / grid 非法要能说出来（否则换算基准是 undefined）', () => {
    expect(validateMask({ kind: 'sprite', masks: {} }).usable).toBe(false)
    expect(validateMask({ kind: 'sprite', grid: null, masks: {} }).usable).toBe(false)
    expect(validateMask({ kind: 'sprite', grid: { x: 0, y: 0, width: 0, height: 10 }, masks: {} }).usable).toBe(
      false,
    )
    expect(
      validateMask({ kind: 'sprite', grid: { x: 0, y: 0, width: Number.NaN, height: 10 }, masks: {} })
        .usable,
    ).toBe(false)
  })

  it('非对象 / kind 不对 / 缺 masks 都被拒绝并给出原因', () => {
    expect(validateMask(null).usable).toBe(false)
    expect(validateMask('x').usable).toBe(false)
    expect(validateMask(undefined).usable).toBe(false)
    expect(validateMask({ kind: 'other' }).usable).toBe(false)
    expect(validateMask({ kind: 'sprite', grid: CELL_GRID }).usable).toBe(false)
  })

  it('masks 为空对象是合法的（等于还没有任何蒙版），且此时任何动作都无蒙版', () => {
    const empty = { kind: 'sprite', atlasVersion: 2, grid: CELL_GRID, masks: {} }
    expect(validateMask(empty).usable).toBe(true)
    expect(hasMask(empty as SpriteMask, 'idle')).toBe(false)
  })
})

describe('spriteWindowSize：精灵格不是正方形', () => {
  it('★ 按格子比例给尺寸（不是正方形）', () => {
    const size = spriteWindowSize({ cellWidth: 192, cellHeight: 208 }, 1)
    expect(size).toEqual({ width: 192, height: 208 })
    expect(size.width).not.toBe(size.height)
  })

  it('随缩放线性变化', () => {
    expect(spriteWindowSize({ cellWidth: 192, cellHeight: 208 }, 2)).toEqual({
      width: 384,
      height: 416,
    })
  })

  it('缩放非法时按 1 处理，且尺寸至少为 1（0 尺寸窗口无法创建）', () => {
    expect(spriteWindowSize({ cellWidth: 192, cellHeight: 208 }, 0)).toEqual({
      width: 192,
      height: 208,
    })
    expect(spriteWindowSize({ cellWidth: 192, cellHeight: 208 }, Number.NaN)).toEqual({
      width: 192,
      height: 208,
    })
    expect(spriteWindowSize({ cellWidth: 0, cellHeight: 0 }, 1)).toEqual({ width: 1, height: 1 })
  })
})

describe('常量自身的守卫', () => {
  it('阈值取半透明而不是 >0（否则抗锯齿外圈会被算成可点）', () => {
    expect(ALPHA_THRESHOLD).toBe(128)
  })

  it('铺满整格的兜底区域就是格子本身', () => {
    expect(FULL_CELL_GRID).toEqual({ x: 0, y: 0, width: CELL_WIDTH, height: CELL_HEIGHT })
  })

  it('★ 点尺寸横纵接近（差得远会让判定在某个方向系统性偏胖）', () => {
    const dotWidth = CELL_WIDTH / MASK_COLS
    const dotHeight = CELL_HEIGHT / MASK_ROWS
    const ratio = Math.max(dotWidth, dotHeight) / Math.min(dotWidth, dotHeight)
    expect(ratio).toBeLessThan(1.25)
  })
})
