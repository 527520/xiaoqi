import { useEffect, useRef, type RefObject } from 'react'

import { Application } from 'pixi.js'
// ★ 这一行必须在创建 Application 之前生效（放文件顶部即可，它是自安装的）。
//
// 作用：把 Pixi 内部基于 `eval` 的 uniform/shader 同步换成**静态 polyfill**，
// 从而在**不放开 CSP** 的前提下正常工作。
//
// 不引它的后果很具体：`UboSystem._systemCheck()` 会抛
//   Current environment does not allow unsafe-eval, please use
//   pixi.js/unsafe-eval module to enable support.
// 于是 `Application.init()` 失败、**宠物完全不渲染**。而窗口本身是透明且正常的，
// 所以表象只是"什么都没显示"，很容易被误判成透明窗或渲染进程配置问题。
// （本机实测踩过一次。）
//
// 注意它**不是**在放宽安全策略：它安装的是**避免 eval** 的实现，
// 因此 index.html 里的 CSP 可以继续保持 `default-src 'none'` 这种最严形态。
import 'pixi.js/unsafe-eval'

import { FRAME_RATE, PET_WINDOW_SIZE } from '@shared/constants'
import type { PetRuntimeState } from '@shared/types'

import { PetStage } from './PetStage'

/**
 * 把 PixiJS 接到 React 上，并让渲染循环跟随宠物形态降帧。
 *
 * ⚠️ 刻意**不用** `@pixi/react`：宠物的渲染循环要按形态动态降帧、要能整体暂停，
 * 而 React 的渲染模型与"每帧变化但不触发 DOM 重渲染"是两套节奏。
 * 用命令式方式持有 `Application` 更直白，帧预算也更好控。
 *
 * React 在这里的职责只有两件：挂载 canvas、把主进程推来的形态转交给舞台。
 *
 * @param containerRef 由组件提供并挂在 DOM 上的容器
 * @param state 主进程推来的运行时状态；`null` = 还没拿到，按保守默认渲染
 */
export function usePetStage(
  containerRef: RefObject<HTMLDivElement | null>,
  state: PetRuntimeState | null,
): void {
  const stageRef = useRef<PetStage | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    const app = new Application()
    let stage: PetStage | null = null

    const boot = async (): Promise<void> => {
      await app.init({
        width: PET_WINDOW_SIZE.width,
        height: PET_WINDOW_SIZE.height,

        // ★ 施工令 §4.3⑥：resolution 固定为 1，全部坐标用 DIP，
        //   DPI 缩放交给 Chromium 合成器。
        //   绝不用 devicePixelRatio / Display.scaleFactor ——
        //   后者被 Chromium 折进了"文字缩放"，拿它算精灵尺寸会在有文字缩放的
        //   机器上被额外放大。
        resolution: 1,
        autoDensity: false,

        // 透明窗：canvas 自身也必须透明，否则会在窗口里画出一块不透明底色。
        backgroundAlpha: 0,
        antialias: true,

        // 明确选 WebGL：WebGPU 在 Electron + 透明窗组合下的行为未经验证，
        // 本项目也不需要 WebGPU 的算力。
        preference: 'webgl',
        // 桌宠是低负载长驻的小渲染，不需要独显。
        powerPreference: 'low-power',

        autoStart: false,
      })

      // init 是异步的：期间组件可能已经卸载。
      if (disposed) {
        app.destroy(true)
        return
      }

      container.appendChild(app.canvas)

      stage = new PetStage(app, () => {
        window.xiaoqi.notifyInteraction()
      })
      stage.onAnimationStateChange((isAnimating) => {
        window.xiaoqi.notifyAnimating(isAnimating)
      })
      stageRef.current = stage

      // 诊断出口：把舞台内部状态挂到 window 上（只读投影，不改变行为）。
      //
      // 为什么需要它：本机**不能在渲染进程里开 DevTools 调试**——
      // 施工令 §4.3② 实测 DevTools 打开时透明窗会变不透明。
      // 而"某个图层为什么没画出来"这类问题必须有办法读到内部状态，
      // 否则只能靠反复改代码 + 猜（本机真的为此浪费过很多轮）。
      //
      // 刻意**不加 `import.meta.env.DEV` 判断**：用户平时用 `pnpm dev`，
      // 但排查打包产物时跑的是生产构建，那时 DEV 为 false，钩子会消失，
      // 恰好在你最需要它的时候不见了。
      // 也**不要用 `process.env`**：渲染进程是 `sandbox: true` 的，
      // 里面没有 `process`，引用它会抛 ReferenceError
      // （而且是在模块求值期抛，整个渲染进程挂掉，极难定位）。
      Reflect.set(window, '__petDebug', () => stage?.debugSnapshot() ?? null)
      Reflect.set(window, '__petLayer', (layer: string, visible: boolean) => {
        stage?.debugSetLayerVisible(
          layer as 'body' | 'ears' | 'tail' | 'cheeks' | 'eyes' | 'shadow',
          visible,
        )
      })

      app.ticker.add((ticker) => {
        // Pixi 的 deltaTime 是"以 60fps 为 1"的无量纲标量；
        // 除以 60 转成秒，动画时长才与帧率无关。
        stage?.update(ticker.deltaTime / 60)
      })

      // 初始待机档；真实档位由下面那个 effect 按形态调整。
      stage.setMaxFps(FRAME_RATE.idle)
      app.start()
    }

    void boot()

    return () => {
      disposed = true
      stageRef.current = null
      stage = null
      // destroy(true) 会一并移除 canvas，卸载后不留 DOM 残渣。
      app.destroy(true)
    }
  }, [containerRef])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.mode = state?.mode ?? 'active'

    // 帧率由**主进程**给出（见 PetRuntimeState.frameRate 的注释）：
    // 只有主进程同时知道"形态"与"是否正在播放交互动画"。
    // 主进程算不出来的情况（首帧、IPC 尚未到达）回落到待机档。
    const fps = state?.frameRate ?? FRAME_RATE.idle
    // ⚠️ 值 0 的语义是"停更"，而 Pixi 的 maxFPS=0 意思是**不限帧**。
    // 所以这里必须夹到 1，绝不能把 0 直接交给 Pixi ——
    // 那会让隐藏/隐身状态变成满帧空转，正好与省电目标相反。
    stage.setMaxFps(fps > 0 ? fps : 1)
  }, [state?.mode, state?.frameRate])
}
