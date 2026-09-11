import { describe, expect, it } from 'vitest'

import { PET_GEOMETRY, PET_WINDOW_SIZE } from '@shared/constants'
import {
  shouldSilence,
  describeUserNotificationState,
  hitTestPet,
  hitTestPetScreenPoint,
  pointInEllipse,
  rectContainsPoint,
} from '@shared/geometry'
import type { Rect, UserNotificationState } from '@shared/types'

const GEOMETRY = PET_GEOMETRY
const BODY = GEOMETRY.body

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
    const from = GEOMETRY.tailTip
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
