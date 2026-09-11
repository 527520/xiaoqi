import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { installErrorReporting } from '../installErrorReporting'
import { Ledger } from './Ledger'
import './ledger.css'

/**
 * 记忆账本窗口的入口。
 *
 * ⚠️ 与宠物页面**分开**的原因：宠物的 `main.tsx` 会拉起 Pixi 与整个舞台，
 * 而账本一行 Pixi 都不需要。两个入口分开，账本窗口就不必为一个
 * 文字列表加载 1.4MB 的渲染库。
 */

// 与宠物页面同一个上报通道：账本崩了也要能在主进程日志里看到堆栈。
installErrorReporting('ledger')

const container = document.getElementById('ledger-root')
if (!container) {
  throw new Error('找不到 #ledger-root 容器——ledger.html 与 main.tsx 不同步')
}

createRoot(container).render(
  <StrictMode>
    <Ledger />
  </StrictMode>,
)
