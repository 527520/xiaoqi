/**
 * 让**真实应用**可被 CDP 诊断。
 *
 * 用法：`node scripts/attach-cdp.mjs [端口] [等待毫秒]`
 *
 * ── 为什么连 browser WebSocket 而不是 /json/list ──
 *
 * 实测：本机 Electron 44（Chromium 152）只打印
 * `DevTools listening on ws://127.0.0.1:PORT/devtools/browser/<id>`，
 * 而 **HTTP 的 `/json/list` 直接被拒绝连接**。所以必须：
 * 1. 从 stderr 里读出 browser WebSocket URL；
 * 2. 连上去用 `Target.getTargets` 枚举页面目标；
 * 3. 用 `Target.attachToTarget { flatten: true }` 拿到 sessionId，
 *    之后所有 `Runtime.*` / `Page.*` 都要带上这个 sessionId。
 *
 * ── 为什么需要这套东西 ──
 *
 * 同一个渲染产物在"诊断小窗 + loadFile"下渲染正常（canvasCount=1），
 * 在真实应用里却报 unsafe-eval。差异只可能来自应用的窗口选项或启动时序，
 * 所以必须在**真实应用里**抓堆栈，而不是在外面复刻环境。
 *
 * 用 CDP 还顺带绕开了施工令 §4.3② 的限制：**不打开 DevTools 窗口**，
 * 因此不会让透明窗变不透明。
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = process.argv[2] ?? '9222'
const waitMs = Number(process.argv[3] ?? 14000)

const PRELUDE = `
window.__results = [];
window.addEventListener('error', function (e) {
  window.__results.push('window.error: ' + e.message + '\\n' + ((e.error && e.error.stack) || ''));
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason;
  window.__results.push('unhandledrejection: ' + ((r && r.message) || String(r)) + '\\n' + ((r && r.stack) || ''));
});
`

function electronBinary() {
  return join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

async function main() {
  const child = spawn(electronBinary(), ['.', `--remote-debugging-port=${port}`], {
    cwd: process.cwd(),
    env: { ...process.env, XIAOQI_EVIDENCE_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  /** 从 stderr 抓 browser WebSocket URL。 */
  const browserUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 DevTools WebSocket URL 超时')), 25000)
    let buffered = ''
    const onData = (chunk) => {
      const text = String(chunk)
      buffered += text
      process.stdout.write('[app:err] ' + text)
      const match = /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+/.exec(buffered)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    }
    child.stderr.on('data', onData)
    child.stdout.on('data', (d) => process.stdout.write('[app] ' + String(d)))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`应用提前退出，code=${String(code)}`))
    })
  })

  console.log('\n浏览器调试端点：' + browserUrl)

  const ws = new WebSocket(browserUrl)
  const pending = new Map()
  let nextId = 0

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
      return
    }

    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log('\n=== 未捕获异常 ===')
      console.log('text :', d.text)
      console.log(
        '位置 :',
        `${d.url ?? ''}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}`,
      )
      if (d.exception?.description) console.log('描述 :\n' + d.exception.description)
      for (const f of d.stackTrace?.callFrames ?? []) {
        console.log(
          `   at ${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`,
        )
      }
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      console.log(`[browser-log:${e.level}] ${e.text} ${e.url ?? ''}:${e.lineNumber ?? ''}`)
    }
  })

  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
    })

    // 枚举目标，找到页面
    let page = null
    for (let attempt = 0; attempt < 30 && !page; attempt++) {
      const res = await send('Target.getTargets')
      page = (res?.targetInfos ?? []).find((t) => t.type === 'page')
      if (!page) await new Promise((r) => setTimeout(r, 400))
    }
    if (!page) throw new Error('找不到 page 目标')
    console.log(`页面目标：${page.url}`)

    const attachedResult = await send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
    const sessionId = attachedResult.sessionId
    console.log(`已附着，sessionId=${String(sessionId)}`)

    await send('Runtime.enable', {}, sessionId)
    await send('Log.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)

    // 在文档创建时注入前奏，然后重新加载，保证早于模块脚本求值
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, sessionId)
    console.log('已登记错误前奏注入，重新加载页面…')
    await send('Page.reload', { ignoreCache: true }, sessionId)

    await new Promise((r) => setTimeout(r, waitMs))

    const state = await send(
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({ results: window.__results ?? null, hasBridge: typeof window.xiaoqi, canvasCount: document.querySelectorAll("canvas").length })',
        returnByValue: true,
      },
      sessionId,
    )
    console.log('\n=== 页面状态 ===\n' + JSON.stringify(state?.result?.value ?? state))

    // 分层截图：关掉身体再截，就能判断"眼睛到底有没有被画出来"。
    // 这比反复读像素可靠——WebGL 的 drawing buffer 合成后可能已失效，
    // 而 Page.captureScreenshot 走的是合成结果。
    if (process.env.XIAOQI_CDP_LAYERS) {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { join: pjoin } = await import('node:path')
      mkdirSync(pjoin(process.cwd(), 'docs', 'evidence'), { recursive: true })

      const shots = [
        ['all-visible', 'true', 'true'],
        ['body-hidden', 'false', 'true'],
        ['eyes-only', 'false', 'true'],
      ]

      for (const [label, bodyVisible, eyesVisible] of shots) {
        await send(
          'Runtime.evaluate',
          {
            expression: `(() => {
  if (typeof window.__petLayer !== 'function') return 'no hook';
  window.__petLayer('body', ${bodyVisible});
  window.__petLayer('ears', ${bodyVisible});
  window.__petLayer('tail', ${bodyVisible});
  window.__petLayer('cheeks', ${bodyVisible});
  window.__petLayer('eyes', ${eyesVisible});
  return 'ok';
})()`,
            returnByValue: true,
          },
          sessionId,
        )
        await new Promise((r) => setTimeout(r, 400))
        const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
        if (shot?.data) {
          const out = pjoin(process.cwd(), 'docs', 'evidence', `layer-${label}.png`)
          writeFileSync(out, Buffer.from(shot.data, 'base64'))
          console.log(`分层截图：${out}`)
        }
      }

      // 恢复全部可见
      await send(
        'Runtime.evaluate',
        {
          expression:
            "['body','ears','tail','cheeks','eyes','shadow'].forEach((l) => window.__petLayer(l, true)), 'restored'",
          returnByValue: true,
        },
        sessionId,
      )
    }

    // 读取舞台内部状态。`window.__petDebug` 只在非生产构建里挂载。
    // 连续采样多次：动画是随时间变化的，"眼睛是不是一直在眨"这类问题
    // 只采样一次会得出错误结论（本机就因此误判过一轮）。
    const samples = Number(process.env.XIAOQI_CDP_SAMPLES ?? '1')
    for (let i = 0; i < samples; i++) {
      const scene = await send(
        'Runtime.evaluate',
        {
          expression:
            'typeof window.__petDebug === "function" ? JSON.stringify(window.__petDebug()) : "no __petDebug hook"',
          returnByValue: true,
        },
        sessionId,
      )
      const value = scene?.result?.value
      console.log(`\n=== 舞台采样 #${i + 1} ===`)
      if (typeof value === 'string' && value.startsWith('{')) {
        if (process.env.XIAOQI_CDP_FULL) {
          console.log(JSON.stringify(JSON.parse(value), null, 1))
        } else {
          const parsed = JSON.parse(value)
          console.log(
            `animation=${JSON.stringify(parsed.animation)} eyeLeftScaleY=${parsed.eyeLeft?.scaleY} eyeLeftPos=(${parsed.eyeLeft?.x},${parsed.eyeLeft?.y})`,
          )
        }
      } else {
        console.log(String(value))
      }
      if (i < samples - 1) await new Promise((r) => setTimeout(r, 700))
    }

    // 抓一张渲染进程的截图。这是判断"宠物到底画出来了没有"最直接的办法：
    // 页面截图与"桌面上看起来如何"不同，但如果 canvas 是空的，
    // 截图里就一定看不到宠物——足以区分"没渲染"和"渲染了但窗口有问题"。
    //
    // ⚠️ 不要再走"用 2D canvas 的 drawImage 把 WebGL canvas 复制出来再 getImageData"
    //    这条路。本机实测它**永远返回全透明**：WebGL 的 drawing buffer 在合成后
    //    就被清空了（默认 `preserveDrawingBuffer: false`），drawImage 复制到的是空缓冲。
    //    曾经因此误判"宠物完全没有渲染"，白排查了很久。
    //    要做像素判据，请用 `Page.captureScreenshot`（走合成结果）再配
    //    `scripts/inspect-canvas.mjs` 分析。
    if (process.env.XIAOQI_CDP_SCREENSHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
      if (shot?.data) {
        const { writeFileSync, mkdirSync } = await import('node:fs')
        const { join: pjoin } = await import('node:path')
        mkdirSync(pjoin(process.cwd(), 'docs', 'evidence'), { recursive: true })
        const out = pjoin(process.cwd(), 'docs', 'evidence', process.env.XIAOQI_CDP_SCREENSHOT)
        writeFileSync(out, Buffer.from(shot.data, 'base64'))
        console.log(`页面截图已写入 ${out}`)
      } else {
        console.log('截图失败：' + JSON.stringify(shot))
      }
    }
  } finally {
    ws.close()
    child.kill()
    await new Promise((r) => setTimeout(r, 600))
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('attach-cdp 失败：' + String(error))
    process.exit(1)
  })
