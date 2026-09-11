import { join } from 'node:path'

import { type BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, nativeImage } from 'electron'

import { describeUserNotificationState } from '@shared/geometry'
import { PET_SCALE_DEFAULT, PET_SCALE_STEPS } from '@shared/constants'
import { IPC } from '@shared/ipc'
import type { PetRuntimeState, VisibilityMode } from '@shared/types'

import { targetFrameRate } from './core/frameRate'
import { evidenceDir, runEvidenceCapture, runResizeTest } from './evidence'
import { selfCheckPlatform } from './platform'
import { win32Platform } from './platform/win32'
import { createPetWindow, resolveRendererEntry, trayIconPath } from './window/createPetWindow'
import { PetWindowController } from './window/petWindow'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★★ 这一行必须在 `app.whenReady()` 之前，且必须是唯一一次 appendSwitch ★★★
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 为什么必须有它 ──
 *
 * Chromium 的原生**遮挡追踪**（CalculateNativeWinOcclusion）在全屏应用激活时
 * 会认为该显示器上所有窗口都被遮挡，从而**停止绘制**它们。
 * 后果是：透明置顶的宠物窗口在全屏游戏/视频下会**直接变成空白**——
 * 哪怕 z-order 完全正常、代码里一切"看起来对"。
 *
 * ── 为什么必须是"一次调用、逗号分隔" ──
 *
 * 实测：`appendSwitch('disable-features', ...)` 是**覆盖**语义，不是合并。
 * 连着调两次，`getSwitchValue` 只剩最后一个值。所以要禁用多个特性时
 * 必须合并成一次逗号分隔调用，例如：
 *
 *     app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,Another')
 *
 * ── 为什么必须在顶层 ──
 *
 * Electron 只在**主脚本执行完毕之后**重新初始化 FeatureList。
 * 把这一行放进 `app.whenReady().then(...)` 或任何异步回调里都**太晚**，
 * 开关不会生效，而且不会报错——这是最典型的"静默失效"。
 *
 * 上面这三条由 eslint 的自定义规则 `xiaoqi/disable-features-invariants`
 * 自动校验（见 eslint.config.mjs），因此未来有人重构这个文件时会被拦住。
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// 宠物是常驻小工具，不应该因为"所有窗口都关了"就退出——
// 它没有主窗口，托盘才是它的常驻入口。
// ⚠️ 注意：**不要**在这里注册 `window-all-closed` 处理器来 quit，
// 否则隐藏宠物窗口会顺手把应用杀掉（verify 踩过这个坑）。

let petWindow: BrowserWindow | null = null
let controller: PetWindowController | null = null
let tray: Tray | null = null

/** 全局快捷键：一键隐身（防社死底线，施工令 §9.4）。 */
const HIDE_ACCELERATOR = 'CommandOrControl+Shift+H'
/** 恢复显示。用户被围观后需要能把它叫回来。 */
const SHOW_ACCELERATOR = 'CommandOrControl+Shift+J'

function log(message: string): void {
  // 开发期日志。绝不打印任何用户内容——本应用也读不到内容（§1.1）。
  console.log(`[xiaoqi] ${message}`)
}

function runtimeState(): PetRuntimeState {
  if (!controller) {
    throw new Error('runtimeState() 在 controller 初始化之前被调用')
  }
  const mode = controller.mode
  return {
    mode,
    cursorRoute: controller.cursorRoute,
    workArea: controller.currentWorkArea(),
    frameRate: targetFrameRate(controller.frameBudgetSnapshot),
    scale: controller.scale,
    // 视线跟随用的光标位置（设计空间坐标）。够远时为 null，眼睛回正。
    cursor: controller.cursorInDesignSpace(),
  }
}

function broadcastState(): void {
  if (!petWindow || petWindow.isDestroyed() || !controller) return
  petWindow.webContents.send(IPC.stateChanged, runtimeState())
  refreshTrayMenu()
}

/**
 * 托盘右键菜单。
 *
 * 托盘是桌宠的**主控制面**（它没有主窗口），所以"恢复"类操作必须都在这里，
 * 尤其是**恢复点击**——那是 electron#49982 卡死穿透状态的唯一出口。
 */
