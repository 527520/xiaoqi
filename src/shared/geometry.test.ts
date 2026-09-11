import { describe, expect, it } from 'vitest'

import { PET_GEOMETRY, petWindowSize } from '@shared/constants'
import {
  shouldSilence,
  describeUserNotificationState,
  hitTestPet,
  hitTestPetScreenPoint,
  pointInEllipse,
  rectContainsPoint,
  scalePetGeometry,
} from '@shared/geometry'
import type { Rect, UserNotificationState } from '@shared/types'

const GEOMETRY = PET_GEOMETRY
const BODY = GEOMETRY.body
const PET_WINDOW_SIZE = petWindowSize(1)

/**
 * 尾巴与身体的连接点（设计空间）。
 *
 * 与 `PetStage#drawTail` 里用的偏移比例一致：尾巴画成一个**从身后探出的**
 * 尖椭圆，它的圆心落在体外，被身体盖住的那一段才是"连接"。
 * 测试连通性必须用这个点，用圆心会测出一条穿过体外空间的线。
 */
const TAIL_ATTACH = { x: BODY.cx + BODY.rx * 0.78, y: BODY.cy + BODY.ry * 0.62 }

describe('几何判定', () => {
  it('椭圆包含中心点', () => {
    expect(pointInEllipse({ x: BODY.cx, y: BODY.cy }, BODY)).toBe(true)
  })

  it('椭圆排除外部点', () => {
    expect(pointInEllipse({ x: BODY.cx + BODY.rx + 1, y: BODY.cy }, BODY)).toBe(false)
    expect(pointInEllipse({ x: BODY.cx, y: BODY.cy + BODY.ry + 1 }, BODY)).toBe(false)
  })

  it('椭圆边界算命中（含边界，避免边缘出现"点不到的一像素缝"）', () => {
    expect(pointInEllipse({ x: BODY.cx + BODY.rx, y: BODY.cy }, BODY)).toBe(true)
  })

  it('半径为 0 的椭圆不命中任何点（防止退化几何悄悄吞掉整个屏幕）', () => {
    expect(pointInEllipse({ x: 0, y: 0 }, { cx: 0, cy: 0, rx: 0, ry: 0 })).toBe(false)
  })
})

