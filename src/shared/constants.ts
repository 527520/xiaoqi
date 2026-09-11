import type { PetGeometry } from './types'

/**
 * 宠物的几何定义 —— **唯一的尺寸真相来源**。
 *
 * 渲染层（PixiJS）与命中测试（core/petHitTest.ts）都读这一份数据，
 * 所以"看起来能点的地方"和"真的能点的地方"永远一致。
 * 改这里就是改宠物的大小，两边同时生效。
 *
 * 设计约束（施工令 §4.3③）：`setShape` 的矩形是**并集，无法挖洞**，
 * 因此宠物必须是**单一连通轮廓**——耳朵与尾巴在几何上必须与身体相接，
 * 否则那部分会在某些未来方案下被切掉。
 */
export const PET_GEOMETRY: PetGeometry = {
  window: { width: 220, height: 220 },

  // 身体：略高于宽的蛋形。比正圆更有"活物"感，也留出下方空间放影子。
  body: { cx: 110, cy: 138, rx: 56, ry: 60 },

  // 耳朵：小圆耳，与身体顶部**相交**（不是相切）以保证轮廓连通。
  //
  // 半径刻意取小（20）。早期用 r=26 且间距更宽时，
  // 双耳+圆身读起来像"老鼠"而不是"猫/狐"——图标实测后调小的。
  earLeft: { cx: 80, cy: 86, r: 20 },
  earRight: { cx: 140, cy: 86, r: 20 },

  // 尾巴：右下角一团，与身体右侧**相交**（中心距 < rx + r）。
  // 位置压低到 cy 下方，这样它读起来像"从身后探出的尾巴"而不是"侧面的瘤"。
  tailTip: { cx: 172, cy: 166, r: 18 },
}

/** 宠物窗口的透明留白：窗口比宠物大，多出来的部分是纯透明、必须穿透。 */
export const PET_WINDOW_SIZE = {
  width: PET_GEOMETRY.window.width,
  height: PET_GEOMETRY.window.height,
} as const

/** 宠物相对工作区右/下边缘的默认间距（DIP）。 */
export const PET_MARGIN = 24

/**
 * 帧率档位（施工令 §4.3⑩：待机时必须降帧，不要常驻 60fps；§9.6 耗电是隐形差评源）。
 *
 * 调研补充证据：BongoCat 的 Steam 讨论区有「serious optimisation issues」
 * 与「makes my PC die」两条主题，说明「默认 60fps + 高频 ticker」确有口碑风险。
 * 本项目因此把帧率当一等参数，而不是常量。
 */
export const FRAME_RATE = {
  /** 有交互动画（被点、情绪切换）时的帧率。 */
  active: 60,
  /**
   * 待机呼吸动画的帧率。
   *
   * 施工令 §4.3⑩ 的硬要求是**待机 ≤10fps**（原话：「待机时必须降帧（≤10fps）
   * 或暂停渲染循环。**不要常驻 60fps。**」）。
   * 呼吸周期 2.6s，8fps 下每周期约 21 帧，已经足够平滑；再高就是纯粹烧电。
   */
  idle: 8,
  /** 静默态（缩成小点）时的帧率：几乎不动。 */
  silent: 4,
} as const

/** 点击穿透轮询间隔（毫秒）。施工令 §4.3③ 建议约 60–100ms。 */
export const CURSOR_POLL_INTERVAL_MS = 80

/**
 * QUNS 轮询间隔（毫秒）。全屏切换不需要秒级响应，2s 足够且省电。
 *
 * 注意这与「置顶重断言」是两件事，不要合并：全屏状态可以 2s 才看一次，
 * 而 TOPMOST 被 Shell 剥夺后必须尽快抢回来（见 `TOPMOST_REASSERT_INTERVAL_MS`）。
 */
export const QUNS_POLL_INTERVAL_MS = 2000

/**
 * 置顶重断言间隔（毫秒）。
 *
 * ⚠️ 这条是调研挖出来的 Windows 硬坑，不写就会静默失效：
 * Shell 在别的应用进入全屏（浏览器视频、游戏）时会**静默剥夺**其他窗口的
 * `HWND_TOPMOST` 且**不恢复、不触发任何 Electron 事件**——所以"在 show/resize 时
 * 重新断言置顶"这种直觉做法根本不会跑，宠物会被永久埋在下面。
 * openpets 的结论是 Shell 约每 2–4s 扫一次，取 1s 节奏可把"被埋"窗口压到 1s 内。
 *
 * 另一个陷阱：Electron 在**缓存状态与目标一致时会短路** `setAlwaysOnTop(true)`，
 * 调用根本到不了 OS。所以重断言前必须先 `setAlwaysOnTop(false)` 做 cache-bust。
 *
 * 不学 BongoCat 的 16ms 循环：那是持续的 CPU/消息开销，
 * 且已被自己记录下"右键菜单被自己的置顶窗盖住"的副作用。
 */
export const TOPMOST_REASSERT_INTERVAL_MS = 1000

/** 进入/退出静默需要连续命中的轮询次数，避免全屏切换瞬间的抖动。 */
export const QUNS_DEBOUNCE_COUNT = 2
