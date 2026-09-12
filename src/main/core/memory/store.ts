import { DAY_MS, shouldForget, type MemoryKind, type MemoryRecord } from './model'
import type { Emotion } from '@shared/types'

import type { MemoryBlock, MemoryBlockKind } from './blocks'

/**
 * 记忆存储 —— SQLite 读写层。
 *
 * ⚠️ 这个文件**只能在主进程里用**（`better-sqlite3` 是原生模块）。
 *    `core/` 下其它文件保持纯 TS 可单测；这里的"纯"由注入的
 *    `DatabaseLike` 接口保证——单测用一个内存实现喂它。
 *
 * ── ★ 检索为什么用 LIKE 而不是 FTS5 ★ ──
 *
 * 施工令 §5 M3 指定用 FTS5。但实测表明**在本机它实现不了中文子串检索**：
 * `unicode61` 把整句中文当成一个 token（中文没有词间空格），
 * 于是 `MATCH '加班'` 查不到「用户昨天也在加班」；trigram 也只支持 ≥3 字。
 * 详见 `docs/verify-m3-fts5.md`（6 个可复现的探测脚本）。
 *
 * 所以这里用 `LIKE '%词%'`：
 *  - 中文 1 字起就能查（FTS5 是 0 命中）；
 *  - 实测 5,000 条单次 0.240ms、20,000 条 0.917ms，千条级约 0.05ms；
 *  - 「不引入向量库」这条规格要求**仍然满足**。
 *
 * ⚠️ 同时刻意**不**给内容列建索引：`EXPLAIN QUERY PLAN` 实测证明
 *    前导通配符会让任何 B-tree 索引失效（恒为 `SCAN`），建了只是浪费写入。
 *
 * ── ★ 删除必须真的删除（施工令 §1.2⑪）★ ──
 *
 * `deleteMemory` 是**物理 DELETE**，不是软删除标记。并且：
 *  - 开启 `PRAGMA secure_delete = ON`，让被删内容不留在数据库空闲页里；
 *  - 删除路径**只记录"删了一条"**，不记录内容（否则日志就成了留痕）。
 */

/** 我们用到的那一小部分 better-sqlite3 接口（便于单测注入假实现）。 */
export interface StatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

export interface DatabaseLike {
  exec(sql: string): void
  prepare(sql: string): StatementLike
  pragma(sql: string, options?: { simple?: boolean }): unknown
  close(): void
}

/** 建表语句。集中在一处，便于核对"表结构即文档"。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,
  occurred_at  INTEGER NOT NULL,
  content      TEXT    NOT NULL,
  tags         TEXT    NOT NULL DEFAULT '',
  weight       REAL    NOT NULL DEFAULT 1.0,
  emotion      TEXT,
  intensity    REAL,
  derived_from INTEGER,
  created_at   INTEGER NOT NULL
);

-- 时间与层级是最常用的筛选维度（"最近的""还没忘的"）
CREATE INDEX IF NOT EXISTS idx_memories_occurred ON memories(occurred_at);
CREATE INDEX IF NOT EXISTS idx_memories_kind     ON memories(kind);
-- 情感记忆按情绪聚合时用
CREATE INDEX IF NOT EXISTS idx_memories_emotion  ON memories(emotion);

-- 工作记忆（当前会话；退出即清）
CREATE TABLE IF NOT EXISTS working (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 核心记忆块：**常驻上下文**，参考 Letta 的 core memory blocks。
--
-- ⚠️ 与 working 分开而不是复用：
--   - 块是**持久**的（跨会话、跨重启），working 退出即清；
--   - 块有**字符上限**（在 core/memory/blocks.ts 里管），working 没有；
--   - 两者的生命周期完全不同，塞进一张表迟早要靠一个 kind 字段硬分，
--     而那个字段会出现在每一次查询里。
CREATE TABLE IF NOT EXISTS memory_blocks (
  kind       TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/**
 * 幂等迁移：把**既有**数据库补到当前表结构。
 *
 * ── 为什么需要它，而不是只靠 `CREATE TABLE IF NOT EXISTS` ──
 *
 * `IF NOT EXISTS` 只在表**不存在**时建表；表已存在时它什么都不做，
 * 于是新加的**列**永远不会出现。用户的库是上个版本建的，
 * 不迁移的话第一次用到新列就会 `no such column`。
 *
 * ── 为什么是"查一查再补"而不是版本号 ──
 *
 * 版本号方案要维护一份版本表 + 一串按序执行的升级脚本，
 * 而本项目的迁移只有"补几列"这一种形态。用 `PRAGMA table_info`
 * 查实际存在哪些列、缺什么补什么，**天然幂等**，也不怕
 * "用户从更老的版本直接跳上来"。
 *
 * ⚠️ 绝不删列、绝不改列类型：SQLite 不支持，而本项目也不需要。
 *    需要"以前是这么认为的"这类历史时，用 `superseded_by` 表达，
 *    不是把列删掉。
 */