describe('宠物命中测试', () => {
  it('身体中心命中', () => {
    expect(hitTestPet(GEOMETRY, { x: BODY.cx, y: BODY.cy })).toBe(true)
  })

  it('双耳命中', () => {
    expect(hitTestPet(GEOMETRY, { x: GEOMETRY.earLeft.cx, y: GEOMETRY.earLeft.cy })).toBe(true)
    expect(hitTestPet(GEOMETRY, { x: GEOMETRY.earRight.cx, y: GEOMETRY.earRight.cy })).toBe(true)
  })

  it('尾巴命中（尾巴是独立的一团，必须自己撑起命中区）', () => {
    expect(hitTestPet(GEOMETRY, { x: GEOMETRY.tailTip.cx, y: GEOMETRY.tailTip.cy })).toBe(true)
  })

  it('窗口四角必须**不**命中 —— 那是透明留白，必须穿透', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: PET_WINDOW_SIZE.width - 1, y: 0 },
      { x: 0, y: PET_WINDOW_SIZE.height - 1 },
      { x: PET_WINDOW_SIZE.width - 1, y: PET_WINDOW_SIZE.height - 1 },
    ]
    for (const corner of corners) {
      expect(hitTestPet(GEOMETRY, corner)).toBe(false)
    }
  })

  it('身体与耳朵之间没有缝隙（轮廓必须是连通的）', () => {
    // 从耳朵中心到身体中心连一条线，采样路径上不应出现"空档"。
    const from = GEOMETRY.earLeft
    const steps = 60
    let gaps = 0
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = from.cx + (BODY.cx - from.cx) * t
      const y = from.cy + (BODY.cy - from.cy) * t
      if (!hitTestPet(GEOMETRY, { x, y })) gaps++
    }
    expect(gaps).toBe(0)
  })

  it('身体与尾巴之间没有缝隙（施工令 §4.3③：必须是单一连通轮廓）', () => {
    // ⚠️ 起点不能用 `tailTip` 的**圆心**：尾巴的圆心刻意落在身体轮廓之外
    //    （否则它会与身体糊成一片、被读成"鳍"，实测过），
    //    所以"圆心 → 身体中心"这条线本来就会经过一段体外空间。
    //    要测连通性，得从尾巴**实际的连接点**出发——也就是它探出身体的那一处。
    const from = TAIL_ATTACH
    const steps = 60
    let gaps = 0
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = from.x + (BODY.cx - from.x) * t
      const y = from.y + (BODY.cy - from.y) * t
      if (!hitTestPet(GEOMETRY, { x, y })) gaps++
    }
    expect(gaps).toBe(0)
  })

  it('尾巴的连接点在身体轮廓内（"长出来"而不是"飘着"）', () => {
    // 这条是上一条的前提：连接点本身必须被身体覆盖，否则尾巴看起来是浮空的。
    expect(hitTestPet(GEOMETRY, TAIL_ATTACH)).toBe(true)
  })

  it('屏幕坐标翻译正确（窗口原点参与计算）', () => {
    const origin = { x: 1000, y: 500 }
    // 窗口局部 (BODY.cx, BODY.cy) → 屏幕坐标
    expect(hitTestPetScreenPoint(GEOMETRY, origin, { x: 1000 + BODY.cx, y: 500 + BODY.cy })).toBe(
      true,
    )
    // 偏移出身体 → 不命中
    expect(
      hitTestPetScreenPoint(GEOMETRY, origin, {
        x: 1000 + BODY.cx + BODY.rx + 5,
        y: 500 + BODY.cy + BODY.ry + 5,
      }),
    ).toBe(false)
  })
})

describe('缩放（宠物可放大缩小之后的回归）', () => {
  it('scalePetGeometry 等比缩放全部几何', () => {
    const g = scalePetGeometry(GEOMETRY, 2)
    expect(g.body.cx).toBeCloseTo(BODY.cx * 2)
    expect(g.body.rx).toBeCloseTo(BODY.rx * 2)
    expect(g.earLeft.r).toBeCloseTo(GEOMETRY.earLeft.r * 2)
    expect(g.tailTip.r).toBeCloseTo(GEOMETRY.tailTip.r * 2)
    expect(g.window.width).toBeCloseTo(GEOMETRY.window.width * 2)
  })

  it('scale = 1 时与原几何完全一致（不引入浮点漂移）', () => {
    const g = scalePetGeometry(GEOMETRY, 1)
    expect(g.body).toEqual(BODY)
    expect(g.earLeft).toEqual(GEOMETRY.earLeft)
  })

  // ★ 这一组是本次改动的核心回归。
  //   漏掉缩放换算的后果非常具体：宠物放大后**只有左上角那一小块能点**，
  //   其余部分点不到 —— 正是 openai/codex #34227 记录的现象。
  it('★ 放大后，宠物放大后的身体上仍然命中（不能只有左上角能点）', () => {
    const scale = 2
    const origin = { x: 0, y: 0 }
    // ⚠️ 这里的取样点必须随几何更新——写死具体数字会在改形状后
    //    "测试失败但实现是对的"，反过来也会掩盖真问题。
    //    因此按当前几何算一个**确定落在身体内**的点。
    const point = { x: (BODY.cx + BODY.rx * 0.5) * scale, y: (BODY.cy + BODY.ry * 0.5) * scale }
    expect(hitTestPetScreenPoint(GEOMETRY, origin, point, scale)).toBe(true)
  })

  it('★ 放大后，落在"放大前窗口之外"的点也能命中（证明判定真的换了尺度）', () => {
    // 选点的讲究：这个点必须在**缩放 1 的窗口之外**，否则用例无法区分
    // "乘了缩放"与"没乘缩放"——两者都可能命中。
    // 取身体右上方向、但位于设计窗口之外的一处。
    const point = { x: (BODY.cx + BODY.rx * 0.4) * 2, y: (BODY.cy - BODY.ry * 0.4) * 2 }
    expect(point.x > PET_WINDOW_SIZE.width || point.y > PET_WINDOW_SIZE.height).toBe(true)
    expect(hitTestPetScreenPoint(GEOMETRY, { x: 0, y: 0 }, point, 2)).toBe(true)
    expect(hitTestPetScreenPoint(GEOMETRY, { x: 0, y: 0 }, point, 1)).toBe(false)
  })

  it('缩小后，同一边界坐标落到轮廓之外（边界随缩放移动）', () => {
    // 按当前几何取一个**恰在身体右缘**的点，而不是写死旧数字（110+57）。
    const edge = { x: BODY.cx + BODY.rx, y: BODY.cy }
    expect(hitTestPetScreenPoint(GEOMETRY, { x: 0, y: 0 }, edge, 1)).toBe(true)
    // 缩到 0.5 后，同一屏幕坐标已远在轮廓之外
    expect(hitTestPetScreenPoint(GEOMETRY, { x: 0, y: 0 }, edge, 0.5)).toBe(false)
  })

  it('任意缩放下，窗口四角都是留白（不能因为缩放把留白吞掉）', () => {
    for (const scale of [0.75, 1, 1.25, 1.5, 2]) {
      const size = petWindowSize(scale)
      const corners = [
        { x: 1, y: 1 },
        { x: size.width - 1, y: 1 },
        { x: 1, y: size.height - 1 },
        { x: size.width - 1, y: size.height - 1 },
      ]
      for (const corner of corners) {
        expect(hitTestPetScreenPoint(GEOMETRY, { x: 0, y: 0 }, corner, scale)).toBe(false)
      }
    }
  })

  it('petWindowSize 按缩放给出窗口尺寸，且与设计尺寸成比例', () => {
    expect(petWindowSize(1)).toEqual({ width: 220, height: 220 })
    expect(petWindowSize(2)).toEqual({ width: 440, height: 440 })
    expect(petWindowSize(0.75)).toEqual({ width: 165, height: 165 })
  })
})

