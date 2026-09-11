import { describe, expect, it } from 'vitest'

import type { DisturbLevel } from '@shared/types'

import { decidePanelLog, PANEL_HEARTBEAT_MS, stateFingerprint } from './debugPanel'
import type { PerceivedState } from './perception'

function state(overrides: Partial<PerceivedState> = {}): PerceivedState {
  return {
    processName: 'code.exe',
    category: 'devTool',
    idleMs: 0,
    notificationState: 5,
    workMode: 'coding',
    workModeReason: '前台是开发工具',
    emotion: { emotion: 'focused', since: 0 },
    physiology: { energy: 0.8, hunger: 0.2, boredom: 0.1, social: 0.2 },
    relationship: { affection: 0.3, trust: 0.4, rapport: 0.1 },
    mood: 'reserved',
    misses: false,
    sameCategoryMs: 0,
    sampledAt: 0,
    uptimeMs: 0,
    lastSuspendMs: 0,
    ...overrides,
  }
}

describe('状态指纹：什么算"有意义的变化"', () => {
  it('前台进程变了 → 指纹变', () => {
    const a = stateFingerprint(state({ processName: 'code.exe' }), 'low')
    const b = stateFingerprint(state({ processName: 'teams.exe' }), 'low')
    expect(a).not.toBe(b)
  })

  it('工作模式变了 → 指纹变', () => {
    const a = stateFingerprint(state({ workMode: 'coding' }), 'low')
    const b = stateFingerprint(state({ workMode: 'meeting' }), 'low')
    expect(a).not.toBe(b)
  })

  it('情绪变了 → 指纹变', () => {
    const a = stateFingerprint(state({ emotion: { emotion: 'calm', since: 0 } }), 'low')
    const b = stateFingerprint(state({ emotion: { emotion: 'happy', since: 0 } }), 'low')
    expect(a).not.toBe(b)
  })

  it('打扰级别变了 → 指纹变', () => {
    expect(stateFingerprint(state(), 'low')).not.toBe(stateFingerprint(state(), 'silent'))
  })

  it('★ 生理量变了**不算**指纹变化（否则节流会被生理量的连续变化冲垮）', () => {
    // 这是这个模块最关键的一条：生理量每拍都在动，
    // 一旦把它算进指纹，`decidePanelLog` 的节流就永远不会生效，
    // 日志又会被每秒 4 行淹掉。
    const a = stateFingerprint(
      state({ physiology: { energy: 0.8, hunger: 0.2, boredom: 0.1, social: 0.2 } }),
      'low',
    )
    const b = stateFingerprint(
      state({ physiology: { energy: 0.5, hunger: 0.9, boredom: 0.7, social: 0.6 } }),
      'low',
    )
    expect(a).toBe(b)
  })

  it('★ 同类状态的连续多拍只产出**一个**指纹', () => {
    const fingerprints = new Set<string>()
    for (let i = 0; i < 50; i++) {
      fingerprints.add(stateFingerprint(state({ uptimeMs: i * 250 }), 'low'))
    }
    expect(fingerprints.size).toBe(1)
  })
})

