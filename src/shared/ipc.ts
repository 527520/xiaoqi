import type { PetRuntimeState, VisibilityMode } from './types'

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
  /** 渲染进程报告"用户点了宠物"，用于帧率预算（send，单向）。 */
  petInteract: 'pet:interact',
  /** 渲染进程报告交互动画结束（send，单向）。 */
  petAnimating: 'pet:animating',
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
  /** 报告用户点了宠物。 */
  notifyInteraction(): void
  /** 报告交互动画开始/结束，用于帧率降档。 */
  notifyAnimating(isAnimating: boolean): void
  /** 报告渲染进程的未捕获错误（含堆栈），由主进程写进日志。 */
  reportError(message: string, stack: string): void
  /** 订阅状态变化；返回取消订阅函数。 */
  onStateChanged(listener: (state: PetRuntimeState) => void): () => void
}

declare global {
  interface Window {
    readonly xiaoqi: XiaoqiBridge
  }
}
