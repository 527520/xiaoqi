import type { UserNotificationState, WorkMode } from '@shared/types'

import { categorizeProcess, isWorkCategory, type AppCategory } from './processTable'

/**
 * 工作模式推断 —— **纯函数，可单测**（时间也作为参数传入，因此能用假时钟）。
 *
 * ── 这个文件是产品红线在代码里的落点 ──
 *
 * 输入只有三项允许的信号 + 本地时间：
 *   ① 前台进程名（只知道**是什么软件**，不知道内容）
 *   ② 系统空闲时长（聚合值，不含按键）
 *   ③ 系统级状态（QUNS：全屏/锁屏）
 *
 * **没有窗口标题，没有屏幕内容，没有任何"增强准确率"的后门。**
 * 施工令 §5 M2 的原话是「由三项信号推出全部工作模式，
 * 不允许读窗口标题来提升准确率」。因此准确率上限更低是**设计**，不是缺陷。
 */

/** 空闲多久算"人不在"。 */
export const IDLE_REST_MS = 20 * 60 * 1000

/** 连续使用同一类工具多久算"专注"。 */
export const FOCUS_MS = 45 * 60 * 1000

/** 工作日的上班时间（含）。 */
export const WORK_START_HOUR = 9
/** 工作日的下班时间（不含）。 */
export const WORK_END_HOUR = 18
/** 工作日超过这个点**仍在工作** → 加班。 */
export const OVERTIME_FROM_HOUR = 19

export interface WorkModeInput {
  /** 前台进程名（小写），`null` = 拿不到。 */
  readonly processName: string | null
  /** 系统空闲时长（毫秒），`null` = 不可用。 */
  readonly idleMs: number | null
  readonly notificationState: UserNotificationState
  /** 本地时间。**作为参数传入**，这样单测能用假时钟。 */
  readonly now: Date
  /**
   * 连续使用同一应用类别的时长（毫秒）。
   * 由调用方跨轮次累积，不在这个纯函数里维护状态。
   */
  readonly sameCategoryMs: number
}

export interface WorkModeResult {
  readonly mode: WorkMode
  readonly category: AppCategory
  /** 推断依据的可读说明，给调试面板与排查用。**不含任何用户内容。** */
  readonly reason: string
}

/** 是否周末。 */
export function isWeekend(now: Date): boolean {
  const day = now.getDay()
  return day === 0 || day === 6
}

/** 是否在工作时段内（工作日 9:00–18:00）。 */
export function isWithinWorkHours(now: Date): boolean {
  const hour = now.getHours()
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR
}

/**
 * 推断工作模式。
 *
 * ── 判定顺序是刻意的：从"硬信号"到"需要推论" ──
 *
 * 前三步都是**硬信号**，不需要猜：
 *   1. 锁屏（QUNS=1）→ 休息
 *   2. 空闲 ≥20 分钟 → 休息
 *   3. 娱乐应用 → 休息
 *
 * 之后按"用户此刻最可能在做什么"排优先级：
 *   4. 会议（**优先于工具类别**：开会时切到编辑器很常见，这时不该说话）
 *   5. 邮件
 *   6. 连续专注 ≥45 分钟 → 专注
 *   7. 开发工具 → 编码
 *   8. 其余（浏览器 / 认不出）→ 工作时间段内给"专注"，
 *      否则按时间给"下班 / 周末"
 *
 * ── 两个刻意的保守选择 ──
 *
 * ① **认不出就承认认不出**：浏览器与未知进程在工作时段内统一给"专注"，
 *    而不是硬猜"编码"。我们确实不知道用户在做什么，装懂会让形态切换出错。
 * ② **拿不到进程名不当作负面信号**：它可能是受保护进程或 UAC 桌面，
 *    此时退化成纯时间驱动（下班 / 周末 / 专注），而不是当成"用户在摸鱼"——
 *    那会违背"不评判"（§1.2⑦）。
 *
 * ⚠️ 加班在**周末不适用**：周末干活叫"在做事"，不叫加班。
 *    "加班"暗示"本该休息的工作日"，用在周末是错的语义。
 */
export function inferWorkMode(input: WorkModeInput): WorkModeResult {
  const { processName, idleMs, notificationState, now, sameCategoryMs } = input
  const category = categorizeProcess(processName)
  const weekend = isWeekend(now)
  const withinWorkHours = isWithinWorkHours(now)
  const hour = now.getHours()

  // ① 锁屏 / 屏保：用户根本不在
  if (notificationState === 1) {
    return { mode: 'rest', category, reason: '锁屏或屏保（QUNS=1）' }
  }

  // ② 空闲过久：人不在，无论前台是什么
  if (idleMs !== null && idleMs >= IDLE_REST_MS) {
    return { mode: 'rest', category, reason: `已空闲 ${String(Math.round(idleMs / 60000))} 分钟` }
  }

  // ③ 娱乐：明确在放松
  if (category === 'entertainment') {
    return { mode: 'rest', category, reason: '前台是娱乐应用' }
  }

  // ④⑤ 会议与邮件优先于工具类别
  if (category === 'meeting') {
    return { mode: 'meeting', category, reason: '前台是会议应用' }
  }
  if (category === 'mail') {
    return { mode: 'email', category, reason: '前台是邮件客户端' }
  }

  const working = isWorkCategory(category)

  // ⑥ 时间维度的两种情况：周末 / 工作日
  if (weekend) {
    if (working) {
      // 周末干活不叫加班——"加班"暗示"本该休息的工作日"
      return { mode: 'coding', category, reason: '周末在使用工作工具' }
    }
    return { mode: 'weekend', category, reason: '周末' }
  }

  // 工作日、工作时段之外
  if (!withinWorkHours) {
    // ⚠️ 这里只按 `working`（**确知**是工作工具）判加班。
    //    第一版写成 `!working → offWork`，导致"晚上用一个认不出的程序"
    //    被判成加班，而"晚上用浏览器"被判成下班——同样都是未知，结论却相反，
    //    明显不对。改用 allowlist 语义：**只有确知在工作才算加班**。
    if (!working) {
      return { mode: 'offWork', category, reason: '工作时段之外' }
    }
    return { mode: 'overtime', category, reason: `${String(hour)} 点在工作时段之外工作` }
  }

  // ⑦ 工作时段内：先看连续专注，再看工具类型
  if (sameCategoryMs >= FOCUS_MS) {
    return {
      mode: 'focus',
      category,
      reason: `连续使用同一类工具 ${String(Math.round(sameCategoryMs / 60000))} 分钟`,
    }
  }
  if (category === 'devTool') {
    return { mode: 'coding', category, reason: '前台是开发工具' }
  }

  // ⑧ 浏览器 / 认不出：在工作时段内，但**我们确实不知道**在做什么。
  //    给中性的"专注"，不硬猜"编码"——装懂会让形态与语气一起出错。
  return {
    mode: 'focus',
    category,
    reason: category === 'browser' ? '前台是浏览器（不读标题，故不知内容）' : '前台进程未归类',
  }
}
