/**
 * 动画曲线 —— 纯函数，可单测。
 *
 * 之所以从 `PetStage` 里抽出来：这些曲线**写错的后果不是报错，是"看起来不对"**。
 * 渲染代码里很难被察觉（本机 DevTools 一开透明窗就不透明了，没法边看边调），
 * 所以把数值逻辑抽成纯函数，用测试把"数学上不可能出现的结果"钉死。
 */

/** 眨眼持续时长（秒）。 */
export const BLINK_DURATION_SECONDS = 0.14

/**
 * 眼睛张开程度：`1` = 完全睁开，`0` = 完全闭上。
 *
 * @param remaining 剩余眨眼时长（秒）；`<= 0` 表示没在眨眼
 * @param duration 眨眼总时长（秒）
 *
 * ── 为什么需要这个函数（一个真实踩过的 bug） ──
 *
 * 最初的实现是"只要在眨眼，就把眼睛竖向压扁到某个值"，结果眼睛**几乎永远
 * 是闭着的**——因为眨眼计时在每一帧都会被重置或残留，`blink > 0` 覆盖了大部分
 * 渲染时刻。症状是宠物**没有眼睛**（一个空白圆脸），
 * 而控制台没有任何报错、canvas 也正常渲染、`canvasCount` 也是 1。
 *
 * 这个函数把"何时闭眼"变成一条**三角形曲线**：
 * 只在眨眼时长的中点闭合到 `0`，两端都是 `1`，
 * 因此绝大多数时间眼睛是睁开的，闭眼只是一个瞬间。
 */
export function eyeOpenness(remaining: number, duration: number): number {
  if (remaining <= 0 || duration <= 0) return 1

  // 归一化到 [0,1]，1 = 刚开始眨，0 = 眨完
  const progress = 1 - Math.min(remaining, duration) / duration

  // 三角形：0→1→0，在 progress=0.5 处取 0（完全闭合）
  const closed = 1 - Math.abs(progress * 2 - 1)

  // 保留一点缝隙（0.08），全闭会让眼睛"消失"而不是"闭上"
  return Math.max(0.08, 1 - closed)
}

/**
 * 呼吸动画的形变。
 *
 * @param elapsedSeconds 累计时间（秒）
 * @param periodSeconds 一个完整呼吸周期（秒）
 * @returns `breath` ∈ [-1, 1]，`squash` = 横向缩放增量，`stretch` = 纵向缩放增量
 *
 * 幅度刻意很小（3%）：再大就会显得"喘"而不是"呼吸"。
 */
export function breathPose(
  elapsedSeconds: number,
  periodSeconds = 2.6,
): { breath: number; squash: number; stretch: number; offsetY: number } {
  const breath = Math.sin(elapsedSeconds * ((Math.PI * 2) / periodSeconds))
  return {
    breath,
    squash: breath * 0.03,
    stretch: -breath * 0.03,
    offsetY: breath * 1.5,
  }
}

/**
 * 摇摆角度的微小抖动。
 *
 * 静止的宠物看起来像一张贴纸；一点点非同步的摇摆能让它"活着"。
 * 周期刻意与呼吸不同（4.1s vs 2.6s），避免两个动画同相位后看起来像机械循环。
 */
export function swayAngle(elapsedSeconds: number, amplitude = 0.012): number {
  return Math.sin(elapsedSeconds * ((Math.PI * 2) / 4.1)) * amplitude
}
