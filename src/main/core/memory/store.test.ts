import { createRequire } from 'node:module'

import { beforeEach, describe, expect, it } from 'vitest'

import type { DatabaseLike } from './store'
import { escapeLike, MemoryStore } from './store'

/**
 * 记忆存储的读写测试。
 *
 * ── 这里刻意用**真的 SQLite**（内存库），不用假实现 ──
 *
 * 因为这一层最容易出错的地方恰恰在 SQL 里：
 * 「删除必须真的删除」、LIKE 的通配符转义、排序稳定性……
 * 用假实现测等于把这些全部跳过，测的只是"我调用了自己的假实现"。
 *
 * ⚠️ 这也意味着这个测试文件**依赖原生模块**（better-sqlite3），
 *    与 `core/` 里其它纯 TS 测试不同。但它是 `.test.ts`，
 *    所以 `boundary.test.ts` 的纯净性守卫（只检查非测试文件）不会拦它。
 *    这是刻意的：**验证 SQL 契约需要真的 SQL**。
 */
const require = createRequire(import.meta.url)
const BetterSqlite3 = require('better-sqlite3') as new (path: string) => DatabaseLike

/** 一个固定的"现在"，让时间相关的断言确定。 */
const NOW = new Date(2026, 8, 9, 10, 0, 0).getTime()

let db: DatabaseLike
let store: MemoryStore

beforeEach(() => {
  db = new BetterSqlite3(':memory:')
  store = new MemoryStore(db, { now: () => NOW })
})

describe('建表与 pragma', () => {
  it('打开后 secure_delete 是开启的（§1.2⑪ 的技术保障）', () => {
    const value = db.pragma('secure_delete', { simple: true })
    expect(value).toBe(1)
  })

  it('重复打开不报错（幂等建表）', () => {
    expect(() => new MemoryStore(db, { now: () => NOW })).not.toThrow()
  })
})

describe('写入与读取', () => {
  it('写入情景记忆后能按 id 取回', () => {
    const id = store.addEpisodic({
      occurredAt: NOW,
      content: '用户在写代码',
      tags: ['coding'],
    })
    const record = store.get(id)
    expect(record).not.toBeNull()
    expect(record?.kind).toBe('episodic')
    expect(record?.content).toBe('用户在写代码')
    expect(record?.tags).toEqual(['coding'])
  })

  it('写入情感记忆会保留情绪与强度', () => {
    const id = store.addEmotional({
      occurredAt: NOW,
      content: '用户夸了它一句',
      tags: ['praise'],
      emotion: 'happy',
      intensity: 0.8,
    })
    const record = store.get(id)
    expect(record?.emotion).toBe('happy')
    expect(record?.intensity).toBe(0.8)
  })

  it('语义记忆不衰减（weight 恒为 1）', () => {
    const id = store.addSemantic({ content: '用户讨厌开长会', tags: ['meeting'] })
    expect(store.get(id)?.weight).toBe(1)
  })

  it('★ 强度越界会被拒绝，并提示这是"累积"而不是"单次"', () => {
    // ADR-0003：情感强度是单次事件的量。越界通常意味着调用方在累加。
    expect(() =>
      store.addEmotional({
        occurredAt: NOW,
        content: 'x',
        tags: [],
        emotion: 'aggrieved',
        intensity: 1.4,
      }),
    ).toThrow(/单次事件/)
  })

  it('标签为空时不产生空字符串标签', () => {
    const id = store.addEpisodic({ occurredAt: NOW, content: '无标签', tags: [] })
    expect(store.get(id)?.tags).toEqual([])
  })
})

