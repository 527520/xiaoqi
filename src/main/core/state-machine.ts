/**
 * 状态机 —— 施工令 §5 M2 里叫这个名字的那一块。
 *
 * ── 为什么它是一个门面（barrel），而不是一个大文件 ──
 *
 * 规格原文是「`core/state-machine.ts`：生理（精力/饥饿/无聊）、情绪（§4.6 的 8 个）、
 * 关系（好感/信任/默契）、工作模式（8 个）」。它规定的是**这一层要有什么**，
 * 而实现上把它们挤进一个文件会带来两个具体的坏处：
 *
 * ① **判定逻辑各自有独立的输入，挤在一起就无法单独测**。
 *    现在四块都是纯函数、各自有完整的单测（生理 21 项、关系 27 项、
 *    工作模式 30 项、情绪限频在生理里），共 78 项。合成一个文件之后，
 *    "关系层的回落速率"这类断言会被埋在一堆无关代码中间，
 *    而它们恰恰是本项目**最需要被钉死**的部分（ADR-0003 的数值守卫）。
 * ② **`perception.ts` 是"串起来"的那一层，本来就不属于状态机**。
 *    它负责轮询节流与跨轮次累积，是唯一需要碰时钟与平台的模块。
 *    把纯判定与它混在一起，`boundary.test.ts` 那条
 *    "core/ 不依赖 Electron"的守卫会立刻变得难以维持。
 *
 * 所以这里保留 `state-machine` 这个名字作为**对外入口**：
 * 外部（以及将来读代码的人）按规格里的名字找到它，从而实现仍在各自文件里，
 * 每个文件只讲一件事。
 *
 * ── 四块状态的关系 ──
 *
 * | 层 | 变化速度 | 由什么驱动 |
 * |---|---|---|
 * | 工作模式 | 分钟级 | 三项感知信号（前台进程 / 空闲 / 系统状态） |
 * | 生理     | 小时级 | 时间流逝 + 工作模式 |
 * | 关系     | **天到月级** | 累积的正向互动 + 时间流逝 |
 * | 情绪     | 秒级   | 生理 + 工作模式，由事件瞬时触发 |
 *
 * 这个"速度阶梯"是刻意的，也是为什么它们必须是分开的量：
 * 如果情绪和关系用同一套时间常数，宠物要么显得没性格（什么都慢），
 * 要么显得神经质（什么都快）。
 *
 * ⚠️ 关系层有一条**不可动摇**的约束（ADR-0003）：
 *    它只改变**怎么表现**，永不改变"是否回应"。
 *    见 `relationship.ts` 文件头，以及 `relationshipMood()` 的类型守卫。
 */

export {
  INITIAL_PHYSIOLOGY,
  baseEmotion,
  EMOTION_MIN_INTERVAL_MS,
  INTERACTION_EMOTION,
  INTERACTION_EMOTION_MS,
  stepEmotion,
  stepPhysiology,
  type EmotionState,
  type Physiology,
} from './physiology'

export {
  AFFECTION_DECAY_PER_HOUR,
  ATTACHED_THRESHOLD,
  INITIAL_RELATIONSHIP,
  INTERACTION_AFFECTION_GAIN,
  INTERACTION_TRUST_GAIN,
  RAPPORT_PER_HOUR,
  TRUST_DECAY_PER_HOUR,
  WARM_THRESHOLD,
  missesUser,
  relationshipMood,
  relationshipStrength,
  stepRelationship,
  type Relationship,
  type RelationshipEvents,
} from './relationship'

export {
  FOCUS_MS,
  IDLE_REST_MS,
  OVERTIME_FROM_HOUR,
  WORK_END_HOUR,
  WORK_START_HOUR,
  inferWorkMode,
  isWeekend,
  isWithinWorkHours,
  type WorkModeInput,
  type WorkModeResult,
} from './workMode'

/** 关系基调的类型本身定义在 `shared/types.ts`（渲染层也要用）。 */
export type { RelationshipMood } from '@shared/types'
