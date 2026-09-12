import { describe, expect, it } from 'vitest'

import { CODEX_V1_ATLAS, CODEX_V2_ATLAS } from './petAtlas'
import {
  describeAtlas,
  describeAttribution,
  parsePetManifest,
  petWindowSizeFor,
  PROCEDURAL_DESIGN_SIZE,
  PROCEDURAL_PET,
  SPRITE_SHEET_FILE,
  type PetDefinition,
  type SpritePetDefinition,
} from './petDefinition'
import { PET_DESIGN_SIZE } from './constants'

/**
 * 宠物定义的测试。
 *
 * ── 这里最要紧的两条 ──
 *
 * ① **窗口尺寸不能是正方形**。精灵图的格是 192×208，硬套正方形会把宠物
 *    压扁。这条错了只有换素材时才看得出来（程序化宠物恰好是正方形，
 *    所以走默认路径永远测不出问题）。
 *
 * ② **版本与图集尺寸必须对上**。版本写错 = 切格高度错 = 宠物每隔几帧
 *    跳到别的动作上去。看着像渲染 bug，实际是元数据错，所以宁可在
 *    开窗之前就拒绝。
 */

/** 造一个合法的 pet.json。 */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '测试猫',
    author: '张三',
    license: 'CC-BY-NC-4.0',
    spriteVersionNumber: 2,
    ...overrides,
  }
}

const V2_PIXELS = { width: CODEX_V2_ATLAS.atlasWidth, height: CODEX_V2_ATLAS.atlasHeight }

/**
 * 解析一份**必定合法**的清单，返回精灵图定义。
 *
 * 用抛错而不是类型断言：断言会在"清单其实被拒了"时把 null 硬当对象用，
 * 于是测试会在别处以莫名其妙的方式失败；抛错直接指出是解析这一环断的。
 */
function spriteFrom(raw: Record<string, unknown>): SpritePetDefinition {
  const result = parsePetManifest(raw, { sheetPixels: V2_PIXELS })
  if (result.definition === null) {
    throw new Error(`清单被拒绝了，测试前提不成立：${result.errors.join('；')}`)
  }
  return result.definition
}

describe('petWindowSizeFor：两条后端的窗口尺寸', () => {
  it('程序化宠物是正方形', () => {
    expect(petWindowSizeFor(PROCEDURAL_PET, 1)).toEqual({
      width: PET_DESIGN_SIZE,
      height: PET_DESIGN_SIZE,
    })
  })

  it('★ 精灵图宠物**不是**正方形（按格子比例，192×208）', () => {
    const definition = spriteFrom(manifest())
    const size = petWindowSizeFor(definition, 1)
    expect(size).toEqual({ width: 192, height: 208 })
    expect(size.width).not.toBe(size.height)
    // 若这里退回成 220×220，宠物会被横向拉伸约 15%
    expect(size.height).toBeGreaterThan(size.width)
  })

  it('随缩放线性变化（两条后端一致）', () => {
    const sprite = spriteFrom(manifest())
    expect(petWindowSizeFor(sprite, 2)).toEqual({ width: 384, height: 416 })
    expect(petWindowSizeFor(PROCEDURAL_PET, 2)).toEqual({ width: 440, height: 440 })
  })

  it('缩放非法时按 1 处理，尺寸至少为 1', () => {
    const sprite = spriteFrom(manifest())
    expect(petWindowSizeFor(sprite, 0)).toEqual({ width: 192, height: 208 })
    expect(petWindowSizeFor(sprite, Number.NaN)).toEqual({ width: 192, height: 208 })
    expect(petWindowSizeFor(sprite, -3)).toEqual({ width: 192, height: 208 })
  })

  it('★ 设计空间边长与 constants.ts 的值一致（重复一个数是为了避免循环 import，必须钉住）', () => {
    expect(PROCEDURAL_DESIGN_SIZE).toBe(PET_DESIGN_SIZE)
    expect(PET_DESIGN_SIZE).toBe(220)
  })
})

