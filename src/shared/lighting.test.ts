import { describe, expect, it } from 'vitest'

import {
  BODY_MATERIAL,
  contactShadowAlpha,
  dot,
  EYE_MATERIAL,
  highlightNormal,
  INNER_MATERIAL,
  KEY_LIGHT,
  luminanceFactor,
  normalize,
  occlusionAt,
  shade,
  surfaceNormal,
  VIEW_DIR,
  type EllipsoidSurface,
  type Material,
  type Vec3,
} from './lighting'

/**
 * 光照模型的测试。
 *
 * ⚠️ 这里断言的是**方向性**，不是审美。
 *    "右上必须比左下亮""边缘必须比中心更亮"是可以断言的，
 *    而"看起来立不立体"不能。把可断言的那一半钉死，
 *    审美判断留给 `docs/evidence/pet-gallery.png` 的人眼比对。
 */

const SPHERE: EllipsoidSurface = { cx: 100, cy: 100, rx: 50, ry: 50 }

describe('normalize / dot', () => {
  it('归一化后长度为 1', () => {
    const n = normalize({ x: 3, y: 4, z: 12 })
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12)
  })

  it('★ 零向量返回 +z 而不是 NaN（NaN 会在着色链路里扩散）', () => {
    const n = normalize({ x: 0, y: 0, z: 0 })
    expect(Number.isFinite(n.x)).toBe(true)
    expect(n).toEqual(VIEW_DIR)
  })

  it('dot 对称', () => {
    const a: Vec3 = { x: 1, y: 2, z: 3 }
    const b: Vec3 = { x: -2, y: 0.5, z: 1 }
    expect(dot(a, b)).toBeCloseTo(dot(b, a), 12)
  })
})

describe('主光方向', () => {
  it('★ 主光在**右上方**（统一光源是"像一个物体"的前提）', () => {
    expect(KEY_LIGHT.x).toBeGreaterThan(0) // 右
    expect(KEY_LIGHT.y).toBeLessThan(0) // 上（设计空间 y 向下）
    expect(KEY_LIGHT.z).toBeGreaterThan(0) // 朝向观察者
  })

  it('已归一化', () => {
    expect(Math.hypot(KEY_LIGHT.x, KEY_LIGHT.y, KEY_LIGHT.z)).toBeCloseTo(1, 12)
  })
})

describe('surfaceNormal：平面图形如何获得球面法线', () => {
  it('中心法线正对观察者', () => {
    const n = surfaceNormal({ x: 100, y: 100 }, SPHERE)
    expect(n.x).toBeCloseTo(0, 12)
    expect(n.y).toBeCloseTo(0, 12)
    expect(n.z).toBeCloseTo(1, 12)
  })

  it('★ 越靠右，法线越朝右（这是"球面受光"的根源）', () => {
    const left = surfaceNormal({ x: 60, y: 100 }, SPHERE)
    const right = surfaceNormal({ x: 140, y: 100 }, SPHERE)
    expect(right.x).toBeGreaterThan(left.x)
    expect(left.x).toBeLessThan(0)
  })

  it('★ 越靠下，法线越朝下', () => {
    const top = surfaceNormal({ x: 100, y: 60 }, SPHERE)
    const bottom = surfaceNormal({ x: 100, y: 140 }, SPHERE)
    expect(bottom.y).toBeGreaterThan(top.y)
  })

  it('所有法线都是单位向量', () => {
    for (const point of [
      { x: 100, y: 100 },
      { x: 55, y: 100 },
      { x: 145, y: 100 },
      { x: 100, y: 55 },
      { x: 100, y: 145 },
      { x: 70, y: 70 },
      { x: 130, y: 130 },
    ]) {
      const n = surfaceNormal(point, SPHERE)
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 10)
    }
  })

  it('★ 椭圆外不产生 NaN（sqrt(负数) 会让整块区域变黑且不报错）', () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 300, y: 300 },
      { x: -50, y: 100 },
      { x: 100, y: 500 },
    ]) {
      const n = surfaceNormal(point, SPHERE)
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(Number.isFinite(n.z)).toBe(true)
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 10)
    }
  })

  it('非法参数不产生 NaN', () => {
    const n = surfaceNormal({ x: Number.NaN, y: 100 }, SPHERE)
    expect(Number.isFinite(n.z)).toBe(true)
  })
})

