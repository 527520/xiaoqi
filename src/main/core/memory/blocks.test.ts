import { describe, expect, it } from 'vitest'

import {
  BLOCK_KINDS,
  BLOCK_LABELS,
  BLOCK_LIMITS,
  composeContext,
  composeNowBlock,
  DEFAULT_PERSONA,
  defaultPersonaBlock,
  fitBlock,
  type MemoryBlock,
} from './blocks'

/**
 * 核心记忆块（Letta 式常驻块）的测试。
 *
 * ⚠️ 这里最要紧的一条是**措辞守卫**：核心块是**常驻上下文**，
 *    一旦写进"用户很少理我"这类内容，它会每一轮都被模型读到，
 *    于是宠物会持续表现成委屈/索取——那正是 ADR-0003 禁止的指控式表达，
 *    而且因为它常驻，危害比检索式记忆大得多。
 */

const NOW = 1_800_000_000_000

describe('上限与标签', () => {
  it('三种块都有上限与中文名', () => {
    for (const kind of BLOCK_KINDS) {
      expect(BLOCK_LIMITS[kind]).toBeGreaterThan(0)
      expect(BLOCK_LABELS[kind].length).toBeGreaterThan(0)
    }
  })

  it('★ 上限是"预算"而非"容量"：都很小', () => {
    // 常驻内容的边际价值下降很快，而它每轮都要占 token。
    // 若有人把上限调到几千，这条会失败——那是需要重新论证的决定。
    for (const kind of BLOCK_KINDS) {
      expect(BLOCK_LIMITS[kind]).toBeLessThanOrEqual(1000)
    }
  })

  it('BLOCK_KINDS 顺序稳定且无重复', () => {
    expect(BLOCK_KINDS).toEqual(['persona', 'human', 'now'])
  })
})

describe('fitBlock：按整行裁剪', () => {
  it('放得下就全留', () => {
    expect(fitBlock(['a', 'b'], 10)).toBe('a\nb')
  })

  it('★ 只保留能**完整**放下的行，绝不截断半行', () => {
    // 半句事实比没有更糟：它会被当成完整事实读进去。
    const result = fitBlock(['12345', '67890'], 7)
    expect(result).toBe('12345')
    expect(result).not.toContain('67')
  })

  it('★ 放不下的行直接丢弃，后面的行仍有机会（不是"遇到第一个超限就停"）', () => {
    const result = fitBlock(['12345678', 'x'], 8)
    expect(result).toBe('12345678')
    // 'x' 放不下（8 + 1 + 1 > 8），所以只剩第一行
    const result2 = fitBlock(['1234567', 'x'], 9)
    expect(result2).toBe('1234567\nx')
  })

  it('忽略空行与只有空白的行', () => {
    expect(fitBlock(['a', '', '   ', 'b'], 100)).toBe('a\nb')
  })

  it('上限非正时返回空串（不抛错）', () => {
    expect(fitBlock(['a'], 0)).toBe('')
    expect(fitBlock(['a'], -5)).toBe('')
    expect(fitBlock(['a'], Number.NaN)).toBe('')
  })

  it('什么都不放得下时返回空串', () => {
    expect(fitBlock(['abc'], 2)).toBe('')
  })

  it('★ 结果长度永不超过上限', () => {
    const lines = ['用户不喜欢开会', '用户常在周末工作', '用户喝咖啡', '用户养了一只猫']
    for (let limit = 0; limit <= 60; limit++) {
      expect(fitBlock(lines, limit).length).toBeLessThanOrEqual(limit)
    }
  })
})

describe('composeNowBlock', () => {
  const base = { workMode: '加班', emotion: '困', mood: 'reserved', misses: false }

  it('★ 只陈述状态，不做评价、不索取', () => {
    const text = composeNowBlock(base)
    expect(text).toContain('加班')
    expect(text).toContain('困')
    // 不该出现"你该休息了"这类祈使/评价
    for (const banned of ['应该', '该休息', '必须', '快点']) {
      expect(text).not.toContain(banned)
    }
  })

  it('★ "想念"的措辞必须是宠物自己的感受，不能是"你很久没来"', () => {
    const text = composeNowBlock({ ...base, misses: true })
    expect(text).toContain('想你')
    // 指控式表达一律不许出现
    for (const banned of ['很久没', '都不来', '你为什么不', '冷落']) {
      expect(text).not.toContain(banned)
    }
  })

  it('只在关系亲近时才提黏人（刚认识时说不通）', () => {
    expect(composeNowBlock({ ...base, mood: 'attached' })).toContain('靠得近')
    expect(composeNowBlock({ ...base, mood: 'warm' })).not.toContain('靠得近')
    expect(composeNowBlock({ ...base, mood: 'reserved' })).not.toContain('靠得近')
  })

  it('结果不超过 now 的上限', () => {
    const text = composeNowBlock({ ...base, mood: 'attached', misses: true })
    expect(text.length).toBeLessThanOrEqual(BLOCK_LIMITS.now)
  })
})

