import { shouldPromoteToSemantic, type MemoryRecord } from './model'

/**
 * 情景记忆 → 语义记忆的升级（**纯函数，可单测**）。
 *
 * ── 规格要求 ──
 *
 * 施工令 §5 M3：「反复发生升级为语义记忆」。
 * 即"用户昨天加班""用户今天又加班""用户还在加班"这类**同类事件**反复出现时，
 * 应当凝聚成一条稳定事实「用户经常加班」，而不是永远躺着一堆零散事件。
 *
 * ── 为什么按**标签**聚类，而不是按文本相似度 ──
 *
 * 三个理由：
 *
 * ① **标签是写入方给的语义身份**。事件在写入时就知道自己属于哪个主题
 *    （`overtime` / `late_night` / `user_praised`），这是免费且准确的信号。
 *    而从自然语言里反推主题需要分词 + 聚类 + 阈值调参，记忆是千条级，
 *    投入产出比极差。
 *
 * ② **面向用户可解释**。记忆账本要能回答"你为什么记得这个"。
 *    "你最近 3 次都带着『加班』这个标签"是一个用户能看懂、能反驳的句子；
 *    "两条记忆的余弦相似度 0.83"不是。
 *
 * ③ **可测**。聚类结果不依赖任何浮点阈值，单测能断言精确的输入输出，
 *    不会因为换了模型或调了参数就 flaky。
 *
 * ── 为什么升级后**要删掉**被升级的情景记忆 ──
 *
 * 不删的话，"用户经常加班"这条语义事实 + 底下 N 条"今天加班"会**同时**
 * 被检索到并拼进 prompt，等于同一件事说了 N+1 遍。
 * 删掉不是丢失信息——语义记忆里的 `derivedFrom` 记着来源，
 * 而"稳定事实"本来就比"某天的流水账"更有用。
 *
 * ⚠️ 删掉之后**事件总数会减少**，所以判据不能是"当前存量"。
 *    判据用 `occurrences`（这个主题**历来**出现过几次），
 *    由调用方跨轮次累计（存在工作记忆里）。否则升级一次之后
 *    计数归零，要再攒 3 次才升级第二次，节奏就错了。
 */

/** 一个"主题"的聚类结果。 */
export interface PromotionSource {
  /**
   * 主题标签（**排序后**用 `,` 连接）。
   * 空标签的事件不参与升级——没有主题就无从"反复发生"。
   */
  readonly topicKey: string
  /** 该主题下的情景记忆，最近的在前。 */
  readonly records: readonly MemoryRecord[]
  /**
   * 该主题**历来**出现过几次（可以大于 `records.length`，
   * 因为已被升级删掉的那些不再在库里）。
   */
  readonly occurrences: number
}

/** 一条待写入的语义记忆。 */
export interface PromotionPlan {
  readonly topicKey: string
  /** 主题标签。 */
  readonly tags: readonly string[]
  /** 自然语言事实，直接进 `addSemantic({ content })`。 */
  readonly content: string
  /** 来源情景记忆 id（取最近的一条），用于回答"为什么它记得"。 */
  readonly derivedFrom: number
  /** 被这次升级吸收掉的情景记忆 id。写入成功后应物理删除。 */
  readonly consumedIds: readonly number[]
}

/** 给标签组算一个稳定的主题键。 */
export function topicKeyOf(tags: readonly string[]): string {
  return [...tags]
    .filter((tag) => tag.length > 0)
    .sort()
    .join(',')
}

/**
 * 把一批情景记忆按主题聚类，算出每个主题的出现次数。
 *
 * @param episodic 情景记忆（顺序无关）
 * @param occurrenceCounts 主题键 → **历来**出现次数（跨轮次累计的计数）
 */
