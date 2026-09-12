import type { MemoryRecord } from './model'

/**
 * 事实巩固 —— **纯函数，可单测**。
 *
 * ── 它解决什么问题 ──
 *
 * 原来的升级逻辑只有一条规则：同类标签攒够 3 次 → 写一条语义记忆；
 * **已有同主题就什么都不做**。于是三件事表达不了：
 *
 * ① **新事实推翻旧事实**（"用户喝咖啡" → 后来"用户戒咖啡了"）；
 * ② **内容几乎相同的两条语义记忆**该合并，而不是各占一行；
 * ③ **"从未有过"与"已有且一致"** 都退化成 no-op，无法区分——
 *    而这两者的正确反应完全不同：前者要写入，后者该**加强**（reinforce）。
 *
 * 这一层参考 mem0 的做法：把"要不要动既有记忆"拆成一次显式决策，
 * 而不是散在写入路径里的 if。区别在于**判据完全不用模型**，见下。
 *
 * ── 为什么判据是符号规则而不是 LLM ──
 *
 * 巩固是**写记忆的必经之路**，它必须在断网、没有 API key 时也能工作
 * （施工令 §4.7：不填 key 时应用必须完全可用）。而它的输入是
 * 我们自己生成的短句、标签也是我们自己给的，所以规则足够；
 * 更重要的是规则**能被穷举单测**，而模型调用不能。
 * 等 LLM 抽取层接上（需要密钥）时，让它产出候选事实，
 * 巩固仍然走这里——决策逻辑保持可测、可回放。
 */

/** 巩固决策。四选一，覆盖"该写入/该加强/该取代/该丢弃"四种结局。 */
export type ConsolidationAction =
  /** 没有任何相关既有记忆 → 写入新条 */
  | 'new'
  /** 已有相关且不矛盾 → **加强**既有那条，不新增 */
  | 'reinforce'
  /** 已有相关且**矛盾** → 写入新条，并把旧的标记为被取代 */
  | 'supersede'
  /** 与既有几乎完全重复、无新信息 → 什么都不做 */
  | 'discard'

/** 一条候选事实。 */
export interface FactCandidate {
  readonly content: string
  readonly tags: readonly string[]
}

export interface ConsolidationInput {
  readonly candidate: FactCandidate
  /** 可能相关的既有语义记忆（调用方按标签/子串先筛过一轮）。 */
  readonly existing: readonly MemoryRecord[]
  /**
   * 判定"内容高度重复"的相似度门槛 ∈ [0,1]。
   *
   * 默认 0.9 而不是 1.0：我们自己的句子是模板生成的，同一件事换个说法
   * 会差几个字（"用户经常加班" vs "用户常常加班"），
   * 要求完全相等会让重复条目悄悄堆积。
   */
  readonly duplicateThreshold?: number
}

export interface ConsolidationPlan {
  readonly action: ConsolidationAction
  /** 要写入的内容（`new` / `supersede` 时有值）。 */
  readonly content?: string
  readonly tags?: readonly string[]
  /** `reinforce` / `supersede` 时指向被作用的既有记忆。 */
  readonly targetId?: number
}

/**
 * 否定词表。
 *
 * ⚠️ 这是**唯一**用来判矛盾的手段，刻意做得很窄：只认显式的否定，
 *    不做语义推理。宁可漏判（多写一条），也不要误判
 *    （把"用户喜欢咖啡"和"用户喜欢茶"当成矛盾，于是互相取代，
 *    最后只留下一条，用户会觉得"它怎么忘了我还喜欢茶"）。
 */
const NEGATION_MARKERS = ['不', '没', '别', '勿', '停止', '戒', '拒绝'] as const

/** 把内容切成可比较的词元：去空白、去标点、统一小写。 */
export function normalizeContent(text: string): string {
  return text.toLowerCase().replace(/[\s，。、,.!！?？：:；;「」『』""''（）()\-—]/g, '')
}