describe('★ 检索：中文子串（这正是不能用 FTS5 的那条路）', () => {
  beforeEach(() => {
    store.addEpisodic({ occurredAt: NOW, content: '用户昨天也在加班', tags: ['overtime'] })
    store.addEpisodic({ occurredAt: NOW, content: '用户说讨厌开长会', tags: ['meeting'] })
    store.addEpisodic({ occurredAt: NOW, content: '今天天气不错', tags: [] })
    store.addEpisodic({ occurredAt: NOW, content: '用户喜欢喝抹茶', tags: ['rest'] })
  })

  it('★ 2 字中文词能命中（FTS5 在这里是 0 命中）', () => {
    expect(store.search({ query: '加班' }).map((r) => r.content)).toEqual(['用户昨天也在加班'])
    expect(store.search({ query: '抹茶' }).map((r) => r.content)).toEqual(['用户喜欢喝抹茶'])
  })

  it('★ 1 字中文也能命中', () => {
    expect(store.search({ query: '茶' }).length).toBe(1)
  })

  it('★ 词出现在句子中间也能命中（前缀查询做不到这一点）', () => {
    const hits = store.search({ query: '讨厌' })
    expect(hits.map((r) => r.content)).toEqual(['用户说讨厌开长会'])
  })

  it('查不到的词返回空数组', () => {
    expect(store.search({ query: '摸鱼' })).toEqual([])
  })

  it('★ LIKE 通配符被转义：搜 % 不会变成"匹配任意"', () => {
    store.addEpisodic({ occurredAt: NOW, content: '进度 100% 完成', tags: [] })
    // 不转义的话 '%100%%' 会匹配到别的行，这里必须只命中真正含 "100%" 的那条
    const hits = store.search({ query: '100%' })
    expect(hits.map((r) => r.content)).toEqual(['进度 100% 完成'])
  })

  it('★ 下划线也被转义', () => {
    store.addEpisodic({ occurredAt: NOW, content: '变量名是 a_b', tags: [] })
    expect(store.search({ query: 'a_b' }).length).toBe(1)
    // 未转义时 'a_b' 会匹配 'axb'
    store.addEpisodic({ occurredAt: NOW, content: '变量名是 axb', tags: [] })
    expect(store.search({ query: 'a_b' }).map((r) => r.content)).toEqual(['变量名是 a_b'])
  })

  it('反斜杠本身也被转义（不会破坏 ESCAPE 语义）', () => {
    store.addEpisodic({ occurredAt: NOW, content: '路径是 C:\\temp', tags: [] })
    expect(store.search({ query: 'C:\\temp' }).length).toBe(1)
  })
})

describe('检索的筛选维度', () => {
  beforeEach(() => {
    store.addEpisodic({ occurredAt: NOW - 5 * 24 * 3600_000, content: '五天前的事', tags: ['a'] })
    store.addEpisodic({ occurredAt: NOW, content: '今天的事', tags: ['a', 'b'] })
    store.addEmotional({
      occurredAt: NOW,
      content: '今天很开心',
      tags: ['praise'],
      emotion: 'happy',
      intensity: 0.9,
    })
  })

  it('按层级过滤', () => {
    const onlyEmotional = store.search({ kinds: ['emotional'] })
    expect(onlyEmotional.length).toBe(1)
    expect(onlyEmotional[0]?.kind).toBe('emotional')
  })

  it('按标签过滤（精确标签，不是子串）', () => {
    // 标签 'a' 不该命中标签 'ab'
    store.addEpisodic({ occurredAt: NOW, content: '另一个', tags: ['ab'] })
    const hits = store.search({ tags: ['a'] })
    expect(hits.every((r) => r.tags.includes('a'))).toBe(true)
    expect(hits.some((r) => r.tags.includes('ab'))).toBe(false)
  })

  it('按情绪过滤', () => {
    expect(store.search({ emotion: 'happy' }).length).toBe(1)
    expect(store.search({ emotion: 'bored' }).length).toBe(0)
  })

  it('按时间下限过滤', () => {
    const recent = store.search({ since: NOW - 24 * 3600_000 })
    expect(recent.some((r) => r.content === '五天前的事')).toBe(false)
    expect(recent.some((r) => r.content === '今天的事')).toBe(true)
  })

  it('多个筛选维度是 AND 关系', () => {
    const hits = store.search({ tags: ['a'], since: NOW - 24 * 3600_000 })
    expect(hits.map((r) => r.content)).toEqual(['今天的事'])
  })

  it('★ 排序稳定：同一时刻按 id 倒序（否则测试会 flaky）', () => {
    const ids = [1, 2, 3].map((i) =>
      store.addEpisodic({ occurredAt: NOW, content: `同刻-${String(i)}`, tags: [] }),
    )
    const hits = store.search({ since: NOW })
    // 同 occurred_at 的三条里，最新的 id 必须排在最前
    expect(hits[0]?.id).toBe(ids[2])
  })

  it('limit 生效', () => {
    expect(store.search({ limit: 2 }).length).toBe(2)
  })
})

