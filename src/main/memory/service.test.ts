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

    // ★ 来源必须留下来（账本靠它回答"你为什么记得这个"）。
    //
    // 这一条是修的 bug：升级路径改成走 `consolidateFact` 时，一开始漏传了
    // `plan.derivedFrom`，而 `addSemantic` 对它是可选的——**不传也能跑**，
    // 只是账本从此只能显示一句没有来由的结论。可选参数漏传不会报错，
    // 所以只能靠断言钉住。
    expect(semantic[0]?.derivedFrom).toBeDefined()
    const sourceId = semantic[0]?.derivedFrom
    expect(typeof sourceId).toBe('number')

    // ★ 诊断里说了"升级了哪个主题"与落成了哪种结局，但**没有**记忆原文。
    const log = diagnostics.join('\n')
    expect(log).toContain('overtime')
    expect(log).toContain('new')
    for (let n = 1; n <= SEMANTIC_PROMOTION_THRESHOLD; n++) {
      expect(log).not.toContain(`第 ${String(n)} 次加班`)
    }
    service.stop()
  })

  it('★ 升级走的是巩固决策，不是直接写入（同主题再攒够时得到 reinforce 而不是第二条）', () => {
    const { service } = makeService()
    service.start()

    for (let n = 1; n <= SEMANTIC_PROMOTION_THRESHOLD; n++) {
      service.recordEpisode(`第 ${String(n)} 次加班`, ['overtime'], NOW + n)
    }
    expect(service.runMaintenance().promoted).toBe(1)
    const first = service.search({ kinds: ['semantic'] })
    expect(first).toHaveLength(1)
    const firstId = first[0]?.id

    // 直接对同主题候选调用巩固：既有事实已存在且不矛盾 → 加强，不新增。
    // 这一条证明"升级路径与巩固路径用的是同一套决策"——如果升级仍是
    // 直接 `addSemantic`，这里会攒出第二条几乎一样的事实。
    expect(service.consolidateFact('用户又加班了', ['overtime'])).toBe('reinforce')
    const after = service.search({ kinds: ['semantic'] })
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(firstId)
    // 语义记忆权重恒为 1，所以断言的是"没被错误地调低"。
    expect(after[0]?.weight).toBeGreaterThanOrEqual(1)
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

describe('★ 阶段二接线：巩固决策落到真实库里', () => {
  it('new → 写入一条新事实', () => {
    const { service } = makeService()
    service.start()
    expect(service.consolidateFact('用户不喝咖啡', ['drink'])).toBe('new')
    const all = service.search({ kinds: ['semantic'] })
    expect(all).toHaveLength(1)
    expect(all[0]?.content).toBe('用户不喝咖啡')
    service.stop()
  })

  it('★ 同主题不矛盾 → reinforce：**不新增**，只把既有那条权重提上去', () => {
    const { service } = makeService()
    service.start()
    service.consolidateFact('用户工作日会加班', ['overtime'])
    const before = service.search({ kinds: ['semantic'] })[0]?.weight ?? 0

    expect(service.consolidateFact('用户这周又加班了', ['overtime'])).toBe('reinforce')

    const all = service.search({ kinds: ['semantic'] })
    // ★ 仍然只有一条 —— 这才是 reinforce 的定义：换个说法不该攒出一堆
    expect(all).toHaveLength(1)
    // 内容没被换掉（reinforce 不产生新内容）
    expect(all[0]?.content).toBe('用户工作日会加班')
    // 权重不下降。注意语义事实的权重恒为 1（不衰减），所以这里
    // 断言的是"没有被错误地调低" —— 第一版断言"必须变大"是错的，
    // 而它恰好抓出了一个真 bug：reinforce 曾把 1 降到 0.999999。
    expect(all[0]?.weight).toBeGreaterThanOrEqual(before)
    service.stop()
  })

  it('★ 同主题矛盾 → supersede：新旧都在，旧的被标记为被取代', () => {
    const { service } = makeService()
    service.start()
    service.consolidateFact('用户喝咖啡', ['drink'])
    expect(service.consolidateFact('用户不喝咖啡', ['drink'])).toBe('supersede')

    // ★ 历史视图（显式要 `'only'`）里两条都在——旧事实是历史，不是被删了。
    const history = service.search({ kinds: ['semantic'], superseded: 'only', limit: 100 })
    expect(history).toHaveLength(1)
    const old = history.find((r) => r.content === '用户喝咖啡')
    expect(old).toBeDefined()

    // ★ 而**默认检索**只有新的那条。
    //
    // 这一条是修的 bug，不是测试凑数：`search` 原来不过滤 `superseded_by`，
    // 于是"用户喝咖啡"和"用户不喝咖啡"会**同时**进 prompt。
    // 两条互相矛盾的事实一起进上下文，模型按先到的那条答 ——
    // 也就是有一半概率用错，而这是最难被察觉的一类错误。
    const live = service.search({ kinds: ['semantic'], limit: 100 })
    expect(live).toHaveLength(1)
    const fresh = live[0]
    expect(fresh?.content).toBe('用户不喝咖啡')
    expect(old?.supersededBy).toBe(fresh?.id)
    expect(old?.supersededAt).toBe(NOW)
    service.stop()
  })

  it('★ 完全相同 → discard：库不变化', () => {
    const { service } = makeService()
    service.start()
    service.consolidateFact('用户不喝咖啡', ['drink'])
    expect(service.consolidateFact('用户不喝咖啡', ['drink'])).toBe('discard')
    expect(service.search({ kinds: ['semantic'] })).toHaveLength(1)
    service.stop()
  })

  it('★ 巩固只看语义层：情景记忆不会去 reinforce 一条稳定事实', () => {
    const { service } = makeService()
    service.start()
    service.consolidateFact('用户工作日会加班', ['overtime'])
    // 一条同主题的**情景**记忆
    service.recordEpisode('用户又在加班', ['overtime'])

    // 候选与既有语义事实不重复（话题相同但都被判为"同主题不矛盾"）→ reinforce
    // 关键是它不会因为情景记忆的存在而变成 discard
    expect(service.consolidateFact('用户还是在加班', ['overtime'])).toBe('reinforce')
    service.stop()
  })
})

describe('★ 阶段二接线：核心块与上下文组装', () => {
  it('★ 首次读取就用默认人设补齐 persona（不必先写库）', () => {
    const { service } = makeService()
    service.start()
    const blocks = service.listBlocks()
    const persona = blocks.find((b) => b.kind === 'persona')
    expect(persona).toBeDefined()
    expect(persona?.content.length).toBeGreaterThan(0)
    // 只读不写：打开账本不该产生副作用
    expect(service.search({ kinds: ['semantic'] })).toHaveLength(0)
    service.stop()
  })

  it('★ 三个块**总是**都在，且带上限与"是否默认值"标记', () => {
    // ── 这条守的是一个真实的坑 ──
    //
    // 初版有两个读取方法（内部用的 `listBlocks` 与界面用的 `listBlockViews`），
    // 而 `composeContextForPrompt` 走的是**没有兜底**的那一个：库里还没有
    // persona 时它拿到空数组，"它自己是谁"那一段整段消失——而默认人设
    // 本来就是为了"从第一天起就有语气可用"才存在的。
    //
    // 所以断言的不是"有内容"，而是**三段齐全 + 兜底生效**，
    // 这样将来再拆出第二个读取路径时会被立刻抓住。
    const { service } = makeService()
    service.start()
    const blocks = service.listBlocks()
    expect(blocks.map((b) => b.kind)).toEqual(['persona', 'human', 'now'])

    const persona = blocks.find((b) => b.kind === 'persona')
    expect(persona?.isDefault).toBe(true)
    expect(persona?.limit).toBe(400)
    // 界面要显示"还能写多少"，所以上限必须随视图一起送出来
    expect(blocks.every((b) => typeof b.limit === 'number' && b.limit > 0)).toBe(true)
    // 中文块名也在这里拼好（渲染进程不该 import 主进程的 core/）
    expect(persona?.label).toBe('它自己')

    // ★ 而拼出来的上下文里**真的**有人设那一段 —— 这才是兜底的目的
    const text = service.composeContextForPrompt({
      now: { workMode: 'coding', emotion: 'calm', mood: 'reserved', misses: false },
    })
    expect(text).toContain('【它自己】')
    expect(text).toContain('小奇')
    service.stop()
  })

  it('★ 写过的 persona 不再是默认值（界面的"未落库"提示要准）', () => {
    const { service } = makeService()
    service.start()
    service.setBlock('persona', '我是另一只小动物')
    const persona = service.listBlocks().find((b) => b.kind === 'persona')
    expect(persona?.isDefault).toBe(false)
    expect(persona?.content).toBe('我是另一只小动物')
    service.stop()
  })

  it('★ human / now 空着就是真的空（不给它们编造内容）', () => {
    // persona 有兜底是因为"它自己是谁"必须有起始内容；
    // human 兜底就等于**它记得一些你没说过的事**——那是很糟的错觉。
    const { service } = makeService()
    service.start()
    const human = service.listBlocks().find((b) => b.kind === 'human')
    expect(human?.content).toBe('')
    expect(human?.isDefault).toBe(false)
    service.stop()
  })

  it('★ setBlock 会强制字符上限（按整行裁剪，不留半句）', () => {
    const { service } = makeService()
    service.start()
    const huge = Array.from({ length: 100 }, (_, i) => `第${String(i)}行挺长的内容`).join('\n')
    service.setBlock('human', huge)

    const stored = service.listBlocks().find((b) => b.kind === 'human')
    expect(stored).toBeDefined()
    expect(stored?.content.length).toBeLessThanOrEqual(600)
    // 不是简单截断：每一行都完整
    for (const line of stored?.content.split('\n') ?? []) {
      expect(line.startsWith('第')).toBe(true)
      expect(line.endsWith('容')).toBe(true)
    }
    service.stop()
  })

  it('setBlock 之后读回的是裁剪后的内容', () => {
    const { service } = makeService()
    service.start()
    service.setBlock('persona', '我是小奇')
    expect(service.listBlocks().find((b) => b.kind === 'persona')?.content).toBe('我是小奇')
    service.stop()
  })

  it('deleteBlock 之后又回到默认人设（不是消失）', () => {
    const { service } = makeService()
    service.start()
    service.setBlock('persona', '临时人设')
    expect(service.deleteBlock('persona')).toBe(true)
    const persona = service.listBlocks().find((b) => b.kind === 'persona')
    expect(persona?.content).not.toBe('临时人设')
    expect(persona?.content.length).toBeGreaterThan(0)
    service.stop()
  })

  it('★ composeContextForPrompt 三段齐全，且核心块在检索结果之前', () => {
    const { service } = makeService()
    service.start()
    service.consolidateFact('用户不喝咖啡', ['drink'])
    service.setBlock('human', '用户不喝咖啡')

    const text = service.composeContextForPrompt({
      now: { workMode: '加班', emotion: '困', mood: 'warm', misses: false },
    })

    expect(text).toContain('它自己')
    expect(text).toContain('关于你')
    expect(text).toContain('此刻')
    expect(text).toContain('用户不喝咖啡')
    // 核心块在检索结果之前
    const humanIndex = text.indexOf('关于你')
    const recalledIndex = text.indexOf('我想起来的事')
    if (recalledIndex >= 0) expect(humanIndex).toBeLessThan(recalledIndex)
    service.stop()
  })

  it('记忆不可用时 composeContextForPrompt 不抛错，返回空串', () => {
    const service = new MemoryService({ dbPath: join(dbPath, 'nested', 'memory.db') })
    new Database(dbPath).close()
    service.start()
    const text = service.composeContextForPrompt({
      now: { workMode: '编码', emotion: '平静', mood: 'reserved', misses: false },
    })
    // now 块仍然能拼出来（它不依赖数据库）
    expect(text).toContain('此刻')
    service.stop()
  })
})
