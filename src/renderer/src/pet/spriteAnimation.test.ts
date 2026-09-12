import { describe, expect, it } from 'vitest'

import { LOOK_DIRECTIONS, nearestLookDirection } from '@shared/petAtlas'
import type { Emotion, VisibilityMode, WorkMode } from '@shared/types'

import {
  describeAnimationChoice,
  emotionAnimationTable,
  isLoopingAnimation,
  lookFromCursor,
  selectSpriteAnimation,
  workModeAnimationTable,
  type SpriteAnimationInput,
} from './spriteAnimation'

/**
 * 动作选择的测试。
 *
 * ── 这里要防的是哪一类错 ──
 *
 * 这张表**错了不会崩**：宠物照常渲染、照常可点，只是"该挥手的时候在发呆"。
 * 而精灵图模式下没有别的线索（DevTools 一开透明窗就不透明，没法边看边调），
 * 所以只能靠测试把每一条对应关系钉住。
 *
 * 另外两条最容易搞反的换算（注视方向 0° = 正上、屏幕 y 轴向下）
 * 也在这里穷举验证。
 */

/** 造一份输入，默认是"平静的、正在编码的、没被点的宠物"。 */
function input(overrides: Partial<SpriteAnimationInput> = {}): SpriteAnimationInput {
  return {
    mode: 'active',
    emotion: 'calm',
    workMode: 'coding',
    reactionRemaining: 0,
    cursorOffset: null,
    waiting: false,
    reviewing: false,
    ...overrides,
  }
}

describe('selectSpriteAnimation：优先级', () => {
  it('★ 隐身 → 不播任何显眼动作（窗口本来就不可见）', () => {
    const selection = selectSpriteAnimation(input({ mode: 'hidden', emotion: 'happy' }))
    expect(selection.animation).toBe('idle')
    expect(selection.look).toBeNull()
  })

  it('★ 静默 → idle：情绪再高兴也不挥手（静默的语义就是"几乎不动"）', () => {
    expect(selectSpriteAnimation(input({ mode: 'silent', emotion: 'happy' })).animation).toBe('idle')
    expect(
      selectSpriteAnimation(input({ mode: 'silent', emotion: 'surprised' })).animation,
    ).toBe('idle')
  })

  it('★ 交互回应压过情绪与工作模式（ADR-0003：无条件回应，不能"因为忙就不理人"）', () => {
    const selection = selectSpriteAnimation(
      input({ reactionRemaining: 0.5, emotion: 'bored', workMode: 'meeting' }),
    )
    expect(selection.animation).toBe('waving')
    expect(selection.oneShot).toBe(true)
  })

  it('★ 交互回应也压过"等用户"与"检视"', () => {
    expect(
      selectSpriteAnimation(input({ reactionRemaining: 0.5, waiting: true })).animation,
    ).toBe('waving')
    expect(
      selectSpriteAnimation(input({ reactionRemaining: 0.5, reviewing: true })).animation,
    ).toBe('waving')
  })

  it('交互倒计时归零就不再挥手（否则会一直挥下去）', () => {
    expect(selectSpriteAnimation(input({ reactionRemaining: 0 })).animation).not.toBe('waving')
    // 恰好为 0 也算结束；负数同样
    expect(selectSpriteAnimation(input({ reactionRemaining: -1 })).animation).not.toBe('waving')
  })

  it('等用户 / 检视 各自映射到 waiting / review，且是循环动作', () => {
    const waiting = selectSpriteAnimation(input({ waiting: true }))
    expect(waiting.animation).toBe('waiting')
    expect(waiting.oneShot).toBe(false)

    const reviewing = selectSpriteAnimation(input({ reviewing: true }))
    expect(reviewing.animation).toBe('review')
    expect(reviewing.oneShot).toBe(false)
  })

  it('等用户优先于检视（两个都为真时选 waiting）', () => {
    expect(selectSpriteAnimation(input({ waiting: true, reviewing: true })).animation).toBe(
      'waiting',
    )
  })

  it('★ 情绪优先于工作模式（情绪是宠物自己的状态，不该被"用户在开会"盖掉）', () => {
    const selection = selectSpriteAnimation(input({ emotion: 'happy', workMode: 'meeting' }))
    expect(selection.animation).toBe('waving')
    expect(selection.animation).not.toBe('waiting')
  })
})

