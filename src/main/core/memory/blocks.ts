/**
 * 核心记忆块 —— **常驻上下文**，参考 Letta 的 core memory blocks。
 *
 * ── 它解决什么问题 ──
 *
 * 检索式记忆有个结构性缺陷：**重要的事会被漏掉**。
 * "用户不喝咖啡"如果某次检索没命中，宠物就会推荐咖啡——
 * 而这恰恰是最伤信任的一类错误。
 *
 * 核心块把**少量、稳定、必须一直记得**的事实固定放进上下文，
 * 不参与相似度竞争。代价是它每次都要占预算，所以**必须有上限**，
 * 且上限要小到能一眼看完。
 *
 * ── 与其它三层的关系 ──
 *
 * | 层 | 进上下文的方式 | 上限 |
 * |---|---|---|
 * | 核心块 | **永远进** | 每个块有字符上限 |
 * | 情景/情感记忆 | 按时间衰减 + 检索 | 由遗忘曲线管 |
 * | 语义记忆 | 按检索命中 | 由 `consolidate.ts` 管 |
 *
 * ── ⚠️ 与 ADR-0003 的关系（最容易写歪的地方）──
 *
 * `persona` 块**只描述它自己**，绝不描述用户。
 * 绝不能出现"用户很少理我"这类内容——那是把宠物的情绪写进
 * 用户的档案，正是 ADR-0003 要避免的指控式表达。
 * 这个约束由 `blocks.test.ts` 用措辞守卫反向验证。
 */

/** 块的种类。三种各有明确职责，不要混。 */
export type MemoryBlockKind =
  /** 它自己是谁、什么脾气。**只描述宠物自己。** */
  | 'persona'
  /** 关于用户的稳定事实。 */
  | 'human'
  /** 当前会话状态（模式/情绪/关系基调）。 */
  | 'now'

/** 一个核心块。 */
export interface MemoryBlock {
  readonly kind: MemoryBlockKind
  readonly content: string
  readonly updatedAt: number
}

/**
 * 每个块的**字符上限**。
 *
 * 这些数字是"预算"而不是"容量"：它们直接决定每轮 prompt 里
 * 有多少 token 被常驻内容吃掉。取得很紧（几百字）是刻意的——
 * 常驻内容的边际价值下降很快，而检索式记忆更适合装"多"。
 *
 * 超限不报错，由 `fitBlock` 按**整行**裁剪：宁可少记一条，
 * 也不要留半句话（半句事实比没有更糟，它会被模型当成完整事实读）。
 */
export const BLOCK_LIMITS: Record<MemoryBlockKind, number> = {
  persona: 400,
  human: 600,
  now: 200,
}

/** 块的中文名（界面与日志用）。 */
export const BLOCK_LABELS: Record<MemoryBlockKind, string> = {
  persona: '它自己',
  human: '关于你',
  now: '此刻',
}

/** 默认的 `persona` 内容。用户可以在记忆账本里改写。 */
export const DEFAULT_PERSONA = [
  '我是小奇，一只住在你桌面上的小动物。',
  '我话不多，喜欢安静地待在角落陪着。',
  '你伸手的时候我一定会回应。',
]

/** 默认的 `now` 内容由运行时状态拼出来（见 `composeNowBlock`）。 */

/**
 * 按整行裁剪内容，使总长不超过上限。
 *
 * 规则：
 * - 行之间用换行连接；
 * - **只保留能完整放下的行**，绝不截断半行；
 * - 放不下的行直接丢弃（不报错、不缩略）。
 *
 * @param lines 候选行（按重要性**从高到低**排序，调用方负责）
 * @param limit 字符上限
 */
export function fitBlock(lines: readonly string[], limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const kept: string[] = []
  let used = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    // +1 是换行符占位；第一行不需要
    const cost = line.length + (kept.length > 0 ? 1 : 0)
    if (used + cost > limit) continue
    kept.push(line)
    used += cost
  }
  return kept.join('\n')
}

/** 拼装时的输入：`now` 块的来源状态。 */
export interface NowBlockInput {
  readonly workMode: string
  readonly emotion: string
  /** 关系基调（`reserved` / `warm` / `attached`）。 */
  readonly mood: string
  /** 是否已淡到"想念"的程度。 */
  readonly misses: boolean
}

/**
 * 生成 `now` 块的内容。
 *
 * ⚠️ 措辞纪律：这里只陈述**状态**，不做任何评价或索取。
 *    - ✅「你正在加班」 ✅「我有点困」
 *    - ❌「你已经很久没理我了」 ❌「你该休息了」
 *
 * `misses` 用「有点想你」而不是「你很久没来」——
 * 前者是宠物自己的感受，后者暗含"你应该来"。
 */
export function composeNowBlock(input: NowBlockInput): string {
  const lines = [`你现在的处境：${input.workMode}`, `我现在的状态：${input.emotion}`]
  // 只在关系确实亲近时才提"黏人"——否则会在刚认识时显得莫名其妙
  if (input.mood === 'attached') lines.push('我们很熟了，我会靠得近一点。')
  else if (input.mood === 'warm') lines.push('我们挺熟的。')
  if (input.misses) lines.push('有点想你。')
  return fitBlock(lines, BLOCK_LIMITS.now)
}

/** 一次拼装所需的全部输入。 */
export interface ComposeContextInput {
  readonly blocks: readonly MemoryBlock[]
  /** 检索到的记忆行（已按重要性/时间排好序）。 */
  readonly recalled: readonly string[]
  /** 检索部分的上限。 */
  readonly recalledLimit?: number
}

/**
 * 把核心块与检索结果拼成一段可直接进 prompt 的文本。
 *
 * ── 顺序是刻意的 ──
 *
 * 核心块在前、检索结果在后：模型对靠前的内容更"当回事"，
 * 而核心块正是"必须一直记得"的那部分。
 *
 * ── 缺失的块不占位 ──
 *
 * 没有内容的块整段略去，而不是留一个空标题。
 * 空标题会占 token 且给出"这里本该有东西"的暗示，反而制造噪声。
 */
export function composeContext(input: ComposeContextInput): string {
  const sections: string[] = []

  for (const kind of ['persona', 'human', 'now'] as const) {
    const block = input.blocks.find((b) => b.kind === kind)
    if (!block) continue
    const content = fitBlock(block.content.split('\n'), BLOCK_LIMITS[kind])
    if (content.length === 0) continue
    sections.push(`【${BLOCK_LABELS[kind]}】\n${content}`)
  }

  if (input.recalled.length > 0) {
    const limit = input.recalledLimit ?? 10
    const picked = input.recalled.slice(0, Math.max(0, limit))
    if (picked.length > 0) {
      sections.push(`【我想起来的事】\n${picked.map((line) => `- ${line}`).join('\n')}`)
    }
  }

  return sections.join('\n\n')
}

/**
 * 一段现成的 `persona` 块（首次启动时写入）。
 *
 * 单独一个函数而不是常量，是为了让它也走 `fitBlock`——
 * 于是"默认内容超限"这件事在开发期就会暴露，而不是等到界面上显示半句。
 */
export function defaultPersonaBlock(now: number): MemoryBlock {
  return {
    kind: 'persona',
    content: fitBlock(DEFAULT_PERSONA, BLOCK_LIMITS.persona),
    updatedAt: now,
  }
}

/** 全部块种类（有稳定顺序，便于遍历与测试）。 */
export const BLOCK_KINDS: readonly MemoryBlockKind[] = ['persona', 'human', 'now']
