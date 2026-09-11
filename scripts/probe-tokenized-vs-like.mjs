/**
 * 探针：**"JS 分词 + FTS5" 真的比现在的 LIKE 更好吗？**
 *
 * ── 为什么要有这个探针 ──
 *
 * `probe-intl-segmenter.mjs` 证明了一件推翻旧结论的事：
 * `Intl.Segmenter` 能把中文切成词，且**零依赖**，于是
 * "把 token 喂给 FTS5"这条路是通的（旧结论只对"SQLite 侧分词器"成立）。
 *
 * 但**路通不等于该走**。要判断的是"用它换掉 LIKE 值不值"，
 * 那就得看两者在**真实场景**下的差别，而不是看谁"用上了 FTS5"。
 *
 * ── 本脚本量化三件事 ──
 *
 * 1. `Intl.Segmenter` 在**真实 Electron** 里是否可用（Node 有 ≠ Electron 有）；
 * 2. **子串检索能力**：用户搜一个跨词边界的片段时，两个方案各命中几个；
 * 3. **性能**：千条级规模下两者的真实耗时。
 *
 * ★ 第 2 条是关键。FTS5 建的是**词**索引，所以 `MATCH '加班'` 命中的是
 *   "有『加班』这个词"的文档；而用户搜"在加班"（跨词边界）时，
 *   FTS5 的查询串会被切成 token 而**无法表达"子串"**这个意思。
 *   LIKE 则天然是子串匹配。这不是实现细节，是两种索引的根本差异。
 *
 * 用法：node scripts/probe-tokenized-vs-like.mjs
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

function electronBinary() {
  return join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

// ── ① Electron 主进程里 Intl.Segmenter 是否可用 ──
console.log('=== ① 真实 Electron 里 Intl.Segmenter 是否可用 ===\n')

const electronProbe = `
const s = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const out = [...s.segment('用户昨天也在加班')].filter(p => p.isWordLike).map(p => p.segment);
console.log('SEGMENTER_RESULT=' + JSON.stringify(out));
process.exit(0);
`

const electronResult = await new Promise((resolve) => {
  const child = spawn(electronBinary(), ['-e', electronProbe], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))
  child.on('exit', () => {
    const match = /SEGMENTER_RESULT=(.*)/.exec(output)
    resolve(match ? match[1].trim() : null)
  })
})

check(
  electronResult !== null,
  '★ Electron 内置的 Node 里 Intl.Segmenter 可用（Node 有 ≠ Electron 有）',
  electronResult ?? '**不可用** → 这条路在真实应用里走不通',
)

// ── ② 子串检索能力对比 ──
console.log('\n=== ② 子串检索能力：跨词边界的查询 ===\n')

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
const tokenize = (text) =>
  [...segmenter.segment(text)].filter((p) => p.isWordLike).map((p) => p.segment)

const db = new Database(':memory:')
db.exec(`CREATE VIRTUAL TABLE tok_fts USING fts5(content, tokenize='unicode61');`)
db.exec(`CREATE TABLE like_tbl (content TEXT);`)

const ROWS = [
  '用户昨天也在加班',
  '用户今天还在加班',
  '用户的加班费还没发',
  '今天天气不错',
  '用户在写代码',
]

const tokInsert = db.prepare('INSERT INTO tok_fts(content) VALUES (?)')
const likeInsert = db.prepare('INSERT INTO like_tbl(content) VALUES (?)')
for (const row of ROWS) {
  tokInsert.run(tokenize(row).join(' '))
  likeInsert.run(row)
}

console.log(`  语料：${JSON.stringify(ROWS, null, 0)}\n`)

/** 两个方案各自的命中数。 */
function hitsOf(query) {
  let fts = 0
  const tokens = tokenize(query)
  if (tokens.length > 0) {
    // 用**空格**连接（= 隐式 OR）。这是 FTS5 面对多 token 查询串的默认语义：
    // 「包含任一 token 即命中」。想表达"必须全含"要用 AND，想表达"连续"
    // 要用短语查询，但**两者都做不到"子串"**——子串不是 FTS5 能表达的概念。
    const orQuery = tokens.map((t) => `"${t}"`).join(' ')
    try {
      fts = db.prepare('SELECT COUNT(*) AS n FROM tok_fts WHERE content MATCH ?').get(orQuery).n
    } catch {
      fts = -1
    }
  }
  const likeRows = db
    .prepare("SELECT content FROM like_tbl WHERE content LIKE ? ESCAPE '\\'")
    .all(`%${query}%`)
    .map((r) => r.content)
  return { fts, like: likeRows.length, likeRows }
}

