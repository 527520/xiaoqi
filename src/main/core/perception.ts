import { QUNS_POLL_INTERVAL_MS } from '@shared/constants'
import type { Emotion, RelationshipMood, UserNotificationState, WorkMode } from '@shared/types'

import type { Platform } from '../platform'
import {
  INITIAL_PHYSIOLOGY,
  stepEmotion,
  stepPhysiology,
  type EmotionState,
  type Physiology,
} from './physiology'
import { CATEGORY_LABELS, type AppCategory } from './processTable'
import {
  INITIAL_RELATIONSHIP,
  missesUser,
  relationshipMood,
  relationshipStrength,
  stepRelationship,
  type Relationship,
} from './relationship'
import { inferWorkMode } from './workMode'

/**
 * 感知轮询 + 状态推进。
 *
 * ── 三件事，一件事一个文件，这里只做"串起来"和"节流" ──
 *
 * - `platform/win32.ts`：怎么读三项信号（唯一允许调原生库的地方）
 * - `core/workMode.ts` / `core/physiology.ts`：怎么推断（纯函数，可单测）
 * - **本文件**：什么时候读、读到的值怎么累积成状态
 *
 * 之所以把"节流"单独放一层：感知轮询频率是**耗电与隐私的双重问题**——
 * 读得越勤，CPU 越忙，而"我们多久看一眼用户"本身也是用户关心的事。
 *
 * ── 轮询频率是刻意的低频 ──
 *
 * 2 秒一次（与 QUNS 同频）。理由：
 * ① 工作模式的变化是分钟级的（打开一个应用、进入会议），2 秒足够灵敏；
 * ② 空闲时长的阈值是 20 分钟，更不需要高频；
 * ③ 施工令 §4.3⑩ 明确「耗电是隐形差评源」。
 *
 * **不要为了"更实时"把它调到几百毫秒**：那既没有产品收益，
 * 又会让任务管理器里出现一个持续占用 CPU 的进程。
 */

export interface PerceivedState {
  /** 前台进程名（小写），`null` = 拿不到。**永不含窗口标题。** */
  readonly processName: string | null
  readonly category: AppCategory
  readonly idleMs: number | null
  readonly notificationState: UserNotificationState
  readonly workMode: WorkMode
  readonly workModeReason: string
  readonly emotion: EmotionState
  readonly physiology: Physiology
  /**
   * 关系状态（好感/信任/默契）。
   *
   * ⚠️ 它**只影响表现**，不影响"是否回应"。见 `core/relationship.ts`
   *    文件头的三条硬约束与 ADR-0003。
   */
  readonly relationship: Relationship
  /** 由关系强度得出的表现基调。**三个取值都是"更亲近"，没有"更冷淡"。** */
  readonly mood: RelationshipMood
  /** 关系是否已淡到"想念"的程度（**不是**"被冷落"）。 */
  readonly misses: boolean
  /** 连续使用同一应用类别的时长（毫秒）。 */
  readonly sameCategoryMs: number
  /** 上一次真正读到信号的时刻（毫秒）。 */
  readonly sampledAt: number
  /**
   * 感知器已经运行了多久（毫秒）。
   *
   * 单列出来是为了让调试面板**可核对**：生理量每小时只变几个百分点，
   * 只显示百分比的话，"它在动"与"它卡住了"看起来一模一样
   * （本机第一次跑调试面板时就没法判断——20 秒内所有数字都没变）。
   */
  readonly uptimeMs: number
  /**
   * 最近一次被判定为"休眠"的时间跳变（毫秒）；没有过则为 0。
   *
   * 单列出来是为了让这件事**可见**：否则"合盖 8 小时后宠物为什么没饿"
   * 只能靠读代码才知道，而调试面板上看不出它发生过。
   */
  readonly lastSuspendMs: number
}

