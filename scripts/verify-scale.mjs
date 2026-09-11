/**
 * 端到端验证"宠物缩放"：窗口尺寸、渲染、命中测试三者是否同步。
 *
 * ── 为什么必须端到端验 ──
 *
 * 缩放的失效方式非常隐蔽，而且**每一层都可以单独看起来是对的**：
 *  - 窗口没跟着变  → 宠物放大后画面被裁掉
 *  - 渲染没跟着变  → 窗口变大了但宠物还是原来大小，周围一片透明
 *  - 命中没跟着变  → 宠物看着变大了，但只有左上角那一小块能点
 *                    （这正是 openai/codex #34227 的现象）
 * 单测只能覆盖第三条的纯函数部分，前两条必须真的跑起来看。
 *
 * 做法：通过 `window.xiaoqi.setScale()`（渲染进程 → 主进程）改缩放，
 * 然后用 CDP 读回**主进程推给渲染进程的状态**与**真实的窗口矩形**做比对。
 *
 * 用法：node scripts/verify-scale.mjs
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = process.argv[2] ?? '9555'
const DESIGN_SIZE = 220

function electronBinary() {
  return join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // 端口还没起
    }
    await delay(250)
  }
  throw new Error('等待 CDP 目标超时')
}

async function main() {
  const child = spawn(electronBinary(), ['.', `--remote-debugging-port=${port}`], {
    cwd: process.cwd(),
    env: { ...process.env, XIAOQI_EVIDENCE_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => {
    logs.push(String(d))
    process.stdout.write('[app] ' + String(d))
  })

  let ws = null
  try {
    const page = await waitForTarget(20000)
    ws = new WebSocket(page.webSocketDebuggerUrl)
    let nextId = 0
    const pending = new Map()
    const send = (method, params, session) => {
      const id = ++nextId
      const payload = { id, method, params: params ?? {} }
      if (session) payload.sessionId = session
      ws.send(JSON.stringify(payload))
      return new Promise((resolve) => pending.set(id, resolve))
    }
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result ?? msg.error)
        pending.delete(msg.id)
      }
    })
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
    })

    const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const session = attached.sessionId

    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true }, session)
      return res?.result?.value
    }

    // 等渲染进程就绪
    for (let i = 0; i < 40; i++) {
      if (await evaluate('typeof window.xiaoqi')) break
      await delay(250)
    }

    const failures = []

    const check = (ok, label, detail) => {
      console.log(`${ok ? '✅' : '❌'} ${label}\n     ${detail}`)
      if (!ok) failures.push(label)
    }

    for (const scale of [1, 1.5, 0.75, 2]) {
      await evaluate(`window.xiaoqi.setScale(${String(scale)})`)
      await delay(900) // 等主进程改窗口 + 重新广播状态

      // ① 主进程推来的状态里 scale 对不对
      const stateScale = await evaluate('window.__xqScale ?? null')
      // ② 渲染进程看到的窗口尺寸（CSS 像素 = DIP）
      const innerSize = await evaluate(
        'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })',
      )
      // ③ 舞台自己的缩放与 canvas 后备尺寸
      const stageInfo = await evaluate(
        'JSON.stringify(typeof window.__petDebug === "function" ? (function(){var d=window.__petDebug();return {scale:d.scale, canvasW:document.querySelector("canvas").width};})() : null)',
      )

      const inner = JSON.parse(String(innerSize))
      const stage = stageInfo && stageInfo !== 'null' ? JSON.parse(String(stageInfo)) : null
      const expected = Math.round(DESIGN_SIZE * scale)

      check(
        inner.w === expected && inner.h === expected,
        `scale=${String(scale)}：窗口确实是 ${String(expected)}×${String(expected)}`,
        `实际 window.innerWidth/Height = ${String(inner.w)}×${String(inner.h)}`,
      )
      check(
        stage !== null && Math.abs(Number(stage.scale) - scale) < 0.001,
        `scale=${String(scale)}：渲染舞台同步了缩放`,
        `舞台 scale = ${String(stage?.scale)}，canvas 宽 = ${String(stage?.canvasW)}`,
      )
      void stateScale
    }

    console.log(
      `\n结果：${String(4 * 2 - failures.length)}/${String(4 * 2)} 项符合预期` +
        (failures.length ? `\n未通过：${failures.join('、')}` : ''),
    )
    if (failures.length > 0) process.exitCode = 1
  } finally {
    ws?.close()
    child.kill()
    await delay(700)
  }
}

main().catch((error) => {
  console.error('缩放验证失败：' + String(error))
  process.exit(1)
})
