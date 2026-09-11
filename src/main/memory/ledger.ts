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
  }
}
