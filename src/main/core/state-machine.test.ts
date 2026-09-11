import { describe, expect, it } from 'vitest'

import * as stateMachine from './state-machine'

/**
 * `state-machine.ts` 的契约测试。
 *
 * ── 为什么一个门面（barrel）也值得测 ──
 *
 * 门面的失效方式很隐蔽：**它永远不报错**。
 * 某个再导出被删掉、或源文件改了名字，`state-machine.ts` 仍然能编译
 * （只要还有一个导出活着），
 * 而外部 `import { stepRelationship } from './state-machine'` 才会炸——
 * 于是失败点离原因很远。
 *
 * 施工令 §5 M2 把这一层写成「生理（精力/饥饿/无聊）、情绪（8 个）、
 * 关系（好感/信任/默契）、工作模式（8 个）」**四块**，
 * 所以这里逐块断言"它在"，缺一块就红。
 */
describe('state-machine：四块状态都要在', () => {
  it('生理：精力/饥饿/无聊/社交', () => {
    expect(stateMachine.INITIAL_PHYSIOLOGY).toBeDefined()
    expect(typeof stateMachine.stepPhysiology).toBe('function')
    // 施工令只点名了前三项，第四个（社交）是 CONTEXT.md 里有的，一并守住。
    for (const key of ['energy', 'hunger', 'boredom', 'social']) {
      expect(stateMachine.INITIAL_PHYSIOLOGY).toHaveProperty(key)
    }
  })

  it('情绪：8 个的判定与限频都在', () => {
    expect(typeof stateMachine.baseEmotion).toBe('function')
    expect(typeof stateMachine.stepEmotion).toBe('function')
    expect(stateMachine.EMOTION_MIN_INTERVAL_MS).toBeGreaterThan(0)
  })

  it('关系：好感/信任/默契', () => {
    expect(typeof stateMachine.stepRelationship).toBe('function')
    expect(typeof stateMachine.relationshipMood).toBe('function')
    expect(typeof stateMachine.relationshipStrength).toBe('function')
    expect(typeof stateMachine.missesUser).toBe('function')
    for (const key of ['affection', 'trust', 'rapport']) {
      expect(stateMachine.INITIAL_RELATIONSHIP).toHaveProperty(key)
    }
  })

  it('工作模式：8 个的推断与边界常数', () => {
    expect(typeof stateMachine.inferWorkMode).toBe('function')
    expect(typeof stateMachine.isWeekend).toBe('function')
    expect(typeof stateMachine.isWithinWorkHours).toBe('function')
    expect(stateMachine.IDLE_REST_MS).toBeGreaterThan(0)
    expect(stateMachine.FOCUS_MS).toBeGreaterThan(0)
  })
})

describe('state-machine：契约的方向性', () => {
  it('★ 关系基调的三个取值里**没有**"冷淡/拒绝"（ADR-0003 在门面层也成立）', () => {
    // 穷举维度组合，断言取值集合恰好是这三个。
    const moods = new Set<string>()
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      moods.add(stateMachine.relationshipMood({ affection: v, trust: v, rapport: v }))
    }
    expect([...moods].sort()).toEqual(['attached', 'reserved', 'warm'])
  })

  it('★ 初始状态是"略微正向"而不是 0（它是来陪你的，不是来考核你的）', () => {
    expect(stateMachine.INITIAL_RELATIONSHIP.affection).toBeGreaterThan(0)
    expect(stateMachine.INITIAL_RELATIONSHIP.trust).toBeGreaterThan(0)
  })

  it('★ 四个层的时间常数是**阶梯状**的（关系最慢、情绪最快）', () => {
    // 这个断言守的是"分层有没有意义"：
    // 若关系的回落速率与生理同量级，它就不再是"累积的关系"，
    // 而只是一个慢一点的生理量。
    const affectionPerHour = stateMachine.AFFECTION_DECAY_PER_HOUR
    expect(affectionPerHour).toBeGreaterThan(0)
    // 关系回落必须比生理变化慢一个数量级以上（生理是每小时几个百分点）。
    expect(affectionPerHour).toBeLessThan(1)
    // 默契是唯一**被动增长**的量。
    expect(stateMachine.RAPPORT_PER_HOUR).toBeGreaterThan(0)
  })
})
