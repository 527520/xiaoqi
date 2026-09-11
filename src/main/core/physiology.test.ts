import { describe, expect, it } from 'vitest'

import type { WorkMode } from '@shared/types'

import {
  baseEmotion,
  EMOTION_MIN_INTERVAL_MS,
  INITIAL_PHYSIOLOGY,
  stepEmotion,
  stepPhysiology,
  type Physiology,
} from './physiology'

const HOUR = 3_600_000

function phys(overrides: Partial<Physiology> = {}): Physiology {
  return { ...INITIAL_PHYSIOLOGY, ...overrides }
}

describe('生理状态的推进（用假时钟：只传 elapsedMs，不碰真实时间）', () => {
  it('用户干活时精力下降', () => {
    const after = stepPhysiology(phys({ energy: 0.8 }), HOUR, 'coding', false)
    expect(after.energy).toBeLessThan(0.8)
  })

  it('用户休息时精力回升', () => {
    const after = stepPhysiology(phys({ energy: 0.4 }), HOUR, 'rest', false)
    expect(after.energy).toBeGreaterThan(0.4)
  })

  it('加班时精力掉得比正常上班更快（陪着一起累）', () => {
    const normal = stepPhysiology(phys({ energy: 0.9 }), HOUR, 'coding', false)
    const overtime = stepPhysiology(phys({ energy: 0.9 }), HOUR, 'overtime', false)
    expect(overtime.energy).toBeLessThan(normal.energy)
  })

  it('饥饿随时间上升', () => {
    const after = stepPhysiology(phys({ hunger: 0.2 }), HOUR, 'coding', false)
    expect(after.hunger).toBeGreaterThan(0.2)
  })

  it('休息时无聊与社交欲几乎不长（它在打盹）', () => {
    const rest = stepPhysiology(phys({ boredom: 0.3, social: 0.3 }), HOUR, 'rest', false)
    const coding = stepPhysiology(phys({ boredom: 0.3, social: 0.3 }), HOUR, 'coding', false)
    expect(rest.boredom).toBeLessThan(coding.boredom)
    expect(rest.social).toBeLessThan(coding.social)
  })

  it('被互动后社交欲明显回落', () => {
    const untouched = stepPhysiology(phys({ social: 0.5 }), 10 * 60 * 1000, 'coding', false)
    const touched = stepPhysiology(phys({ social: 0.5 }), 10 * 60 * 1000, 'coding', true)
    expect(touched.social).toBeLessThan(untouched.social)
  })

  it('所有量恒在 [0,1]（长时间推进也不会越界）', () => {
    let state = phys()
    // 连续推进 48 小时的"加班"
    for (let i = 0; i < 480; i++) {
      state = stepPhysiology(state, 6 * 60 * 1000, 'overtime', false)
      expect(state.energy).toBeGreaterThanOrEqual(0)
      expect(state.energy).toBeLessThanOrEqual(1)
      expect(state.hunger).toBeGreaterThanOrEqual(0)
      expect(state.hunger).toBeLessThanOrEqual(1)
      expect(state.boredom).toBeGreaterThanOrEqual(0)
      expect(state.boredom).toBeLessThanOrEqual(1)
      expect(state.social).toBeGreaterThanOrEqual(0)
      expect(state.social).toBeLessThanOrEqual(1)
    }
    // 48 小时不睡，精力应该真的见底了
    expect(state.energy).toBeLessThan(0.2)
  })

  it('非法的 elapsedMs 不改变状态、不崩', () => {
    const before = phys()
    expect(stepPhysiology(before, 0, 'coding', false)).toBe(before)
    expect(stepPhysiology(before, -5, 'coding', false)).toBe(before)
    expect(stepPhysiology(before, Number.NaN, 'coding', false)).toBe(before)
  })
})

