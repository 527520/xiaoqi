import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import type { Point } from '@shared/types'

/**
 * 宠物位置的持久化。
 *
 * ── 为什么单独一个文件、而不是塞进将来的 `config.json` ──
 *
 * 位置是**高频变更的运行时状态**（每次拖完就写），而 `config.json`
 * 是用户改的**养成参数**（性格、话术、技能）。两者混在一起会有两个问题：
 * ① 用户手改 `config.json` 时容易被程序回写覆盖；
 * ② 将来做"导出/导入养成配置"时，会把屏幕坐标这种机器相关的数据带出去。
 *
 * 所以分开存：`window-state.json` 只放窗口相关的机器状态。
 *
 * ── 失败一律静默降级 ──
 *
 * 读写失败（磁盘满、权限、JSON 坏了）**不能影响宠物运行**——
 * 最坏的结果只是"这次没记住位置"，而不是"宠物起不来"。
 * 所以这里所有错误都被吞掉并返回 null / 无操作。
 */

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

interface WindowState {
  readonly position?: Point
  readonly scale?: number
}

/** 读取保存的状态；任何异常都返回空对象。 */
export function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}

    const state = parsed as { position?: unknown; scale?: unknown }
    const result: { position?: Point; scale?: number } = {}

    const pos = state.position as { x?: unknown; y?: unknown } | undefined
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      // 只接受有限数值：JSON 里可能有 null / NaN 序列化后的怪值。
      if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        result.position = { x: pos.x, y: pos.y }
      }
    }

    if (typeof state.scale === 'number' && Number.isFinite(state.scale) && state.scale > 0) {
      result.scale = state.scale
    }

    return result
  } catch {
    // 首次启动没有这个文件是**正常情况**，不是错误；
    // JSON 损坏也只是"这次没记住"，不该打断启动。
    return {}
  }
}

/** 保存位置。失败静默（最坏只是没记住）。 */
export function savePosition(position: Point): void {
  save({ position })
}

/** 保存缩放。 */
export function saveScale(scale: number): void {
  save({ scale })
}

function save(patch: WindowState): void {
  try {
    // 读-改-写：只覆盖要改的字段，避免"存位置时把缩放抹了"。
    const current = loadWindowState()
    const next: WindowState = { ...current, ...patch }
    writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // 磁盘满 / 权限 / 路径异常。位置记不住不是致命问题。
  }
}
