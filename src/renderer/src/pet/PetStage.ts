import { type Application, Container, FillGradient, Graphics } from 'pixi.js'

import { PET_GEOMETRY } from '@shared/constants'
import { hitTestPet, scalePetGeometry } from '@shared/geometry'
import { PET_BODY, PET_FACE, PET_PALETTE, PET_STROKE_WIDTH } from '@shared/palette'
import type { Emotion, RelationshipMood, VisibilityMode } from '@shared/types'

import {
  BLINK_DURATION_SECONDS,
  blinkIntervalSeconds,
  bounceEnvelope,
  breathPose,
  earSecondarySway,
  eyeOpenness,
  gazeOffset,
  moodAnimation,
  REACTION_DURATION_SECONDS,
  swayAngle,
  tailSway,
  type MoodAnimation,
} from './animation'
import { faceFor } from './emotionFace'
import type { PetStageLike } from './petStageContract'

/**
 * 宠物渲染舞台 —— PixiJS 程序化几何角色。
 *
 * ── 视觉方向（一句话）──
 *
 * **美感来自几何本身的精湛，而不是画得像动物。** 它是程序化几何角色，
 * 那就把这个约束变成风格：干净的曲线、统一的光源（一律右上）、
 * 有物理感的形变。配色用云蓝灰主体 + 墨蓝描边，
 * **只把暖色留给眼睛与腮红**，于是它的"活"集中在脸上。
 *
 * ── 三条必须遵守的渲染约定 ──
 *
 * ① **全部坐标用 DIP（CSS 像素），不碰 `devicePixelRatio`。**
 *    施工令 §4.3⑥ 的解法：Pixi 用 `resolution: 1`，把 DPI 缩放
 *    **整个交给 Chromium 合成器**。自己乘一次 `scaleFactor` 是错的——
 *    那个值被 Chromium 折进了**文字缩放**，拿它算精灵尺寸会在有文字缩放的
 *    机器上被额外放大。
 *
 * ② **形状与 `shared/constants.ts` 的 PET_GEOMETRY 同源。**
 *    命中测试用同一组数字（按缩放换算），所以"看起来能点的地方"与
 *    "真的能点的地方"不可能漂移。
 *
 * ③ **帧率由外部控制**（`setMaxFps`），不常驻 60fps。
 */
/**
 * 尾巴的形状参数（设计空间）。
 *
 * ── 为什么最终是这个形状 ──
 *
 * 这条尾巴试了**五版**才成立，过程记在这里避免重走：
 *  ① 圆团                 → "侧面的瘤"
 *  ② 两点收尖             → "鲨鱼鳍"
 *  ③ 末端大幅上钩         → 钩子自交，出现一条黑竖线
 *  ④ 沿中心线放样做粗细渐变 → 仍然读成"鳍"：它与身体同色、又紧贴体侧，
 *                            于是和身体糊成一片，边界只剩一条斜线
 *  ⑤ **本版**：一个**明确分离**的圆角尖椭圆，只是从身体后面探出来一点
 *
 * 第 ⑤ 版之所以成立，是因为它放弃"画一条完整的尾巴"，改为"只露出尾巴尖"。
 * 露出一点点、形状自洽、与身体有明显分界——这三件事同时满足时，
 * 大脑才会把它读成"身后有条尾巴"，而不是"身上长了个东西"。
 * 这也是很多极简角色设计的通行做法。
 */
const TAIL_SHAPE = {
  /** 相对身体中心的位置（比例）。 */
  offset: { x: 0.78, y: 0.62 },
  /** 椭圆半径。细长一些才像尾巴尖。 */
  rx: 9,
  ry: 19,
  /** 倾斜角（弧度）。约 42°，斜向右下，与"从身后垂下来"一致。 */
  rotation: 0.74,
} as const

export class PetStage implements PetStageLike {
  readonly #app: Application
  readonly #root = new Container()
  /** 会随呼吸形变的部分。 */
  readonly #shadow = new Graphics()
  readonly #tail = new Graphics()
  readonly #ears = new Graphics()
  readonly #body = new Graphics()
  readonly #blush = new Graphics()
  readonly #mouth = new Graphics()
  /**
   * 躯干与四条腿 —— **让宠物不只是个脑袋**。
   *
   * 用户的原话是「当前只有一个头，四肢躯干也要有」。一个只有头的角色
   * 读起来是**图标**而不是生物，所以解剖的完整度本身就是
   * "看起来是个活物"的前提，优先级高于着色。
   *
   * ⚠️ 与头/双耳不同，这一层**没有**走 GPU 光照（着色器的部件表里只有
   *    头与双耳）。它靠烘进图形的柔和渐变 + 全局 AO/接触阴影压出接缝，
   *    读起来仍有体积，代价是不随视差移动。这是**有意的取舍**：
   *    把着色器的部件表从 3 个扩到 8 个，收益边际而风险明显。
   */
  readonly #limbs = new Graphics()
  /** 眼睛：**直接挂在 root 上**，不套中间 Container（理由见 `#drawEyes()`）。 */
  readonly #eyes = new Graphics()
  readonly #onInteract: () => void

