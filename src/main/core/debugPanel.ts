import type { DisturbLevel } from '@shared/types'

import type { PerceivedState } from './perception'

/**
 * 状态调试面板的**判定逻辑**（纯函数，可单测）。
 *
 * 抽出来的理由很具体：面板最初每拍打一行，加上取证用的
 * `XIAOQI_PERCEPTION_INTERVAL_MS` 之后变成每秒约 4 行，
 * 第一次跑就淹了整份日志，真正有用的行（形态切换、错误）全被埋掉。
 *
 * 那次之后我改成"变化必打 + 平稳时心跳"。但**节流本身没有测试**：
 * 它是纯逻辑，却因为和 `console`/`log` 混在一起而没法验证。
 * 抽到这里之后，"会不会又淹日志"就变成可断言的事了——
 * 施工令 §9 说"不打扰"，调试输出也不该例外，而"不该淹"必须能被检查。
 */

/** 平稳时的心跳间隔。变化时不受它限制。 */
export const PANEL_HEARTBEAT_MS = 30_000

/**
 * 计算"状态指纹"。
 *
 * 只包含**有意义的变化**：前台进程、工作模式、情绪、打扰级别、系统状态、
 * 以及**关系基调**。
 *
 * ── 为什么含关系基调，而不含关系的三个百分比 ──
 *
 * 同样的理由：好感/信任/默契是**连续变化**的，放进来会让每一拍都算"变了"，
 * 节流立刻失效、又回到淹日志的老样子。
 * 但**基调**是离散的（reserved/warm/attached），它变化意味着宠物的表现
 * 会明显不同——那正是调试时想看到的那一行。
 *
 * 生理量与关系的原始百分比由心跳行负责体现"它们还在动"。
 */
export function stateFingerprint(state: PerceivedState, level: DisturbLevel): string {
  return [
    state.processName ?? '?',
    state.workMode,
    state.emotion.emotion,
    level,
    String(state.notificationState),
    state.mood,
    // 想念只打一次（进/出该状态时），它是个离散的布尔量。
    state.misses ? 'miss' : '-',
  ].join('|')
}

export interface PanelDecisionInput {
  readonly fingerprint: string
  /** 本次采样的时刻（毫秒）。 */
  readonly now: number
  /** 上一次打日志的指纹；首次为空字符串。 */
  readonly lastFingerprint: string
  /** 上一次打日志的时刻；首次为 0。 */
  readonly lastLoggedAt: number
  readonly heartbeatMs?: number
}

export interface PanelDecision {
  /** 是否应该打这一行。 */
  readonly shouldLog: boolean
  /** 是否属于心跳（指纹没变、只是到点了）。给日志加个标记用。 */
  readonly isHeartbeat: boolean
}

/**
 * 决定这一拍要不要打日志。
 *
 * 规则：
 * - **指纹变了 → 必须打**（那才是有信息量的：形态切换、换应用、情绪变了）；
 * - 指纹没变 → 只有距上次超过心跳间隔才打，避免刷屏。
 */
export function decidePanelLog(input: PanelDecisionInput): PanelDecision {
  const heartbeatMs = input.heartbeatMs ?? PANEL_HEARTBEAT_MS
  const changed = input.fingerprint !== input.lastFingerprint
  if (changed) return { shouldLog: true, isHeartbeat: false }
  const shouldLog = input.now - input.lastLoggedAt >= heartbeatMs
  return { shouldLog, isHeartbeat: shouldLog }
}
