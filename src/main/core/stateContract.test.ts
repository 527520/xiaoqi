import { describe, expect, it } from 'vitest'

import type { DisturbLevel, Emotion, WorkMode } from '@shared/types'

import { mustRespond, resolveDisturbLevel } from './disturbGate'
import {
  EMOTION_MIN_INTERVAL_MS,
  INITIAL_PHYSIOLOGY,
  stepEmotion,
  stepPhysiology,
} from './physiology'
import { inferWorkMode } from './workMode'

/**
 * 端到端的**契约**测试：从"读到一个进程名"一路推到"渲染层该收到什么"。
 *
 * 前面每个文件都有细粒度的单测，但那些只覆盖各自的环节。
 * 这一组走完整条链，用来回答一个更难的问题：
 * **把它们接起来之后，外面看到的状态还成立吗？**
 *
 * 之所以值得单独写：每一环都对、接起来错，是这类"状态引擎"最典型的失败方式。
 */

/** 造一个工作日的给定时刻（周三）。 */
function weekday(hour: number, minute = 0): Date {
  return new Date(2026, 8, 9, hour, minute, 0)
}

/** 走完整条链：进程名 → 类别 → 工作模式 → 生理 → 情绪。 */
function deriveState(options: {
  processName: string | null
  at: Date
  idleMs?: number
  notificationState?: 1 | 2 | 3 | 4 | 5 | 6 | 7
  sameCategoryMs?: number
  physiology?: typeof INITIAL_PHYSIOLOGY
  proactiveness?: number
  visibility?: 'active' | 'silent' | 'hidden'
  inDoNotDisturbWindow?: boolean
}): { mode: WorkMode; emotion: Emotion; level: DisturbLevel; responds: boolean } {
  const {
    processName,
    at,
    idleMs = 0,
    notificationState = 5,
    sameCategoryMs = 0,
    physiology = INITIAL_PHYSIOLOGY,
    proactiveness = 0.15,
    visibility = 'active',
    inDoNotDisturbWindow = false,
  } = options

  const mode = inferWorkMode({
    processName,
    idleMs,
    notificationState,
    now: at,
    sameCategoryMs,
  }).mode

  // 情绪需要"上一拍"作为输入；这里用初始生理量推一拍即可。
  const emotion = stepEmotion(
    { emotion: 'calm', since: at.getTime() - EMOTION_MIN_INTERVAL_MS * 2 },
    physiology,
    mode,
    at.getTime(),
  ).emotion

  const level = resolveDisturbLevel({
    mode,
    notificationState,
    proactiveness,
    inDoNotDisturbWindow,
    visibility,
  })

  return { mode, emotion, level, responds: mustRespond(level, visibility) }
}

describe('契约：进程名 → 渲染层看到的状态', () => {
  it('写代码 → 编码 + 专注陪伴 + 不主动但会回应', () => {
    const s = deriveState({ processName: 'code.exe', at: weekday(10) })
    expect(s.mode).toBe('coding')
    expect(s.emotion).toBe('focused')
    expect(s.level).toBe('low')
    expect(s.responds).toBe(true)
  })

  it('开会 → 会议 + 专注陪伴（安静陪着）+ 不主动', () => {
    const s = deriveState({ processName: 'teams.exe', at: weekday(10) })
    expect(s.mode).toBe('meeting')
    expect(s.level).toBe('low')
    expect(s.responds).toBe(true)
  })

  it('深夜写代码 → 加班，且即使主动度拉满也不主动', () => {
    const s = deriveState({ processName: 'code.exe', at: weekday(23), proactiveness: 1 })
    expect(s.mode).toBe('overtime')
    expect(s.level).toBe('low')
  })

  it('★ 浏览器 → 不装懂（专注），且说明里写明不读标题', () => {
    const r = inferWorkMode({
      processName: 'msedge.exe',
      idleMs: 0,
      notificationState: 5,
      now: weekday(10),
      sameCategoryMs: 0,
    })
    expect(r.mode).toBe('focus')
    expect(r.reason).toContain('不读标题')
  })

  it('★ 全屏看电影 → 形态静默 + 打扰 silent，但用户点它仍然必须回应', () => {
    const s = deriveState({ processName: 'potplayer.exe', at: weekday(21), notificationState: 2 })
    expect(s.level).toBe('silent')
    expect(s.responds).toBe(true)
  })

  it('★ 勿扰时段 → silent，但用户伸手仍然必须回应', () => {
    const s = deriveState({ processName: 'code.exe', at: weekday(10), inDoNotDisturbWindow: true })
    expect(s.level).toBe('silent')
    expect(s.responds).toBe(true)
  })

  it('★ 隐身是唯一的"不回应"情形', () => {
    const s = deriveState({ processName: 'code.exe', at: weekday(10), visibility: 'hidden' })
    expect(s.level).toBe('silent')
    expect(s.responds).toBe(false)
  })

  it('★ 端到端：任何组合下，"回应能力"都不依赖主动度', () => {
    // 这是 ADR-0003 无条件回应的最强形式：把主动度从 0 扫到 1，
    // 只要不是隐身，回应都必须为 true。
    for (const proactiveness of [0, 0.15, 0.5, 0.9, 1]) {
      for (const name of ['code.exe', 'teams.exe', 'outlook.exe', 'msedge.exe', null]) {
        const s = deriveState({ processName: name, at: weekday(14), proactiveness })
        expect(s.responds, `主动度 ${String(proactiveness)} / 进程 ${String(name)}`).toBe(true)
      }
    }
  })

  it('★ 默认主动度下，八种工作模式全都不允许主动', () => {
    // §9.1「默认主动度 = 低。宁可少说话。」
    const samples: { name: string | null; at: Date; idleMs?: number; n?: 1 | 2 | 5 }[] = [
      { name: 'code.exe', at: weekday(11) },
      { name: 'teams.exe', at: weekday(11) },
      { name: 'outlook.exe', at: weekday(11) },
      { name: 'msedge.exe', at: weekday(11) },
      { name: 'steam.exe', at: weekday(11) },
      { name: 'code.exe', at: weekday(23) },
      { name: 'unknown.exe', at: weekday(23) },
      { name: 'unknown.exe', at: new Date(2026, 8, 12, 14, 0, 0) }, // 周六
    ]
    const modes = new Set<WorkMode>()
    for (const sample of samples) {
      const s = deriveState({
        processName: sample.name,
        at: sample.at,
        ...(sample.idleMs === undefined ? {} : { idleMs: sample.idleMs }),
      })
      modes.add(s.mode)
      expect(s.level, `模式 ${s.mode} 在默认主动度下不该允许主动`).not.toBe('normal')
    }
    // 顺带确认这条链确实覆盖到了多种模式
    expect(modes.size).toBeGreaterThanOrEqual(6)
  })

  it('★ 生理量跨模式演进时不会产出任何越界值', () => {
    let physiology = INITIAL_PHYSIOLOGY
    const modes: (string | null)[] = ['code.exe', 'teams.exe', 'steam.exe', 'msedge.exe', null]
    for (let i = 0; i < 200; i++) {
      const name = modes[i % modes.length] ?? null
      const at = weekday(10 + (i % 12))
      const mode = inferWorkMode({
        processName: name,
        idleMs: 0,
        notificationState: 5,
        now: at,
        sameCategoryMs: 0,
      }).mode
      physiology = stepPhysiology(physiology, 5 * 60 * 1000, mode, i % 7 === 0)
      for (const value of Object.values(physiology)) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })
})
