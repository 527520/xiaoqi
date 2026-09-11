import { FRAME_RATE } from '@shared/constants'
import type { VisibilityMode } from '@shared/types'

/**
 * 待机降帧 —— 施工令 §4.3⑩「待机时必须降帧（≤10fps）或暂停渲染循环；
 * 无交互、无动画时不刷新。**不要常驻 60fps。**」
 * §9.6 补了一句为什么：「耗电是隐形差评源。」
 *
 * 纯函数，可单测。真正的 `app.ticker.maxFPS = ...` 在渲染进程。
 */

export interface FrameBudgetInput {
  readonly mode: VisibilityMode
  /** 是否有交互动画正在播放。 */
  readonly isAnimating: boolean
  /** 窗口是否可见。不可见时必须完全停更。 */
  readonly isWindowVisible: boolean
}

/**
 * 目标帧率。
 *
 * 注意 `isWindowVisible === false` 时返回 **0**，语义是"停更"（暂停渲染循环），
 * 而不是"以 0fps 渲染"。
 *
 * ⚠️ 落地时有个反直觉的坑：Pixi 的 `ticker.maxFPS = 0` 意思是**不限帧**，
 * 不是暂停（见 `pixi.js/lib/ticker/Ticker.js` 的 setter：0 走
 * `_minElapsedMS = 0`，即不节流）。所以本返回值的 0 必须由渲染进程翻译成
 * "设成极低帧率（1fps）"，**绝不能直接写进 `maxFPS`**——
 * 那会让隐藏/隐身状态变成满帧空转，正好与省电目标相反。
 *
 * 调研佐证：BongoCat 的 Steam 讨论区有「serious optimisation issues」
 * 与「make my PC die」两条主题帖，以及中文社区的"低配流畅运行指南"，
 * 都指向"默认 60fps + 高频 ticker"这一组合的口碑风险。
 */
export function targetFrameRate(input: FrameBudgetInput): number {
  if (!input.isWindowVisible) return 0
  if (input.mode === 'hidden') return 0
  if (input.isAnimating) return FRAME_RATE.active
  if (input.mode === 'silent') return FRAME_RATE.silent
  return FRAME_RATE.idle
}

/** 帧率为 0 是否意味着"应该完全停掉渲染循环"。 */
export function shouldPauseTicker(input: FrameBudgetInput): boolean {
  return targetFrameRate(input) === 0
}

/**
 * 两次帧预算之间是否需要真的动 ticker。
 *
 * 避免每 80ms 的光标轮询都去写一次 `maxFPS`——
 * 重复写入虽然不致命，但会让"其实什么都没变"这件事在 profiling 里看不出来。
 */
export function frameBudgetChanged(previous: FrameBudgetInput, next: FrameBudgetInput): boolean {
  return targetFrameRate(previous) !== targetFrameRate(next)
}
