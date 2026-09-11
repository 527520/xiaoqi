import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import type { Emotion } from '@shared/types'

import { shouldForget, type MemoryRecord } from '../core/memory/model'
import { planPromotions, type PromotionPlan } from '../core/memory/promote'
import { MemoryStore } from '../core/memory/store'

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
