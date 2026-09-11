import { useCallback, useEffect, useMemo, useState } from 'react'

import type { MemoryLedgerEntry } from '@shared/types'

/**
 * 记忆账本（施工令 §5 M3：「**可见、可删、可一键清空、可手动让它记住/忘掉**」）。
 *
 * ── 这个界面的第一职责不是"管理"，是**让人放心** ──
 *
 * 一只会记事的桌宠，用户心里第一个问题是"它到底记了什么？"
 * 界面必须**当场、完整**地回答这个问题，而不是给一个模糊的摘要。
 * 所以：原文照抄、时间明确、来源可查。
 *
 * ── 删除为什么不做二次确认弹窗 ──
 *
 * 单条删除的代价很低（就是一条流水账），而弹窗会打断阅读节奏。
 * 改成一个**就地二次点击**：第一次点变成"确定删？"，三秒后自己变回去。
 * 这样误触不会删掉东西，也不会跳出一个打断注意力的模态框。
 * 「清空全部」代价高得多，但同样用就地二次点击——它的破坏性一眼看得出。
 */

type Kind = MemoryLedgerEntry['kind']

/** 层级的中文名。**不要**在界面上直接显示 `episodic` 这种内部词。 */
const KIND_LABEL: Record<Kind, string> = {
  episodic: '情景',
  semantic: '语义',
  emotional: '情感',
}

/** 每种层级一句话解释。用户看不懂"语义记忆"是什么意思。 */
const KIND_HINT: Record<Kind, string> = {
  episodic: '某天发生的一件事，会随时间淡忘',
  semantic: '关于你的稳定事实，它自己总结的或你教它的',
  emotional: '带情绪的事，记得比一般的事久',
}

const EMOTION_LABEL: Record<string, string> = {
  happy: '开心',
  calm: '平静',
  sleepy: '困了',
  focused: '专注',
  aggrieved: '委屈',
  surprised: '惊讶',
  close: '亲近',
  bored: '无聊',
}

