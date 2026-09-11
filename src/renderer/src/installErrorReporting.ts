/**
 * 把渲染进程的未捕获错误送到主进程日志。
 *
 * ── 为什么需要这个 ──
 *
 * 本机排查渲染进程的手段几乎都被堵死了：
 *
 * - **DevTools 一打开就让透明窗变不透明**（施工令 §4.3②），所以不能开着它看；
 * - Chromium 的 `console-message` 事件**只给消息文本**：实测对未捕获的
 *   Promise 拒绝，`sourceId` 与 `lineNumber` 都是空的，**拿不到堆栈**。
 *
 * 结果是"宠物没渲染出来"会变成一个纯黑盒——窗口透明且正常，却没有任何线索
 * 指向真正出错的那一行。这个模块就是为这条通道存在的。
 *
 * 它在 `main.tsx` 的**最顶部**导入并立刻调用，早于 React 与 Pixi 的任何求值，
 * 因此连模块初始化期的报错也能捞到。
 *
 * @param page 上报来源标签（`pet` / `ledger`）。两个窗口共用一个通道，
 *   没有标签就分不清"是宠物崩了还是账本崩了"。
 */
export function installErrorReporting(page: string): void {
  // 打点：确认安装时机。启动期的报错如果早于这一行，就说明还有更早的求值路径。
  // 标注为 boot-checkpoint 而非 error，下面的断言据此把它与真实错误区分开。
  window.xiaoqi.reportError('boot-checkpoint', `${page} 页面已开始执行`)

  window.addEventListener('error', (event) => {
    const error = event.error as unknown
    const stack = error instanceof Error ? (error.stack ?? '(无堆栈)') : '(非 Error 对象)'
    window.xiaoqi.reportError(`window.error: ${event.message}`, stack)
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as unknown
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? (reason.stack ?? '(无堆栈)') : '(非 Error 对象)'
    window.xiaoqi.reportError(`unhandledrejection: ${message}`, stack)
  })
}
