/**
 * 探测：**不引入任何依赖**的前提下，中文分词能不能做到？
 *
 * ── 背景 ──
 *
 * `docs/verify-m3-fts5.md` 的结论是"FTS5 在本机做不到中文子串检索"。
 * 但那个结论依赖一个前提：**SQLite 侧没有可用的中文分词器**。
 * 本机没有 C++ 编译器（cl/gcc/clang/nmake 全无）、没有 node-gyp，
 * 所以自写原生分词器与 SQLite 扩展这两条路都堵死了。
 *
 * 于是问题变成：**能不能在 JS 侧先分好词，再把 token 喂给 FTS5？**
 * 那样就不需要 SQLite 认识中文——它只需要认识"已经切好的 token"。
 *
 * 而 Node 与 Electron 都内置 ICU，`Intl.Segmenter` 正好提供
 * **按词**切分（`granularity: 'word'`）。如果它对中文有效，
 * 就能做到：零依赖 + 真分词 + FTS5 可用。
 *
 * ── 本脚本测什么 ──
 *
 * 1. `Intl.Segmenter` 在 Node 里是否可用、中文切分结果是否合理；
 * 2. 同一段文本切成 token 后，用 FTS5 建表检索，**能不能命中 2 字词**；
 * 3. 对照：不切分直接存（现状）命中几个。
 *
 * 用法：node scripts/probe-intl-segmenter.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

// ── ① 可用性 ──
console.log('=== ① Intl.Segmenter 可用性 ===\n')
check(
  typeof Intl.Segmenter === 'function',
  'Intl.Segmenter 存在',
  typeof Intl.Segmenter === 'function' ? '' : '**不存在** → 这条路走不通',
)

if (typeof Intl.Segmenter !== 'function') {
  console.log('\n结论：本机 Node 没有 Intl.Segmenter，需要在 Electron 里再测一次。')
  process.exit(1)
}

// ── ② 中文切分质量 ──
console.log('\n=== ② 中文切分结果 ===\n')

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

/** 切出"像词"的片段（丢掉空格与标点）。 */
function tokenize(text) {
  const tokens = []
  for (const piece of segmenter.segment(text)) {
    if (piece.isWordLike) tokens.push(piece.segment)
  }
  return tokens
}

const SAMPLES = [
  '用户昨天也在加班',
  '用户，昨天：加班',
  '今天天气不错',
  '用户反复出现「overtime」这类情况',
  '我不喝咖啡',
]

for (const sample of SAMPLES) {
  console.log(`  ${JSON.stringify(sample)}\n    → ${JSON.stringify(tokenize(sample))}`)
}

// 关键判据：整句不该被当成**一个** token（那正是 unicode61 的病）。
const tokensOfLong = tokenize('用户昨天也在加班')
check(
  tokensOfLong.length > 1,
  '★ 整句被切成多个 token（不是一整块）',
  `切成 ${String(tokensOfLong.length)} 个：${JSON.stringify(tokensOfLong)}`,
)

// 关键判据：2 字词要能独立成 token —— 这是 unicode61 做不到的那件事。
check(
  tokensOfLong.includes('加班'),
  '★ 「加班」被切成了**独立的词**（unicode61 做不到）',
  tokensOfLong.includes('加班') ? '' : `实际 token：${JSON.stringify(tokensOfLong)}`,
)

// ── ③ 把 token 喂给 FTS5，看能不能检索到 ──
console.log('\n=== ③ 用切好的 token 建 FTS5 表并检索 ===\n')

const db = new Database(':memory:')

// 现状方案（对照）：整段文本原样存进 unicode61 的 FTS5 表。
db.exec(`CREATE VIRTUAL TABLE plain_fts USING fts5(content, tokenize='unicode61');`)

// 新方案：内容先由 Intl.Segmenter 切词，再用**空格**连接存进去。
// 空格是 unicode61 唯一认的分隔符，所以这样它就能正确建索引。
db.exec(`CREATE VIRTUAL TABLE seg_fts USING fts5(content, tokenize='unicode61');`)

const ROWS = ['用户昨天也在加班', '用户今天还在加班', '今天天气不错', '用户在写代码', '我不喝咖啡']

const plainInsert = db.prepare('INSERT INTO plain_fts(content) VALUES (?)')
const segInsert = db.prepare('INSERT INTO seg_fts(content) VALUES (?)')
for (const row of ROWS) {
  plainInsert.run(row)
  // 关键：token 之间用空格连接。
  segInsert.run(tokenize(row).join(' '))
}

console.log(`  写入 ${String(ROWS.length)} 条：${JSON.stringify(ROWS)}\n`)

const QUERIES = ['加班', '天气', '咖啡', '写代码', '用户']

console.log('  查询词      现状(整句存)   切成 token 后存')
let plainTotal = 0
let segTotal = 0
for (const query of QUERIES) {
  // 查询串也要按同样方式切，否则 FTS5 会把整串当成一个 token。
  const segQuery = tokenize(query).join(' ')

  // 查询本身可能语法不合法（FTS5 的查询串是一门小语言），
  // 失败记 -1 而不是 0：0 会被误读成"合法查询但没命中"。
  let plainHits
  try {
    plainHits = db.prepare('SELECT COUNT(*) AS n FROM plain_fts WHERE content MATCH ?').get(query).n
  } catch {
    plainHits = -1
  }

  let segHits
  try {
    segHits =
      segQuery.length === 0
        ? 0
        : db.prepare('SELECT COUNT(*) AS n FROM seg_fts WHERE content MATCH ?').get(segQuery).n
  } catch {
    segHits = -1
  }

  plainTotal += Math.max(0, plainHits)
  segTotal += Math.max(0, segHits)
  console.log(
    `  ${query.padEnd(10)}  ${String(plainHits).padStart(6)}          ${String(segHits).padStart(6)}`,
  )
}

console.log()
check(
  segTotal > plainTotal,
  `★ 切成 token 后命中总数大幅提升（${String(plainTotal)} → ${String(segTotal)}）`,
  `现状 ${String(plainTotal)} 命中；切词后 ${String(segTotal)} 命中`,
)
check(segTotal > 0, '★ 切词方案至少有命中（不是 0，也不是靠 LIKE 兜底）')

db.close()

console.log(`\n结果：${failures === 0 ? '探针全部成立' : `${String(failures)} 项不成立`}`)
process.exit(failures === 0 ? 0 : 1)
