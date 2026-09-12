import { useCallback, useEffect, useMemo, useState } from 'react'

import type { MemoryBlockKind, MemoryBlockView, MemoryLedgerEntry } from '@shared/types'

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

/**
 * 核心记忆块编辑器（阶段二：常驻上下文）。
 *
 * ── 为什么它必须可编辑，而不是只读展示 ──
 *
 * 核心块**每一轮都进 prompt**（不参与相似度竞争）。一条说错了的常驻事实
 * 比一百条检索式记忆更伤——它会持续影响宠物对用户的每一句话。
 * 所以用户必须能看见它、改写它、清掉它。
 *
 * ── 为什么每块显示"还能写多少" ──
 *
 * 上限直接决定常驻内容吃掉多少 token。上限**只在主进程有一份真相**
 * （随视图一起送过来），界面不复制一份——复制的那份会漂移，
 * 而漂移的表现是"界面说还能写，实际被裁掉了"，用户完全无法理解。
 */
function BlockEditor({
  block,
  onSaved,
  onError,
}: {
  block: MemoryBlockView
  onSaved: () => Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  // ⚠️ 这里**刻意不**用「effect 监听 `block.content` 变化 → setDraft」那种写法。
  //
  // 那个写法有两个问题：① 在 effect 里同步 setState 会引发级联渲染
  // （lint 也会拦）；② 它无法区分"外部数据变了"与"用户正在打字"——
  // 用户打字打到一半、后台刚好刷新了一次，草稿就会被冲掉。
  //
  // 正确做法是**用 key 重置组件**：调用方把"服务端内容的版本"放进 key，
  // 内容真的变了就换一个新实例，初始 state 自然取到新值；
  // 而用户打字不会改 key，草稿因此不会被打断。
  const [draft, setDraft] = useState(block.content)
  const [pendingClear, setPendingClear] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!pendingClear) return
    const timer = setTimeout(() => {
      setPendingClear(false)
    }, 3000)
    return () => {
      clearTimeout(timer)
    }
  }, [pendingClear])

  const used = draft.length
  const over = used > block.limit
  const dirty = draft !== block.content

  const save = useCallback(async () => {
    setBusy(true)
    try {
      const ok = await window.xiaoqi.setBlock(block.kind, draft)
      if (!ok) onError(`「${block.label}」没能写入（记忆可能不可用）`)
      else onError('')
      await onSaved()
    } finally {
      setBusy(false)
    }
  }, [block.kind, block.label, draft, onError, onSaved])

  const clear = useCallback(async () => {
    setBusy(true)
    try {
      await window.xiaoqi.clearBlock(block.kind)
      setPendingClear(false)
      await onSaved()
    } finally {
      setBusy(false)
    }
  }, [block.kind, onSaved])

  return (
    <section className="block">
      <div className="block__head">
        <span className="block__label">{block.label}</span>
        {block.isDefault && (
          <span className="tag tag--plain" title="还没落库，用的是内置默认内容">
            默认
          </span>
        )}
        <span className="card__spacer" />
        {/* 计数超限时才变红：正常状态下它只是个安静的提示 */}
        <span className={over ? 'block__count block__count--over' : 'block__count'}>
          {used} / {block.limit}
        </span>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => void save()}
          disabled={!dirty || busy}
        >
          保存
        </button>
        <button
          type="button"
          className={pendingClear ? 'btn btn--sm btn--danger' : 'btn btn--sm'}
          onClick={() => {
            if (pendingClear) void clear()
            else setPendingClear(true)
          }}
          disabled={busy || block.content.length === 0}
        >
          {pendingClear ? '确定清空？' : '清空'}
        </button>
      </div>
      <textarea
        className="block__editor"
        value={draft}
        rows={block.kind === 'now' ? 2 : 4}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        aria-label={`编辑「${block.label}」`}
      />
      <p className="block__hint">{BLOCK_HINT[block.kind]}</p>
    </section>
  )
}

/** 每个块一句话解释。用户看不懂"核心块"是什么意思。 */
const BLOCK_HINT: Record<MemoryBlockKind, string> = {
  persona: '它每句话都会带着这段。**只描述它自己**，不要写成对用户的评价。',
  human: '关于你的稳定事实，每次都会带上——适合放"它绝对不能忘"的事。',
  now: '当下的处境与状态，由它自己填。',
}

