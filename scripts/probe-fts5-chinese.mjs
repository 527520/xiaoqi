/**
 * FTS5 对中文到底怎么切词？
 *
 * `docs/verification.md` 的 V1 结论是「FTS5 默认 `unicode61` 对中文按字切分，
 * 子串检索可用」。但本项目的冒烟测试（`scripts/smoke-sqlite.mjs`）用
 * `MATCH '加班'` 去查 `用户昨天也在加班` **没命中**。
 *
 * 两者矛盾，必须查清楚——它决定记忆检索能不能用中文子串。
 * 这个脚本枚举几种可能的切词/查询方式，把真实行为打出来。
 *
 * 用法：node scripts/probe-fts5-chinese.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const SENTENCE = '用户昨天也在加班'
const QUERIES = ['加班', '"加班"', '加班*', '*加班*', '用户', '昨天', '用户昨天也在加班']

function tryTokenizer(label, options) {
  console.log(`\n=== ${label} ===`)
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(content${options ? `, ${options}` : ''})`)
    db.prepare('INSERT INTO t(content) VALUES (?)').run(SENTENCE)

    // fts5vocab 能直接看到切出来的 token —— 这比猜查询语法靠谱
    try {
      db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row')")
      const terms = db.prepare('SELECT term FROM v ORDER BY term').all()
      console.log(
        `  切出的 token（${String(terms.length)} 个）：`,
        terms.map((r) => r.term).join(' | '),
      )
    } catch (error) {
      console.log('  （fts5vocab 不可用：' + String(error) + '）')
    }

    for (const q of QUERIES) {
      try {
        const hits = db.prepare('SELECT content FROM t WHERE t MATCH ?').all(q)
        console.log(`  MATCH ${JSON.stringify(q).padEnd(24)} → ${String(hits.length)} 条`)
      } catch (error) {
        console.log(
          `  MATCH ${JSON.stringify(q).padEnd(24)} → 语法错误：${String(error).slice(0, 60)}`,
        )
      }
    }
  } catch (error) {
    console.log('  建表失败：' + String(error))
  } finally {
    db.close()
  }
}

tryTokenizer('默认（unicode61）', '')
tryTokenizer('trigram', "tokenize = 'trigram'")
tryTokenizer('unicode61 去掉分隔符分类', 'tokenize = "unicode61 remove_diacritics 0"')
