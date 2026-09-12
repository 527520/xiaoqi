import type { MemoryLedgerEntry } from '@shared/types'

import { currentWeight, type MemoryRecord } from '../core/memory/model'

/**
 * 内部记忆记录 → 账本条目（**唯一的转换点**）。
 *
 * ── 为什么只留一个转换点 ──
 *
 * 账本界面要显示"它记得有多牢"。如果渲染进程自己按时间戳算一遍，
 * 就会出现两套口径：主进程按 `currentWeight()` 判定该不该清，
 * 界面按自己那套显示——于是用户看到"显示还有 30% 牢度"的记忆
 * 被维护周期清掉了，而这看起来完全是 bug。
 *
 * 因此强度一律由主进程用 `currentWeight()` 算好再送出去。
 * 界面上不做任何衰减计算。
 */
/**
 * 一条账本条目在时间线上的状态。
 *
 * 三态而不是布尔：`supersededBy` 让用户能回答"它现在改成了什么"，
 * 而只给一个 `superseded: true` 的话界面只能说"这条过期了"，
 * 用户还得自己去猜现在信哪条。
 */
export type LedgerState = 'current' | 'superseded'

export function toLedgerEntry(record: MemoryRecord, now: number): MemoryLedgerEntry {
  const kind = record.kind === 'working' ? 'episodic' : record.kind

  return {
    id: record.id,
    kind,
    occurredAt: record.occurredAt,
    content: record.content,
    tags: record.tags,
    // 只有情感记忆该带情绪与强度；其他层级带上会让界面显示出无意义的徽章。
    ...(record.kind === 'emotional' && record.emotion ? { emotion: record.emotion } : {}),
    ...(record.kind === 'emotional' && record.intensity !== undefined
      ? { intensity: record.intensity }
      : {}),
    strength: currentWeight(record, now),
    ...(record.derivedFrom !== undefined ? { derivedFrom: record.derivedFrom } : {}),
    // 用户手写的事实没有来源（`derivedFrom` 为空且是语义层），
    // 或者是它自己推断出来的——后者一定带 derivedFrom。
    userAuthored: record.kind === 'semantic' && record.derivedFrom === undefined,
    // ★ 被取代的历史。默认列表里不会出现它们（`search` 的默认过滤），
    //   只有"历史"视图显式要。带上 `supersededBy` 是为了让界面能标出
    //   "现在信的是哪一条"，而不是只告诉用户"这条过期了"。
    superseded: record.supersededBy !== undefined,
    ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
    ...(record.supersededAt !== undefined ? { supersededAt: record.supersededAt } : {}),
  }
}