describe('QUNS → 静默判定', () => {
  it('{1,2,3,4} 一律视为需要静默（锁屏/全屏/独占全屏/演示）', () => {
    for (const state of [1, 2, 3, 4] as const) {
      expect(shouldSilence(state)).toBe(true)
    }
  })

  it('5 正常可打扰、6 系统安静时段、7 应用模式，都不由这里静默', () => {
    expect(shouldSilence(5)).toBe(false)
    expect(shouldSilence(6)).toBe(false)
    expect(shouldSilence(7)).toBe(false)
  })

  it('0（调用失败/未知）**不**静默 —— 刻意的不对称', () => {
    // 若把"调用失败"当成静默，一次原生调用抖动就会让宠物永久缩成小点，
    // 而用户完全不知道为什么。反过来只是多存在一会儿，代价小得多。
    expect(shouldSilence(0)).toBe(false)
  })

  it('每个取值都有可读描述（避免日志里出现 undefined）', () => {
    for (const state of [0, 1, 2, 3, 4, 5, 6, 7] as UserNotificationState[]) {
      const text = describeUserNotificationState(state)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toContain('undefined')
    }
  })
})

describe('矩形包含判定', () => {
  const rect: Rect = { x: 10, y: 20, width: 100, height: 50 }

  it('内部点命中', () => {
    expect(rectContainsPoint(rect, { x: 50, y: 40 })).toBe(true)
  })

  it('外部点不命中', () => {
    expect(rectContainsPoint(rect, { x: 9, y: 40 })).toBe(false)
    expect(rectContainsPoint(rect, { x: 50, y: 71 })).toBe(false)
  })

  it('边界点命中', () => {
    expect(rectContainsPoint(rect, { x: 10, y: 20 })).toBe(true)
    expect(rectContainsPoint(rect, { x: 110, y: 70 })).toBe(true)
  })
})
