import type { Emotion } from '@shared/types'

/**
 * 情绪 → 眼睛的表情。
 *
 * ── 为什么把"表情"抽成纯函数 ──
 *
 * 眼睛是这只宠物**唯一真正会说话的部位**（它是几何角色，没有嘴部动画、
 * 没有贴图、不能换素材）。所以"什么情绪配什么眼睛"是一条真正需要被
 * 审视与固定的映射，而不是散在绘制代码里的 if。
 *
 * 抽出来之后就能回答两个原本很难回答的问题：
 * ① **8 种情绪是不是真的长得不一样？** —— 可断言（见测试）。
 * ② **有没有哪两种情绪被画成了同一个表情？** —— 那等于这个情绪不存在。
 *    施工令 §4.6 只允许 8 种情绪，那么 8 种都该看得出来。
 *
 * ── 为什么只有眼睛 ──
 *
 * 刻意不为每种情绪单独定制身体形变：身体动效（呼吸/弹跳/次级动作）
 * 已经在管"活着的感"，再叠一层会互相打架。表情集中在眼睛上，
 * 是"用最少的变化传达最多信息"的做法。
 */

/** 眼睛的画法。`open`/`smile` 二选一，其余是修饰。 */
export type EyeExpression =
  /** 正常睁开（默认） */
  | 'normal'
  /** 上凸弧线 —— 笑眼。压扁只是"变小"，弧线才是"笑" */
  | 'smile'
  /** 半闭 —— 困、无聊 */
  | 'halfClosed'
  /** 眯起（横向压窄）—— 专注 */
  | 'narrowed'

export interface EmotionFace {
  readonly eyes: EyeExpression
  /**
   * 眼睛竖向开合的额外系数（1 = 不受影响）。
   * 用于"困"这种整体下垂的感觉，即使没到眨眼也应该显得没精神。
   */
  readonly openScale: number
  /**
   * 是否画腮红。委屈时更明显（泛红），专注时收掉（不打扰）。
   */
  readonly blushScale: number
  /**
   * 整体轻微的垂直偏移（设计空间像素）。
   * 负数 = 头部略微抬高（警觉/惊讶），正数 = 略微垂下（困/委屈）。
   */
  readonly headTiltY: number
}

const FACES: Record<Emotion, EmotionFace> = {
  // 开心：笑眼 + 腮红明显
  happy: { eyes: 'smile', openScale: 1, blushScale: 1.15, headTiltY: -1 },

  // 平静：正常，什么都不强调
  calm: { eyes: 'normal', openScale: 1, blushScale: 0.9, headTiltY: 0 },

  // 困：半闭 + 略垂 + 腮红收淡
  sleepy: { eyes: 'halfClosed', openScale: 0.45, blushScale: 0.7, headTiltY: 2 },

  // 专注陪伴：眯一点、腮红收掉——"我在认真陪你，不打扰"
  focused: { eyes: 'narrowed', openScale: 0.8, blushScale: 0.55, headTiltY: 0 },

  // 委屈：眼睛偏大（水汪汪）+ 腮红最重 + 头略垂
  aggrieved: { eyes: 'normal', openScale: 1.12, blushScale: 1.35, headTiltY: 2 },

  // 惊讶：眼睛明显放大 + 头抬高
  surprised: { eyes: 'normal', openScale: 1.25, blushScale: 0.8, headTiltY: -2 },

  // 亲近：笑眼但比 happy 收敛（不是兴奋，是靠着）
  close: { eyes: 'smile', openScale: 0.95, blushScale: 1.25, headTiltY: 1 },

  // 无聊：半闭 + 头垂
  bored: { eyes: 'halfClosed', openScale: 0.6, blushScale: 0.6, headTiltY: 2 },
}

/** 取某个情绪的面部参数。 */
export function faceFor(emotion: Emotion): EmotionFace {
  return FACES[emotion]
}

/** 8 种情绪的两两表情是否**真的不同**（用于测试与自查）。 */
export function expressionSignature(emotion: Emotion): string {
  const f = FACES[emotion]
  return `${f.eyes}|${f.openScale.toFixed(2)}|${f.blushScale.toFixed(2)}|${String(f.headTiltY)}`
}
