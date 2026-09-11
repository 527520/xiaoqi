import type { Emotion, WorkMode } from '@shared/types'

/**
 * 生理状态 —— 随时间**缓慢**变化的内部量（CONTEXT.md）。
 *
 * ── ★ 一个刻意的设计禁令，必须写在这里 ★ ──
 *
 * 这四个量描述**宠物自己**，**绝不描述用户**。
 * 尤其不要演化成以下任何东西：
 *   - "用户连续工作 3 小时 → 宠物生气/失望"
 *   - "用户摸鱼 40 分钟 → 宠物变瘦/饿死"
 *   - 任何形式的"用户表现评分"
 *
 * 施工令 §1.2⑦ 的原文是「永不统计用户摸鱼时长、永不生成效率报告。
 * 宠物不衡量用户」。生理状态是**宠物的**身体感受，它的作用是让宠物
 * 显得有内在状态，而不是给用户打分。
 *
 * 反馈方向也是**反的**：用户加班时宠物表现得更累、更安静（而不是更活跃地"提醒"）。
 * 它是陪着一起累，不是催。
 */
export interface Physiology {
  /** 精力 ∈ [0,1]。用户工作时段缓慢下降，休息时段回升。 */
  readonly energy: number
  /** 饥饿 ∈ [0,1]。随时间缓慢上升，用户喂食时清零。 */
  readonly hunger: number
  /** 无聊 ∈ [0,1]。长时间没有互动时上升。 */
  readonly boredom: number
  /** 社交欲 ∈ [0,1]。长时间没有互动时上升；被互动时下降。 */
  readonly social: number
}

