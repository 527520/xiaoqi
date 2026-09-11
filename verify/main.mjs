/**
 * 小奇（xiaoqi）· M0 前置验证
 *
 * 目的：在写任何业务代码之前，证明技术方案在本机成立。
 * 运行：pnpm --dir verify verify
 *   可选环境变量：
 *     XIAOQI_CHECK_CAPTURE=1   做桌面捕获取证（判定「一键隐身」是否真的生效）
 *     XIAOQI_KEEP_OPEN_MS=15000  验证完把窗口留一会儿，供手工观察全屏行为
 *
 * 设计原则：
 *  - 每一项都给出**可复现的实测值**，而不是"应该可以"。
 *  - 无法在本机验证的项标 ⚠️，绝不假装通过。
 *  - 不做任何越界感知：只读进程名、空闲时长、全屏状态。不读窗口标题、不读屏幕内容。
 */
import { app, BrowserWindow, screen, desktopCapturer } from 'electron'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// 陷阱 ①：遮挡开关必须在 main.js 顶层。appendSwitch 是「覆盖」不是「合并」，
// 且放进 app.whenReady() 里就太晚了（Electron 只在主脚本执行完后重建 FeatureList）。
// ─────────────────────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const CHECK_CAPTURE = process.env.XIAOQI_CHECK_CAPTURE === '1'
const KEEP_OPEN_MS = Number(process.env.XIAOQI_KEEP_OPEN_MS || 0)