function refreshTrayMenu(): void {
  if (!tray || !controller) return

  const mode = controller.mode
  const isHidden = mode === 'hidden'

  const menu = Menu.buildFromTemplate([
    {
      label: isHidden ? '显示小奇' : '隐藏小奇（隐身）',
      click: () => {
        controller?.setManualMode(isHidden ? 'active' : 'hidden')
      },
    },
    {
      label: '静默（缩成小点，仍然可见）',
      type: 'radio',
      checked: mode === 'silent',
      click: () => {
        controller?.setManualMode('silent')
      },
    },
    {
      label: '恢复正常形态',
      type: 'radio',
      checked: mode === 'active',
      click: () => {
        controller?.setManualMode('active')
      },
    },
    { type: 'separator' },
    {
      label: '恢复点击（宠物点不到时用）',
      click: () => {
        controller?.recoverClickThrough()
      },
    },
    {
      label: '回到默认位置',
      click: () => {
        controller?.placeAtDefaultPosition()
      },
    },
    {
      // 大小做成**档位**而不是滑块：托盘菜单里滑块不好用（拖动体验差、
      // 无法显示当前档），而档位一眼看得出选中的是哪个。
      label: '大小',
      submenu: PET_SCALE_STEPS.map((step) => ({
        label:
          step === 1
            ? `${String(Math.round(step * 100))}%（默认）`
            : `${String(Math.round(step * 100))}%`,
        type: 'radio' as const,
        checked: Math.abs((controller?.scale ?? 1) - step) < 0.001,
        click: () => {
          controller?.setScale(step)
          refreshTrayMenu()
        },
      })),
    },
    { type: 'separator' },
    {
      label: `全局快捷键：${HIDE_ACCELERATOR} 隐身 / ${SHOW_ACCELERATOR} 显示`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: `当前：${describeMode(mode)} · QUNS=${String(
        win32Platform.queryUserNotificationState(),
      )}（${describeUserNotificationState(win32Platform.queryUserNotificationState())}）`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '退出小奇',
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setContextMenu(menu)
  tray.setToolTip(`小奇 · ${describeMode(mode)}`)
}

function describeMode(mode: VisibilityMode): string {
  switch (mode) {
    case 'active':
      return '正常'
    case 'silent':
      return '静默'
    case 'hidden':
      return '隐身'
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath())
  tray = new Tray(icon)
  tray.setToolTip('小奇')
  // 双击托盘切换显隐——用户被围观时最顺手的动作。
  tray.on('double-click', () => {
    if (!controller) return
    controller.setManualMode(controller.mode === 'hidden' ? 'active' : 'hidden')
  })
  refreshTrayMenu()
}

function registerShortcuts(): void {
  const hideOk = globalShortcut.register(HIDE_ACCELERATOR, () => {
    log(`快捷键 ${HIDE_ACCELERATOR} → 隐身`)
    controller?.setManualMode('hidden')
  })
  if (!hideOk) {
    // 注册失败必须**说出来**——静默失败会让用户以为"按了没反应是宠物坏了"。
    log(`⚠️ 全局快捷键 ${HIDE_ACCELERATOR} 注册失败（可能被其他应用占用）`)
  }

  const showOk = globalShortcut.register(SHOW_ACCELERATOR, () => {
    log(`快捷键 ${SHOW_ACCELERATOR} → 显示`)
    controller?.setManualMode('active')
  })
  if (!showOk) {
    log(`⚠️ 全局快捷键 ${SHOW_ACCELERATOR} 注册失败（可能被其他应用占用）`)
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.stateGet, () => runtimeState())

  ipcMain.handle(IPC.modeSet, (_event, mode: unknown) => {
    if (mode !== 'active' && mode !== 'silent' && mode !== 'hidden') {
      throw new Error(`非法的形态值：${String(mode)}`)
    }
    log(`渲染进程请求切换形态 → ${mode}`)
    controller?.setManualMode(mode)
    return runtimeState()
  })

  ipcMain.handle(IPC.scaleSet, (_event, raw: unknown) => {
    const scale = Number(raw)
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error(`非法的缩放值：${String(raw)}`)
    }
    log(`渲染进程请求缩放 → ${String(scale)}`)
    controller?.setScale(scale)
    refreshTrayMenu()
    return runtimeState()
  })

  ipcMain.on(IPC.petInteract, () => {
    log('用户点了宠物')
    // M1 没有业务逻辑：这里只记录互动。M2 起接入状态机。
  })

  ipcMain.on(IPC.petAnimating, (_event, isAnimating: unknown) => {
    controller?.setAnimating(isAnimating === true)
  })

  // 渲染进程的未捕获错误（含堆栈）。见 shared/ipc.ts 里 rendererError 的注释。
  // 用 sendSync 的接收端：`event.returnValue` 必须赋值，否则渲染进程会挂住。
  ipcMain.on(IPC.rendererError, (event, message: unknown, stack: unknown) => {
    log(`[renderer:uncaught] ${String(message)}`)
    for (const line of String(stack).split('\n')) {
      log(`   ${line.trim()}`)
    }
    event.returnValue = null
  })
}

/**
 * 缩放透明度实测（仅当 `XIAOQI_RESIZE_TEST=<缩放倍数>` 时启用）。
 *
 * 用来回答一个规格里没有答案的问题：**运行期用 `setBounds` 改一个
 * `transparent` 窗口的尺寸，会不会破坏透明？**
 * 这是"宠物可缩放"能否用方案 B（真改窗口尺寸）的前提。
 */
async function runResizeTestIfRequested(): Promise<void> {
  const raw = process.env.XIAOQI_RESIZE_TEST
  if (!raw || !petWindow) return

  const scale = Number(raw)
  if (!Number.isFinite(scale) || scale <= 0) return

  log(`开始缩放实测：scale=${String(scale)}`)
  try {
    const lines = await runResizeTest(petWindow, scale)
    for (const line of lines) log(`  ${line}`)
  } catch (error) {
    log(`⚠️ 缩放实测失败：${String(error)}`)
  }

  if (!process.env.XIAOQI_KEEP_OPEN_MS) app.quit()
}

function bootstrap(): void {
  // 先跑平台层冒烟自检。原生 FFI 的库名/函数名写错会在模块求值期就崩，
  // 而报错不会告诉你"库名写错了"——所以这里主动调用一次并把结果喊出来。
  const check = selfCheckPlatform(win32Platform)
  for (const message of check.messages) log(message)
  if (!check.ok) {
    log('⚠️ 平台层自检失败：全屏自动静默在本机不可用（其余功能不受影响）。')
  }

  // ⚠️ 必须是 `.cjs`，与 electron.vite.config.ts 里 preload 的
  //    `entryFileNames: '[name].cjs'` 对应。
  //    沙箱化的 preload 不支持 ESM，所以不能产成 `.mjs`——
  //    那样 preload 会静默不执行，`window.xiaoqi` 不存在，
  //    而报错会出现在渲染进程里一个看起来无关的地方。
  const preloadPath = join(__dirname, '../preload/index.cjs')

  petWindow = createPetWindow({ preloadPath, scale: PET_SCALE_DEFAULT })
  controller = new PetWindowController({
    window: petWindow,
    platform: win32Platform,
    onStateChanged: broadcastState,
    logger: log,
  })

  controller.placeAtDefaultPosition()

  const entry = resolveRendererEntry()
  if (entry.url) {
    void petWindow.loadURL(entry.url)
  } else if (entry.file) {
    void petWindow.loadFile(entry.file)
  }

  petWindow.once('ready-to-show', () => {
    controller?.start()
    log(`宠物已就绪。形态=${controller?.mode ?? '?'}`)
    log(`系统状态：${describeUserNotificationState(win32Platform.queryUserNotificationState())}`)

    // 渲染进程的报错必须**冒到主进程日志**，否则"宠物不显示"会变成一个
    // 完全没有线索的故障——本机 web_fetch 不可用、DevTools 又会破坏透明窗，
    // 没有这条日志就只能靠猜。
    // 注意 Electron 44 的新签名：参数在 event 对象上，不是位置参数。
    petWindow?.webContents.on('console-message', (details) => {
      if (details.level === 'error' || details.level === 'warning' || details.level === 'info') {
        log(`[renderer:${details.level}] ${details.message}`)
      }
    })
    petWindow?.webContents.on('render-process-gone', (_e, details) => {
      log(`⚠️ 渲染进程退出：${details.reason}（exitCode=${String(details.exitCode)}）`)
    })
    petWindow?.webContents.on('preload-error', (_e, preloadPath, error) => {
      log(`⚠️ preload 加载失败：${preloadPath} → ${error.message}`)
    })

    // 先跑缩放实测，再跑常规取证。
    // ⚠️ 顺序很重要：缩放实测结束后要把窗口恢复原尺寸，否则常规取证的
    //    "保护关闭"那张会拍到已经缩放过的窗口，两张图不可比。
    void runResizeTestIfRequested().then(() => runEvidenceIfRequested())
    scheduleKeepOpen()
  })

  // 窗口关闭只是隐藏——宠物不该被"关掉"，只有托盘退出才真的退出。
  petWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      controller?.setManualMode('hidden')
    }
  })

  registerIpc()
  createTray()
  registerShortcuts()
}

