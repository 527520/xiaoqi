import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  FOCUS_MS,
  IDLE_REST_MS,
  inferWorkMode,
  isWeekend,
  isWithinWorkHours,
  type WorkModeInput,
} from './workMode'

const here = dirname(fileURLToPath(import.meta.url))

/** 造一个工作日 10:00 的时间（周三）。 */
function weekday(hour = 10, minute = 0): Date {
  // 2026-09-09 是周三
  return new Date(2026, 8, 9, hour, minute, 0)
}

/** 造一个周末 14:00 的时间（周六）。 */
function weekendDay(hour = 14): Date {
  // 2026-09-12 是周六
  return new Date(2026, 8, 12, hour, 0, 0)
}

function input(overrides: Partial<WorkModeInput> = {}): WorkModeInput {
  return {
    processName: 'code.exe',
    idleMs: 0,
    notificationState: 5,
    now: weekday(),
    sameCategoryMs: 0,
    ...overrides,
  }
}

describe('时间判定', () => {
  it('周末识别正确', () => {
    expect(isWeekend(weekendDay())).toBe(true)
    expect(isWeekend(weekday())).toBe(false)
  })

  it('工作时段边界：9:00 含、18:00 不含', () => {
    expect(isWithinWorkHours(weekday(8, 59))).toBe(false)
    expect(isWithinWorkHours(weekday(9, 0))).toBe(true)
    expect(isWithinWorkHours(weekday(17, 59))).toBe(true)
    expect(isWithinWorkHours(weekday(18, 0))).toBe(false)
  })
})

describe('硬信号优先（不需要推论的那几条）', () => {
  it('锁屏 → 休息，无论前台是什么', () => {
    const r = inferWorkMode(input({ notificationState: 1 }))
    expect(r.mode).toBe('rest')
  })

  it('空闲超过阈值 → 休息，无论前台是什么', () => {
    const r = inferWorkMode(input({ idleMs: IDLE_REST_MS }))
    expect(r.mode).toBe('rest')
    expect(r.reason).toContain('空闲')
  })

  it('空闲阈值下方不触发休息', () => {
    const r = inferWorkMode(input({ idleMs: IDLE_REST_MS - 1 }))
    expect(r.mode).not.toBe('rest')
  })

  it('娱乐应用 → 休息（用户在放松，不该打扰）', () => {
    for (const name of ['steam.exe', 'potplayer.exe', 'cloudmusic.exe']) {
      expect(inferWorkMode(input({ processName: name })).mode).toBe('rest')
    }
  })

  it('全屏应用（QUNS=2）不影响工作模式 —— 那是形态闸门管的事', () => {
    // 工作模式回答"用户在干什么"，QUNS 回答"现在该不该出声"。
    // 两者刻意分开：全屏看电影时人在"休息"，全屏写代码时人在"编码"。
    const coding = inferWorkMode(input({ notificationState: 2, processName: 'code.exe' }))
    expect(coding.mode).toBe('coding')
  })
})

describe('工具类别推断', () => {
  it('开发工具 → 编码', () => {
    for (const name of ['code.exe', 'devenv.exe', 'windowsterminal.exe', 'pwsh.exe']) {
      expect(inferWorkMode(input({ processName: name })).mode).toBe('coding')
    }
  })

  it('会议应用 → 会议', () => {
    for (const name of ['teams.exe', 'zoom.exe', 'wemeetapp.exe', 'dingtalk.exe']) {
      expect(inferWorkMode(input({ processName: name })).mode).toBe('meeting')
    }
  })

  it('邮件客户端 → 邮件', () => {
    for (const name of ['outlook.exe', 'thunderbird.exe', 'foxmail.exe']) {
      expect(inferWorkMode(input({ processName: name })).mode).toBe('email')
    }
  })

  it('★ 会议优先于工具：开会时切到编辑器仍然算会议', () => {
    // 这条很重要：开会时用户会在会议软件与编辑器之间来回切，
    // 如果按"当前前台"报编码，宠物就会在别人讲话时冒泡。
    // 这里的优先级保证只要前台是会议应用就先算会议。
    const r = inferWorkMode(input({ processName: 'teams.exe', sameCategoryMs: FOCUS_MS * 2 }))
    expect(r.mode).toBe('meeting')
  })
})

describe('★ 隐私红线：浏览器只知是浏览器', () => {
  it('浏览器不会给出"编码"这种具体结论（因为我们不读标题）', () => {
    const r = inferWorkMode(input({ processName: 'msedge.exe' }))
    // 工作时段内的浏览器 → 中性的"专注"，不装懂
    expect(r.mode).toBe('focus')
    expect(r.reason).toContain('不读标题')
  })

  it('所有浏览器进程名得到同一个结论（不因"网页不同"而不同）', () => {
    const names = ['msedge.exe', 'chrome.exe', 'firefox.exe', '360se.exe']
    const modes = names.map((n) => inferWorkMode(input({ processName: n })).mode)
    expect(new Set(modes).size).toBe(1)
  })

  it('★ 源码级守卫：core/ 里不得出现任何读取窗口标题的 API', () => {
    // 这条是 ADR-0002 与施工令 §1.1④ 的自动化保障。
    // 读窗口标题**不会报错**，只会静默地把内容级信息带进来——
    // 所以必须用文本断言把它挡在代码之外。
    const forbidden = [
      'GetWindowText', // 经典读标题
      'GetWindowTextW',
      'GetWindowTextLength',
      'WindowTitle',
      'windowTitle',
      'titleText',
    ]
    const files = ['processTable.ts', 'workMode.ts']
    for (const file of files) {
      const source = readFileSync(join(here, file), 'utf8')
      for (const needle of forbidden) {
        expect(source.includes(needle), `${file} 里出现了禁用的窗口标题 API：${needle}`).toBe(false)
      }
    }
  })

  it('★ 平台层的进程名读取也不得**调用**读标题的 API', () => {
    // 平台层是唯一允许调 Win32 的地方，也是唯一"有机会"读标题的地方。
    //
    // ⚠️ 必须先剥掉注释再检查。第一版直接搜字符串，结果命中了
    //    `win32.ts` 里那句"**故意没有** GetWindowTextW"的说明注释——
    //    守卫把自己的警告文档当成了违规。剥注释之后才是真的在查调用。
    const source = readFileSync(join(here, '..', 'platform', 'win32.ts'), 'utf8')
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    for (const needle of ['GetWindowText', 'GetWindowTextW', 'GetWindowTextLength']) {
      expect(codeOnly.includes(needle), `win32.ts 的代码里出现了 ${needle}`).toBe(false)
    }
  })
})

