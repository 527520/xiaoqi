/**
 * 继续查证 FTS5 与中文检索：把"我推断的"换成"我量到的"。
 *
 * 上一轮我基于"unicode61 按 Unicode 类别切分"的**推断**下了结论。
 * 但有一个实测事实与那个推断不符：`也在加班` 与 `昨天也在加班` **能**命中 trigram，
 * 而 `加班` 不能。同一套 token，凭什么一个行一个不行？
 *
 * 这个脚本逐一查证以下问题，每一条都给出可直接复现的输出：
 *
 * 1. `LIKE` 的真实大小写敏感性（我上一轮只有一条命令的输出，不足以下结论）
 * 2. FTS5 的 `unicode61` 到底怎么切中文（用 fts5vocab 逐个看）
 * 3. 为什么 trigram 下"也在加班"能中、"加班"不能
 * 4. 前缀查询 `加班*` 在两种分词器下分别是什么行为
 * 5. `LIKE` 在千条级数据上的真实性能
 * 6. 这份 SQLite 是否编译了 ICU / 是否支持自定义分词器
 *
 * 用法：node scripts/probe-fts5-deep.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const line = (s) => console.log(s)

// ────────────────────────────────────────────────────────────────────────────
line('\n=== 1. LIKE 的真实大小写敏感性 ===')
{
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t(c TEXT)')
  db.prepare('INSERT INTO t VALUES (?)').run('Hello World ABC')

  const has = (pattern) => db.prepare('SELECT 1 FROM t WHERE c LIKE ?').all(pattern).length > 0

  line(`  默认 LIKE '%abc%'  → ${has('%abc%') ? '命中（大小写不敏感）' : '不命中（大小写敏感）'}`)
  db.pragma('case_sensitive_like = ON')
  line(`  case_sensitive_like=ON 后 '%abc%' → ${has('%abc%') ? '命中' : '不命中'}`)
  db.pragma('case_sensitive_like = OFF')

  // 中文不受大小写影响，但确认一下 LIKE 与 GLOB 的差别
  db.prepare('INSERT INTO t VALUES (?)').run('用户昨天也在加班')
  line(`  中文 LIKE '%加班%' → ${has('%加班%') ? '命中' : '不命中'}`)
  line(
    `  中文 GLOB '*加班*' → ${db.prepare('SELECT 1 FROM t WHERE c GLOB ?').all('*加班*').length > 0 ? '命中' : '不命中'}`,
  )
  db.close()
}

// ────────────────────────────────────────────────────────────────────────────
line('\n=== 2. unicode61 到底怎么切中文（逐 token）===')
{
  const samples = [
    '用户昨天也在加班',
    '加班',
    '用户 昨天 加班',
    '用户，昨天：加班',
    'user 加班 123',
    'ABC加班',
  ]
  for (const sample of samples) {
    const db = new Database(':memory:')
    db.exec('CREATE VIRTUAL TABLE t USING fts5(c)')
    db.prepare('INSERT INTO t(c) VALUES (?)').run(sample)
    db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row')")
    const terms = db
      .prepare('SELECT term FROM v ORDER BY term')
      .all()
      .map((r) => r.term)
    line(
      `  ${JSON.stringify(sample).padEnd(22)} → ${String(terms.length)} 个 token: ${JSON.stringify(terms)}`,
    )
    db.close()
  }
}

// ────────────────────────────────────────────────────────────────────────────
line('\n=== 3. trigram：为什么"也在加班"能中、"加班"不能 ===')
{
  const db = new Database(':memory:')
  db.exec("CREATE VIRTUAL TABLE t USING fts5(c, tokenize='trigram')")
  db.prepare('INSERT INTO t(c) VALUES (?)').run('用户昨天也在加班')
  db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row')")
  const terms = db
    .prepare('SELECT term FROM v ORDER BY term')
    .all()
    .map((r) => r.term)
  line(`  trigram tokens: ${JSON.stringify(terms)}`)

  const q = (s) => db.prepare('SELECT 1 FROM t WHERE t MATCH ?').all(s).length
  for (const s of ['加班', '也在加班', '昨天也在加班', '也在', '昨天']) {
    line(`  MATCH ${JSON.stringify(s).padEnd(14)} → ${String(q(s))} 条`)
  }
  line('  说明：MATCH 把查询串**也按同一分词器切**，然后要求 token 集合匹配。')
  line('        "加班"切出来是 1 个 token「加班」，而正文里的 token 都是 3 字的，')
  line('        两者没有交集 → 0 条。"也在加班"切出 2 个 trigram，都在正文里 → 命中。')
  db.close()
}

// ────────────────────────────────────────────────────────────────────────────
line('\n=== 4. 前缀查询 `加班*` 在两种分词器下的行为 ===')
{
  for (const [label, opt] of [
    ['unicode61', ''],
    ['trigram', ", tokenize='trigram'"],
  ]) {
    const db = new Database(':memory:')
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(c${opt})`)
    db.prepare('INSERT INTO t(c) VALUES (?)').run('用户昨天也在加班')
    const q = (s) => {
      try {
        return db.prepare('SELECT 1 FROM t WHERE t MATCH ?').all(s).length
      } catch (e) {
        return `语法错误(${String(e).slice(0, 30)})`
      }
    }
    line(`  [${label}] MATCH '加班*'      → ${String(q('加班*'))}`)
    line(`  [${label}] MATCH '"加班" *'    → ${String(q('"加班" *'))}`)
    line(`  [${label}] MATCH '用户*'      → ${String(q('用户*'))}`)
    db.close()
  }
  line('  说明：前缀查询只能匹配**token 的开头**。默认分词器整句是 1 个 token，')
  line('        所以只有"用户昨天也在加班*"这种从整句开头开始的才算前缀。')
  line('        在句子中间出现的"加班"永远不可能被前缀查询命中。')
}

// ────────────────────────────────────────────────────────────────────────────
line('\n=== 5. LIKE 在千条级数据上的真实性能 ===')
{
  const db = new Database(':memory:')
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT, tags TEXT)')
  const insert = db.prepare('INSERT INTO notes (content, tags) VALUES (?, ?)')
  const words = ['加班', '开会', '摸鱼', '抹茶', '天气', '复盘', '改需求', '午饭', '散步', '被夸']
  const N = 5000
  const tx = db.transaction(() => {
    for (let i = 0; i < N; i++) {
      insert.run(`第${String(i)}条：用户今天${words[i % words.length]}了`, `tag${String(i % 20)}`)
    }
  })
  tx()

  const t0 = performance.now()
  const ITER = 200
  let hits = 0
  for (let i = 0; i < ITER; i++) {
    hits += db.prepare('SELECT id FROM notes WHERE content LIKE ?').all('%加班%').length
  }
  const t1 = performance.now()
  line(`  ${String(N)} 条记录，LIKE '%加班%' 全表扫描 ${String(ITER)} 次：`)
  line(
    `    总耗时 ${(t1 - t0).toFixed(1)}ms，单次 ${((t1 - t0) / ITER).toFixed(3)}ms，命中 ${String(hits)} 条`,
  )
  line('  ★ 这就是"千条级用 LIKE 会不会太慢"的直接答案。')
  db.close()
}

// ────────────────────────────────────────────────────────────────────────────
line('\n=== 6. 这份 SQLite 的分词器可选性 ===')
{
  const db = new Database(':memory:')
  line(`  SQLite 版本：${String(db.prepare('SELECT sqlite_version() AS v').get().v)}`)

  const opts = db
    .prepare('PRAGMA compile_options')
    .all()
    .map((r) => r.compile_options)
  const interesting = opts.filter((o) => /FTS|ICU|JSON|THREAD/i.test(String(o)))
  line(`  相关编译选项：${JSON.stringify(interesting)}`)
  line(
    `  是否启用 ICU 分词器：${opts.some((o) => String(o).includes('ICU')) ? '是' : '否（未编译 ICU）'}`,
  )

  // FTS5 支持哪些内置分词器
  for (const tok of ['unicode61', 'ascii', 'porter', 'trigram', 'icu']) {
    try {
      const d2 = new Database(':memory:')
      d2.exec(`CREATE VIRTUAL TABLE t USING fts5(c, tokenize='${tok}')`)
      line(`  分词器 ${tok.padEnd(10)} → 可用`)
      d2.close()
    } catch (error) {
      line(`  分词器 ${tok.padEnd(10)} → 不可用（${String(error).slice(0, 40)}）`)
    }
  }
  db.close()
}
