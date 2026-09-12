import { type Application, Container, Rectangle, Sprite, Texture } from 'pixi.js'

import type { CodexAnimationName } from '@shared/petAtlas'
import { animationDuration, frameAt, LOOK_DIRECTIONS } from '@shared/petAtlas'
import { hitTestSpriteMask } from '@shared/spriteMask'
import type { Emotion, RelationshipMood, VisibilityMode } from '@shared/types'

import { isLoopingAnimation, selectSpriteAnimation, lookFromCursor, type SpriteAnimationSelection } from './spriteAnimation'
import { frameRectsFor, lookRectFor, type PreparedSpriteSheet } from './spriteSheet'
import type { PetStageLike } from './petStageContract'

/**
 * 精灵图后端的舞台。
 *
 * ── 它和 `PetStage`（程序化后端）的关系 ──
 *
 * 两者提供**同一套对外的成员**（mode / setScale / setMaxFps / update /
 * setCursor / setEmotion / setMood / onDrag / onAnimationStateChange /
 * debugTriggerInteraction / debugSnapshot / debugSetLayerVisible），
 * 于是 `usePetStage` 不需要关心现在跑的是哪一条后端。
 * 这条约定由 `petStageContract.ts` 里的接口 + 一组类型测试钉住——
 * 少一个成员就会在切换后端时变成运行期 undefined 调用。
 *
 * ── 玩法上的差别（必须承认，不要假装两条后端一样）──
 *
 * 程序化后端有 8 种情绪、会眨眼、会呼吸、瞳孔跟着光标转。
 * 精灵图后端只有图集给的 9 个动作：它更**好看**（可以换成任何人画好的素材），
 * 但**表现力更低**。`setEmotion`/`setMood` 在这里仍然被接受，
 * 只是映射到图集里语义最接近的动作（见 `spriteAnimation.ts` 的对照表）。
 */

/** 交互动作播完之后停多久再回到常态（秒）。 */
const REACTION_HOLD_SECONDS = 1.1

/** 驱动一次动作选择的间隔（秒）。 */
//
// 为什么不是每帧都重选：选择本身很便宜，但它会产生**新的帧计时基准**——
// 每帧重选等于把匿名动画永远钉在第 0 帧。所以按固定节奏采样"该播哪个动作"，
// 在两次采样之间让帧自己走。
const RESELECT_INTERVAL_SECONDS = 0.12

export class SpriteStage implements PetStageLike {
  /** 隐身 / 静默 / 正常。由 `usePetStage` 跟随主进程状态设置。 */
  mode: VisibilityMode = 'active'

  readonly #app: Application
  readonly #sheet: PreparedSpriteSheet
  readonly #root = new Container()
  readonly #sprite: Sprite
  readonly #onInteract: () => void

  /** 每个动作切好的纹理（图集只加载一次，帧纹理复用）。 */
  readonly #frames = new Map<CodexAnimationName, Texture[]>()
  /** 16 个注视方向的纹理（V1 为空）。 */
  readonly #lookFrames = new Map<number, Texture>()

  #current: SpriteAnimationSelection = { animation: 'idle', look: null, oneShot: false }
  /** 当前动作已经播了多久（秒）。 */
  #animationElapsed = 0
  /** 距离下一次重新选择还有多久（秒）。 */
  #reselectIn = 0
  /** 交互动作剩余的保持时间（秒）。 */
  #reactionRemaining = 0

  #scale = 1
  #cursor: { x: number; y: number } | null = null
  #emotion: Emotion = 'calm'
  #mood: RelationshipMood = 'reserved'
  #waiting = false
  #reviewing = false

  #appliedMaxFps = -1
  #animationCallback: ((isAnimating: boolean) => void) | null = null
  #dragStart: ((offset: { x: number; y: number }) => void) | null = null
  #dragEnd: (() => void) | null = null
  #pressStart: { x: number; y: number } | null = null
  #dragging = false

