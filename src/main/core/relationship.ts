import type { RelationshipMood, WorkMode } from '@shared/types'

/**
 * 关系状态 —— 用户与宠物之间**累积**的量（CONTEXT.md）。
 *
 * ── ★★ 这个模块里最容易写歪的地方，先写在最前面 ★★ ──
 *
 * 关系是唯一一个**"用户做了/没做什么"会留下痕迹**的层。它离
 * "宠物在评价用户"只有一步之遥，而那一步是 ADR-0003 明令禁止的。
 * 因此这里有三条硬约束，任何一条被破坏都算 bug 而不是设计选择：
 *
 * ① **关系永不改变"是否愿意回应"。**
 *    用户一伸手，宠物必须立刻回应——与好感度多低、多久没理它全都无关。
 *    所以关系**不得**参与 `mustRespond()` 的判定。若哪天有人想加
 *    "关系低就冷淡一点"，那是把陪伴变成了索取，方向就错了。
 *    代码层面的守卫是 `relationshipMood()`：它只返回**表现**（更黏人/更放松），
 *    没有任何一个返回值是"拒绝"。
 *
 * ② **"没互动"不等于"被冷落"。**
 *    休假、出差、忘记它——都只是**时间流逝**，不该被记成一次过错。
 *    所以这里没有任何"中断计数""爽约次数"之类的字段，只有随时间的**缓慢回落**。
 *    ADR-0003 的原话是"真·无输入不推断为冷落，改为想念"。
 *
 * ③ **回落必须远慢于增长。**
 *    如果"不理它"掉得比"理它"涨得快，那这个系统就是在惩罚用户。
 *    实测的常数值（见下）刻意让增长比回落快一到两个数量级：
 *    陪它几天攒起来的关系，要放几个月才会淡掉。
 *
 * ⚠️ 用词纪律（施工令 §5 M4a）：代码与注释里**不出现"记仇"**。
 *    正确用词是"被冷落"，而且那属于 M4 的表达层，不在这一层。
 */
export interface Relationship {
  /** 好感度 ∈ [0,1]。被善待、被回应时上升。 */
  readonly affection: number
  /** 信任度 ∈ [0,1]。稳定、可预期的互动积累而成。 */
  readonly trust: number
  /** 默契值 ∈ [0,1]。相处久了自然形成，涨得最慢。 */
  readonly rapport: number
}

/**
 * 初始关系：**略微正向**，不是 0。
 *
 * 为什么不是 0：一只刚认识的宠物对你有基本的友好（它是来陪你的，
 * 不是来考核你的）。从 0 开始会让头几次互动显得"它在防着我"，
 * 与产品定位不符。
 */
