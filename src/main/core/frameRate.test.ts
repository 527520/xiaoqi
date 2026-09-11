import { describe, expect, it } from 'vitest'

import { FRAME_RATE } from '@shared/constants'

import {
  frameBudgetChanged,
  shouldPauseTicker,
  targetFrameRate,
  type FrameBudgetInput,
} from './frameRate'

function budget(overrides: Partial<FrameBudgetInput> = {}): FrameBudgetInput {
  return { mode: 'active', isAnimating: false, isWindowVisible: true, ...overrides }
}

describe('待机降帧（施工令 §4.3⑩）', () => {
  it('待机时**不是** 60fps —— 这是本项目最容易被忽略的性能红线', () => {
    const fps = targetFrameRate(budget())
    expect(fps).toBe(FRAME_RATE.idle)
    expect(fps).toBeLessThanOrEqual(10)
  })

  it('有交互动画时才升到 60fps', () => {
    expect(targetFrameRate(budget({ isAnimating: true }))).toBe(FRAME_RATE.active)
  })

  it('静默态比待机还低（缩成小点时几乎不动）', () => {
    const silent = targetFrameRate(budget({ mode: 'silent' }))
    expect(silent).toBe(FRAME_RATE.silent)
    expect(silent).toBeLessThan(FRAME_RATE.idle)
  })

  it('窗口不可见时帧率为 0（语义是"停更"）', () => {
    expect(targetFrameRate(budget({ isWindowVisible: false }))).toBe(0)
    expect(shouldPauseTicker(budget({ isWindowVisible: false }))).toBe(true)
  })

  it('隐身形态时帧率为 0，即使窗口还来不及隐藏', () => {
    expect(targetFrameRate(budget({ mode: 'hidden' }))).toBe(0)
    expect(shouldPauseTicker(budget({ mode: 'hidden' }))).toBe(true)
  })

  it('不可见优先于"正在动画"—— 不可见就不该有任何绘制', () => {
    expect(targetFrameRate(budget({ isAnimating: true, isWindowVisible: false }))).toBe(0)
  })

  it('正常可见时不停更', () => {
    expect(shouldPauseTicker(budget())).toBe(false)
    expect(shouldPauseTicker(budget({ mode: 'silent' }))).toBe(false)
  })
})

describe('帧预算变化判定', () => {
  it('档位没变时不认为变化（避免重复写 ticker.maxFPS）', () => {
    expect(frameBudgetChanged(budget(), budget())).toBe(false)
  })

  it('待机 → 动画 算变化', () => {
    expect(frameBudgetChanged(budget(), budget({ isAnimating: true }))).toBe(true)
  })

  it('正常 → 静默 算变化', () => {
    expect(frameBudgetChanged(budget(), budget({ mode: 'silent' }))).toBe(true)
  })

  it('可见 → 不可见 算变化', () => {
    expect(frameBudgetChanged(budget(), budget({ isWindowVisible: false }))).toBe(true)
  })

  it('两个字段不同但帧率相同的组合，不算变化', () => {
    // 静默态 + 窗口不可见（0）与 active + 窗口不可见（0）帧率相同，
    // 因此不需要写 ticker。
    const a = budget({ mode: 'silent', isWindowVisible: false })
    const b = budget({ mode: 'active', isWindowVisible: false })
    expect(frameBudgetChanged(a, b)).toBe(false)
  })
})
