import type { CodexAnimationName } from '@shared/petAtlas'
import { nearestLookDirection, type LookDirection } from '@shared/petAtlas'
import type { Emotion, VisibilityMode, WorkMode } from '@shared/types'

/**
 * 「宠物现在该播哪一格」—— 纯函数，可单测。
 *
 * ── ★ 先说清楚一个必须承认的落差 ★
 *
 * 程序化小奇有 **8 种情绪**（施工令 §4.6：happy/calm/sleepy/focused/aggrieved/
 * surprised/close/bored），而 Codex 图集只有 **9 个动作**
 * （idle / running-right / running-left / waving / jumping / failed /
 *   waiting / running / review）。
 *
 * 这两套词汇**不是一一对应的**：图集里没有"专注"这个词条，
 * 也没有"困"和"无聊"。硬凑会得到一堆牵强的映射。
 *
 * 所以这里的态度是：
 *   1. 能对应上的**如实对应**（happy → waving、aggrieved → failed）；
 *   2. 对应不上的**明确回落到 idle**，并在下面的表里写清楚"为什么回落"，
 *      而不是随便挑一个看起来差不多但语义不对的动作；
 *   3. 把这个落差写进 `docs/verify-sprite.md` 的已知限制里，不藏着。
 *
 * ⚠️ 后果要说清楚：**精灵图后端的表现力低于程序化后端**。
 *    它换来的是"可以用第三方画好的精美素材"。这是一次交易，不是升级。
 *    用户想要完整 8 情绪时，程序化后端仍然在（`kind: 'procedural'`）。
 */

/** 一次性的动作（播完就回 idle）与持续动作（循环）的区别。 */
export interface SpriteAnimationSelection {
  /** 要播放的动作。 */
  readonly animation: CodexAnimationName
  /**
   * 注视方向（V2 才有意义）；`null` = 不换格、保持当前帧。
   *
   * 只在播 idle 时给出：奔跑/挥手时"看向光标"在视觉上是错的
   * （那些动作的姿态已经把注意力放在动作本身上了）。
   */
  readonly look: LookDirection | null
  /** 这个选择是不是**一次性**的（播完应回落 idle）。 */
  readonly oneShot: boolean
}

/** 选择动作所需的全部输入。刻意都是一个快照里的字段，不引入新状态。 */
export interface SpriteAnimationInput {
  readonly mode: VisibilityMode
  readonly emotion: Emotion
  readonly workMode: WorkMode
  /**
   * 交互动作还剩多久（秒）。`> 0` 表示"刚被点/刚被搭话"。
   *
   * 由**调用方**维护倒计时，这里只根据它选动作——这样"什么时候重置计时"
   * 这件事留在有状态的那一侧，选择逻辑保持纯净、可穷举测试。
   */
  readonly reactionRemaining: number
  /** 光标相对**精灵格中心**的偏移（设计空间像素）；`null` = 不知道 / 太远。 */
  readonly cursorOffset: { readonly x: number; readonly y: number } | null
  /** 是否处于"等待用户"的语境（会话等待、长任务挂起）。 */
  readonly waiting: boolean
  /** 是否处于"审查/检视"的语境。 */
  readonly reviewing: boolean
}

/**
 * 情绪 → 动作的对照表。
 *
 * ── 每一行都写下理由，因为"为什么是这个"比"是什么"更容易被后人改错 ──
 */
const EMOTION_ANIMATION: Readonly<
  Record<Emotion, { readonly animation: CodexAnimationName; readonly why: string }>
> = {
  happy: { animation: 'waving', why: '高兴 → 挥手，最接近"开心地打招呼"的现成动作' },
  surprised: { animation: 'jumping', why: '惊讶 → 跳起来，图集里唯一有"弹起"语义的动作' },
  aggrieved: { animation: 'failed', why: '委屈 → failed（垂头丧气），语义最贴近' },
  close: { animation: 'waving', why: '亲近 → 挥手；图集没有"蹭过来"这类动作' },
  // ── 以下四个**刻意回落 idle**，不是遗漏 ──
  calm: { animation: 'idle', why: '平静本来就是 idle 的定义' },
  focused: { animation: 'idle', why: '图集没有"专注"词条；review 是"检视文档"，不是"专注工作"' },
  sleepy: { animation: 'idle', why: '图集没有"困"；waiting 是"等用户"，语义不同，硬用会误导' },
  bored: { animation: 'idle', why: '图集没有"无聊"；waiting 表达的是期待而不是无聊' },
}

