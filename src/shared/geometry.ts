import type { PetGeometry, Point, Rect, UserNotificationState } from './types'

/**
 * 纯几何/纯判定的共享逻辑。
 *
 * 这些函数**故意不依赖任何东西**——不依赖 Electron、不依赖 koffi、不依赖 DOM，
 * 所以它们可以在纯 Node 下被单测覆盖，也同时被主进程与渲染进程复用。
 * "渲染看到的形状"与"命中测试算的形状"因此不可能漂移。
 */

/** 点是否落在椭圆内（含边界）。 */
export function pointInEllipse(
  point: Point,
  ellipse: { cx: number; cy: number; rx: number; ry: number },
): boolean {
  if (ellipse.rx <= 0 || ellipse.ry <= 0) return false
  const dx = (point.x - ellipse.cx) / ellipse.rx
  const dy = (point.y - ellipse.cy) / ellipse.ry
  return dx * dx + dy * dy <= 1
}

/** 点是否落在圆内（含边界）。 */
export function pointInCircle(
  point: Point,
  circle: { cx: number; cy: number; r: number },
): boolean {
  if (circle.r <= 0) return false
  const dx = point.x - circle.cx
  const dy = point.y - circle.cy
  return dx * dx + dy * dy <= circle.r * circle.r
}

/**
 * 把**设计空间**的几何按缩放换算到**窗口局部坐标**。
 *
 * ⚠️ 这是宠物可缩放之后新加的必经一步，漏掉它的后果很具体：
 * 宠物放大到 2 倍后，命中测试仍在用设计空间的坐标，
 * 于是**只有左上角那一小块能点**，其余部分点不到——
 * 正是 openai/codex 桌宠 #34227 记录的那类"命中区与形象脱节"。
 *
 * 命中测试与渲染都从这一份缩放后的几何出发，因此不会各算各的。
 */
export function scalePetGeometry(geometry: PetGeometry, scale: number): PetGeometry {
  const s = (value: number): number => value * scale
  return {
    window: { width: s(geometry.window.width), height: s(geometry.window.height) },
    body: {
      cx: s(geometry.body.cx),
      cy: s(geometry.body.cy),
      rx: s(geometry.body.rx),
      ry: s(geometry.body.ry),
    },
    earLeft: { cx: s(geometry.earLeft.cx), cy: s(geometry.earLeft.cy), r: s(geometry.earLeft.r) },
    earRight: {
      cx: s(geometry.earRight.cx),
      cy: s(geometry.earRight.cy),
      r: s(geometry.earRight.r),
    },
    tailTip: { cx: s(geometry.tailTip.cx), cy: s(geometry.tailTip.cy), r: s(geometry.tailTip.r) },
  }
}

/**
 * 点是否落在宠物的**可见轮廓**内。
 *
 * 轮廓 = 身体椭圆 ∪ 双耳 ∪ 尾巴（施工令 §4.3③：`setShape` 的矩形是并集、
 * 无法挖洞，所以宠物必须是**单一连通轮廓**；这里的并集形式与之一致）。
 *
 * `point` 用**窗口局部坐标**（DIP），且 `geometry` 必须已经是**缩放后**的
 * （见 `scalePetGeometry`）。调用方负责把屏幕坐标翻译过来。
 */
export function hitTestPet(geometry: PetGeometry, point: Point): boolean {
  return (
    pointInEllipse(point, geometry.body) ||
    pointInCircle(point, geometry.earLeft) ||
    pointInCircle(point, geometry.earRight) ||
    pointInCircle(point, geometry.tailTip)
  )
}

/**
 * 把屏幕坐标（DIP）翻译成窗口局部坐标（DIP），**按缩放换算几何**，再判命中。
 *
 * 这是主进程与渲染层共用的**唯一**命中判定入口。`scale` 由调用方给出
 * （主进程知道自己设了多大），几何在设计空间里保持一份，避免两处漂移。
 *
 * ⚠️ 历史教训（写在这里防止以后有人"优化"掉它）：
 * openai/codex 的桌面宠物有多个公开 bug 都是"命中区与可见形象脱节"
 * （#42190 拖动/缩放后穿透到底下窗口、#34227 运行数小时后只有上半身可点）。
 * 根因是命中区与渲染各算各的。本函数是唯一判定入口 + 几何来自
 * `shared/constants.ts` 的单一真相 + 缩放走同一个 `scalePetGeometry`，
 * 就是为了从结构上排除这类漂移。
 */
export function hitTestPetScreenPoint(
  geometry: PetGeometry,
  windowOrigin: Point,
  screenPoint: Point,
  scale = 1,
): boolean {
  return hitTestPet(scalePetGeometry(geometry, scale), {
    x: screenPoint.x - windowOrigin.x,
    y: screenPoint.y - windowOrigin.y,
  })
}

/**
 * QUNS → 是否需要静默。
 *
 * `{1,2,3,4}` = 锁屏/屏保、全屏应用或演示、独占全屏、演示模式 → 一律静默
 * （施工令 §4.3④，这是刻意的合并：这四种状态下用户都不希望被打扰）。
 *
 * `0`（调用失败/未知）**不算静默**。这是刻意的不对称：
 * 一次原生调用失败若被当成静默，宠物会永久缩成小点且用户无法理解原因；
 * 反过来只是多存在一会儿，代价小得多。
 */
export function shouldSilence(state: UserNotificationState): boolean {
  return state === 1 || state === 2 || state === 3 || state === 4
}

/** QUNS 取值的可读名字，仅用于日志与调试面板。 */
export function describeUserNotificationState(state: UserNotificationState): string {
  switch (state) {
    case 1:
      return 'QUNS_NOT_PRESENT（锁屏/屏保，用户不在）'
    case 2:
      return 'QUNS_BUSY（全屏应用或演示设置）'
    case 3:
      return 'QUNS_RUNNING_D3D_FULL_SCREEN（独占全屏）'
    case 4:
      return 'QUNS_PRESENTATION_MODE（演示模式）'
    case 5:
      return 'QUNS_ACCEPTS_NOTIFICATIONS（正常，可打扰）'
    case 6:
      return 'QUNS_QUIET_TIME（系统安静时段）'
    case 7:
      return 'QUNS_APP（应用模式）'
    default:
      return '未知（调用失败）'
  }
}

/** 矩形是否包含某点（含边界）。 */
export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}
