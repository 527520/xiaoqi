/**
 * 诊断脚本：两个真问题
 *   A) QUNS 在全屏应用在场时为什么不跳变？—— 分别试「几何覆盖」「真全屏」「置顶」
 *   B) setShape 到底要什么参数格式？
 *
 * 运行：electron diagnose.mjs
 */
import { app, BrowserWindow, screen } from 'electron'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const koffi = require('koffi')
const shell32 = koffi.load('shell32.dll')
const SHQueryUserNotificationState = shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int32 *peState)')
const QUNS = { 1: 'NOT_PRESENT', 2: 'BUSY', 3: 'D3D_FULLSCREEN', 4: 'PRESENTATION', 5: 'ACCEPTS_NOTIF', 6: 'QUIET', 7: 'APP' }
const q = () => { const s = [0]; const hr = SHQueryUserNotificationState(s); return `${s[0]}(${QUNS[s[0]] ?? '?'}) hr=${hr}` }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const mon = screen.getPrimaryDisplay()
  const H = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#101014;color:#fff;font:600 40px system-ui;display:flex;align-items:center;justify-content:center}</style></head><body>PROBE</body></html>'
  const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(H)

  console.log('\n=== A) QUNS 诊断 ===')
  console.log('基线                     :', q())

  // A1: 无边框、几何覆盖整屏、不置顶
  const a1 = new BrowserWindow({
    x: mon.bounds.x, y: mon.bounds.y, width: mon.size.width, height: mon.size.height,
    frame: false, show: false, skipTaskbar: true, backgroundColor: '#101014',
  })
  await a1.loadURL(html)
  a1.show(); a1.focus(); await sleep(1200)
  console.log('A1 无边框+几何覆盖整屏    :', q(), ` bounds=${JSON.stringify(a1.getBounds())} isFullScreen=${a1.isFullScreen()}`)

  // A2: 同一个窗改成“真”全屏
  a1.setFullScreen(true); await sleep(1500)
  console.log('A2 同上 + setFullScreen   :', q(), ` isFullScreen=${a1.isFullScreen()}`)
  a1.setFullScreen(false); await sleep(800)

  // A3: 真全屏 + 置顶（模拟游戏的独占/置顶行为）
  a1.setAlwaysOnTop(true); a1.setFullScreen(true); await sleep(1500)
  console.log('A3 真全屏 + alwaysOnTop   :', q(), ` isFullScreen=${a1.isFullScreen()}`)
  a1.setFullScreen(false); a1.setAlwaysOnTop(false); await sleep(600)

  // A4: 有边框最大化（真实的“最大化窗口”场景）
  const a4 = new BrowserWindow({ frame: true, show: false, backgroundColor: '#101014' })
  await a4.loadURL(html)
  a4.maximize(); a4.show(); a4.focus(); await sleep(1200)
  console.log('A4 有边框窗口最大化       :', q(), ` bounds=${JSON.stringify(a4.getBounds())}`)

  // A5: 关闭 A1 后，只剩最大化窗口
  a1.destroy(); await sleep(1000)
  console.log('A5 仅剩最大化窗口         :', q())
  a4.destroy(); await sleep(800)
  console.log('A6 全部关闭后             :', q())

  console.log('\n=== B) setShape 参数格式诊断 ===')
  const w = new BrowserWindow({
    width: 400, height: 400, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, show: false, skipTaskbar: true,
  })
  await w.loadURL(html)
  w.center(); w.showInactive(); await sleep(600)

  const formats = [
    ['PascalCase 数组', () => w.setShape([{ X: 0, Y: 0, Width: 200, Height: 200 }])],
    ['lowercase 数组', () => w.setShape([{ x: 0, y: 0, width: 200, height: 200 }])],
    ['Pascal 完整四块', () => w.setShape([
      { X: 0, Y: 0, Width: 400, Height: 100 },
      { X: 0, Y: 300, Width: 400, Height: 100 },
    ])],
    ['空数组（复原）', () => w.setShape([])],
  ]
  for (const [label, fn] of formats) {
    try {
      fn()
      await sleep(250)
      console.log(`  ✅ ${label}  → 成功`)
    } catch (e) {
      console.log(`  ❌ ${label}  → ${String(e && e.message ? e.message : e).split('\n')[0]}`)
    }
  }

  // B2: 会不会是“透明窗不支持”？用非透明窗试
  const w2 = new BrowserWindow({ width: 300, height: 300, frame: false, show: false, skipTaskbar: true })
  await w2.loadURL(html)
  w2.showInactive(); await sleep(400)
  try {
    w2.setShape([{ X: 0, Y: 0, Width: 150, Height: 150 }])
    await sleep(250)
    console.log('  ✅ 非透明窗 + PascalCase  → 成功（透明度不是原因）')
  } catch (e) {
    console.log(`  ❌ 非透明窗 + PascalCase  → ${String(e && e.message ? e.message : e).split('\n')[0]}`)
  }
  try {
    w2.setShape([{ x: 0, y: 0, width: 150, height: 150 }])
    await sleep(250)
    console.log('  ✅ 非透明窗 + lowercase  → 成功')
  } catch (e) {
    console.log(`  ❌ 非透明窗 + lowercase  → ${String(e && e.message ? e.message : e).split('\n')[0]}`)
  }
  w2.destroy()

  await sleep(500)
  console.log('\n=== 诊断结束 ===')
  app.exit(0)
}

app.whenReady().then(() => run().catch((e) => { console.error('诊断脚本出错:', e); app.exit(1) }))
// 刻意不注册 window-all-closed：A 段会销毁窗口，那个事件会导致应用提前退出、B 段永远跑不到。
