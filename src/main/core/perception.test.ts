import { describe, expect, it } from 'vitest'

import type { UserNotificationState } from '@shared/types'

import type { Platform } from '../platform'
import { Perception } from './perception'

/**
 * 假平台：让感知层能在**纯 Node** 下测试，不需要 Electron、不需要 koffi。
 * 这正是 `Platform` 接口存在的意义（施工令 §4.4 铁律）：
 * 内核依赖接口、不依赖实现，所以可以喂任意信号组合。
 */
function fakePlatform(signals: {
  processName?: string | null
  idleMs?: number | null
  notificationState?: UserNotificationState
}): Platform {
  return {
    name: 'fake',
    getForegroundProcessName: () => signals.processName ?? null,
    getIdleMilliseconds: () => signals.idleMs ?? 0,
    queryUserNotificationState: () => signals.notificationState ?? 5,
  }
}

/** 一个确定处于工作时段的时间（周三 10:00，本地时区）。 */
const WORK_TIME = new Date(2026, 8, 9, 10, 0, 0)

/**
 * 建一个感知器 + 可控时钟。
 *
 * ⚠️ 时钟从 `WORK_TIME` 起算，而不是随便一个时间戳：
 *    第一版用了 `1_700_000_000_000`，而那个时刻在本机时区**不在工作时段**，
 *    于是 `code.exe` 被判成 `overtime` 而不是 `coding`——
 *    测试失败的其实是"我把测试时间设错了"，不是实现错了。
 */
function setup(
  signals: Parameters<typeof fakePlatform>[0],
  overrides?: Partial<Pick<Platform, 'getForegroundProcessName'>>,
) {
  const platform = { ...fakePlatform(signals), ...overrides }
  let current = WORK_TIME.getTime()
  const perception = new Perception({ platform, now: () => current })
  return {
    perception,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('感知轮询', () => {
  it('读三项信号并推断工作模式', () => {
    const { perception } = setup({ processName: 'code.exe' })
    const state = perception.tick()
    expect(state.processName).toBe('code.exe')
    expect(state.workMode).toBe('coding')
    expect(state.notificationState).toBe(5)
    expect(state.category).toBe('devTool')
  })

  it('锁屏信号会让工作模式变成休息', () => {
    const { perception } = setup({ processName: 'code.exe', notificationState: 1 })
    expect(perception.tick().workMode).toBe('rest')
  })

  it('拿不到进程名时不崩，类别为 unknown', () => {
    const { perception } = setup({ processName: null })
    const state = perception.tick()
    expect(state.processName).toBeNull()
    expect(state.category).toBe('unknown')
  })

  it('★ 连续同类工具时长会累积（专注判定的输入）', () => {
    const { perception, advance } = setup({ processName: 'code.exe' })
    perception.tick()
    advance(50 * 60 * 1000) // 50 分钟 > FOCUS_MS(45 分钟)
    const state = perception.tick()
    expect(state.sameCategoryMs).toBeGreaterThan(45 * 60 * 1000)
    expect(state.workMode).toBe('focus')
  })

  it('★ 换到别的类别会重置连续时长', () => {
    let name = 'code.exe'
    const { perception, advance } = setup({}, { getForegroundProcessName: () => name })

    perception.tick()
    advance(50 * 60 * 1000)
    expect(perception.tick().workMode).toBe('focus')

    name = 'teams.exe'
    const after = perception.tick()
    expect(after.sameCategoryMs).toBe(0)
    expect(after.workMode).toBe('meeting')
  })

  it('生理量随时间演进：干活时精力下降', () => {
    const { perception, advance } = setup({ processName: 'code.exe' })
    const before = perception.tick().physiology.energy
    advance(60 * 60 * 1000) // 1 小时
    const after = perception.tick().physiology.energy
    expect(after).toBeLessThan(before)
  })

  it('休息时精力回升', () => {
    const { perception, advance } = setup({ processName: 'code.exe', idleMs: 30 * 60 * 1000 })
    const before = perception.tick().physiology.energy
    advance(60 * 60 * 1000)
    const after = perception.tick().physiology.energy
    expect(after).toBeGreaterThan(before)
  })

  it('互动会降低社交欲', () => {
    const { perception, advance } = setup({ processName: 'code.exe' })
    const base = perception.tick().physiology.social
    advance(1000)
    perception.noteInteraction()
    expect(perception.tick().physiology.social).toBeLessThan(base)
  })

  it('dispose 之后手动 tick 仍不崩（计时器已清）', () => {
    const { perception } = setup({})
    perception.dispose()
    expect(() => perception.tick()).not.toThrow()
  })

  it('快照在 tick 之后可用；未 tick 时为 null', () => {
    const { perception } = setup({ processName: 'code.exe' })
    expect(perception.snapshot).toBeNull()
    perception.tick()
    expect(perception.snapshot).not.toBeNull()
  })

  it('flashEmotion 会立刻改变情绪，且在窗口期内不被基础情绪覆盖', () => {
    const { perception, advance } = setup({ processName: 'code.exe' })
    perception.tick()

    // 先把时钟推远一点，避免 tick 内部的"瞬时情绪窗口"判定还停留在过去
    advance(5000)
    perception.flashEmotion('surprised')
    expect(perception.snapshot?.emotion.emotion).toBe('surprised')

    // 同一时刻再 tick 一次：瞬时情绪还在窗口内，不该被基础情绪盖掉
    expect(perception.tick().emotion.emotion).toBe('surprised')

    // 窗口过后回落到基础情绪
    advance(5000)
    expect(perception.tick().emotion.emotion).not.toBe('surprised')
  })

  it('★ describe() 只输出进程名与聚合量，不含任何用户内容', () => {
    // 调试面板是唯一会把感知结果显示出来的地方，必须确认它不越界：
    // 允许出现"进程名 + 数字 + 我们自己的说明文字"，
    // **不允许**出现任何来自窗口内容的东西。
    const { perception } = setup({ processName: 'msedge.exe', idleMs: 12_000 })
    perception.tick()
    const lines = perception.describe().join('\n')

    expect(lines).toContain('msedge.exe')
    // 不该出现 URL、文件路径、或任何像"网页/文档标题"的内容
    expect(lines).not.toMatch(/https?:\/\//)
    expect(lines).not.toMatch(/[A-Za-z]:\\/) // Windows 路径
    expect(lines).not.toMatch(/\.(ts|js|md|docx|xlsx|pdf)\b/)
    // 也不该出现"标题是什么"这类措辞（说明里提到"不读标题"是允许的，
    // 因为它是在声明**不读**，不是在展示读到的内容）
    expect(lines).not.toMatch(/标题[：:]/)
    expect(lines).not.toMatch(/title\s*[:=]/i)
  })
})
