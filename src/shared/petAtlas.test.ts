import { describe, expect, it } from 'vitest'

import {
  animationDuration,
  atlasForVersion,
  CELL_HEIGHT,
  CELL_WIDTH,
  clampFrames,
  CODEX_V1_ATLAS,
  CODEX_V2_ATLAS,
  frameAt,
  frameRect,
  LOOK_DIRECTIONS,
  lookFrameRect,
  nearestLookDirection,
  validateAtlas,
  type CodexAnimationName,
} from './petAtlas'

/**
 * 图集契约的测试。
 *
 * ── 这里在防什么 ──
 *
 * 这批常量是**从外部规范抄来的**，抄错的后果不是报错，而是
 * "画面偏移一格"或"少播一帧"——两种都极难从截图上看出来。
 * 所以把规范里的每个数字都变成一条断言，让它不可能被静默改掉。
 *
 * 规范的来源：Codex 官方 `hatch-pet-v2` skill 的
 * `references/codex-pet-contract.md` 与 `references/animation-rows.md`。
 */

describe('尺寸与网格（照抄规范）', () => {
  it('单格是 192×208', () => {
    expect(CELL_WIDTH).toBe(192)
    expect(CELL_HEIGHT).toBe(208)
  })

  it('V1 是 8×9 = 1536×1872', () => {
    expect(CODEX_V1_ATLAS.columns).toBe(8)
    expect(CODEX_V1_ATLAS.rows).toBe(9)
    expect(CODEX_V1_ATLAS.atlasWidth).toBe(1536)
    expect(CODEX_V1_ATLAS.atlasHeight).toBe(1872)
  })

  it('V2 是 8×11 = 1536×2288', () => {
    expect(CODEX_V2_ATLAS.columns).toBe(8)
    expect(CODEX_V2_ATLAS.rows).toBe(11)
    expect(CODEX_V2_ATLAS.atlasWidth).toBe(1536)
    expect(CODEX_V2_ATLAS.atlasHeight).toBe(2288)
  })

  it('★ 图集宽高必须等于 列×格宽 / 行×格高（否则切帧会逐步偏移）', () => {
    for (const atlas of [CODEX_V1_ATLAS, CODEX_V2_ATLAS]) {
      expect(atlas.atlasWidth).toBe(atlas.columns * atlas.cellWidth)
      expect(atlas.atlasHeight).toBe(atlas.rows * atlas.cellHeight)
    }
  })

  it('atlasForVersion 按版本返回对应契约', () => {
    expect(atlasForVersion(1)).toBe(CODEX_V1_ATLAS)
    expect(atlasForVersion(2)).toBe(CODEX_V2_ATLAS)
  })
})

