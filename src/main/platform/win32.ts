import koffi from 'koffi'

import type { UserNotificationState } from '@shared/types'

import type { Platform } from './index'

/**
 * ★ 全项目**唯一**允许加载原生库的文件（施工令 §4.4 铁律）★
 *
 * 其他任何文件都不得 import koffi。这条由 eslint 的 `no-restricted-imports`
 * 自动封死（见 eslint.config.mjs），所以它不是靠自觉维持的约定。
 *
 * 这样安排有两个具体收益：
 * 1. `core/` 保持纯 TS，可以在纯 Node 下跑单测，不需要 Electron、不需要原生模块。
 * 2. 原生调用面收窄到一个文件，出事时排查范围是确定的。
 *
 * ── 本文件里两处「照直觉写会静默失效」的地方 ──
 *
 * ① `SHQueryUserNotificationState` 的返回值是 **HRESULT**（`int`），
 *    状态经 `_Out_` 指针吐出。不要写成"返回状态值"。
 *
 * ② `GetLastInputInfo` 的参数必须是 **`_Inout_`**，不能是 `_Out_`。
 *    写成 `_Out_` 会**静默返回 false 且 `cbSize` 读成 0**，不报任何错。
 *    并且必须先把 `cbSize` 填成结构体大小（8）再调用（施工令 §4.3⑤）。
 */

/** `LASTINPUTINFO`：cbSize(DWORD) + dwTime(DWORD) = 8 字节。 */
const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', {
  cbSize: 'uint32',
  dwTime: 'uint32',
})

const user32 = koffi.load('user32.dll')
// ⚠️ SHQueryUserNotificationState 在 **shell32.dll** 里，不在 user32。
//    放错库的症状是启动时抛 `Cannot find function 'SHQueryUserNotificationState'
//    in shared library` —— 一个不会指向"库名写错"的报错。
const shell32 = koffi.load('shell32.dll')
// GetTickCount64 在 **kernel32.dll** 里。
const kernel32 = koffi.load('kernel32.dll')

// 输出参数用 `_Out_ int *` + **数组**接收（`[0]`）。
// koffi 的 `_Out_` 指针需要可写目标：数组或 Buffer 都行，
// 但传普通对象 `{ value: 0 }` 会抛 `Unexpected Object value, expected int *`。
const ShQueryUserNotificationState = shell32.func(
  'int __stdcall SHQueryUserNotificationState(_Out_ int *peState)',
)

// ★ `_Inout_` 而非 `_Out_` —— 见文件头注释 ②。
const GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *plii)')

// `GetTickCount64` 返回 64 位无符号数，koffi 交回的是 JS **number**。
// 不要对它调用 BigInt()——施工令 §4.3⑤ 明确提示过。
const GetTickCount64 = kernel32.func('uint64 __stdcall GetTickCount64()')

// ── 前台进程名 ──
//
// 三步：GetForegroundWindow → GetWindowThreadProcessId → OpenProcess + QueryFullProcessImageNameW。
//
// ⚠️★ 这里**故意没有** `GetWindowTextW`。★
//    读窗口标题是本产品明令禁止的（施工令 §1.1④ / ADR-0002）：
//    实测浏览器标题就是网页内容摘要。只取进程名，不取标题——
//    这不是"暂时不做"，是产品红线，请勿添加。
const GetForegroundWindow = user32.func('uintptr __stdcall GetForegroundWindow()')
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(uintptr hWnd, _Out_ uint32 *lpdwProcessId)',
)
const OpenProcess = kernel32.func(
  'uintptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)',
)
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(uintptr handle)')
// `QueryFullProcessImageNameW` 要宽字符缓冲；`_Out_ char16_t *` + Buffer 让 koffi
// 自己处理编码（施工令附录提到 verify/ 里也是这么做的：用 Buffer 重载接收指针）。
const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(uintptr hProcess, uint32 flags, _Out_ char16_t *buf, _Inout_ uint32 *size)',
)

/** `PROCESS_QUERY_LIMITED_INFORMATION` = 0x1000，权限最小、够用。 */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** 路径缓冲：上限 32768 个 UTF-16 字符（Windows 长路径上限）的保守取值。 */
const PROCESS_PATH_CHARS = 1024

/**
 * 复用路径缓冲，避免每次轮询都分配几十 KB。
 * 感知轮询是秒级频率，但仍没必要每次都新建。
 */
const processPathBuffer = Buffer.alloc(PROCESS_PATH_CHARS * 2)
const processPathSize = [PROCESS_PATH_CHARS]

const LASTINPUTINFO_SIZE = koffi.sizeof(LASTINPUTINFO)

/**
 * 复用同一个可写结构体，避免每次轮询都分配。
 * 轮询频率是 80ms 量级，这个优化有意义（GC 压力）。
 */
const lastInputBuffer = { cbSize: LASTINPUTINFO_SIZE, dwTime: 0 }

const UNKNOWN_STATE: UserNotificationState = 0

