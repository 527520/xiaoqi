import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import type { Emotion, MemoryLedgerEntry } from '@shared/types'

import {
  BLOCK_LIMITS,
  composeContext,
  composeNowBlock,
  defaultPersonaBlock,
  fitBlock,
  type MemoryBlock,
  type MemoryBlockKind,
  type NowBlockInput,
} from '../core/memory/blocks'
import {
  planConsolidation,
  reinforcedWeight,
  type ConsolidationAction,
} from '../core/memory/consolidate'
import { shouldForget, type MemoryRecord } from '../core/memory/model'
import { planPromotions, type PromotionPlan } from '../core/memory/promote'
import { MemoryStore } from '../core/memory/store'
import { toLedgerEntry } from './ledger'

/**
 * 记忆子系统的**接线层**：把纯逻辑（`core/memory/`）接到真实文件与时钟上。
 *
 * ── 分层 ──
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `core/memory/model.ts` | 纯函数：遗忘曲线、升级判据、强情绪豁免 |
 * | `core/memory/promote.ts` | 纯函数：按主题聚类、生成升级计划 |
 * | `core/memory/store.ts` | SQL；只依赖注入的 `DatabaseLike`，不认 Electron |
 * | `memory/service.ts` ← **本文件** | 真实文件路径、生命周期、定时维护 |
 *
 * 判定逻辑一律复用 `core/` 的纯函数，本文件**不重新实现任何规则**——
 * 否则"账本里显示的"与"维护时清理的"会用两套口径，产生
 * "看得见却突然消失"这类无法解释的行为。
 *
 * ── 为什么记忆坏掉不能让宠物起不来 ──
 *
 * 数据库在磁盘上：磁盘会满、文件会损坏、原生模块可能加载失败。
 * 这些都**不该**让一只桌宠打不开——用户要的是宠物，不是数据库。
 * 因此所有失败只记一行诊断，`#store` 保持 `null`，对外接口不抛异常，
 * 调用方拿到的都是空结果。
 *
 * ── ★ 日志纪律 ★ ──
 *
 * 诊断信息里**只允许出现"发生了什么"**，永远不出现记忆**内容**
 * （施工令 §1.2⑪：删掉的记忆不得在日志或缓存中留痕）。
 * 这条纪律由 `service.test.ts` 用一条会污染日志的输入反向验证。
 */

/** 惰性加载 `better-sqlite3` 的失败原因（诊断可见，但不致命）。 */
export interface MemoryInitFailure {
  readonly reason: string
}

export interface MemoryServiceOptions {
  /** 数据库文件路径。 */
  readonly dbPath: string
  readonly now?: () => number
  /**
   * 诊断输出。**只传"记忆不可用""删了一条"这类事实**，
   * 记忆**内容**永远不进日志。
   */
  readonly onDiagnostic?: (message: string) => void
  /** 维护周期。默认 60s；测试里可以调小。 */
  readonly maintenanceIntervalMs?: number
}

/** 记忆是否可用。 */
export interface MemoryStatus {
  readonly available: boolean
  /** 不可用时的原因。**不含记忆内容。** */
  readonly reason?: string
  /** 库里"还没忘"的记忆条数。 */
  readonly total: number
}

/** 维护周期：每分钟一次，开销可忽略（千条级全表扫描 ≈0.05ms）。 */
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000

export class MemoryService {
  readonly #dbPath: string
  readonly #now: () => number
  readonly #onDiagnostic: (message: string) => void
  readonly #maintenanceIntervalMs: number

  #store: MemoryStore | null = null
  #failure: MemoryInitFailure | null = null
  #timer: NodeJS.Timeout | null = null

  constructor(options: MemoryServiceOptions) {
    this.#dbPath = options.dbPath
    this.#now = options.now ?? Date.now
    this.#maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS
    this.#onDiagnostic =
      options.onDiagnostic ??
      ((message) => {
        console.warn(`[memory] ${message}`)
      })
  }

  /** 数据库路径（诊断用；不含记忆内容）。 */
  get dbPath(): string {
    return this.#dbPath
  }

