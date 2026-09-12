import { join } from 'node:path'

import {
  type BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
} from 'electron'

import { describeUserNotificationState } from '@shared/geometry'
import { PET_SCALE_DEFAULT, PET_SCALE_STEPS } from '@shared/constants'
import { IPC } from '@shared/ipc'
import type { DisturbLevel, Emotion, PetRuntimeState, VisibilityMode } from '@shared/types'

import { decidePanelLog, stateFingerprint } from './core/debugPanel'
import { resolveDisturbLevel } from './core/disturbGate'
import { targetFrameRate } from './core/frameRate'
import { Perception, type PerceivedState } from './core/perception'
import { evidenceDir, runEvidenceCapture, runResizeTest } from './evidence'
import { MemoryService } from './memory/service'
import { selfCheckPlatform } from './platform'
import { win32Platform } from './platform/win32'
import { createPetWindow, resolveRendererEntry, trayIconPath } from './window/createPetWindow'
import { createLedgerWindow, resolveLedgerEntry } from './window/ledgerWindow'
import { createProbeWindow, resolveProbeEntry } from './window/probeWindow'
import { PetWindowController } from './window/petWindow'
import { loadWindowState, savePosition, saveScale } from './window/windowState'

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
/** 记忆账本窗口（单例）。见 `openLedger()`。 */
let ledgerWindow: BrowserWindow | null = null

/**
 * preload 产物路径。
 *
 * ⚠️ 必须是 `.cjs`，与 electron.vite.config.ts 里 preload 的
 *    `entryFileNames: '[name].cjs'` 对应。
 *    沙箱化的 preload 不支持 ESM，所以不能产成 `.mjs`——
 *    那样 preload 会静默不执行，`window.xiaoqi` 不存在，
 *    而报错会出现在渲染进程里一个看起来无关的地方。
 *
 * 提到模块作用域是因为**两个窗口共用它**（宠物窗口与记忆账本窗口）。
 */
const PRELOAD_PATH = join(__dirname, '../preload/index.cjs')

/**
 * 感知器：三项信号 → 工作模式 / 生理 / 情绪。
 *
 * 它在 M2 才被接进运行时。在此之前 `core/perception.ts` 只有测试在跑，
 * 应用起来时并没有真的在采样。
 */
let perception: Perception | null = null

/**
 * 调试面板开关（施工令 §5 M2 要求「一个实时打印当前状态的调试面板，
 * 开发期用，可被设置项关闭」）。
 *
 * 默认在开发期开启、打包后关闭；`XIAOQI_DEBUG_STATE=1/0` 可强制覆盖。
 * 它打到**主进程日志**而不是屏幕上——因为我们刻意不去截屏或叠加窗口，
 * 而日志既能被自动化验证读取，又不打扰用户。
 */
const DEBUG_STATE_ENABLED =
  process.env.XIAOQI_DEBUG_STATE === '1' ||
  (process.env.XIAOQI_DEBUG_STATE !== '0' && !app.isPackaged)

/**
 * 记忆（M3）。
 *
 * 它在 `bootstrap()` 里被创建。若数据库打不开，`MemoryService` 会自己降级成
 * 空实现并记一行诊断——**记忆不可用不该让宠物起不来**。
 */
let memory: MemoryService | null = null

/**
 * 记忆数据库路径。与 `window-state.json` 同目录（`%APPDATA%\xiaoqi`）。
 *
 * 用 `userData` 而不是自拼 `%APPDATA%`：路径随平台与打包形态变化，
 * Electron 已经把这件事算对了。
 * `XIAOQI_MEMORY_DB` 可覆盖，供验证脚本指向临时库。
 */
function memoryDbPath(): string {
  return process.env.XIAOQI_MEMORY_DB ?? join(app.getPath('userData'), 'memory.db')
}

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
    // 只推**推断结果**，不推原始感知输入（进程名、空闲时长）。
    // 渲染层只需要知道"该摆什么表情"，把原始信号推过去既无用又扩大暴露面。
    workMode: perception?.snapshot?.workMode ?? 'rest',
    emotion: perception?.snapshot?.emotion.emotion ?? 'calm',
    disturbLevel: currentDisturbLevel(),
    // 关系基调（只影响表现，不影响是否回应）。
    mood: perception?.snapshot?.mood ?? 'reserved',
  }
}

