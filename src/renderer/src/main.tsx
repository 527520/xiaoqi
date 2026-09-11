// ★ 顺序是刻意的：先安装全局错误上报，再导入 React / Pixi。
//
// 这样连 React 或 Pixi 在**模块求值期**抛的错也能被捞到。
// 之所以需要这条通道：本机没有别的渲染进程诊断出口——
// DevTools 一打开透明窗就不透明了（施工令 §4.3②），
// 而 Chromium 的 console-message 事件只给消息文本、不带堆栈。
//
// 注：ESM 的 import 会被提升，所以 installErrorReporting 的**调用**单独成句，
// 且必须排在会抛错的那些导入之前。
import { installErrorReporting } from './installErrorReporting'

installErrorReporting()

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 容器——index.html 与 main.tsx 不同步')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
