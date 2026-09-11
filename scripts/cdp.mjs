/**
 * 可复用的 CDP 客户端（**模块**，不自己启动任何东西）。
 *
 * ── 为什么单独抽出来 ──
 *
 * `attach-cdp.mjs` 是个**脚本**：一 import 就跑 `main()`，没法当库用。
 * 而验证记忆账本需要"连上真实应用、在页面里跑 JS、截图"这套能力，
 * 所以把那套机制抽成模块，两边共用同一份实现
 * ——否则 CDP 的连接细节会在两处各自漂移。
 *
 * ── 本机必须知道的三个事实 ──
 *
 * ① **HTTP 的 `/json/list` 在本机不可用**（Electron 44 / Chromium 152 实测
 *    直接拒绝连接），所以只能从 stderr 里读
 *    `DevTools listening on ws://127.0.0.1:PORT/devtools/browser/<id>`，
 *    连 browser WebSocket，再用 `Target.getTargets` 枚举页面。
 * ② 所有 `Runtime.*` / `Page.*` 调用都要带上 `Target.attachToTarget`
 *    返回的 `sessionId`（`flatten: true`）。
 * ③ `Page.captureScreenshot` 走的是**合成结果**，因此 WebGL 画布也截得到。
 *    不要改走 `drawImage` + `getImageData`——那条路对 WebGL 永远返回全透明
 *    （默认 `preserveDrawingBuffer: false`，合成后 drawing buffer 就清了）。
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * @returns {string} electron 可执行文件路径
 */
export function electronBinary() {
  return join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 启动应用并收集日志。
 *
 * @param {{ port?: number, env?: Record<string, string>, extraArgs?: string[] }} [options]
 * @returns {{ child: import('node:child_process').ChildProcess, logs: string[], browserUrl: Promise<string> }}
 */
export function launchApp({ port, env = {}, extraArgs = [] } = {}) {
  const args = ['.']
  if (port !== undefined) args.push(`--remote-debugging-port=${String(port)}`)
  args.push(...extraArgs)

  const child = spawn(electronBinary(), args, {
    cwd: process.cwd(),
    env: { ...process.env, XIAOQI_EVIDENCE_DIR: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs = []
  let buffered = ''
  let settleBrowserUrl
  const browserUrl = new Promise((resolve) => {
    settleBrowserUrl = resolve
  })

  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    logs.push(text)
    process.stdout.write(`[app] ${text}`)
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk)
    logs.push(text)
    // DevTools 那行本身是噪声（每次都要打），其它 stderr 照常透传。
    if (!text.includes('DevTools listening')) process.stderr.write(`[app:err] ${text}`)
    buffered += text
    const match = /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+/.exec(buffered)
    if (match) settleBrowserUrl(match[0])
  })

  return { child, logs, browserUrl }
}

/**
 * 连上 browser 端点，返回一个带 `session` 的 CDP 客户端。
 *
 * @param {string} browserUrl browser 级 WebSocket URL
 * @param {string} targetUrlIncludes 只附着 URL 含该子串的页面目标
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   target: { url: string, targetId: string },
 *   sessionId: string,
 *   send: (method: string, params?: Record<string, unknown>, session?: string) => Promise<any>,
 *   evaluate: (expression: string) => Promise<any>,
 *   screenshot: () => Promise<string>,
 *   close: () => void,
 * }>}
 */
export async function connectCdp(browserUrl, targetUrlIncludes, { timeoutMs = 25_000 } = {}) {
  const ws = new WebSocket(browserUrl)
  const pending = new Map()
  let nextId = 0

  const send = (method, params, session) => {
    const id = ++nextId
    const payload = { id, method, params: params ?? {} }
    if (session) payload.sessionId = session
    ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP 调用超时：${method}`))
      }, timeoutMs)
    })
  }

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      // CDP 把失败放在 `error` 字段里；不检查的话调用方会拿到 undefined
      // 而以为是"成功但没结果"。
      if (msg.error) entry.reject(new Error(`${msg.error.message ?? 'CDP 错误'}`))
      else entry.resolve(msg.result)
    }
  })

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
  })

  // 等目标出现。应用是异步开窗的，账本窗口要几秒后才有。
  const deadline = Date.now() + timeoutMs
  let target = null
  while (Date.now() < deadline && !target) {
    const res = await send('Target.getTargets')
    target = (res?.targetInfos ?? []).find(
      (info) => info.type === 'page' && (info.url ?? '').includes(targetUrlIncludes),
    )
    if (!target) await delay(300)
  }
  if (!target) {
    ws.close()
    throw new Error(`找不到 URL 含 "${targetUrlIncludes}" 的页面目标`)
  }

  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sessionId = attached.sessionId

  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)

  return {
    target,
    sessionId,
    send,

    /** 在页面里求值并取回 JSON 化的结果。 */
    async evaluate(expression) {
      const result = await send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      )
      // 页面里抛的异常会走 exceptionDetails，不能当成 undefined 悄悄吞掉。
      if (result?.exceptionDetails) {
        throw new Error(
          `页面求值抛错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        )
      }
      return result?.result?.value
    },

    /** 截页面（走合成结果，WebGL 也截得到）。返回 base64。 */
    async screenshot() {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
      if (!shot?.data) throw new Error('截图失败：没有 data')
      return shot.data
    },

    close() {
      ws.close()
    },
  }
}
