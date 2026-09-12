import { describe, expect, it } from 'vitest'

import type { MemoryRecord } from './model'
import {
  contradicts,
  normalizeContent,
  planConsolidation,
  reinforcedWeight,
  sameTopic,
  similarity,
  type FactCandidate,
} from './consolidate'

/**
 * 事实巩固的测试。
 *
 * ⚠️ 这里最重要的不是"规则跑得通"，而是**误判的代价不对称**：
 * - 漏判（该取代却没取代）→ 账本里多一条旧事实，用户能看见、能删；
 * - 误判（把两件不同的事当成矛盾）→ **悄悄只留下一条**，
 *   用户会觉得"它怎么忘了我还喜欢茶"。
 *
 * 所以下面有几条专门断言"**不该**判成矛盾"的用例。
 */

const NOW = 1_800_000_000_000

let nextId = 1
function semantic(content: string, tags: string[], occurredAt = NOW): MemoryRecord {
  return { id: nextId++, kind: 'semantic', occurredAt, content, tags, weight: 1 }
}

const candidate = (content: string, tags: string[]): FactCandidate => ({ content, tags })

describe('normalizeContent', () => {
  it('去掉空白与中英文标点', () => {
    expect(normalizeContent('用户，昨天：加班。')).toBe('用户昨天加班')
    expect(normalizeContent('Hello, World!')).toBe('helloworld')
  })

  it('幂等', () => {
    const once = normalizeContent('用户（昨天）加班！')
    expect(normalizeContent(once)).toBe(once)
  })
})

