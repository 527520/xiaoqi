import { useEffect, useRef, type RefObject } from 'react'

import { Application } from 'pixi.js'
// ★ 这一行必须在创建 Application 之前生效（放文件顶部即可，它是自安装的）。
//
// 作用：把 Pixi 内部基于 `eval` 的 uniform/shader 同步换成**静态 polyfill**，
// 从而在**不放开 CSP** 的前提下正常工作。
//
// 不引它的后果很具体：`UboSystem._systemCheck()` 会抛
//   Current environment does not allow eval, please use pixi.js/unsafe-eval...
// 于是 `Application.init()` 失败、**宠物完全不渲染**。而窗口本身是透明且正常的，
// 所以表象只是"什么都没显示"，很容易被误判成透明窗或渲染进程配置问题。
// （本机实测踩过一次。）
//
// 注意它**不是**在放宽安全策略：它安装的是**避免 eval** 的实现，
// 因此 index.html 里的 CSP 可以继续保持 `default-src 'none'` 这种最严形态。
import 'pixi.js/unsafe-eval'

import { FRAME_RATE, petWindowSize } from '@shared/constants'
import type { PetRuntimeState } from '@shared/types'

import { PetStage } from './PetStage'

/**
 * 把 PixiJS 接到 React 上：挂载 canvas、跟随形态降帧、跟随缩放与光标。
 *
 * ⚠️ 刻意**不用** `@pixi/react`：宠物的渲染循环要按形态动态降帧、要能整体暂停，
 * 而 React 的渲染模型与"每帧变化但不触发 DOM 重渲染"是两套节奏。
 * 用命令式方式持有 `Application` 更直白，帧预算也更好控。
 *
 * @param containerRef 由组件提供并挂在 DOM 上的容器
 * @param state 主进程推来的运行时状态；`null` = 还没拿到
 */
