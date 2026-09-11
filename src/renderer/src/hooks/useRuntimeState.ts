import { useEffect, useState } from 'react'

import type { PetRuntimeState } from '@shared/types'

/**
 * 订阅主进程推送的运行时状态。
 *
 * 渲染进程**不持有真相**：形态、穿透状态、工作区全部由主进程决定，
 * 这里只做投影。这样"谁在什么状态下"只有一个答案，
 * 不会出现主进程与渲染进程对当前形态各执一词的情况。
 *
 * （Zustand 已在依赖里，但 M1 只有这一个状态值，
 * 引入 store 只是多一层间接。M6 的设置界面会有真正的多片状态再上。）
 */
export function useRuntimeState(): PetRuntimeState | null {
  const [state, setState] = useState<PetRuntimeState | null>(null)

  useEffect(() => {
    let cancelled = false

    window.xiaoqi
      .getState()
      .then((initial) => {
        if (!cancelled) setState(initial)
      })
      .catch(() => {
        // 拿不到初始状态不应该让宠物整个白屏——保持 null，
        // 由 App 用一个保守的默认形态继续渲染。
      })

    const unsubscribe = window.xiaoqi.onStateChanged((next) => {
      setState(next)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}
