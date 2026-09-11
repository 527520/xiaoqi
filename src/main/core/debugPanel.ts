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
 * 只包含**有意义的变化**：前台进程、工作模式、情绪、打扰级别、系统状态。
 * **刻意不含生理量**——它们是连续变化的，放进来会让每一拍都算"变了"，
 * 节流立刻失效、又回到淹日志的老样子。
 *
 * 生理量的"还在动"由心跳行负责体现。
 */
export function stateFingerprint(state: PerceivedState, level: DisturbLevel): string {
  return [
    state.processName ?? '?',
    state.workMode,
    state.emotion.emotion,
    level,
    String(state.notificationState),
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