/**
 * 工作模式 → 动作的对照表。
 *
 * ⚠️ 只在**情绪没有更强的主张**（即情绪映射到 idle）时才看工作模式。
 *    顺序反过来的话，"用户在开会"会盖掉"宠物很高兴"，那就本末倒置了：
 *    情绪是**宠物自己的状态**，工作模式是**用户的处境**。
 */
const WORK_MODE_ANIMATION: Readonly<
  Partial<Record<WorkMode, { readonly animation: CodexAnimationName; readonly why: string }>>
> = {
  coding: { animation: 'running', why: '编码 → running（在原地忙），图集里最像"在干活"' },
  focus: { animation: 'running', why: '专注 → 同样用 running；它表示"持续在做事"' },
  email: { animation: 'review', why: '邮件 → review（看文档/审阅）' },
  meeting: { animation: 'waiting', why: '会议 → waiting（安静地待着，不打扰）' },
  rest: { animation: 'idle', why: '休息 → idle，它也该歇着' },
  offWork: { animation: 'idle', why: '下班 → idle' },
  weekend: { animation: 'idle', why: '周末 → idle' },
  overtime: { animation: 'running', why: '加班 → running；但**不做任何评判**，只是陪着' },
}

/** 交互（被点/被搭话）时的动作：挥手，一秒左右回落到常态。 */
const REACTION_ANIMATION: CodexAnimationName = 'waving'

/**
 * 选动作。
 *
 * ── 优先级（从高到低） ──
 *
 * 1. **隐身**：什么都不播（窗口本来就不可见，省掉一次判断之后的全部工作）；
 * 2. **静默**：idle。静默的语义是"缩小并几乎不动"，不该播挥手/跳跃；
 * 3. **交互回应**：用户刚点了我 → 挥手。ADR-0003 要求**无条件回应**，
 *    所以这一条排在情绪与工作模式**之前**——不能因为"宠物正在忙"就不理人；
 * 4. **等用户**：waiting；
 * 5. **检视**：review；
 * 6. **情绪**；
 * 7. **工作模式**；
 * 8. 兜底 idle。
 *
 * 注视方向只在最终落到 idle 时给（见 `SpriteAnimationSelection.look` 的说明）。
 */
export function selectSpriteAnimation(input: SpriteAnimationInput): SpriteAnimationSelection {
  if (input.mode === 'hidden') {
    // 窗口不可见。返回 idle 只是为了让调用方有个确定的动作可以停在那儿，
    // 它不会真的被画出来。
    return { animation: 'idle', look: null, oneShot: false }
  }

  if (input.mode === 'silent') {
    return { animation: 'idle', look: null, oneShot: false }
  }

  if (input.reactionRemaining > 0) {
    return { animation: REACTION_ANIMATION, look: null, oneShot: true }
  }

  if (input.waiting) {
    return { animation: 'waiting', look: null, oneShot: false }
  }

  if (input.reviewing) {
    return { animation: 'review', look: null, oneShot: false }
  }

  const byEmotion = EMOTION_ANIMATION[input.emotion]
  if (byEmotion.animation !== 'idle') {
    // 情绪有明确主张：一次性动作（挥手/跳/垂头）播完要回 idle，
    // 所以标 oneShot——由调用方的倒计时负责回落。
    return { animation: byEmotion.animation, look: null, oneShot: true }
  }

  const byWork = WORK_MODE_ANIMATION[input.workMode]
  if (byWork && byWork.animation !== 'idle') {
    return { animation: byWork.animation, look: null, oneShot: false }
  }

  return { animation: 'idle', look: lookFromCursor(input.cursorOffset), oneShot: false }
}