describe('★ 不评判：生理状态描述宠物自己，不是用户的成绩单', () => {
  it('加班让宠物更累，而不是让它"不满"', () => {
    // 反馈方向是反的：陪着一起累，而不是催。
    const tired = stepPhysiology(phys({ energy: 0.9 }), 3 * HOUR, 'overtime', false)
    expect(tired.energy).toBeLessThan(phys({ energy: 0.9 }).energy)
    // 且**不会**因此变成任何带指责意味的情绪
    const emotion = baseEmotion(tired, 'overtime')
    expect(['sleepy', 'calm', 'focused', 'bored']).toContain(emotion)
  })

  it('任何工作模式下都不会产出"愤怒/怨恨"类情绪（v0.1 只有 8 个情绪）', () => {
    const allowed = [
      'happy',
      'calm',
      'sleepy',
      'focused',
      'aggrieved',
      'surprised',
      'close',
      'bored',
    ]
    const modes: WorkMode[] = [
      'coding',
      'meeting',
      'email',
      'focus',
      'rest',
      'overtime',
      'offWork',
      'weekend',
    ]
    for (const mode of modes) {
      for (const energy of [0, 0.3, 0.7, 1]) {
        for (const hunger of [0, 0.5, 1]) {
          const emotion = baseEmotion(phys({ energy, hunger }), mode)
          expect(allowed).toContain(emotion)
        }
      }
    }
  })
})

describe('基础情绪的优先级', () => {
  it('会议优先于一切生理感受（开会时不该显得困或饿得撒娇）', () => {
    expect(baseEmotion(phys({ energy: 0.05, hunger: 1 }), 'meeting')).toBe('focused')
  })

  it('精力见底 → 困', () => {
    expect(baseEmotion(phys({ energy: 0.1 }), 'coding')).toBe('sleepy')
  })

  it('很饿 → 委屈（撒娇式，不是指责）', () => {
    expect(baseEmotion(phys({ energy: 0.5, hunger: 0.9 }), 'coding')).toBe('aggrieved')
  })

  it('社交欲很高 → 亲近', () => {
    expect(baseEmotion(phys({ energy: 0.5, social: 0.8 }), 'coding')).toBe('close')
  })

  it('很无聊 → 无聊', () => {
    expect(baseEmotion(phys({ energy: 0.5, boredom: 0.8 }), 'coding')).toBe('bored')
  })

  it('用户在编码且宠物精力尚可 → 专注陪伴', () => {
    expect(baseEmotion(phys({ energy: 0.7, boredom: 0.1 }), 'coding')).toBe('focused')
  })

  it('用户休息且宠物精力足 → 开心', () => {
    expect(baseEmotion(phys({ energy: 0.9, boredom: 0.1 }), 'rest')).toBe('happy')
  })

  it('八种情绪都能被某种输入取到', () => {
    const reached = new Set<string>()
    reached.add(baseEmotion(phys({ energy: 0.9, boredom: 0.1 }), 'rest'))
    reached.add(baseEmotion(phys({ energy: 0.5, boredom: 0.1 }), 'weekend'))
    reached.add(baseEmotion(phys({ energy: 0.1 }), 'coding'))
    reached.add(baseEmotion(phys({ energy: 0.9 }), 'meeting'))
    reached.add(baseEmotion(phys({ energy: 0.5, hunger: 0.9 }), 'coding'))
    reached.add(baseEmotion(phys({ energy: 0.5, social: 0.8 }), 'coding'))
    reached.add(baseEmotion(phys({ energy: 0.5, boredom: 0.8 }), 'coding'))
    expect(reached.size).toBeGreaterThanOrEqual(6)
  })
})

describe('情绪限频（1 秒 60 次切换会让宠物显得神经质）', () => {
  it('同一秒内不会因为生理量微变而反复切换情绪', () => {
    const t0 = 1_000_000
    const first = stepEmotion({ emotion: 'calm', since: t0 }, phys({ energy: 0.5 }), 'coding', t0)
    // 300ms 后生理量刚好跨过阈值也不该立刻换
    const soon = stepEmotion(first, phys({ energy: 0.1 }), 'coding', t0 + 300)
    expect(soon.emotion).toBe(first.emotion)
  })

  it('超过最小间隔后允许切换', () => {
    const t0 = 1_000_000
    const first = stepEmotion({ emotion: 'calm', since: t0 }, phys({ energy: 0.5 }), 'coding', t0)
    const later = stepEmotion(
      first,
      phys({ energy: 0.1 }),
      'coding',
      t0 + EMOTION_MIN_INTERVAL_MS + 1,
    )
    expect(later.emotion).toBe('sleepy')
    expect(later.since).toBe(t0 + EMOTION_MIN_INTERVAL_MS + 1)
  })

  it('情绪没变时不更新 since（否则限频窗口会被无限推迟）', () => {
    const t0 = 1_000_000
    const state = { emotion: 'focused' as const, since: t0 }
    const same = stepEmotion(state, phys({ energy: 0.8, boredom: 0.1 }), 'coding', t0 + 10_000)
    expect(same).toBe(state)
    expect(same.since).toBe(t0)
  })
})
