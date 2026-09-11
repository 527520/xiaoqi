import { join } from 'node:path'

import { BrowserWindow, app } from 'electron'

/**
 * 记忆账本窗口（施工令 §5 M3：「可见、可删、可一键清空、可手动让它记住/忘掉」）。
 *
 * ── 为什么是**独立窗口**，不是宠物身上的一块面板 ──
 *
 * 宠物窗口有三个把它钉死的属性：`transparent` + `frame: false` + 220×220。
 * 账本要显示几十条文字、要能搜索、要能滚动——塞进那个窗口既不现实，
 * 也会把"宠物"和"设置界面"两种完全不同的东西混在一个渲染进程里。
 *
 * 与宠物窗口相反，账本是个**普通窗口**：
 * 有边框、有标题栏、进任务栏、可缩放、不置顶。
 * 它出现时应该是"用户打开了它"，而不是"桌面上多了个东西"。
 */
export function createLedgerWindow(options: { readonly preloadPath: string }): BrowserWindow {
  const window = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 420,
    minHeight: 360,

    // 普通窗口的默认外观：有边框、可缩放。刻意不设 transparent。
    title: '小奇记得什么',
    // 与宠物的配色同源（云蓝灰 + 墨），但底色不透明——账本是要读字的。
    backgroundColor: '#eef2f7',
    show: false,
    // ★ 不置顶。账本是用户主动打开来读的东西，抢在别的窗口前面只会碍事。
    alwaysOnTop: false,
    // 账本**进**任务栏与 Alt+Tab：用户需要能切回来。
    skipTaskbar: false,

    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 账本是普通窗口，开 DevTools 不会破坏透明（那个限制只针对宠物窗口）。
      devTools: !app.isPackaged,
    },
  })

  return window
}

/**
 * 账本页面的入口。
 *
 * ⚠️ `ledger.html` 必须与 `src/renderer/ledger.html` **同名同路径**——
 * electron-vite 会按 root 的相对路径产出它，两处不一致就是白屏。
 * 这条约定和宠物窗口的 `index.html` 一样，所以两处都写在同一类函数里，便于对照。
 */
export function resolveLedgerEntry(): { url?: string; file?: string } {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    // dev server 下两个页面同源，只是路径不同。
    return { url: new URL('ledger.html', devServerUrl).toString() }
  }
  return { file: join(__dirname, '../renderer/ledger.html') }
}
