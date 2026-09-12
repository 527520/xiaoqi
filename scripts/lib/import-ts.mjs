/**
 * 把仓库里的 TS 模块**当 ESM 导入**，供 Node 侧的验证脚本使用。
 *
 * ── 为什么需要它 ──
 *
 * 验证脚本跑在纯 Node 下，而真相（图集契约、蒙版编解码、命中换算）
 * 都写在 TypeScript 里。两条路可选：
 *
 *   ① 在脚本里**重新实现**一遍这些公式 —— 绝对不行。那样验证的只是
 *      "我的第二份实现与第一份一致"，而两份一起错的时候它照样通过。
 *      本项目在 `docs/RECON.md` 里记过头号 bug 来源就是这种脱节。
 *   ② 把真源码打包后 import —— 就是这里做的事。
 *
 * ── 为什么必须**打包**，而不是把单文件转译结果塞进 data: URL ──
 *
 * `vite.transformRequest()` 只转译**单个文件**，里面的 import 原样保留，
 * 且会被重写成 `/src/shared/petAtlas.ts` 这类 Vite 内部路径。塞进
 * `data:text/javascript;base64,...` 之后，Node 会拿那个 data URL 当基准
 * 去解析这些路径，结果是 `ERR_UNSUPPORTED_RESOLVE_REQUEST`
 * （"Invalid relative URL or base scheme is not hierarchical"）——
 * 报错信息完全看不出真正的原因。（踩过一次。）
 *
 * `generate-test-atlas.mjs` 用的是单文件转译那条老路，它能工作只是因为
 * 它只 import 了一个**不 import 任何东西**的叶子模块。新脚本请用这个工具。
 *
 * ── 为什么用 Vite 的 build 而不是直接 import esbuild ──
 *
 * esbuild 在本仓库里**不是直接依赖**（只有 Vite 内部那一份，pnpm 不会
 * 把它提升到 `node_modules` 根），`import 'esbuild'` 会
 * `ERR_MODULE_NOT_FOUND`。Vite 的 `build()`（Rollup 驱动）是现成的、
 * 已经装好的，而且顺带处理 `@shared` / `@main` / `@renderer` 别名。
 */

import { Buffer } from 'node:buffer'
import { join } from 'node:path'

import { build } from 'vite'

const repoRoot = process.cwd()

/**
 * 打包并导入若干个入口模块。
 *
 * @param entries `{ 名字: '/src/....ts' }`
 * @returns 与 `entries` 同键的模块命名空间对象
 */
export async function importTsModules(entries) {
  const alias = {
    '@shared': join(repoRoot, 'src', 'shared'),
    '@main': join(repoRoot, 'src', 'main'),
    '@renderer': join(repoRoot, 'src', 'renderer', 'src'),
  }

  const out = {}
  for (const [name, entry] of Object.entries(entries)) {
    const absolute = entry.startsWith('/') ? join(repoRoot, entry.slice(1)) : join(repoRoot, entry)

    const result = await build({
      configFile: false,
      logLevel: 'error',
      resolve: { alias },
      build: {
        // `lib` 模式 + `write: false`：产出留在内存里，不落盘。
        lib: { entry: absolute, formats: ['es'], fileName: name },
        write: false,
        minify: false,
        // 关掉 sourcemap：我们要的是能跑的代码，不是能调试的代码
        sourcemap: false,
        // 依赖（pixi / electron / better-sqlite3 等）不进包：
        // 我们要验的是**我们自己的逻辑**，而这些模块要么在 Node 下跑不起来，
        // 要么根本不是被测对象。
        rollupOptions: {
          external: ['electron', 'pixi.js', 'better-sqlite3', 'koffi'],
        },
        // 目标降到 Node 24 一定支持的语法，避免 esbuild 针对浏览器做额外处理
        target: 'node20',
      },
    })

    const output = Array.isArray(result) ? result[0] : result
    const chunk = output?.output?.find((item) => item.type === 'chunk')
    if (!chunk || typeof chunk.code !== 'string') {
      throw new Error(`打包 ${entry} 没有产出可用的 chunk`)
    }

    const encoded = Buffer.from(chunk.code, 'utf8').toString('base64')
    out[name] = await import(`data:text/javascript;base64,${encoded}`)
  }
  return out
}
