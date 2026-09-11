import { useRef, type JSX } from 'react'

import { useRuntimeState } from './hooks/useRuntimeState'
import { usePetStage } from './pet/usePetStage'

/**
 * 宠物窗口的根组件。
 *
 * 只有两件事：一个承载 canvas 的容器，以及把主进程状态接到舞台上。
 * 所有系统行为（穿透、静默、置顶、隐身）都在主进程，这里一概不管——
 * 渲染进程是纯投影，没有权限也没有责任去决定那些事。
 */
export function App(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const state = useRuntimeState()

  usePetStage(containerRef, state)

  return <div ref={containerRef} className="pet-stage" />
}
