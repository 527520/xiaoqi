/**
 * 在**真实 SQLite 文件**上验证记忆检索与"删除必须真的删除"。
 *
 * ── 为什么不能只靠单测 ──
 *
 * `store.test.ts` 用内存库覆盖了 SQL 契约。但有一件事只有真文件能证明：
 *
 * **删除之后，内容真的不在文件里了。**
 * 内存库关掉就没了，看不出留痕。这里会在删除后把整个 .db 文件当**二进制**
 * 扫一遍，找原文的 UTF-8 字节——这是对施工令 §1.2⑪
 * 「删掉的记忆必须真的消失，不得在日志或缓存中留痕」最直接的一次验证。
 *
 * ⚠️ 同时必须有**对照组**：如果只断言"扫不到"，那"扫描方法本身无效"
 *    也会让测试通过。所以另有一条断言要求"没删的那条必须扫得到"。
 *
 * 用法：node scripts/verify-memory-delete.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const PRIVATE_MEMO = '用户说他的密码提示是紫色小猫'
const KEPT = '用户昨天也在加班'

const workDir = mkdtempSync(join(tmpdir(), 'xiaoqi-memory-'))
const dbPath = join(workDir, 'memory.db')

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 1.0,
  emotion TEXT,
  intensity REAL,
  derived_from INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_occurred ON memories(occurred_at);
`

console.log(`数据库文件：${dbPath}\n`)

// ── ① 建库并写入 ──
{
  const db = new Database(dbPath)
  db.pragma('secure_delete = ON')
  db.exec(SCHEMA)
  const insert = db.prepare(
    `INSERT INTO memories (kind, occurred_at, content, tags, weight, emotion, intensity, derived_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = Date.now()
  insert.run('episodic', now, KEPT, 'overtime', 1, null, null, null, now)
  insert.run('episodic', now, PRIVATE_MEMO, 'private', 1, null, null, null, now)
  insert.run('episodic', now, '今天天气不错', '', 1, null, null, null, now)
  db.close()
  check(true, '写入三条记忆并关闭数据库')
}

// ── ② 重启后数据仍在 + 中文子串检索 ──
{
  const db = new Database(dbPath)
  const count = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  check(count === 3, '重启后数据仍在', `计数 = ${String(count)}`)

  const hits = db
    .prepare("SELECT content FROM memories WHERE content LIKE ? ESCAPE '\\'")
    .all('%加班%')
  check(
    hits.length === 1 && hits[0].content === KEPT,
    '中文 2 字子串检索命中（这正是 FTS5 做不到的那条）',
    JSON.stringify(hits.map((r) => r.content)),
  )
  db.close()
}

// ── ③ 删除 ──
{
  const db = new Database(dbPath)
  db.pragma('secure_delete = ON')
  const target = db.prepare('SELECT id FROM memories WHERE content = ?').get(PRIVATE_MEMO)
  check(Boolean(target), '找到要删除的那条记忆')

  const removed = db.prepare('DELETE FROM memories WHERE id = ?').run(target.id).changes
  check(removed === 1, '删除返回 1 行受影响')

  db.exec('VACUUM')
  db.close()
}

// ── ④ ★ 核心：删除后文件里不得留痕 ──
{
  check(existsSync(dbPath), '数据库文件仍存在')

  const raw = readFileSync(dbPath)

  const memoBytes = Buffer.from(PRIVATE_MEMO, 'utf8')
  const memoOffset = raw.indexOf(memoBytes)
  check(
    memoOffset === -1,
    '★ 被删记忆的原文在数据库文件里**找不到**（§1.2⑪）',
    memoOffset === -1
      ? `已扫描 ${String(raw.length)} 字节，未出现原文`
      : `**仍能搜到原文**（偏移 ${String(memoOffset)}）——说明有留痕`,
  )

  // ★ 对照组：没被删的那条必须仍能扫到。
  //   没有这条，"扫不到"可能只是因为整个扫描方法无效（假阳性）。
  const keptOffset = raw.indexOf(Buffer.from(KEPT, 'utf8'))
  check(
    keptOffset !== -1,
    '★ 对照组：未删除的记忆**仍能**在文件里找到',
    keptOffset !== -1
      ? `偏移 ${String(keptOffset)} —— 说明上面的扫描方法确实有效`
      : '未删除的记忆也扫不到 → 说明扫描方法本身无效，上一条断言不算数',
  )
}

rmSync(workDir, { recursive: true, force: true })

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
