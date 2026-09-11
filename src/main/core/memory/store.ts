import { DAY_MS, shouldForget, type MemoryKind, type MemoryRecord } from './model'
import type { Emotion } from '@shared/types'

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
`

/** 打开数据库并建表。 */
export function openMemoryDatabase(db: DatabaseLike): void {
  db.exec(SCHEMA_SQL)
  // 被删内容不留在空闲页里 —— §1.2⑪ 的技术保障之一。
  // 注意这是**连接级**的 pragma，每次打开都要设。
  db.pragma('secure_delete = ON')
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
  const extra: { emotion?: Emotion; intensity?: number; derivedFrom?: number } = {}
  if (row.emotion) extra.emotion = row.emotion as Emotion
  if (row.intensity !== null) extra.intensity = row.intensity
  if (row.derived_from !== null) extra.derivedFrom = row.derived_from
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
   * 返回值只表示"删没删掉"，**不含被删内容**（否则调用方一记日志就留痕了）。
   */
  deleteMemory(id: number): boolean {
    const info = this.#db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return info.changes > 0
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