/** 把毫秒时间戳写成"今天 14:03"这种读得懂的形态。 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${clock}`

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (isYesterday) return `昨天 ${clock}`

  const monthDay = `${String(date.getMonth() + 1)}月${String(date.getDate())}日`
  // 跨年了才带年份，否则满屏都是 2026，反而看不清"多久以前"。
  return date.getFullYear() === now.getFullYear()
    ? `${monthDay} ${clock}`
    : `${String(date.getFullYear())}年${monthDay}`
}

export function Ledger(): React.JSX.Element {
  const [entries, setEntries] = useState<MemoryLedgerEntry[]>([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 正在等待"确定删？"的那一条。 */
  const [pendingForgetId, setPendingForgetId] = useState<number | null>(null)
  /** 「清空全部」是否在等待确认。 */
  const [pendingClearAll, setPendingClearAll] = useState(false)

  /**
   * 按关键词重新拉取列表。
   *
   * ★ 这个是**事件处理器**，不是 effect 里的自动同步。
   *   搜索框的 `onChange` 直接调它——刻意不用 "state 变了 → useEffect → 拉取"
   *   那套写法。那条路上有两个真实的坑：
   *   ①`setState` 在 effect 里同步发生会引发级联渲染；
   *   ②"搜索词没变"时（比如刚写完一条记忆、把搜索框从空设成空）
   *     effect 根本不会触发，新数据就显示不出来——表象是"点了没反应"。
   *   显式调用把"什么时候该重新读"变成代码里看得见的一件事。
   *   账本是千条级，主进程的子串检索实测 0.05ms，不需要防抖。
   */
  const refresh = useCallback(async (searchText: string) => {
    try {
      const list = await window.xiaoqi.listMemories(searchText.trim() || undefined)
      setEntries(list)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次挂载时读一次。刻意只在挂载时跑：之后的每次刷新都由
  // 具体动作（输入、点刷新、增删）显式触发。
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh('')
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [refresh])

  // 「确定删？」三秒后自动收回，避免它一直挂在那里等着被误点。
  useEffect(() => {
    if (pendingForgetId === null) return
    const timer = setTimeout(() => {
      setPendingForgetId(null)
    }, 3000)
    return () => {
      clearTimeout(timer)
    }
  }, [pendingForgetId])

  useEffect(() => {
    if (!pendingClearAll) return
    const timer = setTimeout(() => {
      setPendingClearAll(false)
    }, 3000)
    return () => {
      clearTimeout(timer)
    }
  }, [pendingClearAll])

  const forget = useCallback(
    async (id: number) => {
      const removed = await window.xiaoqi.forgetMemory(id)
      setPendingForgetId(null)
      if (!removed) {
        // 只有"没删掉"才提示。删掉了就让它安静地消失——
        // 弹一句"已删除"是在为一个不需要确认的动作要求确认。
        setError('这条记忆没能删掉（可能已经被清理过了）')
      }
      await refresh(query)
    },
    [query, refresh],
  )
  const forgetAll = useCallback(async () => {
    const removed = await window.xiaoqi.forgetAllMemories()
    setPendingClearAll(false)
    setError(null)
    // ★ 用 removed 而不是本地列表长度：以数据库实际删掉的条数为准。
    if (removed === 0) setError('没有可清空的记忆')
    await refresh(query)
  }, [query, refresh])

  const remember = useCallback(async () => {
    const content = draft.trim()
    if (content.length === 0) return
    const id = await window.xiaoqi.rememberFact(content)
    if (id === null) {
      setError('没能写入（记忆可能不可用）')
      return
    }
    setDraft('')
    setError(null)
    // 清空搜索词，否则刚写入的这条可能因为不匹配当前关键词而"看不见"，
    // 让用户以为没写进去。
    setQuery('')
    // ⚠️ 必须**显式**刷新一次。
    //    清空搜索词在"搜索框本来就是空的"时候不会改变 `query`，
    //    于是上面那个 `useEffect` 根本不触发，新写入的记忆就不会出现
    //    ——用户看到的是"点了没反应"，而数据其实已经写进去了。
    await refresh('')
  }, [draft, refresh])

  // 各层级的条数，用于顶部那句"它现在记得多少"。
  const counts = useMemo(() => {
    const result: Record<Kind, number> = { episodic: 0, semantic: 0, emotional: 0 }
    for (const entry of entries) result[entry.kind]++
    return result
  }, [entries])

  return (
    <div className="ledger">
      <header className="ledger__header">
        <div>
          <h1 className="ledger__title">小奇记得什么</h1>
          <p className="ledger__subtitle">
            {loading
              ? '正在读取…'
              : entries.length === 0
                ? '它现在什么都不记得'
                : `共 ${String(entries.length)} 条 · 情景 ${String(counts.episodic)} · 语义 ${String(counts.semantic)} · 情感 ${String(counts.emotional)}`}
          </p>
        </div>
        <button
          type="button"
          className={pendingClearAll ? 'btn btn--danger' : 'btn'}
          onClick={() => {
            if (pendingClearAll) void forgetAll()
            else setPendingClearAll(true)
          }}
          disabled={entries.length === 0 && !pendingClearAll}
        >
          {pendingClearAll ? '确定全部删掉？' : '清空全部'}
        </button>
      </header>

      <div className="ledger__toolbar">
        <input
          className="field field--search"
          type="search"
          placeholder="搜它记得的事…（支持中文词）"
          value={query}
          onChange={(event) => {
            const next = event.target.value
            setQuery(next)
            // 直接读，不经过 effect。理由见上面 `refresh` 的注释。
            void refresh(next)
          }}
          aria-label="搜索记忆"
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            void refresh(query)
          }}
          aria-label="重新读取记忆列表"
        >
          刷新
        </button>
      </div>

      <div className="ledger__toolbar">
        <input
          className="field"
          type="text"
          placeholder="教它记住一件事，比如「我不喝咖啡」"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void remember()
          }}
          aria-label="手动添加记忆"
        />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void remember()}
          disabled={draft.trim().length === 0}
        >
          记住这条
        </button>
      </div>

      {error !== null && <p className="ledger__error">{error}</p>}

      {!loading && entries.length === 0 ? (
        <p className="ledger__empty">
          {query.trim().length > 0
            ? `没有记得「${query.trim()}」相关的事。`
            : '还没有记忆。你来找它玩几次，它就会开始记事。'}
        </p>
      ) : (
        <ul className="ledger__list">
          {entries.map((entry) => (
            <li key={entry.id} className={`card card--${entry.kind}`}>
              <div className="card__head">
                <span className={`tag tag--${entry.kind}`} title={KIND_HINT[entry.kind]}>
                  {KIND_LABEL[entry.kind]}
                </span>
                <time className="card__time" dateTime={new Date(entry.occurredAt).toISOString()}>
                  {formatTime(entry.occurredAt)}
                </time>
                {entry.userAuthored && (
                  <span className="tag tag--authored" title="你亲手教它记住的，不会随遗忘曲线淡去">
                    你教的
                  </span>
                )}
                {entry.emotion !== undefined && (
                  <span className="tag tag--emotion">
                    {EMOTION_LABEL[entry.emotion] ?? entry.emotion}
                  </span>
                )}
                <span className="card__spacer" />
                <span
                  className="card__strength"
                  title={
                    entry.kind === 'semantic'
                      ? '稳定事实，不会淡忘'
                      : '它还记得多牢。越低越接近被忘掉。'
                  }
                >
                  <span className="card__strengthBar" aria-hidden="true">
                    <span
                      className="card__strengthFill"
                      style={{ inlineSize: `${String(Math.round(entry.strength * 100))}%` }}
                    />
                  </span>
                  {String(Math.round(entry.strength * 100))}%
                </span>
                <button
                  type="button"
                  className={
                    pendingForgetId === entry.id ? 'btn btn--sm btn--danger' : 'btn btn--sm'
                  }
                  onClick={() => {
                    if (pendingForgetId === entry.id) void forget(entry.id)
                    else setPendingForgetId(entry.id)
                  }}
                >
                  {pendingForgetId === entry.id ? '确定删？' : '忘掉'}
                </button>
              </div>
              <p className="card__content">{entry.content}</p>
              {entry.tags.length > 0 && (
                <div className="card__tags">
                  {entry.tags.map((tag) => (
                    <span key={tag} className="tag tag--plain">
                      {tag}
                    </span>
                  ))}
                  {entry.derivedFrom !== undefined && (
                    <span className="card__origin">由它自己从几次同类的事里总结出来</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <footer className="ledger__footer">
        「忘掉」是真的删除，不是标记——删掉之后原文不会再留在文件里。
      </footer>
    </div>
  )
}