describe('★★ 删除必须真的删除（施工令 §1.2⑪）', () => {
  it('删掉之后按 id 取不到', () => {
    const id = store.addEpisodic({ occurredAt: NOW, content: '要被删掉的事', tags: [] })
    expect(store.deleteMemory(id)).toBe(true)
    expect(store.get(id)).toBeNull()
  })

  it('★ 删掉之后**用原文检索也查不到**（不是只加了软删除标记）', () => {
    const id = store.addEpisodic({ occurredAt: NOW, content: '用户昨天也在加班', tags: [] })
    store.deleteMemory(id)
    expect(store.search({ query: '加班' })).toEqual([])
    expect(store.search({ query: '用户昨天也在加班' })).toEqual([])
  })

  it('★ 删掉之后，底层表里也真的没有这一行（直接查原始 SQL 交叉验证）', () => {
    // 这一条专门防"软删除"：如果实现加了 deleted_at 标记，行还在，
    // 这条断言就会失败。
    const id = store.addEpisodic({ occurredAt: NOW, content: 'x', tags: [] })
    store.deleteMemory(id)
    const rows = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(id) as {
      n: number
    }
    expect(rows.n).toBe(0)
  })

  it('删不存在的 id 返回 false，不抛异常', () => {
    expect(store.deleteMemory(99999)).toBe(false)
  })

  it('一键清空返回删除条数，且之后检索为空', () => {
    store.addEpisodic({ occurredAt: NOW, content: 'a', tags: [] })
    store.addEpisodic({ occurredAt: NOW, content: 'b', tags: [] })
    expect(store.deleteAll()).toBe(2)
    expect(store.search({})).toEqual([])
  })

  it('★ 表里没有 deleted_at 之类的软删除列（结构层面就没有留痕的地方）', () => {
    const cols = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    for (const forbidden of ['deleted_at', 'deleted', 'is_deleted', 'trashed']) {
      expect(cols, `表里出现了软删除列 ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('遗忘曲线的落地（prune）', () => {
  it('情景记忆过期后被清掉', () => {
    store.addEpisodic({ occurredAt: NOW - 30 * 24 * 3600_000, content: '很久以前', tags: [] })
    expect(store.prune(NOW)).toBe(1)
    expect(store.search({})).toEqual([])
  })

  it('★ 语义记忆永不被清（它是"稳定事实"）', () => {
    store.addSemantic({ content: '用户讨厌开长会', tags: [] })
    expect(store.prune(NOW + 365 * 24 * 3600_000)).toBe(0)
    expect(store.search({ kinds: ['semantic'] }).length).toBe(1)
  })

  it('★ 强情绪事件豁免遗忘（施工令 §5 M3「强情绪事件长期保留」）', () => {
    store.addEmotional({
      occurredAt: NOW,
      content: '用户很少这么开心',
      tags: [],
      emotion: 'happy',
      intensity: 0.9,
    })
    expect(store.prune(NOW + 365 * 24 * 3600_000)).toBe(0)
  })

  it('弱情绪事件会被清掉（不是所有情绪都长期保留）', () => {
    store.addEmotional({
      occurredAt: NOW,
      content: '有点无聊',
      tags: [],
      emotion: 'bored',
      intensity: 0.2,
    })
    expect(store.prune(NOW + 365 * 24 * 3600_000)).toBe(1)
  })

  it('新鲜的情景记忆不会被清', () => {
    store.addEpisodic({ occurredAt: NOW, content: '刚发生', tags: [] })
    expect(store.prune(NOW)).toBe(0)
  })
})

describe('工作记忆', () => {
  it('存取与覆盖', () => {
    store.setWorking('k', 'v1')
    expect(store.getWorking('k')).toBe('v1')
    store.setWorking('k', 'v2')
    expect(store.getWorking('k')).toBe('v2')
  })

  it('取不存在的 key 返回 null', () => {
    expect(store.getWorking('missing')).toBeNull()
  })

  it('清空工作记忆', () => {
    store.setWorking('a', '1')
    store.clearWorking()
    expect(store.getWorking('a')).toBeNull()
  })
})

describe('escapeLike 本身（纯函数）', () => {
  it('转义三个特殊字符', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('C:\\x')).toBe('C:\\\\x')
  })

  it('普通文本原样返回', () => {
    expect(escapeLike('加班')).toBe('加班')
  })
})
