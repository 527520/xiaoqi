/**
 * LIKE 能不能走索引？这决定内容字段该不该按大小写敏感建索引。
 *
 * SQLite 有一条明确的优化规则：**当 `case_sensitive_like = ON` 时，
 * `column LIKE '前缀%'` 可以使用该列上的普通索引**（B-tree 范围扫描）。
 * 默认（大小写不敏感）则一定全表扫描。
 *
 * 这对本项目有个实际影响：记忆检索的查询词都是中文，而中文**没有大小写**，
 * 所以关掉大小写不敏感对我们毫无损失，却换来"前缀查询走索引"的可能。
 *
 * 但注意：我们要的是**子串**检索（`%词%`），而**前导通配符会让任何索引失效**。
 * 所以真正的问题是：中文记忆检索到底是"子串"多还是"前缀"多？
 *
 * 用法：node scripts/probe-like-index.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const N = 20000
const words = ['加班', '开会', '摸鱼', '抹茶', '天气', '复盘', '改需求', '午饭', '散步', '被夸']

function build() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO notes (content) VALUES (?)')
  const tx = db.transaction(() => {
    for (let i = 0; i < N; i++) {
      insert.run(`第${String(i)}条：用户今天${words[i % words.length]}了`)
    }
  })
  tx()
  return db
}

function timeIt(label, fn, iter = 100) {
  // 预热一次，避免把首次的页缓存冷启动算进去
  fn()
  const t0 = performance.now()
  for (let i = 0; i < iter; i++) fn()
  const t1 = performance.now()
  console.log(`  ${label.padEnd(46)} ${((t1 - t0) / iter).toFixed(3)}ms/次`)
  return (t1 - t0) / iter
}

console.log(`\n=== 无索引，${String(N)} 条 ===`)
{
  const db = build()
  timeIt("LIKE '%加班%'（子串，必然全表）", () =>
    db.prepare("SELECT id FROM notes WHERE content LIKE '%加班%'").all(),
  )
  timeIt("LIKE '第1条%'（前缀，无索引也全表）", () =>
    db.prepare("SELECT id FROM notes WHERE content LIKE '第1条%'").all(),
  )
  db.close()
}

console.log(`\n=== 建普通索引，保持默认（大小写不敏感）===`)
{
  const db = build()
  db.exec('CREATE INDEX idx_notes_content ON notes(content)')
  timeIt("LIKE '%加班%'（子串）", () =>
    db.prepare("SELECT id FROM notes WHERE content LIKE '%加班%'").all(),
  )
  timeIt("LIKE '第1条%'（前缀）", () =>
    db.prepare("SELECT id FROM notes WHERE content LIKE '第1条%'").all(),
  )
  db.close()
}

console.log(`\n=== 建普通索引 + case_sensitive_like = ON ===`)
{
  const db = build()
  db.exec('CREATE INDEX idx_notes_content ON notes(content)')
  db.pragma('case_sensitive_like = ON')
  timeIt("LIKE '%加班%'（子串，前导通配符）", () =>
    db.prepare("SELECT id FROM notes WHERE content LIKE '%加班%'").all(),
  )
  timeIt("LIKE '第1条%'（前缀，应能走索引）", () =>
    db.prepare("SELECT id FROM notes WHERE content LIKE '第1条%'").all(),
  )
  db.close()
}

console.log(`\n=== 用 EXPLAIN QUERY PLAN 直接看有没有走索引 ===`)
{
  const db = build()
  db.exec('CREATE INDEX idx_notes_content ON notes(content)')
  const plan = (sql) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => String(r.detail))
      .join(' | ')

  db.pragma('case_sensitive_like = OFF')
  console.log('  [默认] 子串 :', plan("SELECT id FROM notes WHERE content LIKE '%加班%'"))
  console.log('  [默认] 前缀 :', plan("SELECT id FROM notes WHERE content LIKE '第1条%'"))

  db.pragma('case_sensitive_like = ON')
  console.log('  [CS]   子串 :', plan("SELECT id FROM notes WHERE content LIKE '%加班%'"))
  console.log('  [CS]   前缀 :', plan("SELECT id FROM notes WHERE content LIKE '第1条%'"))
  db.close()
}

console.log(`
=== 结论 ===
1. 中文没有大小写，所以 case_sensitive_like = ON 对本项目**没有语义损失**。
2. 但记忆检索要的是**子串**（"加班"出现在句子中间），而前导 % 会让索引失效。
   所以"走索引"这条路对子串检索**不成立**——不管怎么配 pragma。
3. 唯一能从索引获益的是"前缀查询"（词在句首），而中文句子里词几乎不在句首。
4. 所以结论是：**子串检索就是全表扫描**，问题只剩"表有多大"。
   实测见上面的数字——这才是决定该不该担心的依据。
`)
