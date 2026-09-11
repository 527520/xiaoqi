import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * 单元测试针对 `src/main/core/**`（纯 TS 内核）、`src/main/platform/**` 与 `src/shared/**`。
 *
 * `core/` 是刻意做成零 Electron 依赖的：它不得 import electron，
 * 也不得 require koffi，因此可以在纯 Node 下直接跑测试。
 * 有一个测试专门断言这条边界（见 `src/main/core/boundary.test.ts`），
 * 因为"纯 TS 可单测"一旦破防就是静默失效——代码照样跑得起来，
 * 只是内核从此再也无法脱离 Electron 测试。
 *
 * ⚠️ 别名必须与 tsconfig.node.json / tsconfig.web.json 的 `paths` 保持一致，
 * 否则会出现"类型检查通过、测试却解析不到模块"这种半坏状态。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 不允许 skip：施工令 §7 明确禁止用 test.skip / it.only "通过"测试。
    allowOnly: false,
    passWithNoTests: false,
    reporters: ['default'],
  },
})