/**
 * 求当前打扰级别。
 *
 * M2 只把它算出来并展示（调试面板/渲染层），**还没有任何主动行为去消费它**
 * ——表达层要等 M5。这样安排是有意的：先把"能不能打扰"的判定做对并可见，
 * 等真正会说话的模块进来时，它只能走这个闸门。
 */
function currentDisturbLevel(): DisturbLevel {
  const snapshot = perception?.snapshot
  if (!snapshot || !controller) return 'silent'
  return resolveDisturbLevel({
    mode: snapshot.workMode,
    notificationState: snapshot.notificationState,
    // 主动度：M2 还没有用户配置，先用默认的"低"。
    // 注意 0.15 低于两个门槛（0.6 / 0.75），因此**默认永远不主动**。
    proactiveness: 0.15,
    // 勿扰时段同样要等 M6 的配置界面；M2 先固定为"不在勿扰时段"。
    inDoNotDisturbWindow: false,
    visibility: controller.mode,
  })
}

/**
 * 调试面板的节流状态。
 *
 * ⚠️ 判定逻辑**不在这里**——它在 `core/debugPanel.ts`，是纯函数、有单测。
 *    面板最初每拍打一行，加上取证用的 `XIAOQI_PERCEPTION_INTERVAL_MS` 之后
 *    变成每秒约 4 行，第一次跑就淹了整份日志。
 *    把"该不该打"抽出去之后，"会不会又淹"就成了可断言的事。
 */
let lastPanelFingerprint = ''
let lastPanelAt = 0