export function migrateMemoryDatabase(db: DatabaseLike): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map((row) => row.name),
  )

  /**
   * 双时间字段（借鉴 Zep/Graphiti）。
   *
   * 语义事实**不删除**，而是标记"被哪一条取代了"，
   * 于是"它当时是这么认为的"这条审计线索得以保留。
   *
   * ⚠️ 这**不是软删除**，两者的区别是本质的：
   *   - 软删除 = "用户点了删除，但数据还在" → 与 §1.2⑪ 直接冲突；
   *   - 被取代 = "新事实推翻了旧事实，旧事实仍是历史" → 用户没要求删。
   * 用户点"忘掉"时走 `deleteMemory()`，那是**物理删除**，
   * 并且会把取代链条上的相关条目一并删掉（见 `deleteMemory`）。
   */
  if (!columns.has('superseded_by')) {
    db.exec('ALTER TABLE memories ADD COLUMN superseded_by INTEGER')
  }
  if (!columns.has('superseded_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN superseded_at INTEGER')
  }
  // 查"某条是否已被取代"时用；被取代的条数很少，但仍值得一个索引，
  // 因为每次检索都要过滤掉它们。
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)')
}

/** 打开数据库、建表并迁移。 */
export function openMemoryDatabase(db: DatabaseLike): void {
  db.exec(SCHEMA_SQL)
  migrateMemoryDatabase(db)
  // 被删内容不留在空闲页里 —— §1.2⑪ 的技术保障之一。
  // 注意这是**连接级**的 pragma，每次打开都要设。
  db.pragma('secure_delete = ON')
}

/**
 * 读一个"迁移补上的可选列"。
 *
 * ── 为什么需要这个函数，而不是直接读属性 ──
 *
 * better-sqlite3 对**不存在的列**返回 `undefined`（而不是抛错）。
 * 但我们声明的行类型是 `number | null`，于是 TypeScript 认为
 * `!== undefined` 永不成立，lint 会把那个判断当成死代码删掉——
 * **静态类型在这里恰好是错的**："列不存在"是运行期事实。
 *
 * 用 `in` 做**存在性**判断，静态类型就无从优化掉它。
 * 这样"忘了迁移"会真的走进兜底分支，而不是悄悄通过。
 *
 * 本项目的迁移测试曾经"关掉迁移也全绿"，根因就是这个：
 * 没有任何代码真正依赖那两列，于是守卫形同虚设。
 */