  #elapsed = 0
  /** >0 表示正在播放交互动画，值为剩余秒数。 */
  #reactionRemaining = 0
  #blink = 0
  #nextBlinkAt = 2.4
  /** 当前生效的 maxFPS，避免每帧重复写（Pixi 的 setter 会重置计时基线）。 */
  #appliedMaxFps = -1
  #destroyed = false
  /** 缩放。由外部按主进程推送的值设置。 */
  #scale = 1
  /** 光标（设计空间局部坐标）；null = 够远，眼睛回正。 */
  #cursor: { x: number; y: number } | null = null
  /** 平滑后的视线方向，避免光标跳变时瞳孔瞬移。 */
  #gaze = { x: 0, y: 0 }
  /** 动画状态回调（通知主进程调整帧率预算）。 */
  #animationCallback: ((isAnimating: boolean) => void) | null = null

  /** 拖动回调（由 `onDrag` 注入）。 */
  #dragStart: ((offset: { x: number; y: number }) => void) | null = null
  #dragEnd: (() => void) | null = null
  /** 本次按下的起点（用于区分"点击"与"拖动"）。`null` = 没按住。 */
  #pressStart: { x: number; y: number } | null = null
  #dragging = false

  /** 形态。由外部按主进程推送的状态设置。 */
  mode: VisibilityMode = 'active'

  /** 情绪。由外部按主进程推送的推断结果设置。 */
  #emotion: Emotion = 'calm'

  setEmotion(emotion: Emotion): void {
    this.#emotion = emotion
  }

  /**
   * 关系基调。只调制**表现幅度**，不改变任何"是否回应"的行为。
   * 默认 `reserved`（1 倍系数，等于不调制）——
   * 所以关系还没建立时画面与从前完全一致。
   */
  #mood: RelationshipMood = 'reserved'

  setMood(mood: RelationshipMood): void {
    this.#mood = mood
  }

