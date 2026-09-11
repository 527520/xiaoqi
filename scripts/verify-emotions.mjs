/**
 * 给八种情绪逐个截图，用来**用眼睛**核对表情是否真的各不相同。
 *
 * ── 为什么需要它 ──
 *
 * `emotionFace.test.ts` 能证明"八种情绪的参数不同"，但证明不了
 * "画出来看起来不一样"——那正是这个功能存在的理由。
 * 本机又不能在渲染进程里开 DevTools 看（一开透明窗就不透明），
 * 所以只能逐个截图再人眼比对（或交给脚本对比像素）。
 *
 * 做法：对每种情绪启动一次应用（用 `XIAOQI_FORCE_EMOTION` 锁死情绪），
 * 用 CDP 截一张渲染进程的图，最后拼成一张对比表的信息。
 *
 * 用法：node scripts/verify-emotions.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EMOTIONS = ['happy', 'calm', 'sleepy', 'focused', 'aggrieved', 'surprised', 'close', 'bored']

const outDir = join(process.cwd(), 'docs', 'evidence', 'runtime', 'emotions')
const debugPort = 9888

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
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // 端口还没起
    }
    await delay(200)
  }
  throw new Error('等待 CDP 目标超时')
}

/** 启动一次应用、锁定一种情绪、截一张图。 */
async function captureEmotion(emotion) {
  const child = spawn(electronBinary(), ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XIAOQI_EVIDENCE_DIR: '',
      XIAOQI_FORCE_EMOTION: emotion,
      // 关掉状态面板日志，免得八次运行刷一堆无关输出
      XIAOQI_DEBUG_STATE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))

  let ws = null
  try {
    const page = await waitForTarget(25000)
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

    const attached = await send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
    const session = attached.sessionId
    await send('Page.enable', {}, session)

    // 等渲染就绪 + 情绪推送到达
    await delay(3000)

    const shot = await send('Page.captureScreenshot', { format: 'png' }, session)
    if (!shot?.data) throw new Error('截图失败')

    mkdirSync(outDir, { recursive: true })
    const path = join(outDir, `${emotion}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))

    // 顺带从日志确认主进程真的锁上了这个情绪
    const applied = logs.join('').includes(`情绪已锁定为 ${emotion}`)
    console.log(`${applied ? '✅' : '❌'} ${emotion} → ${path}`)
    return applied
  } finally {
    ws?.close()
    child.kill()
    await delay(900)
  }
}

async function main() {
  let failures = 0
  for (const emotion of EMOTIONS) {
    try {
      const ok = await captureEmotion(emotion)
      if (!ok) failures++
    } catch (error) {
      console.error(`❌ ${emotion} 失败：${String(error)}`)
      failures++
    }
  }
  console.log(`\n截图 ${String(EMOTIONS.length - failures)}/${String(EMOTIONS.length)} 张`)
  console.log(`输出目录：${outDir}`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('情绪取证失败：' + String(error))
  process.exit(1)
})
