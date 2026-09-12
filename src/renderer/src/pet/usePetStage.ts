import { useEffect, useRef, type RefObject } from 'react'

import { Application, Texture } from 'pixi.js'
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

import { atlasForVersion, type SpriteVersion } from '@shared/petAtlas'
import { FRAME_RATE, petWindowSize } from '@shared/constants'
import { spriteWindowSize } from '@shared/spriteMask'
import type { PetRuntimeState, VisibilityMode } from '@shared/types'

import { decodeSpriteSheet, SheetDecodeError } from './decodeSheet'
import { PetStage } from './PetStage'
import type { PetStageLike } from './petStageContract'
import { prepareSpriteSheet } from './spriteSheet'
import { SpriteStage } from './SpriteStage'

/**
 * 把 PixiJS 接到 React 上：挂载 canvas、跟随形态降帧、跟随缩放与光标，
 * 并按主进程给的**形象信息**选渲染后端。
 *
 * ⚠️ 刻意**不用** `@pixi/react`：宠物的渲染循环要按形态动态降帧、要能整体暂停，
 * 而 React 的渲染模型与"每帧变化但不触发 DOM 重渲染"是两套节奏。
 * 用命令式方式持有 `Application` 更直白，帧预算也更好控。
 *
 * ── 两条后端的差别只体现在"建哪个舞台" ──
 *
 * 其余全部共用：帧率、拖动、光标、诊断钩子、事件。所以下面的代码里
 * `backend` 只出现两次（决定建谁、决定要不要解码图集）。
 *
 * @param containerRef 由组件提供并挂在 DOM 上的容器
 * @param state 主进程推来的运行时状态；`null` = 还没拿到
 */
