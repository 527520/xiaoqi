import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { WorkMode } from '@shared/types'

import {
  AFFECTION_DECAY_PER_HOUR,
  ATTACHED_THRESHOLD,
  INITIAL_RELATIONSHIP,
  INTERACTION_AFFECTION_GAIN,
  INTERACTION_TRUST_GAIN,
  RAPPORT_PER_HOUR,
  TRUST_DECAY_PER_HOUR,
  WARM_THRESHOLD,
  missesUser,
  relationshipMood,
  relationshipStrength,
  stepRelationship,
  type Relationship,
  type RelationshipEvents,
} from './relationship'

/**
 * 关系层的测试。
 *
 * ⚠️ 这些测试里**最重要的不是数值**，而是那几条"方向性"断言：
 * 关系不该惩罚用户、不该改变是否回应、不该把"没互动"记成过错。
 * 数值将来可以调，方向不能。
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

const ALL_MODES: WorkMode[] = [
  'coding',
  'meeting',
  'email',
  'focus',
  'rest',
  'overtime',
  'offWork',
  'weekend',
]

const NO_EVENTS: RelationshipEvents = { positiveInteraction: false }
const TOUCHED: RelationshipEvents = { positiveInteraction: true }

/** 连跑若干小时，每小时一次互动（模拟"经常陪它"）。 */
function interactForHours(
  start: Relationship,
  hours: number,
  stepMs = HOUR,
  events: RelationshipEvents = TOUCHED,
): Relationship {
  let state = start
  let elapsed = 0
  while (elapsed < hours * HOUR) {
    state = stepRelationship(state, stepMs, 'coding', events)
    elapsed += stepMs
  }
  return state
}

