import { describe, expect, it } from 'vitest'

import { BLINK_DURATION_SECONDS, breathPose, eyeOpenness, swayAngle } from './animation'

describe('眼睛张开度（一个真实踩过的 bug 的回归测试）', () => {
  it('不眨眼时完全睁开', () => {
    expect(eyeOpenness(0, BLINK_DURATION_SECONDS)).toBe(1)
    expect(eyeOpenness(-1, BLINK_DURATION_SECONDS)).toBe(1)
  })

  it('眨眼中点闭合到最小', () => {
    expect(eyeOpenness(BLINK_DURATION_SECONDS / 2, BLINK_DURATION_SECONDS)).toBeCloseTo(0.08, 5)
  })

  it('★ 眨眼的**起点与终点**必须是完全睁开的', () => {
    // 这是最初那个 bug 的核心：旧实现只要 `blink > 0` 就把眼睛压扁，
    // 于是整个眨眼时长内眼睛几乎都是闭的，宠物看起来**没有眼睛**。
    // 正确的曲线是三角形：只在中间闭合，两端睁开。
    expect(eyeOpenness(BLINK_DURATION_SECONDS, BLINK_DURATION_SECONDS)).toBeCloseTo(1, 5)
    expect(eyeOpenness(0.0001, BLINK_DURATION_SECONDS)).toBeGreaterThan(0.99)
  })

  it('★ 眨眼过程中"接近闭合"的时间占比必须很小', () => {
    // 断言"绝大多数采样点眼睛是明显睁开的"。
    // 这条比逐点断言更能锁住"形状是对的"这件事。
    const samples = 100
    let nearlyClosed = 0
    for (let i = 0; i <= samples; i++) {
      const remaining = (i / samples) * BLINK_DURATION_SECONDS
      if (eyeOpenness(remaining, BLINK_DURATION_SECONDS) < 0.3) nearlyClosed++
    }
    // 三角形曲线下，低于 0.3 的区间约占 30%，取宽松上界 40%
    expect(nearlyClosed / (samples + 1)).toBeLessThan(0.4)
  })

  it('张开度永远落在 [0.08, 1]，不会变成负数或超过 1', () => {
    for (let i = -5; i <= 105; i++) {
      const remaining = (i / 100) * BLINK_DURATION_SECONDS
      const value = eyeOpenness(remaining, BLINK_DURATION_SECONDS)
      expect(value).toBeGreaterThanOrEqual(0.08)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('时长非法时不崩、按完全睁开处理', () => {
    expect(eyeOpenness(0.05, 0)).toBe(1)
    expect(eyeOpenness(0.05, -1)).toBe(1)
  })

  it('剩余时长超过总时长也被夹住（不会算出负的 progress）', () => {
    const value = eyeOpenness(BLINK_DURATION_SECONDS * 3, BLINK_DURATION_SECONDS)
    expect(value).toBeGreaterThanOrEqual(0.08)
    expect(value).toBeLessThanOrEqual(1)
  })
})

describe('呼吸姿态', () => {
  it('幅度很小 —— 大了就变成"喘"', () => {
    for (let i = 0; i < 50; i++) {
      const pose = breathPose(i * 0.13)
      expect(Math.abs(pose.squash)).toBeLessThanOrEqual(0.04)
      expect(Math.abs(pose.stretch)).toBeLessThanOrEqual(0.04)
      expect(Math.abs(pose.offsetY)).toBeLessThanOrEqual(2)
    }
  })

  it('横向与纵向形变方向相反（体积守恒感）', () => {
    const pose = breathPose(0.65) // sin 接近 1
    expect(Math.sign(pose.squash)).toBe(-Math.sign(pose.stretch))
  })

  it('是周期函数，且不会累积漂移', () => {
    const a = breathPose(0, 2.6)
    const b = breathPose(2.6, 2.6)
    expect(a.breath).toBeCloseTo(b.breath, 6)
  })

  it('取值恒在 [-1, 1]', () => {
    for (let i = 0; i < 200; i++) {
      const { breath } = breathPose(i * 0.07)
      expect(breath).toBeGreaterThanOrEqual(-1.0000001)
      expect(breath).toBeLessThanOrEqual(1.0000001)
    }
  })
})

describe('摇摆', () => {
  it('幅度很小（否则宠物会像在晃脑袋）', () => {
    for (let i = 0; i < 100; i++) {
      expect(Math.abs(swayAngle(i * 0.11))).toBeLessThanOrEqual(0.013)
    }
  })

  it('在 t=0 时为零（静止起步，不会突然跳一下）', () => {
    expect(swayAngle(0)).toBe(0)
  })
})