export interface PerceptionOptions {
  readonly platform: Platform
  /** 状态变化时的回调（调试面板与渲染层用）。 */
  readonly onState?: (state: PerceivedState) => void
  /** 时钟注入，便于单测。默认 `Date.now`。 */
  readonly now?: () => number
  /**
   * 轮询间隔（毫秒），默认 `QUNS_POLL_INTERVAL_MS`（2000）。
   *
   * ⚠️ 只给测试与取证用。生产路径**不要**传它，更不要把默认值调小：
   * 2 秒是"够灵敏 + 省电"的折中（见文件头注释）。测试里传小值是为了
   * 在几秒内观察到生理量的变化——生理量每小时只变几个百分点，
   * 用 2 秒间隔根本看不出它在动。
   */
  readonly intervalMs?: number
}

/**
 * 感知器。用 `start()` / `dispose()` 管理生命周期。
 *
 * 没有做成"每次都读"的纯函数，是因为它要**跨轮次累积**两件事：
 * ① 同一应用类别的连续时长（用于判定"专注"）；
 * ② 生理量（随时间演进）。
 * 但**判定逻辑全部是纯函数**，所以这个类只有"累积"这点状态，容易验证。
 */
export class Perception {
  readonly #platform: Platform
  readonly #onState: ((state: PerceivedState) => void) | null
  readonly #now: () => number
  readonly #intervalMs: number

  #timer: NodeJS.Timeout | null = null
  #disposed = false

  #physiology: Physiology = INITIAL_PHYSIOLOGY
  #relationship: Relationship = INITIAL_RELATIONSHIP
  #emotion: EmotionState = { emotion: 'calm', since: 0 }
  #category: AppCategory = 'unknown'
  #sameCategorySince = 0
  #lastStepAt = 0
  /** 最近一次采样的时刻。与 `#lastStepAt` 不同：这个**不被休眠补偿清零**， 供外部算真实间隔。 */
  #lastSampleAt = 0
  #startedAt = 0
  #hadInteraction = false
  /** 最近一次被判定为"休眠"的时间跳变（毫秒）。仅用于调试面板。 */
  #lastSuspendMs = 0
  #snapshot: PerceivedState | null = null

  constructor(options: PerceptionOptions) {
    this.#platform = options.platform
    this.#onState = options.onState ?? null
    this.#now = options.now ?? Date.now
    this.#intervalMs = options.intervalMs ?? QUNS_POLL_INTERVAL_MS

    // ⚠️ 时间基准必须在**构造时**初始化，不能等到 `start()`。
    //
    // 初版把这两个字段留成 0，于是第一次 tick 算出的 `elapsedMs`
    // 是"从 1970 年到现在"，`sameCategoryMs` 报出 **2981 万分钟**，
    // 直接被判成"专注"，同时生理量按 56 年推进、精力瞬间归零。
    // 单测里"第一次 tick 应该是 coding"这条把它抓出来了。
    //
    // 教训：**"起点"这类状态不能依赖"某个方法先被调用"**——
    // 只要存在一条不经过 `start()` 就能 tick 的路径（测试、调试面板、
    // 或将来某个直接调 tick 的地方），就会静默地算出一个荒谬的值。
    const now = this.#now()
    this.#lastStepAt = now
    this.#lastSampleAt = now
    this.#sameCategorySince = now
    this.#startedAt = now
    this.#emotion = { emotion: 'calm', since: now }
  }

  get snapshot(): PerceivedState | null {
    return this.#snapshot
  }

  /**
   * 最近一次采样的时刻（毫秒）。
   *
   * 与 `#lastStepAt` 的区别：那个在休眠补偿时会被**清零重置**，
   * 这个始终是"真的采样时刻"。外部（`powerMonitor` 的处理器）
   * 需要算**真实间隔**才能判断该不该补偿，所以必须拿这个。
   */
  get lastSampleAt(): number {
    return this.#lastSampleAt
  }