describe('初始状态', () => {
  it('★ 从**略微正向**开始，不是 0（它是来陪你的，不是来考核你的）', () => {
    expect(INITIAL_RELATIONSHIP.affection).toBeGreaterThan(0)
    expect(INITIAL_RELATIONSHIP.trust).toBeGreaterThan(0)
    // 默契可以从很低开始——那个确实要靠相处攒。
    expect(INITIAL_RELATIONSHIP.rapport).toBeGreaterThanOrEqual(0)
  })

  it('所有维度都在 [0,1] 内', () => {
    for (const value of Object.values(INITIAL_RELATIONSHIP)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

describe('★ ADR-0003 方向性约束（这几条比数值重要）', () => {
  it('★ 回落必须**远慢于**增长——否则这个系统就是在惩罚用户', () => {
    // 陪它 1 小时攒到的好感，应该远大于放着 1 小时掉掉的好感。
    const gainPerHour = INTERACTION_AFFECTION_GAIN * 1 // 哪怕只互动一次
    const decayPerHour = AFFECTION_DECAY_PER_HOUR / 100
    expect(gainPerHour).toBeGreaterThan(decayPerHour * 5)

    // 信任同理：攒得慢，但更不能掉得快。
    expect(INTERACTION_TRUST_GAIN).toBeGreaterThan((TRUST_DECAY_PER_HOUR / 100) * 5)
  })

  it('★ 陪它几天攒的关系，放几个月才会淡掉', () => {
    // 基准：把好感**直接**设成满值，然后完全不管 —— 这是关系曲线上最坏的情况。
    const full: Relationship = { affection: 1, trust: 1, rapport: 1 }
    const afterMonth = stepRelationship(full, 30 * DAY, 'coding', NO_EVENTS)
    const afterTwoWeeks = stepRelationship(full, 14 * DAY, 'coding', NO_EVENTS)

    // 两周不打开应用：掉不到两成（这才叫"温柔"）。
    expect(afterTwoWeeks.affection).toBeGreaterThan(0.8)
    // 整整一个月不管：掉掉的不到四成 —— 一段关系不该因为一个月没见就消失。
    expect(afterMonth.affection).toBeGreaterThan(0.6)

    // 而"想念"（好感 < 0.2）要放到几个月之后才会出现。
    const afterQuarter = stepRelationship(full, 90 * DAY, 'coding', NO_EVENTS)
    expect(afterQuarter.affection).toBeLessThan(0.2)
  })

  it('★ 每天随便摸一两下就足以维持住关系（不需要打卡式地陪它）', () => {
    // 每天 2 次互动，持续 30 天，看关系是否稳得住。
    let state = INITIAL_RELATIONSHIP
    for (let day = 0; day < 30; day++) {
      // 上午一次
      state = stepRelationship(state, 12 * HOUR, 'coding', TOUCHED)
      // 下午一次
      state = stepRelationship(state, 12 * HOUR, 'coding', TOUCHED)
    }
    // 不但没掉，还涨到了 warm 以上。
    expect(state.affection).toBeGreaterThan(INITIAL_RELATIONSHIP.affection)
    expect(relationshipStrength(state)).toBeGreaterThan(WARM_THRESHOLD)
  })

  it('★ 关系再低也不产生"拒绝"——mood 的取值里只有更亲近，没有更冷淡', () => {
    // 把所有维度压到最低，mood 仍然是一个"愿意陪着你"的基调。
    const cold: Relationship = { affection: 0, trust: 0, rapport: 0 }
    expect(relationshipMood(cold)).toBe('reserved')

    // 穷举：三个取值必须是这三个，没有任何"冷淡/拒绝"的档位。
    const moods = new Set<string>()
    for (const affection of [0, 0.3, 0.5, 0.8, 1]) {
      for (const trust of [0, 0.3, 0.5, 0.8, 1]) {
        for (const rapport of [0, 0.3, 0.5, 0.8, 1]) {
          moods.add(relationshipMood({ affection, trust, rapport }))
        }
      }
    }
    expect([...moods].sort()).toEqual(['attached', 'reserved', 'warm'])
  })

  it('★ "没互动"只带来时间流逝，不带来任何处罚', () => {
    // 同样时长、同样模式：有互动 vs 没互动，差别**只有**增长那一项。
    const idle = stepRelationship(INITIAL_RELATIONSHIP, 8 * HOUR, 'meeting', NO_EVENTS)
    const touched = stepRelationship(INITIAL_RELATIONSHIP, 8 * HOUR, 'meeting', TOUCHED)

    // 互动只会让它更好，不会因为"之前没理它"而更差。
    expect(touched.affection).toBeGreaterThan(idle.affection)
    expect(touched.trust).toBeGreaterThan(idle.trust)
    expect(touched.rapport).toBe(idle.rapport)
  })

  it('★ 工作模式不影响好感/信任的方向（"你去开会了所以好感掉了"是被禁止的归因）', () => {
    let reference: number | null = null
    for (const mode of ALL_MODES) {
      const state = stepRelationship(INITIAL_RELATIONSHIP, 6 * HOUR, mode, NO_EVENTS)
      reference ??= state.affection
      // 所有模式下好感的变化必须完全一致——模式不参与好坏的判定。
      expect(state.affection).toBeCloseTo(reference, 12)
      expect(state.trust).toBeCloseTo(
        stepRelationship(INITIAL_RELATIONSHIP, 6 * HOUR, ALL_MODES[0]!, NO_EVENTS).trust,
        12,
      )
    }
  })

  it('★ 取消呼吸提醒**不做任何减法**（M4a 的规则，这里先把守卫立住）', () => {
    const withCancel = stepRelationship(INITIAL_RELATIONSHIP, 2 * HOUR, 'coding', {
      positiveInteraction: false,
      cancelledReminder: true,
    })
    const withoutCancel = stepRelationship(INITIAL_RELATIONSHIP, 2 * HOUR, 'coding', NO_EVENTS)

    // 取消提醒不该让它掉更多——真·无输入不推断为冷落（ADR-0003）。
    expect(withCancel.affection).toBe(withoutCancel.affection)
    expect(withCancel.trust).toBe(withoutCancel.trust)
  })

  it('★ 用词纪律：源码里不出现"记仇"（注释里的警示语除外）', () => {
    // 施工令 §5 M4a：「代码与文案中不要出现"记仇"，正确用词是"被冷落"。
    // 用词会塑造实现者的直觉。」这条用一个断言来守。
    //
    // ⚠️ 必须先剥掉注释再扫。文件头那段注释**故意**写了这个词，
    //    因为"不要用某个词"这类纪律必须指名道姓才有约束力。
    //    不剥注释的话，这条守卫会被它自己的警示语触发——
    //    而"守卫被自己的说明文字绊倒"正是本项目踩过的坑
    //    （版权扫描测试曾匹配到它自己的注释）。
    // 用**顶层 import** 的 readFileSync/join，不用动态 import。
    //    动态 import 解构出来的 `join` 是一个裸方法名，lint 的
    //    unbound-method 会认为"它可能与对象分离、`this` 会跑偏"
    //    （虽然 node:path 的 join 不依赖 this）。
    //    顶层 import 没有这个问题，也更直白。
    const source = readFileSync(join(process.cwd(), 'src/main/core/relationship.ts'), 'utf8')

    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/\/\/.*$/gm, '') // 行注释
      .replace(/`[^`]*`/g, '``') // 模板串（可能含文案）

    expect(withoutComments).not.toContain('记仇')

    // ★ 反向验证：确认"剥注释"这一步真的有效，否则上面那条断言可能
    //   只是因为整个文件被剥空了才通过（假阳性）。
    expect(source).toContain('记仇') // 警示语确实在注释里
    expect(withoutComments.length).toBeGreaterThan(200) // 没被剥空
  })
})

describe('stepRelationship · 增长', () => {
  it('持续互动会让三个维度都上升', () => {
    const after = interactForHours(INITIAL_RELATIONSHIP, 4)
    expect(after.affection).toBeGreaterThan(INITIAL_RELATIONSHIP.affection)
    expect(after.trust).toBeGreaterThan(INITIAL_RELATIONSHIP.trust)
    expect(after.rapport).toBeGreaterThan(INITIAL_RELATIONSHIP.rapport)
  })

  it('不会超过 1（长时间狂点也不会溢出）', () => {
    const after = interactForHours(INITIAL_RELATIONSHIP, 5000, 1000)
    for (const value of Object.values(after)) {
      expect(value).toBeLessThanOrEqual(1)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('不会低于 0（无限期放着不管也不会变负数）', () => {
    const after = stepRelationship(INITIAL_RELATIONSHIP, 100_000 * DAY, 'rest', NO_EVENTS)
    for (const value of Object.values(after)) {
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('★ 信任涨得比好感慢（否则"信任"就只是"好感"的同义词）', () => {
    const after = interactForHours(INITIAL_RELATIONSHIP, 1, HOUR, TOUCHED)
    const affectionGain = after.affection - INITIAL_RELATIONSHIP.affection
    const trustGain = after.trust - INITIAL_RELATIONSHIP.trust
    expect(trustGain).toBeLessThan(affectionGain)
  })

  it('★ 默契随"待在一起"自然上升，不需要互动（它的语义是时间沉淀，不是挣来的）', () => {
    const idle = stepRelationship(INITIAL_RELATIONSHIP, 10 * HOUR, 'rest', NO_EVENTS)
    expect(idle.rapport).toBeGreaterThan(INITIAL_RELATIONSHIP.rapport)
  })

  it('一起干活时默契涨得更快（并肩做事比各自闲着更容易形成默契）', () => {
    const working = stepRelationship(INITIAL_RELATIONSHIP, 10 * HOUR, 'coding', NO_EVENTS)
    const resting = stepRelationship(INITIAL_RELATIONSHIP, 10 * HOUR, 'rest', NO_EVENTS)
    expect(working.rapport).toBeGreaterThan(resting.rapport)
  })

  it('elapsedMs 为 0 或负数时状态不变（不倒退、不 NaN）', () => {
    expect(stepRelationship(INITIAL_RELATIONSHIP, 0, 'coding', TOUCHED)).toBe(INITIAL_RELATIONSHIP)
    expect(stepRelationship(INITIAL_RELATIONSHIP, -1000, 'coding', TOUCHED)).toBe(
      INITIAL_RELATIONSHIP,
    )
  })

  it('elapsedMs 为 NaN 时状态不变（假时钟出错不该污染关系）', () => {
    expect(stepRelationship(INITIAL_RELATIONSHIP, Number.NaN, 'coding', TOUCHED)).toBe(
      INITIAL_RELATIONSHIP,
    )
  })
})

describe('relationshipStrength 与 mood', () => {
  it('单调：任一维度上升，强度不下降', () => {
    const base: Relationship = { affection: 0.4, trust: 0.4, rapport: 0.4 }
    const stronger: Relationship = { affection: 0.5, trust: 0.4, rapport: 0.4 }
    expect(relationshipStrength(stronger)).toBeGreaterThan(relationshipStrength(base))
  })

  it('端点是 0 与 1', () => {
    expect(relationshipStrength({ affection: 0, trust: 0, rapport: 0 })).toBe(0)
    expect(relationshipStrength({ affection: 1, trust: 1, rapport: 1 })).toBe(1)
  })

  it('门槛是**包含**的（正好等于阈值时算进更高一档）', () => {
    // 构造恰好落在阈值上的组合：全维度同值 ⇒ 强度 = 该值。
    expect(relationshipMood({ affection: 1, trust: 1, rapport: 1 })).toBe('attached')
    const exactlyWarm = {
      affection: WARM_THRESHOLD,
      trust: WARM_THRESHOLD,
      rapport: WARM_THRESHOLD,
    }
    expect(relationshipStrength(exactlyWarm)).toBeCloseTo(WARM_THRESHOLD, 12)
    expect(relationshipMood(exactlyWarm)).toBe('warm')
  })

  it('初始关系落在 reserved（刚认识，礼貌而克制——不是冷淡）', () => {
    expect(relationshipMood(INITIAL_RELATIONSHIP)).toBe('reserved')
  })

  it('长期相处能升到 warm，再久能到 attached（门槛是可达的，不是永远够不着）', () => {
    const fewDays = interactForHours(INITIAL_RELATIONSHIP, 24 * 3, HOUR)
    expect(relationshipMood(fewDays)).not.toBe('reserved')

    const longTerm = interactForHours(INITIAL_RELATIONSHIP, 24 * 40, HOUR)
    expect(relationshipMood(longTerm)).toBe('attached')
  })

  it('阈值本身有序（写反了会让 attached 比 warm 更容易达到）', () => {
    expect(WARM_THRESHOLD).toBeLessThan(ATTACHED_THRESHOLD)
  })
})

describe('missesUser', () => {
  it('★ 返回的是"想念"，不是"被冷落"——判据含默契，单好感低可能只是刚认识', () => {
    expect(missesUser({ affection: 0.1, trust: 0.3, rapport: 0.1 })).toBe(true)
    // 好感低但默契高 ⇒ 是老朋友，不是"被冷落"。
    expect(missesUser({ affection: 0.1, trust: 0.5, rapport: 0.9 })).toBe(false)
  })

  it('正常关系下不想念', () => {
    expect(missesUser(INITIAL_RELATIONSHIP)).toBe(false)
  })

  it('★ 回落速率常数为正且很小（改大它们就等于改了"温柔"的程度）', () => {
    // 这些数字是 ADR-0003 在数值上的守卫，锁住以免被悄悄调大。
    expect(AFFECTION_DECAY_PER_HOUR).toBeLessThanOrEqual(1)
    expect(TRUST_DECAY_PER_HOUR).toBeLessThanOrEqual(1)
    expect(RAPPORT_PER_HOUR).toBeGreaterThan(0)
  })
})
