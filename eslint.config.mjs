import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const rootDir = dirname(fileURLToPath(import.meta.url))

const MAIN_INDEX = join('src', 'main', 'index.ts')

/**
 * 施工令 §4.3①：disable-features 是覆盖而非合并，且必须在主脚本顶层。
 *
 * 这条断言检查"只出现一次"与"出现在 app.whenReady 之前"这两件事——
 * 因为两种写错方式都**不会报错**，只会让宠物在全屏应用下变空白：
 * 调两次只剩最后一次生效；放进异步回调则 FeatureList 早已初始化完毕。
 *
 * 这是个"文件级"检查，所以挂在一个只跑一次的 Program 访问器上，
 * 并且只对 src/main/index.ts 生效。
 */
function createDisableFeaturesRule(context) {
  return {
    Program(node) {
      const filename = context.filename ?? context.getFilename?.() ?? ''
      if (!filename.replace(/\\/g, '/').endsWith(MAIN_INDEX.replace(/\\/g, '/'))) return

      const text = context.sourceCode.getText()
      // 只在**真实代码**里找调用：注释里会大量提到 `disable-features`
      // （这个文件本身就是靠注释解释为什么不能调两次的），
      // 用裸正则匹配全文会把注释也算进去，规则自己就会误报。
      const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

      const calls = [...codeOnly.matchAll(/appendSwitch\(\s*['"]disable-features['"]/g)]

      if (calls.length !== 1) {
        context.report({
          node,
          message: `src/main/index.ts 必须恰好调用一次 appendSwitch('disable-features', ...)，当前 ${calls.length} 次。多次调用会互相覆盖，只有最后一次生效（施工令 §4.3①）。`,
        })
        return
      }

      const callAt = codeOnly.indexOf(calls[0][0])
      const readyAt = codeOnly.search(/app\.whenReady\s*\(/)
      if (readyAt !== -1 && callAt > readyAt) {
        context.report({
          node,
          message:
            "appendSwitch('disable-features', ...) 出现在 app.whenReady() 之后。Electron 只在主脚本执行完后才重新初始化 FeatureList，放在异步回调里太晚（施工令 §4.3①）。",
        })
      }
    },
  }
}

const architectureGuards = {
  rules: {
    'disable-features-invariants': {
      meta: {
        type: 'problem',
        docs: { description: '守卫 disable-features 的单次顶层调用' },
      },
      create: createDisableFeaturesRule,
    },
  },
}

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'verify/**',
      'coverage/**',
      // 开发期诊断产物：探针 bundle 与临时页面都是生成物，不是源码。
      'docs/evidence/**',
      // 供验证脚本调用的小工具是 CommonJS（`.cjs`），
      // 它靠 `ELECTRON_RUN_AS_NODE` 跑在纯 Node 下，不属于任何 tsconfig，
      // 因此类型感知的 lint 无法解析它。
      'scripts/cursor-tool.cjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
    },
    plugins: { xiaoqi: architectureGuards },
    rules: {
      'xiaoqi/disable-features-invariants': 'error',

      // 内核与平台层都要求显式类型，禁止隐式 any 漏网。
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // 原生调用集中在 platform/win32.ts —— 用 no-restricted-imports 在 lint 层封死。
      // 这是 §1.1 硬约束里"原生调用只允许出现在一个文件里"的自动化保障。
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'koffi',
              message:
                'koffi 只允许在 src/main/platform/win32.ts 中引入（施工令 §4.4 铁律）。其他文件请通过 platform 抽象层调用。',
            },
          ],
        },
      ],

      'no-console': 'off',
    },
  },

  // 电子主进程 / preload：Node 环境
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.mjs', '*.ts', '*.mjs'],
    languageOptions: { globals: globals.node },
  },

  // scripts/ 下的取证脚本：豁免"导出函数必须显式写类型"。
  //
  // 为什么豁免：这些是 `.mjs`，没有类型语法可用，只能写 JSDoc；
  // 而 `explicit-module-boundary-types` **不读 JSDoc**（实测：JSDoc 已按
  // 规范写全，7 条报错一条不少）。于是这条规则对 `.mjs` 只有两个结局——
  // 报一堆改不掉的错，或者逼人把有用的脚本改成 `.ts`。
  // 两者都不划算，所以在**这个文件范围内**关掉它。
  // ⚠️ 范围刻意收窄到 `scripts/**/*.mjs`：`src/` 下的 TS 一行都不放松，
  //    那里才是"禁止隐式 any 漏网"真正要守住的地方。
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // 渲染进程：浏览器环境 + React
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // 唯一允许加载 koffi 的文件
  {
    files: ['src/main/platform/win32.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // 测试文件：允许更松的类型写法
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // 配置文件本身用非类型感知规则集，避免 parserOptions.projectService 找不到它们
  {
    files: ['**/*.mjs', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
)
