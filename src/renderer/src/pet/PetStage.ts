import { type Application, Container, Graphics } from 'pixi.js'

import { PET_GEOMETRY } from '@shared/constants'
import { PET_FACE, PET_PALETTE } from '@shared/palette'

import { BLINK_DURATION_SECONDS, breathPose, eyeOpenness, swayAngle } from './animation'

/** 交互动画时长（秒）。 */
export const REACTION_DURATION_SECONDS = 0.9

/**
 * 宠物渲染舞台 —— PixiJS 程序化几何角色。
 *
 * ── 三条必须遵守的渲染约定 ──
 *
 * ① **全部坐标用 DIP（CSS 像素），不碰 `devicePixelRatio`。**
 *    这是施工令 §4.3⑥ 的解法：Pixi 用 `resolution: 1`，
 *    把 DPI 缩放**整个交给 Chromium 合成器**。
 *    自己乘一次 `scaleFactor` 是错的——那个值被 Chromium 折进了**文字缩放**
 *    （源码原话：1.5 文字 × 2.0 显示 → device_scale_factor = 3.0），
 *    拿它算精灵尺寸会在有文字缩放的机器上放大 1.5 倍。
 *    保持 1 CSS px = 1 纹理 px，高 DPI 屏上依然清晰，因为合成器负责放大。
 *
 * ② **形状与 `shared/constants.ts` 的 PET_GEOMETRY 同源。**
 *    命中测试用的是同一组数字，所以"看起来能点的地方"与"真的能点的地方"
 *    不可能漂移。这是 openai/codex 桌宠那批"命中区与可见形象脱节" bug
 *    （#42190 / #34227）的结构性对策。
 *
 * ③ **帧率由外部控制**（`setMaxFps`），不常驻 60fps。
 */
export class PetStage {
  readonly #app: Application
  readonly #root = new Container()
  readonly #body = new Graphics()
  readonly #ears = new Graphics()
  readonly #tail = new Graphics()
  readonly #shadow = new Graphics()
  readonly #cheeks = new Graphics()
  // 眼睛没有中间 Container：直接是挂在 root 上的 Graphics。理由见 `#drawEyes()`。
  readonly #eyeLeftGraphics = new Graphics()
  readonly #eyeRightGraphics = new Graphics()
  readonly #onInteract: () => void

  #elapsed = 0
  /** >0 表示正在播放交互动画，值为剩余秒数。 */
  #reactionRemaining = 0
  #blink = 0
  #nextBlinkAt = 2.2
  /** 当前生效的 maxFPS，避免每帧重复写（Pixi 的 setter 会重置计时基线）。 */
  #appliedMaxFps = -1

