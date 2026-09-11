/**
 * 记忆账本的端到端验证 + 截图（施工令 §5 M3：账本"可见、可删、可一键清空"）。
 *
 * ── 为什么必须端到端 ──
 *
 * 账本要证明的东西全都跨进程：界面点一下 → preload → IPC → 主进程 →
 * SQLite → 再回到界面。单测只覆盖得到最里面那一层 SQL。
 * 而"点了忘掉，数据库里真的没了"这件事，只有把这几层串起来才算数。
 *
 * ── 做法 ──
 *
 * 用 `XIAOQI_OPEN_LEDGER_MS` 让应用自己打开账本窗口（走的正是托盘菜单
 * 调的同一个 `openLedger()`），再用 CDP 连上账本页面，调用**真实的
 * `window.xiaoqi` 桥**完成增删查，并逐项核对：
 *
 * 1. 账本页面真的渲染了（不是白屏），界面也真的把数据画了出来；
 * 2. 手动"让它记住"能写进去、能查到（含中文 2 字子串检索）；
 * 3. 走界面调用 `forgetMemory` 之后，**数据库文件里扫不到那段原文**
 *    （§1.2⑪ 的硬约束在端到端路径上仍然成立），并带**对照组**；
 * 4. `forgetAllMemories` 之后库与文件都干净；
 * 5. 主进程日志里没有出现任何记忆原文；
 * 6. 截图存到 `docs/evidence/runtime/ledger/`。
 *
 * ★ 全程用 `XIAOQI_MEMORY_DB` 指向临时库，**绝不碰用户的真实记忆**。
 *
 * 用法：node scripts/verify-ledger.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connectCdp, delay, launchApp } from './cdp.mjs'

const workDir = mkdtempSync(join(tmpdir(), 'xiaoqi-ledger-'))
const dbPath = join(workDir, 'memory.db')
const shotDir = join(process.cwd(), 'docs', 'evidence', 'runtime', 'ledger')
const debugPort = 9899

/** 写进去再删掉的那条。用独一无二的串，便于在文件里精确搜索。 */
const DOOMED = '这条要被删掉的独有标记 ZZDELETEMEZZ'
/** 留着不删的对照条，用来证明"扫不到"不是因为扫描方法无效。 */
const KEPT = '这条要留着当对照 ZZCONTROLZZ'

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

const contains = (buffer, text) => buffer.includes(Buffer.from(text, 'utf8'))

console.log(`临时数据库：${dbPath}\n`)

const { child, logs, browserUrl } = launchApp({
  port: debugPort,
  env: {
    // ★ 临时库，绝不碰用户真实记忆。
    XIAOQI_MEMORY_DB: dbPath,
    XIAOQI_DEBUG_STATE: '0',
    // 让应用自己打开账本（与托盘菜单同一条代码路径）。
    XIAOQI_OPEN_LEDGER_MS: '2500',
    // 留够时间跑完整个验证。
    XIAOQI_KEEP_OPEN_MS: '60000',
  },
})

