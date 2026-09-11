/**
 * 动画曲线 —— 纯函数，可单测。
 *
 * 之所以从 `PetStage` 里抽出来：这些曲线**写错的后果不是报错，是"看起来不对"**。
 * 渲染代码里很难被察觉（本机 DevTools 一开透明窗就不透明，没法边看边调），
 * 所以把数值逻辑抽成纯函数，用测试把"数学上不可能出现的结果"钉死。
 */

/** 眨眼持续时长（秒）。 */
export const BLINK_DURATION_SECONDS = 0.13

/** 呼吸周期（秒）。 */
export const BREATH_PERIOD_SECONDS = 3.1

/** 交互动画时长（秒）。 */
export const REACTION_DURATION_SECONDS = 0.95

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
 * 渲染时刻。症状是宠物**没有眼睛**（一张空白圆脸），而控制台没有任何报错。
 *
 * 这个函数把"何时闭眼"变成一条**三角形曲线**：只在眨眼时长的中点闭合到 0，
 * 两端都是 1，因此绝大多数时间眼睛是睁开的，闭眼只是一个瞬间。
 */
export function eyeOpenness(remaining: number, duration: number): number {
  if (remaining <= 0 || duration <= 0) return 1

  // 归一化到 [0,1]，1 = 刚开始眨，0 = 眨完
  const progress = 1 - Math.min(remaining, duration) / duration

  // 三角形：0→1→0，在 progress=0.5 处取 0（完全闭合）
  const closed = 1 - Math.abs(progress * 2 - 1)

  // 保留一点缝隙（0.1），全闭会让眼睛"消失"而不是"闭上"
  return Math.max(0.1, 1 - closed)
}

export interface BreathPose {
  /** 原始正弦值 ∈ [-1, 1]。 */
  readonly breath: number
  /** 横向缩放增量（squash）。 */
  readonly squash: number
  /** 纵向缩放增量（stretch）。 */
  readonly stretch: number
  /** 垂直位移（像素，设计空间）。 */
  readonly offsetY: number
}

/**
 * 呼吸姿态。
 *
 * 用**体积守恒**的 squash & stretch（横向涨则纵向缩，反之亦然）而不是
 * 单纯的上下浮动：前者读起来像"在呼吸"，后者读起来像"在飘"。
 * 幅度刻意很小（3.5%）——再大就变成"喘"。
 */
export function breathPose(elapsedSeconds: number, periodSeconds = BREATH_PERIOD_SECONDS): BreathPose {
  const breath = Math.sin(elapsedSeconds * ((Math.PI * 2) / periodSeconds))
  return {
    breath,
    squash: breath * 0.035,
    stretch: -breath * 0.035,
    offsetY: breath * 1.6,
  }
}

/**
 * 摇摆角度的微小抖动。
 *
 * 静止的宠物看起来像一张贴纸；一点点非同步的摇摆能让它"活着"。
 * 周期刻意与呼吸不同（4.7s vs 3.1s），避免两个动画同相位后看起来像机械循环。
 */
export function swayAngle(elapsedSeconds: number, amplitude = 0.013): number {
  return Math.sin(elapsedSeconds * ((Math.PI * 2) / 4.7)) * amplitude
}

/**
 * 耳朵摆动的次级动作：**相位滞后于身体**。
 *
 * 这是"动画有质感"的关键细节，也是初版完全没做的一环：
 * 耳朵若与身体同相位摆动，读起来像整块图在转；
 * 滞后一点、幅度大一点，才会被看成"身体动带动了耳朵"。
 */
export function earSecondarySway(elapsedSeconds: number, amplitude = 0.05): number {
  const lagged = elapsedSeconds - 0.18
  return Math.sin(lagged * ((Math.PI * 2) / 4.7)) * amplitude
}

/** 尾巴摆动的次级动作：比耳朵更快、幅度更大，形成独立的"甩尾"。 */
export function tailSway(elapsedSeconds: number): number {
  return Math.sin((elapsedSeconds - 0.1) * ((Math.PI * 2) / 2.3)) * 0.12
}

/**
 * 被点一下的弹跳曲线。
 *
 * `progress` ∈ [0, 1]。返回 [0, 1] 的钟形包络：
 * **起手快、回落稍慢**，模拟"被按下去又弹回来"。
 *
 * ⚠️ 不要用 `sin(πp)` 或它的幂：`sin(πp)^k` 关于 p=0.5 是**对称**的，
 *    看起来像"匀速涨起来又匀速落回去"，没有重量感。
 *    要非对称必须显式分段——这里用两个不同的指数：
 *    上升段（p<0.5）指数小 → 涨得快；下降段指数大 → 落得慢。
 */
export function bounceEnvelope(progress: number): number {
  if (progress <= 0 || progress >= 1) return 0
  // 归一化到 [0,1] 的"距离峰值"再折回包络高度。
  // 上升段用 0.7 次幂（快起），下降段用 1.8 次幂（慢落）。
  return progress < 0.5
    ? Math.pow(progress * 2, 0.7)
    : Math.pow((1 - progress) * 2, 1.8)
}

/**
 * 眼睛看向某个方向的偏移量（用于视线跟随）。
 *
 * @param targetX/targetY 目标点（设计空间坐标）
 * @param eyeX/eyeY 眼心（设计空间坐标）
 * @param maxOffset 瞳孔最多能偏移多少像素
 * @param reach 多远的距离算"看满"（超过就按满偏移处理）
 *
 * 归一化到单位圆内再乘 `maxOffset`，因此瞳孔永远不会跑出眼白——
 * 这是"眼睛跟着你"能成立的前提（跑出去就变成恐怖片了）。
 */
export function gazeOffset(
  targetX: number,
  targetY: number,
  eyeX: number,
  eyeY: number,
  maxOffset: number,
  reach: number,
): { x: number; y: number } {
  const dx = targetX - eyeX
  const dy = targetY - eyeY
  const distance = Math.hypot(dx, dy)
  if (distance < 0.001 || reach <= 0) return { x: 0, y: 0 }

  // 距离越近，偏移越小（贴到眼前时不该把瞳孔顶到边上）
  const magnitude = Math.min(distance / reach, 1)
  return {
    x: (dx / distance) * magnitude * maxOffset,
    y: (dy / distance) * magnitude * maxOffset,
  }
}