let isQuitting = false

/**
 * 开发期取证（仅当 `XIAOQI_EVIDENCE_DIR` 有值时启用）。
 *
 * 走**桌面捕获**而不是自捕获：Chromium 自捕获合成的是不透明位图，
 * 证明不了透明窗，也证明不了捕获排除——自捕获永远看得到自己。
 */
async function runEvidenceIfRequested(): Promise<void> {
  if (!evidenceDir() || !petWindow) return

  log('开始取证（XIAOQI_EVIDENCE_DIR 已设置）…')
  try {
    const files = await runEvidenceCapture(petWindow)
    for (const file of files) log(`  取证写入 ${file}`)
    log('取证完成。注意：捕获排除**不是安全特性**，手机拍屏依然拍得到。')
  } catch (error) {
    log(`⚠️ 取证失败：${String(error)}`)
  }

  // 取证完就退出，避免留一个宠物窗口给后续自动化添乱。
  if (!process.env.XIAOQI_KEEP_OPEN_MS) {
    app.quit()
  }
}

/**
 * 保留窗口一段时间供**人工**观察（`XIAOQI_KEEP_OPEN_MS=20000`）。
 *
 * 这是施工令 §5 明确要求的用法：本机脚本无法自己制造"真实全屏应用"，
 * 所以「全屏下宠物是否变空白」只能靠人开着全屏视频肉眼看。
 * 与 `verify/` 的同名环境变量保持一致，避免两套习惯。
 */