describe('情绪 → 动作：每条对应都钉住，包括"刻意回落"的那几条', () => {
  it('★ 有明确语义的情绪如实对应', () => {
    expect(selectSpriteAnimation(input({ emotion: 'happy' })).animation).toBe('waving')
    expect(selectSpriteAnimation(input({ emotion: 'surprised' })).animation).toBe('jumping')
    expect(selectSpriteAnimation(input({ emotion: 'aggrieved' })).animation).toBe('failed')
    expect(selectSpriteAnimation(input({ emotion: 'close' })).animation).toBe('waving')
  })

  it('★ 图集里没有对应词条的情绪**必须**回落 idle，而不是硬凑一个', () => {
    // calm 回落是定义使然；focused / sleepy / bored 是**已知落差**。
    // 这条测试的作用是：谁要是把 focused 改成 review 来"看起来更丰富"，
    // 必须同时改掉这里的断言，也就必须面对"review 是检视文档、不是专注"这个问题。
    for (const emotion of ['calm', 'focused', 'sleepy', 'bored'] as const) {
      const fallbackInput = input({ emotion, workMode: 'rest' })
      expect(selectSpriteAnimation(fallbackInput).animation, emotion).toBe('idle')
    }
  })

  it('★ 有主张的情绪都是一次性动作（播完要回落，不能卡在挥手那一帧）', () => {
    for (const emotion of ['happy', 'surprised', 'aggrieved', 'close'] as const) {
      expect(selectSpriteAnimation(input({ emotion })).oneShot, emotion).toBe(true)
    }
  })

  it('对照表覆盖全部 8 种情绪（漏一个会得到 undefined 并静默变成 idle）', () => {
    const table = emotionAnimationTable()
    const emotions: Emotion[] = [
      'happy',
      'calm',
      'sleepy',
      'focused',
      'aggrieved',
      'surprised',
      'close',
      'bored',
    ]
    for (const emotion of emotions) {
      expect(table[emotion], emotion).toBeDefined()
      // 每一条都必须写下理由——没有理由的映射迟早被改错
      expect(table[emotion].why.length, emotion).toBeGreaterThan(4)
    }
    expect(Object.keys(table)).toHaveLength(8)
  })

  it('对照表里的动作都是合法的图集动作（自创名字会在运行时变成空白格）', () => {
    const valid = new Set([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review',
    ])
    for (const [emotion, entry] of Object.entries(emotionAnimationTable())) {
      expect(valid.has(entry.animation), emotion).toBe(true)
    }
    // ⚠️ 这里只遍历**表里真的有的**键，所以 entry 不可能是 undefined
    //    （`Object.entries` 只会吐出成对的键值）。不带 `?.` 是刻意的：
    //    加上它会把"表里少了一个工作模式"这件事掩盖成一次静默通过。
    for (const [workMode, entry] of Object.entries(workModeAnimationTable())) {
      expect(valid.has(entry.animation), workMode).toBe(true)
    }
  })
})

describe('工作模式 → 动作', () => {
  it('编码 / 专注 / 加班 → running（在原地忙）', () => {
    for (const workMode of ['coding', 'focus', 'overtime'] as const) {
      expect(selectSpriteAnimation(input({ workMode })).animation, workMode).toBe('running')
    }
  })

  it('邮件 → review，会议 → waiting', () => {
    expect(selectSpriteAnimation(input({ workMode: 'email' })).animation).toBe('review')
    expect(selectSpriteAnimation(input({ workMode: 'meeting' })).animation).toBe('waiting')
  })

  it('★ 休息 / 下班 / 周末 → idle（它也该歇着）', () => {
    for (const workMode of ['rest', 'offWork', 'weekend'] as const) {
      expect(selectSpriteAnimation(input({ workMode })).animation, workMode).toBe('idle')
    }
  })

  it('★ 加班不当成"可怜"或"批评"（ADR-0003：不评判用户）', () => {
    // 只允许 running（陪着干活）。出现 failed/aggrieved 那种"垂头丧气"
    // 就等于在暗示"你加班好惨"——那正是施工令禁止的评判。
    const selection = selectSpriteAnimation(input({ workMode: 'overtime', emotion: 'calm' }))
    expect(selection.animation).toBe('running')
    expect(selection.animation).not.toBe('failed')
  })

  it('对照表的理由字段都写了（可 grep 的自解释）', () => {
    for (const [workMode, entry] of Object.entries(workModeAnimationTable())) {
      expect(entry.why.length, workMode).toBeGreaterThan(4)
    }
  })
})