/** 调试面板：把当前状态打一行到日志。 */
function logPerceivedState(state: PerceivedState): void {
  if (!DEBUG_STATE_ENABLED) return

  const level = currentDisturbLevel()
  const fingerprint = stateFingerprint(state, level)
  const decision = decidePanelLog({
    fingerprint,
    now: Date.now(),
    lastFingerprint: lastPanelFingerprint,
    lastLoggedAt: lastPanelAt,
  })
  if (!decision.shouldLog) return
  lastPanelFingerprint = fingerprint
  lastPanelAt = Date.now()

  const p = state.physiology
  // 保留一位小数：生理量每小时只变几个百分点，整数会把变化抹平，
  // 让"它在动"与"它卡住了"看起来一样。
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

  if (decision.isHeartbeat) {
    // 心跳只需要证明"它还活着、量还在动"，所以压成一行。
    // 压成一行是有理由的：心跳每 30 秒一次，展开成八行会在长时间运行时
    // 把日志撑得很难翻。
    log(
      `[状态]（心跳）+${String(Math.round(state.uptimeMs / 1000))}s ` +
        `精力 ${pct(p.energy)} 饥饿 ${pct(p.hunger)} 无聊 ${pct(p.boredom)} 社交 ${pct(p.social)}｜` +
        `好感 ${pct(state.relationship.affection)} 默契 ${pct(state.relationship.rapport)}｜基调 ${state.mood}`,
    )
    return
  }

  // ★ 状态**变化**时打完整的调试面板，而不是压成一行。
  //
  // 这里踩过一个坑：最初变化时也只打那一行压缩摘要，于是
  // 「一个实时打印当前状态的调试面板」（施工令 §5 M2）实际上
  // **看不到大部分状态**——尤其是新加的关系层，一行都没有，
  // 而"面板在正常工作"这个假象还很难被发现（日志明明有输出）。
  // 是 `scripts/verify-m2.mjs` 逐项核对面板里该有哪些字段时抓出来的。
  //
  // 完整面板直接复用 `perception.describe()`：那是**唯一**一份
  // 格式化逻辑，不要在日志这边再写一套（两套迟早会漂移，
  // 而且"日志里少了一项"这种偏差几乎不可能被注意到）。
  const full = perception?.describe()
  if (full && full.length > 0) {
    log(`[状态] +${String(Math.round(state.uptimeMs / 1000))}s`)
    for (const line of full) log(`   ${line}`)
    return
  }

  // 拿不到 `perception`（理论上不该发生）时退回压缩格式，至少不丢信息。
  log(
    `[状态] +${String(Math.round(state.uptimeMs / 1000))}s ` +
      `${state.processName ?? '（拿不到进程）'} → ${state.workMode}｜情绪 ${state.emotion.emotion}｜` +
      `打扰 ${level}｜精力 ${pct(p.energy)} 饥饿 ${pct(p.hunger)} 无聊 ${pct(p.boredom)} 社交 ${pct(p.social)}｜` +
      `空闲 ${state.idleMs === null ? '?' : String(Math.round(state.idleMs / 1000))}s｜QUNS=${String(state.notificationState)}`,
  )
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
      // 记忆账本（§5 M3）。放在"恢复点击"之上：用户想查看/清理记忆时
      // 通常正被某件事困扰（"它怎么记得这个？"），应当一眼能找到。
      label: '它记得什么…',
      click: () => {
        openLedger()
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
    saveScale(scale)
    refreshTrayMenu()
    return runtimeState()
  })

  // 拖动：渲染进程按下时给一个光标相对窗口的偏移，主进程按它跟随光标。
  ipcMain.on(IPC.dragStart, (_event, offset: unknown) => {
    const o = offset as { x?: unknown; y?: unknown } | undefined
    if (!o || typeof o.x !== 'number' || typeof o.y !== 'number') return
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return
    controller?.beginDrag({ x: o.x, y: o.y })
  })

  ipcMain.on(IPC.dragEnd, () => {
    controller?.endDrag()
  })

  ipcMain.on(IPC.petInteract, () => {
    log('用户点了宠物')
    // 「无条件回应」（ADR-0003）的落地：**用户一伸手就必有反应**，
    // 与形态、打扰级别、工作模式、是否"被冷落"全都无关。
    // 这里做三件事：
    //   ① 记一次互动 → 影响生理（社交欲回落）；
    //   ② 闪一下"惊讶/被注意到"的表情 → 立即可见的回应；
    //   ③ 记进记忆 → 这是情景记忆唯一的来源（M3）。
    perception?.noteInteraction()
    perception?.flashEmotion('surprised')
    recordInteractionMemory()
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

  // ── 记忆账本（M3）──
  //
  // 记忆**内容**会经过这几条通道送往渲染进程（账本要显示它）。
  // 这是必须的——账本的意义就是"让用户看见它记住了什么"。
  // 但内容**不进日志**：日志是无意的留痕渠道，界面是用户主动打开的。

  ipcMain.handle(IPC.memoryList, (_event, query: unknown) => {
    const text = typeof query === 'string' && query.trim().length > 0 ? query.trim() : undefined
    return memory?.listLedger(text) ?? []
  })

  ipcMain.handle(IPC.memoryForget, (_event, raw: unknown) => {
    const id = Number(raw)
    if (!Number.isInteger(id)) throw new Error(`非法的记忆 id：${String(raw)}`)
    // 返回值如实反映"有没有真的从库里删掉"——这是对用户的承诺（§1.2⑪）。
    return memory?.forget(id) ?? false
  })

  ipcMain.handle(IPC.memoryForgetAll, () => memory?.forgetAll() ?? 0)

  ipcMain.handle(IPC.memoryRemember, (_event, raw: unknown) => {
    if (typeof raw !== 'string') throw new Error('记忆内容必须是字符串')
    const content = raw.trim()
    // 空内容不写库：它会在账本里显示成一条空白，并让升级聚类多出一个噪声主题。
    if (content.length === 0) return null
    return memory?.remember(content) ?? null
  })
}

/**
 * 渲染探针窗口（仅当 `XIAOQI_MESH_PROBE=1`）。
 *
 * ── 为什么它是一个**真的窗口**而不是渲染进程里的一段脚本 ──
 *
 * 要验证的是"Mesh + 自定义 GLSL 在**透明置顶窗**下能否工作"。
 * 透明、置顶、无边框这些是**窗口属性**，只有真的开一个那样的窗口才验得到。
 * 在普通窗口里跑通不能外推——本项目在"透明窗 + 渲染特性"上踩过的坑
 * （DevTools 让窗口不透明、遮挡追踪让窗口空白）全都是**窗口属性**引起的。
 *
 * 与 `XIAOQI_RESIZE_TEST` / `XIAOQI_OPEN_LEDGER_MS` 同类：只给取证用。
 */
function openMeshProbeIfRequested(): void {
  if (process.env.XIAOQI_MESH_PROBE !== '1') return

  log('（取证）打开渲染探针窗口')
  const window = createProbeWindow()

  const entry = resolveProbeEntry()
  if (entry.url) {
    void window.loadURL(entry.url)
  } else if (entry.file) {
    void window.loadFile(entry.file)
  }
}

/**
 * 打开记忆账本（§5 M3：可见、可删、可一键清空、可手动记住/忘掉）。
 *
 * ── 为什么是单例窗口 ──
 *
 * 连点两次托盘菜单不该开出两个账本窗口。已有窗口就 `focus()`——
 * 这也顺带处理了"窗口被最小化"的情况（`restore()` 再 `focus()`）。
 *
 * ⚠️ 账本窗口**不**受 `isQuitting` 那套"关闭即隐藏"逻辑管：
 *    它是普通窗口，用户点 X 就应该真的关掉。宠物窗口才需要"关不掉"。
 */
function openLedger(): void {
  if (!memory) {
    log('⚠️ 记忆不可用，无法打开账本')
    return
  }

  if (ledgerWindow && !ledgerWindow.isDestroyed()) {
    if (ledgerWindow.isMinimized()) ledgerWindow.restore()
    ledgerWindow.focus()
    return
  }

  log('打开记忆账本')
  const window = createLedgerWindow({ preloadPath: PRELOAD_PATH })
  ledgerWindow = window

  const entry = resolveLedgerEntry()
  if (entry.url) {
    void window.loadURL(entry.url)
  } else if (entry.file) {
    void window.loadFile(entry.file)
  }

  window.once('ready-to-show', () => {
    window.show()
  })

  // 用户关掉窗口就销毁，下次再开是新的——账本没有"隐藏起来备用"的必要，
  // 留着只会让"我现在看到的是不是最新状态"变得不确定。
  window.on('closed', () => {
    ledgerWindow = null
  })
}

/**
 * 监听系统电源/会话事件（施工令 §5 M2 的「**事件驱动**」）。
 *
 * ── 为什么光有轮询不够 ──
 *
 * 轮询解决的问题是"多久看一眼"，它解决不了"这一眼与上一眼之间机器睡着了"。
 * 合盖 8 小时再打开，`tick()` 算出 `elapsedMs = 8 小时`，
 * 于是生理按"用户连续工作 8 小时"推进——精力归零、饥饿拉满，
 * 宠物一睁眼就是快饿死的委屈样。
 *
 * ★ 这不只是观感问题：它**凭空造出了一段不存在的用户行为**，
 *   而 §1.2⑦ 明令「宠物不衡量用户」。所以这是一个必须显式处理的正确性问题，
 *   不是打磨项。
 *
 * `Perception.tick()` 里另有一道**时间跳变兜底**（间隔超过 5 分钟即判定休眠）——
 * 两道防线是刻意的：事件在某些平台/某些休眠形态下会漏，
 * 而漏掉的后果是"宠物凭空受了一天罪"，代价不对称。
 */
function registerPowerEvents(): void {
  // 恢复：把"上一次采样到现在"这段间隔显式交给感知器判定。
  // 不让它传 `Infinity` 是因为感知器的入参约定是"真实毫秒数"，
  // 用一个哨兵值会让那个函数多一条只有调用方知道的隐含分支。
  // 这里直接算真实的 `now - lastSampleAt`，感知器按 5 分钟阈值自己判定。
  const compensate = (why: string): void => {
    const gap = Date.now() - (perception?.lastSampleAt ?? Date.now())
    perception?.noteSuspend(gap)
    log(`${why} → 已补偿（间隔 ${String(Math.round(gap / 1000))}s，生理不按"连续工作"推进）`)
    broadcastState()
  }

  // 合盖/睡眠后恢复。
  powerMonitor.on('resume', () => {
    compensate('系统从休眠中恢复')
  })

  // 锁屏/解锁同样属于"用户不在"。只处理解锁——锁屏那一刻用户还在，
  // 且随后必然还有一次 tick 把间隔记上。
  powerMonitor.on('unlock-screen', () => {
    compensate('屏幕已解锁')
  })
}

/**
 * 启动后自动打开记忆账本（仅当 `XIAOQI_OPEN_LEDGER_MS=<延迟毫秒>`）。
 *
 * ── 为什么需要这个开关 ──
 *
 * 账本只能从**托盘菜单**打开，而本机没有可自动化的输入通道去点托盘菜单
 * （托盘是 shell 的，不属于我们的窗口树，CDP 也够不着）。
 * 没有这个开关，"账本界面长什么样"就既截不了图也验不了证——
 * 而施工令 §5 M3 明确要求账本截图作为证据。
 *
 * 与 `XIAOQI_FORCE_EMOTION` / `XIAOQI_RESIZE_TEST` 同类：**只给取证用**，
 * 生产不要设。它走的正是托盘菜单调的同一个 `openLedger()`，
 * 因此验证覆盖的是真实路径，不是一个"专供测试的分支"。
 */
function scheduleLedgerIfRequested(): void {
  const raw = process.env.XIAOQI_OPEN_LEDGER_MS
  if (!raw) return
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) return

  setTimeout(() => {
    log('（取证）自动打开记忆账本')
    openLedger()
  }, ms)
}