export const win32Platform: Platform = {
  name: 'win32',

  /**
   * 查询 QUNS —— 判断「有没有全屏应用 / 是否锁屏」的**唯一权威原语**。
   *
   * ⚠️ 不要退化成几何判断：实测「无边框窗口 + 几何覆盖整个显示器」时 QUNS 仍是 5，
   * Windows 只认真正进入全屏的窗口（施工令 §4.3④）。
   * 也不要拿 `GetWindowRect` 做像素比对——它比真实可视边界大 16px（不可见调整边框），
   * 那会让判定**永远为否**。
   */
  queryUserNotificationState(): UserNotificationState {
    // 用数组接收 `_Out_` 指针的写回值。传对象会抛
    // `Unexpected Object value, expected int *`。
    const out: [number] = [0]
    try {
      const hr = ShQueryUserNotificationState(out) as unknown as number
      if (hr !== 0) return UNKNOWN_STATE
      // 显式取成 number：tsconfig 开了 noUncheckedIndexedAccess，
      // 下标访问的类型是 `number | undefined`。
      const state: number = out[0]
      if (!Number.isInteger(state) || state < 1 || state > 7) return UNKNOWN_STATE
      return state as UserNotificationState
    } catch {
      // 会话断开、窗口站不可用等情况。返回"未知"而不是抛异常，
      // 因为调用方在轮询路径上，一次失败不该中断整个宠物。
      return UNKNOWN_STATE
    }
  },

  /**
   * 系统空闲时长（毫秒）。
   *
   * 这是三项允许的感知信号之一：它只是一个**聚合时长**，
   * 不包含任何按键内容——本项目永不安装键盘钩子（施工令 §1.1③）。
   *
   * 返回 `null` 表示不可用（锁屏、会话切换等），调用方不得假设总有值。
   */
  getIdleMilliseconds(): number | null {
    lastInputBuffer.cbSize = LASTINPUTINFO_SIZE
    lastInputBuffer.dwTime = 0

    const ok = GetLastInputInfo(lastInputBuffer) as unknown as boolean
    if (!ok) return null

    const now = GetTickCount64() as unknown as number
    const idle = now - lastInputBuffer.dwTime

    // GetTickCount64 是 32 位回绕安全的，但理论上仍可能出现负值
    // （例如 dwTime 来自尚未同步的时钟）。夹到 0 比返回负数安全。
    return idle >= 0 ? idle : null
  },

  /**
   * 前台窗口所属进程的**可执行文件名**（小写、不含路径）。
   *
   * ★ 隐私红线：本函数**只读进程名，绝不读窗口标题**。★
   * 理由见 `./index.ts` 的接口注释与 `docs/adr/0002`：
   * 实测浏览器窗口标题等于网页内容摘要，拿到它等于拿到内容级信息。
   *
   * 实现要点与失败模式：
   * - `GetForegroundWindow` 可能返回 0（没有前台窗口，例如切到安全桌面）；
   * - UWP 应用的前台窗口属于 `ApplicationFrameHost`，进程名会是它而不是真实应用——
   *   这是**已知的精度损失**，接受它（不为了更准去读标题）；
   * - 提权窗口 / 受保护进程：`OpenProcess` 会被拒绝 → 返回 `null`，
   *   调用方按"未知"处理，不要报错、不要重试提权。
   */
  getForegroundProcessName(): string | null {
    let handle = 0
    try {
      const hwnd = GetForegroundWindow() as unknown as number
      if (!hwnd) return null

      const pidOut: [number] = [0]
      GetWindowThreadProcessId(hwnd, pidOut)
      const pid: number = pidOut[0]
      if (!pid) return null

      // koffi 的 `uintptr` 返回 number（不是 bigint），所以这里不需要断言。
      handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as number
      if (!handle) return null // 受保护进程会被拒绝——这是正常的，不是错误

      processPathBuffer.fill(0)
      processPathSize[0] = PROCESS_PATH_CHARS
      const ok = QueryFullProcessImageNameW(handle, 0, processPathBuffer, processPathSize) as
        | boolean
        | number
      if (!ok) return null

      // `size` 被写回成**不含结尾 NUL 的字符数**。
      const chars: number = processPathSize[0]
      if (!chars) return null
      const fullPath = processPathBuffer.toString('utf16le', 0, chars * 2)

      // 只取文件名部分。同时兼容 `\` 与 `/`（后者理论上有，防呆）。
      const lastSep = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'))
      const name = lastSep >= 0 ? fullPath.slice(lastSep + 1) : fullPath
      return name ? name.toLowerCase() : null
    } catch {
      // 会话切换、句柄失效等。返回 null 而不是抛异常：
      // 调用方在轮询路径上，一次失败不该中断整个宠物。
      return null
    } finally {
      // 句柄必须关，否则每秒轮询会稳定泄漏内核对象。
      if (handle) {
        try {
          CloseHandle(handle)
        } catch {
          // 关闭失败无可挽回，忽略。
        }
      }
    }
  },
}
