import { describe, expect, it } from 'vitest'

import { PET_GEOMETRY } from '@shared/constants'
import { PET_FACE } from '@shared/palette'
import {
  AMBIENT_GROUND,
  AMBIENT_SKY,
  BODY_MATERIAL,
  EYE_MATERIAL,
  KEY_LIGHT,
} from '@shared/lighting'

import {
  buildUniformValues,
  declaredUniforms,
  FRAGMENT_SRC,
  OCCLUSION_RADIUS,
  UNIFORM_NAMES,
  VERTEX_SRC,
} from './petShader'

/**
 * 着色器源码的契约测试。
 *
 * ── 这个文件在防什么 ──
 *
 * 漏传一个 uniform 的后果是它在 GPU 上**恒为 0**，画面静默地不对
 * （例如高光永远不出现、环境光变成纯黑）。那种问题从截图上极难认出来，
 * 而且不会报任何错——正是本项目反复踩到的那类静默失效。
 *
 * 所以这里把"uniform 清单"变成一份可断言的契约：
 * 源码里声明的、JS 侧要传的，必须一一对应。
 */

describe('顶点着色器', () => {
  it('★ 必须声明并使用 aUV（探针踩过的坑：缺了它几何建好却什么都不画）', () => {
    expect(VERTEX_SRC).toContain('in vec2 aUV;')
    expect(VERTEX_SRC).toContain('vUV = aUV;')
  })

  it('必须声明 aPosition 并写出 gl_Position', () => {
    expect(VERTEX_SRC).toContain('in vec2 aPosition;')
    expect(VERTEX_SRC).toContain('gl_Position')
  })

  it('★ 必须用 Pixi 提供的全局 uniform 做变换（否则几何会跑到屏幕外）', () => {
    expect(VERTEX_SRC).toContain('uProjectionMatrix')
    expect(VERTEX_SRC).toContain('uWorldTransformMatrix')
  })
})

describe('片段着色器', () => {
  it('★ 完全透明的像素必须 discard（否则桌宠会变成不透明方块挡住下层窗口）', () => {
    expect(FRAGMENT_SRC).toContain('discard')
    expect(FRAGMENT_SRC).toMatch(/base\.a\s*<\s*0\.02/)
  })

  it('★ 半球环境光必须用**负**的法线 y（设计空间 y 轴向下）', () => {
    // 这条守的是一个真实 bug：第一版写成 n.y*0.5+0.5，把上下面接反，
    // 结果下巴比额头亮，像从地板打光。
    expect(FRAGMENT_SRC).toMatch(/-normal\.y/)
  })

  it('★ 高光必须带 Blinn-Phong 归一化项（否则 shininess 稍大就塌成 0）', () => {
    expect(FRAGMENT_SRC).toContain('(shininess + 8.0) / (8.0 * 3.14159265)')
  })

  it('法线由椭圆解析求出（这是"平面图形获得球面受光"的关键）', () => {
    expect(FRAGMENT_SRC).toContain('ellipseNormal')
    expect(FRAGMENT_SRC).toContain('sqrt(max(0.0, 1.0 - r2))')
  })

  it('输出亮度有上限，不允许烧白（烧白会丢掉全部体积信息）', () => {
    expect(FRAGMENT_SRC).toMatch(/min\(lit,\s*vec3\(1\.35\)\)/)
  })

  it('★ 源码里不含反引号（这段是模板字符串，反引号会提前结束它）', () => {
    // 本轮踩过**两次**：一次是 GLSL 注释里写了 Shader.from({resources})，
    // 一次是 uShadowCenter。两次的报错都指向别处
    // （TS1005 / esbuild 的 "Expected ; but found ..."），
    // 完全看不出是注释里的反引号。所以这条守卫是必要的，不是洁癖。
    expect(FRAGMENT_SRC).not.toContain('`')
    expect(VERTEX_SRC).not.toContain('`')
  })

  it('★ uniform 的声明类型必须与它在着色器里的用法一致（本轮真踩过）', () => {
    // uShadowCenter 一度声明成 vec3，而着色器里拿它和 vec2 相减：
    // 结果是**整个着色器编译失败 → 网格完全不画 → 画面上只剩眼睛**。
    // 那种失败在截图上看起来像"烘焙出了空纹理"，极难定位。
    // 所以把"声明类型"钉住，而不是依赖人眼审阅 GLSL。
    const expected: Record<string, string> = {
      uSize: 'vec2',
      uBody: 'vec4',
      uEarL: 'vec4',
      uEarR: 'vec4',
      uEyeL: 'vec4',
      uEyeColor: 'vec3',
      uShadowCenter: 'vec2',
      uShadowRadius: 'vec2',
      uLightDir: 'vec3',
    }
    for (const [name, type] of Object.entries(expected)) {
      expect(FRAGMENT_SRC, `${name} 的声明类型应为 ${type}`).toContain(`uniform ${type} ${name};`)
    }
  })
})

