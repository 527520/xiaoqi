import type { UserNotificationState, WorkMode } from '@shared/types'

/**
 * 打扰闸门 —— 决定宠物**现在允许主动做什么**。
 *
 * 施工令 §9「打扰控制（写进代码，不只是文档）」的落点。这一层刻意独立于
 * 形态闸门（`modeGate.ts`）：
 *
 * - **形态闸门**回答"宠物看起来是什么样"（可见/静默/隐身）；
 * - **打扰闸门**回答"宠物可不可以主动出声"。
 *
 * 两者会得出不同结论，混在一起就必然出错。最典型的例子：
 * 全屏看电影时形态是"静默"（可见的小点），而打扰级别必须是"完全不打扰"；
 * 而用户正常写代码时形态是"正常"、打扰级别也只是"低"——能回应，但不主动。
 *
 * 纯函数，可单测。
 */

/**
 * 打扰级别。从小到大。
 *
 * `silent` 与 `low` 的区别很重要：
 * - `low`：**可以回应**用户（他伸手了），但**不主动**发起。
 * - `silent`：连回应都压到最低限度（只做最小可见反馈），不冒泡、不出声。
 */
export type DisturbLevel =
  /** 完全不主动，且回应压到最小（全屏、锁屏、勿扰时段） */
  | 'silent'
  /** 只回应、不主动（默认） */
  | 'low'
  /** 可以偶尔主动（用户明确调高了主动度，且当前语境合适） */
  | 'normal'

export interface DisturbGateInput {
  readonly mode: WorkMode
  readonly notificationState: UserNotificationState
  /** 用户配置的主动度 ∈ [0,1]。 */
  readonly proactiveness: number
  /** 当前是否处于用户配置的勿扰时段。 */
  readonly inDoNotDisturbWindow: boolean
  /** 宠物形态：隐身时显然什么都不该做。 */
  readonly visibility: 'active' | 'silent' | 'hidden'
}

/**
 * 求当前打扰级别。
 *
 * 判定顺序：**先看"绝对不许"的条件**，再看用户偏好。
 * 这个顺序不能反：用户把主动度调到最高，也不该在全屏电影上冒泡——
 * 施工令 §2 的优先级里「不打扰 > 功能丰富」。
 */
export function resolveDisturbLevel(input: DisturbGateInput): DisturbLevel {
  const { mode, notificationState, proactiveness, inDoNotDisturbWindow, visibility } = input

  // ── 绝对不许打扰的情形 ──
  // QUNS {1,2,3,4}：锁屏、全屏应用、独占全屏、演示模式。
  if (notificationState === 1 || notificationState === 2 || notificationState === 3) {
    return 'silent'
  }
  // 演示模式（4）也要静默——用户正在给别人看屏幕。
  if (notificationState === 4) return 'silent'
  // 勿扰时段：用户明确说了这段时间别烦我。
  if (inDoNotDisturbWindow) return 'silent'
  // 隐身时它根本不在屏幕上，谈不上打扰；但仍归到最低档以保持一致语义。
  if (visibility === 'hidden') return 'silent'

  // ── 会议中：可以回应，但绝不主动 ──
  // 会议是"别人也在场"的场景，宠物主动出声会让用户尴尬。
  if (mode === 'meeting') return 'low'

  // ── 用户正在专注：不主动 ──
  if (mode === 'focus') return 'low'

  // ── 用户在工作但没到专注：允许按用户偏好决定 ──
  // ⚠️ 门槛刻意设得高（0.6）：施工令 §9.1「默认主动度 = 低。宁可少说话。」
  //    默认值在配置里是 0.15，因此默认情况下**永远到不了 normal**。
  if ((mode === 'coding' || mode === 'email') && proactiveness >= 0.6) return 'normal'

  // 休息/下班/周末：用户在放松，可以稍微活泼一点，但门槛同样高。
  if ((mode === 'rest' || mode === 'offWork' || mode === 'weekend') && proactiveness >= 0.75) {
    return 'normal'
  }

  return 'low'
}

/** 当前是否允许**主动**发起互动（冒泡、说话）。 */
export function mayInitiate(level: DisturbLevel): boolean {
  return level === 'normal'
}

/**
 * 当前是否允许**回应**用户。
 *
 * ⚠️★ 这个函数永远返回 `true`，除了隐身（它不在屏幕上）。★
 *
 * 这不是偷懒，是本产品最硬的一条红线（施工令 §1.2⑧ / ADR-0003）：
 * **无条件回应**——用户一旦伸手，宠物必须立即回应，不许提条件。
 * 所以"能不能回应"**不允许**依赖 work mode、打扰级别、主动度、
 * 甚至"被冷落"状态。把任何一条接进来都会立刻违反红线。
 *
 * 这个函数存在的意义是**把这条规则写成代码**，让人改不动它而不用解释。
 */
export function mustRespond(
  _level: DisturbLevel,
  visibility: 'active' | 'silent' | 'hidden',
): boolean {
  // 隐身时它不在屏幕上，没有"回应"的载体；这是唯一的例外，
  // 而且用户一按显示键它必须立刻回来（见 PetWindowController.setManualMode）。
  return visibility !== 'hidden'
}