describe('similarity（Dice 系数 / 2 字滑窗）', () => {
  it('完全相同为 1', () => {
    expect(similarity('用户加班', '用户加班')).toBe(1)
  })

  it('★ 空串与空串算相同（否则空内容会被反复写入）', () => {
    expect(similarity('', '')).toBe(1)
  })

  it('任一为空则为 0', () => {
    expect(similarity('用户加班', '')).toBe(0)
    expect(similarity('', '用户加班')).toBe(0)
  })

  it('★ 换个说法仍算高度相似（模板句只差几个字）', () => {
    // LCS 相似度实测 0.833。用 2 字滑窗时只有 0.600，
    // 与"不同的事"（0.667）几乎分不开——见 `similarity()` 的注释。
    const value = similarity('用户经常加班', '用户常常加班')
    expect(value).toBeGreaterThan(0.75)
  })

  it('★ 不同的事相似度**明显低于**换个说法（这是不误判的基础）', () => {
    const rephrased = similarity('用户经常加班', '用户常常加班')
    const different = similarity('用户喜欢咖啡', '用户喜欢茶')
    const unrelated = similarity('用户喝咖啡', '用户不喜欢开会')

    expect(different).toBeLessThan(rephrased)
    expect(unrelated).toBeLessThan(rephrased)
    // 拉开足够差距，才能选出一个把两者分开的门槛
    expect(different).toBeLessThan(0.7)
    expect(rephrased).toBeGreaterThan(0.8)
  })

  it('值域在 [0,1]', () => {
    const pairs: [string, string][] = [
      ['abc', 'abc'],
      ['abc', 'xyz'],
      ['用户加班', '用户不加班'],
      ['一', '二'],
    ]
    for (const [a, b] of pairs) {
      const value = similarity(a, b)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('单字串退化成相等判断（不做 2 字滑窗）', () => {
    expect(similarity('甲', '甲')).toBe(1)
    expect(similarity('甲', '乙')).toBe(0)
  })
})

describe('contradicts', () => {
  it('★ 肯定 vs 否定同一件事 → 矛盾', () => {
    expect(contradicts('用户喝咖啡', '用户不喝咖啡')).toBe(true)
    expect(contradicts('用户不喝咖啡', '用户喝咖啡')).toBe(true)
  })

  it('★ 两句都肯定 → 不矛盾', () => {
    expect(contradicts('用户喝咖啡', '用户喝茶')).toBe(false)
  })

  it('★ 两句都否定 → 不矛盾（不是"双重否定即肯定"，只是无从判断）', () => {
    expect(contradicts('用户不喝咖啡', '用户不喝茶')).toBe(false)
  })

  it('★ 不该误判：不同主题的肯定/否定不算矛盾', () => {
    // 这是误判代价最大的场景——判成矛盾会让其中一条被取代而消失
    expect(contradicts('用户喝咖啡', '用户不喜欢开会')).toBe(false)
    expect(contradicts('用户喜欢猫', '用户不吃辣')).toBe(false)
  })

  it('认得出"戒/停止/没"这类否定', () => {
    expect(contradicts('用户喝咖啡', '用户戒了咖啡')).toBe(true)
    expect(contradicts('用户抽烟', '用户停止抽烟')).toBe(true)
    expect(contradicts('用户会午睡', '用户没午睡')).toBe(true)
  })

  it('对称', () => {
    expect(contradicts('用户喝咖啡', '用户不喝咖啡')).toBe(
      contradicts('用户不喝咖啡', '用户喝咖啡'),
    )
  })
})

describe('sameTopic', () => {
  it('标签顺序不影响判定', () => {
    expect(sameTopic(['a', 'b'], ['b', 'a'])).toBe(true)
  })

  it('空标签被忽略', () => {
    expect(sameTopic(['a', ''], ['a'])).toBe(true)
    expect(sameTopic([], [])).toBe(true)
  })

  it('不同标签不算同主题', () => {
    expect(sameTopic(['a'], ['b'])).toBe(false)
  })
})

describe('planConsolidation：四种结局', () => {
  it('① 没有任何相关既有 → new', () => {
    const plan = planConsolidation({
      candidate: candidate('用户经常加班', ['overtime']),
      existing: [],
    })
    expect(plan.action).toBe('new')
    expect(plan.content).toBe('用户经常加班')
    expect(plan.tags).toEqual(['overtime'])
  })

  it('★ ② 同主题且高度重复 → discard（不新增、也不加强）', () => {
    const plan = planConsolidation({
      candidate: candidate('用户经常加班', ['overtime']),
      existing: [semantic('用户经常加班', ['overtime'])],
    })
    expect(plan.action).toBe('discard')
  })

  it('★ 换个说法**不**算重复 → 走 reinforce（加强既有，不新增）', () => {
    // 这是刻意的：同一件事换个说法时，正确反应是"加强原来那条"，
    // 而不是"再写一条"。默认阈值 0.9 就是为了让这类情况落到 reinforce。
    const plan = planConsolidation({
      candidate: candidate('用户常常加班', ['overtime']),
      existing: [semantic('用户经常加班', ['overtime'])],
    })
    expect(plan.action).toBe('reinforce')
  })

  it('★ 完全相同才算重复 → discard', () => {
    const plan = planConsolidation({
      candidate: candidate('用户经常加班', ['overtime']),
      existing: [semantic('用户经常加班', ['overtime'])],
    })
    expect(plan.action).toBe('discard')
  })

  it('★ ③ 同主题且矛盾 → supersede，并指向被取代的那条', () => {
    const old = semantic('用户喝咖啡', ['drink'])
    const plan = planConsolidation({
      candidate: candidate('用户不喝咖啡', ['drink']),
      existing: [old],
    })
    expect(plan.action).toBe('supersede')
    expect(plan.targetId).toBe(old.id)
    expect(plan.content).toBe('用户不喝咖啡')
  })

  it('★ ④ 同主题不矛盾 → reinforce（加强既有，不新增）', () => {
    const old = semantic('用户工作日会加班', ['overtime'])
    const plan = planConsolidation({
      candidate: candidate('用户这周又加班了', ['overtime']),
      existing: [old],
    })
    expect(plan.action).toBe('reinforce')
    expect(plan.targetId).toBe(old.id)
    // 加强**不**产生新内容——否则等于换个说法又写一条
    expect(plan.content).toBeUndefined()
  })

  it('★ 不同主题各走各的：不会因为别处有矛盾就取代', () => {
    const other = semantic('用户喝咖啡', ['drink'])
    const plan = planConsolidation({
      candidate: candidate('用户经常加班', ['overtime']),
      existing: [other],
    })
    expect(plan.action).toBe('new')
  })

  it('reinforce 命中**最近**的一条（同主题多条时）', () => {
    const older = semantic('用户会加班', ['overtime'], NOW - 10_000)
    const newer = semantic('用户又加班', ['overtime'], NOW)
    const plan = planConsolidation({
      candidate: candidate('用户这周还加班', ['overtime']),
      existing: [older, newer],
    })
    expect(plan.action).toBe('reinforce')
    expect(plan.targetId).toBe(newer.id)
  })

  it('判据顺序：完全重复优先于矛盾', () => {
    // 一条完全相同的旧记忆 + 一条矛盾的旧记忆 → 应当是 discard
    const plan = planConsolidation({
      candidate: candidate('用户不喝咖啡', ['drink']),
      existing: [semantic('用户不喝咖啡', ['drink']), semantic('用户喝咖啡', ['drink'])],
    })
    expect(plan.action).toBe('discard')
  })

  it('判据顺序：矛盾优先于加强', () => {
    const plan = planConsolidation({
      candidate: candidate('用户不喝咖啡', ['drink']),
      existing: [semantic('用户常喝咖啡', ['drink'])],
    })
    expect(plan.action).toBe('supersede')
  })

  it('阈值可调，且默认值偏严', () => {
    const similarButNotSame = semantic('用户经常加班到很晚', ['overtime'])
    const strict = planConsolidation({
      candidate: candidate('用户经常加班', ['overtime']),
      existing: [similarButNotSame],
    })
    // 默认阈值 0.9 下不算重复 → 走 reinforce（同主题不矛盾）
    expect(strict.action).toBe('reinforce')
  })
})

describe('reinforcedWeight', () => {
  it('★ 单调不降、且**永不达到 1**（保留"被确认过几次"的差别）', () => {
    // ⚠️ 断言"严格递增"是错的：渐近式在浮点下约 190 次后就会下溢到
    //    与 1 无法区分，此时 `next === value`。所以判据是
    //    **单调不降 + 严格小于 1**，而不是"每次都变大"。
    //    （`reinforcedWeight` 里因此把结果钳在 1 - 1e-6。）
    let value = 0.3
    for (let i = 0; i < 300; i++) {
      const next = reinforcedWeight(value)
      expect(next).toBeGreaterThanOrEqual(value)
      expect(next).toBeLessThan(1)
      value = next
    }
    // 而且它确实涨到了很接近 1 —— 否则"永不达到"就变成"根本涨不上去"
    expect(value).toBeGreaterThan(0.99)
  })

  it('一次加强的幅度适中（不明显跳变）', () => {
    const gain = reinforcedWeight(0.5) - 0.5
    expect(gain).toBeGreaterThan(0.05)
    expect(gain).toBeLessThan(0.15)
  })

  it('越接近 1 涨得越慢（渐近，而不是线性）', () => {
    const low = reinforcedWeight(0.2) - 0.2
    const high = reinforcedWeight(0.9) - 0.9
    expect(high).toBeLessThan(low)
  })

  it('多次确认比一次涨得多，但仍不到 1', () => {
    const once = reinforcedWeight(0.5, 1)
    const thrice = reinforcedWeight(0.5, 3)
    expect(thrice).toBeGreaterThan(once)
    expect(thrice).toBeLessThan(1)
  })

  it('边界：0 与 1 都不越界', () => {
    expect(reinforcedWeight(0)).toBeGreaterThan(0)
    expect(reinforcedWeight(1)).toBeLessThanOrEqual(1)
    expect(reinforcedWeight(1)).toBeGreaterThan(0.9)
  })

  it('非法输入不产生 NaN（NaN 会污染整条权重链路）', () => {
    expect(reinforcedWeight(Number.NaN)).toBe(0)
    expect(Number.isFinite(reinforcedWeight(0.5, Number.NaN))).toBe(true)
    expect(Number.isFinite(reinforcedWeight(0.5, -3))).toBe(true)
  })
})
