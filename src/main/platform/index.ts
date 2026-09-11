import type { UserNotificationState } from '@shared/types'

/**
 * 平台抽象层接口 —— **所有 OS 调用的唯一入口**。
 *
 * 施工令 §4.4 铁律：`core/` 下任何文件都不得 import Electron，也不得 require koffi。
 * 这条铁律的落地方式就是这个接口：内核依赖接口，不依赖实现。
 * 于是内核可以在纯 Node 下用假实现跑单测，一行 Electron 都不需要。
 *
 * 接口刻意保持**窄**：只放 Win32 才能提供的东西。
 * 凡是 Electron 已经可靠提供的，就不要在这里再包一层——
 * 例如光标位置直接用 `screen.getCursorScreenPoint()`：它返回的就是 **DIP**，
 * 正好是命中测试与 `getBounds()` 用的同一套单位，不需要任何换算。
 * 多一层包装只会多一处会漂移的代码，不增加任何能力。
 *
 * macOS 分支留到 v0.5，此处不实现（施工令 §4.4）。
 */
export interface Platform {
  /** 实现名，用于日志与调试面板。 */
  readonly name: string

  /**
   * 查询系统级通知状态（`SHQueryUserNotificationState`）。
   *
   * 这是判断「有没有全屏应用 / 是否锁屏」的**唯一权威原语**。
   * 几何判断是错的：实测无边框窗口几何覆盖整屏时 QUNS 仍是 5（施工令 §4.3④）。
   *
   * 返回 `0`（未知）表示调用失败，调用方应保守地当作「可以活动」，
   * 而不是当作「需要静默」——否则一次调用失败会让宠物永久静默。
   */
  queryUserNotificationState(): UserNotificationState

  /**
   * 系统空闲时长（毫秒），即"用户多久没碰键鼠了"。
   *
   * ⚠️ 这是一个**聚合时长**，不含任何按键内容。本项目永不安装键鼠钩子。
   * M1 还不用它，但它是 §1.1 允许的三项信号之一，接口先立在这里，
   * 免得 M2 为了实现它而到处开洞。
   *
   * 返回 `null` 表示不可用。调用方不得假设总有值。
   */
  getIdleMilliseconds(): number | null

  /**
   * 前台窗口所属进程的**可执行文件名**（小写、不含路径），例如 `code.exe`。
   *
   * ⚠️★ **只取进程名，永不取窗口标题。** ★
   *
   * 这是 `docs/adr/0002` 与施工令 §1.1④ 的核心约束，也是本产品隐私承诺的落点：
   * 实测证明浏览器窗口标题等于网页内容摘要（`msedge :: 升级 PowerShell 并安装 rg
   * — DeepSeek Harness 和另外 5 个页面`）—— 拿到标题就等于拿到了内容级信息。
   *
   * 因此本方法**不得**调用 `GetWindowText` 一类的 API，也不得返回任何
   * 由窗口内容派生的字符串。它只回答"用户在用什么软件"，
   * 不回答"用户在看什么"。README 里对用户的原话是：
   * **"它只会认得你在用什么软件，不知道你在看什么。"**
   *
   * 返回 `null` 表示拿不到（前台窗口属于受保护进程、已退出、或调用失败）。
   * 调用方必须容忍，不得假设总有值。
   */
  getForegroundProcessName(): string | null
}

/**
 * 平台层**冒烟自检** —— 启动时真的调用一次原生接口。
 *
 * ── 为什么必须有这个 ──
 *
 * 施工令 §4.2 要求「加一个启动时真的打开一次数据库的冒烟测试——这是唯一能当场
 * 发现 ABI/预编译问题的方法」。原生 **FFI 调用**有完全一样的问题，
 * 而且更隐蔽：库名或函数名写错时错误发生在**模块求值期**，
 * 表现为启动即崩，而报错文本（`Cannot find function 'X' in shared library`）
 * **不会告诉你库名写错了**。
 *
 * 本机真的踩过一次：把 `SHQueryUserNotificationState` 挂在 `user32.dll` 上
 * （它其实在 `shell32.dll`），应用启动直接抛错。
 *
 * 所以这里做一次真实调用，验证三件事：
 * - 库能加载
 * - 函数能解析到符号
 * - 参数 marshalling 姿势正确（`_Out_` 指针必须用**数组**接收，
 *   传普通对象会抛 `Unexpected Object value, expected int *`）
 *
 * 失败时返回具体原因，由调用方**喊出来**，而不是静默降级——
 * 静默降级会把"全屏检测永远失效"变成一个没人发现的 bug。
 */
export function selfCheckPlatform(platform: Platform): {
  readonly ok: boolean
  readonly messages: string[]
} {
  const messages: string[] = []

  try {
    const state = platform.queryUserNotificationState()
    if (state === 0) {
      messages.push(
        '⚠️ queryUserNotificationState 返回 0（未知）：库与函数已解析，但调用未成功。全屏自动静默不会触发。',
      )
    } else {
      messages.push(`✓ QUNS 调用成功，当前 state=${String(state)}`)
    }
  } catch (error) {
    messages.push(`✗ queryUserNotificationState 抛异常：${String(error)}`)
    return { ok: false, messages }
  }

  try {
    const idle = platform.getIdleMilliseconds()
    if (idle === null) {
      messages.push('⚠️ getIdleMilliseconds 返回 null（会话可能已锁定），感知层将不可用。')
    } else {
      messages.push(`✓ GetLastInputInfo 调用成功，空闲 ${String(Math.round(idle / 1000))}s`)
    }
  } catch (error) {
    messages.push(`✗ getIdleMilliseconds 抛异常：${String(error)}`)
    return { ok: false, messages }
  }

  // 前台进程名也做一次真实调用。
  // 它比前两项更容易出错（要 OpenProcess + QueryFullProcessImageNameW 两步，
  // 而且受保护进程会被拒绝），所以必须当场验证而不是等用户发现"它不认得我的软件"。
  try {
    const name = platform.getForegroundProcessName()
    if (name === null) {
      messages.push('⚠️ getForegroundProcessName 返回 null（前台可能是受保护进程）——不影响运行。')
    } else {
      messages.push(`✓ 前台进程名可读：${name}`)
    }
  } catch (error) {
    messages.push(`✗ getForegroundProcessName 抛异常：${String(error)}`)
    return { ok: false, messages }
  }

  return { ok: true, messages }
}
