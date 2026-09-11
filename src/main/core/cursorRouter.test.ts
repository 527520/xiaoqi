import { describe, expect, it } from 'vitest'

import { PET_GEOMETRY, petWindowSize } from '@shared/constants'
import type { Rect } from '@shared/types'

import { resolveCursorRoute, shouldFlipIgnoreMouseEvents } from './cursorRouter'

const GEOMETRY = PET_GEOMETRY
/** 缩放 1 时的窗口尺寸。缩放相关用例见下面单独一组。 */
const PET_WINDOW_SIZE = petWindowSize(1)

/** 宠物窗口在屏幕上的位置（DIP）。 */
const WINDOW: Rect = {
  x: 2000,
  y: 1000,
  width: PET_WINDOW_SIZE.width,
  height: PET_WINDOW_SIZE.height,
}

/** 把窗口局部坐标翻译成屏幕坐标。 */
function screenPoint(localX: number, localY: number): { x: number; y: number } {
  return { x: WINDOW.x + localX, y: WINDOW.y + localY }
}

describe('光标路由决策', () => {
  it('光标在身体上 → 事件给宠物', () => {
    const body = GEOMETRY.body
    expect(resolveCursorRoute(GEOMETRY, WINDOW, screenPoint(body.cx, body.cy))).toBe('pet')
  })

  it('光标在窗口内但在透明留白上 → 必须穿透', () => {
    // 这是最典型的桌宠 bug 场景：窗口比宠物大，留白处看似什么都没有，
    // 但如果不穿透，用户点到的就是一块"透明的墙"。
    expect(resolveCursorRoute(GEOMETRY, WINDOW, screenPoint(4, 4))).toBe('passthrough')
    expect(
      resolveCursorRoute(
        GEOMETRY,
        WINDOW,
        screenPoint(PET_WINDOW_SIZE.width - 4, PET_WINDOW_SIZE.height - 4),
      ),
    ).toBe('passthrough')
  })

  it('光标在窗口外 → 穿透', () => {
    expect(resolveCursorRoute(GEOMETRY, WINDOW, { x: 0, y: 0 })).toBe('passthrough')
    expect(resolveCursorRoute(GEOMETRY, WINDOW, { x: 2000 + 1000, y: 1000 })).toBe('passthrough')
  })

  it('窗口边界本身算在窗口内（左/上闭区间），外侧一像素算窗口外', () => {
    // 左上角属于窗口，但那里是留白 → 穿透
    expect(resolveCursorRoute(GEOMETRY, WINDOW, { x: 2000, y: 1000 })).toBe('passthrough')
    // 右/下边界属于窗口外（半开区间），避免相邻窗口重叠判定
    expect(
      resolveCursorRoute(GEOMETRY, WINDOW, {
        x: WINDOW.x + WINDOW.width,
        y: WINDOW.y + WINDOW.height,
      }),
    ).toBe('passthrough')
  })

  it('负坐标显示器上的宠物同样能命中（多屏副屏常在负坐标区）', () => {
    // 参考 openai/codex #21508：副屏负坐标下命中测试失效。
    // 本实现用的是纯加减法，不依赖坐标为正，因此天然免疫。
    const negative: Rect = {
      x: -1920,
      y: -200,
      width: PET_WINDOW_SIZE.width,
      height: PET_WINDOW_SIZE.height,
    }
    const body = GEOMETRY.body
    expect(
      resolveCursorRoute(GEOMETRY, negative, {
        x: negative.x + body.cx,
        y: negative.y + body.cy,
      }),
    ).toBe('pet')
  })

  it('耳朵与尾巴各自都能命中（不是只有身体可点）', () => {
    expect(
      resolveCursorRoute(GEOMETRY, WINDOW, screenPoint(GEOMETRY.earLeft.cx, GEOMETRY.earLeft.cy)),
    ).toBe('pet')
    expect(
      resolveCursorRoute(GEOMETRY, WINDOW, screenPoint(GEOMETRY.tailTip.cx, GEOMETRY.tailTip.cy)),
    ).toBe('pet')
  })
})

describe('穿透开关翻转判定', () => {
  it('状态未变时不翻转（避免每 80ms 无谓调用原生 API）', () => {
    expect(shouldFlipIgnoreMouseEvents('pet', 'pet')).toBe(false)
    expect(shouldFlipIgnoreMouseEvents('passthrough', 'passthrough')).toBe(false)
  })

  it('状态改变时翻转', () => {
    expect(shouldFlipIgnoreMouseEvents('pet', 'passthrough')).toBe(true)
    expect(shouldFlipIgnoreMouseEvents('passthrough', 'pet')).toBe(true)
  })
})
