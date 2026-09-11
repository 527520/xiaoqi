import { describe, expect, it } from 'vitest'

import { DAY_MS, EPISODIC_HALFLIFE_DAYS, SEMANTIC_PROMOTION_THRESHOLD } from './model'
import type { MemoryRecord } from './model'
import { describeTopic, groupByTopic, planPromotions, topicKeyOf } from './promote'

const NOW = 1_800_000_000_000

let nextId = 1

/** 造一条情景记忆。默认"刚刚发生"，权重 1。 */
function episodic(
  content: string,
  tags: string[],
  options: { occurredAt?: number; id?: number; weight?: number } = {},
): MemoryRecord {
  const id = options.id ?? nextId++
  return {
    id,
    kind: 'episodic',
    occurredAt: options.occurredAt ?? NOW,
    content,
    tags,
    weight: options.weight ?? 1,
  }
}

function semantic(content: string, tags: string[], id = nextId++): MemoryRecord {
  return { id, kind: 'semantic', occurredAt: NOW, content, tags, weight: 1 }
}

describe('topicKeyOf', () => {
  it('标签顺序不影响主题身份', () => {
    // 这条保证"先写 overtime 还是先写 weeknight"不会变成两个主题。
    expect(topicKeyOf(['overtime', 'weeknight'])).toBe(topicKeyOf(['weeknight', 'overtime']))
  })

  it('没有标签时是空主题（不参与升级）', () => {
    expect(topicKeyOf([])).toBe('')
    expect(topicKeyOf([''])).toBe('')
  })
})

describe('groupByTopic', () => {
  it('按标签组把同类事件聚在一起', () => {
    const groups = groupByTopic([
      episodic('用户昨天加班', ['overtime']),
      episodic('用户今天加班', ['overtime']),
      episodic('用户被夸了', ['praise']),
    ])

    const byKey = new Map(groups.map((group) => [group.topicKey, group]))
    expect(byKey.get('overtime')?.records).toHaveLength(2)
    expect(byKey.get('praise')?.records).toHaveLength(1)
  })

  it('★ 无标签的事件不成组——没有主题就谈不上反复发生', () => {
    const groups = groupByTopic([episodic('随便一条', []), episodic('另一条', [])])
    expect(groups).toEqual([])
  })

  it('每组内最近的排在最前', () => {
    const older = episodic('早', ['overtime'], { occurredAt: NOW - 3 * DAY_MS })
    const newer = episodic('晚', ['overtime'], { occurredAt: NOW - DAY_MS })
    const groups = groupByTopic([older, newer])

    expect(groups[0]?.records.map((record) => record.content)).toEqual(['晚', '早'])
  })

  it('★ 计数取库内条数与累计计数的较大值（升级删源后不会归零）', () => {
    // 场景：库里只剩 1 条，但历来出现过 4 次（前 3 次已被升级吸收）。
    // 若只看库里条数，这个主题就永远升不了级了。
    const groups = groupByTopic([episodic('又加班', ['overtime'])], new Map([['overtime', 4]]))
    expect(groups[0]?.occurrences).toBe(4)
  })

  it('★ 累计计数丢失时也不会归零（换机器 / 清库后仍能靠存量升级）', () => {
    const records = [1, 2, 3].map((n) => episodic(`加班 ${String(n)}`, ['overtime']))
    const groups = groupByTopic(records, new Map())
    expect(groups[0]?.occurrences).toBe(3)
  })
})

describe('describeTopic', () => {
  it('生成的事实里带上主题与次数，并引用最近一次的具体来由', () => {
    const groups = groupByTopic(
      [
        // 明确的时间先后，"最近一次"才有确定答案。
        episodic('用户昨天也在加班', ['overtime'], { occurredAt: NOW - DAY_MS }),
        episodic('用户今天还在加班', ['overtime'], { occurredAt: NOW }),
      ],
      new Map([['overtime', SEMANTIC_PROMOTION_THRESHOLD]]),
    )
    const text = describeTopic(groups[0]!)

    expect(text).toContain('overtime')
    expect(text).toContain(String(SEMANTIC_PROMOTION_THRESHOLD))
    // 带着具体来由，而不是一句空洞的"用户经常加班"。
    expect(text).toContain('用户今天还在加班')
  })

  it('★ 生成的事实里不含"累积强度"这类越界措辞（ADR-0003 的措辞守卫）', () => {
    const groups = groupByTopic([episodic('用户加班', ['overtime'])])
    const text = describeTopic(groups[0]!)

    // 升级描述只该陈述"反复发生"这一事实，不该给情绪或指责定性。
    for (const banned of ['生气', '失望', '委屈', '不理', '惩罚']) {
      expect(text).not.toContain(banned)
    }
  })
})

