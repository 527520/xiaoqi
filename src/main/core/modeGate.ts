import { QUNS_DEBOUNCE_COUNT } from '@shared/constants'
import { shouldSilence } from '@shared/geometry'
import type { UserNotificationState, VisibilityMode } from '@shared/types'

/**
 * 形态闸门 —— 把「系统级状态」翻译成「宠物该以什么形态存在」。
 *
 * 这是纯逻辑（无 IO、无计时器），因此**可以被单测完整覆盖**——
 * 换句话说是"全屏自动静默"这条需求唯一可自动验证的那一半。
 * 原生轮询与窗口操作在 `main/window/petWindow.ts`，那一半只能靠实测记录。
 *
 * ── 三态语义（严格按 CONTEXT.md，不要混用）──
 *
 * - `active` 正常：完整动画、可点击
 * - `silent` **静默**：仍然可见（缩成小点呼吸），但停止动画、不冒泡。
 *            全屏/锁屏时自动进入。**注意静默不等于隐藏**——
 *            CONTEXT.md 明确"用户能看见它，因此知道它没崩"（§9.5 它可以安静，
 *            但不能装死）。
 * - `hidden` **隐身**：完全从屏幕上消失。只有用户手动触发（或屏幕共享）才进入。
 *
 * ⚠️ 全屏时选"静默"而不是"隐身"是本项目的**自研取舍**，且与主要参考项目相反：
 * openpets 明确选择"全屏时保持在内容之上"。两者的共同点是都不打扰用户，
 * 差别在于静默多保留了"宠物还在"这一信息。我们的规格已经选定了静默
 * （施工令 §9.2「QUNS {1,2,3,4} 即静默」＋ CONTEXT.md 的三态定义），
 * 因此这里不构成需要外部拍板的分歧。
 */

export interface ModeGateState {
  /** 用户手动指定的形态；`null` = 交给系统状态自动决定。 */
  readonly manual: VisibilityMode | null
  /** 自动判定出来的形态（不受 manual 影响）。 */
  readonly auto: VisibilityMode
}

export interface ModeGateInput {
  readonly userNotificationState: UserNotificationState
  readonly manual: VisibilityMode | null
  /** 上一次轮询的结果，用于防抖计数。 */
  readonly previous: ModeGateState
  readonly silenceHits: number
  readonly activeHits: number
}

export interface ModeGateResult {
  readonly mode: VisibilityMode
  readonly state: ModeGateState
  readonly silenceHits: number
  readonly activeHits: number
}

export function createModeGateState(): ModeGateState {
  return { manual: null, auto: 'active' }
}

/** 当前实际生效的形态：用户手动值优先。 */
export function effectiveMode(state: ModeGateState): VisibilityMode {
  return state.manual ?? state.auto
}

/**
 * 推进一次闸门。
 *
 * 防抖的意义：全屏切换的瞬间 QUNS 可能在 2 与 5 之间跳几次
 * （例如全屏视频缓冲、任务切换），宠物若跟着抖会非常扎眼。
 * 因此要求**连续 `QUNS_DEBOUNCE_COUNT` 次**一致才真的切换形态。
 *
 * 每次调用**最多**消耗一个计数，两个方向各自计数、互相清零。
 */
export function reduceModeGate(input: ModeGateInput): ModeGateResult {
  const { userNotificationState, manual, previous, silenceHits, activeHits } = input
  const wantsSilence = shouldSilence(userNotificationState)

  if (wantsSilence) {
    const hits = silenceHits + 1
    if (previous.auto !== 'silent' && hits >= QUNS_DEBOUNCE_COUNT) {
      const state: ModeGateState = { manual, auto: 'silent' }
      return { mode: effectiveMode(state), state, silenceHits: 0, activeHits: 0 }
    }
    const state: ModeGateState = { manual, auto: previous.auto }
    return { mode: effectiveMode(state), state, silenceHits: hits, activeHits: 0 }
  }

  const hits = activeHits + 1
  if (previous.auto !== 'active' && hits >= QUNS_DEBOUNCE_COUNT) {
    const state: ModeGateState = { manual, auto: 'active' }
    return { mode: effectiveMode(state), state, silenceHits: 0, activeHits: 0 }
  }
  const state: ModeGateState = { manual, auto: previous.auto }
  return { mode: effectiveMode(state), state, silenceHits: 0, activeHits: hits }
}

/**
 * 静默/隐身状态下，宠物还应该接收鼠标事件吗？
 *
 * 隐身时窗口根本不可见，没有可点的东西 → 必须穿透（否则会留下一个
 * "看不见但挡住下层"的幽灵窗口，这正是最招人烦的一类桌宠 bug）。
 * 静默时宠物仍然可见（小点），所以仍然可点——用户点它应该能得到回应
 * （施工令 §1.2⑧ 无条件回应：只要用户伸手，宠物必须接住）。
 */
export function shouldAcceptCursor(mode: VisibilityMode): boolean {
  return mode !== 'hidden'
}
