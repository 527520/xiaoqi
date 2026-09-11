import { hitTestPetScreenPoint } from '@shared/geometry'
import type { CursorRoute, PetGeometry, Point, Rect } from '@shared/types'

/**
 * 点击穿透的路由决策 —— **纯函数，可单测**。
 *
 * ── 为什么要有这个文件 ──
 *
 * Electron **没有逐像素点击穿透**（issue #1335 开放 11 年），
 * 而唯一能用的 `setIgnoreMouseEvents(true, { forward: true })` 在 Windows 上
 * 有一串未修复的问题：光标闪烁（#48035）、渲染进程崩溃/reload 后
 * **穿透状态卡死**（#49982）、前台是提权窗口时转发暂停（#53026）。
 *
 * 所以本项目**不依赖鼠标转发**：主进程自己轮询光标位置，
 * 用这里的纯函数算出"该不该穿透"，再翻转整窗开关。
 * 这样上面三个转发类 bug 全部免疫——因为根本没开转发。
 *
 * ⚠️ 不要"顺手"加上 `{ forward: true }`。加了它，宠物就依赖转发事件才知道
 * 光标回来了，而转发会**静默停掉**（macOS 切 Space/显示器睡眠，Windows 快速
 * reload/全屏扫描），结果是宠物永久抓不住。本方案不需要转发，因此也没有这个失效面。
 *
 * 调研再次确认了方向：openpets 与 BongoCat 两家做的都是**整窗开关**，
 * 对二者全部源码检索 `setShape|hit.?test|SetInputRegion|alpha.?mask|per.?pixel`
 * 零命中——即"逐像素命中"在成熟实现里并不存在，不要指望它。
 */

/** 把窗口矩形收缩成局部坐标系用的原点。 */
function originOf(windowBounds: Rect): Point {
  return { x: windowBounds.x, y: windowBounds.y }
}

/**
 * 决定光标当前应该路由到宠物，还是穿透到下层窗口。
 *
 * 判定顺序刻意是"先窗后形"：
 * 1. 光标不在窗口矩形内 → 必然穿透（省掉几何计算，且这是绝大多数时候的情况）。
 * 2. 光标在窗口内 → 再看是否落在**宠物可见轮廓**上。
 *    窗口比宠物大（有透明留白），那部分留白必须穿透，
 *    否则会出现"窗口挡住了下层按钮，但那里其实什么都没有"这种最典型的桌宠 bug。
 *
 * `scale` 是当前缩放。几何在设计空间里只存一份，命中判定前统一换算——
 * **漏掉这个参数**的后果很具体：宠物放大到 2 倍后，只有左上角那一小块能点，
 * 其余部分点不到（那正是 openai/codex #34227 记录的现象）。
 */
export function resolveCursorRoute(
  geometry: PetGeometry,
  windowBounds: Rect,
  screenPoint: Point,
  scale = 1,
): CursorRoute {
  const insideWindow =
    screenPoint.x >= windowBounds.x &&
    screenPoint.x < windowBounds.x + windowBounds.width &&
    screenPoint.y >= windowBounds.y &&
    screenPoint.y < windowBounds.y + windowBounds.height

  if (!insideWindow) return 'passthrough'

  return hitTestPetScreenPoint(geometry, originOf(windowBounds), screenPoint, scale)
    ? 'pet'
    : 'passthrough'
}

/**
 * 下一次需要翻转整窗开关吗？
 *
 * 抽成纯函数是为了能在单测里断言"不会重复调用 `setIgnoreMouseEvents`"——
 * 每 80ms 无脑调一次原生 API 是没必要的开销，也会让 #48035 的光标闪烁更容易出现。
 */
export function shouldFlipIgnoreMouseEvents(current: CursorRoute, next: CursorRoute): boolean {
  return current !== next
}