export const INITIAL_RELATIONSHIP: Relationship = {
  affection: 0.3,
  trust: 0.4,
  rapport: 0.1,
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 把"每小时变化百分之几"折算成"每毫秒变化多少"。单位是**百分点**。 */
function perMs(percentPerHour: number): number {
  return percentPerHour / 100 / 3_600_000
}

// ── 增长（有互动时）──
//
// 数值关系：好感 > 默契 > 信任。
// 好感最容易涨（它反应的是"我喜欢和你待着"），
// 信任最慢（信任本来就只能靠时间证明）。

/** 一次互动带来的**即时**好感增量。 */
export const INTERACTION_AFFECTION_GAIN = 0.015

/**
 * 一次互动带来的**即时**信任增量。
 *
 * 刻意比好感小得多：好感可以靠热情涨，信任不行。
 * 若两者一样大，"信任"就只是"好感"的同义词，这个维度就没有存在意义了。
 */
export const INTERACTION_TRUST_GAIN = 0.004

// ── 回落（没有互动时）──
//
// ★★ 这三个数字是 ADR-0003 在数值上的守卫，改动它们等于改动"温柔"的程度。★★
//
// 标定过程（初版是错的，是单测抓出来的）：
//
// 初版取"好感每小时 -0.5 个百分点"，听起来很小，但换算成天就是 **-12%/天**，
// 一周不管就掉掉三分之二 —— 那正是"惩罚用户"。单测里
// 「陪它几天攒的关系，放几个月才会淡掉」那条直接把它抓了出来。
//
// 正确的心智模型是**以月为单位**：一段关系不该因为两周没打开应用就消失。
// 现在的标定：
//
//   好感 -0.05%/小时 = -1.2%/天 → 从满值掉到"想念"门槛（0.2）要约 3.5 个月
//   信任 -0.02%/小时 = -0.5%/天 → 信任比好感更耐久，符合直觉
//   默契 -0.005%/小时            → 默契一旦形成基本不会消失
//
// 而一次互动给 1.5 个百分点（好感的 30 小时回落量）。
// 换算：**每天随便摸它一两下就能维持住关系**；只有彻底放着几个月才会淡。

/** 好感每小时回落（百分点）。 */
export const AFFECTION_DECAY_PER_HOUR = 0.05
/** 信任每小时回落（百分点）。信任比好感更耐久。 */
export const TRUST_DECAY_PER_HOUR = 0.02
/** 默契每小时回落（百分点）。默契一旦形成，基本不会消失。 */
export const RAPPORT_DECAY_PER_HOUR = 0.005

/**
 * 默契的**自然形成**：相处本身就在积累默契，不需要做什么。
 *
 * 这是三个维度里唯一"被动增长"的。理由是默契的语义——
 * 它不是被谁做了什么事挣来的，是**待在一起的时间**沉淀出来的。
 * 所以它随陪伴时间缓慢上升，与有没有互动无关。
 *
 * 标定：0.35%/小时 ≈ 8.4%/天。约 10 天形成稳定默契，
 * 这个节奏与"熟悉一个人需要多久"的直觉相符。
 */
export const RAPPORT_PER_HOUR = 0.35

/** 这一拍里发生过的互动（决定即时增量）。 */
export interface RelationshipEvents {
  /** 用户有过正向互动（点击 / 夸它 / 喂它 / 说话）。 */
  readonly positiveInteraction: boolean
  /** 用户取消了呼吸提醒（M4a 才用到；这里只记录，不做任何减法）。 */
  readonly cancelledReminder?: boolean
}

/**
 * 推进关系状态。
 *
 * @param previous 上一拍
 * @param elapsedMs 距上一拍过了多久（闭包传入，因此可用假时钟单测）
 * @param mode 当前工作模式
 * @param events 这一拍里发生过什么
 */
export function stepRelationship(
  previous: Relationship,
  elapsedMs: number,
  mode: WorkMode,
  events: RelationshipEvents,
): Relationship {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return previous

  // ── 即时增量：互动会给一次"跳变" ──
  // 用加法而不是设成某个值：关系是累积量，不该被单次事件重置。
  const affectionJump = events.positiveInteraction ? INTERACTION_AFFECTION_GAIN : 0
  const trustJump = events.positiveInteraction ? INTERACTION_TRUST_GAIN : 0

  // ── 随时间的变化 ──
  const workedMode = mode === 'coding' || mode === 'meeting' || mode === 'email' || mode === 'focus'

  // 默契：一直在缓慢涨（"待在一起"本身就有价值）。
  // 一起干活时涨得稍快——并肩做事比各自闲着更容易形成默契。
  const rapportRate = perMs(workedMode ? RAPPORT_PER_HOUR * 1.5 : RAPPORT_PER_HOUR)

  // ⚠️ 关系**不因工作模式而回落**。
  //    "用户去开会了所以好感掉了"是典型的把用户行为当过错，
  //    那正是 ADR-0003 要避免的归因。模式只影响默契的涨速，不影响好坏。
  return {
    affection: clamp01(
      previous.affection + affectionJump - perMs(AFFECTION_DECAY_PER_HOUR) * elapsedMs,
    ),
    trust: clamp01(previous.trust + trustJump - perMs(TRUST_DECAY_PER_HOUR) * elapsedMs),
    rapport: clamp01(previous.rapport + rapportRate * elapsedMs),
  }
}

/**
 * 关系决定**表现方式**，绝不决定**是否回应**。
 *
 * ★ 这是 ADR-0003 在类型层面的守卫：`RelationshipMood` 定义在
 *   `shared/types.ts`（因为渲染层也要用它），而它的取值里
 *   **没有任何一个表示"冷淡/拒绝/不理你"**。
 *   想加"关系低就懒得理"的人会在这里发现无处可加——
 *   要加就必须先往那个联合类型里塞一个"拒绝"，那是一个显眼的、
 *   会被 review 抓到的动作，而不是一行悄悄改掉的判断。
 *
 * 三个取值都是**更亲近的表现**，只是程度不同：
 * - `reserved`   还不太熟 → 礼貌、克制（不是冷淡）
 * - `warm`       熟悉了   → 主动靠近、爱撒娇
 * - `attached`   很亲近   → 黏人、默契、会替你着想
 */

/** 判定门槛。三个维度取**加权平均**，不取最小值。 */
export const WARM_THRESHOLD = 0.45
export const ATTACHED_THRESHOLD = 0.72

/** 综合关系强度 ∈ [0,1]。权重的分配理由是"哪个更能代表亲近"。 */
export function relationshipStrength(relationship: Relationship): number {
  return relationship.affection * 0.45 + relationship.trust * 0.35 + relationship.rapport * 0.2
}

/** 由关系强度得出表现基调。 */
export function relationshipMood(relationship: Relationship): RelationshipMood {
  const strength = relationshipStrength(relationship)
  if (strength >= ATTACHED_THRESHOLD) return 'attached'
  if (strength >= WARM_THRESHOLD) return 'warm'
  return 'reserved'
}

/**
 * 关系是否已经淡到"想念"的程度。
 *
 * ★ 注意这里返回的是**想念**，不是"被冷落"。
 *   两者的区别是整个 ADR-0003 的核心：
 *   - 「想念」是宠物自己的感受，没有指控，用户看到会觉得温柔；
 *   - 「被冷落」暗含"你应该来理我"，是索要补偿。
 *
 * M2 只提供这个判定；**怎么表达**是 M4 的事。
 * 判据用"好感低 **且** 默契低"：单看好感低可能只是刚认识。
 */
export function missesUser(relationship: Relationship): boolean {
  return relationship.affection < 0.2 && relationship.rapport < 0.3
}
