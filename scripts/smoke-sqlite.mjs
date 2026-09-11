/**
 * §4.2 要求的**数据库冒烟测试**：真的打开一次、真的跑一条 FTS5 查询。
 *
 * 为什么必须"真的用一次"而不是只 `require`：
 * better-sqlite3 是原生模块，`require` 成功只说明二进制能加载；
 * ABI 不匹配、FTS5 未编译进去这类问题**只在真正执行 SQL 时才暴露**。
 * 施工令 §4.2 的原话是「这是唯一能当场发现 ABI/预编译问题的方法」。
 *
 * 用法：node scripts/smoke-sqlite.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  →  ${detail}` : ''}`)
  if (!ok) failures++
}

let Database
try {
  Database = require('better-sqlite3')
  check(
    true,
    'better-sqlite3 可加载',
    `版本 ${String(Database.prototype?.constructor?.name ?? '')}`,
  )
} catch (error) {
  check(false, 'better-sqlite3 可加载', String(error))
  console.log(
    '\n若在 Electron 里失败而在 Node 里成功，说明需要 electron-rebuild；\n若两者都失败，说明预编译二进制没就位。',
  )
  process.exit(1)
}

const db = new Database(':memory:')

try {
  // FTS5 是否**编译进**了这份二进制
  db.exec('CREATE VIRTUAL TABLE t USING fts5(content)')
  check(true, 'FTS5 可用（虚表建得起来）')

  // 中文子串检索：verify V1 已确认 unicode61 对中文按字切分，子串可命中
  const insert = db.prepare('INSERT INTO t(content) VALUES (?)')
  insert.run('用户昨天也在加班')
  insert.run('今天天气不错')
  const hits = db.prepare('SELECT content FROM t WHERE t MATCH ?').all('加班')
  check(
    hits.length === 1 && hits[0].content === '用户昨天也在加班',
    'FTS5 中文子串检索命中',
    JSON.stringify(hits),
  )

  // ★ 删除必须真的删除（施工令 §1.2⑪）：删完再用原文查，必须查不到
  db.prepare('DELETE FROM t WHERE content = ?').run('用户昨天也在加班')
  const afterDelete = db.prepare('SELECT content FROM t WHERE t MATCH ?').all('加班')
  check(afterDelete.length === 0, '删除后 FTS 索引同步（查不到原文）', JSON.stringify(afterDelete))

  // secure_delete 让被删内容不留在空闲页里
  db.pragma('secure_delete = ON')
  const secure = db.pragma('secure_delete', { simple: true })
  check(secure === 1, 'secure_delete 可开启', String(secure))
} catch (error) {
  check(false, 'SQL 执行', String(error))
} finally {
  db.close()
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
