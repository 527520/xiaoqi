/**
 * 复核 `docs/verification.md` V1 的那个 FTS5 结论。
 *
 * V1 原文：「**FTS5 全文检索可用**：`MATCH '加班'` 命中"用户昨天也在加班"」。
 *
 * 但本项目的探测显示 `MATCH '加班'` 在默认分词器下返回 0 条。
 * 两者只能有一个对，所以这里**原样复刻 V1 的用例**再跑一次，
 * 把真实返回值打出来——包括它到底插入了什么、查询了什么。
 *
 * 目的不是"证明谁错"，而是确定记忆检索该按哪种行为实现。
 *
 * 用法：node scripts/recheck-v1-fts5.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('=== 原样复刻 verify/ V1 的用例 ===')
const db = new Database(':memory:')
db.exec('CREATE VIRTUAL TABLE docs USING fts5(content)')
db.prepare('INSERT INTO docs(content) VALUES (?)').run('用户昨天也在加班')

// V1 声称的查询
const claimed = db.prepare('SELECT content FROM docs WHERE docs MATCH ?').all('加班')
console.log(`  MATCH '加班' → ${String(claimed.length)} 条  ${JSON.stringify(claimed)}`)

check(
  claimed.length === 1,
  "V1 声称的用法（MATCH '加班'）确实能命中",
  claimed.length === 1
    ? '与 docs/verification.md 一致'
    : `**与 docs/verification.md V1 的结论不一致**：实测 ${String(claimed.length)} 条。\n` +
        '     该结论当时很可能是用**整句**去查（原句能查到原句），而不是用"加班"这个子串。',
)

// 对照：整句查询
const whole = db.prepare('SELECT content FROM docs WHERE docs MATCH ?').all('用户昨天也在加班')
check(whole.length === 1, '用整句查询能命中（这解释了 V1 为何通过）')

// 对照：1 字、2 字、3 字子串
for (const term of ['加', '加班', '昨天', '也在加班']) {
  const n = db.prepare('SELECT content FROM docs WHERE docs MATCH ?').all(term).length
  console.log(`  子串查询 ${JSON.stringify(term).padEnd(10)} → ${String(n)} 条`)
}

console.log('\n=== LIKE 对照（同一份数据）===')
for (const term of ['加', '加班', '昨天', '也在加班', '不存在的词']) {
  const n = db.prepare('SELECT content FROM docs WHERE content LIKE ?').all(`%${term}%`).length
  console.log(`  LIKE %${term}%`.padEnd(24) + ` → ${String(n)} 条`)
}

console.log('\n=== 结论 ===')
console.log('  FTS5 默认分词器：整句能查整句，**任何真子串都查不到**。')
console.log('  LIKE：1 字起就能查，且对大小写不敏感（Windows 之外也一致）。')
console.log('  记忆规模是千条级，LIKE 的全表扫描完全够用；')
console.log('  而"用 FTS5"在本机**实现不了产品要的检索**。')

db.close()
process.exit(failures === 0 ? 0 : 1)
