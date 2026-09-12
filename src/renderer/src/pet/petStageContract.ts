import type { Emotion, RelationshipMood, VisibilityMode } from '@shared/types'

/**
 * 宠物舞台的**对外契约** —— 两条渲染后端必须提供同一套成员。
 *
 * ── 为什么需要这个文件 ──
 *
 * `usePetStage` 是唯一驱动舞台的地方：它设形态、设缩放、设情绪、设光标、
 * 接拖动、接帧率、装诊断钩子。它**不该知道**现在跑的是程序化后端还是图集后端。
 *
 * 但没有这个接口时，"两条后端成员一致"只是一句口头约定：
 * 图集后端少实现一个 `debugSetLayerVisible`，`usePetStage` 里那行
 * `stage?.debugSetLayerVisible(...)` 在切换后端时就是运行期 undefined 调用——
 * 而 TypeScript 看不出来，因为它只看到 `PetStage` 或 `SpriteStage` 其中之一。
 *
 * 有了接口之后，两个类都**显式声明 implements**，少一个成员立刻编译失败。
 * 这就是它的全部价值：把"记得实现"变成"编译器强制"。
 */
export interface PetStageLike {
  /** 当前形态。由 `usePetStage` 跟随主进程状态写入。 */
  mode: VisibilityMode

  setScale(scale: number): void
  setMaxFps(fps: number): void
  /** 每帧更新，`dt` 单位是**秒**。 */
  update(dt: number): void

  /** 光标在**设计空间**（未缩放）里的局部坐标；`null` = 够远，回正。 */
  setCursor(cursor: { x: number; y: number } | null): void

  /**
   * 情绪。
   *
   * ⚠️ 两条后端的**表现力不同**：程序化后端把它画成表情，
   *    图集后端只能映射到语义最接近的动作（见 `spriteAnimation.ts`）。
   *    接口一致不代表效果一致——这一点写在 `docs/verify-sprite.md` 的已知限制里。
   */
  setEmotion(emotion: Emotion): void

  /** 关系基调。程序化后端调制动作幅度；图集后端只调制反应灵敏度。 */
  setMood(mood: RelationshipMood): void

  onDrag(handlers: {
    start: (offset: { x: number; y: number }) => void
    end: () => void
  }): void

  onAnimationStateChange(callback: (isAnimating: boolean) => void): void

  /** 诊断：触发一次交互动画（等于被拍一下）。 */
  debugTriggerInteraction(): void
  /** 诊断：读舞台内部状态（只读投影）。 */
  debugSnapshot(): Record<string, unknown>
  /** 诊断：单独开关某个图层。 */
  debugSetLayerVisible(layer: string, visible: boolean): void
}