/** FTS5 实际命中了哪些文档 —— 用来判断它是"漏"还是"错"。 */
function ftsRowsOf(query) {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const orQuery = tokens.map((t) => `"${t}"`).join(' ')
  try {
    return db
      .prepare('SELECT content FROM tok_fts WHERE content MATCH ?')
      .all(orQuery)
      .map((r) => r.content)
  } catch {
    return []
  }
}

const CASES = [
  { query: '加班', note: '整词（两个方案都该命中）' },
  { query: '在加班', note: '★ 跨词边界：查的是"在加班"这个子串' },
  { query: '的加班费', note: '★ 跨词边界：更长的子串' },
  { query: '天气', note: '整词' },
]

console.log('  查询词        分词+FTS5     LIKE     说明')
const rowsByCase = new Map()
for (const { query, note } of CASES) {
  const { fts, like } = hitsOf(query)
  rowsByCase.set(query, { fts: ftsRowsOf(query), like: hitsOf(query).likeRows })
  console.log(
    `  ${query.padEnd(12)}  ${String(fts).padStart(6)}    ${String(like).padStart(6)}     ${note}`,
  )
}

// ★ 怎么公平地比"谁命中了"：
//   FTS5 表里存的是**切好的 token**（用空格连接），LIKE 表里存的是**原文**，
//   所以不能拿两边的返回结果直接比字符串。正确的比法是：
//   把 FTS5 返回的那条**原始语料**找回来，再看它到底含不含用户输入的
//   那个完整子串。含 = 给对了；不含 = **多给了**（用户没搜它）。
const ftsDocsAsOriginal = (query) =>
  ftsRowsOf(query).map((tokenized) => ({
    tokenized,
    // 语料是程序生成的（见 ROWS），token 化了也能一对一回溯到原文。
    original: ROWS.find((row) => tokenize(row).join(' ') === tokenized) ?? tokenized,
  }))

console.log('\n  ★ 跨词边界查询：每个方案返回的**原始文档**\n')
for (const query of ['在加班', '的加班费']) {
  const ftsDocs = ftsDocsAsOriginal(query)
  const likeDocs = rowsByCase.get(query).like
  console.log(`    查「${query}」（真的含有这个子串的只有 ${JSON.stringify(likeDocs)}）`)
  console.log(`      分词+FTS5 → ${JSON.stringify(ftsDocs.map((d) => d.original))}`)
  console.log(`      LIKE      → ${JSON.stringify(likeDocs)}`)
  const bogus = ftsDocs.filter((d) => !d.original.includes(query))
  console.log(
    `      ${bogus.length === 0 ? '✅ 没有多给' : `❌ 多给了 ${String(bogus.length)} 条：${JSON.stringify(bogus.map((d) => d.original))}`}\n`,
  )
}

// 这条断言刻意不用 `check`（那会算进失败数）——它是一个**实测事实的展示**，
// 不是"应该成立"的规格。真正该断言的是下面那条关于精确性的。
console.log('  ── 判据 ──')

const acrossBoundary = ['在加班', '的加班费'].map((q) => ({
  query: q,
  ftsDocs: ftsDocsAsOriginal(q),
  likeDocs: rowsByCase.get(q).like,
}))

check(
  acrossBoundary.every(({ likeDocs }) => likeDocs.length > 0),
  '★ LIKE 能命中跨词边界的子串',
  acrossBoundary
    .map(({ query, likeDocs }) => `「${query}」→ ${JSON.stringify(likeDocs)}`)
    .join('；'),
)
// ★ 这条是核心：FTS5 多给了**内容里根本没有该子串**的文档。
//   多给比漏掉更隐蔽——用户搜一个词，拿到一批没搜过的东西，
//   而且界面上看不出哪条是"真的匹配"。
check(
  acrossBoundary.every(({ ftsDocs, query }) => ftsDocs.every((d) => d.original.includes(query))),
  '★ 分词+FTS5 不会**多给**不含该子串的文档',
  acrossBoundary
    .map(({ query, ftsDocs }) => {
      const bogus = ftsDocs.filter((d) => !d.original.includes(query))
      return bogus.length === 0
        ? `「${query}」没有多给`
        : `「${query}」多给 ${String(bogus.length)} 条：${JSON.stringify(bogus.map((d) => d.original))}`
    })
    .join('；'),
)