describe('uniform 契约', () => {
  it('★ 清单与源码里声明的 uniform 一一对应（多一个少一个都是静默失效）', () => {
    // 两边都排序后逐项比对：漏传会让 uniform 在 GPU 上恒为 0，
    // 多传则是有人在凭记忆写着色器。
    expect([...UNIFORM_NAMES].sort()).toEqual(declaredUniforms(FRAGMENT_SRC).sort())
  })

  it('uAlbedo 是 sampler2D，也在清单里', () => {
    expect(FRAGMENT_SRC).toContain('uniform sampler2D uAlbedo;')
    expect(UNIFORM_NAMES).toContain('uAlbedo')
  })

  it('清单里没有重复项', () => {
    expect(new Set(UNIFORM_NAMES).size).toBe(UNIFORM_NAMES.length)
  })

  it('★ buildUniformValues 覆盖清单里除 uAlbedo 外的每一项', () => {
    const values = buildUniformValues()
    const missing = UNIFORM_NAMES.filter((name) => name !== 'uAlbedo' && !(name in values))
    expect(missing).toEqual([])
  })

  it('产出里没有清单之外的键（多余的值说明有人在凭记忆写 uniform）', () => {
    const values = buildUniformValues()
    const extra = Object.keys(values).filter(
      (name) => !UNIFORM_NAMES.includes(name as (typeof UNIFORM_NAMES)[number]),
    )
    expect(extra).toEqual([])
  })
})

describe('uniform 取值从单一真相派生，不写第二份数字', () => {
  const values = buildUniformValues()

  it('★ 几何来自 PET_GEOMETRY（几何一改，着色器自动跟着走）', () => {
    const body = PET_GEOMETRY.body
    expect(Array.from(values.uBody)).toEqual([body.cx, body.cy, body.rx, body.ry])

    const earL = PET_GEOMETRY.earLeft
    expect(Array.from(values.uEarL)).toEqual([earL.cx, earL.cy, earL.r, earL.r])

    const earR = PET_GEOMETRY.earRight
    expect(Array.from(values.uEarR)).toEqual([earR.cx, earR.cy, earR.r, earR.r])
  })

  it('★ 眼睛几何来自 PET_FACE，且保留椭圆的 rx/ry 差异', () => {
    const eye = PET_FACE.eyeLeft
    expect(Array.from(values.uEyeL)).toEqual([eye.cx, eye.cy, eye.rx, eye.ry])
    expect(values.uEyeL[2]!).not.toBe(values.uEyeL[3]!)
  })

  it('影子位置来自 PET_FACE', () => {
    expect(Array.from(values.uShadowCenter)).toEqual([PET_FACE.shadow.cx, PET_FACE.shadow.cy])
  })

  it('★ 光源与材质来自 lighting.ts（改材质只需改一个地方）', () => {
    expect(values.uLightDir[0]!).toBeCloseTo(KEY_LIGHT.x, 6)
    expect(values.uLightDir[1]!).toBeCloseTo(KEY_LIGHT.y, 6)
    expect(values.uLightDir[2]!).toBeCloseTo(KEY_LIGHT.z, 6)

    expect(values.uAmbientGround[0]!).toBeCloseTo(AMBIENT_GROUND, 6)
    expect(values.uAmbientSky[0]!).toBeCloseTo(AMBIENT_SKY, 6)
    expect(values.uBodySpecular[0]!).toBeCloseTo(BODY_MATERIAL.specularStrength, 6)
    expect(values.uBodyRim[0]!).toBeCloseTo(BODY_MATERIAL.rimStrength, 6)
    expect(values.uEyeSpecular[0]).toBeCloseTo(EYE_MATERIAL.specularStrength, 6)
    expect(values.uEyeShininess[0]!).toBeCloseTo(EYE_MATERIAL.shininess, 6)
  })

  it('★ 玻璃眼睛的高光强度必须**明显**高于身体（否则"材质"读不出来）', () => {
    expect(values.uEyeSpecular[0]!).toBeGreaterThan(values.uBodySpecular[0]! * 3)
  })

  it('环境光上限高于下限（写反了会让朝下的面比朝上的亮）', () => {
    expect(values.uAmbientSky[0]!).toBeGreaterThan(values.uAmbientGround[0]!)
  })

  it('AO 衰减半径为正（为 0 会让 smoothstep 除零）', () => {
    expect(OCCLUSION_RADIUS).toBeGreaterThan(0)
    expect(values.uOcclusionRadius[0]!).toBeGreaterThan(0)
  })

  it('所有 uniform 值都是 Float32Array（Pixi 8 只接受这一种，传裸数字会抛错）', () => {
    for (const [name, value] of Object.entries(values)) {
      expect(value, `${name} 不是 Float32Array`).toBeInstanceOf(Float32Array)
    }
  })

  it('所有 uniform 值都有限，没有 NaN 混进来', () => {
    for (const [name, value] of Object.entries(values)) {
      for (const component of value) {
        expect(Number.isFinite(component), `${name} 含非有限值`).toBe(true)
      }
    }
  })
})

describe('declaredUniforms 解析器', () => {
  it('能抽出普通 uniform', () => {
    expect(declaredUniforms('uniform vec2 uFoo;\nuniform float uBar;')).toEqual(['uFoo', 'uBar'])
  })

  it('能抽出 sampler2D', () => {
    expect(declaredUniforms('uniform sampler2D uTex;')).toEqual(['uTex'])
  })

  it('忽略注释里的 uniform（否则清单会被说明文字污染）', () => {
    // 本项目踩过"守卫被自己的注释绊倒"（版权扫描测试匹配到它自己的说明）。
    const source = '// uniform vec2 uFake;\nuniform float uReal;'
    expect(declaredUniforms(source)).toEqual(['uReal'])
  })

  it('能处理块注释', () => {
    expect(declaredUniforms('/* uniform vec2 uFake; */\nuniform float uReal;')).toEqual(['uReal'])
  })
})