  /**
   * 打开数据库并启动维护定时器。
   *
   * 失败**不抛异常**——记忆不可用时桌宠照常工作，只是"不记事"。
   */
  start(): MemoryStatus {
    this.#ensureStore()
    if (this.#store && !this.#timer) {
      this.#timer = setInterval(() => {
        this.runMaintenance()
      }, this.#maintenanceIntervalMs)
      // 定时器不该拖住进程退出。
      // 注意：这里是 Node 的 `setInterval`（`node:timers`），一定有 `unref`；
      // 不用可选调用，免得给"可能是浏览器定时器"留想象空间。
      this.#timer.unref()
    }
    return this.status()
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.#store?.close()
    this.#store = null
  }

  status(): MemoryStatus {
    const store = this.#store
    if (!store) {
      return {
        available: false,
        // 失败原因里可能有路径，但**不含任何记忆内容**。
        reason: this.#failure?.reason ?? '尚未初始化',
        total: 0,
      }
    }
    try {
      return { available: true, total: this.#liveRecords(store).length }
    } catch (error) {
      this.#noteFailure('统计记忆失败', error)
      return { available: true, total: 0 }
    }
  }

  // ── 写入 ──

  /**
   * 记一次情景记忆。
   *
   * `tags` 是升级为语义记忆的**聚类键**（见 `promote.ts` 的文件头），
   * 因此调用方给的标签要能代表"这是哪一类事"。
   */
  recordEpisode(content: string, tags: readonly string[], occurredAt = this.#now()): void {
    const store = this.#store
    if (!store) return
    try {
      store.addEpisodic({ content, tags, occurredAt })
    } catch (error) {
      this.#noteFailure('记情景记忆失败', error)
    }
  }

  /**
   * 记一次情感记忆。
   *
   * ⚠️ `intensity` 必须是**单次**事件的强度。库里会拒绝越界值，
   *    而那正是 ADR-0003 在代码层面的守卫（"不可累积成怨气"）。
   */
  recordEmotion(
    content: string,
    tags: readonly string[],
    emotion: Emotion,
    intensity: number,
    occurredAt = this.#now(),
  ): void {
    const store = this.#store
    if (!store) return
    try {
      store.addEmotional({ content, tags, emotion, intensity, occurredAt })
    } catch (error) {
      this.#noteFailure('记情感记忆失败', error)
    }
  }

  // ── 读取 ──

  /**
   * 检索"还没忘"的记忆（记忆账本与拼 prompt 共用）。
   *
   * 遗忘判定复用 `shouldForget`，并用**下一个维护周期之后**的时刻做判定：
   * 若按"当前时刻"判定，一条刚好越线的记忆会出现
   * "账本里有、下一分钟自己消失了"的抖动。悲观一点，账本才可信。
   */
  search(
    options: {
      query?: string
      limit?: number
      kinds?: readonly ('episodic' | 'semantic' | 'emotional')[]
    } = {},
  ): MemoryRecord[] {
    const store = this.#store
    if (!store) return []
    try {
      const records = store.search({
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(options.kinds ? { kinds: options.kinds } : {}),
        limit: options.limit ?? 200,
      })
      const horizon = this.#now() + this.#maintenanceIntervalMs
      return records.filter((record) => !shouldForget(record, horizon))
    } catch (error) {
      this.#noteFailure('检索记忆失败', error)
      return []
    }
  }

  /**
   * 账本列表（给记忆账本界面用）。
   *
   * 与 `search()` 共用同一套"还没忘"的口径，只是把内部形态转成界面契约。
   * 强度由主进程算好再送出去，界面不做任何衰减计算——否则两套口径
   * 会造出"显示着 30% 牢度却突然消失"这种像 bug 的现象。
   */
  listLedger(query?: string): MemoryLedgerEntry[] {
    const now = this.#now()
    return this.search(query ? { query } : {}).map((record) => toLedgerEntry(record, now))
  }

  // ── 删除（施工令 §1.2⑪：必须真的删除）──

  /**
   * 删一条记忆。
   *
   * 返回值只表示"删没删掉"，**不含被删内容**——否则调用方一记日志就留痕了。
   */
  forget(id: number): boolean {
    const store = this.#store
    if (!store) return false
    try {
      const removed = store.deleteMemory(id)
      if (removed) this.#onDiagnostic('删除了一条记忆')
      return removed
    } catch (error) {
      this.#noteFailure('删除记忆失败', error)
      return false
    }
  }

  /** 一键清空（记忆账本的"清空全部"）。返回删除条数。 */
  forgetAll(): number {
    const store = this.#store
    if (!store) return 0
    try {
      const removed = store.deleteAll()
      if (removed > 0) this.#onDiagnostic(`清空了 ${String(removed)} 条记忆`)
      return removed
    } catch (error) {
      this.#noteFailure('清空记忆失败', error)
      return 0
    }
  }

  /**
   * 手动"让它记住"：用户直接添加一条语义记忆。
   * `derivedFrom` 为空即表示"这是用户手写的，不是它推断出来的"。
   */
  remember(content: string, tags: readonly string[] = []): number | null {
    const store = this.#store
    if (!store) return null
    try {
      return store.addSemantic({ content, tags })
    } catch (error) {
      this.#noteFailure('写入语义记忆失败', error)
      return null
    }
  }

  // ── 维护（遗忘 + 升级）──

  /**
   * 跑一轮维护：先按遗忘曲线清理，再把反复发生的主题升级为语义记忆。
   *
   * 顺序有讲究：**先清理再升级**。反过来的话，一批已经该被遗忘的
   * 陈旧事件可能凑够阈值、把一条"用户经常加班"写进长期记忆，
   * 而它依据的证据其实早就过期了。
   *
   * 返回这一轮的动作计数，供诊断与测试使用。
   */
  runMaintenance(): { pruned: number; promoted: number } {
    const store = this.#store
    if (!store) return { pruned: 0, promoted: 0 }

    try {
      // ① 遗忘曲线：清掉已淡忘的（强情绪与语义记忆豁免，见 shouldForget）。
      const pruned = store.prune(this.#now())
      // ② 升级：反复发生的同类情景记忆 → 一条稳定事实。
      const promoted = this.#promoteRepeatedTopics(store)
      return { pruned, promoted }
    } catch (error) {
      this.#noteFailure('记忆维护失败', error)
      return { pruned: 0, promoted: 0 }
    }
  }

  #promoteRepeatedTopics(store: MemoryStore): number {
    const now = this.#now()
    // ⚠️ 候选只取"还没忘"的情景记忆。把已淡忘的算进"反复发生"，
    //    等于用证据的残影去支撑一条长期事实。
    const episodic = store
      .search({ kinds: ['episodic'], limit: Number.MAX_SAFE_INTEGER })
      .filter((record) => !shouldForget(record, now))
    if (episodic.length === 0) return 0

    const semantic = store.search({ kinds: ['semantic'], limit: Number.MAX_SAFE_INTEGER })
    const plans = planPromotions({ episodic, semantic })
    if (plans.length === 0) return 0

    let promoted = 0
    for (const plan of plans) {
      if (this.#applyPromotion(store, plan)) promoted++
    }
    return promoted
  }

  #applyPromotion(store: MemoryStore, plan: PromotionPlan): boolean {
    store.addSemantic({
      content: plan.content,
      tags: plan.tags,
      derivedFrom: plan.derivedFrom,
    })

    // 升级成功后，被吸收的情景记忆要真的删掉：
    // 留着的话同一件事会以"稳定事实 + N 条流水账"重复进 prompt。
    for (const id of plan.consumedIds) {
      store.deleteMemory(id)
    }

    // ★ 只记"升级了哪个主题、吸收了几条"，**不记内容**。
    this.#onDiagnostic(
      `把「${plan.topicKey}」升级为语义记忆（吸收 ${String(plan.consumedIds.length)} 条）`,
    )
    return true
  }

  // ── 内部 ──

  /**
   * 用**巩固决策**写入一条语义事实（阶段二的核心接线）。
   *
   * 四种结局各有明确的落地动作：
   *
   * | 决策 | 动作 |
   * |---|---|
   * | `new` | 直接写入 |
   * | `reinforce` | **不新增**，把既有那条的权重按 `reinforcedWeight` 提上去 |
   * | `supersede` | 写入新条，并把旧的标记为被取代（**不删**） |
   * | `discard` | 什么都不做 |
   *
   * ── 与 `promote.ts` 的关系 ──
   *
   * `planPromotions` 决定"要不要从情景记忆里凝练出一条事实"，
   * `planConsolidation` 决定"这条事实落到既有记忆上该怎么算"。
   * 两者串起来用：前者产出候选，后者负责合并。
   * 所以这个方法的入参是**候选事实**，而不是情景记忆。
   *
   * @returns 实际发生的事（供诊断与测试断言）
   */
  consolidateFact(content: string, tags: readonly string[]): ConsolidationAction {
    const store = this.#store
    if (!store) return 'discard'

    try {
      // 只取同层级的候选来比对：巩固是**语义记忆之间**的事。
      // 拿情景记忆一起比会让"今天加了班"这种流水账去reinforce一条稳定事实。
      const existing = store.search({ kinds: ['semantic'], limit: Number.MAX_SAFE_INTEGER })
      const plan = planConsolidation({ candidate: { content, tags }, existing })

      switch (plan.action) {
        case 'new': {
          store.addSemantic({ content, tags })
          return 'new'
        }
        case 'reinforce': {
          if (plan.targetId === undefined) return 'discard'
          const target = store.get(plan.targetId)
          if (!target) return 'discard'
          store.setWeight(plan.targetId, reinforcedWeight(target.weight))
          return 'reinforce'
        }
        case 'supersede': {
          const newId = store.addSemantic({ content, tags })
          if (plan.targetId !== undefined) store.supersede(plan.targetId, newId)
          return 'supersede'
        }
        default:
          return 'discard'
      }
    } catch (error) {
      this.#noteFailure('巩固事实失败', error)
      return 'discard'
    }
  }

  // ── 核心记忆块（常驻上下文）──

  /**
   * 取全部核心块；库里没有的块用**默认值**补齐。
   *
   * `persona` 在首次运行时写入默认值，于是"它自己是谁"这件事
   * 从第一天起就有内容——空的人设会让表达层没有可依据的语气。
   */
  listBlocks(): MemoryBlock[] {
    const store = this.#store
    if (!store) return []
    try {
      const stored = store.listBlocks()
      const kinds = new Set(stored.map((block) => block.kind))
      if (!kinds.has('persona')) {
        // 默认人设不落库也可以工作，但落库之后用户才能在账本里改写它。
        // 这里**只读不写**：读路径上产生副作用会让"打开账本"变成一次写入，
        // 而账本可能只是被看一眼。
        return [...stored, defaultPersonaBlock(this.#now())]
      }
      return stored
    } catch (error) {
      this.#noteFailure('读取核心块失败', error)
      return []
    }
  }

  /** 写一个核心块（记忆账本里编辑"它自己"/"关于你"走这里）。 */
  setBlock(kind: MemoryBlockKind, content: string): boolean {
    const store = this.#store
    if (!store) return false
    try {
      // ★ 上限在这里强制一次：界面可能绕过，而常驻内容超限会
      //   每一轮都多吃 token。`fitBlock` 按整行裁剪，不留半句。
      store.setBlock(kind, fitBlock(content.split('\n'), BLOCK_LIMITS[kind]))
      this.#onDiagnostic(`更新了核心块「${kind}」`)
      return true
    } catch (error) {
      this.#noteFailure('写入核心块失败', error)
      return false
    }
  }

  /** 删一个核心块。 */
  deleteBlock(kind: MemoryBlockKind): boolean {
    const store = this.#store
    if (!store) return false
    try {
      const removed = store.deleteBlock(kind)
      if (removed) this.#onDiagnostic(`清空了核心块「${kind}」`)
      return removed
    } catch (error) {
      this.#noteFailure('删除核心块失败', error)
      return false
    }
  }

  /**
   * 组装要进 prompt 的上下文（核心块 + 检索到的记忆）。
   *
   * 这是阶段二对外的**唯一**出口：M4/M5 的 API 层拿到它就够了，
   * 不需要知道内部有四层记忆、有巩固策略、有双时间字段。
   */
  composeContextForPrompt(options: { now: NowBlockInput; recalledLimit?: number }): string {
    const recalled = this.search({ limit: options.recalledLimit ?? 10 }).map((r) => r.content)
    return composeContext({
      blocks: [
        ...this.listBlocks().filter((block) => block.kind !== 'now'),
        { kind: 'now', content: composeNowBlock(options.now), updatedAt: this.#now() },
      ],
      recalled,
      ...(options.recalledLimit !== undefined ? { recalledLimit: options.recalledLimit } : {}),
    })
  }

  /** 库里"还没忘"的记忆（含 horizon 余量，口径与 `search` 一致）。 */
  #liveRecords(store: MemoryStore): MemoryRecord[] {
    const horizon = this.#now() + this.#maintenanceIntervalMs
    return store
      .search({ limit: Number.MAX_SAFE_INTEGER })
      .filter((record) => !shouldForget(record, horizon))
  }

  #ensureStore(): void {
    if (this.#store) return
    try {
      mkdirSync(dirname(this.#dbPath), { recursive: true })
      this.#store = new MemoryStore(new Database(this.#dbPath), { now: this.#now })
      this.#failure = null
    } catch (error) {
      this.#store = null
      this.#failure = { reason: error instanceof Error ? error.message : String(error) }
      this.#onDiagnostic(`记忆不可用（宠物照常工作，只是不记事）：${this.#failure.reason}`)
    }
  }

  #noteFailure(what: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.#onDiagnostic(`${what}：${message}`)
  }
}