describe('parsePetManifest：合法输入', () => {
  it('V2 清单通过，字段齐全', () => {
    const result = parsePetManifest(manifest(), {
      sheetPixels: V2_PIXELS,
      fallbackName: '目录名',
    })
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    const definition = result.definition
    expect(definition?.kind).toBe('sprite')
    expect(definition?.displayName).toBe('测试猫')
    expect(definition?.atlasVersion).toBe(2)
    expect(definition?.sheetFile).toBe(SPRITE_SHEET_FILE)
    expect(definition?.source?.author).toBe('张三')
    expect(definition?.source?.license).toBe('CC-BY-NC-4.0')
    // 契约：V2 就是 11 行
    expect(definition?.atlas.rows).toBe(11)
    expect(definition?.atlas.atlasHeight).toBe(2288)
  })

  it('★ 省略 spriteVersionNumber 就是 V1（规范如此，不是我们偷懒）', () => {
    const result = parsePetManifest(
      { name: '老图集', license: 'MIT' },
      { sheetPixels: { width: CODEX_V1_ATLAS.atlasWidth, height: CODEX_V1_ATLAS.atlasHeight } },
    )
    expect(result.errors).toEqual([])
    expect(result.definition?.atlasVersion).toBe(1)
    expect(result.definition?.atlas.rows).toBe(9)
  })

  it('PNG 图集也接受（规范允许）', () => {
    const result = parsePetManifest(manifest(), {
      sheetFile: 'spritesheet.png',
      sheetPixels: V2_PIXELS,
    })
    expect(result.errors).toEqual([])
    expect(result.definition?.sheetFile).toBe('spritesheet.png')
  })
})

describe('★ parsePetManifest：版本与尺寸必须对上', () => {
  it('★ V2 清单配 V1 尺寸的图 → 报错（不宽容，因为它会让切格全错）', () => {
    const result = parsePetManifest(manifest({ spriteVersionNumber: 2 }), {
      sheetPixels: { width: CODEX_V1_ATLAS.atlasWidth, height: CODEX_V1_ATLAS.atlasHeight },
    })
    expect(result.definition).toBeNull()
    expect(result.errors).toHaveLength(1)
    // 错误信息要能直接看出"应为多少、实际多少"
    expect(result.errors[0]).toContain('1536×2288')
    expect(result.errors[0]).toContain('1536×1872')
  })

  it('★ V1 清单配 V2 尺寸的图 → 同样报错（反向也要拦住）', () => {
    const result = parsePetManifest(manifest({ spriteVersionNumber: 1 }), {
      sheetPixels: V2_PIXELS,
    })
    expect(result.definition).toBeNull()
    expect(result.errors[0]).toContain('1536×1872')
  })

  it('版本号是别的值 → 报错并说出实际值', () => {
    const result = parsePetManifest(manifest({ spriteVersionNumber: 3 }), {
      sheetPixels: V2_PIXELS,
    })
    expect(result.definition).toBeNull()
    expect(result.errors[0]).toContain('3')
  })

  it('版本号是字符串 "2" → 报错（不做隐式转换，JSON 里写错类型要让人看见）', () => {
    const result = parsePetManifest(manifest({ spriteVersionNumber: '2' }), {
      sheetPixels: V2_PIXELS,
    })
    expect(result.definition).toBeNull()
  })

  it('★ 读不出像素尺寸时只警告、仍然可用（文件头读不到不该挡住启动）', () => {
    const result = parsePetManifest(manifest(), { sheetPixels: null })
    expect(result.definition).not.toBeNull()
    expect(result.errors).toEqual([])
    expect(result.warnings.join()).toContain('像素尺寸')
  })
})