describe('时间维度', () => {
  it('工作日工作时段 + 开发工具 → 编码', () => {
    expect(inferWorkMode(input({ now: weekday(11) })).mode).toBe('coding')
  })

  it('工作日晚间（18 点后）用开发工具 → 加班', () => {
    expect(inferWorkMode(input({ now: weekday(18, 30) })).mode).toBe('overtime')
  })

  it('工作日晚间不用工作工具 → 下班', () => {
    const r = inferWorkMode(input({ now: weekday(21), processName: 'totally-unknown.exe' }))
    expect(r.mode).toBe('offWork')
  })

  it('★ 两字母进程名不会被子串误命中（实测踩过）', () => {
    // `et`（WPS 表格）曾用子串匹配，于是 `acme-widget.exe` 被判成表格工具——
    // 因为 "widget" 里含 "et"。这类误判不报错，只会让宠物以为用户在干别的。
    const r = inferWorkMode(input({ now: weekday(21), processName: 'widget.exe' }))
    expect(r.mode).toBe('offWork')
    expect(r.category).toBe('unknown')
  })

  it('工作日清晨（9 点前）用开发工具 → 加班', () => {
    expect(inferWorkMode(input({ now: weekday(7) })).mode).toBe('overtime')
  })

  it('周末用工作工具 → 编码（**不是**加班）', () => {
    // "加班"暗示"本该休息的工作日"，用在周末是错的语义。
    const r = inferWorkMode(input({ now: weekendDay(), processName: 'code.exe' }))
    expect(r.mode).toBe('coding')
  })

  it('周末不用工作工具 → 周末', () => {
    const r = inferWorkMode(input({ now: weekendDay(), processName: 'unknown-app.exe' }))
    expect(r.mode).toBe('weekend')
  })

  it('周末在娱乐 → 休息（硬信号优先于周末）', () => {
    const r = inferWorkMode(input({ now: weekendDay(), processName: 'steam.exe' }))
    expect(r.mode).toBe('rest')
  })
})

describe('专注', () => {
  it('连续同类工具超过阈值 → 专注', () => {
    const r = inferWorkMode(input({ sameCategoryMs: FOCUS_MS }))
    expect(r.mode).toBe('focus')
    expect(r.reason).toContain('连续')
  })

  it('刚好低于阈值 → 不触发专注', () => {
    expect(inferWorkMode(input({ sameCategoryMs: FOCUS_MS - 1 })).mode).toBe('coding')
  })

  it('专注只在工作时段内生效（晚上连续用工具是加班，不是专注）', () => {
    const r = inferWorkMode(input({ now: weekday(22), sameCategoryMs: FOCUS_MS * 3 }))
    expect(r.mode).toBe('overtime')
  })
})

describe('★ 不评判：拿不到信息时不往坏处推断', () => {
  it('拿不到进程名 → 不报"休息"，而是按时间给中性结论', () => {
    // 拿不到进程名可能是受保护进程、UAC 桌面、或调用失败，
    // **不是**"用户在摸鱼"。当成休息会变成一种隐性的评判。
    const r = inferWorkMode(input({ processName: null, now: weekday(11) }))
    expect(r.mode).toBe('focus')
    expect(r.category).toBe('unknown')
  })

  it('空闲时长不可用（null）→ 不因此判休息', () => {
    const r = inferWorkMode(input({ idleMs: null }))
    expect(r.mode).not.toBe('rest')
  })

  it('未知进程名不会被归到娱乐或休息', () => {
    const r = inferWorkMode(input({ processName: 'totally-unknown-thing.exe' }))
    expect(r.mode).not.toBe('rest')
  })
})

describe('八种模式都可达（施工令 §4.6 明确"就这 8 个"）', () => {
  it('每种工作模式都有至少一个可达输入', () => {
    const reached = new Set<string>()

    reached.add(inferWorkMode(input({ now: weekday(11), processName: 'code.exe' })).mode)
    reached.add(inferWorkMode(input({ now: weekday(11), processName: 'teams.exe' })).mode)
    reached.add(inferWorkMode(input({ now: weekday(11), processName: 'outlook.exe' })).mode)
    reached.add(inferWorkMode(input({ now: weekday(11), sameCategoryMs: FOCUS_MS })).mode)
    reached.add(inferWorkMode(input({ now: weekday(11), processName: 'steam.exe' })).mode)
    reached.add(inferWorkMode(input({ now: weekday(22), processName: 'code.exe' })).mode)
    reached.add(inferWorkMode(input({ now: weekday(22), processName: 'x.exe' })).mode)
    reached.add(inferWorkMode(input({ now: weekendDay(), processName: 'x.exe' })).mode)

    expect([...reached].sort()).toEqual(
      ['coding', 'email', 'focus', 'meeting', 'offWork', 'overtime', 'rest', 'weekend'].sort(),
    )
  })
})
