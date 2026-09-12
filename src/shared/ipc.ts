import type { MemoryLedgerEntry, PetRuntimeState, VisibilityMode } from './types'

/**
 * IPC 通道清单 —— **白名单**，施工令 §4.4。
 *
 * preload 只暴露这里列出的通道，渲染进程拿不到任何别的东西。
 * 渲染进程是沙箱化的（`sandbox: true` + `contextIsolation: true` +
 * `nodeIntegration: false`），它**没有 Node**，因此 `better-sqlite3`、`koffi`
 * 这类原生模块只能待在主进程——这不是选择，是硬约束的后果。
 *
 * 通道名用 `域:动作` 格式。
 */
export const IPC = {
  /** 渲染进程启动时拉取一次完整状态快照（invoke → PetRuntimeState）。 */
  stateGet: 'state:get',
  /** 用户手动设置形态：正常/静默/隐身（invoke → PetRuntimeState）。 */
  modeSet: 'mode:set',
  /**
   * 设置宠物缩放（invoke → PetRuntimeState）。
   *
   * M1 的托盘菜单直接调主进程，不走这里；这条通道是给**渲染进程**
   * （将来的设置界面）用的。加上它也让缩放能被自动化验证覆盖——
   * 「托盘菜单点一下」没法自动点，但这条 invoke 可以。
   */
  scaleSet: 'scale:set',
  /**
   * 让宠物**跟着光标走**（拖动）。
   *
   * 为什么是主进程算位置而不是渲染进程给坐标：
   * 拖动期间光标常常**移出宠物轮廓**（用户只是在拖），
   * 而透明区域一律穿透，渲染进程根本收不到那些 move 事件。
   * 主进程本来就在每 80ms 轮询光标，用它算窗口位置最直接也最平滑。
   *
   * `dragStart` 带一个光标相对窗口原点的偏移，之后主进程按这个偏移跟随；
   * `dragEnd` 结束拖动并持久化位置。
   */
  dragStart: 'drag:start',
  dragEnd: 'drag:end',
  /** 渲染进程报告"用户点了宠物"，用于帧率预算（send，单向）。 */
  petInteract: 'pet:interact',
  /** 渲染进程报告交互动画结束（send，单向）。 */
  petAnimating: 'pet:animating',
  /**
   * 渲染进程把图集的 **alpha 命中蒙版**推给主进程（send，单向）。
   *
   * ── 为什么命中判定必须在主进程做 ──
   *
   * 穿透开关是**整窗**的（`setIgnoreMouseEvents`），而决定何时翻转的是
   * 每 80ms 一次的光标轮询——那在渲染进程里做不到：光标移出宠物轮廓后
   * 鼠标事件会穿透出去，渲染进程根本收不到那些 move。
   *
   * ── 为什么要送蒙版而不是几何 ──
   *
   * 图集宠物的剪影是不规则 alpha，几何表达不了。蒙版是下采样后的点阵
   * （13×16，每动作约 64 字节），一次推送约 600 字节，之后每次轮询只查一位。
   *
   * ⚠️ 结构不合法时主进程**整体拒收**并回落几何判定/穿透——
   *    半张蒙版会让命中区在某些动作下神秘缺失。
   */
  spriteMaskPush: 'sprite:mask',
  /**
   * 渲染进程报告当前正在播的动作（send，单向）。
   *
   * 蒙版是**按动作**存的，所以主进程必须知道现在该查哪一张。
   * 不报的话它只能永远查 idle 的蒙版——表现是"宠物跑起来之后就点不到了"。
   */
  spriteAnimationChanged: 'sprite:animation',
  /**
   * 渲染进程把未捕获异常 / 未处理的 Promise 拒绝送到主进程日志。
   *
   * 为什么需要这条通道：本机的诊断条件很差——
   * ① DevTools **一打开就让透明窗变不透明**（施工令 §4.3②），所以不能开着它排查；
   * ② 渲染进程的 `console-message` 事件**只给消息文本、没有堆栈**
   *    （实测对未捕获的 Promise 拒绝，`sourceId`/`lineNumber` 都是空的）。
   * 于是"宠物不渲染"这类故障会变成完全没有线索的黑盒。
   * 这条通道把真实堆栈捞到主进程日志里。
   *
   * 用 **`sendSync`（同步）** 而不是 `send`：宠物启动期的错误可能发生在
   * "渲染进程已开始执行、主进程日志却还没建立"的时间窗里，
   * 异步消息会晚到甚至丢在窗口关闭之后。实测第一次排查时，
   * 最关键的那条启动期堆栈就是这样丢掉的。
   */
  rendererError: 'renderer:error',
  /** 主进程推给渲染进程的状态变化（on → PetRuntimeState）。 */
  stateChanged: 'state:changed',

  // ── 记忆账本（M3；施工令 §5 M3「可见、可删、可一键清空、可手动记住/忘掉」）──
  //
  // ⚠️ 这几条通道只在**记忆账本窗口**里有意义。宠物窗口的渲染进程虽然
  // 拿得到同一个 bridge，但它不画账本，也就不会调它们。
  // 需要真隔离时应拆成两个 preload——这里先不做，因为账本窗口
  // 与宠物窗口同属本应用、同一个信任域，拆开只会增加两处需要同步的配置。

  /** 拉取账本列表（invoke → MemoryLedgerEntry[]）。 */
  memoryList: 'memory:list',
  /** 删掉一条记忆（invoke → 是否真的删掉了）。 */
  memoryForget: 'memory:forget',
  /** 一键清空（invoke → 删掉的条数）。 */
  memoryForgetAll: 'memory:forget-all',
  /** 手动"让它记住"一条事实（invoke → 新记忆 id，失败为 null）。 */
  memoryRemember: 'memory:remember',
} as const

