import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DAY_MS, SEMANTIC_PROMOTION_THRESHOLD } from '../core/memory/model'
import { MemoryService } from './service'

/**
 * `MemoryService` 的集成测试：**真实 SQLite 文件** + **假时钟**。
 *
 * ── 为什么这一层必须有测试 ──
 *
 * 下一层的 `store.ts` 测得再细，也测不到接线层的三件事：
 * ①遗忘曲线是不是**真的按时间流逝**在清理（假时钟能把 30 天压进 1 毫秒）；
 * ②升级是不是**真的写进了库**并且真的删掉了被吸收的源记忆；
 * ③★**日志里是不是真的没有记忆内容**（§1.2⑪ 的留痕约束）。
 *
 * ③ 尤其重要：它是"删除必须真的消失"这条承诺在**日志**那一侧的守卫，
 * 而日志是最容易被忽略的留痕位置。
 */

const NOW = 1_800_000_000_000

let workDir: string
let dbPath: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'xiaoqi-memory-service-'))
  dbPath = join(workDir, 'memory.db')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** 造一个可控时钟的 service。 */
function makeService(options: { now?: () => number } = {}): {
  service: MemoryService
  diagnostics: string[]
  advance: (ms: number) => void
} {
  let clock = NOW
  const now = options.now ?? ((): number => clock)
  const diagnostics: string[] = []
  const service = new MemoryService({
    dbPath,
    now,
    onDiagnostic: (message) => diagnostics.push(message),
  })
  return {
    service,
    diagnostics,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('MemoryService · 生命周期', () => {
  it('start 之后可用，且真的建出了数据库文件', () => {
    const { service } = makeService()
    const status = service.start()

    expect(status.available).toBe(true)
    expect(status.total).toBe(0)
    // 真的落到磁盘了，不是内存库。
    expect(() => readFileSync(dbPath)).not.toThrow()
    service.stop()
  })

  it('★ 数据库打不开时不抛异常，只是报告不可用（宠物必须照常能开）', () => {
    const diagnostics: string[] = []
    // 指向一个不可能的路径：父级是个文件，mkdir 必然失败。
    const service = new MemoryService({
      dbPath: join(dbPath, 'nested', 'memory.db'),
      onDiagnostic: (message) => diagnostics.push(message),
    })
    // 先占住那个路径，让后面 mkdir 失败。
    new Database(dbPath).close()

    expect(() => service.start()).not.toThrow()
    expect(service.status().available).toBe(false)
    expect(diagnostics.join('\n')).toContain('记忆不可用')
    service.stop()
  })

  it('不可用时所有读写都是安全的空操作', () => {
    const service = new MemoryService({ dbPath: join(dbPath, 'nested', 'memory.db') })
    new Database(dbPath).close()
    service.start()

    expect(() => {
      service.recordEpisode('随便', ['x'])
    }).not.toThrow()
    expect(service.search()).toEqual([])
    expect(service.forget(1)).toBe(false)
    expect(service.forgetAll()).toBe(0)
    expect(service.remember('事实')).toBeNull()
    expect(service.runMaintenance()).toEqual({ pruned: 0, promoted: 0 })
    service.stop()
  })
})

describe('MemoryService · 遗忘曲线（假时钟）', () => {
  it('★ 情景记忆 24h 后降权，最终被清理', () => {
    const { service, advance } = makeService()
    service.start()
    service.recordEpisode('今天开了个会', ['meeting'])

    // 刚写完还在。
    expect(service.search()).toHaveLength(1)

    // 半衰期 1 天。权重要到 0.02 以下需要约 5.6 个半衰期。
    advance(10 * DAY_MS)
    expect(service.runMaintenance().pruned).toBe(1)
    expect(service.search()).toHaveLength(0)
    service.stop()
  })

  it('★ 情感记忆衰减慢得多——同样的时间流逝，它还在', () => {
    const { service, advance } = makeService()
    service.start()
    service.recordEpisode('今天开了个会', ['meeting'])
    service.recordEmotion('今天被夸了', ['praise'], 'happy', 0.5)

    // 10 天：情景记忆该没了，情感记忆（半衰期 30 天）还在。
    advance(10 * DAY_MS)
    const { pruned } = service.runMaintenance()

    expect(pruned).toBe(1)
    const kinds = service.search().map((record) => record.kind)
    expect(kinds).toEqual(['emotional'])
    service.stop()
  })

  it('★ 强情绪事件长期保留（规格：强情绪事件长期保留）', () => {
    const { service, advance } = makeService()
    service.start()
    service.recordEmotion('特别开心的一天', ['praise'], 'happy', 0.9)

    // 1 年之后仍然不该被清掉。
    advance(365 * DAY_MS)
    expect(service.runMaintenance().pruned).toBe(0)
    expect(service.search()).toHaveLength(1)
    service.stop()
  })

  it('语义记忆永不衰减', () => {
    const { service, advance } = makeService()
    service.start()
    service.remember('用户用 Windows')

    advance(3650 * DAY_MS)
    expect(service.runMaintenance().pruned).toBe(0)
    expect(service.search()).toHaveLength(1)
    service.stop()
  })
})

describe('MemoryService · 反复发生升级为语义记忆', () => {
  it('★ 同类事件攒够次数后升级，且被吸收的情景记忆真的被删掉', () => {
    const { service, diagnostics } = makeService()
    service.start()

    for (let n = 1; n <= SEMANTIC_PROMOTION_THRESHOLD; n++) {
      service.recordEpisode(`第 ${String(n)} 次加班`, ['overtime'], NOW + n)
    }
    expect(service.search({ kinds: ['episodic'] })).toHaveLength(SEMANTIC_PROMOTION_THRESHOLD)

    const { promoted } = service.runMaintenance()
    expect(promoted).toBe(1)

    // 语义记忆出现了，情景记忆被吸收干净（否则同一件事会重复进 prompt）。
    const semantic = service.search({ kinds: ['semantic'] })
    expect(semantic).toHaveLength(1)
    expect(semantic[0]?.tags).toEqual(['overtime'])
    expect(semantic[0]?.content).toContain('overtime')
    expect(service.search({ kinds: ['episodic'] })).toHaveLength(0)

    // ★ 诊断里说了"升级了哪个主题"，但**没有**任何一条记忆原文。
    const log = diagnostics.join('\n')
    expect(log).toContain('overtime')
    for (let n = 1; n <= SEMANTIC_PROMOTION_THRESHOLD; n++) {
      expect(log).not.toContain(`第 ${String(n)} 次加班`)
    }
    service.stop()
  })

  it('★ 次数不够时不升级', () => {
    const { service } = makeService()
    service.start()
    service.recordEpisode('第一次加班', ['overtime'], NOW)
    service.recordEpisode('第二次加班', ['overtime'], NOW + 1)

    expect(service.runMaintenance().promoted).toBe(0)
    expect(service.search({ kinds: ['semantic'] })).toHaveLength(0)
    service.stop()
  })

  it('★ 同一主题不重复升级（第二次攒够时已有语义记忆，不再写第二条）', () => {
    const { service } = makeService()
    service.start()

    for (let n = 1; n <= SEMANTIC_PROMOTION_THRESHOLD; n++) {
      service.recordEpisode(`第一批 ${String(n)}`, ['overtime'], NOW + n)
    }
    expect(service.runMaintenance().promoted).toBe(1)

    for (let n = 1; n <= SEMANTIC_PROMOTION_THRESHOLD; n++) {
      service.recordEpisode(`第二批 ${String(n)}`, ['overtime'], NOW + 100 + n)
    }
    expect(service.runMaintenance().promoted).toBe(0)
    expect(service.search({ kinds: ['semantic'] })).toHaveLength(1)
    service.stop()
  })

  it('★ 已淡忘的情景记忆不会被算作"反复发生"的证据', () => {
    const { service, advance } = makeService()
    service.start()

    // 两条很旧的（已淡忘）+ 一条新的：不能凑成"3 次"。
    service.recordEpisode('很久以前加班 A', ['overtime'], NOW)
    service.recordEpisode('很久以前加班 B', ['overtime'], NOW + 1)
    advance(30 * DAY_MS)
    service.recordEpisode('刚刚加班', ['overtime'])

    // 本轮维护会先把旧的两条清掉，剩下的不足以升级。
    expect(service.runMaintenance().promoted).toBe(0)
    service.stop()
  })
})

describe('MemoryService · ★ 无痕（施工令 §1.2⑪）', () => {
  it('★ 删除后，原文在数据库文件里找不到（带对照组）', () => {
    const { service, diagnostics } = makeService()
    service.start()

    service.recordEpisode('用户说他的密码提示是紫色小猫', ['private'])
    service.remember('用户昨天也在加班', ['overtime'])

    const ephemeral = service.search({ kinds: ['episodic'] })[0]
    expect(ephemeral).toBeDefined()
    expect(service.forget(ephemeral!.id)).toBe(true)
    service.stop()

    const raw = readFileSync(dbPath)
    const gone = raw.indexOf(Buffer.from('用户说他的密码提示是紫色小猫', 'utf8'))
    const kept = raw.indexOf(Buffer.from('用户昨天也在加班', 'utf8'))

    expect(gone).toBe(-1)
    // ★ 对照组：没删的那条必须仍能扫到，否则"扫不到"可能只是扫描方法无效。
    expect(kept).not.toBe(-1)

    // ★ 日志里同样不得出现被删内容——这一点由 `fast` 断言单独守着。
    expect(diagnostics.join('\n')).not.toContain('紫色小猫')
  })

  it('★ 清空全部之后，所有原文都从文件与日志里消失', () => {
    const { service, diagnostics } = makeService()
    service.start()

    service.recordEpisode('第一条私密内容', ['a'])
    service.recordEpisode('第二条私密内容', ['b'])
    expect(service.forgetAll()).toBe(2)
    service.stop()

    const raw = readFileSync(dbPath)
    expect(raw.indexOf(Buffer.from('第一条私密内容', 'utf8'))).toBe(-1)
    expect(raw.indexOf(Buffer.from('第二条私密内容', 'utf8'))).toBe(-1)
    expect(diagnostics.join('\n')).not.toContain('私密内容')
  })

  it('★ 被拒绝的写入（强度越界）也不得把内容写进日志', () => {
    // ADR-0003 的守卫：强度越界说明调用方在做"累积"。
    // 拒绝是对的，但**报错信息里不能带上记忆内容**，否则留痕。
    const { service, diagnostics } = makeService()
    service.start()

    service.recordEmotion('一段不该留痕的隐私', ['x'], 'happy', 1.5)

    const log = diagnostics.join('\n')
    expect(log).toContain('记情感记忆失败')
    expect(log).not.toContain('一段不该留痕的隐私')
    service.stop()
  })
})

describe('MemoryService · 检索', () => {
  it('中文子串检索可用（这正是 FTS5 做不到的那条）', () => {
    const { service } = makeService()
    service.start()
    service.recordEpisode('用户昨天也在加班', ['overtime'])
    service.recordEpisode('今天天气不错', ['weather'])

    const hits = service.search({ query: '加班' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.content).toBe('用户昨天也在加班')
    service.stop()
  })

  it('按层级过滤', () => {
    const { service } = makeService()
    service.start()
    service.recordEpisode('事件', ['a'])
    service.remember('事实', ['b'])

    expect(service.search({ kinds: ['semantic'] })).toHaveLength(1)
    expect(service.search({ kinds: ['episodic', 'semantic'] })).toHaveLength(2)
    service.stop()
  })

  it('★ 账本里显示的与维护时清理的口径一致（不会"看得见却突然消失"）', () => {
    const { service, advance } = makeService()
    service.start()
    service.recordEpisode('快要被忘了的事', ['x'])

    // 走到"下一轮维护就会清掉"的边缘：搜索已经不该再显示它。
    advance(10 * DAY_MS)

    expect(service.search()).toHaveLength(0)
    expect(service.runMaintenance().pruned).toBe(1)
    service.stop()
  })
})
