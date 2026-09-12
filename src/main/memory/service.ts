import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import type { Emotion, MemoryBlockView, MemoryLedgerEntry } from '@shared/types'

import {
  BLOCK_KINDS,
  BLOCK_LABELS,
  BLOCK_LIMITS,
  composeContext,
  composeNowBlock,
  defaultPersonaBlock,
  fitBlock,
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
      /**
       * 要不要包含**已被取代**的记录。默认 `'live'`。
       *
       * 默认值在 `MemoryStore.search` 里兜底，这里只是透传——
       * 但**必须**透传：账本的"历史"视图要 `'only'`，
       * 不给这条路的话，被取代的旧事实就永远看不见，
       * 而"能看见它以前认为什么"正是双时间字段存在的理由。
       */
      superseded?: 'live' | 'only' | 'all'
    } = {},
  ): MemoryRecord[] {
    const store = this.#store
    if (!store) return []
    try {
      const records = store.search({
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(options.kinds ? { kinds: options.kinds } : {}),
        ...(options.superseded ? { superseded: options.superseded } : {}),
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

  /**
   * 账本的**历史视图**：只看已被取代的旧事实。
   *
   * ── 为什么单独一个方法，而不是给 `listLedger` 加参数 ──
   *
   * 两边的默认行为必须不同，而且是**安全侧不同**：
   *   - `listLedger`（主列表）：被取代的**不出现**。用户要看的是"它现在记什么"。
   *   - `listSuperseded`（历史）：只有被取代的。
   *
   * 合成一个方法的话，调用方传错一个布尔就会让主列表混进自相矛盾的旧事实
   * ——那是我们在 `SearchOptions.superseded` 里花力气避开的同一个坑。
   */
  listSuperseded(query?: string): MemoryLedgerEntry[] {
    const now = this.#now()
    return this.search({
      ...(query ? { query } : {}),
      superseded: 'only',
    }).map((record) => toLedgerEntry(record, now))
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

    // ★ `superseded: 'live'`：只用**当前有效**的事实去做"这个主题已经记过了"
    //   的判断。把被取代的旧事实也算进来的话，一个主题会被认为"已覆盖"，
    //   于是新的同类证据永远升不上来——而被取代恰恰说明旧事实已经不作数了。
    const semantic = store.search({
      kinds: ['semantic'],
      superseded: 'live',
      limit: Number.MAX_SAFE_INTEGER,
    })
    const plans = planPromotions({ episodic, semantic })
    if (plans.length === 0) return 0

    let promoted = 0
    for (const plan of plans) {
      if (this.#applyPromotion(store, plan)) promoted++
    }
    return promoted
  }

  /**
   * 落一条升级计划。
   *
   * ── ★ 为什么这里**必须**走 `consolidateFact`，而不是直接 `addSemantic` ★ ──
   *
   * 初版是直接写入的。那样有一个真实的坏结果：`planPromotions` 只知道
   * "这个主题**没有**语义记忆"，它不看既有事实**内容**。于是同一件事
   * 被反复凝练时会攒出好几条几乎一样的事实，各占一行、同时进 prompt。
   *
   * `consolidateFact` 给出的四选一决策正好补上这一段：
   *   - `new`：确实没有 → 写入；
   *   - `reinforce`：同主题且不矛盾 → **不新增**，加强既有那条；
   *   - `supersede`：同主题但**矛盾** → 写新条 + 把旧条标为被取代（不删）；
   *   - `discard`：几乎完全重复 → 什么都不做。
   *
   * ── ★ 为什么"吸收掉的情景记忆"要**无条件**删，与决策无关 ★ ──
   *
   * `planPromotions` 的 `coveredTopics` 门会挡住"已有同主题就不要重复升级"，
   * 所以走到这里时该主题**从来没有**过语义事实 —— 也就是说决策只可能是
   * `new`（正常情况下）。但门是按**主题键**挡的，而巩固还要看内容是否矛盾：
   * 一个主题下完全可能出现"用户喝咖啡"→"用户戒咖啡了"这种真矛盾。
   *
   * 关键在于：**这些情景记忆已经被这条事实吸收了**。它们不能留在库里，
   * 否则同一条证据会在下一轮再次凑够阈值、再次尝试升级，无限循环。
   * 事实写没写成不该决定证据留不留。
   */
  #applyPromotion(store: MemoryStore, plan: PromotionPlan): boolean {
    // `derivedFrom` 必须带上：账本靠它回答"你为什么记得这个"。
    const action = this.consolidateFact(plan.content, plan.tags, plan.derivedFrom)

    // 升级成功后，被吸收的情景记忆要真的删掉：
    // 留着的话同一件事会以"稳定事实 + N 条流水账"重复进 prompt。
    for (const id of plan.consumedIds) {
      store.deleteMemory(id)
    }

    // ★ 只记"升级了哪个主题、吸收了几条、落成了哪种结局"，**不记内容**。
    this.#onDiagnostic(
      `把「${plan.topicKey}」升级为语义记忆（${action}，吸收 ${String(plan.consumedIds.length)} 条）`,
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
   * @param derivedFrom 这条事实是从哪条情景记忆凝练出来的。
   *        ⚠️ 传进来就**必须**存下去：账本靠它回答"你为什么记得这个"
   *        （业内的说法是 provenance）。丢了它，账本就只能显示一句
   *        没有来由的结论，用户无法判断该不该信。
   *        用户手动写的事实没有来源，那时不传。
   * @returns 实际发生的事（供诊断与测试断言）
   */
  consolidateFact(
    content: string,
    tags: readonly string[],
    derivedFrom?: number,
  ): ConsolidationAction {
    const store = this.#store
    if (!store) return 'discard'

    try {
      // 只取同层级的候选来比对：巩固是**语义记忆之间**的事。
      // 拿情景记忆一起比会让"今天加了班"这种流水账去reinforce一条稳定事实。
      //
      // ★ `superseded: 'live'`：已被取代的旧事实不参与比对。
      //   否则"用户喝咖啡"（已被取代）会让"用户不喝咖啡"再次被判为
      //   supersede，把链条越接越长，而每一条历史都指向下一条。
      const existing = store.search({
        kinds: ['semantic'],
        superseded: 'live',
        limit: Number.MAX_SAFE_INTEGER,
      })
      const plan = planConsolidation({ candidate: { content, tags }, existing })

      switch (plan.action) {
        case 'new': {
          store.addSemantic({
            content,
            tags,
            ...(derivedFrom !== undefined ? { derivedFrom } : {}),
          })
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
          const newId = store.addSemantic({
            content,
            tags,
            ...(derivedFrom !== undefined ? { derivedFrom } : {}),
          })
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
   * 取全部核心块（**唯一入口**，返回值直接就是界面契约）。
   *
   * ── 为什么只有这一个方法，而不是"内部块 + 视图层"两个 ──
   *
   * 初版有两个（`listBlocks` 给内部、`listBlockViews` 给界面），
   * 于是 `composeContextForPrompt` 走的是**没有兜底**的那一个：
   * 库里还没有 `persona` 时它拿到空数组，"它自己是谁"这一段整段消失
   * —— 而默认人设本来就是为了"从第一天起就有语气可用"才存在的。
   * 两个方法只差一层映射，却让最容易漏的那条路走了错的那个。
   *
   * 合成一个之后，`isDefault` 与 `limit` 对**所有**调用方都在，
   * 兜底逻辑也只有一处。
   *
   * `persona` 缺失时用默认内容补齐：它让"它自己是谁"从第一天起就有内容。
   * 这里**只读不写**——读路径上产生副作用会让"打开账本"变成一次写入，
   * 而账本可能只是被看一眼。
   */
  listBlocks(): MemoryBlockView[] {
    const store = this.#store
    if (!store) return []
    try {
      const stored = new Map(store.listBlocks().map((block) => [block.kind, block]))
      // 默认内容用**与落库同一个函数**算出来，不手抄一份字符串——
      // 手抄的那份会在默认人设被改写之后悄悄失配，于是"是否默认"永远判错。
      const defaultPersona = defaultPersonaBlock(this.#now()).content
      const now = this.#now()

      return BLOCK_KINDS.map((kind) => {
        const block = stored.get(kind)
        // persona 缺失 → 用默认内容顶上；human / now 空着就是真的空，
        // 不给它们编造内容（那会变成"它记得一些你没说过的事"）。
        const content = block?.content ?? (kind === 'persona' ? defaultPersona : '')
        return {
          kind,
          label: BLOCK_LABELS[kind],
          content,
          limit: BLOCK_LIMITS[kind],
          updatedAt: block?.updatedAt ?? now,
          isDefault: kind === 'persona' && content === defaultPersona,
        }
      })
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