/** 通道名字面量联合类型，防止拼写漂移。 */
export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * preload 通过 `contextBridge` 暴露给渲染进程的 API。
 *
 * ⚠️ 保持**窄**：调研里 openpets 的做法是"每个窗口一个窄 preload"，
 * 而不是"一个大 preload 暴露一切"。窄接口的好处是渲染进程被攻破时的
 * 可达面是确定的、可枚举的。
 */
export interface XiaoqiBridge {
  /** 拉取一次状态快照。 */
  getState(): Promise<PetRuntimeState>
  /** 设置形态。返回应用后的新快照。 */
  setMode(mode: VisibilityMode): Promise<PetRuntimeState>
  /** 设置宠物缩放。返回应用后的新快照。 */
  setScale(scale: number): Promise<PetRuntimeState>
  /**
   * 开始拖动：`offset` 是光标相对宠物窗口左上角的偏移（DIP）。
   * 之后主进程按这个偏移跟随光标，直到 `endDrag()`。
   */
  startDrag(offset: { x: number; y: number }): void
  /** 结束拖动（松手）。主进程会持久化位置。 */
  endDrag(): void
  /** 报告用户点了宠物。 */
  notifyInteraction(): void
  /** 报告交互动画开始/结束，用于帧率降档。 */
  notifyAnimating(isAnimating: boolean): void
  /**
   * 把图集的 alpha 命中蒙版推给主进程。
   *
   * 只在**精灵图后端**、且图集解码完成之后调用一次。
   * 参数类型是 `unknown`：这条通道的收端会做完整校验，
   * 而类型断言在这里只是把"我保证它是对的"写进代码——那不该是唯一防线。
   */
  pushSpriteMask(mask: unknown): void
  /** 报告当前正在播的动作名（主进程据此选蒙版）。 */
  reportSpriteAnimation(animation: string): void
  /** 报告渲染进程的未捕获错误（含堆栈），由主进程写进日志。 */
  reportError(message: string, stack: string): void
  /** 订阅状态变化；返回取消订阅函数。 */
  onStateChanged(listener: (state: PetRuntimeState) => void): () => void

  // ── 记忆账本 ──

  /** 列出记忆（可选关键词过滤，走中文子串匹配）。 */
  listMemories(query?: string): Promise<MemoryLedgerEntry[]>
  /**
   * 删掉一条记忆。
   *
   * 返回 `true` 表示**真的从数据库里删掉了**（不是打个标记）——
   * 这是对用户的承诺（§1.2⑪），所以返回值要如实反映。
   */
  forgetMemory(id: number): Promise<boolean>
  /** 一键清空。返回删掉的条数。 */
  forgetAllMemories(): Promise<number>
  /** 手动"让它记住"一条事实。返回新记忆的 id，失败为 null。 */
  rememberFact(content: string): Promise<number | null>
}

declare global {
  interface Window {
    readonly xiaoqi: XiaoqiBridge
  }
}
