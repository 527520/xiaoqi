/**
 * 加载渲染探针页的窗口。
 *
 * ── 为什么参数与宠物窗口**逐条对齐** ──
 *
 * 这个探针要回答的是"Mesh + 自定义 GLSL 在**宠物窗口那种条件下**能否工作"。
 * 若窗口参数不同（比如开了 `resizable`、或者背景不透明），
 * 它验证的就是另一件事，结论不能外推。
 *
 * 所以：`frame: false` + `transparent: true` + `#00000000` + 不设 `resizable`
 * + `skipTaskbar` + 置顶，与 `createPetWindow` 一致。
 */

import { join } from 'node:path'

import { BrowserWindow, app } from 'electron'

/** 与宠物同尺寸、同透明约定，但内容是一个自检页面。 */
export function createProbeWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 220,
    height: 220,
    // ★ 与宠物窗口一致的四条透明约定。
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 刻意不写 resizable —— 默认 false，与宠物窗口一致。
    skipTaskbar: true,
    show: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  return window
}

/**
 * 探针页入口（与宠物/账本同一套 dev-server 约定）。
 *
 * ⚠️ 查询参数必须**分开返回**，不能拼进文件路径。
 *    `XIAOQI_MESH_PROBE` 的值用来切换探针模式（`1` = 光照对照实验、
 *    `variants` = Mesh 变换语义实验）。第一版把它拼成了
 *    `mesh.html?variants` 交给 `loadFile`，于是 `?` 被百分号编码进文件名，
 *    实际请求的是 `mesh.html%3Fvariants` —— Electron 报 `ERR_FILE_NOT_FOUND`，
 *    页面全白，而脚本只看到"探针页没起来"。
 *    `loadFile` 有专门的 `query` 选项，走它才对。
 */
export function resolveProbeEntry(): {
  url?: string
  file?: string
  /** 传给 `loadFile` 的 `query`（Electron 要求是 `Record<string,string>`）。 */
  query?: Record<string, string>
} {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const mode = process.env.XIAOQI_MESH_PROBE ?? '1'
  const hasMode = mode !== '1'

  if (!app.isPackaged && devServerUrl) {
    return { url: new URL(`mesh.html${hasMode ? `?${mode}` : ''}`, devServerUrl).toString() }
  }
  return {
    file: join(__dirname, '../renderer/mesh.html'),
    // 页面侧用 `URLSearchParams.has('variants')` 判断模式，
    // 所以这里给一个空值即可（`?variants=`）。
    ...(hasMode ? { query: { [mode]: '' } } : {}),
  }
}