  constructor(
    app: Application,
    sheet: PreparedSpriteSheet,
    sheetTexture: Texture,
    onInteract: () => void,
  ) {
    this.#app = app
    this.#sheet = sheet
    this.#onInteract = onInteract

    this.#buildFrameTextures(sheetTexture)

    const first = this.#frames.get('idle')?.[0] ?? sheetTexture
    this.#sprite = new Sprite(first)
    // 锚点放在左上角：帧矩形是绝对像素坐标，锚点居中的话每换一帧都要重算位置。
    this.#sprite.anchor.set(0, 0)
    this.#root.addChild(this.#sprite)
    app.stage.addChild(this.#root)

    this.#installPointerInput()
    this.#applyFrame()
  }

  /** 把整张图集按动作切成帧纹理。 */
  #buildFrameTextures(sheetTexture: Texture): void {
    const { atlas, playableFrames } = this.#sheet

    for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
      const frames = playableFrames[name] ?? 1
      const rects = frameRectsFor(atlas, name, frames)
      const textures: Texture[] = []
      for (const rect of rects) {
        textures.push(
          new Texture({
            source: sheetTexture.source,
            frame: new Rectangle(rect.x, rect.y, rect.width, rect.height),
          }),
        )
      }
      this.#frames.set(name, textures)
    }