export function groupByTopic(
  episodic: readonly MemoryRecord[],
  occurrenceCounts: ReadonlyMap<string, number> = new Map(),
): PromotionSource[] {
  const groups = new Map<string, MemoryRecord[]>()

  for (const record of episodic) {
    if (record.kind !== 'episodic') continue
    const key = topicKeyOf(record.tags)
    // 没有主题标签的事件不参与"反复发生"的判定。
    if (key.length === 0) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(record)
    else groups.set(key, [record])
  }

  return [...groups.entries()].map(([topicKey, records]) => {
    // 最近的在前，便于取 derivedFrom 与生成描述。
    const sorted = [...records].sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id)
    // ★ 计数取"库里的条数"与"累计计数"的**较大值**。
    //   只取库里的条数会在升级删源之后归零，导致第二次升级要重新攒 3 次；
    //   只取累计计数则在计数丢失时（换机器、清库）永远升不了级。
    //   取较大值对两种情形都成立。
    const occurrences = Math.max(sorted.length, occurrenceCounts.get(topicKey) ?? 0)
    return { topicKey, records: sorted, occurrences }
  })
}

/**
 * 由主题标签生成一句人话事实。
 *
 * 刻意**不用** LLM：这句话会长期躺在记忆账本里，用户要能看懂、
 * 也要能在断网时照常工作。模板化的句子朴素但诚实。
 *
 * 取**最近一条**的原文做引子，让事实带着具体来由，
 * 而不是一句空洞的"用户经常加班"。
 */
export function describeTopic(source: PromotionSource): string {
  const labels = source.topicKey.split(',').filter((tag) => tag.length > 0)
  const label = labels.join('、')
  const latest = source.records[0]
  return latest
    ? `用户反复出现「${label}」这类情况（已第 ${String(source.occurrences)} 次），最近一次：${latest.content}`
    : `用户反复出现「${label}」这类情况（已第 ${String(source.occurrences)} 次）`
}

/** `planPromotions` 的输入。 */
export interface PlanPromotionsInput {
  /** 候选情景记忆（通常全部或近期的情景记忆）。 */
  readonly episodic: readonly MemoryRecord[]
  /** 已有的语义记忆，用来避免同一主题重复升级。 */
  readonly semantic?: readonly MemoryRecord[]
  /** 主题键 → 历来出现次数。跨轮次累计，见 `groupByTopic`。 */
  readonly occurrenceCounts?: ReadonlyMap<string, number>
  /**
   * 每个主题**每次升级**吸收掉的情景记忆条数下限。
   * 默认 2：只有 1 条新证据时升级没有意义（那条自己就该被检索到）。
   */
  readonly minConsumed?: number
}

/**
 * 决定这一轮要把哪些主题升级为语义记忆。
 *
 * 三条拒绝理由，缺一不可：
 * ① 出现次数不到阈值（`shouldPromoteToSemantic`）；
 * ② 该主题已有语义记忆（避免"用户经常加班"攒出好几条）；
 * ③ 本次能吸收的情景记忆少于 `minConsumed`（没有新证据就别动）。
 */
export function planPromotions(input: PlanPromotionsInput): PromotionPlan[] {
  const { episodic, semantic = [], occurrenceCounts, minConsumed = 2 } = input

  const coveredTopics = new Set(
    semantic
      .filter((record) => record.kind === 'semantic')
      .map((record) => topicKeyOf(record.tags)),
  )

  const plans: PromotionPlan[] = []
  for (const source of groupByTopic(episodic, occurrenceCounts)) {
    if (!shouldPromoteToSemantic(source)) continue
    if (coveredTopics.has(source.topicKey)) continue
    if (source.records.length < minConsumed) continue

    const latest = source.records[0]
    if (!latest) continue

    plans.push({
      topicKey: source.topicKey,
      tags: source.topicKey.split(',').filter((tag) => tag.length > 0),
      content: describeTopic(source),
      derivedFrom: latest.id,
      consumedIds: source.records.map((record) => record.id),
    })
  }

  // 出现次数多的先升级：主题更牢固，也让结果与输入顺序无关（可测）。
  return plans.sort(
    (a, b) => b.consumedIds.length - a.consumedIds.length || a.topicKey.localeCompare(b.topicKey),
  )
}