export function Ledger(): React.JSX.Element {
  const [entries, setEntries] = useState<MemoryLedgerEntry[]>([])
  const [blocks, setBlocks] = useState<MemoryBlockView[]>([])
  const [superseded, setSuperseded] = useState<MemoryLedgerEntry[]>([])
  const [contextPreview, setContextPreview] = useState('')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 正在等待"确定删？"的那一条。 */
  const [pendingForgetId, setPendingForgetId] = useState<number | null>(null)
  /** 「清空全部」是否在等待确认。 */
  const [pendingClearAll, setPendingClearAll] = useState(false)
  /** 主列表 vs 历史视图。 */
  const [view, setView] = useState<'current' | 'history'>('current')

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
      const text = searchText.trim() || undefined
      const list = await window.xiaoqi.listMemories(text)
      setEntries(list)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 刷新阶段二那三块内容（核心块 / 历史 / 上下文预览）。
   *
   * 与 `refresh` 分开是因为它们的**读取时机不同**：列表跟着搜索词走，
   * 而这三样与搜索词无关。合成一个的话，每次敲一个字都要重算一遍
   * 上下文预览——那是主进程在拼字符串，纯浪费。
   */
  const refreshBlocks = useCallback(async () => {
    try {
      const [nextBlocks, history, preview] = await Promise.all([
        window.xiaoqi.listBlocks(),
        window.xiaoqi.listSuperseded(),
        window.xiaoqi.previewContext(),
      ])
      setBlocks(nextBlocks)
      setSuperseded(history)
      setContextPreview(preview)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 首次挂载时读一次。刻意只在挂载时跑：之后的每次刷新都由
  // 具体动作（输入、点刷新、增删）显式触发。
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh('')
      void refreshBlocks()
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [refresh, refreshBlocks])

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
      // 删一条可能让整个取代链条一起消失（用户的删除是承诺），
      // 所以历史视图必须跟着重读。
      await refreshBlocks()
    },
    [query, refresh, refreshBlocks],
  )
  const forgetAll = useCallback(async () => {
    const removed = await window.xiaoqi.forgetAllMemories()
    setPendingClearAll(false)
    setError(null)
    // ★ 用 removed 而不是本地列表长度：以数据库实际删掉的条数为准。
    if (removed === 0) setError('没有可清空的记忆')
    await refresh(query)
    await refreshBlocks()
  }, [query, refresh, refreshBlocks])

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
    // 手写的事实也要出现在上下文预览里，否则用户会以为它没被采纳。
    await refreshBlocks()
  }, [draft, refresh, refreshBlocks])

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
          className="btn"
          onClick={() => {
            setView(view === 'current' ? 'history' : 'current')
          }}
          title={
            view === 'history'
              ? '回到它现在记得的事'
              : '看它以前是这么认为的（被新事实取代的旧事实）'
          }
        >
          {view === 'history'
            ? '回到当前'
            : `历史${superseded.length > 0 ? ` (${String(superseded.length)})` : ''}`}
        </button>
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

      {/* ── 核心记忆块（常驻上下文）── */}
      {view === 'current' && blocks.length > 0 && (
        <section className="blocks">
          <h2 className="blocks__title">
            它一直记着的
            <span className="blocks__sub">
              这几段每次都会带上，不参与检索——所以必须短，也必须准。
            </span>
          </h2>
          {blocks.map((block) => (
            <BlockEditor
              // ★ key 里带上"内容的版本"，内容真的变了才换实例。
              //   用 `block.content` 而不是 `updatedAt`：清空之后重新落到
              //   默认人设时，`updatedAt` 可能仍是旧值（读路径不写库），
              //   而内容确实换了。以内容为准最稳。
              key={`${block.kind}:${block.content}`}
              block={block}
              onSaved={refreshBlocks}
              onError={(message) => {
                setError(message.length > 0 ? message : null)
              }}
            />
          ))}
        </section>
      )}

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

      {view === 'history' ? (
        <section className="history">
          <p className="history__intro">
            这些是它**以前**认为的事。被新事实推翻之后它们不再参与回应，但保留下来——
            所以你能看出它改过什么主意。（点「忘掉」仍是真的删除。）
          </p>
          {superseded.length === 0 ? (
            <p className="ledger__empty">它还没有改过主意。</p>
          ) : (
            <ul className="ledger__list">
              {superseded.map((entry) => (
                <li key={entry.id} className="card card--superseded">
                  <div className="card__head">
                    <span className="tag tag--superseded">旧事实</span>
                    <time
                      className="card__time"
                      dateTime={new Date(entry.occurredAt).toISOString()}
                    >
                      {formatTime(entry.occurredAt)}
                    </time>
                    {entry.supersededAt !== undefined && (
                      <span className="card__origin">{formatTime(entry.supersededAt)}被取代</span>
                    )}
                    <span className="card__spacer" />
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
                  <p className="card__content card__content--struck">{entry.content}</p>
                  <p className="card__origin">
                    现在信的是这一条（#{String(entry.supersededBy ?? '?')}）
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : !loading && entries.length === 0 ? (
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

      {/* ── 上下文预览（阶段二对外的唯一出口）── */}
      {view === 'current' && contextPreview.length > 0 && (
        <details className="preview">
          <summary className="preview__summary">
            它此刻带着的上下文
            <span className="preview__sub">（接上大模型之后，这段就是每轮真正送过去的内容）</span>
          </summary>
          <pre className="preview__body">{contextPreview}</pre>
        </details>
      )}

      <footer className="ledger__footer">
        「忘掉」是真的删除，不是标记——删掉之后原文不会再留在文件里。
      </footer>
    </div>
  )
}
