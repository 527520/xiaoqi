import { join } from 'node:path'

import { BrowserWindow, app } from 'electron'

import { PET_WINDOW_SIZE } from '@shared/constants'

/**
 * 宠物窗口的构造。
 *
 * ⚠️★ 透明度在 Windows 上有一组硬约束，任何一条破了都会**静默失效**
 * （不是报错，是窗口变成不透明黑块或干脆不显示）：
 *
 * 1. `transparent: true` **必须配 `frame: false`**，否则 transparent 不生效。
 * 2. `backgroundColor` 用 Electron 特有的 **`#AARRGGBB`（alpha 在前）**，
 *    与 CSS 的 `#RRGGBBAA` **顺序相反**。写成 CSS 顺序会得到不透明黑窗。
 * 3. **不要设 `resizable`**。`resizable: true` 可能破坏透明。
 * 4. **DevTools 打开时窗口不透明**——做视觉自测时不要开着 DevTools 截图。
 * 5. **Chromium 的原生遮挡追踪会让这个窗口变空白**（遮挡跟踪器在全屏应用前台时
 *    认为该显示器上所有窗口都被遮挡并停止绘制）。对策是禁用
 *    `CalculateNativeWinOcclusion`，且**必须在主脚本顶层**做——见 main/index.ts。
 *
 * 另注：`transparent` 窗口**无法**在显示后再切换成不透明，反之亦然。
 * 所以这些参数只在创建时能定，运行期不可改。
 */
export function createPetWindow(options: { readonly preloadPath: string }): BrowserWindow {
  const window = new BrowserWindow({
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,

    // ★ 1
    frame: false,
    transparent: true,
    // ★ 2：alpha 在前。8 个 0 = 完全透明。
    backgroundColor: '#00000000',
    // ★ 3：刻意不写 resizable —— 默认 false。

    // 宠物不该出现在任务栏与 Alt+Tab 里：它是"住在桌面上的东西"，
    // 不是一个需要被切换的窗口。
    skipTaskbar: true,
    // 不抢焦点：创建时就以非激活状态出现，避免打断用户正在做的事（§9 打扰控制）。
    show: false,
    // 桌面宠物没有最大/最小化的概念。
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,

    webPreferences: {
      preload: options.preloadPath,
      // 渲染进程安全三件套（施工令 §4.1）。这三条合起来意味着渲染进程里
      // **没有 Node**，因此 better-sqlite3 / koffi 只能待在主进程里。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 宠物窗口不需要 devtools 常驻，且开着他会让窗口不透明（见上 ★4）。
      devTools: !app.isPackaged,
    },
  })

  // 置顶。用 'screen-saver' 档位——比普通 'floating' 更高，
  // 否则在很多场景下会被普通置顶窗盖住。
  window.setAlwaysOnTop(true, 'screen-saver')

  // 宠物不参与"窗口管理"语义。
  window.setSkipTaskbar(true)

  // ⚠️ 刻意**不调用** `window.setIgnoreMouseEvents(true, { forward: true })`。
  // 穿透状态由 `PetWindowController` 依据光标轮询动态翻转，且从不开启 forward。
  // 理由见 core/cursorRouter.ts。

  return window
}

/** 开发期加载 dev server，打包后加载构建产物。 */
export function resolveRendererEntry(): { url?: string; file?: string } {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    return { url: devServerUrl }
  }
  return { file: join(__dirname, '../renderer/index.html') }
}

/**
 * 托盘图标路径。
 *
 * 图标是**程序化生成**的（`scripts/generate-icons.mjs`），不是手绘位图——
 * 这样它与宠物的几何定义同源：改了宠物形状，重跑脚本，图标跟着变，
 * 不会出现"图标和宠物长得不一样"的漂移。
 */
export function trayIconPath(): string {
  // 打包后 resources 被解到 process.resourcesPath 下。
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', 'tray.png')
    : join(app.getAppPath(), 'resources', 'icons', 'tray.png')
}
