import { type BrowserWindow, screen } from 'electron'

import {
  CURSOR_POLL_INTERVAL_MS,
  PET_GEOMETRY,
  PET_MARGIN,
  petWindowSize,
  QUNS_POLL_INTERVAL_MS,
  TOPMOST_REASSERT_INTERVAL_MS,
} from '@shared/constants'
import type { CursorRoute, Point, Rect, VisibilityMode } from '@shared/types'

import { resolveCursorRoute, shouldFlipIgnoreMouseEvents } from '../core/cursorRouter'
import { frameBudgetChanged, shouldPauseTicker, type FrameBudgetInput } from '../core/frameRate'
import {
  createModeGateState,
  effectiveMode,
  reduceModeGate,
  shouldAcceptCursor,
  type ModeGateState,
} from '../core/modeGate'
import type { Platform } from '../platform'

export interface PetWindowControllerOptions {
  readonly window: BrowserWindow
  readonly platform: Platform
  /** 状态变化时回调，用于推送给渲染进程与刷新托盘菜单。 */
  readonly onStateChanged: () => void
  readonly logger?: (message: string) => void
}

/**
 * 宠物窗口的运行时控制器 —— M1 全部系统行为的落点。
 *
 * 这里刻意把**判定**与**执行**分开：
 * 判定（该不该穿透、该不该静默、该不该降帧）全在 `core/` 的纯函数里，可单测；
 * 本文件只负责调用 Electron/Win32 把判定结果执行下去。
 * 于是"最容易写错的部分"可以自动验证，"执行部分"才需要靠实机记录背书。
 */
export class PetWindowController {
  readonly #window: BrowserWindow
  readonly #platform: Platform
  readonly #onStateChanged: () => void
  readonly #log: (message: string) => void

  #modeGate: ModeGateState = createModeGateState()
  #silenceHits = 0
  #activeHits = 0