    for (const direction of LOOK_DIRECTIONS) {
      const rect = lookRectFor(atlas, direction)
      if (!rect) continue
      this.#lookFrames.set(
        direction,
        new Texture({
          source: sheetTexture.source,
          frame: new Rectangle(rect.x, rect.y, rect.width, rect.height),
        }),
      )
    }
  }

  // ── 指针输入 ──
  //
  // 与 `PetStage` 同一套手势语义（按下 → 移动超阈值算拖动 → 松手算拍一下）。
  // 之所以复制而不是抽公用：两边的差异在**命中区**，而命中区是与各自
  // 渲染后端绑死的（这里是蒙版点阵，那边是椭圆并集）。抽公用会把
  // 唯一的差异点也一起抽走，剩下一个需要参数化的空壳。

  #installPointerInput(): void {
    const app = this.#app
    app.stage.eventMode = 'static'
    app.stage.hitArea = {
      contains: (x: number, y: number) => this.#hitTest(x, y),
    }

    app.stage.on('pointerdown', (event) => {
      this.#pressStart = { x: event.global.x, y: event.global.y }
      this.#dragging = false
      // 与 PetStage 一样，这里**不除以缩放**：`event.global` 已经是窗口 CSS 像素。
      this.#dragStart?.({ x: event.global.x, y: event.global.y })
    })

    app.stage.on('pointermove', (event) => {
      if (!this.#pressStart) return
      const dx = event.global.x - this.#pressStart.x
      const dy = event.global.y - this.#pressStart.y
      if (!this.#dragging && Math.hypot(dx, dy) >= 4) this.#dragging = true
    })

    const endPress = (): void => {
      if (!this.#pressStart) return
      const wasDragging = this.#dragging
      this.#pressStart = null
      this.#dragging = false
      this.#dragEnd?.()
      if (!wasDragging) {
        this.#trigger()
        this.#onInteract()
      }
    }
    app.stage.on('pointerup', endPress)
    app.stage.on('pointerupoutside', endPress)
  }

  /**
   * 渲染进程侧的命中判定：查**当前动作**的蒙版点阵。
   *
   * ⚠️ 这只是 Pixi 事件派发的粗筛，**真正决定"窗口收不收鼠标事件"的是主进程**
   *    （那里每 80ms 轮询光标 + 翻转 `setIgnoreMouseEvents`）。
   *    两者用的是同一份蒙版与同一套换算（`hitTestSpriteMask`），
   *    但渲染进程这边用**当前动作**、主进程那边可能稍微滞后几十毫秒——
   *    这个滞后是已知的、可接受的（见 docs/verify-sprite.md）。
   */
  #hitTest(x: number, y: number): boolean {
    const { mask, atlas } = this.#sheet
    // 窗口尺寸由**契约格宽 × 缩放**算出，与主进程用的是同一个式子
    // （主进程那边是 `spriteWindowSize(atlas, scale)`，数学上相同）。
    // 用同一个式子而不是读 Pixi 的实际尺寸，是为了避免"渲染器与主进程
    // 各自取整、慢慢漂开"——那正是本项目反复踩过的坑。
    return hitTestSpriteMask(
      mask.masks[this.#current.animation],
      x,
      y,
      atlas.cellWidth * this.#scale,
      atlas.cellHeight * this.#scale,
      mask.grid,
    )
  }

  onDrag(handlers: { start: (offset: { x: number; y: number }) => void; end: () => void }): void {
    this.#dragStart = handlers.start
    this.#dragEnd = handlers.end
  }

  onAnimationStateChange(callback: (isAnimating: boolean) => void): void {
    this.#animationCallback = callback
  }

  setScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return
    this.#scale = scale
    this.#root.scale.set(scale)
  }

  /** 光标在**设计空间**（未缩放）里的局部坐标；`null` = 够远。 */
  setCursor(cursor: { x: number; y: number } | null): void {
    this.#cursor = cursor
  }

  /**
   * 情绪。精灵图后端**接受但降级**——见文件头的说明与 `spriteAnimation.ts`。
   *
   * 刻意保留这个方法而不是删掉：删了之后 `usePetStage` 就得按后端分支调不同的
   * 方法，那正是"四条调用路径各自判断后端"的开端。接受并映射是更小的代价。
   */
  setEmotion(emotion: Emotion): void {
    this.#emotion = emotion
    // 情绪一变立刻重选，不要等到下一个采样点——否则"点了它"要过一百多毫秒才有反应
    this.#reselectIn = 0
  }

  /**
   * 关系基调。精灵图后端**只把它映射到 idle 的活跃程度**。
   *
   * 三个取值都只是"更亲近"，没有"冷淡"档（见 types.ts）。这里用它调制
   * 重新选择动作的节奏：关系越亲近，采样越密（反应更灵敏）。
   * 幅度上的差别（呼吸深浅、摇摆）精灵图表达不了——那是程序化后端的活。
   */
  setMood(mood: RelationshipMood): void {
    this.#mood = mood
  }

  /** 语境标记：等用户 / 检视。由调用方按会话状态设置。 */
  setContext(context: { readonly waiting?: boolean; readonly reviewing?: boolean }): void {
    if (context.waiting !== undefined) this.#waiting = context.waiting
    if (context.reviewing !== undefined) this.#reviewing = context.reviewing
    this.#reselectIn = 0
  }

  #trigger(): void {
    this.#reactionRemaining = REACTION_HOLD_SECONDS
    this.#animationCallback?.(true)
  }

  debugTriggerInteraction(): void {
    this.#trigger()
  }

  setMaxFps(fps: number): void {
    if (fps === this.#appliedMaxFps) return
    this.#appliedMaxFps = fps
    this.#app.ticker.maxFPS = fps
  }

  /** 每帧更新。`dt` 单位是秒。 */
  update(dt: number): void {
    if (this.mode === 'hidden') return

    if (this.#reactionRemaining > 0) {
      this.#reactionRemaining -= dt
      if (this.#reactionRemaining <= 0) {
        this.#reactionRemaining = 0
        this.#animationCallback?.(false)
      }
    }

    this.#reselectIn -= dt
    if (this.#reselectIn <= 0) {
      this.#reselectIn = this.#reselectInterval()
      const next = this.#select()
      if (next.animation !== this.#current.animation) {
        this.#current = next
        this.#animationElapsed = 0
      } else {
        // 同一个动作：只更新注视方向，**不重置帧计时**
        this.#current = next
      }
    }

    this.#animationElapsed += dt
    this.#applyFrame()
  }

  /** 关系越亲近，重新选择越密（反应更灵敏）。 */
  #reselectInterval(): number {
    switch (this.#mood) {
      case 'attached':
        return RESELECT_INTERVAL_SECONDS * 0.5
      case 'warm':
        return RESELECT_INTERVAL_SECONDS * 0.75
      case 'reserved':
        return RESELECT_INTERVAL_SECONDS
    }
  }

  #select(): SpriteAnimationSelection {
    const { atlas } = this.#sheet
    const selection = selectSpriteAnimation({
      mode: this.mode,
      emotion: this.#emotion,
      // 工作模式在精灵图后端**不参与选择**：它是"用户的处境"，
      // 而程序化后端用呼吸/摇摆幅度表达这件事；图集没有对应动作。
      // 传 'rest' 而不是传真实值，是为了让 selectSpriteAnimation 的
      // 「工作模式 → 动作」那一层在这里永远命中 idle 分支——
      // 否则"用户在开会"会把宠物钉在 waiting 上，看起来像卡住。
      workMode: 'rest',
      reactionRemaining: this.#reactionRemaining,
      cursorOffset: this.#cursorOffset(),
      waiting: this.#waiting,
      reviewing: this.#reviewing,
    })

    // ★ 一次性动作播完要回落。
    //
    // 不这么做的话，`selectSpriteAnimation` 只看 reactionRemaining，
    // 而那个值由交互事件驱动——用户不再点，它会永远停在挥手那一帧。
    if (this.#current.oneShot && !isLoopingAnimation(this.#current.animation)) {
      const total = animationDuration(atlas, this.#current.animation) / 1000
      if (this.#animationElapsed >= total) {
        this.#reactionRemaining = 0
        return { animation: 'idle', look: lookFromCursor(this.#cursorOffset()), oneShot: false }
      }
    }
    return selection
  }

  /** 光标相对**精灵格中心**的偏移（设计空间像素）。 */
  #cursorOffset(): { x: number; y: number } | null {
    if (!this.#cursor) return null
    const { atlas } = this.#sheet
    return {
      x: this.#cursor.x - atlas.cellWidth / 2,
      y: this.#cursor.y - atlas.cellHeight / 2,
    }
  }

  /** 把当前动作 + 当前帧（或注视方向）落到纹理上。 */
  #applyFrame(): void {
    const { atlas, playableFrames } = this.#sheet

    // 注视方向优先：它只在 idle 时被给出，且每格就是一张静态图
    if (this.#current.look !== null && this.#current.animation === 'idle') {
      const lookTexture = this.#lookFrames.get(this.#current.look)
      if (lookTexture) {
        this.#sprite.texture = lookTexture
        return
      }
      // V1 没有注视行：回落到普通 idle（不是错误，是素材能力所限）
    }

    const frames = this.#frames.get(this.#current.animation)
    if (!frames || frames.length === 0) return
    const count = Math.min(frames.length, playableFrames[this.#current.animation] ?? frames.length)
    const index = frameAt(atlas, this.#current.animation, this.#animationElapsed * 1000)
    const safe = Math.min(index, count - 1)
    const texture = frames[safe]
    if (texture) this.#sprite.texture = texture
  }

  debugSnapshot(): Record<string, unknown> {
    return {
      backend: 'sprite',
      mode: this.mode,
      scale: this.#scale,
      atlasVersion: this.#sheet.atlas.version,
      animation: this.#current.animation,
      look: this.#current.look,
      oneShot: this.#current.oneShot,
      elapsed: Math.round(this.#animationElapsed * 100) / 100,
      reactionRemaining: Math.round(this.#reactionRemaining * 1000) / 1000,
      mood: this.#mood,
      // 帧纹理的数量与当前用的那一张——"画出来是空白"时第一个要看的就是它
      frameCounts: Object.fromEntries(
        [...this.#frames.entries()].map(([name, list]) => [name, list.length]),
      ),
      currentFrameRect: {
        x: Math.round(this.#sprite.texture.frame.x),
        y: Math.round(this.#sprite.texture.frame.y),
        w: Math.round(this.#sprite.texture.frame.width),
        h: Math.round(this.#sprite.texture.frame.height),
      },
      maskAnimations: Object.keys(this.#sheet.mask.masks),
      rootVisible: this.#root.visible,
    }
  }

  /**
   * 诊断：单独开关某个图层。
   *
   * 精灵图后端**只有一层**（整只宠物就是一张图的切片），所以这里只认
   * `'body'`（等同于整只）与 `'all'`。保留这个方法是为了让
   * `usePetStage` 的 `__petLayer` 钩子在两条后端下都能调用而不报错。
   */
  debugSetLayerVisible(layer: string, visible: boolean): void {
    if (layer === 'body' || layer === 'all') {
      this.#sprite.visible = visible
    }
  }
}