const results = []
const rec = (name, status, value = '') => {
  results.push({ name, status, value })
  const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ' }[status] ?? '  '
  console.log(`${icon} ${name}${value ? '  →  ' + value : ''}`)
}
const section = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────────────────────
// 场景分类表：仅用「前台进程名」推断工作模式。
// 刻意只读进程名 —— 永不读窗口标题（见 docs/adr/0002）。
// ─────────────────────────────────────────────────────────────────────────────
const SCENE_MAP = {
  coding: ['code', 'code - insiders', 'cursor', 'devenv', 'pycharm64', 'pycharm', 'idea64', 'webstorm64',
    'goland64', 'clion64', 'rider64', 'sublime_text', 'notepad++', 'windowsterminal', 'wt', 'powershell',
    'pwsh', 'cmd', 'conhost', 'wezterm', 'alacritty', 'mintty', 'git-bash', 'bash', 'wsl', 'nvim', 'vim',
    'emacs', 'fleet', 'zed', 'trae', 'windsurf', 'rustrover64', 'phpstorm64', 'rubymine64', 'datagrip64',
    'androidstudio64', 'eclipse', 'netbeans', 'helix', 'hx', 'idea'],
  meeting: ['zoom', 'teams', 'ms-teams', 'webexmta', 'webex', 'dingtalk', 'wemeetapp', 'wemeet', 'feishu',
    'lark', 'slack', 'discord', 'skype', 'gotomeeting', 'bluejeans', 'whereby', 'around', 'gather',
    'voovmeeting', 'tencentmeeting'],
  email: ['outlook', 'thunderbird', 'foxmail', 'mailspring', 'spark', 'em client', 'emclient'],
  notes: ['obsidian', 'notion', 'typora', 'logseq', 'onenote', 'joplin', 'craft', 'evernote',
    'wiznote', 'siyuan'],
  browser: ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'chromium', 'iexplore',
    '360se', '360chrome', 'qqbrowser', 'sogouexplorer', 'maxthon'],
  media: ['potplayer', 'vlc', 'mpc-hc64', 'mpc-hc', 'mpv', 'kmplayer', 'bilibili', 'iqiyi', 'youku',
    'spotify', 'foobar2000', 'aimp', 'musicbee', 'zunemusic', 'qqmusic', 'cloudmusic', 'kugou', 'kuwo'],
  game: ['steam', 'steamwebhelper', 'epicgameslauncher', 'battle.net', 'riotclientservices', 'galaxyclient',
    'goggalaxy', 'ubisoftconnect', 'origin', 'eadesktop', 'genshinimpact', 'yuanshen', 'starrail',
    'leagueclient', 'dota2', 'cs2', 'valorant', 'minecraft', 'wow', 'ffxiv_dx11'],
  design: ['photoshop', 'illustrator', 'figma', 'blender', 'krita', 'gimp', 'inkscape', 'affinity',
    'coreldrw', 'afterfx', 'premiere', 'davinci', 'resolve', 'obs64', 'obs32', 'obs'],
  office: ['winword', 'excel', 'powerpnt', 'wps', 'et', 'wpp', 'acrobat', 'acrord32', 'foxitreader',
    'sumatrapdf'],
  files: ['explorer', 'totalcmd', 'everything', 'dopus', 'xyplorer', 'files'],
}
const MODE_LABEL = {
  coding: '编码', meeting: '会议', email: '邮件', notes: '笔记', browser: '浏览',
  media: '娱乐', game: '游戏', design: '设计', office: '文档', files: '文件', unknown: '未知',
}
function classify(proc) {
  const p = String(proc || '').toLowerCase().replace(/\.exe$/, '').trim()
  if (!p) return 'unknown'
  for (const [mode, list] of Object.entries(SCENE_MAP)) {
    if (list.includes(p)) return mode
  }
  for (const [mode, list] of Object.entries(SCENE_MAP)) {
    if (list.some((k) => k.length >= 6 && p.startsWith(k))) return mode
  }
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// koffi 绑定 —— 本项目全部 OS 调用的唯一入口
// （产品中只允许出现在 src/main/platform/win32.ts，core/ 绝不能 require 它）
// ─────────────────────────────────────────────────────────────────────────────
function bindWin32() {
  const koffi = require('koffi')

  // 结构体必须先定义、且只定义一次；嵌套时引用已注册的名字。
  const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
  const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' })
  const MONITORINFO = koffi.struct('MONITORINFO', {
    cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32',
  })

  const user32 = koffi.load('user32.dll')
  const shell32 = koffi.load('shell32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // 句柄/指针统一用 uintptr，避免 Buffer ↔ void* 的转换问题
  return {
    koffi, RECT,
    // 允许的感知 ①：前台进程名
    GetForegroundWindow: user32.func('uintptr __stdcall GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr hWnd, _Out_ uint32 *lpdwProcessId)'),
    OpenProcess: kernel32.func('uintptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(uintptr hProc, uint32 flags, _Out_ uint16 *name, _Inout_ uint32 *size)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(uintptr h)'),
    // 允许的感知 ②：空闲时长
    GetLastInputInfo: user32.func('bool __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *plii)'),
    GetTickCount64: kernel32.func('uint64 __stdcall GetTickCount64()'),
    LASTINPUTINFO,
    // 允许的感知 ③：全屏 / 锁屏状态
    SHQueryUserNotificationState: shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int32 *peState)'),
    // 几何（只用于自己的窗口与全屏交叉验证，不读内容）
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr hWnd, _Out_ RECT *r)'),
    MonitorFromWindow: user32.func('uintptr __stdcall MonitorFromWindow(uintptr hwnd, uint32 flags)'),
    GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(uintptr hMon, _Inout_ MONITORINFO *mi)'),
    MONITORINFO,
    // 窗口形状：这一层用 Buffer 重载接收 HWND，让 koffi 自己解码指针
    // （不要手动 readUInt32LE —— 64 位句柄取低 32 位可能符号扩展出错）
    GetWindowRgnBox: user32.func('int32 __stdcall GetWindowRgnBox(void *hwnd, _Out_ RECT *r)'),
    // DWM 取证：既不读窗口内容也不读标题，只问窗口的外框与排除状态
    DwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr hwnd, uint32 attr, _Out_ uint8 *pv, uint32 cb)'),
    DwmGetWindowAttributeInt: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr hwnd, uint32 attr, _Out_ int32 *pv, uint32 cb)'),
    DwmGetWindowAttributeRect: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr hwnd, uint32 attr, _Out_ RECT *pv, uint32 cb)'),
    _gdi32Loaded: !!gdi32, // 仅确认可加载；CreateRectRgn 在 gdi32 而非 user32
  }
}