  #cursorRoute: CursorRoute = 'passthrough'
  #frameBudget: FrameBudgetInput = {
    mode: 'active',
    isAnimating: false,
    isWindowVisible: true,
  }

  #isAnimating = false
  #scale = 1
  /** 上一次广播出去的光标位置，用来避免重复推送同样的值。 */
  #lastBroadcastCursor: Point | null = null

  #cursorTimer: NodeJS.Timeout | null = null
  #qunsTimer: NodeJS.Timeout | null = null
  #topmostTimer: NodeJS.Timeout | null = null
  #tickCount = 0
  #disposed = false

  constructor(options: PetWindowControllerOptions) {
    this.#window = options.window
    this.#platform = options.platform
    this.#onStateChanged = options.onStateChanged
    this.#log =
      options.logger ??
      ((): void => {
        // 默认不打日志。日志是可选注入的，测试与静默运行时不产生任何输出。
      })
  }

  /** 当前形态。用户手动值优先于系统自动值。 */
  get mode(): VisibilityMode {
    return effectiveMode(this.#modeGate)
  }

  get cursorRoute(): CursorRoute {
    return this.#cursorRoute
  }

  get isAnimating(): boolean {
    return this.#isAnimating
  }

  get frameBudgetSnapshot(): FrameBudgetInput {
    return this.#frameBudget
  }

  /** 宠物窗口当前所在的显示器工作区（DIP），用于调试面板与多屏定位。 */
  currentWorkArea(): Rect {
    // 用**窗口**所在显示器，而不是光标所在显示器。
    // 光标在验证脚本里会被移动（那正是脚本在做的事），
    // 用光标会让"当前工作区"随验证步骤跳动，读数不可比。
    const display = screen.getDisplayMatching(this.#window.getBounds())
    const area = display.workArea
    return { x: area.x, y: area.y, width: area.width, height: area.height }
  }

  /** 当前缩放倍数。 */
  get scale(): number {
    return this.#scale
  }

  /**
   * 改变缩放：**真的改窗口尺寸**（方案 B）。
   *
   * 依据：本机实测过 `setBounds` 改一个 `transparent` 窗口的尺寸后
   * **透明仍然成立**（见 `docs/verify-m1.md` 的缩放实测一节）——
   * 施工令只警告了 `resizable: true` 可能破透明，没有禁止 `setBounds`。
   *
   * 窗口尺寸变化后**必须重算命中测试与穿透状态**：几何在设计空间里只有一份，
   * 命中判定要按新缩放换算，否则宠物放大后只有左上角可点。
   */
  setScale(scale: number): void {
    if (this.#disposed) return
    if (!Number.isFinite(scale) || scale <= 0) return
    if (scale === this.#scale) return

    const before = this.bounds()
    this.#scale = scale

    const size = petWindowSize(scale)
    // 以**右下角为锚点**缩放：宠物默认贴在右下角，
    // 若以左上角为锚点，放大会把它推出工作区、缩小会留下空档。
    this.#window.setBounds({
      x: Math.round(before.x + before.width - size.width),
      y: Math.round(before.y + before.height - size.height),
      width: size.width,
      height: size.height,
    })

    // 尺寸变了，穿透判定必须立刻重算（否则会有一段"点不到"的窗口）
    this.#cursorRoute = 'passthrough'
    this.#window.setIgnoreMouseEvents(true)
    this.#tickCursor()
    this.#reassertContentProtection()
    this.#reassertTopmost()

    this.#log(`缩放 → ${String(scale)}（窗口 ${String(size.width)}×${String(size.height)}）`)
    this.#onStateChanged()
  }

  /**
   * 启动全部轮询。
   *
   * 启动顺序是刻意的：先建立初始形态与穿透状态，再开始轮询——
   * 否则第一次轮询会基于未初始化的状态做翻转判断。
   */
  start(): void {
    this.#applyMode(effectiveMode(this.#modeGate), { force: false })

    this.#cursorTimer = setInterval(() => {
      this.#tickCursor()
    }, CURSOR_POLL_INTERVAL_MS)

    this.#qunsTimer = setInterval(() => {
      this.#tickUserNotificationState()
    }, QUNS_POLL_INTERVAL_MS)

    this.#topmostTimer = setInterval(() => {
      this.#reassertTopmost()
    }, TOPMOST_REASSERT_INTERVAL_MS)

    // 立刻跑一次，免得开头 2 秒处于"未知"形态。
    this.#tickUserNotificationState()
  }

  dispose(): void {
    this.#disposed = true
    for (const timer of [this.#cursorTimer, this.#qunsTimer, this.#topmostTimer]) {
      if (timer) clearInterval(timer)
    }
    this.#cursorTimer = null
    this.#qunsTimer = null
    this.#topmostTimer = null
  }

  /** 宠物窗口当前的屏幕矩形（DIP）。不要缓存——多屏/DPI 变化后必须重新查。 */
  bounds(): Rect {
    const b = this.#window.getBounds()
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  }

  /**
   * 光标在**宠物设计空间**里的位置；够远时返回 `null`。
   *
   * 用途只有一个：让它的眼睛跟着光标转。这是这只宠物"有生命感"的主要来源。
   *
   * 两个刻意的处理：
   * ① **只在光标接近窗口时才有值**（超出窗口外 80 设计像素就返回 null）。
   *    否则屏幕上任何一次鼠标移动都会让主进程往渲染进程推消息，
   *    而绝大多数时候宠物根本看不见光标。
   * ② 返回的是**设计空间**坐标（未缩放），渲染进程不需要再关心缩放，
   *    因此缩放与视线跟随互不干扰。
   */
  cursorInDesignSpace(): Point | null {
    if (this.mode !== 'active') return null

    const point = this.#cursorPoint()
    if (!point) return null

    const b = this.bounds()
    const s = this.#scale
    const reach = 80 // 设计空间像素
    const localX = (point.x - b.x) / s
    const localY = (point.y - b.y) / s

    const size = PET_GEOMETRY.window.width
    if (localX < -reach || localY < -reach || localX > size + reach || localY > size + reach) {
      return null
    }
    return { x: localX, y: localY }
  }

  /**
   * 用户手动设置形态（托盘菜单 / 全局快捷键走这里）。
   *
   * `null` 表示交还给系统自动决定（全屏时该静默仍然会静默）。
   */
  setManualMode(mode: VisibilityMode | null): void {
    this.#modeGate = { manual: mode, auto: this.#modeGate.auto }
    this.#applyMode(effectiveMode(this.#modeGate), { force: true })
  }

  setAnimating(isAnimating: boolean): void {
    if (this.#isAnimating === isAnimating) return
    this.#isAnimating = isAnimating
    this.#syncFrameBudget()
  }

  /** 该不该完全停掉渲染循环（帧率为 0 时）。 */
  shouldPauseRendering(): boolean {
    return shouldPauseTicker(this.#frameBudget)
  }

  // ────────────────────────────── 光标路由 ──────────────────────────────

  /**
   * 轮询光标并翻转穿透开关。
   *
   * ★ 这是 M1 的核心风险点，也是**唯一**在"宠物可点"与"下层窗口可点"之间
   *   做取舍的地方。
   *
   * 用轮询而不是 `setIgnoreMouseEvents(forward: true)`，是因为转发有三个
   * 未修复的失效面（#48035 光标闪烁、#49982 崩溃后穿透状态卡死、
   * #53026 提权窗口下转发暂停），而轮询方案根本不开转发，因此全部免疫。
   */
  #tickCursor(): void {
    if (this.#disposed) return

    const point = this.#cursorPoint()
    if (!point) return

    // 启动后不久打一次"光标/窗口/判定"的完整快照。
    //
    // 为什么需要它：穿透日志只在**状态翻转**时打印，而启动时的初始状态就是
    // `passthrough`、光标又常常不在宠物上，于是可能整轮日志里一行都没有——
    // "功能没跑"与"没有翻转可打"长得一模一样。本机因此误判过一次。
    // 这条快照让验收脚本与排查都有确定的基准（见 scripts/verify-clickthrough.mjs）。
    // 只打一次，不做周期性输出：桌宠常驻，日志不该持续增长。
    this.#tickCount++
    if (this.#tickCount === 1) {
      const b = this.bounds()
      this.#log(
        `初始状态：光标 (${String(Math.round(point.x))},${String(Math.round(point.y))}) ` +
          `窗口 (${String(b.x)},${String(b.y)}) ${String(b.width)}×${String(b.height)} ` +
          `判定 ${this.#cursorRoute} 形态 ${this.mode}`,
      )
    }

    // 隐身态没有任何可见内容 → 一律穿透，避免"看不见但挡住下层"的幽灵窗口。
    const bounds = this.bounds()
    const next: CursorRoute = shouldAcceptCursor(this.mode)
      ? resolveCursorRoute(PET_GEOMETRY, bounds, point, this.#scale)
      : 'passthrough'

    const routeChanged = shouldFlipIgnoreMouseEvents(this.#cursorRoute, next)
    if (routeChanged) {
      this.#cursorRoute = next
      // 注意：**不加** `{ forward: true }`。理由见 core/cursorRouter.ts。
      this.#window.setIgnoreMouseEvents(next === 'passthrough')

      // 穿透开关翻转时打一行日志。这是**唯一**能证明"主进程真的按宠物轮廓翻转了
      // 整窗开关"的证据——纯函数单测只证明算得对，证明不了它被执行了。
      // 验收与排查都依赖这行日志（见 scripts/verify-clickthrough.mjs）。
      this.#log(
        `穿透 → ${next}（光标 ${String(Math.round(point.x))},${String(Math.round(point.y))}；` +
          `窗口 ${String(bounds.x)},${String(bounds.y)} ${String(bounds.width)}×${String(bounds.height)}；` +
          `形态 ${this.mode}）`,
      )
    }

    // ⚠️ 光标位置也要触发广播，而且**不能**只依赖上面那个"路由翻转"分支。
    //
    // 渲染进程的**视线跟随**需要持续拿到光标位置。如果只在路由翻转时推状态，
    // 那么宠物在光标进入轮廓的那一刻看一眼、之后眼睛就冻住了——
    // 看起来像卡住。这个 bug 是加完视线跟随之后才引入的。
    //
    // 代价：光标在宠物附近时，IPC 约每 80ms 一次（≈12 次/秒）。
    // 可以接受，因为：① 只在光标接近窗口时才有值（远离时 `cursorInDesignSpace`
    // 返回 null，前后相等就不广播）；② payload 极小。
    const cursor = this.cursorInDesignSpace()
    const cursorChanged =
      (cursor === null) !== (this.#lastBroadcastCursor === null) ||
      (cursor !== null &&
        this.#lastBroadcastCursor !== null &&
        (Math.round(cursor.x) !== Math.round(this.#lastBroadcastCursor.x) ||
          Math.round(cursor.y) !== Math.round(this.#lastBroadcastCursor.y)))

    if (routeChanged || cursorChanged) {
      this.#lastBroadcastCursor = cursor
      this.#onStateChanged()
    }
  }

  #cursorPoint(): Point | null {
    try {
      const p = screen.getCursorScreenPoint()
      return { x: p.x, y: p.y }
    } catch {
      // 会话断开等情况。返回 null 让调用方跳过这一轮，而不是把异常抛出去。
      return null
    }
  }

  // ────────────────────────────── 形态闸门 ──────────────────────────────

  /**
   * 轮询 QUNS，决定是否进入静默。
   *
   * 用 `SHQueryUserNotificationState` 而不是任何几何判断：
   * 实测「无边框窗口 + 几何覆盖整个显示器」时 QUNS 仍是 5，
   * Windows 只认真正进入全屏的窗口（施工令 §4.3④）。
   */
  #tickUserNotificationState(): void {
    if (this.#disposed) return

    const state = this.#platform.queryUserNotificationState()
    const result = reduceModeGate({
      userNotificationState: state,
      manual: this.#modeGate.manual,
      previous: this.#modeGate,
      silenceHits: this.#silenceHits,
      activeHits: this.#activeHits,
    })

    this.#silenceHits = result.silenceHits
    this.#activeHits = result.activeHits

    const autoChanged = result.state.auto !== this.#modeGate.auto
    this.#modeGate = result.state

    if (!autoChanged) return

    this.#log(`系统状态变化 → 自动形态 ${result.state.auto}（QUNS=${String(state)}）`)
    this.#applyMode(result.mode, { force: false })
  }

  /**
   * 落实形态：窗口显隐 + 穿透 + 帧率 + 捕获保护。
   *
   * ⚠️ 每个分支后面都要**重新断言** `setContentProtection` 与穿透状态
   * （施工令 §4.3⑨：「隐身/显示切换后重新断言 setContentProtection 与
   * setIgnoreMouseEvents 的状态」）。原因是 `SetWindowDisplayAffinity` 的
   * 生效前提是窗口可见，而隐藏再显示会重置这个前提。
   */
  #applyMode(mode: VisibilityMode, options: { force: boolean }): void {
    if (this.#disposed) return

    if (mode === 'hidden') {
      if (this.#window.isVisible()) {
        this.#window.hide()
        this.#log('隐身：窗口已隐藏')
      }
      this.#syncFrameBudget()
      if (options.force) this.#onStateChanged()
      return
    }

    if (!this.#window.isVisible() && !this.#window.isDestroyed()) {
      this.#window.showInactive()
      this.#log(`显示：窗口已显示（形态 ${mode}）`)
    }

    // ★ 必须在窗口可见之后断言。Chromium 在窗口不可见时设置 affinity
    //   会得到一个空白窗——不抛错，只是静默画不出来。
    this.#reassertContentProtection()
    this.#reassertTopmost()

    // 显示/形态切换后穿透状态可能被系统重置，强制重算一次。
    this.#cursorRoute = 'passthrough'
    this.#window.setIgnoreMouseEvents(true)
    this.#tickCursor()

    this.#syncFrameBudget()
    if (options.force) this.#onStateChanged()
  }

  // ────────────────────────────── 置顶与捕获 ──────────────────────────────

  /**
   * 周期性重断言置顶。
   *
   * ⚠️ 两个必须同时处理的陷阱，缺一个都会静默失效：
   *
   * ① **Shell 会静默剥夺 `HWND_TOPMOST`**：别的应用进入全屏时，
   *    Windows 摘掉其他窗口的置顶，并且**不恢复、不发任何 Electron 事件**。
   *    所以"在 show/resize 时重断言"这种直觉做法根本不会触发。
   * ② **Electron 会在缓存状态与目标一致时短路** `setAlwaysOnTop(true)`，
   *    调用到不了 OS。必须先置 false 做 cache-bust 再置 true。
   *
   * 只在窗口可见时做——隐藏时重断言没有意义，纯浪费。
   * 不学 BongoCat 的 16ms 循环：那是持续的 CPU/消息开销，
   * 且已被自己记录下"右键菜单被自己的置顶窗盖住"的副作用。
   */
  #reassertTopmost(): void {
    if (this.#disposed) return
    if (this.#window.isDestroyed() || !this.#window.isVisible()) return

    try {
      this.#window.setAlwaysOnTop(false)
      this.#window.setAlwaysOnTop(true, 'screen-saver')
    } catch (error) {
      this.#log(`置顶重断言失败：${String(error)}`)
    }
  }

  /**
   * 重新断言窗口捕获排除（`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`）。
   *
   * ✅ 本机已实测可靠：纯洋红探针窗在桌面捕获中，关闭保护时可见、开启后消失
   * （`docs/verification.md` V5，Electron 44.3.0 / Win11 build 26200）。
   *
   * ⚠️ 边界必须如实告知用户，**不要宣传成"防截屏"**：
   * 微软官方明确说明它不保证保护窗口内容，**手机拍屏依然拍得到**。
   */
  #reassertContentProtection(): void {
    if (this.#disposed) return
    if (this.#window.isDestroyed()) return
    try {
      this.#window.setContentProtection(true)
    } catch (error) {
      this.#log(`捕获保护设置失败：${String(error)}`)
    }
  }

  // ────────────────────────────── 帧率 ──────────────────────────────

  #syncFrameBudget(): void {
    const next: FrameBudgetInput = {
      mode: this.mode,
      isAnimating: this.#isAnimating,
      isWindowVisible: !this.#window.isDestroyed() && this.#window.isVisible(),
    }

    if (!frameBudgetChanged(this.#frameBudget, next)) {
      this.#frameBudget = next
      return
    }

    this.#frameBudget = next
    this.#onStateChanged()
  }

  /**
   * 移除卡死的点击穿透 —— 施工令 §4.3③「必做」的恢复路径。
   *
   * 为什么必须有：electron#49982 是**真实存在**的已确认状态——
   * 渲染进程崩溃或 reload 之后穿透状态可能卡死，用户看到宠物却怎么都点不到，
   * 且系统没有任何自愈机制。
   *
   * 本方案的轮询理论上免疫该问题（穿透状态每 80ms 依光标重算），
   * 但仍提供显式入口：理论上免疫不等于用户不会遇到，
   * 而"宠物点不到"属于会让用户直接卸载的那类故障。
   */
  recoverClickThrough(): void {
    this.#log('恢复点击：重置穿透状态并强制重算')
    this.#cursorRoute = 'passthrough'
    this.#window.setIgnoreMouseEvents(true)
    this.#reassertTopmost()
    this.#reassertContentProtection()
    this.#tickCursor()
    this.#onStateChanged()
  }

  /**
   * 把宠物放到光标所在显示器的右下角。
   *
   * ⚠️ 用**工作区**（`workArea`）而不是整块屏幕 `bounds`，否则宠物会压到任务栏上。
   *
   * ⚠️ 不缓存几何：每次调用重新查询（施工令 §4.3⑦「不要缓存几何」）。
   * `Display.id` 重启后不持久，因此只在运行期使用，不作为持久化依据。
   *
   * ⚠️ **未验证**：本机只有一块显示器（2560×1440 @1x），
   * 跨屏定位与混合 DPI 无法在本机验证。实现按规格写，但不声称已通过。
   */
  placeAtDefaultPosition(): void {
    const display = screen.getDisplayMatching(this.#window.getBounds())
    const area = display.workArea
    const size = petWindowSize(this.#scale)

    this.#window.setBounds({
      x: Math.round(area.x + area.width - size.width - PET_MARGIN),
      y: Math.round(area.y + area.height - size.height - PET_MARGIN),
      width: size.width,
      height: size.height,
    })
  }
}