describe('★ lookFromCursor：0° = 正上，且屏幕 y 轴向下', () => {
  it('光标在正上方 → 0°（12 点钟），**不是** 0° 表示正前方', () => {
    // 屏幕坐标：中心上方 = y 为负
    expect(lookFromCursor({ x: 0, y: -50 })).toBe(0)
  })

  it('★ 四个正方向的度数（这一条同时钉住 y 轴取负与 +90° 的换算）', () => {
    expect(lookFromCursor({ x: 0, y: -50 })).toBe(0) // 上
    expect(lookFromCursor({ x: 50, y: 0 })).toBe(90) // 右
    expect(lookFromCursor({ x: 0, y: 50 })).toBe(180) // 下
    expect(lookFromCursor({ x: -50, y: 0 })).toBe(270) // 左
  })

  it('★ 右上在 0° 与 90° 之间（45°），而不是 315°', () => {
    expect(lookFromCursor({ x: 50, y: -50 })).toBe(45)
    // 右下 135°、左下 225°、左上 315°
    expect(lookFromCursor({ x: 50, y: 50 })).toBe(135)
    expect(lookFromCursor({ x: -50, y: 50 })).toBe(225)
    expect(lookFromCursor({ x: -50, y: -50 })).toBe(315)
  })

  it('null 光标 → null（保持当前帧，不要硬转）', () => {
    expect(lookFromCursor(null)).toBeNull()
  })

  it('★ 中心死区内 → null（否则一点点抖动会让它看起来在抽搐）', () => {
    expect(lookFromCursor({ x: 0, y: 0 })).toBeNull()
    expect(lookFromCursor({ x: 2, y: -3 })).toBeNull()
    // 死区之外立刻给方向
    expect(lookFromCursor({ x: 0, y: -20 })).toBe(0)
  })

  it('★ 返回值永远是 16 个合法方向之一（穷举一圈）', () => {
    for (let degrees = 0; degrees < 360; degrees += 3) {
      const radians = (degrees * Math.PI) / 180
      // 反推屏幕坐标：图集角度 d（0=上，顺时针）→ 屏幕偏移
      const x = Math.sin(radians) * 100
      const y = -Math.cos(radians) * 100
      const result = lookFromCursor({ x, y })
      expect(result, `${String(degrees)}°`).not.toBeNull()
      expect(LOOK_DIRECTIONS).toContain(result)
    }
  })

  it('★ 与 nearestLookDirection 的约定一致（两处各写一份就会漂移）', () => {
    // 我在 lookFromCursor 里做 +90° 换算；这里验的是"换过去之后
    // 交给 nearestLookDirection 得到的确实是期望的那个方向"。
    expect(lookFromCursor({ x: 0, y: -50 })).toBe(nearestLookDirection(0))
    expect(lookFromCursor({ x: 50, y: 0 })).toBe(nearestLookDirection(90))
    expect(lookFromCursor({ x: 0, y: 50 })).toBe(nearestLookDirection(180))
    expect(lookFromCursor({ x: -50, y: 0 })).toBe(nearestLookDirection(270))
  })

  it('★ 只有 idle 才带注视方向（挥手/奔跑时"看向光标"在视觉上是错的）', () => {
    const idle = selectSpriteAnimation(
      input({ workMode: 'rest', cursorOffset: { x: 0, y: -40 } }),
    )
    expect(idle.animation).toBe('idle')
    expect(idle.look).toBe(0)

    const waving = selectSpriteAnimation(
      input({ emotion: 'happy', cursorOffset: { x: 0, y: -40 } }),
    )
    expect(waving.animation).toBe('waving')
    expect(waving.look).toBeNull()

    const running = selectSpriteAnimation(
      input({ workMode: 'coding', cursorOffset: { x: 0, y: -40 } }),
    )
    expect(running.animation).toBe('running')
    expect(running.look).toBeNull()
  })

  it('工作模式映射到 idle 时仍然给注视方向（rest 时它会看着你）', () => {
    const selection = selectSpriteAnimation(
      input({ workMode: 'rest', cursorOffset: { x: 0, y: -40 } }),
    )
    expect(selection.animation).toBe('idle')
    expect(selection.look).toBe(0)
  })
})

