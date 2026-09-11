/**
 * 诊断 B：setShape 到底要什么参数格式（把 A 段的窗口操作全部去掉，避免互相干扰）
 * 运行：electron diagnose-b.mjs
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRACE = path.join(__dirname, 'diagnose-b-trace.log')
const trace = (s) => {
  const line = `${new Date().toISOString()}  ${s}`
  console.log(line)
  try { fs.appendFileSync(TRACE, line + '\n', 'utf8') } catch { /* ignore */ }
}

const HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#ff00ff}</style></head><body></body></html>')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tryFormat(label, win, makeRects) {
  try {
    const rects = makeRects()
    win.setShape(rects)
    await sleep(250)
    trace(`  ✅ ${label}`)
    return true
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0]
    trace(`  ❌ ${label}  →  ${msg}`)
    return false
  }
}

async function run() {
  try { fs.writeFileSync(TRACE, '', 'utf8') } catch { /* ignore */ }
  trace('=== 诊断 B 开始 ===')

  let win
  try {
    win = new BrowserWindow({
      width: 400, height: 400, frame: false, transparent: true,
      backgroundColor: '#00000000', resizable: false, show: false, skipTaskbar: true,
    })
    await win.loadURL(HTML)
    win.center()
    win.showInactive()
    await sleep(700)
    trace(`窗口已就绪 visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`)
  } catch (e) {
    trace(`窗口创建失败: ${e}`)
    app.exit(1)
    return
  }

  trace('--- 透明 + 无边框窗口 ---')
  await tryFormat('PascalCase 单矩形 {X,Y,Width,Height}', win, () => [{ X: 0, Y: 0, Width: 200, Height: 200 }])
  await tryFormat('lowercase 单矩形 {x,y,width,height}', win, () => [{ x: 0, y: 0, width: 200, height: 200 }])
  await tryFormat('PascalCase 两块（并集）', win, () => [
    { X: 0, Y: 0, Width: 400, Height: 100 },
    { X: 0, Y: 300, Width: 400, Height: 100 },
  ])
  await tryFormat('空数组（复原）', win, () => [])
  await tryFormat('null', win, () => null)

  // 非透明窗对照：排除“透明窗不支持 setShape”这一可能
  trace('--- 非透明窗对照 ---')
  let win2
  try {
    win2 = new BrowserWindow({ width: 300, height: 300, frame: false, show: false, skipTaskbar: true })
    await win2.loadURL(HTML)
    win2.showInactive()
    await sleep(500)
    await tryFormat('非透明窗 + PascalCase', win2, () => [{ X: 0, Y: 0, Width: 150, Height: 150 }])
  } catch (e) {
    trace(`非透明窗对照失败: ${e}`)
  }

  trace('=== 诊断 B 结束 ===')
  app.exit(0)
}

app.whenReady().then(() => run().catch((e) => { trace(`顶层异常: ${e && e.stack ? e.stack : e}`); app.exit(1) }))
// 刻意不注册 window-all-closed