/**
 * 由光标偏移算出注视方向。
 *
 * ── 两处极易搞反的地方，都在这里收口 ──
 *
 * ① **0° 是正上（12 点钟），不是正前方。**
 *    图集规范如此。搞反的表现是"光标在头顶时它才看着你"，很微妙但错。
 * ② **屏幕 y 轴向下**，而图集角度以"上"为 0、顺时针增加。
 *
 * 把这两件事合成一个式子：以"右"为第一分量、"上"为第二分量做 `atan2`，
 * 其中"上"= `-offset.y`（因为屏幕 y 向下为正）：
 *
 *     角度 = atan2(offset.x, -offset.y)
 *
 * 逐象限验证：
 *   - 上 `(0,-1)` → atan2(0, 1)   =   0°   ✔
 *   - 右 `(1, 0)` → atan2(1, 0)   =  90°   ✔（顺时针）
 *   - 下 `(0, 1)` → atan2(0, -1)  = 180°   ✔
 *   - 左 `(-1,0)` → atan2(-1, 0)  = -90° → 规范化 270° ✔
 *
 * ⚠️ 不要写成 `atan2(-offset.y, offset.x) + 90`：那样正上方会算成 180°
 *    （正下方），上下整体镜像。这是本文件踩过的坑，测试里钉住了四个正方向。
 *
 * `atan2` 返回 (-180, 180]，而 `nearestLookDirection` 自己会规范化成 [0, 360)，
 * 所以负角不用在这里处理。
 *
 * @param offset 光标相对精灵格**中心**的偏移（设计空间像素；y 向下为正）
 * @returns 16 向之一；`offset` 为 null 或落在中心死区时返回 `null`（保持当前帧）
 */
export function lookFromCursor(
  offset: { readonly x: number; readonly y: number } | null,
): LookDirection | null {
  if (!offset) return null

  // 死区：光标几乎压在中心时方向是噪声（一点点抖动就换格，看起来像抽搐）。
  // 阈值取设计空间里的 6 像素——比人手抖动大一点，又远小于格子尺寸。
  const DEAD_ZONE = 6
  if (Math.abs(offset.x) < DEAD_ZONE && Math.abs(offset.y) < DEAD_ZONE) return null

  const degrees = (Math.atan2(offset.x, -offset.y) * 180) / Math.PI
  return nearestLookDirection(degrees)
}

/**
 * 一个动作是不是循环播放的（用于决定"播完要不要回 idle"）。
 *
 * 单独一个函数而不是在调用处判断：`oneShot` 字段与这张表必须一致，
 * 两处各写一份就会漂移（表现为某个动作播完之后卡住不动）。
 */
export function isLoopingAnimation(animation: CodexAnimationName): boolean {
  switch (animation) {
    case 'idle':
    case 'running':
    case 'waiting':
    case 'review':
      return true
    case 'waving':
    case 'jumping':
    case 'failed':
    case 'running-left':
    case 'running-right':
      return false
  }
}

/**
 * 供日志/验证脚本读的对照说明。
 *
 * 存在的理由：把"为什么这个情绪落到这个动作"变成**可 grep 的字符串**，
 * 而不是只存在于我脑子里。排查"精灵图模式下它怎么不动"时，
 * 第一件事就是看这张表。
 */
export function describeAnimationChoice(input: SpriteAnimationInput): string {
  const selection = selectSpriteAnimation(input)
  if (selection.animation !== 'idle') {
    return `${input.emotion}/${input.workMode} → ${selection.animation}`
  }
  return `${input.emotion}/${input.workMode} → idle（${EMOTION_ANIMATION[input.emotion].why}）`
}

/** 情绪 → 动作的原始对照（给测试与文档用，不参与运行时决策）。 */
export function emotionAnimationTable(): Readonly<
  Record<Emotion, { readonly animation: CodexAnimationName; readonly why: string }>
> {
  return EMOTION_ANIMATION
}

/** 工作模式 → 动作的原始对照（同上）。 */
export function workModeAnimationTable(): Readonly<
  Partial<Record<WorkMode, { readonly animation: CodexAnimationName; readonly why: string }>>
> {
  return WORK_MODE_ANIMATION
}