describe('parsePetManifest：宽容降级的那部分', () => {
  it('缺 name → 用目录名兜底并警告', () => {
    const result = parsePetManifest(
      { license: 'MIT', spriteVersionNumber: 2 },
      { sheetPixels: V2_PIXELS, fallbackName: 'my-cat' },
    )
    expect(result.definition?.displayName).toBe('my-cat')
    expect(result.warnings.join()).toContain('my-cat')
  })

  it('缺 name 且没有兜底名 → 用「未命名」而不是空串', () => {
    const result = parsePetManifest({ spriteVersionNumber: 2 }, { sheetPixels: V2_PIXELS })
    expect(result.definition?.displayName).toBe('未命名')
    expect(result.definition?.displayName).not.toBe('')
  })

  it('★ 缺 license → 警告但不拒绝（社区素材普遍缺，拒绝会把用户挡在门外）', () => {
    const result = parsePetManifest(
      { name: '无名猫', spriteVersionNumber: 2 },
      { sheetPixels: V2_PIXELS },
    )
    expect(result.definition).not.toBeNull()
    expect(result.errors).toEqual([])
    expect(result.warnings.join()).toContain('license')
  })

  it('displayName 可以作为 name 的别名', () => {
    const result = parsePetManifest(
      { displayName: '别名猫', license: 'MIT', spriteVersionNumber: 2 },
      { sheetPixels: V2_PIXELS },
    )
    expect(result.definition?.displayName).toBe('别名猫')
  })

  it('空字符串的名字视为没写（不是"叫空字符串的宠物"）', () => {
    const result = parsePetManifest(
      { name: '   ', license: 'MIT', spriteVersionNumber: 2 },
      { sheetPixels: V2_PIXELS, fallbackName: '目录名' },
    )
    expect(result.definition?.displayName).toBe('目录名')
  })

  it('source 可以给出处链接', () => {
    const result = parsePetManifest(
      manifest({ source: 'https://example.com/pet' }),
      { sheetPixels: V2_PIXELS },
    )
    expect(result.definition?.source?.url).toBe('https://example.com/pet')
  })

  it('多余字段被忽略（社区包里有各种自家扩展）', () => {
    const result = parsePetManifest(manifest({ somethingElse: { nested: true } }), {
      sheetPixels: V2_PIXELS,
    })
    expect(result.errors).toEqual([])
    expect(result.definition).not.toBeNull()
  })
})

describe('parsePetManifest：坏输入', () => {
  it('不是对象就被拒（数组也算拒）', () => {
    for (const bad of [null, undefined, 'x', 42, [], true]) {
      const result = parsePetManifest(bad)
      expect(result.definition, JSON.stringify(bad)).toBeNull()
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('错误信息里要带上是哪个字段出的问题', () => {
    const result = parsePetManifest(manifest({ spriteVersionNumber: 'two' }), {
      sheetPixels: V2_PIXELS,
    })
    expect(result.errors[0]).toContain('spriteVersionNumber')
  })
})

describe('署名与描述', () => {
  const spriteDefinition: SpritePetDefinition = {
    kind: 'sprite',
    displayName: '猫',
    atlasVersion: 2,
    sheetFile: SPRITE_SHEET_FILE,
    atlas: CODEX_V2_ATLAS,
    source: { author: '李四', license: 'CC0-1.0' },
  }

  it('★ 精灵图的署名包含作者与授权（授权是能不能用的前提，必须可见）', () => {
    const line = describeAttribution(spriteDefinition)
    expect(line).toContain('李四')
    expect(line).toContain('CC0-1.0')
    expect(line).toContain('V2')
  })

  it('★ 缺作者/授权时给出明确的占位，而不是留空（空白会被当成"没问题"）', () => {
    const bare: PetDefinition = {
      kind: 'sprite',
      displayName: '猫',
      atlasVersion: 1,
      sheetFile: SPRITE_SHEET_FILE,
      atlas: CODEX_V1_ATLAS,
    }
    const line = describeAttribution(bare)
    expect(line).toContain('作者未注明')
    expect(line).toContain('授权未注明')
  })

  it('程序化宠物的署名说明是内置形象', () => {
    expect(describeAttribution(PROCEDURAL_PET)).toContain('内置矢量形象')
  })

  it('describeAtlas 报出网格、格尺寸与总帧数', () => {
    const line = describeAtlas(spriteDefinition)
    expect(line).toContain('8列×11行')
    expect(line).toContain('192×208')
    // V2 标准动作帧数：6+8+8+4+5+8+6+6+6 = 57
    expect(line).toContain('57')
  })
})