export function usePetStage(
  containerRef: RefObject<HTMLDivElement | null>,
  state: PetRuntimeState | null,
): void {
  const stageRef = useRef<PetStageLike | null>(null)

  const scale = state?.scale ?? null
  const backend = state?.pet.backend ?? null
  const sheetUrl = state?.pet.sheetUrl ?? null
  const spriteVersion = state?.pet.spriteVersion ?? 1

  // ── 渲染器生命周期 ──
  //
  // ⚠️ 依赖里带 `scale` / `backend` / `sheetUrl` 是**刻意的**：
  //    - 窗口尺寸随缩放与后端变化，而 canvas 的后备存储必须与窗口尺寸一致，
  //      否则画面会被拉伸模糊，也违背"1 CSS px = 1 纹理 px"这条关键简化（§4.3⑥）；
  //    - 换宠物（换图集）时必须重建，否则新素材不会生效。
  //    整体重建比"局部换纹理"更不容易留下半旧半新的状态，而重建成本可以忽略。
  useEffect(() => {
    const container = containerRef.current
    // 状态还没到就先不初始化：此时既不知道窗口有多大，也不知道该建哪条后端，
    // 硬开一个猜出来的渲染器只会画歪。
    if (!container || scale === null || backend === null) return
    // 精灵图后端还没拿到图集 URL 时也先等着（主进程一定会在同一次快照里给出）
    if (backend === 'sprite' && !sheetUrl) return

    // 窗口尺寸按**后端**算：程序化是正方形（220×220），图集是格子比例（192×208）。
    // 走的都是与主进程同一个函数（`petWindowSize` / `spriteWindowSize`），
    // 所以两边不可能算出不同的窗口尺寸。
    const size =
      backend === 'sprite'
        ? spriteWindowSize(atlasForVersion(spriteVersion as SpriteVersion), scale)
        : petWindowSize(scale)

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
    /**
     * 已经造好的舞台。
     *
     * ★ 用一个局部变量记住它，而不是只放在 `stageRef` 里，是为了兜住一个
     *   真实的泄漏：`boot()` 里 `await bootSpriteStage(...)` 期间（要解码一张
     *   1536×2288 的图，几十毫秒）组件可能就被卸载了。那时 `stageRef.current`
     *   还是 null，清理函数什么也不做——而那个新建的舞台已经在 `app.stage` 上
     *   注册了 pointer 监听、建好了几十个帧纹理，成了永远不会被释放的残留。
     *   在 StrictMode 的"挂载 → 卸载 → 再挂载"下，开发期每次都会发生。
     */
    let created: PetStageLike | null = null

    /** 幂等且带保护地销毁渲染器。 */
    const safeDestroy = (): void => {
      if (destroyed) return
      destroyed = true
      // 未被接管的舞台要单独销毁：它不在 `app.stage` 的销毁链上
      // （`app.destroy(true)` 走不到它注册的那些监听）。
      if (created) {
        try {
          created.destroy()
        } catch (error) {
          console.warn('[xiaoqi] 舞台销毁失败：', error)
        }
      }
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

      const notify = (): void => {
        window.xiaoqi.notifyInteraction()
      }

      created =
        backend === 'sprite' && sheetUrl
          ? await bootSpriteStage(app, sheetUrl, spriteVersion, notify)
          : new PetStage(app, notify)

      // ⚠️ 这里**不能**再判一次 `disposed`：TS 认为它从上面那次检查之后
      //    不可能变（清理函数是同步跑的，而 await 不是它改值的时机）。
      //    真正兜住"卸载发生在 await 期间"的是清理函数里的
      //    `if (created && created !== stage)` —— 那条分支就是为它写的。
      //
      // 图集那条路可能失败（素材坏了）。失败时 `bootSpriteStage` 已经把
      // 原因报到主进程日志了，这里只需要**不要**继续装钩子——
      // 装在一个没建成的舞台上，诊断钩子会读到误导性的空状态。
      if (!created) return

      // 之后的所有代码都用这个 **const**，不再用外层的 `created`：
      // 外层那个是 `let ... | null`，在闭包里引用它会让每一行都要
      // 重新做一次空值判断。
      const live = created
      live.onAnimationStateChange((isAnimating) => {
        window.xiaoqi.notifyAnimating(isAnimating)
      })
      live.setScale(scale)
      // 拖动：按下时把光标相对宠物左上角的偏移交给主进程，
      // 之后由主进程按偏移跟随光标（渲染进程拿不到轮廓外的鼠标事件）。
      live.onDrag({
        start: (offset) => {
          window.xiaoqi.startDrag(offset)
        },
        end: () => {
          window.xiaoqi.endDrag()
        },
      })
      stageRef.current = live

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
      Reflect.set(window, '__petDebug', () => live.debugSnapshot())
      Reflect.set(window, '__petLayer', (layer: string, visible: boolean) => {
        live.debugSetLayerVisible(layer, visible)
      })
      // 触发一次交互动画。契约测试要验证"点了会有动效"时走这里——
      // `notifyInteraction()` 只到主进程，不会触发 Pixi 的弹跳。
      Reflect.set(window, '__petInteract', () => {
        live.debugTriggerInteraction()
      })

      app.ticker.add((ticker) => {
        // Pixi 的 deltaTime 是"以 60fps 为 1"的无量纲标量；
        // 除以 60 转成秒，动画时长才与帧率无关。
        live.update(ticker.deltaTime / 60)
      })

      // 初始待机档；真实档位由下面那个 effect 按形态调整。
      live.setMaxFps(FRAME_RATE.idle)
      app.start()
    }

    void boot()

    return () => {
      disposed = true
      stageRef.current = null
      // 卸载时把诊断钩子摘掉，避免在 StrictMode 的"卸载 → 再挂载"间隙里
      // 读到已销毁的实例（那个实例的场景图"看起来正常"但不画任何东西，
      // 是本轮最容易误导人的一个陷阱）。再挂载的实例会立刻重装自己的钩子。
      //
      // 用 `Reflect` 而不是 `typeof window.__petDebug`：
      // 后者在 TS 里会因为该键未声明而报 TS2339。
      Reflect.deleteProperty(window, '__petDebug')
      Reflect.deleteProperty(window, '__petLayer')
      Reflect.deleteProperty(window, '__petInteract')
      safeDestroy()
    }
  }, [containerRef, scale, backend, sheetUrl, spriteVersion])

  // ── 形态与帧率 ──
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.mode = (state?.mode ?? 'active') satisfies VisibilityMode

    // 帧率由**主进程**给出（见 PetRuntimeState.frameRate 的注释）：
    // 只有主进程同时知道"形态"与"是否正在播放交互动画"。
    const fps = state?.frameRate ?? FRAME_RATE.idle
    // ⚠️ 值 0 的语义是"停更"，而 Pixi 的 maxFPS=0 意思是**不限帧**。
    // 所以这里必须夹到 1，绝不能把 0 直接交给 Pixi ——
    // 那会让隐藏/隐身状态变成满帧空转，正好与省电目标相反。
    stage.setMaxFps(fps > 0 ? fps : 1)
  }, [state?.mode, state?.frameRate])

  // ── 情绪 → 表情 ──
  // 主进程推来的是**推断结果**（不是原始感知信号），渲染层只负责把它画出来。
  useEffect(() => {
    if (state?.emotion) stageRef.current?.setEmotion(state.emotion)
  }, [state?.emotion])

  // ── 关系基调 → 动作幅度 ──
  // 只调制已有动作的幅度（呼吸深浅、摇摆、眨眼频率、前倾），不加新动作。
  // `reserved` 是 1 倍系数，所以关系没建立时画面与从前完全一致。
  useEffect(() => {
    if (state?.mood) stageRef.current?.setMood(state.mood)
  }, [state?.mood])

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

