import { contextBridge, ipcRenderer } from 'electron'

import { IPC } from '../shared/ipc'
import type { XiaoqiBridge } from '../shared/ipc'
import type {
  MemoryBlockKind,
  MemoryBlockView,
  MemoryLedgerEntry,
  PetRuntimeState,
  VisibilityMode,
} from '../shared/types'

/**
 * preload —— 主进程与渲染进程之间**唯一的**桥。
 *
 * 这个文件跑在渲染进程的上下文里，但拥有受限的 Node/Electron 能力。
 * 因此它的安全纪律是：**只暴露白名单通道，不暴露 `ipcRenderer` 本身。**
 * 一旦把 `ipcRenderer` 整个交出去，白名单就形同虚设。
 *
 * 注意这里用相对路径 `../shared/ipc` 而不是 `@shared/ipc`：
 * preload 是独立的一段构建，别名在两个 tsconfig 里都要配，相对路径更不容易漂。
 */

const bridge: XiaoqiBridge = {
  getState: () => ipcRenderer.invoke(IPC.stateGet) as Promise<PetRuntimeState>,

  setMode: (mode: VisibilityMode) =>
    ipcRenderer.invoke(IPC.modeSet, mode) as Promise<PetRuntimeState>,

  setScale: (scale: number) => ipcRenderer.invoke(IPC.scaleSet, scale) as Promise<PetRuntimeState>,

  startDrag: (offset) => {
    ipcRenderer.send(IPC.dragStart, offset)
  },

  endDrag: () => {
    ipcRenderer.send(IPC.dragEnd)
  },

  notifyInteraction: () => {
    ipcRenderer.send(IPC.petInteract)
  },

  notifyAnimating: (isAnimating: boolean) => {
    ipcRenderer.send(IPC.petAnimating, isAnimating)
  },

  pushSpriteMask: (mask: unknown) => {
    ipcRenderer.send(IPC.spriteMaskPush, mask)
  },

  reportSpriteAnimation: (animation: string) => {
    ipcRenderer.send(IPC.spriteAnimationChanged, animation)
  },

  reportError: (message: string, stack: string) => {
    // 同步发送：启动期的报错必须**当场**写进主进程日志，
    // 异步 send 在窗口刚要关闭时可能来不及送达（实测丢过关键堆栈）。
    ipcRenderer.sendSync(IPC.rendererError, message, stack)
  },

  onStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: PetRuntimeState): void => {
      listener(state)
    }
    ipcRenderer.on(IPC.stateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.stateChanged, handler)
    }
  },

  // ── 记忆账本（M3）──
  //
  // 这几条只在记忆账本窗口里被调用。宠物窗口拿得到同样的 bridge，
  // 但它不画账本。真要隔离得拆成两个 preload——见 shared/ipc.ts 的说明。

  listMemories: (query?: string) =>
    ipcRenderer.invoke(IPC.memoryList, query) as Promise<MemoryLedgerEntry[]>,

  forgetMemory: (id: number) => ipcRenderer.invoke(IPC.memoryForget, id) as Promise<boolean>,

  forgetAllMemories: () => ipcRenderer.invoke(IPC.memoryForgetAll) as Promise<number>,

  rememberFact: (content: string) =>
    ipcRenderer.invoke(IPC.memoryRemember, content) as Promise<number | null>,

  // ── 核心记忆块与历史（阶段二）──

  listBlocks: () => ipcRenderer.invoke(IPC.memoryBlocks) as Promise<MemoryBlockView[]>,

  setBlock: (kind: MemoryBlockKind, content: string) =>
    ipcRenderer.invoke(IPC.memoryBlockSet, kind, content) as Promise<boolean>,

  clearBlock: (kind: MemoryBlockKind) =>
    ipcRenderer.invoke(IPC.memoryBlockClear, kind) as Promise<boolean>,

  listSuperseded: (query?: string) =>
    ipcRenderer.invoke(IPC.memorySuperseded, query) as Promise<MemoryLedgerEntry[]>,

  previewContext: () => ipcRenderer.invoke(IPC.memoryContextPreview) as Promise<string>,
}

contextBridge.exposeInMainWorld('xiaoqi', bridge)
