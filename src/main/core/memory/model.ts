import type { Emotion } from '@shared/types'

/**
 * 记忆 —— 契约、遗忘曲线与分级规则（**纯函数，可单测**）。
 *
 * ── 四层记忆（CONTEXT.md + 施工令 §5 M3）──
 *
 * | 层 | 语义 | 衰减 |
 * |---|---|---|
 * | 情景记忆 | "今天发生了什么"，带时间戳的事件 | 按遗忘曲线衰减 |
 * | 语义记忆 | 关于用户的稳定事实，由反复出现的情景升级而来 | 不衰减 |
 * | 情感记忆 | 带情绪标签的事件 | **衰减最慢** |
 * | 工作记忆 | 当前会话的短期上下文 | 退出即清 |
 *
 * ── 两条不可动摇的约束 ──
 *
 * ① **删除必须真的删除**（施工令 §1.2⑪）。不得在日志或缓存中留痕。
 *    所以这里的删除策略是**物理删除**，并且有测试断言"删完之后
 *    用原文再查也查不到"。
 *
 * ② **"被冷落"只存在于情感记忆层，且不可累积成怨气**（ADR-0003）。
 *    因此情感记忆的强度是**单次事件**的强度，任何跨事件累加都必须被拒绝。
 */

/** 记忆层级。 */
export type MemoryKind = 'episodic' | 'semantic' | 'emotional' | 'working'

/** 一条记忆的存储形态（与 SQLite 行一一对应）。 */
export interface MemoryRecord {
  readonly id: number
  readonly kind: MemoryKind
  /** 事件发生时刻（Unix 毫秒）。 */
  readonly occurredAt: number
  /** 自然语言描述。检索与拼 prompt 都用它。 */
  readonly content: string
  /** 逗号分隔的标签。**与工作模式标签对齐**，用于"模式 × 记忆"匹配。 */
  readonly tags: readonly string[]
  /**
   * 权重 ∈ [0,1]。遗忘曲线作用在它上面。
   * 语义记忆恒为 1（不衰减）。
   */
  readonly weight: number
  /** 仅情感记忆有：情绪标签。 */
  readonly emotion?: Emotion
  /** 仅情感记忆有：该次事件的强度 ∈ [0,1]。**不做跨事件累加。** */
  readonly intensity?: number
  /** 仅语义记忆有：来源情景记忆的 id（可空 = 用户手动添加）。 */
  readonly derivedFrom?: number
}

/** 新的情景记忆（插入前的形态，id 由数据库给）。 */
export interface NewEpisodicMemory {
  readonly occurredAt: number
  readonly content: string
  readonly tags: readonly string[]
}

/** 新的情感记忆。 */
export interface NewEmotionalMemory {
  readonly occurredAt: number
  readonly content: string
  readonly tags: readonly string[]
  readonly emotion: Emotion
  /** 单次强度。**不是累积值**——见文件头约束 ②。 */
  readonly intensity: number
}

/** 新的语义记忆。 */
export interface NewSemanticMemory {
  readonly content: string
  readonly tags: readonly string[]
  /** 来源情景记忆 id；用户手动添加时为 undefined。 */
  readonly derivedFrom?: number
}

// ────────────────────────────────────────────────────────────────────────────
// 遗忘曲线
// ────────────────────────────────────────────────────────────────────────────

/** 一天。遗忘曲线的所有常数都以它为单位。 */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 情景记忆的半衰期（天）。
 *
 * 施工令 §5 M3 的原话是「小事 24h 降权」。这里取"24 小时权重减半"，
 * 即半衰期 1 天——它读起来直接对应规格里的"24h 降权"。
 */
export const EPISODIC_HALFLIFE_DAYS = 1

/**
 * 情感记忆的半衰期（天）。
 *
 * **比情景记忆长得多**，因为规格明确说情感记忆"衰减最慢"。
 * 取 30 天：一个月前的"今天被夸了"仍有近一半权重，
 * 而一个月前的"今天开了个会"几乎归零。
 */
export const EMOTIONAL_HALFLIFE_DAYS = 30

/**
 * 低于这个权重就认为是"忘了"，可以从库里清掉。
 *
 * 不是 0：浮点指数衰减永远到不了 0，用一个小阈值来定义"忘了"。
 */
export const FORGET_THRESHOLD = 0.02

/**
 * 权重衰减（指数半衰期）。
 *
 * @param initialWeight 初始权重 ∈ [0,1]
 * @param elapsedMs 距事件发生过了多久
 * @param halflifeDays 半衰期（天）
 */
