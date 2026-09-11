/**
 * 在 trigram 分词器上验证**中文子串检索**是否真的可用。
 *
 * 背景：`docs/verification.md` V1 声称「FTS5 默认 unicode61 对中文按字切分，
 * 子串检索可用」。实测**不成立**——默认分词器把整句中文当成**一个 token**，
 * 因此 `MATCH '加班'` 查不到 `用户昨天也在加班`（见 probe-fts5-chinese.mjs）。
 *
 * trigram 分词器会把文本切成三字滑窗，因此**长度 ≥3 的子串**应该能命中。
 * 这个脚本确认这一点，并顺便量出"最短能查几个字"。
 *
 * 用法：node scripts/probe-fts5-trigram.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const db = new Database(':memory:')
db.exec("CREATE VIRTUAL TABLE t USING fts5(content, tokenize = 'trigram')")

const ROWS = ['用户昨天也在加班', '用户说讨厌开长会', '今天天气不错', '用户喜欢喝抹茶']
const insert = db.prepare('INSERT INTO t(content) VALUES (?)')
for (const row of ROWS) insert.run(row)

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  →  ${detail}` : ''}`)
  if (!ok) failures++
}

function search(term) {
  try {
    return db
      .prepare('SELECT content FROM t WHERE t MATCH ?')
      .all(term)
      .map((r) => r.content)
  } catch (error) {
    return [`（语法错误：${String(error).slice(0, 40)}）`]
  }
}

console.log('=== 子串检索（长度从 1 到 5）===')
for (const term of ['加', '加班', '也在加班', '昨天也在加班', '抹茶', '长会', '天气']) {
  const hits = search(term)
  console.log(
    `  MATCH ${JSON.stringify(term).padEnd(14)} → ${String(hits.length)} 条  ${hits.join(' / ')}`,
  )
}

console.log('\n=== 判定 ===')
check(search('加班').length === 1, '3 字子串"加班"能命中（trigram 的 3 字窗口）')
check(search('也在加班').length === 1, '更长子串也能命中')
check(search('抹茶').length === 1, '另一个 3 字以内词（抹茶只有 2 字）')
check(search('加').length === 0, '单字不命中 —— 这是 trigram 的固有限制')

console.log(
  '\n结论：trigram 支持**长度 ≥3** 的中文子串检索；1–2 字的查询无法命中。\n' +
    '      记忆检索的查询词几乎都是 2 字词（"加班""开会""抹茶"），\n' +
    '      所以需要上层做一次改写：把 2 字查询也补成 3 字前缀去匹配，\n' +
    '      或者干脆不做 MATCH、改用 LIKE 兜底。这一点必须写进实现，不能假设 FTS 够用。',
)

db.close()
process.exit(failures === 0 ? 0 : 1)