describe('★ 措辞守卫：persona 块只描述宠物自己', () => {
  it('默认 persona 不描述用户、不含指控', () => {
    const text = DEFAULT_PERSONA.join('\n')
    for (const banned of ['用户', '你很少', '你都不', '很久没', '不理我', '冷落', '生气']) {
      expect(text).not.toContain(banned)
    }
  })

  it('默认 persona 不超过上限', () => {
    expect(defaultPersonaBlock(NOW).content.length).toBeLessThanOrEqual(BLOCK_LIMITS.persona)
  })

  it('defaultPersonaBlock 带上时间戳与种类', () => {
    const block = defaultPersonaBlock(NOW)
    expect(block.kind).toBe('persona')
    expect(block.updatedAt).toBe(NOW)
    expect(block.content.length).toBeGreaterThan(0)
  })
})

describe('composeContext', () => {
  const block = (kind: MemoryBlock['kind'], content: string): MemoryBlock => ({
    kind,
    content,
    updatedAt: NOW,
  })

  it('★ 核心块排在检索结果**之前**（靠前的内容更被当回事）', () => {
    const text = composeContext({
      blocks: [block('human', '用户不喝咖啡')],
      recalled: ['某天加了班'],
    })
    expect(text.indexOf('关于你')).toBeLessThan(text.indexOf('我想起来的事'))
  })

  it('块顺序固定为 persona → human → now', () => {
    const text = composeContext({
      blocks: [block('now', '此刻内容'), block('human', '用户内容'), block('persona', '自己内容')],
      recalled: [],
    })
    const order = ['它自己', '关于你', '此刻'].map((label) => text.indexOf(label))
    expect(order[0]).toBeLessThan(order[1]!)
    expect(order[1]).toBeLessThan(order[2]!)
  })

  it('★ 缺失或为空的块整段略去（不留空标题制造噪声）', () => {
    const text = composeContext({ blocks: [block('persona', '   ')], recalled: [] })
    expect(text).toBe('')
    expect(text).not.toContain('【')
  })

  it('没有检索结果时不出现那一段', () => {
    const text = composeContext({ blocks: [block('persona', '我是小奇')], recalled: [] })
    expect(text).not.toContain('我想起来的事')
  })

  it('检索结果按条目前缀，便于模型分辨"这是若干条"', () => {
    const text = composeContext({
      blocks: [],
      recalled: ['第一件', '第二件'],
    })
    expect(text).toContain('- 第一件')
    expect(text).toContain('- 第二件')
  })

  it('检索条数受 recalledLimit 限制', () => {
    const text = composeContext({
      blocks: [],
      recalled: ['a', 'b', 'c', 'd'],
      recalledLimit: 2,
    })
    expect(text).toContain('- a')
    expect(text).toContain('- b')
    expect(text).not.toContain('- c')
  })

  it('recalledLimit 为 0 时不出现检索段', () => {
    const text = composeContext({ blocks: [], recalled: ['a'], recalledLimit: 0 })
    expect(text).not.toContain('我想起来的事')
  })

  it('★ 超限的块在拼装时也被裁剪（不信任调用方已裁过）', () => {
    const huge = Array.from({ length: 200 }, (_, i) => `第${String(i)}行很长的内容`).join('\n')
    const text = composeContext({ blocks: [block('human', huge)], recalled: [] })
    // 正文长度不应超过上限（再加上标题这一行）
    expect(text.length).toBeLessThanOrEqual(BLOCK_LIMITS.human + 20)
  })

  it('空输入返回空串（不抛错）', () => {
    expect(composeContext({ blocks: [], recalled: [] })).toBe('')
  })
})