export function usePetStage(
  containerRef: RefObject<HTMLDivElement | null>,
  state: PetRuntimeState | null,
): void {
  const stageRef = useRef<PetStage | null>(null)
  const scale = state?.scale ?? null

  // ── 渲染器生命周期 ──
  //
  // ⚠️ 依赖里带 `scale` 是**刻意的**：窗口尺寸随缩放变化，而 canvas 的
  //    后备存储（backing store）必须与窗口尺寸一致，否则画面会被拉伸模糊，
  //    也违背"1 CSS px = 1 纹理 px"这条关键简化（施工令 §4.3⑥）。
  //    缩放变化时整体重建比"局部 resize"更不容易留下半旧半新的状态，
  //    而宠物只有几个图形，重建成本可以忽略。
  useEffect(() => {
    const container = containerRef.current
    // state 还没到就先不初始化：此时不知道窗口有多大，
    // 硬开一个尺寸不对的渲染器只会画歪。
    if (!container || scale === null) return

    const size = petWindowSize(scale)

    let disposed = false
    // `app.init()` 是异步的。要区分"初始化完成"与"只是构造了 Application"——
    // 对**尚未 init 完成**的实例调用 `destroy()` 会抛
    // `this._cancelResize is not a function`（Pixi 内部插件还没注册上）。
    //
    // 这条路径在 React 19 的 StrictMode 下**必然**会被走到：开发模式会
    // 挂载 → 卸载 → 再挂载，于是卸载时 `init()` 往往还没 await 完。
    let initialized = false
    let destroyed = false
    const app = new Application()
    let stage: PetStage | null = null

    /** 幂等且带保护地销毁渲染器。 */
    const safeDestroy = (): void => {
      if (destroyed) return
      destroyed = true
      if (!initialized) return // 未 init 完成：没有可释放的资源，destroy 反而会抛
      try {
        app.destroy(true)
      } catch (error) {
        // 销毁失败不该让整个宠物挂掉——记录即可，别把异常抛进 React 的
        // effect 清理链（那会让错误边界接管并整屏空白）。
        console.warn('[xiaoqi] Pixi Application 销毁失败：', error)
      }
    }

    const boot = async (): Promise<void> => {
      await app.init({
        width: size.width,
        height: size.height,

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

      initialized = true

      // init 期间组件可能已经卸载（StrictMode 下必然发生一次）。
      if (disposed) {
        safeDestroy()
        return
      }

      container.appendChild(app.canvas)

      stage = new PetStage(app, () => {
        window.xiaoqi.notifyInteraction()
      })
      stage.onAnimationStateChange((isAnimating) => {
        window.xiaoqi.notifyAnimating(isAnimating)
      })
      stage.setScale(scale)
      // 拖动：按下时把光标相对宠物左上角的偏移交给主进程，
      // 之后由主进程按偏移跟随光标（渲染进程拿不到轮廓外的鼠标事件）。
      stage.onDrag({
        start: (offset) => {
          window.xiaoqi.startDrag(offset)
        },
        end: () => {
          window.xiaoqi.endDrag()
        },
      })
      stageRef.current = stage

      // 诊断出口：把舞台内部状态挂到 window 上（只读投影，不改变行为）。
      //
      // 为什么需要它：本机**不能在渲染进程里开 DevTools 调试**——
      // 施工令 §4.3② 实测 DevTools 打开时透明窗会变不透明。
      // 而"某个图层为什么没画出来"这类问题必须有办法读到内部状态。
      //
      // 刻意**不加 `import.meta.env.DEV` 判断**：排查打包产物时跑的是生产构建，
      // 那时 DEV 为 false，钩子会消失——恰好在最需要它的时候。
      // 也**不要用 `process.env`**：渲染进程是 `sandbox: true` 的，没有 `process`，
      // 引用它会抛 ReferenceError（在模块求值期抛，整个渲染进程挂掉）。
      Reflect.set(window, '__petDebug', () => stage?.debugSnapshot() ?? null)
      Reflect.set(window, '__petLayer', (layer: string, visible: boolean) => {
        stage?.debugSetLayerVisible(layer, visible)
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
      // 卸载时把诊断钩子摘掉，避免在 StrictMode 的"卸载 → 再挂载"间隙里
      // 读到已销毁的实例（那个实例的场景图"看起来正常"但不画任何东西，
      // 是本轮最容易误导人的一个陷阱）。再挂载的实例会立刻重装自己的钩子。
      //
      // 用 `Reflect` 而不是 `typeof window.__petDebug`：
      // 后者在 TS 里会因为该键未声明而报 TS2339。
      Reflect.deleteProperty(window, '__petDebug')
      Reflect.deleteProperty(window, '__petLayer')
      safeDestroy()
    }
  }, [containerRef, scale])

  // ── 形态与帧率 ──
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.mode = state?.mode ?? 'active'

    // 帧率由**主进程**给出（见 PetRuntimeState.frameRate 的注释）：
    // 只有主进程同时知道"形态"与"是否正在播放交互动画"。
    const fps = state?.frameRate ?? FRAME_RATE.idle
    // ⚠️ 值 0 的语义是"停更"，而 Pixi 的 maxFPS=0 意思是**不限帧**。
    // 所以这里必须夹到 1，绝不能把 0 直接交给 Pixi ——
    // 那会让隐藏/隐身状态变成满帧空转，正好与省电目标相反。
    stage.setMaxFps(fps > 0 ? fps : 1)
  }, [state?.mode, state?.frameRate])

  // ── 视线跟随 ──
  // 只在光标位置真的变化时更新；主进程已经在"光标够远"时给 null。
  useEffect(() => {
    stageRef.current?.setCursor(state?.cursor ?? null)
  }, [state?.cursor])

  // 缩放兜底：理论上上面的 effect 重建时已经设过，这里保证运行期不会漏。
  useEffect(() => {
    if (scale !== null) stageRef.current?.setScale(scale)
  }, [scale])
}