export function decayWeight(
  initialWeight: number,
  elapsedMs: number,
  halflifeDays: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return initialWeight
  if (halflifeDays <= 0) return 0
  const halflives = elapsedMs / (halflifeDays * DAY_MS)
  return initialWeight * Math.pow(0.5, halflives)
}

/** 当前权重（情景记忆）。 */
export function episodicWeightAt(initialWeight: number, elapsedMs: number): number {
  return decayWeight(initialWeight, elapsedMs, EPISODIC_HALFLIFE_DAYS)
}

/**
 * 当前权重（情感记忆）。
 *
 * ⚠️ `intensity` 是**单次事件**的强度。**不要**把同一情绪的多次事件强度相加
 *    再传进来——那正是 ADR-0003 禁止的"累积成怨气"。
 *    如果需要对同一情绪取代表值，用 `max` 或最近的单次值，不要用 sum。
 */
export function emotionalWeightAt(intensity: number, elapsedMs: number): number {
  return decayWeight(intensity, elapsedMs, EMOTIONAL_HALFLIFE_DAYS)
}

/** 一条记忆在当前时刻的权重。语义记忆不衰减。 */
export function currentWeight(record: MemoryRecord, now: number): number {
  if (record.kind === 'semantic') return 1
  if (record.kind === 'working') return 1
  const elapsed = now - record.occurredAt
  if (record.kind === 'emotional') {
    return emotionalWeightAt(record.intensity ?? record.weight, elapsed)
  }
  return episodicWeightAt(record.weight, elapsed)
}

/** 这条记忆是否已经被遗忘（可以从库里清掉）。 */
export function isForgotten(record: MemoryRecord, now: number): boolean {
  if (record.kind === 'semantic' || record.kind === 'working') return false
  return currentWeight(record, now) < FORGET_THRESHOLD
}

// ────────────────────────────────────────────────────────────────────────────
// 升级为语义记忆
// ────────────────────────────────────────────────────────────────────────────

/**
 * 同类事件重复多少次算"稳定事实"。
 *
 * 施工令 §5 M3：「反复发生升级为语义记忆」。
 * 取 3：两次可能是巧合，三次才像习惯。
 */
export const SEMANTIC_PROMOTION_THRESHOLD = 3

/** 升级判定的输入：一组**同类**情景记忆。 */
export interface PromotionCandidate {
  readonly records: readonly MemoryRecord[]
  /** 这一类共出现过几次（可以大于 records.length，若部分已衰减掉）。 */
  readonly occurrences: number
}

/**
 * 是否应该把一组同类情景记忆升级为语义记忆。
 *
 * 判据刻意简单：**同类事件出现够多次**。
 * 不做词频、不做聚类——记忆规模是千条级，简单规则更可解释，
 * 而"可解释"是这个产品对用户的承诺（记忆账本能显示它记住了什么）。
 */
export function shouldPromoteToSemantic(candidate: PromotionCandidate): boolean {
  return candidate.occurrences >= SEMANTIC_PROMOTION_THRESHOLD
}

/**
 * 强情绪事件的保留规则。
 *
 * 施工令 §5 M3：「强情绪事件长期保留」。
 * 阈值取 0.7：中等强度的情绪仍会随情感记忆的半衰期淡去，
 * 只有真正强烈的（被夸得特别开心、特别委屈）才豁免遗忘。
 */
export const STRONG_EMOTION_INTENSITY = 0.7

/**
 * 这条情感记忆是否因"情绪足够强"而豁免遗忘。
 *
 * ⚠️ 豁免的依据是**强度**，不是**次数**。
 *    按次数豁免会变成"同一件小事攒够多次就不忘了"——
 *    那正是 ADR-0003 要避免的累积。
 */
export function survivesByIntensity(record: MemoryRecord): boolean {
  return record.kind === 'emotional' && (record.intensity ?? 0) >= STRONG_EMOTION_INTENSITY
}

/** 应该被清理的记忆（已遗忘且不因强情绪豁免）。 */
export function shouldForget(record: MemoryRecord, now: number): boolean {
  if (survivesByIntensity(record)) return false
  return isForgotten(record, now)
}

// ────────────────────────────────────────────────────────────────────────────
// 违规检查
// ────────────────────────────────────────────────────────────────────────────

/**
 * 情感强度是否合法。
 *
 * 单独一个函数、单独一组测试，因为它是 ADR-0003 在代码层面的守卫：
 * 强度必须是**单次事件**的 [0,1] 值。任何"累积"都会表现为越界
 * （例如两次 0.6 相加得 1.2），因此这一条检查能实际拦住累积式实现。
 */
export function isValidIntensity(intensity: number): boolean {
  return Number.isFinite(intensity) && intensity >= 0 && intensity <= 1
}
