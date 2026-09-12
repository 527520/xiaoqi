/**
 * 端到端验证**记忆账本的阶段二部分**：核心块 / 历史视图 / 上下文预览。
 *
 * ── 为什么必须真跑 ──
 *
 * 这一轮新增的三样东西，每一件都有"看着像做完了、其实没接上"的失效方式：
 *
 *   - 核心块：IPC 通了但**拼 prompt 时没用兜底**，于是"它自己是谁"整段消失；
 *   - 历史视图：`search` 忘了过滤 `superseded_by`，于是**旧事实也参与回应**
 *     （两条互相矛盾的事实同时进上下文 = 有一半概率用错）；
 *   - 上下文预览：根本没有消费者，坏了没人会发现。
 *
 * 前两条单测已经钉住了判定逻辑；这里验的是**它们真的接进了应用**：
 * IPC 通道存在、账本真的渲染出这三块、像素上真的看得见。
 *
 * ── 做法 ──
 *
 * 先用一个临时库**预置数据**（含一条被取代的旧事实），再起应用并自动打开
 * 账本，然后：① 断言应用日志健康；② 用 CDP 读界面文本；
 * ③ 截图并做像素判据（非空白）。
 *
 * ★ 像素判据必须有一个**反例**：同一套统计跑在一张真正的空白图上应当失败。
 *   否则"非空白"这个判据可能对任何输入都成立，等于没测。
 *
 * 用法：node scripts/verify-ledger-blocks.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import { connectCdp, delay } from './cdp.mjs'
import { countUniqueColors, decodePng } from './lib/png.mjs'

const workDir = mkdtempSync(join(tmpdir(), 'xiaoqi-ledger-blocks-'))
const dbPath = join(workDir, 'memory.db')
const outDir = join(process.cwd(), 'docs', 'evidence', 'runtime', 'ledger')
const shotPath = join(outDir, 'ledger-phase2.png')

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

// ── ① 预置数据 ──
//
// 直接写库而不是走界面：界面只能"手动记住一条"，而我们要验的
// **被取代**这条路径在界面上做不出来（它由巩固决策产生）。
// 用真表结构写，就等于把"升级/巩固真的落成这个形态"当成既定前提，
// 而那一层由 service.test.ts 覆盖。
console.log(`临时数据库：${dbPath}`)
{
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      weight REAL NOT NULL DEFAULT 1,
      emotion TEXT,
      intensity REAL,
      derived_from INTEGER,
      superseded_by INTEGER,
      superseded_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS memory_blocks (
      kind TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  const now = Date.now()

  // 当前有效的事实（它会出现在主列表 + 上下文预览里）
  db.prepare(
    `INSERT INTO memories (kind, occurred_at, content, tags, weight) VALUES ('semantic', ?, ?, 'drink', 1)`,
  ).run(now - 60_000, '用户不喝咖啡')

  // ★ 被取代的旧事实：双时间字段的形态（新条 + 旧条指向新条）
  const oldId = db
    .prepare(
      `INSERT INTO memories (kind, occurred_at, content, tags, weight, superseded_at) VALUES ('semantic', ?, ?, 'editor', 1, ?)`,
    )
    .run(now - 3 * 86_400_000, '用户用 VSCode', now - 60_000).lastInsertRowid
  const newId = db
    .prepare(
      `INSERT INTO memories (kind, occurred_at, content, tags, weight) VALUES ('semantic', ?, ?, 'editor', 1)`,
    )
    .run(now - 30_000, '用户改用 Cursor 了').lastInsertRowid
  db.prepare(`UPDATE memories SET superseded_by = ? WHERE id = ?`).run(newId, oldId)

  // 一条情景记忆（让主列表不止有语义层）
  db.prepare(
    `INSERT INTO memories (kind, occurred_at, content, tags, weight) VALUES ('episodic', ?, ?, 'interaction,coding', 0.9)`,
  ).run(now - 10_000, '用户在「coding」时来找我玩')

  // 核心块：只写 human，**故意不写 persona** —— 要验的就是默认人设兜底
  db.prepare(`INSERT INTO memory_blocks (kind, content, updated_at) VALUES ('human', ?, ?)`).run(
    '用户是后端工程师，白天写 Go，晚上写 TypeScript。',
    now,
  )

  db.close()
  console.log('已预置：1 条当前事实 + 1 条被取代的旧事实 + 1 条情景 + human 核心块')
  console.log('（刻意不写 persona —— 要验默认人设兜底真的生效）\n')
}

// ── ② 起应用并自动打开账本 ──
const port = 9701
const child = spawn(electronBinary(), ['.', `--remote-debugging-port=${String(port)}`], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    XIAOQI_MEMORY_DB: dbPath,
    XIAOQI_EVIDENCE_DIR: '',
    XIAOQI_DEBUG_STATE: '0',
    // 启动后 1.2s 自动打开账本（与托盘菜单走同一条路径）
    XIAOQI_OPEN_LEDGER_MS: '1200',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const logs = []
child.stdout.on('data', (chunk) => logs.push(String(chunk)))
child.stderr.on('data', (chunk) => logs.push(String(chunk)))

let cdp = null
try {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline && !logs.join('').includes('记忆已就绪')) {
    await delay(250)
  }
  const logText = () => logs.join('')

  check(
    logText().includes('记忆已就绪'),
    '记忆子系统就绪（原生模块在 Electron 里真的加载了）',
    (logText().match(/记忆已就绪[^\n]*/) ?? [''])[0].trim(),
  )
  check(!logText().includes('记忆不可用'), '没有降级为「记忆不可用」')
  check(
    !logText().includes('记忆维护失败'),
    '维护没有报错',
    (logText().match(/记忆维护失败[^\n]*/) ?? [''])[0].trim(),
  )

  // ── ③ 连上账本页面 ──
  //
  // ⚠️ 必须先从 **stderr** 里抓 browser WebSocket URL：本机实测 Electron
  //    只打印 browser 端点，HTTP 的 `/json/list` 会被拒（既有脚本里记过这条）。
  //    初版这里写了个"用假 URL 反复重试"的笨办法，永远连不上。
  const match = /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+/.exec(logText())
  if (!match) throw new Error('拿不到 CDP browser WebSocket URL（应从 stderr 里抓）')
  const ledger = await connectCdp(match[0], 'ledger', { timeoutMs: 25_000 })
  console.log('\n已连上账本窗口，等待渲染…')
  await delay(2500)

  // ── ④ 读界面文本 ──
  const text = await ledger.evaluate('document.body.innerText')
  const snapshot = typeof text === 'string' ? text : ''

  const blocks = await ledger.evaluate('document.querySelectorAll(".block").length')
  check(
    Number(blocks) === 3,
    '核心块渲染出 3 个（它自己 / 关于你 / 此刻）',
    `实际 ${String(blocks)}`,
  )

  // ★ 核心块的内容在 `<textarea>` 里，而 **`innerText` 拿不到 textarea 的值**
  //   —— 那是 value 属性，不是文本节点。初版用 `innerText` 断言内容，
  //   于是把"没读到"误判成"没显示"。这里显式读 `.value`。
  const blockText = await ledger.evaluate(`
    JSON.stringify([...document.querySelectorAll('.block')].map((el) => ({
      label: el.querySelector('.block__label')?.textContent ?? '',
      value: el.querySelector('.block__editor')?.value ?? '',
      count: el.querySelector('.block__count')?.textContent ?? '',
    })))
  `)
  const blockValues = JSON.parse(blockText)
  const byLabel = Object.fromEntries(blockValues.map((b) => [b.label, b]))

  check(
    typeof byLabel['它自己']?.value === 'string' && byLabel['它自己'].value.includes('小奇'),
    '★ 默认人设兜底生效：库里没写 persona，编辑器里仍有内置人设',
    `「它自己」= ${String(byLabel['它自己']?.value ?? '').split('\n')[0]}`,
  )
  check(
    byLabel['关于你']?.value.includes('用户是后端工程师'),
    '预置的 human 核心块显示在编辑器里',
    `「关于你」= ${String(byLabel['关于你']?.value ?? '').slice(0, 30)}`,
  )
  check(
    /\d+ \/ \d+/.test(byLabel['关于你']?.count ?? ''),
    '每块都显示"已用 / 上限"（上限只有主进程一份真相）',
    `计数 = ${String(byLabel['关于你']?.count ?? '')}`,
  )
  check(snapshot.includes('用户不喝咖啡'), '当前有效的语义事实出现在主列表里')
  check(
    !snapshot.includes('用户用 VSCode'),
    '★ 被取代的旧事实**不在**主列表里（否则它会与新事实一起进上下文）',
  )
  check(snapshot.includes('它此刻带着的上下文'), '上下文预览入口存在')

  // ── ⑤ 切到历史视图，旧事实应当出现 ──
  const switched = await ledger.evaluate(`
    (() => {
      const buttons = [...document.querySelectorAll('button')]
      const target = buttons.find((b) => b.textContent && b.textContent.includes('历史'))
      if (!target) return 'no-button'
      target.click()
      return 'clicked'
    })()
  `)
  check(switched === 'clicked', '历史视图按钮可点', String(switched))
  await delay(1200)

  const historyText = await ledger.evaluate('document.body.innerText')
  const history = typeof historyText === 'string' ? historyText : ''
  check(history.includes('用户用 VSCode'), '★ 历史视图里能看到被取代的旧事实（双时间字段的可见性）')
  check(history.includes('现在信的是这一条'), '历史条目标出了"现在信的是哪条"')

  // 切回当前视图再截图，这样三块内容都在一张图里
  await ledger.evaluate(`
    (() => {
      const buttons = [...document.querySelectorAll('button')]
      const target = buttons.find((b) => b.textContent && b.textContent.includes('回到当前'))
      if (target) target.click()
      return true
    })()
  `)
  await delay(900)
  // 展开上下文预览，让截图里能看到拼装结果
  await ledger.evaluate(`
    (() => {
      const details = document.querySelector('details.preview')
      if (details) details.open = true
      return true
    })()
  `)
  await delay(700)

  // ── ★ 上下文预览的内容 ──
  //
  // ⚠️ 必须在**展开 `<details>` 之后**读：折叠状态下 `innerText` 拿不到里面的文本。
  //    初版在展开之前读，于是"没读到"被误判成"没拼出来"。
  const previewText = await ledger.evaluate(
    'document.querySelector(".preview__body")?.textContent ?? ""',
  )
  const preview = typeof previewText === 'string' ? previewText : ''
  check(
    preview.includes('【它自己】'),
    '★ 上下文预览里有「它自己」段落（默认人设真的进了 prompt 草稿）',
    preview.split('\n').slice(0, 3).join(' / '),
  )
  check(preview.includes('【关于你】'), '上下文预览里有「关于你」段落')
  check(preview.includes('用户是后端工程师'), '★ 核心块的内容真的被拼进了上下文（不是只有标题）')
  check(
    !preview.includes('用户用 VSCode'),
    '★ 被取代的旧事实**没有**进上下文（否则两条矛盾事实会同时送过去）',
  )

  // ── ⑥ 截图 + 像素判据 ──
  mkdirSync(outDir, { recursive: true })
  // 整页截图：折叠线以下的内容（记忆列表、上下文预览）也要在一张图里看到。
  const png = Buffer.from(await ledger.screenshot({ fullPage: true }), 'base64')
  writeFileSync(shotPath, png)
  const image = decodePng(png)
  const colors = countUniqueColors(image)

  console.log(
    `\n截图：${shotPath}（${String(image.width)}×${String(image.height)}，${String(png.length)} 字节）`,
  )

  check(image.width > 400 && image.height > 300, '截图尺寸合理（账本真的渲染了）')
  // 判据：画面里必须存在**足够多互不相同的颜色**。
  // 一张空白/纯色图的唯一色数会是 1，而一屏文字卡片必然远大于它。
  check(
    colors > 50,
    '★ 截图里有足够多的颜色（说明真的渲染出了内容，不是空白）',
    `唯一色数 ${String(colors)}`,
  )
  // ★ 反例：把同一条判据喂给一张纯色图，它必须失败。
  //   没有这一条的话，"唯一色数 > 50"可能对任何输入都成立，等于没测。
  const blank = { width: 200, height: 200, rgba: new Uint8Array(200 * 200 * 4).fill(255) }
  const blankColors = countUniqueColors(blank)
  check(
    blankColors <= 1 && !(blankColors > 50),
    '★ [反例] 同一条判据在纯白图上**不成立**（证明它真的能失败）',
    `纯色图唯一色数 ${String(blankColors)}`,
  )

  // ── ⑦ §1.2⑪：日志里不得出现记忆内容 ──
  check(
    !logText().includes('用户不喝咖啡') && !logText().includes('VSCode'),
    '★ 日志里没有任何记忆内容（只走界面，不走日志）',
  )
} catch (error) {
  console.error(`\n验证过程出错：${String(error)}`)
  failures++
} finally {
  cdp?.close()
  child.kill()
  await delay(800)
  rmSync(workDir, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