const QUNS = {
  1: 'QUNS_NOT_PRESENT（锁屏/屏保/不在前台）',
  2: 'QUNS_BUSY（全屏应用或演示设置）',
  3: 'QUNS_RUNNING_D3D_FULL_SCREEN（独占全屏）',
  4: 'QUNS_PRESENTATION_MODE（演示模式）',
  5: 'QUNS_ACCEPTS_NOTIFICATIONS（正常）',
  6: 'QUNS_QUIET_TIME（静默时段）',
  7: 'QUNS_APP（Store 应用）',
}
const SILENCE_SET = new Set([1, 2, 3, 4]) // 这四种状态一律静默
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** 用 koffi 取进程可执行文件名 —— 不 spawn 子进程，避免阻塞事件循环破坏透明度取证 */
function foregroundProcessName(w) {
  const hwnd = w.GetForegroundWindow()
  if (!hwnd) return { proc: '', pid: 0 }
  const pid = [0]
  w.GetWindowThreadProcessId(hwnd, pid)
  if (!pid[0]) return { proc: '', pid: 0 }
  const h = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0])
  if (!h) return { proc: '', pid: pid[0] }
  try {
    const buf = new Uint16Array(1024)
    const size = [1024]
    if (!w.QueryFullProcessImageNameW(h, 0, buf, size)) return { proc: '', pid: pid[0] }
    const full = Buffer.from(buf.buffer, 0, size[0] * 2).toString('utf16le')
    return { proc: path.win32.basename(full).replace(/\.exe$/i, ''), pid: pid[0] }
  } finally {
    w.CloseHandle(h)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  section('环境')
  rec('Electron', 'INFO', process.versions.electron)
  rec('Chromium', 'INFO', process.versions.chrome)
  rec('Node（Electron 内置）', 'INFO', process.versions.node)
  rec('Node-API', 'INFO', String(process.versions.napi))
  rec('平台', 'INFO', `${process.platform} ${os.release()}  ${os.arch()}`)
  const displays = screen.getAllDisplays()
  rec('显示器', 'INFO', displays.map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}x${d.internal ? '内' : '外'}`).join('  '))
  if (displays.length === 1) {
    rec('多屏与混合 DPI', 'WARN', '本机只有一块显示器 → 跨屏定位与混合 DPI 无法验证，实现后必须标注未验证')
  }

  // ═══ V1: better-sqlite3 ═══
  section('V1  better-sqlite3 能否在 Electron 主进程里直接用（不需要 rebuild）')
  try {
    const Database = require('better-sqlite3')
    rec('模块加载', 'PASS', 'better-sqlite3 ' + require('better-sqlite3/package.json').version)

    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, v TEXT)')
    db.exec('CREATE VIRTUAL TABLE mem USING fts5(content, tags)')
    db.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('name', '小奇')
    db.prepare('INSERT INTO mem (content, tags) VALUES (?, ?)').run('用户昨天也在加班', '加班,疲劳')
    db.prepare('INSERT INTO mem (content, tags) VALUES (?, ?)').run('用户喜欢抹茶', '偏好')

    const row = db.prepare('SELECT v FROM t WHERE k = ?').get('name')
    rec('读写', row && row.v === '小奇' ? 'PASS' : 'FAIL', `SELECT → ${row && row.v}`)

    const hits = db.prepare('SELECT content FROM mem WHERE mem MATCH ? ORDER BY rank').all('加班')
    rec('FTS5 全文检索', hits.length > 0 ? 'PASS' : 'FAIL',
      `${hits.length} 条命中${hits.length ? '：' + hits.map((h) => h.content).join(' / ') : ''}`)

    rec('中文分词', 'INFO', 'FTS5 默认 unicode61 对中文按字切分；"加班"能命中说明子串检索可用')
    db.close()
    rec('结论', 'PASS', 'N-API 预编译二进制直接可用，无需 electron-rebuild')
  } catch (e) {
    rec('better-sqlite3', 'FAIL', e.message)
    rec('后续', 'WARN', '若为 NODE_MODULE_VERSION 错误，则预编译方案在本机不成立，M0 需重新评估')
  }

  // ═══ V2: koffi / 三项感知信号 ═══
  section('V2  koffi 调 Win32：三项允许的感知信号是否真的拿得到')
  let w = null
  try {
    w = bindWin32()
    rec('koffi 版本', 'PASS', w.koffi.version)
    rec('gdi32 可加载', w._gdi32Loaded ? 'PASS' : 'WARN', '注意 CreateRectRgn 在 gdi32 而非 user32')

    // 信号 ③：全屏 / 锁屏
    const st = [0]
    const hr = w.SHQueryUserNotificationState(st)
    if (hr === 0) {
      rec('SHQueryUserNotificationState', 'PASS',
        `hr=0  state=${st[0]}  ${QUNS[st[0]] ?? '未知'}  ${SILENCE_SET.has(st[0]) ? '→ 沉默' : '→ 可活动'}`)
    } else {
      rec('SHQueryUserNotificationState', 'FAIL', `hr=${hr}`)
    }

    // 信号 ②：空闲时长
    const lii = { cbSize: 8, dwTime: 0 }
    if (w.GetLastInputInfo(lii)) {
      const idleMs = Number(w.GetTickCount64()) - lii.dwTime
      rec('GetLastInputInfo', 'PASS', `ok=true cbSize=${lii.cbSize} 空闲=${(idleMs / 1000).toFixed(1)}s`)
    } else {
      rec('GetLastInputInfo', 'FAIL', '返回 false —— 检查是否误用了 _Out_（陷阱 ⑤）')
    }
    // 负向对照：证明真的在 marshalling，而不是恰好返回 true
    const bad = { cbSize: 4, dwTime: 0 }
    const badOk = w.GetLastInputInfo(bad)
    rec('负向对照（cbSize=4）', badOk === false ? 'PASS' : 'WARN',
      badOk === false ? '返回 false，证明结构体真被校验 → 调用有效' : '仍返回 true，说明调用可能未真正生效')

    // 信号 ①：前台进程名
    const { proc, pid } = foregroundProcessName(w)
    rec('前台进程名', proc ? 'PASS' : 'FAIL', `pid=${pid} 进程=${proc || '(未取到)'}`)
    if (proc) {
      const mode = classify(proc)
      rec('场景分类', mode !== 'unknown' ? 'PASS' : 'WARN',
        `${proc} → ${MODE_LABEL[mode]}${mode === 'unknown' ? '（不在映射表，需补充）' : ''}`)
    }

    // 全屏交叉验证：前台窗口矩形 vs 显示器矩形
    // 这里刻意同时报告 GetWindowRect 与 DWM 的扩展外框 —— 差额就是 Win10/11 的不可见调整边框，
    // 它会让「拿 GetWindowRect 做像素比对判断全屏」的做法永远判否。
    const hwnd = w.GetForegroundWindow()
    const rect = {}
    if (hwnd && w.GetWindowRect(hwnd, rect)) {
      const hMon = w.MonitorFromWindow(hwnd, 2)
      const mi = { cbSize: 40, rcMonitor: {}, rcWork: {}, dwFlags: 0 }
      if (w.GetMonitorInfoW(hMon, mi)) {
        const rawW = rect.right - rect.left
        const rawH = rect.bottom - rect.top
        const monW = mi.rcMonitor.right - mi.rcMonitor.left
        const monH = mi.rcMonitor.bottom - mi.rcMonitor.top
        rec('显示器物理分辨率', 'INFO', `${monW}x${monH}`)
        rec('前台窗口 GetWindowRect', 'INFO', `${rawW}x${rawH}`)

        const dwm = {}
        const hr2 = w.DwmGetWindowAttributeRect(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, dwm, 16)
        if (hr2 === 0) {
          const dw = dwm.right - dwm.left
          const dh = dwm.bottom - dwm.top
          const inflated = rawW - dw
          rec('DWM 扩展外框（真实可视边界）', 'PASS', `${dw}x${dh}`)
          if (inflated > 0) {
            rec('陷阱：GetWindowRect 比真实边界大', 'PASS',
              `大 ${inflated}px（不可见调整边框）→ 拿它做全屏像素比对会永远判否，必须改用 DWMWA_EXTENDED_FRAME_BOUNDS 或 QUNS`)
          }
          rec('像素比对能否判定全屏', dw === monW && dh === monH
            ? 'INFO' : 'PASS',
            dw === monW && dh === monH
              ? '窗口真实边界 == 显示器 → 该窗口很可能全屏'
              : `不相等（${dw}x${dh} vs ${monW}x${monH}）→ 仅凭几何判定不可靠，以 QUNS 为准`)
        } else {
          rec('DWM 扩展外框', 'WARN', `hr=${hr2}（不回退到 GetWindowRect 做判断）`)
        }
      }
    }
  } catch (e) {
    rec('koffi', 'FAIL', e.message)
    w = null
  }

  // ═══ V3: 透明窗 ═══
  section('V3  透明 + 无边框 + 置顶窗是否正常')
  const WIN_W = 320
  const WIN_H = 320
  const win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    frame: false,                  // 陷阱 ②：Windows 上 transparent 必须配 frame:false
    transparent: true,
    backgroundColor: '#00000000',  // 陷阱 ②：Electron 用 #AARRGGBB（alpha 在前）
    resizable: false,              // 陷阱 ②：resizable:true 可能破坏透明
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  win.center()
  win.showInactive()
  await sleep(800)

  rec('窗口创建', win.isVisible() ? 'PASS' : 'FAIL',
    `${WIN_W}x${WIN_H}  frame=false transparent=true resizable=false`)
  rec('置顶', win.isAlwaysOnTop() ? 'PASS' : 'FAIL', String(win.isAlwaysOnTop()))

  // 自捕获：先证明「渲染真的产出了洋红」，这是后续桌面取证的前提
  const shot = await win.webContents.capturePage()
  const bmp = shot.toBitmap()
  const size = shot.getSize()
  const px = (x, y) => { const i = (y * size.width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]] }
  const RGB_LABEL = ['R', 'G', 'B']
  const isMagenta = ([r, g, b]) => r > 200 && g < 60 && b > 200
  const c0 = px(6, 6)
  rec('渲染产出校验', isMagenta(c0) ? 'PASS' : 'FAIL',
    `左上角 RGB=(${c0.join(',')})${isMagenta(c0) ? ' 洋红 ✓ 渲染正常' : ' 期望洋红 (255,0,255)'}`)
  rec('自捕获的透明度', 'INFO',
    'Chromium 自捕获合成的是不透明位图，因此自捕获无法证明桌面上的透明 —— 见 V4 桌面取证')

  // DPR 污染印证（陷阱 ⑥）
  const rdp = await win.webContents.executeJavaScript('window.devicePixelRatio').catch(() => null)
  const disp = screen.getPrimaryDisplay()
  rec('渲染进程 devicePixelRatio', 'INFO', String(rdp))
  rec('screen.scaleFactor', 'INFO',
    `${disp.scaleFactor}${rdp !== null && rdp !== disp.scaleFactor ? '   ← 两者不同！证实陷阱 ⑥ → Pixi 必须用 resolution:1' : '（本机恰好相同；陷阱 ⑥ 在有文字缩放时才会显现）'}`)

  // ═══ V4: 桌面透明取证 + 遮挡开关 ═══
  section('V4  桌面上的真实透明度 与 遮挡开关')
  const sw = app.commandLine.getSwitchValue('disable-features')
  rec('主进程 disable-features', sw.includes('CalculateNativeWinOcclusion') ? 'PASS' : 'FAIL', sw || '(空)')
  rec('位置要求', 'INFO', '必须在 main.js 顶层；放进 app.whenReady() 里太晚')

  try {
    const onDesktop = await sampleDesktopMagenta(win, disp)
    rec('桌面上能看到探针窗口（纯洋红）', onDesktop ? 'PASS' : 'WARN',
      onDesktop
        ? '是 → 说明窗口真的画在桌面上且未被遮挡节流；同时证明透明窗在不透明区域会正常显示'
        : '否 → 可能被遮挡节流、或窗口不在该显示器上。若配合全屏应用才出现，即为需要靠 disable-features 解决的问题')
  } catch (e) {
    rec('桌面取样', 'WARN', e.message)
  }
  rec('「全屏应用下不变空白」', 'WARN', '需真实全屏应用在场才能验证，脚本无法自动制造 —— 用 XIAOQI_KEEP_OPEN_MS 保留窗口后手工开全屏视频观察')

  // ═══ V5: 一键隐身 ═══
  section('V5  一键隐身：窗口能否真的从屏幕捕获中排除')
  win.setContentProtection(true)
  await sleep(600)
  rec('setContentProtection(true)', 'INFO', '已调用（内部 = SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)）')
  rec('已知开放回归', 'WARN', 'electron#47834（36.3.2 / Win10 19045 仍被截到）；Win11 是否受影响未确认 —— 下方取证就是回答这个问题')

  if (CHECK_CAPTURE) {
    win.setContentProtection(false)
    await sleep(700)
    const visible = await sampleDesktopMagenta(win, disp)
    win.setContentProtection(true)
    await sleep(700)
    const hidden = await sampleDesktopMagenta(win, disp)
    rec('取证前提：未保护时捕获能看到洋红块', visible ? 'PASS' : 'FAIL',
      visible ? '是' : '否 —— 取证无效（窗口没被画出来）')
    if (visible) {
      rec('开启保护后洋红块从捕获中消失', !hidden ? 'PASS' : 'FAIL',
        hidden ? '仍可见 → 该 Electron/Win 组合上【捕获排除不生效】，一键隐身只能靠"隐藏窗口"兜底'
               : '已消失 → 捕获排除生效，隐身可靠')
    }
    rec('注意', 'INFO', '这不是安全保证：手机拍屏依然能拍到（微软官方明确说明）')
  } else {
    rec('捕获取证', 'WARN', '未启用。用 XIAOQI_CHECK_CAPTURE=1 重跑以获得确定结论')
  }

  // ═══ V6: setShape ═══
  section('V6  setShape 在 transparent 窗口上是否生效（仅记录，不作依赖）')
  try {
    // 实测陷阱：Electron 的类型定义写的是 Rectangle（X/Y/Width/Height），
    // 但运行时只接受 小写 {x,y,width,height} —— 大写会抛 conversion failure。
    const full = { x: 0, y: 0, width: WIN_W, height: WIN_H }
    const inner = { x: 40, y: 40, width: WIN_W - 80, height: WIN_H - 80 }
    win.setShape([full, inner])
    await sleep(400)

    const box = {}
    // getNativeWindowHandle() 返回 Buffer，交给 koffi 解码；不要手写 readUInt32LE
    const kind = w.GetWindowRgnBox(win.getNativeWindowHandle(), box)
    rec('setShape([...]) 小写字段', 'PASS', '未抛异常（大写 PascalCase 会失败——实测）')
    rec('GetWindowRgnBox', kind > 1 ? 'PASS' : 'WARN',
      kind > 1
        ? `OS 层窗口区域已生效 (type=${kind}) 外框=(${box.left},${box.top})-(${box.right},${box.bottom})，尺寸 ${box.right - box.left}x${box.bottom - box.top}`
        : `未检测到区域 (type=${kind}；0=ERROR 1=NULLREGION)`)

    win.setShape([])
    await sleep(300)
    const box2 = {}
    const kind2 = w.GetWindowRgnBox(win.getNativeWindowHandle(), box2)
    rec('setShape([]) 复原', kind2 <= 1 ? 'PASS' : 'WARN',
      `type=${kind2}${kind2 <= 1 ? '（已复原为矩形）' : '（仍存在区域）'}`)
    rec('重要限制', 'WARN', '矩形是「并集」，无法挖洞 —— 宠物必须是单一连通轮廓')
  } catch (e) {
    rec('setShape', 'FAIL', String(e && e.message ? e.message : e))
  }

  // ═══ 场景识别表自检 ═══
  section('场景识别表自检（仅用进程名，永不读窗口标题）')
  const all = Object.values(SCENE_MAP).flat()
  const misses = all.filter((p) => classify(p) === 'unknown')
  rec('映射表规模', 'INFO', `${Object.keys(SCENE_MAP).length} 类 / ${all.length} 个进程名`)
  rec('自检命中率', misses.length === 0 ? 'PASS' : 'FAIL', `${all.length - misses.length}/${all.length}`)
  if (misses.length) rec('未命中', 'FAIL', misses.join(', '))
  console.log('  ' + Object.entries(SCENE_MAP).map(([k, v]) => `${MODE_LABEL[k]}(${v.length})`).join('  '))

  // ═══ QUNS 观察窗口（需人工制造全屏条件）═══
  if (KEEP_OPEN_MS > 0 && w) {
    section(`QUNS 观察窗口（${(KEEP_OPEN_MS / 1000).toFixed(0)} 秒）`)
    console.log('  现在请做这几件事，观察下面的 state 是否跳变：')
    console.log('   1.  开一个全屏视频（浏览器 F11 或播放器全屏）→ 期待 state 变成 2')
    console.log('   2.  退出全屏 → 期待回到 5')
    console.log('   3.  Win+L 锁屏会变成 1（但锁屏后你看不到输出，回来检查 JSON 记录）')
    console.log('   4.  顺便看洋红方块：全屏时它是否消失/变黑（这就是遮挡节流要解决的问题）')
    console.log('')
    const timeline = []
    const t0 = Date.now()
    while (Date.now() - t0 < KEEP_OPEN_MS) {
      const s = [0]
      const r = w.SHQueryUserNotificationState(s)
      const prev = timeline.length ? timeline[timeline.length - 1].state : null
      if (s[0] !== prev) {
        const mark = SILENCE_SET.has(s[0]) ? '→ 应静默' : '→ 可活动'
        console.log(`   [${((Date.now() - t0) / 1000).toFixed(1)}s] state=${s[0]}  ${QUNS[s[0]] ?? '未知'}  ${mark}`)
      }
      timeline.push({ t: Date.now() - t0, state: s[0], hr: r })
      await sleep(400)
    }
    const seen = [...new Set(timeline.map((x) => x.state))]
    rec('观察到的 QUNS 状态', seen.length > 1 ? 'PASS' : 'WARN',
      `{${seen.join(', ')}}${seen.length > 1 ? ' → 状态会随全屏切换而跳变，静默策略可行' : ' → 未观察到跳变；若你确实开了全屏应用，说明该路径未能反映'}`)
    fs.writeFileSync(path.join(__dirname, 'quns-timeline.json'), JSON.stringify(timeline, null, 2), 'utf8')
    console.log('   QUNS 时间线已写入 verify/quns-timeline.json')
  } else if (KEEP_OPEN_MS > 0) {
    section('QUNS 观察窗口')
    rec('跳过', 'WARN', 'koffi 未绑定成功，无法观察')
  }

  // ═══ V7: 自动制造全屏，验证 QUNS 跳变与遮挡行为 ═══
  section('V7  自动制造全屏应用，验证 QUNS 是否会跳变（全屏检测的核心前提）')
  if (!w) {
    rec('跳过', 'WARN', 'koffi 未绑定成功')
  } else {
    const mon = screen.getPrimaryDisplay()
    const sampleState = () => { const s = [0]; const hr = w.SHQueryUserNotificationState(s); return { state: s[0], hr } }
    const petBoundsBefore = win.getBounds()

    const baseline = sampleState()
    rec('基线（无全屏应用）', 'INFO', `state=${baseline.state}  ${QUNS[baseline.state] ?? '未知'}`)

    // 造一个真正覆盖整个显示器的全屏窗
    const fsWin = new BrowserWindow({
      x: mon.bounds.x, y: mon.bounds.y, width: mon.size.width, height: mon.size.height,
      frame: false, fullscreen: false, skipTaskbar: true, alwaysOnTop: false, show: false,
      backgroundColor: '#101014',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await fsWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;' +
      'background:#101014;color:#fff;font:600 42px system-ui,\\"Microsoft YaHei\\",sans-serif;' +
      'display:flex;align-items:center;justify-content:center}'
      + '</style></head><body>xiaoqi · M0 fullscreen probe</body></html>'))

    const timeline = []
    const poll = async (label, ms) => {
      const t0 = Date.now()
      const seen = []
      while (Date.now() - t0 < ms) {
        const s = sampleState()
        seen.push(s.state)
        timeline.push({ phase: label, t: Date.now() - t0, ...s })
        await sleep(200)
      }
      const uniq = [...new Set(seen)]
      return uniq
    }

    fsWin.show()
    fsWin.focus()
    await sleep(500)
    // 关键：几何覆盖整屏 **不会** 触发 QUNS_BUSY，必须真的 setFullScreen(true)。
    // 实测对照：无边框+几何覆盖整屏 → state=5；同一窗口 setFullScreen(true) → state=2。
    fsWin.setFullScreen(true)
    await sleep(1200)
    const duringFullscreen = await poll('fullscreen', 2500)
    rec('全屏期间的 QUNS', duringFullscreen.includes(2) || duringFullscreen.includes(3) ? 'PASS' : 'FAIL',
      `state ∈ {${duringFullscreen.join(', ')}}  ${duringFullscreen.map((s) => QUNS[s] ?? s).join(' / ')}`)
    if (duringFullscreen.includes(2) || duringFullscreen.includes(3)) {
      rec('结论', 'PASS', 'QUNS 能真实反映「有全屏应用在跑」→ 全屏自动静默方案成立')
    } else {
      rec('结论', 'FAIL', '真全屏窗在场但 QUNS 未变 → 全屏静默方案需重新设计')
    }

    // 遮挡检查：全屏期间宠物窗是否还在桌面上被画出来
    let occludedResult = null
    try {
      occludedResult = await sampleDesktopMagenta(win, mon)
      rec('全屏覆盖期间能否采到宠物窗', occludedResult ? 'INFO' : 'PASS',
        occludedResult
          ? '仍能采到洋红 —— 但此时全屏窗在它上面，采到的可能是全屏窗内容，此项不作判定'
          : '全屏窗盖住了宠物（预期：此时宠物应已静默/隐藏）')
    } catch (e) {
      rec('遮挡取样', 'WARN', e.message)
    }

    fsWin.setFullScreen(false)
    await sleep(400)
    fsWin.hide()
    await sleep(600)
    const after = await poll('after-hide', 1500)
    rec('退出全屏后的 QUNS', after.includes(5) ? 'PASS' : 'WARN',
      `state ∈ {${after.join(', ')}}  ${after.map((s) => QUNS[s] ?? s).join(' / ')}`)

    const petBoundsAfter = win.getBounds()
    rec('宠物窗几何未被扰动', petBoundsBefore.x === petBoundsAfter.x && petBoundsBefore.y === petBoundsAfter.y
      ? 'PASS' : 'WARN',
      `前 (${petBoundsBefore.x},${petBoundsBefore.y}) → 后 (${petBoundsAfter.x},${petBoundsAfter.y})`)

    fsWin.destroy()
    fs.writeFileSync(path.join(__dirname, 'quns-timeline.json'), JSON.stringify(timeline, null, 2), 'utf8')
    rec('时间线', 'INFO', 'verify/quns-timeline.json')
  }

  // ═══ 汇总 ═══
  section('汇总')
  const tally = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {})
  console.log('  ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('   '))
  const fails = results.filter((r) => r.status === 'FAIL')
  const warns = results.filter((r) => r.status === 'WARN')
  console.log(fails.length
    ? `\n  ❌ 失败 ${fails.length} 项：\n` + fails.map((f) => `     - ${f.name}: ${f.value}`).join('\n')
    : '\n  ❌ 无失败项')
  console.log(warns.length
    ? `\n  ⚠️  待确认 ${warns.length} 项：\n` + warns.map((f) => `     - ${f.name}: ${f.value}`).join('\n')
    : '\n  ⚠️  无待确认项')

  const out = { ranAt: new Date().toISOString(), versions: process.versions, platform: os.release(), results }
  fs.writeFileSync(path.join(__dirname, 'verification-result.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n  结果已写入 verify/verification-result.json')

  if (KEEP_OPEN_MS > 0) {
    console.log(`\n  窗口保留 ${KEEP_OPEN_MS}ms 供手工观察。现在请：`)
    console.log('   1. 开一个全屏视频或游戏，看洋红方块是否消失/变黑')
    console.log('   2. 开录屏/截图，看洋红方块是否被排除在外')
    setTimeout(() => app.quit(), KEEP_OPEN_MS)
  } else {
    setTimeout(() => app.quit(), 300)
  }
}

/** 从桌面捕获里采样窗口中心是否为洋红 —— 判定「桌面上真的画出来了 / 真的被捕获排除了」 */
async function sampleDesktopMagenta(win, disp) {
  const b = win.getBounds()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
  if (!sources.length) return false
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) ?? sources[0]
  const img = src.thumbnail
  const size = img.getSize()
  const sx = size.width / disp.size.width
  const sy = size.height / disp.size.height
  const cx = Math.round((b.x - disp.bounds.x + b.width / 2) * sx)
  const cy = Math.round((b.y - disp.bounds.y + b.height / 2) * sy)
  if (cx < 6 || cy < 6 || cx >= size.width - 6 || cy >= size.height - 6) return false
  const bm = img.toBitmap()
  let hits = 0
  for (let dy = -4; dy <= 4; dy += 2) {
    for (let dx = -4; dx <= 4; dx += 2) {
      const i = ((cy + dy) * size.width + (cx + dx)) * 4
      const [r, g, bl] = [bm[i + 2], bm[i + 1], bm[i]]
      if (r > 180 && g < 90 && bl > 180) hits++
    }
  }
  return hits >= 4
}

// 探针：不透明洋红 + 白色圆环。不透明是刻意的 —— 这样才能用"能否在桌面捕获里看到洋红"
// 来判定捕获排除是否生效。
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;overflow:hidden;width:100%;height:100%;background:transparent}
  .blob{position:absolute;inset:0;background:rgb(255,0,255)}
  .ring{position:absolute;inset:70px;border-radius:50%;border:8px solid rgba(255,255,255,.95)}
  .lbl{position:absolute;left:0;right:0;bottom:26px;text-align:center;
       font:600 13px/1.4 system-ui,"Microsoft YaHei",sans-serif;color:#fff;
       text-shadow:0 1px 3px rgba(0,0,0,.9)}
</style></head><body>
  <div class="blob"></div><div class="ring"></div>
  <div class="lbl">xiaoqi · M0 verify</div>
</body></html>`

app.whenReady().then(() => {
  run().catch((e) => {
    console.error('\n验证脚本自身出错：', e)
    results.push({ name: '脚本异常', status: 'FAIL', value: String(e && e.stack ? e.stack : e) })
    try {
      fs.writeFileSync(path.join(__dirname, 'verification-result.json'),
        JSON.stringify({ ranAt: new Date().toISOString(), crashed: true, error: String(e), results }, null, 2), 'utf8')
    } catch { /* ignore */ }
    app.exit(1)
  })
})

// 刻意不注册 window-all-closed：验证过程会销毁窗口，该事件会导致应用提前退出，
// 使后续检查永远跑不到（诊断时踩过一次）。生命周期由 run() 显式 app.quit() 控制。
