import { describe, expect, it } from 'vitest'

import type { RelationshipMood } from '@shared/types'

import {
  BLINK_DURATION_SECONDS,
  blinkIntervalSeconds,
  bounceEnvelope,
  breathPose,
  earSecondarySway,
  eyeOpenness,
  gazeOffset,
  moodAnimation,
  REACTION_DURATION_SECONDS,
  swayAngle,
  tailSway,
} from './animation'

describe('眼睛张开度（一个真实踩过的 bug 的回归测试）', () => {
  it('不眨眼时完全睁开', () => {
    expect(eyeOpenness(0, BLINK_DURATION_SECONDS)).toBe(1)
    expect(eyeOpenness(-1, BLINK_DURATION_SECONDS)).toBe(1)
  })

  it('眨眼中点闭合到最小', () => {
    expect(eyeOpenness(BLINK_DURATION_SECONDS / 2, BLINK_DURATION_SECONDS)).toBeCloseTo(0.1, 5)
  })

  it('★ 眨眼的**起点与终点**必须是完全睁开的', () => {
    // 这是最初那个 bug 的核心：旧实现只要 `blink > 0` 就把眼睛压扁，
    // 于是整个眨眼时长内眼睛几乎都是闭的，宠物看起来**没有眼睛**。
    // 正确的曲线是三角形：只在中间闭合，两端睁开。
    expect(eyeOpenness(BLINK_DURATION_SECONDS, BLINK_DURATION_SECONDS)).toBeCloseTo(1, 5)
    expect(eyeOpenness(0.0001, BLINK_DURATION_SECONDS)).toBeGreaterThan(0.99)
  })

  it('★ 眨眼过程中"接近闭合"的时间占比必须很小', () => {
    // 断言"绝大多数采样点眼睛是明显睁开的"。
    // 这条比逐点断言更能锁住"形状是对的"这件事。
    const samples = 100
    let nearlyClosed = 0
    for (let i = 0; i <= samples; i++) {
      const remaining = (i / samples) * BLINK_DURATION_SECONDS
      if (eyeOpenness(remaining, BLINK_DURATION_SECONDS) < 0.3) nearlyClosed++
    }
    // 三角形曲线下，低于 0.3 的区间约占 30%，取宽松上界 40%
    expect(nearlyClosed / (samples + 1)).toBeLessThan(0.4)
  })

  it('张开度永远落在 [0.08, 1]，不会变成负数或超过 1', () => {
    for (let i = -5; i <= 105; i++) {
      const remaining = (i / 100) * BLINK_DURATION_SECONDS
      const value = eyeOpenness(remaining, BLINK_DURATION_SECONDS)
      expect(value).toBeGreaterThanOrEqual(0.08)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('时长非法时不崩、按完全睁开处理', () => {
    expect(eyeOpenness(0.05, 0)).toBe(1)
    expect(eyeOpenness(0.05, -1)).toBe(1)
  })

  it('剩余时长超过总时长也被夹住（不会算出负的 progress）', () => {
    const value = eyeOpenness(BLINK_DURATION_SECONDS * 3, BLINK_DURATION_SECONDS)
    expect(value).toBeGreaterThanOrEqual(0.08)
    expect(value).toBeLessThanOrEqual(1)
  })
})

describe('呼吸姿态', () => {
  it('幅度很小 —— 大了就变成"喘"', () => {
    for (let i = 0; i < 50; i++) {
      const pose = breathPose(i * 0.13)
      expect(Math.abs(pose.squash)).toBeLessThanOrEqual(0.04)
      expect(Math.abs(pose.stretch)).toBeLessThanOrEqual(0.04)
      expect(Math.abs(pose.offsetY)).toBeLessThanOrEqual(2)
    }
  })

  it('横向与纵向形变方向相反（体积守恒感）', () => {
    const pose = breathPose(0.65) // sin 接近 1
    expect(Math.sign(pose.squash)).toBe(-Math.sign(pose.stretch))
  })

  it('是周期函数，且不会累积漂移', () => {
    const a = breathPose(0, 2.6)
    const b = breathPose(2.6, 2.6)
    expect(a.breath).toBeCloseTo(b.breath, 6)
  })

  it('取值恒在 [-1, 1]', () => {
    for (let i = 0; i < 200; i++) {
      const { breath } = breathPose(i * 0.07)
      expect(breath).toBeGreaterThanOrEqual(-1.0000001)
      expect(breath).toBeLessThanOrEqual(1.0000001)
    }
  })
})

describe('摇摆', () => {
  it('幅度很小（否则宠物会像在晃脑袋）', () => {
    for (let i = 0; i < 100; i++) {
      expect(Math.abs(swayAngle(i * 0.11))).toBeLessThanOrEqual(0.013)
    }
  })

  it('在 t=0 时为零（静止起步，不会突然跳一下）', () => {
    expect(swayAngle(0)).toBe(0)
  })
})

describe('次级动作（"有质感"的关键）', () => {
  it('耳朵相位**滞后于身体**——同相位会读成"整块图在转"', () => {
    // 在 t 时刻，身体摇摆的相位是 t，耳朵用的是 t - 滞后。
    // 判据：同一时刻两者不应相等（否则就没有次级动作）。
    const t = 0.4
    expect(earSecondarySway(t)).not.toBeCloseTo(swayAngle(t), 4)
  })

  it('耳朵摆幅大于身体（带动关系才看得出来）', () => {
    let maxEar = 0
    let maxBody = 0
    for (let i = 0; i < 200; i++) {
      const t = i * 0.05
      maxEar = Math.max(maxEar, Math.abs(earSecondarySway(t)))
      maxBody = Math.max(maxBody, Math.abs(swayAngle(t)))
    }
    expect(maxEar).toBeGreaterThan(maxBody)
  })

  it('尾巴摆幅明显大于耳朵（尾巴是独立的一根，它自己会甩）', () => {
    let maxTail = 0
    let maxEar = 0
    for (let i = 0; i < 200; i++) {
      const t = i * 0.05
      maxTail = Math.max(maxTail, Math.abs(tailSway(t)))
      maxEar = Math.max(maxEar, Math.abs(earSecondarySway(t)))
    }
    expect(maxTail).toBeGreaterThan(maxEar)
  })

  it('尾巴摆幅有上界（不能甩成螺旋桨）', () => {
    for (let i = 0; i < 300; i++) {
      expect(Math.abs(tailSway(i * 0.03))).toBeLessThanOrEqual(0.13)
    }
  })
})

describe('被点一下的弹跳包络', () => {
  it('两端为零（起手与收尾都不跳变）', () => {
    expect(bounceEnvelope(0)).toBe(0)
    expect(bounceEnvelope(1)).toBe(0)
    expect(bounceEnvelope(-0.5)).toBe(0)
    expect(bounceEnvelope(1.5)).toBe(0)
  })

  it('中间取到接近 1 的峰值', () => {
    expect(bounceEnvelope(0.5)).toBeCloseTo(1, 5)
  })

  it('★ 非对称：前半段比后半段涨得快（"被按下去又弹回来"的重量感）', () => {
    // ⚠️ 这一条最初写错过：`sin(πp)^k` 关于峰值是**对称**的，
    //    所以我第一版的实现虽然"看起来"用了非线性曲线，
    //    仍然是对称的，这条断言立刻把它抓出来了。
    //    现在用两个不同指数的分段曲线，起手快、回落慢。
    const rise = bounceEnvelope(0.25)
    const fall = bounceEnvelope(0.75)
    expect(rise).toBeGreaterThan(fall)
  })

  it('非对称性不是偶然：多点比对都成立', () => {
    // 单点比对可能被巧合满足，这里扫一遍确认整条曲线都偏向前快后慢。
    for (const d of [0.1, 0.2, 0.3, 0.4]) {
      expect(bounceEnvelope(0.5 - d)).toBeGreaterThan(bounceEnvelope(0.5 + d))
    }
  })

  it('全程在 [0, 1]', () => {
    for (let i = 0; i <= 100; i++) {
      const v = bounceEnvelope(i / 100)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('交互动画时长是个"能感觉到但不等"的量级', () => {
    expect(REACTION_DURATION_SECONDS).toBeGreaterThan(0.4)
    expect(REACTION_DURATION_SECONDS).toBeLessThan(1.6)
  })
})

describe('视线跟随', () => {
  const eye = { x: 110, y: 136 }

  it('目标就在眼前时不偏移（否则瞳孔会乱抖）', () => {
    const g = gazeOffset(110, 136, eye.x, eye.y, 4, 150)
    expect(Math.hypot(g.x, g.y)).toBeCloseTo(0, 5)
  })

  it('★ 偏移量永远不超过上限 —— 瞳孔不能跑出眼白', () => {
    // 这是"眼睛跟着你"能成立的前提：跑出去就从可爱变成恐怖片了。
    const max = 3.6
    for (const [tx, ty] of [
      [0, 0],
      [1000, 1000],
      [-1000, 500],
      [110, -900],
      [1e6, 1e6],
    ] as const) {
      const g = gazeOffset(tx, ty, eye.x, eye.y, max, 150)
      expect(Math.hypot(g.x, g.y)).toBeLessThanOrEqual(max + 1e-9)
    }
  })

  it('方向正确：目标在右上，瞳孔就往右上偏', () => {
    const g = gazeOffset(eye.x + 400, eye.y - 400, eye.x, eye.y, 4, 150)
    expect(g.x).toBeGreaterThan(0)
    expect(g.y).toBeLessThan(0)
  })

  it('距离越远偏移越大，直到饱和（贴近时不该顶到边上）', () => {
    const near = gazeOffset(eye.x + 10, eye.y, eye.x, eye.y, 4, 150)
    const mid = gazeOffset(eye.x + 80, eye.y, eye.x, eye.y, 4, 150)
    const far = gazeOffset(eye.x + 5000, eye.y, eye.x, eye.y, 4, 150)
    expect(Math.abs(near.x)).toBeLessThan(Math.abs(mid.x))
    expect(mid.x).toBeLessThan(far.x)
    expect(far.x).toBeCloseTo(4, 5)
  })

  it('reach 非法时不崩（防除零）', () => {
    expect(gazeOffset(500, 500, eye.x, eye.y, 4, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('关系基调对动画的调制', () => {
  const MOODS: RelationshipMood[] = ['reserved', 'warm', 'attached']

  it('★ reserved 是"什么都不改"（1 倍），所以关系没建立时画面与从前一致', () => {
    const reserved = moodAnimation('reserved')
    expect(reserved.breathScale).toBe(1)
    expect(reserved.swayScale).toBe(1)
    expect(reserved.fidgetScale).toBe(1)
    expect(reserved.lean).toBe(0)
  })

  it('★ 越亲近，动作幅度越大（单调，不能出现"更亲近反而更呆"）', () => {
    const [reserved, warm, attached] = MOODS.map((m) => moodAnimation(m))
    expect(warm!.breathScale).toBeGreaterThan(reserved!.breathScale)
    expect(attached!.breathScale).toBeGreaterThan(warm!.breathScale)
    expect(warm!.swayScale).toBeGreaterThan(reserved!.swayScale)
    expect(attached!.swayScale).toBeGreaterThan(warm!.swayScale)
    expect(warm!.fidgetScale).toBeGreaterThan(reserved!.fidgetScale)
    expect(attached!.fidgetScale).toBeGreaterThan(warm!.fidgetScale)
  })

  it('★ 三种基调的参数**各不相同**（否则这个特性是白做的）', () => {
    const signatures = MOODS.map((m) => JSON.stringify(moodAnimation(m)))
    expect(new Set(signatures).size).toBe(MOODS.length)
  })

  it('★ 幅度都在"慢慢感觉到"的量级内（一次也不该超过 2 倍）', () => {
    // 关系是长期变量，表达必须含蓄。一下子变化明显会让用户以为宠物坏了。
    for (const mood of MOODS) {
      const anim = moodAnimation(mood)
      expect(anim.breathScale).toBeLessThanOrEqual(2)
      expect(anim.swayScale).toBeLessThanOrEqual(2)
      expect(anim.fidgetScale).toBeLessThanOrEqual(2)
      // 前倾角很小（弧度），2.4° 左右，不是"鞠躬"。
      expect(Math.abs(anim.lean)).toBeLessThan(0.1)
    }
  })

  it('★ 前倾方向一致：都是"往前凑"，没有一个是"往后躲"', () => {
    for (const mood of MOODS) {
      expect(moodAnimation(mood).lean).toBeGreaterThanOrEqual(0)
    }
  })

  it('未知/undefined 基调回落到 reserved（不崩、不产生 NaN）', () => {
    expect(moodAnimation(undefined)).toEqual(moodAnimation('reserved'))
    expect(moodAnimation('nonsense' as RelationshipMood)).toEqual(moodAnimation('reserved'))
  })

  it('★ 越亲近眨眼越勤（放松的信号；紧张时会盯着不动）', () => {
    const reserved = blinkIntervalSeconds('reserved')
    const warm = blinkIntervalSeconds('warm')
    const attached = blinkIntervalSeconds('attached')
    expect(warm).toBeLessThan(reserved)
    expect(attached).toBeLessThan(warm)
  })

  it('眨眼间隔都是正的（写成 0 会让它永远闭着眼——曾经踩过这个坑）', () => {
    for (const mood of MOODS) {
      expect(blinkIntervalSeconds(mood)).toBeGreaterThan(1)
    }
    expect(blinkIntervalSeconds(undefined)).toBeGreaterThan(1)
  })
})