/** 初始状态：精力充沛、不饿、不无聊、社交欲不高。 */
export const INITIAL_PHYSIOLOGY: Physiology = {
  energy: 0.85,
  hunger: 0.2,
  boredom: 0.15,
  social: 0.2,
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 把"每小时变化百分之几"折算成"每毫秒变化多少"。
 *
 * ⚠️ 单位是**百分点**不是比例，这里写错会静默地毁掉整条曲线：
 *    初版直接把 `-8` 当比例除以 3_600_000，于是 1 小时掉 800%、
 *    立刻被夹到 0，下一拍又被人为 +22% 弹回 1 —— 精力在 0 与 1 之间跳，
 *    看起来"有变化"，其实完全没有生理意义。
 *    是单测里"加班时精力应该掉得更快"那条把它抓出来的。
 */
function perMs(percentPerHour: number): number {
  return percentPerHour / 100 / 3_600_000
}

/**
 * 推进生理状态。
 *
 * @param previous 上一拍的状态
 * @param elapsedMs 距上一拍过了多少毫秒（闭包传入，因此可用假时钟单测）
 * @param mode 当前工作模式 —— 决定"宠物陪着你一起累"还是"一起歇着"
 * @param hadInteraction 这一拍内是否有过互动
 */
export function stepPhysiology(
  previous: Physiology,
  elapsedMs: number,
  mode: WorkMode,
  hadInteraction: boolean,
): Physiology {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return previous

  // 用户在"干活"还是"歇着"——宠物跟着一起。
  // 注意这里用的是**工作模式**（用户的处境），不是"用户表现如何"。
  //
  // ⚠️ `overtime` 也算在干活里。初版漏了它，于是加班时精力反而**回升**——
  //    因为不匹配 workingMode、又不等于 rest，掉进了最后那个"闲着"分支。
  //    单测里"加班时精力应该掉得更快"那条把它抓出来了。
  const workingMode =
    mode === 'coding' ||
    mode === 'meeting' ||
    mode === 'email' ||
    mode === 'focus' ||
    mode === 'overtime'
  const overtime = mode === 'overtime'

  // 精力：干活时降，休息时升；加班时降得更快（陪着一起累）
  const energyRate = workingMode
    ? perMs(overtime ? -14 : -8)
    : mode === 'rest'
      ? perMs(22)
      : perMs(6)

  // 饥饿：稳定上升，加班时略快（"它也想吃点东西"）
  const hungerRate = perMs(overtime ? 8 : 5)

  // 无聊与社交欲：休息时几乎不长（它在打盹），干活时缓慢长
  const boredomRate = mode === 'rest' ? perMs(1) : perMs(6)
  const socialRate = mode === 'rest' ? perMs(0.5) : perMs(4)
  const dt = elapsedMs

  return {
    energy: clamp01(previous.energy + energyRate * dt),
    hunger: clamp01(previous.hunger + hungerRate * dt),
    boredom: clamp01(previous.boredom + boredomRate * dt),
    // 有过互动就明显回落（社交欲"被满足了"）
    social: clamp01(previous.social + socialRate * dt - (hadInteraction ? 0.3 : 0)),
  }
}

/**
 * 由生理状态 + 工作模式决定**基础情绪**。
 *
 * ── 优先级是刻意的 ──
 *
 * 从上到下：越"当下、越具体"的处境越优先。
 * 例如用户正在开会时，宠物即使很累也不该表现成"困"——会议态需要安静专注，
 * 表现成困倦反而更分散注意力。
 *
 * ⚠️ v0.1 就这 8 个情绪（施工令 §4.6「不要增加」）：
 *    开心、平静、困、专注陪伴、委屈、惊讶、亲近、无聊。
 */
export function baseEmotion(physiology: Physiology, mode: WorkMode): Emotion {
  const { energy, hunger, boredom, social } = physiology

  // 会议：安静、专注地陪着，不打扰。这一条优先于一切生理感受。
  if (mode === 'meeting') return 'focused'

  // 精力见底 → 困
  if (energy <= 0.2) return 'sleepy'

  // 饿得厉害 → 委屈（撒娇式的委屈，不是指责）
  if (hunger >= 0.85) return 'aggrieved'

  // 社交欲很高 → 亲近（想被注意）
  if (social >= 0.75) return 'close'

  // 无聊 → 无聊
  if (boredom >= 0.7) return 'bored'

  // 用户在专注/编码，宠物精力尚可 → 专注陪伴
  if ((mode === 'coding' || mode === 'focus') && energy > 0.45) return 'focused'

  // 用户在休息且宠物精力足 → 开心
  if (mode === 'rest' && energy > 0.6) return 'happy'

  // 精力中等偏高 → 开心；否则平静
  if (energy > 0.65 && boredom < 0.4) return 'happy'
  return 'calm'
}

/**
 * 情绪**变化的最小间隔**（毫秒）。
 *
 * 情绪是"由事件瞬时触发"的快变量（CONTEXT.md），但这不意味着它该每拍都变。
 * 频繁切换会让宠物显得神经质，而且会让形态切换闪烁。
 * 3 秒是一个"看得出反应、但不抖"的量级。
 */
export const EMOTION_MIN_INTERVAL_MS = 3000

/** 情绪快照：当前情绪 + 它是什么时候定的（用于限频与调试面板）。 */
export interface EmotionState {
  readonly emotion: Emotion
  readonly since: number
}

/**
 * 推进情绪：限频地重新求基础情绪。
 *
 * @param now 当前时间戳（毫秒）。**作为参数传入**，便于用假时钟单测。
 */
export function stepEmotion(
  previous: EmotionState,
  physiology: Physiology,
  mode: WorkMode,
  now: number,
): EmotionState {
  const next = baseEmotion(physiology, mode)
  if (next === previous.emotion) return previous
  if (now - previous.since < EMOTION_MIN_INTERVAL_MS) return previous
  return { emotion: next, since: now }
}

/** 用户的即时互动如何影响情绪（"被拍了一下"这类瞬时反应）。 */
export const INTERACTION_EMOTION: Emotion = 'surprised'

/** 互动的瞬时情绪持续多久（毫秒）。 */
export const INTERACTION_EMOTION_MS = 900