describe('isLoopingAnimation：与 oneShot 必须一致', () => {
  it('循环与一次性各归各的', () => {
    expect(isLoopingAnimation('idle')).toBe(true)
    expect(isLoopingAnimation('running')).toBe(true)
    expect(isLoopingAnimation('waiting')).toBe(true)
    expect(isLoopingAnimation('review')).toBe(true)
    expect(isLoopingAnimation('waving')).toBe(false)
    expect(isLoopingAnimation('jumping')).toBe(false)
    expect(isLoopingAnimation('failed')).toBe(false)
    expect(isLoopingAnimation('running-left')).toBe(false)
    expect(isLoopingAnimation('running-right')).toBe(false)
  })

  it('★ 选择结果里的 oneShot 与这张表一致（两处不一致会让动作播完卡住）', () => {
    // 挑几个会走到不同分支的输入，逐个核对 oneShot 字段
    const cases: SpriteAnimationInput[] = [
      input({ emotion: 'happy' }), // waving
      input({ emotion: 'surprised' }), // jumping
      input({ emotion: 'aggrieved' }), // failed
      input({ reactionRemaining: 0.5 }), // waving
      input({ workMode: 'coding' }), // running
      input({ waiting: true }), // waiting
      input({ reviewing: true }), // review
      input({}), // idle
    ]
    for (const item of cases) {
      const selection = selectSpriteAnimation(item)
      const looping = isLoopingAnimation(selection.animation)
      expect(
        selection.oneShot,
        `${selection.animation} 的 oneShot 与 isLoopingAnimation 不一致`,
      ).toBe(!looping)
    }
  })
})

describe('describeAnimationChoice：可 grep 的自解释', () => {
  it('非 idle 时给出 情绪/工作模式 → 动作', () => {
    const line = describeAnimationChoice(input({ emotion: 'happy' }))
    expect(line).toContain('happy')
    expect(line).toContain('waving')
  })

  it('★ idle 时把"为什么回落"的理由带出来', () => {
    const line = describeAnimationChoice(input({ emotion: 'focused', workMode: 'rest' }))
    expect(line).toContain('idle')
    expect(line).toContain('专注')
  })
})

describe('类型层面的守卫', () => {
  it('VisibilityMode 的三个取值都被处理（新增取值时这条会失败，提醒补分支）', () => {
    const modes: VisibilityMode[] = ['active', 'silent', 'hidden']
    for (const mode of modes) {
      const selection = selectSpriteAnimation(input({ mode, emotion: 'happy' }))
      if (mode === 'active') {
        expect(selection.animation, mode).toBe('waving')
      } else {
        expect(selection.animation, mode).toBe('idle')
      }
    }
  })

  it('WorkMode 的八个取值都能得到一个动作（没有 undefined 漏出去）', () => {
    const modes: WorkMode[] = [
      'coding',
      'meeting',
      'email',
      'focus',
      'rest',
      'overtime',
      'offWork',
      'weekend',
    ]
    for (const workMode of modes) {
      const selection = selectSpriteAnimation(input({ workMode }))
      expect(typeof selection.animation, workMode).toBe('string')
    }
  })
})