/**
 * 两条内容是否**矛盾**。
 *
 * 判据（全部是符号规则，可穷举单测）：
 * ① 去掉标点空白后，**一条是否定式而另一条不是**；
 * ② 且两者的**肯定部分**足够相似（否则只是两件不同的事）。
 *
 * 例：
 *  - "用户喝咖啡" / "用户不喝咖啡" → 第一次相似、第二条有否定 → 矛盾 ✅
 *  - "用户喜欢咖啡" / "用户喜欢茶" → 相似度低 → 不算矛盾 ✅（重要）
 */
export function contradicts(a: string, b: string): boolean {
  const na = normalizeContent(a)
  const nb = normalizeContent(b)

  const aNeg = NEGATION_MARKERS.some((m) => na.includes(m))
  const bNeg = NEGATION_MARKERS.some((m) => nb.includes(m))
  // ① 必须恰好一条是否定式
  if (aNeg === bNeg) return false

  // ② 剥掉否定词再看相似度：否定式的核心命题应当与肯定式相似
  const strip = (text: string): string => {
    let out = text
    for (const m of NEGATION_MARKERS) out = out.split(m).join('')
    return out
  }
  const coreA = aNeg ? strip(na) : na
  const coreB = bNeg ? strip(nb) : nb
  /**
   * 门槛 0.65 是**实测调出来的**（见 `similarity()` 注释里的对照表）：
   *
   * | 对比 | LCS 相似度 | 该判矛盾吗 |
   * |---|---|---|
   * | 用户喝咖啡 / 用户不喝咖啡 | 0.833 | ✅ 是 |
   * | 用户经常加班 / 用户常常加班 | 0.833 | ❌ 不是（但两者都肯定，第①条已排除） |
   * | 用户喜欢咖啡 / 用户喜欢茶 | 0.667 | ❌ **不是**（这是误判代价最大的场景） |
   * | 用户喝咖啡 / 用户不喜欢开会 | 0.286 | ❌ 不是 |
   *
   * 门槛必须**高于 0.667**才能保住"喜欢咖啡/喜欢茶"这一类，
   * 又要**低于 0.833**才能认出真正的否定。0.65 落在这中间……
   * 但 0.667 > 0.65，所以 0.7 才是安全值。取 0.7。
   */
  return similarity(coreA, coreB) >= 0.7
}

