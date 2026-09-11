import { describe, expect, it } from 'vitest'

import type { Emotion } from '@shared/types'

import { expressionSignature, faceFor } from './emotionFace'

/** v0.1 的 8 种情绪（施工令 §4.6 明确「不要增加」）。 */
const EMOTIONS: Emotion[] = [
  'happy',
  'calm',
  'sleepy',
  'focused',
  'aggrieved',
  'surprised',
  'close',
  'bored',
]

describe('情绪 → 表情', () => {
  it('★ 八种情绪必须长得**不一样**——否则那个情绪等于不存在', () => {
    // 这是这个模块存在的核心理由。施工令 §4.6 只允许 8 种情绪，
    // 那么 8 种都该看得出来；有两种画成同一个表情，就是白占一个位置。
    const signatures = new Map<string, Emotion>()
    for (const emotion of EMOTIONS) {
      const sig = expressionSignature(emotion)
      const clash = signatures.get(sig)
      expect(clash, `${emotion} 与 ${String(clash)} 的表情完全相同`).toBeUndefined()
      signatures.set(sig, emotion)
    }
    expect(signatures.size).toBe(EMOTIONS.length)
  })

  it('每种情绪都有定义（不会有 undefined 漏进绘制代码）', () => {
    for (const emotion of EMOTIONS) {
      const face = faceFor(emotion)
      expect(face).toBeDefined()
      expect(typeof face.openScale).toBe('number')
      expect(Number.isFinite(face.openScale)).toBe(true)
    }
  })

  it('★ 眼睛开合系数落在合理区间（太小等于永远闭眼，太大像瞪人）', () => {
    // 参考：眨眼闭合到 0.1，完全睁开是 1.0。
    // 情绪带来的额外开合**不该**超出"半闭"到"瞪大"的范围，
    // 否则会出现"宠物没有眼睛"或"眼睛大得离谱"。
    for (const emotion of EMOTIONS) {
      const { openScale } = faceFor(emotion)
      expect(openScale, `${emotion} 的 openScale 过小`).toBeGreaterThanOrEqual(0.4)
      expect(openScale, `${emotion} 的 openScale 过大`).toBeLessThanOrEqual(1.3)
    }
  })

  it('腮红系数在 [0, 1.5]，不会变成大红脸或消失到看不见', () => {
    for (const emotion of EMOTIONS) {
      const { blushScale } = faceFor(emotion)
      expect(blushScale).toBeGreaterThan(0)
      expect(blushScale).toBeLessThanOrEqual(1.5)
    }
  })

  it('头部偏移很小（几像素级，不该看起来像在点头）', () => {
    for (const emotion of EMOTIONS) {
      expect(Math.abs(faceFor(emotion).headTiltY)).toBeLessThanOrEqual(3)
    }
  })

  it('★ 专注时腮红收掉——"我在认真陪你，不打扰"', () => {
    // 专注的语义是不打扰；一张满脸腮红的兴奋脸与它矛盾。
    expect(faceFor('focused').blushScale).toBeLessThan(faceFor('happy').blushScale)
  })

  it('★ 委屈的腮红比开心还重（泛红是委屈最直接的视觉信号）', () => {
    expect(faceFor('aggrieved').blushScale).toBeGreaterThan(faceFor('happy').blushScale)
  })

  it('★ 开心与亲近都用笑眼，但靠其它参数区分开', () => {
    // 这两个语义接近（都是正面），允许共用"笑眼"，
    // 但必须靠开合/腮红/头位区分，不能完全一样——上面那条唯一性测试已覆盖，
    // 这里额外把"它们确实都用笑眼"写下来，避免以后有人把其中一个改成别的表情
    // 却以为只是小改动。
    expect(faceFor('happy').eyes).toBe('smile')
    expect(faceFor('close').eyes).toBe('smile')
    expect(expressionSignature('happy')).not.toBe(expressionSignature('close'))
  })

  it('惊讶的头位向上、困与无聊的头位向下（方向不能反）', () => {
    expect(faceFor('surprised').headTiltY).toBeLessThan(0)
    expect(faceFor('sleepy').headTiltY).toBeGreaterThan(0)
    expect(faceFor('bored').headTiltY).toBeGreaterThan(0)
  })
})
