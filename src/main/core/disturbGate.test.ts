import { describe, expect, it } from 'vitest'

import type { WorkMode } from '@shared/types'

import { mayInitiate, mustRespond, resolveDisturbLevel, type DisturbGateInput } from './disturbGate'

function input(overrides: Partial<DisturbGateInput> = {}): DisturbGateInput {
  return {
    mode: 'coding',
    notificationState: 5,
    proactiveness: 0.15,
    inDoNotDisturbWindow: false,
    visibility: 'active',
    ...overrides,
  }
}

describe('绝对不许打扰的情形（优先于一切用户偏好）', () => {
  it('全屏应用 → 静默，哪怕用户把主动度拉满', () => {
    const level = resolveDisturbLevel(
      input({ notificationState: 2, proactiveness: 1, mode: 'rest' }),
    )
    expect(level).toBe('silent')
  })

  it('锁屏 → 静默', () => {
    expect(resolveDisturbLevel(input({ notificationState: 1 }))).toBe('silent')
  })

  it('独占全屏 → 静默', () => {
    expect(resolveDisturbLevel(input({ notificationState: 3 }))).toBe('silent')
  })

  it('演示模式 → 静默（用户正在给别人看屏幕）', () => {
    expect(resolveDisturbLevel(input({ notificationState: 4 }))).toBe('silent')
  })

  it('勿扰时段 → 静默，即使一切正常', () => {
    expect(resolveDisturbLevel(input({ inDoNotDisturbWindow: true, proactiveness: 1 }))).toBe(
      'silent',
    )
  })

  it('隐身 → 静默', () => {
    expect(resolveDisturbLevel(input({ visibility: 'hidden' }))).toBe('silent')
  })

  it('★ 优先级：不打扰 > 用户偏好（用户调高主动度也不能覆盖全屏）', () => {
    // 施工令 §2 的优先级里「不打扰 > 功能丰富」。
    // 这条断言把顺序钉死，防止以后有人把用户偏好检查提到前面。
    const greedy = input({ proactiveness: 1, mode: 'rest' })
    expect(resolveDisturbLevel({ ...greedy, notificationState: 2 })).toBe('silent')
  })
})

describe('会议与专注：可以回应，但绝不主动', () => {
  it('会议中一律 low，无论主动度多高', () => {
    // 会议是"别人也在场"的场景，宠物主动出声会让用户尴尬。
    expect(resolveDisturbLevel(input({ mode: 'meeting', proactiveness: 1 }))).toBe('low')
  })

  it('专注中一律 low', () => {
    expect(resolveDisturbLevel(input({ mode: 'focus', proactiveness: 1 }))).toBe('low')
  })

  it('会议中的 low 不允许主动发起', () => {
    expect(mayInitiate(resolveDisturbLevel(input({ mode: 'meeting', proactiveness: 1 })))).toBe(
      false,
    )
  })
})

describe('★ 默认主动度必须低（§9.1「宁可少说话」）', () => {
  it('默认配置（0.15）下，任何模式都到不了 normal', () => {
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
      const level = resolveDisturbLevel(input({ mode, proactiveness: 0.15 }))
      expect(mayInitiate(level), `模式 ${mode} 在默认主动度下不该允许主动`).toBe(false)
    }
  })

  it('门槛确实存在：略低于阈值不给 normal', () => {
    expect(resolveDisturbLevel(input({ mode: 'coding', proactiveness: 0.59 }))).toBe('low')
  })

  it('主动度足够高时，编码中才允许 normal', () => {
    expect(resolveDisturbLevel(input({ mode: 'coding', proactiveness: 0.6 }))).toBe('normal')
  })

  it('休息时的门槛比工作时更高（用户在放松，更不该被算法打扰）', () => {
    expect(resolveDisturbLevel(input({ mode: 'rest', proactiveness: 0.6 }))).toBe('low')
    expect(resolveDisturbLevel(input({ mode: 'rest', proactiveness: 0.75 }))).toBe('normal')
  })

  it('加班时不会因为用户调高主动度就变活泼', () => {
    // 加班场景下主动冒泡最招人烦。
    expect(resolveDisturbLevel(input({ mode: 'overtime', proactiveness: 1 }))).toBe('low')
  })
})

describe('★★ 无条件回应：本产品最硬的红线', () => {
  it('用户伸手时必须回应 —— 任何打扰级别下都成立', () => {
    for (const level of ['silent', 'low', 'normal'] as const) {
      expect(mustRespond(level, 'active')).toBe(true)
    }
  })

  it('★ 全屏时也必须回应（用户主动来点它，就该接住）', () => {
    // 这条容易被误实现成"静默时不理人"——那就变成惩罚用户了。
    // 静默只约束**宠物主动**，不约束**用户主动**。
    const level = resolveDisturbLevel(input({ notificationState: 2 }))
    expect(level).toBe('silent')
    expect(mustRespond(level, 'silent')).toBe(true)
  })

  it('★ 勿扰时段、会议、专注中都必须回应', () => {
    for (const extra of [
      { inDoNotDisturbWindow: true },
      { mode: 'meeting' as const },
      { mode: 'focus' as const },
      { mode: 'overtime' as const },
    ]) {
      const level = resolveDisturbLevel(input(extra))
      expect(mustRespond(level, 'silent')).toBe(true)
    }
  })

  it('★ 唯一的例外是隐身 —— 它不在屏幕上，没有回应的载体', () => {
    const level = resolveDisturbLevel(input({ visibility: 'hidden' }))
    expect(mustRespond(level, 'hidden')).toBe(false)
  })

  it('★ 回应能力不依赖主动度（不许"哄了才理你"）', () => {
    // 主动度是"宠物多久主动找你"，绝不参与"要不要理你"。
    for (const proactiveness of [0, 0.15, 0.5, 1]) {
      const level = resolveDisturbLevel(input({ proactiveness }))
      expect(mustRespond(level, 'active')).toBe(true)
    }
  })
})