/**
 * 两条内容的相似度 ∈ [0,1]。
 *
 * ── 为什么是 LCS 而不是 Dice（2 字滑窗）──
 *
 * 第一版用 Dice 系数，实测在本项目的句子上**不具区分度**：
 *
 * | 对比 | 2 字滑窗 | LCS |
 * |---|---|---|
 * | 用户经常加班 / 用户常常加班（换个说法） | 0.600 | 0.833 |
 * | 用户喜欢咖啡 / 用户喜欢茶（**不同的事**） | 0.667 | 0.667 |
 * | 用户喝咖啡 / 用户不喝咖啡（矛盾） | 0.667 | 0.833 |
 *
 * 问题在于滑窗**按位置对齐**：中文短句里改一两个字会让所有后续
 * 位置的滑窗全部错位，于是"换个说法"与"换件事"得分几乎一样。
 * 而 LCS 看的是"公共子序列有多长"，不受位置错位影响，
 * 于是换说法（保留大部分字序）得分明显高于换件事。
 *
 * 这是**实测调出来的**，不是拍脑袋：判据必须能把"同一件事的两种说法"
 * 与"两件不同的事"分开，否则巩固逻辑要么漏合并、要么误合并。
 *
 * 单字串退化成"字是否相同"；任一为空时，只有**都为空**才算相同
 * （否则空内容会被反复写入）。
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const lcs = longestCommonSubsequenceLength(a, b)
  // 用较长者的长度做分母：于是"短句是长句的一部分"得分高，
  // 而"两句各说各的"得分低。
  return lcs / Math.max(a.length, b.length)
}

/** 最长公共子序列的长度（经典 DP；句子很短，O(n·m) 足够）。 */
function longestCommonSubsequenceLength(a: string, b: string): number {
  // 滚动数组：只留上一行，内存 O(min(n,m))
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  let previous = new Uint32Array(short.length + 1)
  let current = new Uint32Array(short.length + 1)

  for (let i = 1; i <= long.length; i++) {
    for (let j = 1; j <= short.length; j++) {
      current[j] =
        long[i - 1] === short[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0)
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return previous[short.length] ?? 0
}

/** 两个标签集合是否指向同一主题（排序后相等，忽略空标签）。 */
export function sameTopic(a: readonly string[], b: readonly string[]): boolean {
  const key = (tags: readonly string[]): string =>
    [...tags]
      .filter((t) => t.length > 0)
      .sort()
      .join(',')
  return key(a) === key(b)
}

/**
 * 决定一条候选事实该怎么落地。
 *
 * 判定顺序是刻意的（从"最确定"到"最宽松"）：
 *   ① 完全重复      → discard（不新增、也不加强：它没有带来新信息）
 *   ② 同主题且矛盾  → supersede
 *   ③ 同主题不矛盾  → reinforce
 *   ④ 其余          → new
 *
 * ⚠️ 只有**同主题**才考虑矛盾。跨主题的否定关系不判——
 *    那需要真正的语义理解，硬做会误伤。
 */
export function planConsolidation(input: ConsolidationInput): ConsolidationPlan {
  const { candidate, existing } = input
  const threshold = input.duplicateThreshold ?? 0.9
  const normalized = normalizeContent(candidate.content)

  // 只看同主题的既有记忆
  const sameTopicExisting = existing.filter((record) => sameTopic(record.tags, candidate.tags))

  // ① 完全重复
  for (const record of sameTopicExisting) {
    if (similarity(normalized, normalizeContent(record.content)) >= threshold) {
      return { action: 'discard' }
    }
  }

  // ② 同主题且矛盾 → 取代
  for (const record of sameTopicExisting) {
    if (contradicts(candidate.content, record.content)) {
      return {
        action: 'supersede',
        content: candidate.content,
        tags: candidate.tags,
        targetId: record.id,
      }
    }
  }

  // ③ 同主题不矛盾 → 加强（取最近的一条：同一主题下最该被加强的是它）
  if (sameTopicExisting.length > 0) {
    const latest = [...sameTopicExisting].sort(
      (a, b) => b.occurredAt - a.occurredAt || b.id - a.id,
    )[0]
    if (latest) return { action: 'reinforce', targetId: latest.id }
  }

  // ④ 全新
  return { action: 'new', content: candidate.content, tags: candidate.tags }
}

/**
 * 加强一条记忆时权重怎么涨。
 *
 * 采用"向 1 逼近但永不达到"的写法：每次把"到 1 的距离"缩掉 18%。
 *
 * ── 为什么不用 `+0.1` ──
 *
 * 线性加法会在有限次后到 1，然后**再也无法区分**"刚被发现"与
 * "已被反复确认"；而渐近式永远保留这个差别，也天然不会越界。
 *
 * ⚠️ 但渐近有个真实的下溢问题：连乘约 190 次后 `1 - (1-base)*0.82^n`
 *    在双精度下会**四舍五入到 1.0**，于是"永不达到 1"这条性质失效。
 *    提出来单测就是因为它会被这条性质抓住。
 *    处理方式：把结果钳在 1 - 1e-6，既保留"严格小于 1"，
 *    又让它在数值上与 1 无法区分（那正是"已经被确认很多次"该有的样子）。
 *
 * @param current 当前权重 ∈ [0,1]
 * @param times 本次加强包含几次确认
 */
export function reinforcedWeight(current: number, times = 1): number {
  if (!Number.isFinite(current)) return 0
  const base = Math.min(1, Math.max(0, current))
  if (!Number.isFinite(times) || times <= 0) return base
  // 每次把"到 1 的距离"缩掉 18%
  const next = 1 - (1 - base) * Math.pow(0.82, times)
  // 钳住上界：渐近线在浮点下会被四舍五入突破
  return Math.min(next, 1 - 1e-6)
}