describe('★ 帧数与行号（规范的逐项复刻）', () => {
  /** 规范表格里的九行。抄在测试里做**双重录入**：实现与期望各一份。 */
  const EXPECTED: Record<CodexAnimationName, { row: number; frames: number }> = {
    idle: { row: 0, frames: 6 },
    'running-right': { row: 1, frames: 8 },
    'running-left': { row: 2, frames: 8 },
    waving: { row: 3, frames: 4 },
    jumping: { row: 4, frames: 5 },
    failed: { row: 5, frames: 8 },
    waiting: { row: 6, frames: 6 },
    running: { row: 7, frames: 6 },
    review: { row: 8, frames: 6 },
  }

  it('每个动作的行号与帧数都与规范一致', () => {
    for (const [name, want] of Object.entries(EXPECTED) as [CodexAnimationName, typeof EXPECTED.idle][]) {
      const spec = CODEX_V2_ATLAS.animations[name]
      expect(spec.row, `${name} 的行号`).toBe(want.row)
      expect(spec.frames, `${name} 的帧数`).toBe(want.frames)
    }
  })

  it('★ 行号 0–8 连续且不重复（有一行重复就会出现两个动作抢同一行）', () => {
    const rows = Object.values(CODEX_V2_ATLAS.animations).map((spec) => spec.row)
    expect([...rows].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('★ 每帧都有时长，且时长个数等于帧数（差一个就会播到 undefined）', () => {
    for (const [name, spec] of Object.entries(CODEX_V2_ATLAS.animations)) {
      expect(spec.frameDurations.length, `${name} 的时长个数`).toBe(spec.frames)
      for (const ms of spec.frameDurations) {
        expect(ms).toBeGreaterThan(0)
      }
    }
  })

  it('★ 帧数不超过列数（超了就会读到下一行的图）', () => {
    for (const [name, spec] of Object.entries(CODEX_V2_ATLAS.animations)) {
      expect(spec.frames, `${name} 的帧数`).toBeLessThanOrEqual(CODEX_V2_ATLAS.columns)
    }
  })

  it('规范里的两个"最慢帧"是刻意的：每段动作的最后一帧更长（收势）', () => {
    // 这不是随便写的：规范明确说"最后帧更长"，让动作有收势而不是硬切。
    for (const [, spec] of Object.entries(CODEX_V2_ATLAS.animations)) {
      const last = spec.frameDurations[spec.frameDurations.length - 1] ?? 0
      const prev = spec.frameDurations[spec.frameDurations.length - 2] ?? last
      expect(last).toBeGreaterThanOrEqual(prev)
    }
  })
})

describe('frameRect：切帧', () => {
  it('第 0 帧在左上角', () => {
    expect(frameRect(CODEX_V2_ATLAS, 'idle', 0)).toEqual({
      x: 0,
      y: 0,
      width: 192,
      height: 208,
    })
  })

  it('同一动作内每帧向右平移一格', () => {
    const a = frameRect(CODEX_V2_ATLAS, 'running-right', 0)
    const b = frameRect(CODEX_V2_ATLAS, 'running-right', 3)
    expect(b.x - a.x).toBe(3 * CELL_WIDTH)
    expect(b.y).toBe(a.y)
  })

  it('★ 不同动作落在不同行（y = 行号 × 格高）', () => {
    for (const [name, spec] of Object.entries(CODEX_V2_ATLAS.animations)) {
      const rect = frameRect(CODEX_V2_ATLAS, name as CodexAnimationName, 0)
      expect(rect.y, `${name} 的 y`).toBe(spec.row * CELL_HEIGHT)
    }
  })

  it('★ 越界帧被钳住，不抛错也不返回负坐标', () => {
    // 渲染器每帧都调用它；一个越界索引不该让整只宠物消失。
    const beyond = frameRect(CODEX_V2_ATLAS, 'waving', 99)
    const last = frameRect(CODEX_V2_ATLAS, 'waving', 3)
    expect(beyond).toEqual(last)

    const negative = frameRect(CODEX_V2_ATLAS, 'waving', -5)
    expect(negative.x).toBe(0)
    expect(Number.isFinite(negative.x)).toBe(true)
  })

  it('矩形永远落在图集范围内', () => {
    for (const name of Object.keys(CODEX_V2_ATLAS.animations) as CodexAnimationName[]) {
      const spec = CODEX_V2_ATLAS.animations[name]
      const rect = frameRect(CODEX_V2_ATLAS, name, spec.frames - 1)
      expect(rect.x + rect.width).toBeLessThanOrEqual(CODEX_V2_ATLAS.atlasWidth)
      expect(rect.y + rect.height).toBeLessThanOrEqual(CODEX_V2_ATLAS.atlasHeight)
    }
  })
})

describe('★ 注视方向（最容易搞反的一处约定）', () => {
  it('16 个方向，每 22.5° 一档', () => {
    expect(LOOK_DIRECTIONS).toHaveLength(16)
    expect(LOOK_DIRECTIONS[0]).toBe(0)
    expect(LOOK_DIRECTIONS[1]).toBe(22.5)
    expect(LOOK_DIRECTIONS[15]).toBe(337.5)
  })

  it('★ 0° 是**正上**（12 点钟），不是"正面"', () => {
    // 搞反的表现很微妙：光标在正上方时它却"看着你"。
    // 这条断言把约定钉住：0 落在行 9 的第 0 列。
    const rect = lookFrameRect(CODEX_V2_ATLAS, 0)
    expect(rect).toEqual({ x: 0, y: 9 * CELL_HEIGHT, width: 192, height: 208 })
  })

  it('前 8 个方向在行 9，后 8 个在行 10', () => {
    expect(lookFrameRect(CODEX_V2_ATLAS, 0)?.y).toBe(9 * CELL_HEIGHT)
    expect(lookFrameRect(CODEX_V2_ATLAS, 157.5)?.y).toBe(9 * CELL_HEIGHT)
    expect(lookFrameRect(CODEX_V2_ATLAS, 180)?.y).toBe(10 * CELL_HEIGHT)
    expect(lookFrameRect(CODEX_V2_ATLAS, 337.5)?.y).toBe(10 * CELL_HEIGHT)
  })

  it('行 10 的第 0 列对应 180°', () => {
    expect(lookFrameRect(CODEX_V2_ATLAS, 180)?.x).toBe(0)
  })

  it('★ V1 没有注视行 → 返回 null（调用方回落到 idle）', () => {
    expect(lookFrameRect(CODEX_V1_ATLAS, 90)).toBeNull()
  })

  it('nearestLookDirection 取最近档，且环绕正确', () => {
    expect(nearestLookDirection(0)).toBe(0)
    expect(nearestLookDirection(10)).toBe(0)
    expect(nearestLookDirection(12)).toBe(22.5)
    expect(nearestLookDirection(90)).toBe(90)
    expect(nearestLookDirection(359)).toBe(0)
    expect(nearestLookDirection(-22.5)).toBe(337.5)
    expect(nearestLookDirection(720)).toBe(0)
  })

  it('非法角度回落 0 而不抛错', () => {
    expect(nearestLookDirection(Number.NaN)).toBe(0)
    expect(nearestLookDirection(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('frameAt：假时钟推进', () => {
  const atlas = CODEX_V2_ATLAS

  it('t=0 是第 0 帧', () => {
    expect(frameAt(atlas, 'idle', 0)).toBe(0)
  })

  it('★ 每一帧都在它自己的时长区间内', () => {
    const spec = atlas.animations.idle
    let elapsed = 0
    for (let i = 0; i < spec.frames; i++) {
      const duration = spec.frameDurations[i] ?? 0
      // 该帧区间的开始与结束前一刻都应返回 i
      expect(frameAt(atlas, 'idle', elapsed), `第 ${String(i)} 帧起点`).toBe(i)
      expect(frameAt(atlas, 'idle', elapsed + duration - 1), `第 ${String(i)} 帧末`).toBe(i)
      elapsed += duration
    }
  })

  it('★ 走完一轮后回到第 0 帧（循环）', () => {
    const total = animationDuration(atlas, 'idle')
    expect(frameAt(atlas, 'idle', total)).toBe(0)
    expect(frameAt(atlas, 'idle', total * 3 + 1)).toBe(0)
  })

  it('不同动作的节奏不同（不是共用一个时钟表）', () => {
    // idle 第 0 帧 280ms，running 第 0 帧 120ms
    expect(frameAt(atlas, 'idle', 200)).toBe(0)
    expect(frameAt(atlas, 'running', 200)).toBe(1)
  })

  it('动画总时长 = 各帧之和', () => {
    const spec = atlas.animations.jumping
    const sum = spec.frameDurations.reduce((a, b) => a + b, 0)
    expect(animationDuration(atlas, 'jumping')).toBe(sum)
  })

  it('★ 非法/负时间返回 0 而不抛错（一个坏时钟不该让宠物消失）', () => {
    expect(frameAt(atlas, 'idle', -1)).toBe(0)
    expect(frameAt(atlas, 'idle', Number.NaN)).toBe(0)
    expect(frameAt(atlas, 'idle', Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('帧号永远落在 [0, frames)', () => {
    for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
      const frames = atlas.animations[name].frames
      for (let t = 0; t < 5000; t += 137) {
        const frame = frameAt(atlas, name, t)
        expect(frame, `${name} @${String(t)}ms`).toBeGreaterThanOrEqual(0)
        expect(frame, `${name} @${String(t)}ms`).toBeLessThan(frames)
      }
    }
  })
})

describe('validateAtlas：宽容降级（与参考实现的有意分歧）', () => {
  it('尺寸正确的 V2 图集通过', () => {
    const result = validateAtlas({ version: 2, width: 1536, height: 2288 })
    expect(result.usable).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('★ 尺寸不符 → 不可用（切帧会逐步偏移，必须拒绝）', () => {
    const result = validateAtlas({ version: 2, width: 1536, height: 1872 })
    expect(result.usable).toBe(false)
    expect(result.errors.join()).toContain('2288')
  })

  it('★ 把 V2 的图集当 V1 用 → 尺寸不符而报错（这正是"省略版本号"的后果）', () => {
    const result = validateAtlas({ version: 1, width: 1536, height: 2288 })
    expect(result.usable).toBe(false)
  })

  it('★ 帧数不足只是**警告**，仍然可用（运行时宿主应尽量用起来）', () => {
    const result = validateAtlas({
      version: 2,
      width: 1536,
      height: 2288,
      availableFrames: { idle: 4, waving: 2 },
    })
    expect(result.usable).toBe(true)
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.join()).toContain('idle')
  })

  it('帧数足够时没有警告', () => {
    const result = validateAtlas({
      version: 2,
      width: 1536,
      height: 2288,
      availableFrames: { idle: 6, waving: 4 },
    })
    expect(result.warnings).toEqual([])
  })

  it('clampFrames 把时长表一起截短（否则会播到 undefined 时长）', () => {
    const clamped = clampFrames(CODEX_V2_ATLAS.animations.idle, 3)
    expect(clamped.frames).toBe(3)
    expect(clamped.frameDurations).toHaveLength(3)
  })

  it('clampFrames 在帧数足够或非法时原样返回', () => {
    const spec = CODEX_V2_ATLAS.animations.idle
    expect(clampFrames(spec, 6)).toBe(spec)
    expect(clampFrames(spec, 99)).toBe(spec)
    expect(clampFrames(spec, 0)).toBe(spec)
    expect(clampFrames(spec, Number.NaN)).toBe(spec)
  })

  it('★ 截短后的动作仍能正确取帧（不会与 spec 不一致）', () => {
    const clamped = clampFrames(CODEX_V2_ATLAS.animations.idle, 3)
    const atlas = {
      ...CODEX_V2_ATLAS,
      animations: { ...CODEX_V2_ATLAS.animations, idle: clamped },
    }
    for (let t = 0; t < 2000; t += 41) {
      expect(frameAt(atlas, 'idle', t)).toBeLessThan(3)
    }
  })
})
