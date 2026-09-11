import { contextBridge, ipcRenderer } from 'electron'

import { IPC } from '../shared/ipc'
import type { XiaoqiBridge } from '../shared/ipc'
import type { PetRuntimeState, VisibilityMode } from '../shared/types'

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
}

contextBridge.exposeInMainWorld('xiaoqi', bridge)