function scheduleKeepOpen(): void {
  const raw = process.env.XIAOQI_KEEP_OPEN_MS
  if (!raw) return
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return

  log(`窗口将保留 ${String(ms)}ms 供人工观察，随后自动退出。`)
  log('请在这段时间内打开全屏视频/游戏，观察宠物是否变空白。')
  setTimeout(() => {
    log('保留时间结束，退出。')
    app.quit()
  }, ms)
}

// 单实例锁：桌宠是常驻的，开第二个实例会得到两只宠物 + 两套托盘图标，
// 且全局快捷键会冲突。第二个实例直接把已有实例叫出来。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    log('检测到第二个实例，改为显示已有宠物')
    controller?.setManualMode('active')
  })

  app.whenReady().then(
    () => {
      bootstrap()
    },
    (error: unknown) => {
      console.error('[xiaoqi] 启动失败', error)
      app.exit(1)
    },
  )
}

// ⚠️ 刻意**不注册** `window-all-closed` 处理器。
// 宠物窗口隐藏/关闭不应该结束应用；退出只由托盘菜单或 app.quit() 触发。
// （verify/main.mjs 曾因为注册它而让诊断流程被提前杀掉。）

app.on('will-quit', () => {
  isQuitting = true
  // 退出顺序与启动严格逆序：先注销全局快捷键，再停轮询，最后销毁托盘与窗口。
  globalShortcut.unregisterAll()
  controller?.dispose()
  tray?.destroy()
  tray = null
})