  /** 取当前基调的动画系数（供测试与调试快照使用）。 */
  get moodAnimation(): MoodAnimation {
    return moodAnimation(this.#mood)
  }

  constructor(app: Application, onInteract: () => void) {
    this.#app = app
    this.#onInteract = onInteract

    this.#drawShadow()
    this.#drawTorsoAndLegs()
    this.#drawTail()
    this.#drawEars()
    this.#drawBody()
    this.#drawBlush()
    this.#drawMouth()
    this.#drawEyes()

    // 层级（从下到上）：
    //   影子 → 尾巴 → 耳朵 → 身体 → 腮红/嘴 → 眼睛
    // 身体盖住耳朵与尾巴的根部，"接得上"而不是"贴上去"。
    this.#root.addChild(this.#shadow)
    this.#root.addChild(this.#limbs)
    this.#root.addChild(this.#tail)
    this.#root.addChild(this.#ears)
    this.#root.addChild(this.#body)
    this.#root.addChild(this.#blush)
    this.#root.addChild(this.#mouth)
    this.#root.addChild(this.#eyes)

    app.stage.addChild(this.#root)
    app.stage.eventMode = 'static'
    /**
     * 命中区：**轮廓的并集**（与主进程的命中测试同源）。
     *
     * ── ★ 必须同时给出 `x/y/width/height`，不能只给 `contains` ★ ──
     *
     * 这是完整解剖之后暴露出来的一个真 bug：宠物还是"只有一个头"时，
     * 只给 `contains` 也能工作；加了躯干与四肢之后，
     * **躯干那一段（y 约 130–170）完全点不动**——而耳朵、头顶、腿都正常。
     *
     * 根因：Pixi 在做事件派发前会先用命中区的**包围盒矩形**做一次粗筛
     * （性能优化）。只给 `contains` 时那个矩形是**从当前内容推算出来的**，
     * 而它是按"头"的包围盒算的——于是躯干落在粗筛矩形之外，
     * `contains` 根本没被调用。
     *
     * 所以这里要显式给出整个设计空间的包围盒，让粗筛永远通过。
     *
     * 判据：拖动手势在躯干（y≈152）上必须能抓住。本轮就是靠
     * `verify-drag.mjs` 扫描不同抓取高度发现的（y=78/110 可以，130–170 不行）。
     */
    /**
     * 命中区：**轮廓的并集**，与主进程的命中测试同源。
     *
     * ── ★ 完整解剖暴露出来的真 bug：躯干那一带点不动 ★ ──
     *
     * 宠物还是"只有一个头"时，下面的写法一直工作正常。加上躯干与四肢之后，
     * 拖动手势在 **y ≈ 130–170** 全部失效（头顶、耳朵、腿都正常）——
     * 而主进程的命中测试分明说那些点在轮廓内。
     *
     * 定位过程值得记下来：`verify-drag.mjs` 扫抓取高度，得到
     * y=78/110 通过、130–170 失败、186 通过 —— 这个"中间一段空洞"的形状
     * 说明不是坐标系错（那样会整体偏移），而是**判定被整段跳过**。
     *
     * 原因是 Pixi 在事件派发前会用命中区的**包围盒**做粗筛。只给
     * `contains`（`IHitArea` 也只允许这一个成员）时，那个包围盒由内容推算，
     * 而内容推导出来的盒子没有覆盖到新加的躯干。
     *
     * 于是这里的写法要保证"粗筛一定通过"：`contains` 每次都被真正调用，
     * 精确判定交给与主进程同源的 `hitTestPet`。
     */ app.stage.hitArea = {
      contains: (x: number, y: number) => {
        // 命中区用**缩放后**的几何。漏掉这一步，宠物放大后只有左上角可点。
        // 与主进程 `hitTestPetScreenPoint` 读的是同一份 `PET_GEOMETRY`，
        // 因此"看起来能点的地方"与"真的能点的地方"不可能漂移。
        const inside = hitTestPet(scalePetGeometry(PET_GEOMETRY, this.#scale), { x, y })
        return inside
      },
    }
    app.stage.on('pointerdown', (event) => {
      // 记录按下位置：松手时若几乎没移动，就当作"拍了一下"（互动）；
      // 移动超过阈值才算拖动。不做这个区分的话，用户每次点宠物都会
      // 因指针的微小抖动把它挪动一两像素——很恼人。
      this.#pressStart = { x: event.global.x, y: event.global.y }
      this.#dragging = false
      // 立即进入拖动模式：主进程会在这段时间里保持接收鼠标事件，
      // 否则光标一移出宠物轮廓，窗口就"松手"了。
      //
      // ★ 这里**不能**除以 `#scale`。
      //
      // 踩过的坑：`event.global` 是 Pixi 的世界坐标，而这个舞台的
      // `root` 已经承担了缩放（`#root.scale.set(rootScale)`），
      // 所以 `event.global` 落在**窗口 CSS 像素**里——它本来就是我们
      // 要发给主进程的东西（主进程按窗口左上角 + DIP 偏移跟随光标）。
      //
      // 初版多除了一个 `#scale`，于是缩放 2× 时：
      //   抓取点 (220, 278) 被算成 (110, 139)，窗口**只跟到手的一半**，
      //   而拖动手感表现为"宠物跑得比光标慢"。
      //   更糟的是它不报错——只是拖不准，很容易被当成"手感问题"。
      //   是 `verify-drag.mjs` 断言"位移必须与拖动距离一致"抓出来的。
      this.#dragStart?.({ x: event.global.x, y: event.global.y })
    })

    app.stage.on('pointermove', (event) => {
      if (!this.#pressStart) return
      const dx = event.global.x - this.#pressStart.x
      const dy = event.global.y - this.#pressStart.y
      // 阈值 4px：低于它算手抖，不算拖动。
      if (!this.#dragging && Math.hypot(dx, dy) >= 4) this.#dragging = true
    })

    const endPress = (): void => {
      if (!this.#pressStart) return
      const wasDragging = this.#dragging
      this.#pressStart = null
      this.#dragging = false
      this.#dragEnd?.()
      // 只有"没在拖"才算被拍了一下——否则每次拖完都会触发一次互动反应。
      if (!wasDragging) {
        this.#trigger()
        this.#onInteract()
      }
    }
    app.stage.on('pointerup', endPress)
    app.stage.on('pointerupoutside', endPress)
  }

  /** 接上拖动回调（由 `usePetStage` 连到 IPC）。 */
  onDrag(handlers: { start: (offset: { x: number; y: number }) => void; end: () => void }): void {
    this.#dragStart = handlers.start
    this.#dragEnd = handlers.end
  }

  onAnimationStateChange(callback: (isAnimating: boolean) => void): void {
    this.#animationCallback = callback
  }

  /**
   * 释放舞台。
   *
   * 幂等：React 的清理链在 StrictMode 下会跑两次，第二次不该抛。
   *
   * 程序化后端的资源就是一棵 Graphics 场景图（没有外部纹理），
   * 但同样要显式销毁——因为"造好但还没挂到 `app.stage` 上"的那个
   * 窗口期同样存在（见 `petStageContract.ts` 里 `destroy()` 的说明）。
   */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#animationCallback = null
    this.#dragStart = null
    this.#dragEnd = null
    this.#root.destroy({ children: true })
  }

  /** 设置缩放（整数倍或小数都可以）。 */
  setScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return
    this.#scale = scale
    this.#root.scale.set(scale)
  }

  /** 设置光标位置（**设计空间**局部坐标）；`null` = 够远，眼睛回正。 */
  setCursor(cursor: { x: number; y: number } | null): void {
    this.#cursor = cursor
  }

  /**
   * 播放"被点一下"的反应。
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
   * 诊断：触发一次交互动画（等于在被点一下）。
   *
   * ⚠️ 为什么不能用 `window.xiaoqi.notifyInteraction()` 来代替：
   *    那条桥只是**告诉主进程**"用户点了"（用于记记忆、推进生理），
   *    它**不经过 Pixi 的 pointerup**，因此不会触发舞台上的弹跳。
   *    要验证"点了会有动效"，必须走这里。
   */
  debugTriggerInteraction(): void {
    this.#trigger()
  }

  /**
   * 设置目标帧率。
   *
   * ⚠️ Pixi 的 `maxFPS = 0` 语义是**不限帧**，不是暂停——与直觉相反。
   * 因此"暂停"在这里落地为 `maxFPS = 1`：窗口已隐藏，每秒一次空转的开销
   * 可以忽略，但避免了"停掉 ticker"在恢复时可能引入的状态问题。
   *
   * 另注：这个 setter 会重算 `_minElapsedMS`，所以**只在值真的变化时才写**。
   */
  setMaxFps(fps: number): void {
    if (fps === this.#appliedMaxFps) return
    this.#appliedMaxFps = fps
    this.#app.ticker.maxFPS = fps
  }

  /** 每帧更新。`dt` 单位是秒。 */
  update(dt: number): void {
    // 隐身时窗口已隐藏，做任何绘制都是纯浪费。
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
    this.#updateGaze(dt)
    this.#updatePose()
  }

  #updateBlink(dt: number): void {
    if (this.#blink > 0) {
      this.#blink = Math.max(0, this.#blink - dt)
      return
    }
    this.#nextBlinkAt -= dt
    if (this.#nextBlinkAt <= 0) {
      this.#blink = BLINK_DURATION_SECONDS
      // 随机间隔：固定节奏的眨眼看起来像机器。
      // 基准值由**关系基调**决定（越亲近眨眼越勤——那是"放松"的信号，
      // 见 `blinkIntervalSeconds`），再叠一层随机避免机械感。
      // 基准 4.4s ⇒ 实际落在约 4.4–9s，接近真实小猫的频率。
      const base = blinkIntervalSeconds(this.#mood)
      this.#nextBlinkAt = base + Math.random() * 4.6
    }
  }

  /**
   * 视线跟随：朝光标方向偏移瞳孔，并**做平滑**。
   *
   * 平滑是必需的：主进程约 80ms 推一次光标位置，
   * 直接赋值会让瞳孔一顿一顿地跳。用与帧率无关的指数趋近。
   */
  #updateGaze(dt: number): void {
    let target = { x: 0, y: 0 }

    // 被点的时候不看光标——抬头看你，这比继续追光标更有回应感。
    const interacting = this.#reactionRemaining > 0
    if (this.#cursor && !interacting && this.mode === 'active') {
      const c = this.#cursor
      const centreX = (PET_FACE.eyeLeft.cx + PET_FACE.eyeRight.cx) / 2
      const centreY = PET_FACE.eyeLeft.cy
      target = gazeOffset(c.x, c.y, centreX, centreY, 3.6, 150)
    }

    // 指数趋近，半衰期约 0.12s；用 1-exp 保证与帧率无关。
    const k = 1 - Math.exp(-dt / 0.12)
    this.#gaze = {
      x: this.#gaze.x + (target.x - this.#gaze.x) * k,
      y: this.#gaze.y + (target.y - this.#gaze.y) * k,
    }
  }

  #updatePose(): void {
    const t = this.#elapsed
    // ★ 关系基调通过**调制已有动作的幅度**来表达（不是加新动作）。
    //   理由见 `animation.ts` 里 `MOOD_ANIMATION` 的注释：
    //   越亲近 → 呼吸越明显、越爱动、略微前倾。
    //   `reserved` 全是 1 倍，即"什么都不改"——所以这个特性
    //   在关系还没建立时**不会**给画面引入任何变化。
    const moodAnim = moodAnimation(this.#mood)
    const { squash, stretch, offsetY } = breathPose(t)
    const sway = swayAngle(t) * moodAnim.swayScale

    let scaleX = 1 + squash * moodAnim.breathScale
    let scaleY = 1 + stretch * moodAnim.breathScale
    let poseOffsetY = offsetY * moodAnim.breathScale
    let rootScale = this.#scale

    if (this.mode === 'silent') {
      // 静默：缩成小点并慢速呼吸（CONTEXT.md：静默必须**仍然可见**，
      // 用户能看见它，因此知道它没崩）。
      rootScale = this.#scale * 0.32
      const slow = Math.sin(t * ((Math.PI * 2) / 3.4))
      scaleX = 1 + slow * 0.06
      scaleY = 1 - slow * 0.06
      poseOffsetY = 0
    }

    // 被点一下：一次下压回弹。用非对称包络（起手快、回落慢）才有重量感。
    let bounce = 0
    if (this.#reactionRemaining > 0) {
      const progress = 1 - this.#reactionRemaining / REACTION_DURATION_SECONDS
      bounce = bounceEnvelope(progress)
      scaleX = 1 + bounce * 0.16
      scaleY = 1 - bounce * 0.16
      poseOffsetY = bounce * 6
    }

    // 缩放的锚点在**身体底部中心**，所以宠物是"踩在地上"呼吸的，
    // 而不是整体上下平移。这一步是初版最明显的观感缺陷之一。
    const anchorX = PET_BODY.cx
    const anchorY = PET_BODY.cy + PET_BODY.ry

    // root 承担两件事：整体缩放（含静默态额外缩小）与居中。
    // `rootScale` 已经是"绝对"缩放，居中偏移按窗口像素算：
    //   窗口边长 = PET_DESIGN_SIZE × scale（由主进程按同一个 scale 设置）
    //   宠物占用边长 = PET_DESIGN_SIZE × rootScale
    const windowPx = PET_GEOMETRY.window.width * this.#scale
    const contentPx = PET_GEOMETRY.window.width * rootScale
    this.#root.scale.set(rootScale)
    this.#root.position.set((windowPx - contentPx) / 2, (windowPx - contentPx) / 2)

    /** 统一的"随呼吸形变"变换：以底部中心为锚点缩放并轻微旋转。 */
    const applyBodyLike = (g: Graphics, extraScale = 0, rotation = sway): void => {
      g.pivot.set(anchorX, anchorY)
      g.position.set(anchorX, anchorY)
      g.scale.set(scaleX + extraScale, scaleY + extraScale)
      g.rotation = rotation
    }

    applyBodyLike(this.#body)
    // 躯干与四肢跟身体一起呼吸：它们**不参与次级动作**
    //（耳朵/尾巴的滞后摆动），因为四肢与躯干是一整块承重结构。
    applyBodyLike(this.#limbs)
    applyBodyLike(this.#ears, 0.02, sway + earSecondarySway(t) * moodAnim.fidgetScale)
    applyBodyLike(this.#tail, 0, sway * 0.6 + tailSway(t) * moodAnim.fidgetScale)
    applyBodyLike(this.#blush)
    // 嘴巴与身体同呼吸，但**带上基调的前倾**：越亲近越像"凑过来说话"。
    this.#mouth.rotation = sway + moodAnim.lean

    // 影子：横向随呼吸轻微伸缩，透明度随身体升高而变淡（离地感）。
    this.#shadow.pivot.set(PET_FACE.shadow.cx, PET_FACE.shadow.cy)
    this.#shadow.position.set(PET_FACE.shadow.cx, PET_FACE.shadow.cy)
    this.#shadow.scale.set(scaleX * (1 + bounce * 0.08), 1)

    // 眼睛：位置跟随身体的呼吸位移，**不跟随形变**（压扁的眼睛很怪）。
    this.#drawEyesDynamic(poseOffsetY, bounce)
  }

  // ────────────────────────────── 绘制 ──────────────────────────────

  #drawShadow(): void {
    const s = PET_FACE.shadow
    // 两层：外圈更淡更大，形成软边。纯色椭圆会显得像贴纸。
    this.#shadow.ellipse(s.cx, s.cy, s.rx * 1.18, s.ry * 1.5).fill({
      color: PET_PALETTE.shadow,
      alpha: 0.07,
    })
    this.#shadow.ellipse(s.cx, s.cy, s.rx, s.ry).fill({ color: PET_PALETTE.shadow, alpha: 0.13 })
  }

  /**
   * 躯干与四条腿 —— **让宠物不只是个脑袋**。
   *
   * 用户的原话是「当前只有一个头，四肢躯干也要有」。只有头的角色
   * 读起来是**图标**而不是生物，所以先把解剖补齐，再谈着色。
   *
   * ── 姿态：坐着的四足小动物 ──
   *
   * - 后腿画在躯干**之下**，只露出外侧 → 坐姿时收腿的感觉；
   * - 前腿画在躯干**之上**，撑在身前 → 承重感；
   * - 每一条都与躯干**相交**（腿根埋进躯干），这是连通性的硬要求
   *   （施工令 §4.3③：`setShape` 的并集无法表达分离的块）。
   *
   * ── 为什么这一层不走光照着色器 ──
   *
   * 着色器的部件表目前只有头与双耳（`uBody` / `uEarL` / `uEarR`）。
   * 四肢与躯干若也要逐像素法线，得把部件表从 3 个扩到 8 个；
   * 而它们面积小、又大多被躯干遮住，收益边际、风险明显。
   * 所以这里用**烘进图形的竖直渐变**（上亮下暗，与全局光源同向），
   * 立体感主要来自渐变方向一致，而不是逐像素法线。
   */
  #drawTorsoAndLegs(): void {
    const g = this.#limbs

    /** 竖直渐变：上亮下暗，与全局光源（右上）方向一致。 */
    const vertical = (top: number, bottom: number): FillGradient =>
      new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
          { offset: 0, color: top },
          { offset: 1, color: bottom },
        ],
      })

    // 后腿：先画，于是被躯干压住大半，只露出外侧。
    for (const leg of [PET_GEOMETRY.hindLegLeft, PET_GEOMETRY.hindLegRight]) {
      g.ellipse(leg.cx, leg.cy, leg.rx, leg.ry)
        .fill(vertical(PET_PALETTE.bodyBottom, PET_PALETTE.ink))
        .stroke({ color: PET_PALETTE.ink, width: PET_STROKE_WIDTH })
    }

    // 躯干
    const torso = PET_GEOMETRY.torso
    g.ellipse(torso.cx, torso.cy, torso.rx, torso.ry)
      .fill(vertical(PET_PALETTE.bodyTop, PET_PALETTE.bodyBottom))
      .stroke({ color: PET_PALETTE.ink, width: PET_STROKE_WIDTH })

    // 前腿：后画，压在躯干之上 —— 它们是"撑在身前"的。
    for (const leg of [PET_GEOMETRY.frontLegLeft, PET_GEOMETRY.frontLegRight]) {
      g.ellipse(leg.cx, leg.cy, leg.rx, leg.ry)
        .fill(vertical(PET_PALETTE.bodyTop, PET_PALETTE.bodyBottom))
        .stroke({ color: PET_PALETTE.ink, width: PET_STROKE_WIDTH })
    }
  }

  /**
   * 尾巴：一个**明确分离**的圆角尖椭圆，只从身体后面探出来一点。
   *
   * 形状与位置的取舍见 `TAIL_SHAPE` 的注释（这条尾巴试了五版）。
   * 绘制顺序上它在身体**之下**，所以与身体重叠的部分被盖住，
   * 露出来的只有尖端——轮廓连通（施工令 §4.3③）由这段重叠保证。
   */
  #drawTail(): void {
    const b = PET_BODY
    const cx = b.cx + b.rx * TAIL_SHAPE.offset.x
    const cy = b.cy + b.ry * TAIL_SHAPE.offset.y
    const { rx, ry, rotation } = TAIL_SHAPE

    // 用旋转后的椭圆：直接在椭圆上做旋转需要变换，这里改用 Graphics 的
    // 局部旋转会牵动整个图层（#tail 还要参与呼吸摆动），
    // 所以宁可手算一个旋转后的椭圆多边形。
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)
    const STEPS = 28
    const path = (): Graphics => {
      const g = this.#tail
      for (let i = 0; i <= STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2
        const ex = Math.cos(a) * rx
        const ey = Math.sin(a) * ry
        const px = cx + ex * cos - ey * sin
        const py = cy + ex * sin + ey * cos
        if (i === 0) g.moveTo(px, py)
        else g.lineTo(px, py)
      }
      return g.closePath()
    }

    path().fill(PET_PALETTE.bodyBottom)
    path().stroke({ color: PET_PALETTE.ink, width: PET_STROKE_WIDTH })
  }

