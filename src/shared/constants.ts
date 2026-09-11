import type { PetGeometry } from './types'

/**
 * 宠物的几何定义 —— **唯一的尺寸真相来源**（**设计空间**坐标）。
 *
 * 渲染层（PixiJS）与命中测试（core/cursorRouter.ts）都读这一份数据，
 * 所以"看起来能点的地方"和"真的能点的地方"永远一致。
 * 改这里就是改宠物的形状，两边同时生效。
 *
 * ⚠️ 这里的坐标是 **220×220 设计空间**，不是屏幕像素。
 *    实际窗口尺寸 = 设计空间 × 缩放（见 `petWindowSize(scale)`）。
 *    命中测试**必须先缩放再换算**，否则宠物放大后会"点不到边缘"。
 *
 * 设计约束（施工令 §4.3③）：`setShape` 的矩形是**并集，无法挖洞**，
 * 因此宠物必须是**单一连通轮廓**——耳朵与尾巴在几何上必须与身体相接。
 */
export const PET_DESIGN_SIZE = 220

export const PET_GEOMETRY: PetGeometry = {
  window: { width: PET_DESIGN_SIZE, height: PET_DESIGN_SIZE },

  // 身体：**上窄下宽的蛋形**（rx 略小于 ry，重心在下）。
  //
  // 关于"像什么"的取舍：早期版本是圆身 + 两枚宽间距大圆耳，
  // 视觉上读起来像**老鼠**；只有把身体收窄、耳朵做尖并靠近，
  // 才读得出"猫"那一类。这一步完全靠截图肉眼比对调出来的，
  // 没有可自动化的判据——所以改动这里时**务必重新截图看**。
  body: { cx: 110, cy: 139, rx: 53, ry: 59 },

  // 耳朵：尖耳，与身体顶部**相交**（不是相切）以保证轮廓连通。
  earLeft: { cx: 84, cy: 90, r: 19 },
  earRight: { cx: 136, cy: 90, r: 19 },

  // 尾巴：右下角。
  //
  // 位置与大小试过四版，结论是：**尾巴要小而远**。
  // 大而贴近身体的版本，无论曲线怎么调都会与身体轮廓糊成一片，
  // 读起来像"鳍"而不是"尾巴"；小一点、离开身体一点，
  // 反而一眼就能读出"身后有条尾巴"。
  // 连通性由中心线起点埋在体内保证，不靠这个圆心。
  tailTip: { cx: 186, cy: 186, r: 16 },
}

/** 缩放档位（托盘菜单用）。1 是设计尺寸，宠物实际约 220×220 DIP。 */
export const PET_SCALE_STEPS = [0.75, 1, 1.25, 1.5, 2] as const

export type PetScale = (typeof PET_SCALE_STEPS)[number]

/** 默认缩放。 */
export const PET_SCALE_DEFAULT: PetScale = 1

/**
 * 由缩放算出**实际窗口尺寸**（DIP）。
 *
 * 唯一入口：主进程放窗、渲染进程设 canvas、命中测试换算都必须走这里，
 * 否则三处会各自取整、慢慢漂开。
 */
export function petWindowSize(scale: number): { width: number; height: number } {
  return {
    width: Math.round(PET_DESIGN_SIZE * scale),
    height: Math.round(PET_DESIGN_SIZE * scale),
  }
}

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
