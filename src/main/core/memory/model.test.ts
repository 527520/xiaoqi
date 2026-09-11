import { describe, expect, it } from 'vitest'

import type { Emotion } from '@shared/types'

import {
  currentWeight,
  DAY_MS,
  decayWeight,
  EMOTIONAL_HALFLIFE_DAYS,
  EPISODIC_HALFLIFE_DAYS,
  emotionalWeightAt,
  episodicWeightAt,
  FORGET_THRESHOLD,
  isForgotten,
  isValidIntensity,
  SEMANTIC_PROMOTION_THRESHOLD,
  shouldForget,
  shouldPromoteToSemantic,
  STRONG_EMOTION_INTENSITY,
  survivesByIntensity,
  type MemoryRecord,
} from './model'

/** 一个固定的"现在"，让所有测试都是确定性的（不依赖真实时间）。 */
const NOW = new Date(2026, 8, 9, 10, 0, 0).getTime()

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 1,
    kind: 'episodic',
    occurredAt: NOW,
    content: '用户在写代码',
    tags: ['coding'],
    weight: 1,
    ...overrides,
  }
}

describe('遗忘曲线（纯函数，用固定时间戳，不依赖真实时钟）', () => {
  it('刚发生时不衰减', () => {
    expect(episodicWeightAt(1, 0)).toBe(1)
  })

  it('★ 情景记忆半衰期是 1 天 —— 直接对应规格里的「24h 降权」', () => {
    expect(EPISODIC_HALFLIFE_DAYS).toBe(1)
    expect(episodicWeightAt(1, DAY_MS)).toBeCloseTo(0.5, 6)
    expect(episodicWeightAt(1, 2 * DAY_MS)).toBeCloseTo(0.25, 6)
  })

  it('★ 情感记忆衰减**明显更慢** —— 规格说它"衰减最慢"', () => {
    const thirtyDays = 30 * DAY_MS
    const episodic = episodicWeightAt(1, thirtyDays)
    const emotional = emotionalWeightAt(1, thirtyDays)
    expect(emotional).toBeGreaterThan(episodic)
    // 半衰期 30 天 → 30 天后还剩一半
    expect(emotional).toBeCloseTo(0.5, 6)
    expect(EMOTIONAL_HALFLIFE_DAYS).toBeGreaterThan(EPISODIC_HALFLIFE_DAYS)
  })

  it('权重单调递减，且永远为正（指数衰减不到 0）', () => {
    let previous = 1
    for (let day = 1; day <= 30; day++) {
      const w = episodicWeightAt(1, day * DAY_MS)
      expect(w).toBeLessThan(previous)
      expect(w).toBeGreaterThan(0)
      previous = w
    }
  })

  it('非法输入不崩：负时长按不衰减、半衰期 0 按归零处理', () => {
    expect(decayWeight(1, -100, 1)).toBe(1)
    expect(decayWeight(1, Number.NaN, 1)).toBe(1)
    expect(decayWeight(1, DAY_MS, 0)).toBe(0)
  })

  it('初始权重参与计算（不是恒从 1 开始）', () => {
    expect(episodicWeightAt(0.4, DAY_MS)).toBeCloseTo(0.2, 6)
  })
})

describe('分层权重', () => {
  it('语义记忆不衰减（它是"稳定事实"）', () => {
    const semantic = record({ kind: 'semantic', occurredAt: NOW - 365 * DAY_MS })
    expect(currentWeight(semantic, NOW)).toBe(1)
    expect(isForgotten(semantic, NOW)).toBe(false)
  })

  it('工作记忆不参与遗忘（退出即清，由别处负责）', () => {
    const working = record({ kind: 'working', occurredAt: NOW - 365 * DAY_MS })
    expect(isForgotten(working, NOW)).toBe(false)
  })

  it('情景记忆会随时间被遗忘', () => {
    const fresh = record({ occurredAt: NOW })
    const old = record({ occurredAt: NOW - 10 * DAY_MS })
    expect(isForgotten(fresh, NOW)).toBe(false)
    expect(isForgotten(old, NOW)).toBe(true)
  })

  it('情感记忆同样时间点还没被遗忘（衰减慢）', () => {
    const at = NOW - 10 * DAY_MS
    expect(isForgotten(record({ kind: 'episodic', occurredAt: at }), NOW)).toBe(true)
    expect(isForgotten(record({ kind: 'emotional', occurredAt: at, intensity: 1 }), NOW)).toBe(
      false,
    )
  })
})