  constructor(app: Application, onInteract: () => void) {
    this.#app = app
    this.#onInteract = onInteract

    this.#drawShadow()
    this.#drawTail()
    this.#drawEars()
    this.#drawBody()
    this.#drawCheeks()
    this.#drawEyes()

    // 层级：影子在最底、身体覆盖尾巴根部与耳朵根部、五官在最上。
    //
    // 注意眼睛是**直接把 Graphics 挂在 root 上**，没有中间 Container——
    // 理由见 `#drawEyes()` 的注释（套 Container 会导致眼睛一个像素都不画）。
    this.#root.addChild(this.#shadow)
    this.#root.addChild(this.#tail)
    this.#root.addChild(this.#ears)
    this.#root.addChild(this.#body)
    this.#root.addChild(this.#cheeks)
    this.#root.addChild(this.#eyeLeftGraphics)
    this.#root.addChild(this.#eyeRightGraphics)

    app.stage.addChild(this.#root)
    app.stage.eventMode = 'static'
    app.stage.hitArea = {
      contains: (x: number, y: number) => {
        const b = PET_GEOMETRY.body
        const dl = PET_GEOMETRY.earLeft
        const dr = PET_GEOMETRY.earRight
        const dt = PET_GEOMETRY.tailTip
        const inEllipse = ((x - b.cx) / b.rx) ** 2 + ((y - b.cy) / b.ry) ** 2 <= 1
        const inCircle = (c: { cx: number; cy: number; r: number }): boolean =>
          (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r * c.r
        return inEllipse || inCircle(dl) || inCircle(dr) || inCircle(dt)
      },
    }
    app.stage.on('pointerdown', () => {
      this.#trigger()
      this.#onInteract()
    })
  }

  /** 交互动画开始/结束的回调（用于通知主进程调整帧率预算）。 */
  #animationCallback: ((isAnimating: boolean) => void) | null = null

  onAnimationStateChange(callback: (isAnimating: boolean) => void): void {
    this.#animationCallback = callback
  }

  /**
   * 播放"被拍一下"的反应。
   *
   * M1 只有这一种反应，所以不设参数；M2 接入 8 种情绪时再引入
   * `reaction` 判别参数并在这里分派。（有意识地不加"预留参数"——
   * 一个永远不会传第二个值的参数只会让类型收窄失效。）
   */
  #trigger(): void {
    this.#reactionRemaining = REACTION_DURATION_SECONDS
    this.#animationCallback?.(true)
  }

  /**
   * 设置目标帧率。
   *
   * ⚠️ Pixi 的 `maxFPS = 0` 语义是**不限帧**，不是暂停——与直觉相反。
   * 因此"暂停"在这里落地为 `maxFPS = 1`：窗口已隐藏，每秒一次空转的开销
   * 可以忽略，但避免了"停掉 ticker"在恢复时可能引入的状态问题。
   *
   * 另注：这个 setter 会重算 `_minElapsedMS`，所以**只在值真的变化时才写**，
   * 否则每帧重写会不断推后帧计时基线。
   */
  setMaxFps(fps: number): void {
    if (fps === this.#appliedMaxFps) return
    this.#appliedMaxFps = fps
    this.#app.ticker.maxFPS = fps
  }

  /** 每帧更新。`dt` 单位是秒。 */
  update(dt: number): void {
    // 隐身时窗口已隐藏，做任何绘制都是纯浪费。
    // （此时 ticker 已被压到 1fps，但 1fps 也仍是"每秒醒来一次"。）
    if (this.mode === 'hidden') return

    this.#elapsed += dt

    if (this.#reactionRemaining > 0) {
      this.#reactionRemaining -= dt
      if (this.#reactionRemaining <= 0) {
        this.#reactionRemaining = 0
        this.#animationCallback?.(false)
      }
    }

    this.#updateBlink(dt)
    this.#updatePose()
  }

  // ────────────────────────────── 动画 ──────────────────────────────

  #updateBlink(dt: number): void {
    if (this.#blink > 0) {
      this.#blink = Math.max(0, this.#blink - dt)
      return
    }
    this.#nextBlinkAt -= dt
    if (this.#nextBlinkAt <= 0) {
      this.#blink = BLINK_DURATION_SECONDS
      // 随机间隔：固定节奏的眨眼看起来像机器。2.2–6.5s 接近真实小猫的频率。
      this.#nextBlinkAt = 2.2 + Math.random() * 4.3
    }
  }

  #updatePose(): void {
    const t = this.#elapsed
    const { breath, squash, stretch, offsetY } = breathPose(t)
    const sway = swayAngle(t)

    let scaleX = 1 + squash
    let scaleY = 1 + stretch
    let poseOffsetY = offsetY
    let rootScale = 1

    if (this.mode === 'silent') {
      // 静默：缩成小点并慢速呼吸（CONTEXT.md：静默必须**仍然可见**，
      // 用户能看见它，因此知道它没崩）。
      rootScale = 0.3
      const slow = Math.sin(t * ((Math.PI * 2) / 3.4))
      scaleX = 1 + slow * 0.06
      scaleY = 1 - slow * 0.06
      poseOffsetY = 0
    }

    if (this.#reactionRemaining > 0) {
      // 被拍一下：一次快速的下压回弹（squash & stretch）。
      const progress = 1 - this.#reactionRemaining / REACTION_DURATION_SECONDS
      // 0 → 1 → 0 的钟形曲线
      const bump = Math.sin(progress * Math.PI)
      scaleX = 1 + bump * 0.14
      scaleY = 1 - bump * 0.14
      poseOffsetY = bump * 5
    }

    const b = PET_GEOMETRY.body
    this.#root.scale.set(rootScale)
    this.#root.position.set(
      ((1 - rootScale) * PET_GEOMETRY.window.width) / 2,
      ((1 - rootScale) * PET_GEOMETRY.window.height) / 2,
    )

    // 以身体底部中心为缩放锚点，这样呼吸时脚是"踩在地上"的。
    this.#body.pivot.set(b.cx, b.cy + b.ry)
    this.#body.position.set(b.cx, b.cy + b.ry)
    this.#body.scale.set(scaleX, scaleY)
    this.#body.rotation = sway

    this.#ears.pivot.set(b.cx, b.cy + b.ry)
    this.#ears.position.set(b.cx + poseOffsetY * 0.35, b.cy + b.ry)
    this.#ears.scale.set(scaleX + 0.02, scaleY + 0.02)
    this.#ears.rotation = sway

    this.#tail.pivot.set(b.cx, b.cy + b.ry)
    this.#tail.position.set(b.cx + poseOffsetY * 0.2, b.cy + b.ry)
    this.#tail.scale.set(scaleX, scaleY)
    // 尾巴摆动幅度略大于身体，产生"甩尾"的次级动作。
    this.#tail.rotation = sway * 3.2 + Math.sin(t * 1.7) * 0.05

