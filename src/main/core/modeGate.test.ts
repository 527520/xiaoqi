import { describe, expect, it } from 'vitest'

import { QUNS_DEBOUNCE_COUNT } from '@shared/constants'
import type { UserNotificationState, VisibilityMode } from '@shared/types'

import {
  createModeGateState,
  effectiveMode,
  reduceModeGate,
  shouldAcceptCursor,
  type ModeGateResult,
  type ModeGateState,
} from './modeGate'

/** 把闸门推进 n 次，返回最终结果。 */
function advance(
  initial: ModeGateState,
  state: UserNotificationState,
  rounds: number,
): ModeGateResult {
  let gate = initial
  let silenceHits = 0
  let activeHits = 0
  let last: ModeGateResult = {
    mode: effectiveMode(gate),
    state: gate,
    silenceHits,
    activeHits,
  }

  for (let i = 0; i < rounds; i++) {
    last = reduceModeGate({
      userNotificationState: state,
      manual: gate.manual,
      previous: gate,
      silenceHits,
      activeHits,
    })
    gate = last.state
    silenceHits = last.silenceHits
    activeHits = last.activeHits
  }

  return last
}

describe('形态闸门：全屏自动静默', () => {
  it('初始形态是 active', () => {
    expect(effectiveMode(createModeGateState())).toBe('active')
  })

  it(`QUNS=2（全屏）连续 ${String(QUNS_DEBOUNCE_COUNT)} 次后进入静默`, () => {
    const result = advance(createModeGateState(), 2, QUNS_DEBOUNCE_COUNT)
    expect(result.state.auto).toBe('silent')
    expect(result.mode).toBe('silent')
  })

  it('抖动一次不会立刻静默（防抖有效）', () => {
    // 全屏切换的瞬间 QUNS 可能在 2 与 5 之间跳几次，
    // 宠物若跟着抖会非常扎眼。
    const once = advance(createModeGateState(), 2, 1)
    expect(once.state.auto).toBe('active')
  })

  it('全屏退出后恢复到 active', () => {
    const silenced = advance(createModeGateState(), 2, QUNS_DEBOUNCE_COUNT)
    expect(silenced.state.auto).toBe('silent')

    const restored = advance(silenced.state, 5, QUNS_DEBOUNCE_COUNT)
    expect(restored.state.auto).toBe('active')
  })

  it('每种"需要静默"的 QUNS 取值都能触发静默', () => {
    for (const state of [1, 2, 3, 4] as UserNotificationState[]) {
      const result = advance(createModeGateState(), state, QUNS_DEBOUNCE_COUNT)
      expect(result.state.auto).toBe('silent')
    }
  })

  it('QUNS=0（调用失败）不会让宠物静默', () => {
    // 这是刻意的不对称：一次原生调用失败不该让宠物永久缩成小点。
    const result = advance(createModeGateState(), 0, 10)
    expect(result.state.auto).toBe('active')
  })

  it('QUNS=6（系统安静时段）不由本闸门静默 —— 勿扰时段是另一层逻辑', () => {
    const result = advance(createModeGateState(), 6, 10)
    expect(result.state.auto).toBe('active')
  })
})

describe('形态闸门：用户手动值优先', () => {
  it('手动隐身时，即使系统状态正常也是 hidden', () => {
    const gate: ModeGateState = { manual: 'hidden', auto: 'active' }
    expect(effectiveMode(gate)).toBe('hidden')
  })

  it('手动隐身时，自动层仍然照常跟踪系统状态', () => {
    // 这点很重要：用户在游戏里按了隐身，退出游戏后 auto 应该已经回到 active，
    // 而不是停留在"进入游戏那一刻"的状态。
    const gate: ModeGateState = { manual: 'hidden', auto: 'active' }
    const result = advance(gate, 2, QUNS_DEBOUNCE_COUNT)
    expect(result.state.auto).toBe('silent')
    expect(result.mode).toBe('hidden') // 手动值仍然赢
  })

  it('手动值清空后，立刻回落到自动值', () => {
    const gate: ModeGateState = { manual: null, auto: 'silent' }
    expect(effectiveMode(gate)).toBe('silent')
  })

  it('手动静默在没有全屏时也保持静默', () => {
    const gate: ModeGateState = { manual: 'silent', auto: 'active' }
    const result = advance(gate, 5, 5)
    expect(result.mode).toBe('silent')
    expect(result.state.auto).toBe('active')
  })
})

describe('静默/隐身下的鼠标事件', () => {
  it('正常与静默都接受鼠标事件 —— 静默仍然可见，用户点它必须得到回应', () => {
    // 施工令 §1.2⑧「无条件回应」：只要用户伸手，宠物必须接住。
    // 静默态（缩成小点）也可见，所以也必须在可点范围内。
    expect(shouldAcceptCursor('active')).toBe(true)
    expect(shouldAcceptCursor('silent')).toBe(true)
  })

  it('隐身不接受鼠标事件 —— 否则会留下"看不见但挡住下层"的幽灵窗口', () => {
    expect(shouldAcceptCursor('hidden')).toBe(false)
  })
})

describe('形态取值完备性', () => {
  it('三种形态都有明确语义，没有遗漏分支', () => {
    const modes: VisibilityMode[] = ['active', 'silent', 'hidden']
    for (const mode of modes) {
      expect(typeof shouldAcceptCursor(mode)).toBe('boolean')
    }
  })
})
