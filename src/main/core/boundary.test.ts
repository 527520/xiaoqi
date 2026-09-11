import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
/** 本文件就位于 `src/main/core/`，所以 core 目录就是它所在目录本身。 */
const coreDir = here
/** 仓库根：src/main/core → 需要上溯三级。 */
const repoRoot = join(here, '..', '..', '..')

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 守卫「内核可在纯 Node 下单测」这条架构铁律。
 *
 * ── 为什么需要这个测试 ──
 *
 * 施工令 §4.4 规定：`core/` 下任何文件都不得 `import` Electron，
 * 也不得 `require('koffi')`。这条铁律的价值在于内核能在**纯 Node** 下跑测试。
 *
 * 但它**破防时不会报错**——今天有人在 `core/` 里 `import { screen } from 'electron'`，
 * 测试仍然跑得起来（因为 electron 装了），只是从此所有内核测试都要拖起
 * 一整个 Electron 运行时。等到发现问题时，内核已经没法单测了。
 *
 * 所以这里用文本断言把它钉死。`no-restricted-imports` 那条 eslint 规则
 * 也能拦 koffi（但拦不了 electron，因为平台层自己要用 electron），
 * 这个测试是两条防线里覆盖更完整的那个。
 */
describe('core/ 的纯净性边界（施工令 §4.4 铁律）', () => {
  const files = collectTsFiles(coreDir)

  it('core/ 下确实有文件被检查（防止这个测试因为改目录而静默失效）', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('core/ 下任何文件都不 import electron', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      // 匹配 `from 'electron'` / `require('electron')` / `from "electron"`
      if (/(?:from|require\s*\()\s*['"]electron['"]/.test(source)) {
        offenders.push(relative(repoRoot, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('core/ 下任何文件都不 import koffi', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (/(?:from|require\s*\()\s*['"]koffi['"]/.test(source)) {
        offenders.push(relative(repoRoot, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('只有 platform/win32.ts 加载 koffi（原生调用面必须收在一个文件里）', () => {
    const mainDir = join(here)
    const offenders: string[] = []
    for (const file of collectTsFiles(mainDir)) {
      const rel = relative(repoRoot, file).replace(/\\/g, '/')
      if (rel.endsWith('platform/win32.ts')) continue
      const source = readFileSync(file, 'utf8')
      if (/(?:from|require\s*\()\s*['"]koffi['"]/.test(source)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