describe('面板节流决策', () => {
  const base = {
    fingerprint: 'code.exe|coding|focused|low|5',
    lastFingerprint: 'code.exe|coding|focused|low|5',
  }

  it('指纹变化 → 立刻打', () => {
    const d = decidePanelLog({
      ...base,
      fingerprint: 'teams.exe|meeting|focused|low|5',
      now: 1,
      lastLoggedAt: 0,
    })
    expect(d.shouldLog).toBe(true)
    expect(d.isHeartbeat).toBe(false)
  })

  it('指纹未变且未到心跳 → 不打', () => {
    const d = decidePanelLog({ ...base, now: 1000, lastLoggedAt: 0 })
    expect(d.shouldLog).toBe(false)
  })

  it('指纹未变但到了心跳 → 打，且标记为心跳', () => {
    const d = decidePanelLog({ ...base, now: PANEL_HEARTBEAT_MS, lastLoggedAt: 0 })
    expect(d.shouldLog).toBe(true)
    expect(d.isHeartbeat).toBe(true)
  })

  it('★ 高频采样（每秒 4 次）在 1 分钟内最多产出 1 行 + 若干心跳', () => {
    // 这是在复现"淹日志"那个 bug 的场景，并断言它不会再发生。
    const pollMs = 250
    const oneMinute = 60_000
    let lastFingerprint = ''
    let lastLoggedAt = 0
    let logged = 0

    for (let now = 0; now <= oneMinute; now += pollMs) {
      const fingerprint = 'code.exe|coding|focused|low|5'
      const d = decidePanelLog({ fingerprint, now, lastFingerprint, lastLoggedAt })
      if (d.shouldLog) {
        logged++
        lastFingerprint = fingerprint
        lastLoggedAt = now
      }
    }

    // 1 分钟：首行 + 1 次心跳（30s 处）= 2 行上下，绝不该是 240 行
    expect(logged).toBeLessThanOrEqual(3)
    expect(logged).toBeGreaterThan(0)
  })

  it('★ 状态真在变时不会因为节流而漏掉变化', () => {
    // 节流只该压掉"没变化"的重复，不该吞掉真实的状态切换。
    const sequence = [
      'code.exe|coding|focused|low|5',
      'teams.exe|meeting|focused|low|5',
      'code.exe|coding|focused|low|5',
      'msedge.exe|focus|calm|low|5',
    ]
    let lastFingerprint = ''
    let lastLoggedAt = 0
    const logged: string[] = []

    for (const fingerprint of sequence) {
      // 每 250ms 一拍，且状态每拍都换
      for (let i = 0; i < 4; i++) {
        const now = logged.length * 1000 + i * 250
        const d = decidePanelLog({ fingerprint, now, lastFingerprint, lastLoggedAt })
        if (d.shouldLog) {
          logged.push(fingerprint)
          lastFingerprint = fingerprint
          lastLoggedAt = now
        }
      }
    }

    // 四次变化全部被记下
    expect(logged).toEqual(sequence)
  })

  it('可注入心跳间隔（取证时想更密/更疏）', () => {
    const d = decidePanelLog({ ...base, now: 5000, lastLoggedAt: 0, heartbeatMs: 1000 })
    expect(d.shouldLog).toBe(true)
  })
})

describe('打扰级别参与指纹（形态与打扰分别变化都要可见）', () => {
  it('同一进程但打扰级别从 low 变 silent → 指纹变', () => {
    const s = state()
    const levels: DisturbLevel[] = ['low', 'silent']
    const prints = levels.map((l) => stateFingerprint(s, l))
    expect(new Set(prints).size).toBe(2)
  })
})

describe('状态指纹：关系基调', () => {
  it('★ 基调变了 → 指纹变（否则"它突然更黏人了"这件事在日志里看不到）', () => {
    const a = stateFingerprint(state({ mood: 'reserved' }), 'low')
    const b = stateFingerprint(state({ mood: 'attached' }), 'low')
    expect(a).not.toBe(b)
  })

  it('★ "想念"是离散量，进/出该状态各打一次', () => {
    const normal = stateFingerprint(state({ misses: false }), 'low')
    const missing = stateFingerprint(state({ misses: true }), 'low')
    expect(normal).not.toBe(missing)
  })

  it('★ 关系的**百分比**不进指纹（连续量放进去会让节流失效、又淹日志）', () => {
    // 同样的基调与 misses，只有百分比不同 ⇒ 指纹必须一样。
    const a = stateFingerprint(
      state({ relationship: { affection: 0.31, trust: 0.4, rapport: 0.1 } }),
      'low',
    )
    const b = stateFingerprint(
      state({ relationship: { affection: 0.315, trust: 0.401, rapport: 0.101 } }),
      'low',
    )
    expect(a).toBe(b)
  })
})