let cdp = null
try {
  const url = await Promise.race([
    browserUrl,
    delay(25_000).then(() => {
      throw new Error('等待 DevTools 端点超时')
    }),
  ])

  cdp = await connectCdp(url, 'ledger.html')
  console.log(`账本页面：${cdp.target.url}\n`)

  // 等 React 挂载 + 首次拉取完成。
  await delay(1500)

  // ── ① 页面真的渲染了 ──
  const title = await cdp.evaluate('document.querySelector(".ledger__title")?.textContent ?? ""')
  check(title === '小奇记得什么', '账本页面渲染成功（标题正确）', `标题：${JSON.stringify(title)}`)

  check(
    await cdp.evaluate(
      'typeof window.xiaoqi?.listMemories === "function" && typeof window.xiaoqi?.forgetMemory === "function"',
    ),
    'preload 桥暴露了记忆账本通道',
  )

  // ── ② 手动"让它记住" ──
  const doomedId = await cdp.evaluate(`window.xiaoqi.rememberFact(${JSON.stringify(DOOMED)})`)
  const keptId = await cdp.evaluate(`window.xiaoqi.rememberFact(${JSON.stringify(KEPT)})`)
  check(
    typeof doomedId === 'number' && typeof keptId === 'number',
    '"让它记住"两条都写入了',
    `id = ${String(doomedId)}, ${String(keptId)}`,
  )

  const listed = await cdp.evaluate('window.xiaoqi.listMemories().then((r) => r.length)')
  check(listed === 2, '账本里能读到这两条', `条数 = ${String(listed)}`)

  // ── ③ 删除前：原文**在**文件里（先证明它确实落盘了，否则后面的"没了"没有意义）──
  const beforeBytes = readFileSync(dbPath)
  check(contains(beforeBytes, DOOMED), '删除前：原文在数据库文件里**找得到**（确实落盘了）')

  // ── ④ 界面真的把数据画出来了（不只是 IPC 通了）──
  //
  // ⚠️ 这里必须用 `HTMLInputElement.prototype` 上的**原生 value setter**。
  //    直接 `input.value = x` 然后派发 `input` 事件是**不行的**：
  //    React 在 value setter 上装了追踪器，赋值时就把"最近的值"记成了 x，
  //    于是它认为值没变、不重渲染。这是 React 受控输入测试里最常踩的坑，
  //    踩了之后的表象是"界面没更新"，很容易误判成组件有 bug。
  const typeSearch = (text) =>
    cdp.evaluate(`(() => {
      const el = document.querySelector('.field--search')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

  /** 点界面上的刷新按钮（真实点击路径，不是直接调 IPC）。 */
  const clickRefresh = () =>
    cdp.evaluate(`(() => {
      const btn = document.querySelector('[aria-label="重新读取记忆列表"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)

  /** 轮询等界面达到期望的卡片数，避免依赖固定的 sleep 时长。 */
  const waitForCards = async (expected, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    let count = -1
    while (Date.now() < deadline) {
      count = await cdp.evaluate('document.querySelectorAll(".card").length')
      if (count === expected) return count
      await delay(250)
    }
    return count
  }

  check((await clickRefresh()) === true, '界面上有刷新按钮，点击成功（真实点击路径）')
  check((await waitForCards(2)) === 2, '界面真的把这两条画成了卡片（点刷新后）')

  // ── ⑤ 中文 2 字子串检索：走**界面输入**，端到端再验一次 ──
  //
  // 这条同时证明两件事：中文子串检索在端到端路径上可用
  // （FTS5 做不到的那条），以及搜索框真的驱动了列表。
  await typeSearch('对照')
  const hitCount = await waitForCards(1)
  const hitText = await cdp.evaluate(
    'Array.from(document.querySelectorAll(".card__content")).map((e) => e.textContent).join("|")',
  )
  check(
    hitCount === 1 && hitText === KEPT,
    '★ 端到端的中文 2 字子串检索命中（走界面搜索框）',
    `卡片数 ${String(hitCount)}，内容 ${JSON.stringify(hitText)}`,
  )

  // 清空搜索并刷新，让截图里有两条内容。
  await typeSearch('')
  await clickRefresh()
  await waitForCards(2)

  // ── ⑥ 截图 ──
  mkdirSync(shotDir, { recursive: true })
  const shotPath = join(shotDir, 'ledger.png')
  writeFileSync(shotPath, Buffer.from(await cdp.screenshot(), 'base64'))
  check(true, '账本截图已保存', shotPath)

  // ── ⑥ 删掉一条，并确认数据库里真的没了 ──
  const removed = await cdp.evaluate(`window.xiaoqi.forgetMemory(${String(doomedId)})`)
  check(removed === true, 'forgetMemory 返回 true（真的删掉了，不是打标记）')

  const afterBytes = readFileSync(dbPath)
  check(
    !contains(afterBytes, DOOMED),
    '★ 删除后：原文在数据库文件里**扫不到**（§1.2⑪）',
    `已扫描 ${String(afterBytes.length)} 字节`,
  )
  // ★ 对照组：没删的必须仍在，否则上面的"扫不到"可能只是方法无效。
  check(contains(afterBytes, KEPT), '★ 对照组：未删除的那条**仍能**扫到（证明扫描有效）')

  const leftAfterForget = await cdp.evaluate('window.xiaoqi.listMemories().then((r) => r.length)')
  check(leftAfterForget === 1, '删除后账本只剩一条', `条数 = ${String(leftAfterForget)}`)

  // ── ⑦ 一键清空 ──
  const cleared = await cdp.evaluate('window.xiaoqi.forgetAllMemories()')
  check(cleared === 1, 'forgetAllMemories 返回实际删掉的条数', `删掉 ${String(cleared)} 条`)

  const finalList = await cdp.evaluate('window.xiaoqi.listMemories().then((r) => r.length)')
  check(finalList === 0, '清空后账本是空的', `条数 = ${String(finalList)}`)

  const finalBytes = readFileSync(dbPath)
  check(!contains(finalBytes, KEPT), '★ 清空后：对照条也从文件里消失了')

  // ── ⑧ 日志里不得出现记忆内容 ──
  const log = logs.join('')
  check(
    !log.includes(DOOMED) && !log.includes(KEPT),
    '★ 主进程日志里没有出现任何记忆原文',
    log.includes(DOOMED) || log.includes(KEPT) ? '**发现了原文**' : '',
  )
} catch (error) {
  check(false, '验证过程本身出错', String(error))
} finally {
  cdp?.close()
  child.kill()
  await delay(600)
  rmSync(workDir, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
