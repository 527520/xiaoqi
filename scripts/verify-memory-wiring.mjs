/**
 * 验证**记忆子系统在真实应用里真的活着**。
 *
 * ── 为什么单测不够 ──
 *
 * `service.test.ts` 用 Node 的 vitest 跑，而应用跑在 **Electron 的 Node** 里。
 * `better-sqlite3` 是原生模块，二进制要匹配 ABI——vitest 里加载成功
 * **不证明** Electron 里加载成功（这正是施工令 §4.2 要求"真的用一次"的理由）。
 *
 * 本脚本用**临时数据库**（`XIAOQI_MEMORY_DB`）启动真实应用，然后核对：
 *
 * 1. 日志里出现「记忆已就绪」而不是「记忆不可用」→ 原生模块真的加载了；
 * 2. **应用自己**在 `%TEMP%` 下真的建出了那个 .db 文件 → 不是只打开了个句柄；
 * 3. 退出前跑的那轮维护没有报错 → 遗忘曲线与升级逻辑在真库里跑得通。
 *
 * ★ 为什么必须用临时库：用真实库会污染用户的记忆，而且脚本没法断言初始状态。
 *   顺带这也验证了 `XIAOQI_MEMORY_DB` 这个逃生舱口是好用的。
 *
 * 用法：node scripts/verify-memory-wiring.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workDir = mkdtempSync(join(tmpdir(), 'xiaoqi-wiring-'))
const dbPath = join(workDir, 'memory.db')

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

/** 启动应用、等它自己退出，返回主进程日志。 */
function runApp(keepOpenMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), ['.'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // ★ 指向临时库，绝不碰用户的真实记忆。
        XIAOQI_MEMORY_DB: dbPath,
        XIAOQI_EVIDENCE_DIR: '',
        XIAOQI_KEEP_OPEN_MS: String(keepOpenMs),
        XIAOQI_DEBUG_STATE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const logs = []
    child.stdout.on('data', (chunk) => logs.push(String(chunk)))
    child.stderr.on('data', (chunk) => logs.push(String(chunk)))

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('应用未在预期时间内退出'))
    }, keepOpenMs + 30_000)

    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ logs: logs.join(''), code })
    })
  })
}

console.log(`临时数据库：${dbPath}\n`)

const startedAt = Date.now()
const { logs, code } = await runApp(4000)
const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)

// ── ⓪ ★ 应用真的退出了 ──
//    这条不是走过场。`app.quit()` 曾经被窗口的 close 处理器整个吃掉——
//    托盘菜单点「退出小奇」只让宠物消失，进程却一直留着（托盘图标还在、
//    全局快捷键还占着）。根因是 `isQuitting` 置位写在了 `will-quit`，
//    而 Electron 的顺序是 before-quit → 关窗 → will-quit，
//    于是关窗那一刻 `isQuitting` 仍是 false，`preventDefault()` 取消了退出。
//    进程挂住时本脚本会走超时分支，所以这条断言是能真的失败的。
check(
  typeof code === 'number',
  '★ 应用在保留时间结束后**真的退出了**（app.quit 没被 close 处理器吃掉）',
  `退出码 ${String(code)}，耗时 ${String(elapsedSeconds)}s`,
)

// ── ① 原生模块在 Electron 里真的加载了 ──
check(
  logs.includes('记忆已就绪'),
  '★ 记忆子系统在真实 Electron 里就绪（原生模块 ABI 匹配）',
  logs.includes('记忆已就绪')
    ? (logs.match(/记忆已就绪[^\n]*/) ?? [''])[0].trim()
    : '日志里没有「记忆已就绪」',
)

check(
  !logs.includes('记忆不可用'),
  '没有出现「记忆不可用」降级',
  logs.includes('记忆不可用')
    ? `**降级了**：${(logs.match(/记忆不可用[^\n]*/) ?? [''])[0].trim()}`
    : '',
)

// ── ② 应用自己在临时目录建出了数据库文件 ──
check(
  existsSync(dbPath),
  '★ 应用在 XIAOQI_MEMORY_DB 指定的位置真的建出了 .db 文件',
  existsSync(dbPath) ? `大小 ${String(statSync(dbPath).size)} 字节` : '文件不存在',
)

// ── ③ 建出来的是合法的 SQLite 库（有表），不是空文件 ──
if (existsSync(dbPath)) {
  const header = readFileSync(dbPath).subarray(0, 16).toString('latin1')
  check(header.startsWith('SQLite format 3'), '文件是合法 SQLite 格式', `头部：${header.trim()}`)
}

// ── ④ 维护跑过但没报错 ──
check(
  !logs.includes('记忆维护失败'),
  '退出前那轮维护没有失败',
  logs.includes('记忆维护失败') ? (logs.match(/记忆维护失败[^\n]*/) ?? [''])[0].trim() : '',
)

// ── ⑤ ★ 日志里没有任何记忆内容（§1.2⑪ 的留痕约束）──
//    本次运行没有互动，所以正常情况下不该出现任何"用户在…时来找我玩"。
check(
  !logs.includes('来找我玩'),
  '★ 日志里没有出现任何记忆内容',
  logs.includes('来找我玩') ? '**发现了记忆原文**' : '',
)

rmSync(workDir, { recursive: true, force: true })

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