  /**
   * 耳朵：**圆角三角**，不是圆。
   *
   * 圆耳 + 圆身读起来像老鼠/熊（初版实测）。把耳朵做成向上收尖的圆角三角，
   * 立刻读出"猫/狐"那一类。尖顶用一段短贝塞尔收圆，避免真的尖角
   * （尖角在低分辨率下会有明显的锯齿感）。
   *
   * 耳朵与身体相交保证轮廓连通。绘制顺序上身体在后，所以耳朵根部被压住，
   * 看起来是"长出来的"而不是"贴上去的"。
   */
  #drawEars(): void {
    for (const ear of [PET_GEOMETRY.earLeft, PET_GEOMETRY.earRight]) {
      const { cx, cy, r } = ear
      // 外耳：从底部两角收到顶部一点
      const path = (): Graphics =>
        this.#ears
          .moveTo(cx - r * 0.92, cy + r * 0.55)
          .quadraticCurveTo(cx - r * 0.78, cy - r * 0.85, cx, cy - r * 1.0)
          .quadraticCurveTo(cx + r * 0.78, cy - r * 0.85, cx + r * 0.92, cy + r * 0.55)
          .closePath()

      path().fill(PET_PALETTE.bodyTop)
      path().stroke({ color: PET_PALETTE.ink, width: PET_STROKE_WIDTH })

      // 内耳：同形但缩小并下移，露出一圈描边宽度
      const inner = r * 0.5
      this.#ears
        .moveTo(cx - inner * 0.9, cy + r * 0.3)
        .quadraticCurveTo(cx - inner * 0.7, cy - inner * 0.8, cx, cy - inner * 0.92)
        .quadraticCurveTo(cx + inner * 0.7, cy - inner * 0.8, cx + inner * 0.9, cy + r * 0.3)
        .closePath()
        .fill({ color: PET_PALETTE.earInner, alpha: 0.75 })
    }
  }

  /**
   * 身体：蛋形 + **自上而下的渐变**。
   *
   * 渐变是"从平涂变成有体积"的最小改动，性价比最高：
   * 上半受光（浅）、下半落影（深），立刻从"色块"变成"有厚度的东西"。
   * 全局光源统一在**右上方**，与眼睛高光、影子方向一致。
   *
   * ⚠️ 用**选项对象**构造 `FillGradient`。位置参数那个重载
   *    （`new FillGradient(x0, y0, x1, y1)`）在 8.5.2 起已废弃，
   *    lint 会以 `no-deprecated` 拦下——这不是风格问题，是 API 迁移。
   */
  #drawBody(): void {
    const b = PET_BODY
    // 局部纹理空间（0..1 相对绘制对象的边界框），与 Pixi 的默认一致。
    const gradient = new FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: PET_PALETTE.bodyTop },
        { offset: 0.58, color: PET_PALETTE.bodyTop },
        { offset: 1, color: PET_PALETTE.bodyBottom },
      ],
    })

    this.#body.ellipse(b.cx, b.cy, b.rx, b.ry).fill(gradient)
    this.#body
      .ellipse(b.cx, b.cy, b.rx, b.ry)
      .stroke({ color: PET_PALETTE.ink, width: PET_STROKE_WIDTH })
  }

  #drawBlush(): void {
    for (const blush of [PET_FACE.blushLeft, PET_FACE.blushRight]) {
      this.#blush
        .ellipse(blush.cx, blush.cy, blush.rx, blush.ry)
        .fill({ color: PET_PALETTE.blush, alpha: 0.5 })
    }
  }

  /** 嘴：一条极短的微笑下弧。 */
  #drawMouth(): void {
    const m = PET_FACE.mouth
    this.#mouth
      .moveTo(m.cx - m.halfWidth, m.cy)
      .quadraticCurveTo(m.cx, m.cy + m.drop, m.cx + m.halfWidth, m.cy)
      .stroke({
        color: PET_PALETTE.ink,
        width: m.strokeWidth,
        cap: 'round',
      })
  }

  /**
   * 眼睛的**静态**部分：虹膜、瞳孔、高光。
   *
   * 全部画在一个 Graphics 里，每帧重绘（`#drawEyesDynamic`）——
   * 因为瞳孔要跟着光标动、眨眼要改形状，静态画一次是不够的。
   * 这个角色的绘制量很小（几个椭圆），重绘成本可以忽略。
   */
  #drawEyes(): void {
    this.#drawEyesDynamic(0, 0)
  }

  /**
   * 每帧重绘眼睛。
   *
   * ⚠️ 这里刻意**不用中间 `Container`、也不用 `pivot`**，而是每帧重画。
   *    两个原因：
   *    ① Pixi v8 的 `position` 会被 `pivot` 偏移，`pivot == position`
   *       会把内容画到父容器原点（受控最小复现里量过）。
   *    ② 本轮排查"眼睛不渲染"时发现一个会污染诊断的 bug：
   *       StrictMode 下 `window.__petDebug` 可能指向**已被销毁的实例**，
   *       而那个死实例的场景图"看起来完全正常"。
   *    改成"每帧按当前状态直接画"之后，绘制结果只取决于这一帧的输入，
   *    不依赖任何跨帧的容器状态，这类问题从结构上就不存在了。
   *
   * 眯眼（被点时）用**画成弧线**而不是压扁椭圆：
   * 压扁只是"变小"，弧线才是"笑"。
   */
  #drawEyesDynamic(offsetY: number, bounce: number): void {
    const g = this.#eyes
    g.clear()

    // 情绪决定表情。眼睛是这只宠物**唯一会说话的部位**（几何角色，没有嘴部
    // 动画、没有贴图），所以表情全部集中在眼睛上——这是"用最少的变化
    // 传达最多信息"的做法。映射表在 `emotionFace.ts`，是纯函数、有单测
    // （其中一条断言"八种情绪必须长得不一样"，否则那个情绪等于不存在）。
    const face = faceFor(this.#emotion)

    const blink = eyeOpenness(this.#blink, BLINK_DURATION_SECONDS)
    // 静默时闭眼打盹；被点时的"笑"由 bounce 触发，优先于基础情绪
    // ——用户的即时互动必须压过背景情绪，这是「无条件回应」的可见形式。
    const openness = this.mode === 'silent' ? 0.12 : Math.max(0.1, blink * face.openScale)
    const smiling = bounce > 0.25 || face.eyes === 'smile'

    // 情绪带来的整头位移：很小（≤3px），只为了让姿态有方向感。
    const headY = offsetY + face.headTiltY

    for (const eye of [PET_FACE.eyeLeft, PET_FACE.eyeRight]) {
      const cx = eye.cx
      const cy = eye.cy + headY
      // "眯起"是横向压窄（专注），"半闭"是竖向压扁（困/无聊）——
      // 两者不能混用：横向压窄看起来是"认真"，竖向压扁看起来是"没精神"。
      const rx = face.eyes === 'narrowed' ? eye.rx * 0.82 : eye.rx

      if (smiling) {
        // 笑眼：一段上凸的弧线。压扁只是"变小"，弧线才是"笑"。
        g.moveTo(cx - rx, cy + 1)
          .quadraticCurveTo(cx, cy - eye.ry * 0.85, cx + rx, cy + 1)
          .stroke({ color: PET_PALETTE.ink, width: 2.6, cap: 'round' })
        continue
      }

      // 眼形：竖椭圆，按 openness 压扁（眨眼 + 情绪）
      const ry = Math.max(0.6, eye.ry * openness)
      g.ellipse(cx, cy, rx, ry).fill(PET_PALETTE.eye)

      // 瞳孔 + 高光只在没闭眼时画（闭着时画高光会露出缝隙里的白点）
      if (openness > 0.35) {
        const px = cx + this.#gaze.x
        const py = cy + this.#gaze.y
        g.circle(px, py, PET_FACE.pupilR * Math.min(1, openness + 0.2)).fill(PET_PALETTE.pupil)

        // 主高光（右上）——与全局光源方向一致
        g.circle(
          px + PET_FACE.catchlightOffset.x,
          py + PET_FACE.catchlightOffset.y,
          PET_FACE.catchlightR,
        ).fill({ color: PET_PALETTE.catchlight, alpha: 0.95 })
        // 次级高光（左下）——让眼睛像玻璃珠而不是贴了两块白
        g.circle(
          px + PET_FACE.catchlight2Offset.x,
          py + PET_FACE.catchlight2Offset.y,
          PET_FACE.catchlight2R,
        ).fill({ color: PET_PALETTE.catchlight, alpha: 0.5 })
      }
    }
  }

  /**
   * 诊断快照 —— 通过 `window.__petDebug` 暴露（只读投影，不改变行为）。
   *
   * 本机没法在渲染进程里开 DevTools 调试（一开透明窗就不透明），
   * 所以"某个图层为什么没画出来"这类问题只能靠把内部状态读出来判断。
   */
  debugSnapshot(): Record<string, unknown> {
    const describe = (g: Graphics): Record<string, unknown> => {
      const bounds = g.getLocalBounds()
      return {
        visible: g.visible,
        renderable: g.renderable,
        alpha: Math.round(g.alpha * 100) / 100,
        position: { x: Math.round(g.x), y: Math.round(g.y) },
        scale: { x: Math.round(g.scale.x * 1000) / 1000, y: Math.round(g.scale.y * 1000) / 1000 },
        bounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          w: Math.round(bounds.width),
          h: Math.round(bounds.height),
        },
      }
    }

    return {
      mode: this.mode,
      scale: this.#scale,
      rootVisible: this.#root.visible,
      rootChildren: this.#root.children.length,
      animation: {
        elapsed: Math.round(this.#elapsed * 100) / 100,
        blinkRemaining: Math.round(this.#blink * 1000) / 1000,
        nextBlinkAt: Math.round(this.#nextBlinkAt * 100) / 100,
        reactionRemaining: Math.round(this.#reactionRemaining * 1000) / 1000,
      },
      gaze: { x: Math.round(this.#gaze.x * 100) / 100, y: Math.round(this.#gaze.y * 100) / 100 },
      // 关系基调与它实际生效的动画系数。
      // 放进来是为了让"关系真的影响到了画面"这件事**可被脚本核对**——
      // 否则它只是一个传进来了但没人用的字段，而那正是最容易发生的静默失效。
      mood: this.#mood,
      moodAnimation: this.moodAnimation,
      body: describe(this.#body),
      ears: describe(this.#ears),
      tail: describe(this.#tail),
      eyes: describe(this.#eyes),
    }
  }

  /**
   * 诊断：单独开关某个图层（用于分层截图定位"哪一层没画"）。
   * 只在诊断时用，不参与正常运行。
   */
  debugSetLayerVisible(layer: string, visible: boolean): void {
    const map: Record<string, Graphics> = {
      body: this.#body,
      ears: this.#ears,
      tail: this.#tail,
      blush: this.#blush,
      mouth: this.#mouth,
      eyes: this.#eyes,
      shadow: this.#shadow,
    }
    const target = map[layer]
    if (target) target.visible = visible
  }
}