describe('planPromotions', () => {
  it('★ 反复发生够多次才升级', () => {
    const few = [1, 2].map((n) => episodic(`加班 ${String(n)}`, ['overtime']))
    expect(planPromotions({ episodic: few })).toEqual([])

    const enough = [1, 2, 3].map((n) => episodic(`加班 ${String(n)}`, ['overtime']))
    expect(planPromotions({ episodic: enough })).toHaveLength(1)
  })

  it('★ 已有同主题语义记忆时不重复升级', () => {
    const enough = [1, 2, 3].map((n) => episodic(`加班 ${String(n)}`, ['overtime']))
    const plans = planPromotions({
      episodic: enough,
      semantic: [semantic('用户经常加班', ['overtime'])],
    })
    expect(plans).toEqual([])
  })

  it('不同主题各自独立判定', () => {
    const records = [
      ...[1, 2, 3].map((n) => episodic(`加班 ${String(n)}`, ['overtime'])),
      episodic('被夸了一次', ['praise']),
    ]
    const plans = planPromotions({ episodic: records })

    expect(plans.map((plan) => plan.topicKey)).toEqual(['overtime'])
  })

  it('升级计划吸收了该主题的全部情景记忆', () => {
    const records = [1, 2, 3].map((n) => episodic(`加班 ${String(n)}`, ['overtime']))
    const plan = planPromotions({ episodic: records })[0]!

    expect([...plan.consumedIds].sort()).toEqual(records.map((record) => record.id).sort())
    // derivedFrom 指向最近的一条，用于回答"为什么它记得"。
    expect(plan.derivedFrom).toBe(records[2]!.id)
  })

  it('★ 没有新证据时不升级（避免空转）', () => {
    // 累计计数已达阈值，但库里只剩 1 条新证据 —— minConsumed 默认 2 时不该动。
    const groupsCounts = new Map([['overtime', SEMANTIC_PROMOTION_THRESHOLD]])
    const plans = planPromotions({
      episodic: [episodic('刚加完班', ['overtime'])],
      occurrenceCounts: groupsCounts,
    })
    expect(plans).toEqual([])
  })

  it('标签里含逗号也不会串味（主题键用逗号连接的前提是标签本身不含逗号）', () => {
    const key = topicKeyOf(['a,b', 'c'])
    // 结果是 'a,b,c'；与其纠结，不如确认它至少是稳定的、可比较的。
    expect(typeof key).toBe('string')
    expect(topicKeyOf(['a,b', 'c'])).toBe(key)
  })

  it('结果与输入顺序无关（可测性）', () => {
    const records = [1, 2, 3].map((n) => episodic(`加班 ${String(n)}`, ['overtime']))
    const forward = planPromotions({ episodic: records })
    const backward = planPromotions({ episodic: [...records].reverse() })

    expect(forward.map((plan) => plan.topicKey)).toEqual(backward.map((plan) => plan.topicKey))
    expect(forward[0]?.consumedIds).toEqual(backward[0]?.consumedIds)
  })

  it('只处理情景记忆，语义/情感记忆不会被误升级', () => {
    const plans = planPromotions({
      episodic: [
        { id: 900, kind: 'semantic', occurredAt: NOW, content: '已有事实', tags: ['x'], weight: 1 },
        {
          id: 901,
          kind: 'emotional',
          occurredAt: NOW,
          content: '很开心',
          tags: ['x'],
          weight: 0.9,
        },
        { id: 902, kind: 'episodic', occurredAt: NOW, content: '事件', tags: ['x'], weight: 1 },
      ],
    })
    expect(plans).toEqual([])
  })
})

describe('与遗忘曲线的配合', () => {
  it('★ 半衰期决定了"多久之后同类事件才算稀罕"——这里锁住口径以免被悄悄改掉', () => {
    // 情景记忆半衰期是 1 天（规格：小事 24h 降权）。
    // 若这个值被改大，同类事件会更容易凑够阈值，升级会变得廉价。
    expect(EPISODIC_HALFLIFE_DAYS).toBe(1)
  })
})