/**
 * 建精灵图舞台：解码 → 准备（蒙版 + 帧数）→ 建舞台 → 把蒙版推给主进程。
 *
 * ── 失败时为什么要"喊出来"而不是静默 ──
 *
 * 图集坏了的表现是**宠物彻底不出现**，而窗口、托盘、记忆全都正常。
 * 如果这里静默失败，用户看到的就是"它不见了"——没有任何线索。
 * 所以失败必须走 `reportError` 进主进程日志（含堆栈），并返回 `null`
 * 让调用方知道"这次没建成"（而不是拿到一个半初始化的舞台）。
 *
 * @returns 建好的舞台；失败时 `null`（错误已经报到主进程）
 */
async function bootSpriteStage(
  app: Application,
  sheetUrl: string,
  version: number,
  onInteract: () => void,
): Promise<SpriteStage | null> {
  try {
    const spriteVersion = version as SpriteVersion
    const decoded = await decodeSpriteSheet(sheetUrl, spriteVersion)
    const sheet = prepareSpriteSheet(decoded.pixels, atlasForVersion(spriteVersion))

    const texture = Texture.from(decoded.canvas)
    const stage = new SpriteStage(app, sheet, texture, onInteract)

    // ★ 把蒙版推给主进程——**这是精灵图宠物可点的前提**。
    //   推之前主进程一律判穿透（安全侧），所以这一步失败的表现是
    //   "看得见但点不到"，而不是"挡住下层窗口"。
    window.xiaoqi.pushSpriteMask(sheet.mask)
    window.xiaoqi.reportSpriteAnimation('idle')

    // 动作变化要告诉主进程，否则它永远查 idle 的蒙版——
    // 表现是"宠物跑起来之后就点不到了"。
    //
    // 用 `setInterval` 而不是每帧上报：动作变化是几百毫秒级的事件，
    // 而每帧一条 IPC 是纯浪费（还会淹没日志）。只在**值真的变了**时发，
    // 否则这条通道会变成每 250ms 一次的噪声。
    let lastReported = 'idle'
    const timer = window.setInterval(() => {
      const snapshot = stage.debugSnapshot()
      const animation = snapshot.animation
      if (typeof animation === 'string' && animation !== lastReported) {
        lastReported = animation
        window.xiaoqi.reportSpriteAnimation(animation)
      }
    }, 250)

    // 舞台销毁时清掉计时器。挂在这里而不是 `app.destroy`：
    // 场景图销毁一定会发生，而 `Application.destroy` 没有可挂的事件。
    app.stage.once('destroyed', () => {
      window.clearInterval(timer)
    })

    return stage
  } catch (error) {
    const message =
      error instanceof SheetDecodeError
        ? `精灵图素材不可用：${error.message}`
        : `精灵图初始化失败：${String(error)}`
    // 走 reportError 而不是只 console：主进程日志是唯一可靠的取证渠道
    // （渲染进程的 console 在没有 DevTools 时读不到）。
    window.xiaoqi.reportError(message, error instanceof Error ? (error.stack ?? '') : '')
    console.error('[xiaoqi]', message, error)
    return null
  }
}
