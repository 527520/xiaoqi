/**
 * 决定记忆检索到底该怎么实现。
 *
 * 前面两次探测已经把问题定死了：
 *  - **默认 unicode61**：整句中文 = 一个 token → `MATCH '加班'` 查不到
 *    （`docs/verification.md` V1 那句"中文子串检索可用"是**错的**，
 *      当时只验了"原句能查到原句"）。
 *  - **trigram**：三字滑窗 → 长度 ≥3 的子串能命中，**2 字词仍然查不到**
 *    （"加班"本身就是一个 trigram token，内部没有滑窗）。
 *
 * 而中文里最关键的查询词恰恰大多是 2 字（加班、开会、摸鱼、抹茶）。
 * 所以"上 FTS5 就完事"是行不通的，必须选一条真正可用的路。
 *
 * 这个脚本比较三条路的**实际表现**，为决策提供依据：
 *   A. 默认 FTS5（unicode61）
 *   B. trigram FTS5
 *   C. trigram FTS5 + LIKE 兜底（短查询走 LIKE）
 *
 * 用法：node scripts/probe-fts5-strategy.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const ROWS = [
  { content: '用户昨天也在加班', tags: 'coding,overtime' },
  { content: '用户说讨厌开长会', tags: 'meeting' },
  { content: '今天天气不错', tags: '' },
  { content: '用户喜欢喝抹茶', tags: 'rest' },
]

/** 真实会出现的查询词：注意大量 2 字词。 */
const QUERIES = ['加班', '开会', '摸鱼', '抹茶', '天气', '长会', '昨天']

function build(tokenize) {
  const db = new Database(':memory:')
  db.exec(
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT, tags TEXT);
     CREATE VIRTUAL TABLE notes_fts USING fts5(content, tags, content='notes', content_rowid='id'${tokenize});
     CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
       INSERT INTO notes_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
     END;
     CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
       INSERT INTO notes_fts(notes_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
     END;`,
  )
  const insert = db.prepare('INSERT INTO notes (content, tags) VALUES (?, ?)')
  for (const row of ROWS) insert.run(row.content, row.tags)
  return db
}

function matchSearch(db, term) {
  try {
    return db
      .prepare(
        'SELECT n.content FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH ?',
      )
      .all(term)
      .map((r) => r.content)
  } catch {
    return []
  }
}

function likeSearch(db, term) {
  return db
    .prepare('SELECT content FROM notes WHERE content LIKE ? OR tags LIKE ?')
    .all(`%${term}%`, `%${term}%`)
    .map((r) => r.content)
}

/** 策略 C：短查询（<3 字）走 LIKE，长查询走 MATCH。 */
function hybridSearch(db, term) {
  return [...new Set([...matchSearch(db, term), ...(term.length < 3 ? likeSearch(db, term) : [])])]
}

function evaluate(label, search) {
  console.log(`\n=== ${label} ===`)
  let hit = 0
  let missed = []
  for (const q of QUERIES) {
    const results = search(q)
    const ok = results.length > 0
    if (ok) hit++
    else missed.push(q)
    console.log(
      `  ${ok ? '命中' : '漏掉'}  ${JSON.stringify(q).padEnd(10)} → ${results.join(' / ') || '（无）'}`,
    )
  }
  console.log(
    `  命中率：${String(hit)}/${String(QUERIES.length)}${missed.length ? `   漏掉：${missed.join('、')}` : ''}`,
  )
  return hit
}

const ftsDefault = build('')
const ftsTrigram = build(", tokenize = 'trigram'")

const a = evaluate('A. 默认 FTS5（unicode61）', (q) => matchSearch(ftsDefault, q))
const b = evaluate('B. trigram FTS5', (q) => matchSearch(ftsTrigram, q))
const c = evaluate('C. trigram + 短查询 LIKE 兜底', (q) => hybridSearch(ftsTrigram, q))
evaluate('D. 纯 LIKE（对照，不用 FTS）', (q) => likeSearch(ftsTrigram, q))

console.log('\n=== 结论 ===')
console.log(`  默认 FTS5 命中 ${String(a)}/${String(QUERIES.length)} —— 中文基本不可用`)
console.log(`  trigram 命中 ${String(b)}/${String(QUERIES.length)} —— 3 字以上可用，2 字词漏掉`)
console.log(`  混合策略命中 ${String(c)}/${String(QUERIES.length)} —— 补齐 2 字词`)

ftsDefault.close()
ftsTrigram.close()