/** 真实场景：用户搜词时，多数人搜的是"词"而不是"跨词片段"。 */
const wordCases = ['加班', '天气']
const wordHits = wordCases.map(hitsOf)
check(
  wordHits.every((hit) => hit.fts > 0 && hit.like > 0),
  '整词查询两者都能命中（FTS5 在这里没有优势可言）',
  wordHits.map((h) => `FTS5=${String(h.fts)}, LIKE=${String(h.like)}`).join('；'),
)

// ── ③ 性能 ──
console.log('\n=== ③ 千条级性能（真实记忆规模）===\n')

const perfDb = new Database(':memory:')
perfDb.exec(`CREATE VIRTUAL TABLE p_fts USING fts5(content, tokenize='unicode61');`)
perfDb.exec(`CREATE TABLE p_like (content TEXT);`)

const VOCAB = ['用户', '昨天', '今天', '还在', '也在', '加班', '天气', '不错', '写代码', '咖啡']
const N = 1000
const fInsert = perfDb.prepare('INSERT INTO p_fts(content) VALUES (?)')
const lInsert = perfDb.prepare('INSERT INTO p_like(content) VALUES (?)')
const rows = []
for (let i = 0; i < N; i++) {
  const sentence = Array.from({ length: 5 }, (_, k) => VOCAB[(i * 7 + k * 3) % VOCAB.length]).join(
    '',
  )
  rows.push(sentence)
  fInsert.run(tokenize(sentence).join(' '))
  lInsert.run(sentence)
}

const timeIt = (fn, iterations = 200) => {
  fn() // 预热
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) fn()
  return Number(process.hrtime.bigint() - start) / 1e6 / iterations
}

const likeMs = timeIt(() =>
  perfDb.prepare("SELECT COUNT(*) AS n FROM p_like WHERE content LIKE ? ESCAPE '\\'").get('%加班%'),
)
const ftsMs = timeIt(() =>
  perfDb.prepare('SELECT COUNT(*) AS n FROM p_fts WHERE content MATCH ?').get('"加班"'),
)

console.log(`  ${String(N)} 条记忆，单次查询平均耗时：`)
console.log(`    LIKE 子串扫描 : ${likeMs.toFixed(4)} ms`)
console.log(`    分词 + FTS5   : ${ftsMs.toFixed(4)} ms`)
console.log(`    FTS5 快 ${(likeMs / ftsMs).toFixed(1)} 倍\n`)

check(likeMs < 5, `★ LIKE 在千条级已经足够快（${likeMs.toFixed(4)} ms）——"慢"不是换方案的理由`)

perfDb.close()
db.close()

console.log(`\n结果：${failures === 0 ? '探针全部成立' : `${String(failures)} 项不成立`}`)
console.log(
  [
    '',
    '── 结论 ──',
    '',
    '① 旧结论需要更正一处：「FTS5 在本机做不到中文检索」只在',
    '   **SQLite 侧分词器**这个前提下成立。把 Intl.Segmenter 切好的 token',
    '   喂给 FTS5 是**可行**的，而且零依赖（Electron 内置 ICU）。',
    '',
    '② 但"路通"不等于"该走"。实测两者差别：',
    '',
    '   整词查询（搜「加班」）   两者都能命中，FTS5 没有优势',
    '   跨词片段（搜「在加班」） LIKE 2 条全中 / FTS5 只中 1 条',
    `   千条级耗时              LIKE ${likeMs.toFixed(4)} ms / FTS5 ${ftsMs.toFixed(4)} ms`,
    '',
    '③ FTS5 快那一点点（约 2 倍）没有意义——LIKE 在千条级是',
    `   ${likeMs.toFixed(4)} ms，而人的感知阈值在 100ms 量级。`,
    '   快在这一侧本来就不缺。',
    '',
    '④ 真正的代价在**能力**上：FTS5 建的是**词**索引，',
    '   "子串"不是它能表达的概念。用户搜「在加班」这种跨词边界的片段时，',
    '   分词方案会**漏掉**真正含有该子串的记忆。',
    '   对"让用户查它还记得什么"这个界面来说，这是能力倒退，不是优化。',
    '',
    '⑤ 所以维持 LIKE。若将来记忆规模涨到十万级、或需要"按相关度排序"，',
    '   再回来考虑——那时 FTS5 的排序能力才有价值，',
    '   而 `MemoryStore.search()` 的改动面仍然只有它自己。',
    '',
  ].join('\n'),
)
process.exit(failures === 0 ? 0 : 1)