/**
 * 把一次互动记成情景记忆（M3）。
 *
 * ── 为什么标签用**工作模式** ──
 *
 * `promote.ts` 用标签做聚类键，所以标签要能代表"这是哪一类事"。
 * 工作模式（加班 / 编码 / 会议 / 周末 …）正好是这样一个维度：
 * 它是**推断结果**而不是感知原文（不推进程名、不推空闲时长），
 * 既符合 §1.1 的感知边界，又能让"用户经常在加班时来找我"
 * 这类事实自然浮现。
 *
 * ⚠️ 记录的内容**不含任何感知原文**：只有"用户来互动了"这一事实
 *    加上当时的工作模式。进程名、空闲时长这些原始信号永不入记忆。
 */
function recordInteractionMemory(): void {
  if (!memory) return
  const snapshot = perception?.snapshot
  if (!snapshot) return

  memory.recordEpisode(`用户在「${snapshot.workMode}」时来找我玩`, [
    'interaction',
    snapshot.workMode,
  ])
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
  const preloadPath = PRELOAD_PATH

  // 恢复上次的缩放与位置。
  // 顺序很重要：**先缩放再定位**——窗口尺寸变了以后，保存的左上角坐标
  // 对应的可见区域也会变；先定尺寸再放位置，结果才与用户上次看到的一致。
  const saved = loadWindowState()
  const startScale = saved.scale ?? PET_SCALE_DEFAULT

  petWindow = createPetWindow({ preloadPath, scale: startScale })
  controller = new PetWindowController({
    window: petWindow,
    platform: win32Platform,
    onStateChanged: broadcastState,
    logger: log,
  })

  controller.setScale(startScale)
  // 位置校验失败（例如拔了副屏）会自动退回默认位置。
  if (!saved.position || !controller.restorePosition(saved.position)) {
    controller.placeAtDefaultPosition()
  }

  // 拖动结束 → 持久化位置。放在这里而不是控制器内部，
  // 是为了让"窗口控制器"保持不碰文件系统的职责边界。
  controller.onDragEnd((position) => {
    savePosition(position)
  })

  // ── 记忆（M3）──
  //
  // 放在感知之前：`start()` 只打开数据库，不读感知；但记情景记忆时
  // 要读 `perception.snapshot` 拿工作模式，所以实例必须先于互动存在。
  // `MemoryService.start()` 自己处理"数据库打不开"的情况——它会降级成
  // 空实现并记一行诊断，绝不抛出去把启动流程打断。
  memory = new MemoryService({ dbPath: memoryDbPath(), onDiagnostic: log })
  const memoryStatus = memory.start()
  log(
    memoryStatus.available
      ? `记忆已就绪（${String(memoryStatus.total)} 条）`
      : `⚠️ 记忆不可用：${memoryStatus.reason ?? '未知原因'}（宠物照常工作，只是不记事）`,
  )

  // ── 感知 ──
  //
  // 它在主进程里跑、以 2 秒一拍读三项信号。刻意**低频**：
  // 工作模式的变化是分钟级的，而施工令 §4.3⑩ 明确「耗电是隐形差评源」。
  //
  // `XIAOQI_PERCEPTION_INTERVAL_MS` 只给取证用：生理量每小时只变几个百分点，
  // 用默认 2 秒间隔在短时间窗里根本看不出它在动。生产不要设这个变量。
  const intervalOverride = Number(process.env.XIAOQI_PERCEPTION_INTERVAL_MS)
  perception = new Perception({
    platform: win32Platform,
    onState: (state) => {
      logPerceivedState(state)
      // 推断结果变了就推给渲染层（它按情绪摆表情、按打扰级别决定要不要冒泡）。
      broadcastState()
    },
    ...(Number.isFinite(intervalOverride) && intervalOverride > 0
      ? { intervalMs: intervalOverride }
      : {}),
  })
  perception.start()

  // 取证用：锁死情绪，便于逐个截图核对八种表情。
  // 真实情绪变化很慢（精力一小时才掉几个百分点），不锁的话没法比对。
  const forced = process.env.XIAOQI_FORCE_EMOTION
  if (forced) {
    log(`⚠️ 情绪已锁定为 ${forced}（XIAOQI_FORCE_EMOTION，仅取证用）`)
    perception.forceEmotion(forced as Emotion)
    // 锁定的那一刻就把新情绪推给渲染层，不必等下一拍
    broadcastState()
  }

  // 取证用：锁死**关系基调**，便于核对三种基调画出来有什么不同。
  // 关系是长期变量（`reserved` 要相处好几天才到 `warm`），
  // 不锁的话根本没法在几秒内对比。
  const forcedMood = process.env.XIAOQI_FORCE_MOOD
  if (forcedMood) {
    if (forcedMood === 'reserved' || forcedMood === 'warm' || forcedMood === 'attached') {
      log(`⚠️ 关系基调已锁定为 ${forcedMood}（XIAOQI_FORCE_MOOD，仅取证用）`)
      perception.forceMood(forcedMood)
      broadcastState()
    } else {
      // 说不认识就说出来，而不是静默忽略——静默忽略会让取证脚本
      // 拿到一堆"看起来一样"的截图却完全不知道为什么。
      log(`⚠️ 未知的关系基调 ${forcedMood}，已忽略（合法值：reserved / warm / attached）`)
    }
  }

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
  registerPowerEvents()
  openMeshProbeIfRequested()
  scheduleLedgerIfRequested()
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

/**
 * ★ 这个标志必须在 **`before-quit`** 里置位，不能等 `will-quit`。
 *
 * Electron 的退出顺序是：`before-quit` → 关闭所有窗口 → `will-quit` → `quit`。
 * 而下面那个 `close` 处理器会在 `isQuitting` 为 false 时
 * `preventDefault()` 并改成"隐藏"——**取消关窗会让整个退出流程中止**。
 *
 * 曾经把它放在 `will-quit` 里，后果很具体：**托盘菜单的「退出小奇」不退出**。
 * 点下去只看到宠物消失（那其实是 close 处理器把它设成了 hidden），
 * 进程却一直留着——托盘图标还在、全局快捷键还占着。
 * 日志里留下的是 `保留时间结束，退出。` 紧跟着 `隐身：窗口已隐藏`，
 * 这两句连在一起就是"退出被自己的隐藏逻辑吃掉了"的指纹。
 */
app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  // 退出顺序与启动严格逆序：先注销全局快捷键，再停感知与轮询，最后销毁托盘与窗口。
  // 注意 `isQuitting` 已在 before-quit 置位，这里不再重复。
  globalShortcut.unregisterAll()
  perception?.dispose()
  perception = null
  // 退出前跑最后一轮维护：把攒够次数的主题升级成语义记忆。
  // 不做的话，"反复发生"的判定要等下一次启动后的第一个维护周期才生效，
  // 而用户关机前的那几次互动就等于白记了。
  memory?.runMaintenance()
  memory?.stop()
  memory = null
  controller?.dispose()
  tray?.destroy()
  tray = null
})