function readOptionalNumber(row: object, key: string): number | undefined {
  if (!(key in row)) return undefined
  const value = (row as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : undefined
}

/** SQLite 行 → 领域对象。 */
interface MemoryRow {
  id: number
  kind: string
  occurred_at: number
  content: string
  tags: string
  weight: number
  emotion: string | null
  intensity: number | null
  derived_from: number | null
  /** 被哪一条取代；NULL = 仍然有效。迁移补上的列，见 `migrateMemoryDatabase`。 */
  superseded_by: number | null
  /** 被取代的时刻。 */
  superseded_at: number | null
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  const base: MemoryRecord = {
    id: row.id,
    kind: row.kind as MemoryKind,
    occurredAt: row.occurred_at,
    content: row.content,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    weight: row.weight,
  }
  // exactOptionalPropertyTypes 开着，所以可选字段要按需构造，
  // 不能塞 undefined 进去。
  const extra: {
    emotion?: Emotion
    intensity?: number
    derivedFrom?: number
    supersededBy?: number
    supersededAt?: number
  } = {}
  if (row.emotion) extra.emotion = row.emotion as Emotion
  if (row.intensity !== null) extra.intensity = row.intensity
  if (row.derived_from !== null) extra.derivedFrom = row.derived_from
  // ⚠️ 这两行让"忘了迁移"变成**查询期立刻报错**（no such column），
  //    而不是悄悄返回 undefined。守卫必须真的被使用才有效——
  //    本项目的迁移测试曾经在关掉迁移的情况下依然全绿，
  //    就是因为当时没有任何代码读这两列。
  // ⚠️ 用 `readOptionalNumber` 而不是 `row.superseded_by !== null` 判值。
  //
  //    better-sqlite3 对**不存在的列**返回 `undefined`。而 TypeScript 只看到
  //    我们声明的行类型（`number | null`），于是 `!== undefined` 这类判断
  //    会被 lint 判为"永不成立"并删掉——**静态类型在这里恰好是错的**，
  //    因为"列不存在"是运行期事实，不是类型事实。
  //
  //    这正是本项目踩过的坑：迁移测试一度"关掉迁移也全绿"，
  //    就是因为没有任何代码真正依赖那两列。用 `in` 做**存在性**判断，
  //    静态类型就无从把它优化掉。
  const supersededBy = readOptionalNumber(row, 'superseded_by')
  if (supersededBy !== undefined) extra.supersededBy = supersededBy
  const supersededAt = readOptionalNumber(row, 'superseded_at')
  if (supersededAt !== undefined) extra.supersededAt = supersededAt
  return { ...base, ...extra }
}

export interface AddEpisodicInput {
  readonly occurredAt: number
  readonly content: string
  readonly tags: readonly string[]
  readonly weight?: number
}

export interface AddEmotionalInput {
  readonly occurredAt: number
  readonly content: string
  readonly tags: readonly string[]
  readonly emotion: Emotion
  /** **单次**事件的强度 ∈ [0,1]。不是累积值（ADR-0003）。 */
  readonly intensity: number
}

export interface AddSemanticInput {
  readonly content: string
  readonly tags: readonly string[]
  readonly derivedFrom?: number
}

export interface SearchOptions {
  /** 关键词（子串匹配）。空则不按关键词过滤。 */
  readonly query?: string
  readonly kinds?: readonly MemoryKind[]
  readonly tags?: readonly string[]
  readonly emotion?: Emotion
  /** 只看这个时刻之后的。 */
  readonly since?: number
  readonly limit?: number
}

/**
 * 记忆库。
 *
 * 只暴露**语义化**的方法，不把 SQL 泄漏给调用方——
 * 这样"删除必须真删"这类约束只需要在一个地方保证。
 */
export class MemoryStore {
  readonly #db: DatabaseLike
  readonly #now: () => number

  constructor(db: DatabaseLike, options?: { readonly now?: () => number }) {
    this.#db = db
    this.#now = options?.now ?? Date.now
    openMemoryDatabase(db)
  }

  #insert(
    kind: MemoryKind,
    occurredAt: number,
    content: string,
    tags: readonly string[],
    weight: number,
    emotion: Emotion | null,
    intensity: number | null,
    derivedFrom: number | null,
  ): number {
    const info = this.#db
      .prepare(
        `INSERT INTO memories
           (kind, occurred_at, content, tags, weight, emotion, intensity, derived_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        occurredAt,
        content,
        tags.join(','),
        weight,
        emotion,
        intensity,
        derivedFrom,
        this.#now(),
      )
    return Number(info.lastInsertRowid)
  }

  addEpisodic(input: AddEpisodicInput): number {
    return this.#insert(
      'episodic',
      input.occurredAt,
      input.content,
      input.tags,
      input.weight ?? 1,
      null,
      null,
      null,
    )
  }

  /**
   * 加一条情感记忆。
   *
   * ⚠️ `intensity` 必须是**单次**事件强度。这里做一次范围检查——
   *    越界通常意味着调用方在做"累积"，而那正是 ADR-0003 禁止的。
   */
  addEmotional(input: AddEmotionalInput): number {
    if (!Number.isFinite(input.intensity) || input.intensity < 0 || input.intensity > 1) {
      throw new Error(
        `情感强度必须在 [0,1]，收到 ${String(input.intensity)}。` +
          `注意它应当是**单次事件**的强度，不是多次累加值（ADR-0003）。`,
      )
    }
    return this.#insert(
      'emotional',
      input.occurredAt,
      input.content,
      input.tags,
      input.intensity,
      input.emotion,
      input.intensity,
      null,
    )
  }

  addSemantic(input: AddSemanticInput): number {
    return this.#insert(
      'semantic',
      this.#now(),
      input.content,
      input.tags,
      1,
      null,
      null,
      input.derivedFrom ?? null,
    )
  }

  /**
   * 检索记忆。
   *
   * 关键词用 **子串匹配**（`LIKE '%词%'`），走全表扫描——
   * 理由与实测见文件头注释。刻意**不建**内容列索引（前导 % 让它必然失效）。
   */
  search(options: SearchOptions = {}): MemoryRecord[] {
    const where: string[] = []
    const params: unknown[] = []

    if (options.query) {
      // ESCAPE 让用户输入里的 % 与 _ 被当成字面量，
      // 否则搜 "100%" 会变成通配。
      where.push("content LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(options.query)}%`)
    }
    if (options.kinds && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => '?').join(',')})`)
      params.push(...options.kinds)
    }
    if (options.tags && options.tags.length > 0) {
      // 标签是逗号分隔的一列。用 LIKE 逐个匹配，量的规模很小。
      for (const tag of options.tags) {
        where.push("(',' || tags || ',') LIKE ?")
        params.push(`%,${escapeLike(tag)},%`)
      }
    }
    if (options.emotion) {
      where.push('emotion = ?')
      params.push(options.emotion)
    }
    if (options.since !== undefined) {
      where.push('occurred_at >= ?')
      params.push(options.since)
    }

    const sql =
      `SELECT * FROM memories` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      // 最近的优先；同刻按 id 倒序保证顺序稳定（否则测试会 flaky）
      ` ORDER BY occurred_at DESC, id DESC LIMIT ?`
    params.push(options.limit ?? 50)

    return (this.#db.prepare(sql).all(...params) as MemoryRow[]).map(rowToRecord)
  }

  /** 按 id 取一条。 */
  get(id: number): MemoryRecord | null {
    const row = this.#db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | MemoryRow
      | undefined
    return row ? rowToRecord(row) : null
  }

  /**
   * ★ 物理删除一条记忆（施工令 §1.2⑪：删掉的记忆必须真的消失）。
   *
   * 这里**不做软删除**——不加 `deleted_at` 标记、不搬到回收表。
   * 配合 `secure_delete = ON`，内容不会留在空闲页里。
   *
   * ── ★ 为什么必须连带删掉整条"取代链条" ★ ──
   *
   * 双时间字段（`superseded_by`）让"新事实推翻旧事实"时旧条被保留下来。
   * 但**用户明确要删**时必须整条链一起删，两个理由：
   *
   * ① **不留痕**：只删新的那条，旧事实的原文仍然躺在库里——
   *    用户以为删掉了、实际没有，这正是 §1.2⑪ 要防的事。
   * ② **不留悬空引用**：只删新的会剩一条"被一个已不存在的 id 取代"的记录；
   *    只删旧的会剩一条 `superseded_by` 指向空气的记录。
   *
   * 实现做**双向遍历**（向前找谁取代了它、向后找它取代了谁），
   * 并且是**迭代**而不是递归——链条长度由用户行为决定，递归有栈溢出风险。
   *
   * 返回值只表示"删没删掉"，**不含被删内容**（否则调用方一记日志就留痕了）。
   */
  deleteMemory(id: number): boolean {
    const doomed = this.#collectSupersedeChain(id)
    if (doomed.length === 0) return false

    const del = this.#db.prepare('DELETE FROM memories WHERE id = ?')
    let removed = 0
    for (const target of doomed) {
      removed += del.run(target).changes
    }
    return removed > 0
  }

  /**
   * 收集与 `id` 在同一条取代链上的全部 id（含自身）。
   *
   * 两条边都要走：`superseded_by` 指向"取代它的那一条"，
   * 反向边是"它取代了哪一条"（用 `WHERE superseded_by = ?` 查）。
   */
  #collectSupersedeChain(id: number): number[] {
    const findSuperseder = this.#db.prepare('SELECT superseded_by FROM memories WHERE id = ?')
    const findSuperseded = this.#db.prepare('SELECT id FROM memories WHERE superseded_by = ?')

    const seen = new Set<number>()
    const queue: number[] = [id]

    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined || seen.has(current)) continue
      seen.add(current)

      // 向前：谁取代了它。
      // 用 `readOptionalNumber` 的理由与 `rowToRecord` 相同——
      // 列可能因未迁移而不存在，而静态类型看不出来。
      const forward = findSuperseder.get(current)
      const superseder = forward ? readOptionalNumber(forward, 'superseded_by') : undefined
      if (superseder !== undefined) queue.push(superseder)

      // 向后：它取代了谁
      for (const row of findSuperseded.all(current) as { id: number }[]) {
        queue.push(row.id)
      }
    }

    return [...seen]
  }

  /** 一键清空（记忆账本上的"清空全部"）。 */
  deleteAll(): number {
    const info = this.#db.prepare('DELETE FROM memories').run()
    return info.changes
  }

  /**
   * 清理已遗忘的记忆（遗忘曲线落地）。
   *
   * ⚠️ 保护名单：语义记忆（稳定事实）与"强情绪"情感记忆都**不**清。
   *    判定逻辑在 `model.ts` 的 `shouldForget()`，是纯函数、有单测。
   */
  prune(now = this.#now()): number {
    const rows = this.#db.prepare('SELECT * FROM memories').all() as MemoryRow[]
    const doomed = rows.map(rowToRecord).filter((record) => shouldForget(record, now))
    if (doomed.length === 0) return 0

    const del = this.#db.prepare('DELETE FROM memories WHERE id = ?')
    let removed = 0
    for (const record of doomed) {
      removed += del.run(record.id).changes
    }
    return removed
  }

  /**
   * 改一条记忆的权重（`reinforce` 决策用它）。
   *
   * 单独一个方法而不是让调用方拼 SQL：权重的取值范围（[0,1]）
   * 只该在一个地方被夹住。越界在这里被钳住而不是抛错——
   * 触发它的只会是我们自己的算术，钳住比让整条维护流程崩掉好。
   */
  setWeight(id: number, weight: number): boolean {
    if (!Number.isFinite(weight)) return false
    const clamped = Math.min(1, Math.max(0, weight))
    const info = this.#db.prepare('UPDATE memories SET weight = ? WHERE id = ?').run(clamped, id)
    return info.changes > 0
  }

  /**
   * 用一条新事实**取代**一条旧事实（双时间字段，借鉴 Zep/Graphiti）。
   *
   * ── ⚠️ 这不是软删除，区别是本质的 ──
   *
   * | | 软删除 | 被取代（本方法） |
   * |---|---|---|
   * | 触发者 | 用户点了"忘掉" | 新事实推翻了旧事实 |
   * | 数据 | 还在，只是被查询过滤 | 还在，且**仍是历史** |
   * | 与 §1.2⑪ | **直接冲突** | 不冲突（用户没要求删） |
   *
   * 旧事实保留下来是**有意的**：它回答了"它当时是这么认为的"。
   * 若用户明确要删，走 `deleteMemory()`——那是物理删除。
   *
   * @returns 是否真的改动了行
   */
  supersede(oldId: number, newId: number, at = this.#now()): boolean {
    const info = this.#db
      .prepare('UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?')
      .run(newId, at, oldId)
    return info.changes > 0
  }

  // ── 核心记忆块（常驻上下文）──

  /**
   * 写一个核心块（存在则覆盖）。
   *
   * ⚠️ 字符上限**不在这里管**——那是 `core/memory/blocks.ts` 里
   *    `BLOCK_LIMITS` 的职责，而且拼装时还会再裁一次。
   *    存储层只负责"存下来"，不做业务校验：否则同一套规则会有两份实现。
   */
  setBlock(kind: MemoryBlockKind, content: string): void {
    this.#db
      .prepare(
        `INSERT INTO memory_blocks (kind, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(kind, content, this.#now())
  }

  /** 读一个核心块；不存在返回 null（**不返回空串**，两者语义不同）。 */
  getBlock(kind: MemoryBlockKind): MemoryBlock | null {
    const row = this.#db
      .prepare('SELECT kind, content, updated_at FROM memory_blocks WHERE kind = ?')
      .get(kind) as { kind: string; content: string; updated_at: number } | undefined
    if (!row) return null
    return { kind: row.kind as MemoryBlockKind, content: row.content, updatedAt: row.updated_at }
  }

  /** 全部核心块（按种类排序，便于稳定展示）。 */
  listBlocks(): MemoryBlock[] {
    return (
      this.#db
        .prepare('SELECT kind, content, updated_at FROM memory_blocks ORDER BY kind')
        .all() as { kind: string; content: string; updated_at: number }[]
    ).map((row) => ({
      kind: row.kind as MemoryBlockKind,
      content: row.content,
      updatedAt: row.updated_at,
    }))
  }

  /** 删一个核心块（用户清空"它自己"或"关于你"时走这里）。 */
  deleteBlock(kind: MemoryBlockKind): boolean {
    return this.#db.prepare('DELETE FROM memory_blocks WHERE kind = ?').run(kind).changes > 0
  }

  // ── 工作记忆（当前会话）──

  setWorking(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO working (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.#now())
  }

  getWorking(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM working WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  clearWorking(): void {
    this.#db.prepare('DELETE FROM working').run()
  }

  close(): void {
    this.#db.close()
  }
}

/**
 * 转义 LIKE 的通配符。
 *
 * 不做这件事的后果很具体：用户在记忆账本里搜 `100%` 会变成"以 100 开头"，
 * 搜 `_` 会匹配任意单字——**看起来像 bug，其实是没转义**。
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 供上层做"最近一天"之类的便捷窗口。 */
export function sinceDaysAgo(days: number, now = Date.now()): number {
  return now - days * DAY_MS
}