    this.#cheeks.pivot.set(b.cx, b.cy + b.ry)
    this.#cheeks.position.set(b.cx, b.cy + b.ry)
    this.#cheeks.scale.set(scaleX, scaleY)

    // 眼睛：位置跟随身体的呼吸位移，但**不跟随形变**。
    //
    // Graphics 的局部原点就在眼心（形状画在 (0,0)，见 `#drawEyes()`），
    // 所以 `position` 直接等于眼睛坐标，`scale.y` 就是眨眼开合度，
    // 且缩放天然以眼心为锚点——不需要 pivot，也就绕开了 Pixi 的
    // "position 被 pivot 偏移"那个坑。
    for (const [graphics, eye] of [
      [this.#eyeLeftGraphics, PET_FACE.eyeLeft],
      [this.#eyeRightGraphics, PET_FACE.eyeRight],
    ] as const) {
      graphics.position.set(eye.cx, eye.cy + poseOffsetY)
    }

    const openness = this.mode === 'silent' ? 0.1 : eyeOpenness(this.#blink, BLINK_DURATION_SECONDS)
    this.#eyeLeftGraphics.scale.set(1, openness)
    this.#eyeRightGraphics.scale.set(1, openness)

    // 影子随呼吸轻微收缩，强化"有重量"的感觉。
    this.#shadow.scale.set(scaleX, 1)
    this.#shadow.alpha = 0.16 - breath * 0.02
  }

  // ────────────────────────────── 绘制 ──────────────────────────────

  #drawShadow(): void {
    const s = PET_FACE.shadow
    this.#shadow.ellipse(s.cx, s.cy, s.rx, s.ry).fill({
      color: PET_PALETTE.shadow,
      alpha: 1,
    })
  }

  #drawTail(): void {
    const t = PET_GEOMETRY.tailTip
    // 先描边后填充：两遍绘制同一形状，得到有描边的实心圆。
    this.#tail.circle(t.cx, t.cy, t.r).fill(PET_PALETTE.body)
    this.#tail.circle(t.cx, t.cy, t.r).stroke({ color: PET_PALETTE.outline, width: 3 })
  }

  #drawEars(): void {
    for (const ear of [PET_GEOMETRY.earLeft, PET_GEOMETRY.earRight]) {
      this.#ears.circle(ear.cx, ear.cy, ear.r).fill(PET_PALETTE.body)
      this.#ears.circle(ear.cx, ear.cy, ear.r).stroke({ color: PET_PALETTE.outline, width: 3 })
      // 耳廓：内侧一小圈暖色，让耳朵不是两个死板的圆。
      this.#ears
        .circle(ear.cx, ear.cy + 1, ear.r * 0.45)
        .fill({ color: PET_PALETTE.cheek, alpha: 0.55 })
    }
  }

  #drawBody(): void {
    const b = PET_GEOMETRY.body
    this.#body.ellipse(b.cx, b.cy, b.rx, b.ry).fill(PET_PALETTE.body)
    this.#body.ellipse(b.cx, b.cy, b.rx, b.ry).stroke({ color: PET_PALETTE.outline, width: 3 })
  }

  #drawCheeks(): void {
    for (const cheek of [PET_FACE.cheekLeft, PET_FACE.cheekRight]) {
      this.#cheeks
        .ellipse(cheek.cx, cheek.cy, cheek.rx, cheek.ry)
        .fill({ color: PET_PALETTE.cheek, alpha: 0.5 })
    }
  }

  #drawEyes(): void {
    // ★ 眼睛的写法（含一次代价很高的排查，改之前请读完）★
    //
    // 做法：形状画在 `Graphics` 的**局部原点 (0,0)**，再把整个 Graphics
    // 平移到眼睛坐标。这样"Graphics 原点 = 眼睛中心 = 缩放锚点"三者重合，
    // 眨眼时按 y 缩放就是以眼心为锚点压扁，**完全不需要 pivot**。
    //
    // ⚠️ 不要把眼睛放进一层中间 `Container` 再靠 `pivot`/`position` 定位。
    //    这里记录**两条确实被量到的事实**，以及一条**我没有定论**的观察。
    //
    //    【事实 1｜可直接复现】Pixi v8 的 `position` 是**被 `pivot` 偏移过的**：
    //          pivot=(0,0)    position=(100,120) → worldTransform.tx=100, ty=120  ✅
    //          pivot=(100,60) position=(100,60)  → worldTransform.tx=0,   ty=0    ❌
    //      即 `pivot == position` 会把内容画到**父容器原点**。
    //      这是在受控最小复现里量出来的，与下面的观察无关，独立成立。
    //
    //    【观察｜结论存疑】当时把两只眼睛各包一层 `Container`（pivot 设 (0,0)、
    //      position 设眼睛坐标）后，看到的现象是眼睛**一个像素都不画**，
    //      且不报任何错：canvas 正常、`visible`/`renderable` 全为 true、
    //      `getLocalBounds()` 与 `worldTransform` 都"看起来正确"（tx=90, ty=133）。
    //
    //      ⚠️ **但这条观察后来被发现有混淆因素**：同一个 `useEffect` 里还有一个
    //      真实的 bug —— React 19 StrictMode 会挂载两次，而当时
    //      `window.__petDebug` 钩子可能仍指向**已被销毁的第一个 Application**。
    //      那个已销毁实例的场景图恰好也"看起来完全正常"。
    //      所以我**无法确定**当年的"不渲染"是容器路径本身的问题，
    //      还是读到了死实例的快照。根因**未定位**，不要引用为"容器有 bug"。
    //
    //    当前写法（不套容器、不用 pivot）依然保留，理由只剩一条且足够：
    //    它让"容器原点 = 眼睛中心 = 缩放锚点"三者重合，绕开了【事实 1】，
    //    同时满足眨眼需求，且比多一层容器更少间接。
    for (const [graphics, eye] of [
      [this.#eyeLeftGraphics, PET_FACE.eyeLeft],
      [this.#eyeRightGraphics, PET_FACE.eyeRight],
    ] as const) {
      graphics.circle(0, 0, eye.r).fill(PET_PALETTE.eye)
      // 高光：让眼睛看起来"有神"。偏右上，是通行的卡通打光方向。
      graphics
        .circle(eye.r * 0.32, -eye.r * 0.34, eye.r * 0.3)
        .fill({ color: 0xffffff, alpha: 0.9 })
      graphics.position.set(eye.cx, eye.cy)
    }
  }

  /**
   * 诊断：单独开关某个图层。
   *
   * 用来回答"某个图层到底有没有被画到屏幕上"——把其他图层关掉再看，
   * 就能排除遮挡/层级判断的干扰。只在诊断时用，不参与正常运行。
   */
  debugSetLayerVisible(
    layer: 'body' | 'ears' | 'tail' | 'cheeks' | 'eyes' | 'shadow',
    visible: boolean,
  ): void {
    switch (layer) {
      case 'body':
        this.#body.visible = visible
        break
      case 'ears':
        this.#ears.visible = visible
        break
      case 'tail':
        this.#tail.visible = visible
        break
      case 'cheeks':
        this.#cheeks.visible = visible
        break
      case 'eyes':
        this.#eyeLeftGraphics.visible = visible
        this.#eyeRightGraphics.visible = visible
        break
      case 'shadow':
        this.#shadow.visible = visible
        break
    }
  }

  /** 形态。由外部按主进程推送的状态设置。 */
  mode: 'active' | 'silent' | 'hidden' = 'active'

  /**
   * 诊断快照 —— 通过 `window.__petDebug` 暴露（只读投影，不改变行为）。
   *
   * 本机没法在渲染进程里开 DevTools 调试（一开透明窗就不透明），
   * 所以"某个图层为什么没画出来"这类问题只能靠把内部状态读出来判断。
   * 排查眼睛不渲染那次，这些字段是把范围从"整段渲染管线"缩到
   * "就是眼睛那块"的关键。
   */
  debugSnapshot(): Record<string, unknown> {
    const describe = (container: Container): Record<string, unknown> => {
      const bounds = container.getLocalBounds()
      return {
        visible: container.visible,
        alpha: container.alpha,
        x: Math.round(container.x * 100) / 100,
        y: Math.round(container.y * 100) / 100,
        scaleX: Math.round(container.scale.x * 1000) / 1000,
        scaleY: Math.round(container.scale.y * 1000) / 1000,
        localBounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          w: Math.round(bounds.width),
          h: Math.round(bounds.height),
        },
      }
    }

    return {
      rootVisible: this.#root.visible,
      rootChildren: this.#root.children.length,
      // 动画的实时内部量：判断"眼睛没画出来"是几何问题还是动画问题
      // （例如误判成一直在眨眼）必须看这几个值。
      animation: {
        elapsed: Math.round(this.#elapsed * 100) / 100,
        blinkRemaining: Math.round(this.#blink * 1000) / 1000,
        nextBlinkAt: Math.round(this.#nextBlinkAt * 100) / 100,
        reactionRemaining: Math.round(this.#reactionRemaining * 1000) / 1000,
      },
      mode: this.mode,
      body: describe(this.#body),
      ears: describe(this.#ears),
      eyesLeft: describe(this.#eyeLeftGraphics),
      eyesRight: describe(this.#eyeRightGraphics),
    }
  }
}