  start(): void {
    if (this.#disposed || this.#timer) return
    this.tick()
    this.#timer = setInterval(() => {
      this.tick()
    }, this.#intervalMs)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** 用户与宠物互动了（喂食、点击）。会影响生理与情绪。 */
  noteInteraction(): void {
    this.#hadInteraction = true
  }

  /**
   * 机器休眠过（合盖、睡眠、或时钟跳变）。由 `powerMonitor` 事件或
   * `tick()` 里的时间跳变检测调用。
   *
   * ── 为什么这件事必须被显式处理，而不是让时间自然流逝 ──
   *
   * 休眠期间**用户什么都没做**。若把这段时间按"正在工作"喂给生理曲线，
   * 就会凭空造出一段不存在的用户行为，宠物醒来时表现成
   * "你连续工作了一整天"——那是**在拿用户没做的事评价他**，
   * 与 §1.2⑦「宠物不衡量用户」直接冲突。
   *
   * 正确处理只有两种：
   * - **生理不推进**（它没有陪你熬过那段时间）；
   * - **关系温和地"想念"一下**，且**有上限**——想念不是惩罚，
   *    不能让"出差两周"把关系打回原点。这里的上限就是
   *    `SUSPEND_MISS_CAP_MS`（按 12 小时结算），
   *    所以离开再久，一次结算也不会比"离开半天"更重。
   *
   * @returns 被"忽略"掉的毫秒数（供调试面板显示，让这件事可见）
   */
  noteSuspend(gapMs: number): number {
    if (!Number.isFinite(gapMs) || gapMs <= SUSPEND_GAP_MS) return 0
    this.#noteSuspend(gapMs)
    return gapMs
  }

  #noteSuspend(gapMs: number): void {
    // 关系按"想念"结算，但**封顶**。用户休假回来该感到被想念，
    // 而不是感到被记账。
    const billable = Math.min(gapMs, SUSPEND_MISS_CAP_MS)
    this.#relationship = stepRelationship(this.#relationship, billable, 'rest', {
      positiveInteraction: false,
    })
    this.#lastSuspendMs = gapMs
  }

  /**
   * 推进一拍。公开是为了让测试能手动驱动，不必等真实计时器。
   */
  tick(): PerceivedState {
    const now = this.#now()
    let elapsedMs = Math.max(0, now - this.#lastStepAt)
    this.#lastStepAt = now
    this.#lastSampleAt = now

    // ── ★ 事件驱动的休眠补偿 ──
    //
    // 轮询只管"多久看一眼"，管不了"这一眼与上一眼之间机器有没有睡着"。
    // 合盖 8 小时再打开时，`now - lastStepAt` 就是 8 小时，
    // 于是生理会按"用户连续工作了 8 小时"推进：精力归零、饥饿拉满，
    // 宠物一睁眼就是一副快饿死的委屈样。
    //
    // 这不只是观感问题——**它把一个不存在的"用户行为"编进了状态**，
    // 正好踩在 §1.2⑦「宠物不衡量用户」那条禁令上。
    //
    // 所以：超过阈值的时间跳变按**挂起**处理，生理不推进，
    // 只把关系按"想念"温和地结算一点（见下面的处理），
    // 并把这一拍的 elapsed 归零。
    // 阈值取 5 分钟：正常轮询是 2 秒，任何超过 5 分钟的间隔都只可能是
    // 挂起/休眠/时钟跳变，而不是"我们在专心工作"。
    if (elapsedMs > SUSPEND_GAP_MS) {
      this.#noteSuspend(elapsedMs)
      elapsedMs = 0
    }

    // ── 读三项信号 ──
    const processName = this.#platform.getForegroundProcessName()
    const idleMs = this.#platform.getIdleMilliseconds()
    const notificationState = this.#platform.queryUserNotificationState()

    // ── 先推断工作模式（它同时给出类别），再累积"连续同一类别"的时长 ──
    //
    // 顺序很重要：`sameCategoryMs` 是 `inferWorkMode` 的输入之一，
    // 而类别是它的输出。所以先用"上一拍的连续时长"推断，再更新累积值——
    // 反过来会用到未来信息（本拍的类别还没算出来）。
    const work = inferWorkMode({
      processName,
      idleMs,
      notificationState,
      now: new Date(now),
      sameCategoryMs: now - this.#sameCategorySince,
    })

    if (work.category !== this.#category) {
      this.#category = work.category
      this.#sameCategorySince = now
    }
    const sameCategoryMs = now - this.#sameCategorySince

    // ── 推进生理、关系与情绪（时间作为参数传入，因此可用假时钟测试）──
    this.#physiology = stepPhysiology(this.#physiology, elapsedMs, work.mode, this.#hadInteraction)
    // 关系与生理共用 `#hadInteraction` 这一个信号源。
    // 刻意让它们读**同一个**信号，而不是各自记一份：
    // 两份计数迟早会漂移，而"用户伸手了"这件事只发生一次。
    this.#relationship = stepRelationship(this.#relationship, elapsedMs, work.mode, {
      positiveInteraction: this.#hadInteraction,
    })
    this.#hadInteraction = false

    // 互动是一个**瞬时**情绪，优先于基础情绪，但只持续很短时间。
    // 这条不放进 physiology（那是慢变量），放在这里更清楚。
    const sinceInteraction = now - this.#emotion.since
    const interactionActive =
      this.#emotion.emotion === 'surprised' && sinceInteraction < INTERACTION_EMOTION_WINDOW_MS

    if (this.#forcedEmotion) {
      // 取证用：锁死情绪，且跳过限频（否则要等 3 秒才生效）
      this.#emotion = { emotion: this.#forcedEmotion, since: now }
    } else if (!interactionActive) {
      this.#emotion = stepEmotion(this.#emotion, this.#physiology, work.mode, now)
    }

    const state: PerceivedState = {
      processName,
      category: work.category,
      idleMs,
      notificationState,
      workMode: work.mode,
      workModeReason: work.reason,
      emotion: this.#emotion,
      physiology: this.#physiology,
      relationship: this.#relationship,
      mood: this.#forcedMood ?? relationshipMood(this.#relationship),
      misses: missesUser(this.#relationship),
      sameCategoryMs,
      sampledAt: now,
      uptimeMs: now - this.#startedAt,
      lastSuspendMs: this.#lastSuspendMs,
    }
    this.#snapshot = state
    this.#onState?.(state)
    return state
  }

  /**
   * 记一次瞬时情绪（例如"被拍了一下"）。
   *
   * 与 `noteInteraction` 分开：那个是"用户伸手了"（影响生理），
   * 这个是"当下该摆什么表情"（影响情绪）。
   *
   * ⚠️ 必须**同时更新缓存的快照**。初版只改了 `#emotion`，
   *    于是 `snapshot.emotion` 会停留在上一拍的值——对外可见的状态
   *    与内部状态不一致，直到下一次 tick 才对上。
   *    调试面板与渲染层读的都是 `snapshot`，所以这个不一致是**看得见**的。
   */
  flashEmotion(emotion: Emotion): void {
    const next: EmotionState = { emotion, since: this.#now() }
    this.#emotion = next
    if (this.#snapshot) {
      this.#snapshot = { ...this.#snapshot, emotion: next }
      this.#onState?.(this.#snapshot)
    }
  }

  /**
   * 强制把情绪锁成某个值（**仅供取证**）。
   *
   * 为什么需要它：真实情绪变化很慢（精力一小时才掉几个百分点），
   * 想核对"八种表情画出来分别长什么样"就得等半小时。
   * 这个开关让取证脚本能逐个截图比对。
   *
   * ⚠️ 生产路径不要用它。它是诊断工具，不是功能。
   */
  #forcedEmotion: Emotion | null = null

  forceEmotion(emotion: Emotion | null): void {
    this.#forcedEmotion = emotion
  }

  /**
   * 强制把关系基调锁成某个值（**仅供取证**）。
   *
   * 同样是为了取证：关系是**长期**变量，`reserved` 要相处好几天才到 `warm`，
   * 想核对"三种基调画出来有什么不同"不可能靠真实演进。
   *
   * ⚠️ 它只改**表现基调**，不改关系的三个百分比本身，
   *    也不改变"是否回应"——后者本来就不看关系（ADR-0003）。
   */
  #forcedMood: RelationshipMood | null = null

  forceMood(mood: RelationshipMood | null): void {
    this.#forcedMood = mood
  }

  /** 给调试面板用的可读摘要。**不含任何用户内容**（只有进程名与聚合量）。 */
  describe(): string[] {
    const s = this.#snapshot
    if (!s) return ['（还没有采样）']
    return [
      `前台进程：${s.processName ?? '（拿不到）'}  →  类别：${CATEGORY_LABELS[s.category]}`,
      `空闲时长：${s.idleMs === null ? '不可用' : `${String(Math.round(s.idleMs / 1000))}s`}`,
      `系统状态：QUNS=${String(s.notificationState)}`,
      `工作模式：${s.workMode}（${s.workModeReason}）`,
      `情绪：${s.emotion.emotion}`,
      `生理：精力 ${pct(s.physiology.energy)} / 饥饿 ${pct(s.physiology.hunger)} / 无聊 ${pct(
        s.physiology.boredom,
      )} / 社交 ${pct(s.physiology.social)}`,
      // 关系单独一行，并**同时打印基调与想念标记**：
      // 三个百分比本身看不出"所以它现在会怎么表现"，而那才是要看的东西。
      `关系：好感 ${pct(s.relationship.affection)} / 信任 ${pct(
        s.relationship.trust,
      )} / 默契 ${pct(s.relationship.rapport)}  →  强度 ${pct(
        relationshipStrength(s.relationship),
      )} 基调 ${s.mood}${s.misses ? '（想念）' : ''}`,
      `同类工具连续：${String(Math.round(s.sameCategoryMs / 1000))}s`,
      // 只在真的发生过休眠时才打这一行——它是异常事件，不是常态。
      ...(s.lastSuspendMs > 0
        ? [
            `休眠补偿：最近一次时间跳变 ${String(Math.round(s.lastSuspendMs / 60000))} 分钟（生理未推进）`,
          ]
        : []),
      `已运行：${String(Math.round(s.uptimeMs / 1000))}s`,
    ]
  }
}

function pct(value: number): string {
  return `${String(Math.round(value * 100))}%`
}

/**
 * 瞬时情绪（`surprised`，即"被拍了一下"）持续多久（毫秒）。
 * 略长于主进程那边的交互动画时长（0.95s），让表情先于动作结束。
 */
const INTERACTION_EMOTION_WINDOW_MS = 1200

/**
 * 超过这个间隔就认为机器休眠过，而不是"用户一直在工作"。
 *
 * 取 5 分钟：正常轮询是 2 秒，所以任何超过 5 分钟的间隔
 * 都只可能是挂起/休眠/时钟跳变。留这么宽的余量是为了容忍
 * 系统卡顿与定时器被节流，不至于把普通抖动误判成休眠。
 */
export const SUSPEND_GAP_MS = 5 * 60 * 1000

/**
 * 一次休眠最多按多久结算关系（12 小时）。
 *
 * ★ 这个上限是 ADR-0003 的守卫：**想念不能变成记账**。
 *   出差两周回来，关系该是"想你了"，而不是"你欠我两周"。
 *   封顶之后，离开 12 小时与离开 12 天的结算结果完全相同。
 */
export const SUSPEND_MISS_CAP_MS = 12 * 60 * 60 * 1000