describe('★ ADR-0003 守卫：情感强度是单次值，不可累积', () => {
  it('合法强度范围是 [0,1]', () => {
    expect(isValidIntensity(0)).toBe(true)
    expect(isValidIntensity(0.5)).toBe(true)
    expect(isValidIntensity(1)).toBe(true)
  })

  it('★ 越界即非法 —— 这正是"累积"的表现形式', () => {
    // 两次 0.6 相加得 1.2：如果实现里做了累加，强度就会越界。
    // 这条检查因此能实际拦住累积式实现，而不只是形式。
    expect(isValidIntensity(1.2)).toBe(false)
    expect(isValidIntensity(-0.1)).toBe(false)
    expect(isValidIntensity(Number.NaN)).toBe(false)
    expect(isValidIntensity(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('★ 强情绪豁免遗忘的依据是**强度**，不是次数', () => {
    // 按次数豁免会变成"同一件小事攒够多次就不忘了"——那正是要避免的累积。
    const strong = record({
      kind: 'emotional',
      occurredAt: NOW - 365 * DAY_MS,
      intensity: STRONG_EMOTION_INTENSITY,
    })
    const weakButMany = record({
      kind: 'emotional',
      occurredAt: NOW - 365 * DAY_MS,
      intensity: 0.2,
    })
    expect(survivesByIntensity(strong)).toBe(true)
    expect(survivesByIntensity(weakButMany)).toBe(false)
    // 强度够 → 一年后仍在
    expect(shouldForget(strong, NOW)).toBe(false)
    // 强度不够 → 一年后已忘（即使这类事发生了很多次）
    expect(shouldForget(weakButMany, NOW)).toBe(true)
  })

  it('情境记忆不会因为"强情绪"而豁免（豁免只属于情感层）', () => {
    const episodic = record({ occurredAt: NOW - 365 * DAY_MS, weight: 1 })
    expect(survivesByIntensity(episodic)).toBe(false)
    expect(shouldForget(episodic, NOW)).toBe(true)
  })

  it('遗忘阈值是个小正数，不是 0（指数衰减到不了 0）', () => {
    expect(FORGET_THRESHOLD).toBeGreaterThan(0)
    expect(FORGET_THRESHOLD).toBeLessThan(0.1)
  })
})

describe('情景 → 语义的升级', () => {
  it('出现次数达到阈值才升级', () => {
    expect(shouldPromoteToSemantic({ records: [], occurrences: 2 })).toBe(false)
    expect(
      shouldPromoteToSemantic({ records: [], occurrences: SEMANTIC_PROMOTION_THRESHOLD }),
    ).toBe(true)
  })

  it('阈值是 3（两次可能是巧合，三次才像习惯）', () => {
    expect(SEMANTIC_PROMOTION_THRESHOLD).toBe(3)
  })

  it('次数可以大于现存记录数（部分已被遗忘）', () => {
    const survivor = record()
    expect(shouldPromoteToSemantic({ records: [survivor], occurrences: 5 })).toBe(true)
  })
})

describe('综合：一条记忆的完整生命周期', () => {
  it('★ 情景记忆从"记得"到"忘了"，情感记忆撑得久得多', () => {
    const episodic = record({ occurredAt: NOW, weight: 1 })
    const emotional = record({
      kind: 'emotional',
      occurredAt: NOW,
      intensity: 0.5,
      emotion: 'happy' as Emotion,
    })

    const checkpoints = [1, 3, 7, 30]
    for (const days of checkpoints) {
      const at = NOW + days * DAY_MS
      const w = currentWeight(episodic, at)
      expect(w).toBeLessThan(1)
    }

    // 7 天后情景记忆已忘，情感记忆还在
    const at7 = NOW + 7 * DAY_MS
    expect(shouldForget(episodic, at7)).toBe(true)
    expect(shouldForget(emotional, at7)).toBe(false)
  })
})