describe('shade：四个分量都要有正确的方向性', () => {
  it('★ 朝光源的法线漫反射最强，背光的最弱', () => {
    const toward = shade(KEY_LIGHT, BODY_MATERIAL)
    const away = shade({ x: -KEY_LIGHT.x, y: -KEY_LIGHT.y, z: -KEY_LIGHT.z }, BODY_MATERIAL)
    expect(toward.diffuse).toBeCloseTo(1, 6)
    expect(away.diffuse).toBe(0)
  })

  it('★ 漫反射有真实的**梯度**：迎光侧最亮，背光侧最暗，之间单调过渡', () => {
    // 沿椭圆水平中线采样。峰值出现在"法线对准光源"的那一点，
    // 它落在**椭圆内部偏右**，所以曲线是"先升后降"，不是全段单调。
    // （第一版按"全段单调"断言，于是必然失败——那是我的预期错了，不是模型错。）
    const xs = Array.from({ length: 41 }, (_, i) => SPHERE.cx - 48 + (96 * i) / 40)
    const values = xs.map(
      (x) => shade(surfaceNormal({ x, y: SPHERE.cy }, SPHERE), BODY_MATERIAL).diffuse,
    )

    const peakIndex = values.indexOf(Math.max(...values))
    // 峰值不在两端（否则说明采样区间没覆盖交界线）
    expect(peakIndex).toBeGreaterThan(0)
    expect(peakIndex).toBeLessThan(values.length - 1)

    // 峰值左侧单调不降，右侧单调不增
    for (let i = 1; i <= peakIndex; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!)
    }
    for (let i = peakIndex + 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]!)
    }

    // 亮暗差距要够大：左缘接近全黑，峰值接近全亮。
    // 这才是"有体积"的量化定义——平涂的话整个序列是常数。
    expect(values[0]!).toBeLessThan(0.1)
    expect(values[peakIndex]!).toBeGreaterThan(0.6)
    expect(values[values.length - 1]!).toBeGreaterThan(values[0]!)
  })

  it('★ 半球环境光：朝上比朝下亮（暗部不是死黑，且有冷暖倾向）', () => {
    // 设计空间 y 轴**向下**，所以"朝上"是 n.y < 0。
    const up = shade({ x: 0, y: -1, z: 0 }, BODY_MATERIAL)
    const down = shade({ x: 0, y: 1, z: 0 }, BODY_MATERIAL)
    expect(up.ambient).toBeGreaterThan(down.ambient)
    // 下限不能是 0：纯黑暗部会让体积感消失
    expect(down.ambient).toBeGreaterThan(0.2)
    // 上下差距要够大，否则"体积"读不出来
    expect(up.ambient - down.ambient).toBeGreaterThan(0.3)
  })

  it('★ 轮廓光在边缘最强、正对观察者时最弱', () => {
    const facing = shade({ x: 0, y: 0, z: 1 }, BODY_MATERIAL)
    const edge = shade(normalize({ x: 1, y: 0, z: 0 }), BODY_MATERIAL)
    expect(edge.rim).toBeGreaterThan(facing.rim)
    expect(facing.rim).toBeCloseTo(0, 6)
  })

  it('★ 高光出现在**镜面反射方向**，而不是光源方向', () => {
    // Blinn-Phong 的峰值在 normal == normalize(L + V)。
    // 第一版测试错把它当成 normal == L，于是断言了一个模型从不产生的值。
    const peak = shade(highlightNormal(), EYE_MATERIAL)
    expect(peak.specular).toBeGreaterThan(0.4)

    // 离峰值越远越弱
    const offPeak = shade(normalize({ x: -1, y: 0, z: 0 }), EYE_MATERIAL)
    expect(offPeak.specular).toBeLessThan(peak.specular * 0.1)
  })

  it('★ 高光**不是到处都亮**：正对观察者的中心几乎没有高光', () => {
    // 这条防的是"把高光当全局提亮"那种写法——那会让整个角色发白，
    // 表面看起来像塑料而不是有材质。
    const center = shade({ x: 0, y: 0, z: 1 }, EYE_MATERIAL)
    const peak = shade(highlightNormal(), EYE_MATERIAL)
    expect(center.specular).toBeLessThan(peak.specular * 0.5)
  })

  it('★ 玻璃材质的高光比磨砂材质强得多（眼睛和身体必须看起来不同材质）', () => {
    const glass = shade(highlightNormal(), EYE_MATERIAL)
    const matte = shade(highlightNormal(), BODY_MATERIAL)
    // 强度差 4 倍以上，"玻璃 vs 磨砂"才读得出来
    expect(glass.specular).toBeGreaterThan(matte.specular * 3)
  })

  it('所有分量都落在 [0,1]', () => {
    for (const material of [BODY_MATERIAL, EYE_MATERIAL, INNER_MATERIAL]) {
      for (const normal of [
        { x: 0, y: 0, z: 1 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 1, z: 0 },
        normalize({ x: -1, y: -1, z: 0.3 }),
      ]) {
        const s = shade(normal, material)
        for (const value of [s.diffuse, s.ambient, s.rim, s.specular]) {
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('非法法线不产生 NaN', () => {
    const s = shade({ x: Number.NaN, y: 0, z: 0 }, BODY_MATERIAL)
    for (const value of [s.diffuse, s.ambient, s.rim, s.specular]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('★ 光源方向非法时回落到安全值，而不是把画面算成 NaN', () => {
    const s = shade({ x: 0, y: 0, z: 1 }, BODY_MATERIAL, { x: 0, y: 0, z: 0 })
    for (const value of [s.diffuse, s.ambient, s.rim, s.specular]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('luminanceFactor：合成后的亮度必须合理', () => {
  it('★ 永不为负、永不烧白（烧白会丢掉全部体积信息）', () => {
    for (const material of [BODY_MATERIAL, EYE_MATERIAL, INNER_MATERIAL]) {
      for (let i = 0; i <= 20; i++) {
        const angle = (i / 20) * Math.PI * 2
        const n = normalize({ x: Math.cos(angle), y: Math.sin(angle), z: 0.4 })
        const value = luminanceFactor(shade(n, material), material)
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThanOrEqual(1.6)
      }
    }
  })

  it('★ 亮面确实比暗面亮（否则"立体"只是说法）', () => {
    // 迎光点取**主光方向**（漫反射最强处），背光点取反方向。
    // 不拿"高光峰值"比，因为它同时受高光影响，混了两件事。
    const lit = luminanceFactor(shade(KEY_LIGHT, BODY_MATERIAL), BODY_MATERIAL)
    const shadow = luminanceFactor(
      shade({ x: -KEY_LIGHT.x, y: -KEY_LIGHT.y, z: -KEY_LIGHT.z }, BODY_MATERIAL),
      BODY_MATERIAL,
    )
    expect(lit).toBeGreaterThan(shadow * 1.4)
  })
})

describe('接触阴影', () => {
  it('★ 越贴地越实（没有它，宠物看起来浮在桌面上）', () => {
    expect(contactShadowAlpha(0, 20)).toBeGreaterThan(contactShadowAlpha(10, 20))
    expect(contactShadowAlpha(10, 20)).toBeGreaterThan(contactShadowAlpha(19, 20))
  })

  it('超出半径则为 0（阴影不该无限扩散）', () => {
    expect(contactShadowAlpha(20, 20)).toBe(0)
    expect(contactShadowAlpha(100, 20)).toBe(0)
  })

  it('上限适中：最实也不超过 0.42（纯黑影子很假）', () => {
    expect(contactShadowAlpha(0, 20)).toBeLessThanOrEqual(0.42)
    expect(contactShadowAlpha(0, 20)).toBeGreaterThan(0.3)
  })

  it('非法参数返回 0 而不是 NaN', () => {
    expect(contactShadowAlpha(Number.NaN, 20)).toBe(0)
    expect(contactShadowAlpha(5, 0)).toBe(0)
  })
})

describe('环境光遮蔽', () => {
  it('★ 交叠处最深，远离后消失（这是"长在一起"与"叠在一起"的分界）', () => {
    expect(occlusionAt(0, 10)).toBeGreaterThan(occlusionAt(5, 10))
    expect(occlusionAt(5, 10)).toBeGreaterThan(occlusionAt(9, 10))
    expect(occlusionAt(10, 10)).toBe(0)
    expect(occlusionAt(50, 10)).toBe(0)
  })

  it('值域在 [0,1]', () => {
    for (let d = 0; d <= 12; d += 0.5) {
      const value = occlusionAt(d, 10)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('中心处为 1（完全遮蔽）', () => {
    expect(occlusionAt(0, 10)).toBeCloseTo(1, 6)
  })

  it('单调不增', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d <= 10; d += 0.25) {
      const value = occlusionAt(d, 10)
      expect(value).toBeLessThanOrEqual(previous + 1e-12)
      previous = value
    }
  })

  it('非法参数返回 0', () => {
    expect(occlusionAt(Number.NaN, 10)).toBe(0)
    expect(occlusionAt(0, 0)).toBe(0)
  })
})

describe('材质参数', () => {
  it('★ 三种材质互不相同（否则"材质"这个概念没有意义）', () => {
    const signatures = [BODY_MATERIAL, EYE_MATERIAL, INNER_MATERIAL].map((m: Material) =>
      JSON.stringify(m),
    )
    expect(new Set(signatures).size).toBe(3)
  })

  it('所有材质参数为正且有限', () => {
    for (const m of [BODY_MATERIAL, EYE_MATERIAL, INNER_MATERIAL]) {
      for (const value of [m.shininess, m.specularStrength, m.rimStrength, m.occlusion]) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
