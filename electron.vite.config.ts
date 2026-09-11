import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite 三段式构建：main / preload / renderer。
 *
 * - main / preload 走 `externalizeDepsPlugin()`：`koffi` 这类原生模块必须保持 external，
 *   否则 rollup 会试图把它打进 bundle，而 `.node` 二进制无法被 bundle。
 * - renderer 是纯 web 构建，入口在 `src/renderer/index.html`。
 *
 * 注意：main 的产物是 CommonJS（electron-vite 默认）。这是刻意的——
 * Electron 的 ESM 主进程支持对原生 CJS 依赖（koffi）仍有摩擦，CJS 是稳妥选择。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // ★ preload **必须是 CommonJS**。
        //
        // 根 package.json 是 `"type": "module"`，electron-vite 因此默认把
        // preload 产成 `index.mjs`（ESM）。但渲染进程是 `sandbox: true` 的，
        // 而**沙箱化的 preload 不支持 ESM**——后果是 preload 静默不执行，
        // `window.xiaoqi` 不存在，渲染进程第一句就用它，于是抛错的地方
        // 看起来与 preload 毫无关系，表象只是"宠物渲染不出来"。
        //
        // 所以这里显式把 preload 钉成 cjs，用 `.cjs` 扩展名
        // （在 `"type": "module"` 的项目里 `.cjs` 被无条件当作 CommonJS）。
        // 对应路径写在 src/main/index.ts 的 bootstrap() 里，两处必须一致。
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
})
