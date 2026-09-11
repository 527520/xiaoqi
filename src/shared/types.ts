/**
 * 共享类型：主进程、preload、渲染进程三方共用的最小契约。
 *
 * 这里只放**数据结构**，不放任何带副作用的东西——
 * 它是唯一可以同时被三段进程 import 的模块。
 */

/** 整数像素/DIP 矩形。x/y 为左上角。 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 点。 */
export interface Point {
  x: number
  y: number
}

/**
 * 宠物在窗口内的几何占位。
 *
 * **这是唯一的尺寸真相来源。** 渲染层按它画，命中测试按它算——
 * 两边共用同一组数字，因此不存在"画的和点的不一致"这种漂移。
 * （该模块是纯数据，core/ 与 renderer/ 都可以 import。）
 */
export interface PetGeometry {
  /** 窗口逻辑尺寸（DIP）。 */
  readonly window: { readonly width: number; readonly height: number }
  /** 身体椭圆中心与半径。 */
  readonly body: {
    readonly cx: number
    readonly cy: number
    readonly rx: number
    readonly ry: number
  }
  /** 左耳圆形。 */
  readonly earLeft: { readonly cx: number; readonly cy: number; readonly r: number }
  /** 右耳圆形。 */
  readonly earRight: { readonly cx: number; readonly cy: number; readonly r: number }
  /** 尾巴末端圆形（宠物是**单一连通轮廓**，尾巴必须挂得住命中区）。 */
  readonly tailTip: { readonly cx: number; readonly cy: number; readonly r: number }
}

/**
 * QUNS = `SHQueryUserNotificationState` 的返回值。
 *
 * 逐值含义见施工令 §4.3④。这里的取值来自 Win32 头文件
 * `shellapi.h` 的 `QUERY_USER_NOTIFICATION_STATE` 枚举。
 */
export type UserNotificationState =
  | 1 // QUNS_NOT_PRESENT          锁屏 / 屏保 / 用户不在
  | 2 // QUNS_BUSY                 全屏应用或演示设置
  | 3 // QUNS_RUNNING_D3D_FULL_SCREEN  独占全屏
  | 4 // QUNS_PRESENTATION_MODE    演示模式
  | 5 // QUNS_ACCEPTS_NOTIFICATIONS 正常，可打扰
  | 6 // QUNS_QUIET_TIME           系统安静时段
  | 7 // QUNS_APP                  应用（UWP）模式
  | 0 // 未知 / 调用失败

/** 宠物的可见模式。三态，语义见 CONTEXT.md「静默 / 隐身」两条。 */
export type VisibilityMode =
  /** 正常：完整动画、可点击、可被看见。 */
  | 'active'
  /** 静默：仍然可见（缩成小点并呼吸），但停止动画、不打扰。全屏/锁屏时自动进入。 */
  | 'silent'
  /** 隐身：从屏幕上完全消失。用户手动触发，或屏幕共享时自动触发。 */
  | 'hidden'

/**
 * 工作模式 —— **推断结果，不是读取结果**。
 *
 * 由三项感知信号（前台进程名 / 空闲时长 / 系统级状态）+ 本地时间推出，
 * 详见 `main/core/workMode.ts`。CONENT.md 的定义是
 * 「由感知信号推断出的用户当前处境标签」。
 *
 * ⚠️ 提升准确率的唯一被允许的手段是**完善进程表**，
 *    **绝不允许**去读窗口标题（施工令 §1.1④）。
 */
export type WorkMode =
  /** 编码 */
  | 'coding'
  /** 会议 */
  | 'meeting'
  /** 邮件 */
  | 'email'
  /** 专注（长时间连续使用同一类工具，没有切换） */
  | 'focus'
  /** 休息（久未操作，或在使用娱乐应用） */
  | 'rest'
  /** 加班（工作日的工作时段之外，仍在工作） */
  | 'overtime'
  /** 下班（工作日的工作时段之外，没有在工作） */
  | 'offWork'
  /** 周末 */
  | 'weekend'

/**
 * 情绪状态（v0.1 就这 8 个，施工令 §4.6 明确「不要增加」）。
 *
 * 与工作模式的区别：工作模式描述**用户**的处境，情绪描述**宠物自己**的状态。
 */
export type Emotion =
  | 'happy'
  | 'calm'
  | 'sleepy'
  | 'focused'
  | 'aggrieved'
  | 'surprised'
  | 'close'
  | 'bored'

/**
 * 打扰级别：宠物现在允许**主动**做什么（施工令 §9 写进代码）。
 *
 * - `silent`：完全不主动，回应也压到最小（全屏、锁屏、勿扰时段）
 * - `low`：可以**回应**用户，但不主动发起（默认）
 * - `normal`：可以偶尔主动（需要用户把主动度调到阈值以上）
 *
 * ⚠️ 它**不影响"要不要回应"**：那条是 `mustRespond()` 管的，几乎恒为 true
 *    （ADR-0003 的无条件回应）。两个概念不要混。
 */
export type DisturbLevel = 'silent' | 'low' | 'normal'

/**
 * 点击穿透的路由决策。
 *
 * `'pet'`   → 光标在宠物轮廓内，窗口必须接收鼠标事件（宠物可点）。
 * `'passthrough'` → 光标不在宠物上，窗口必须让鼠标事件穿透到下层窗口。
 */
export type CursorRoute = 'pet' | 'passthrough'

/** 主进程推给渲染进程的状态快照。渲染层是纯投影，不持有真相。 */
export interface PetRuntimeState {
  readonly mode: VisibilityMode
  readonly cursorRoute: CursorRoute
  /** 宠物窗口当前所在的显示器工作区（DIP），用于放置与调试。 */
  readonly workArea: Rect
  /**
   * 主进程算出的目标帧率。
   *
   * ⚠️ 由**主进程**算而不是渲染进程自己按 `mode` 推，是刻意的：
   * 帧率预算依赖"是否正在播放交互动画"这一信息，而那个信息只有主进程
   * 完整掌握（渲染进程通过 `pet:animating` 上报，主进程汇总）。
   * 如果渲染进程按 `mode` 自行推导，就永远算不出"待机 12fps / 动画 60fps"
   * 这一档——它只看得到形态，看不到动画状态。
   *
   * 值 `0` 的语义是**停更**，不是"0fps 渲染"。
   * 落地时渲染进程要把它翻译成极低帧率：Pixi 的 `maxFPS = 0` 意思是
   * **不限帧**，直接写进去会让隐藏状态变成满帧空转。
   */
  readonly frameRate: number
  /**
   * 当前缩放倍数。窗口尺寸 = `PET_DESIGN_SIZE × scale`。
   *
   * 渲染进程按它缩放舞台，主进程按它换算命中测试——
   * 两边读**同一个值**，因此不会出现"看起来多大、能点的却是另一个大小"。
   */
  readonly scale: number
  /**
   * 光标在**宠物窗口局部坐标**（设计空间、未缩放）中的位置；远离时为 `null`。
   *
   * 用途只有一个：让它的**眼睛跟着光标转**。这是这只宠物"有生命感"的主要来源，
   * 也是它对用户最直接的一次"我注意到你了"。
   *
   * 主进程只在光标接近窗口时才推送（`null` = 够远，眼睛回正），
   * 所以这不会变成一条持续的心跳流量。
   */
  readonly cursor: Point | null
  /**
   * 当前推断出的工作模式（用户的处境）与情绪（宠物自己的状态）。
   *
   * ⚠️ 这里**只放推断结果**，不放任何原始感知输入：
   *    渲染进程拿不到进程名、空闲时长这些东西，它只需要知道
   *    "现在该摆什么表情"。把原始信号也推过去既没有用处，
   *    又白白扩大了信息暴露面。
   */
  readonly workMode: WorkMode
  readonly emotion: Emotion
  /**
   * 打扰级别：宠物现在允许**主动**做什么。
   * 渲染层据此决定要不要冒泡/出声（`silent` 与 `low` 都不主动）。
   */
  readonly disturbLevel: DisturbLevel
}

/**
 * 记忆账本里的一行（M3）。
 *
 * ── 为什么单独一个类型，而不是直接复用 `core/memory/model.ts` 的 `MemoryRecord` ──
 *
 * `MemoryRecord` 是**内部**形态：它有 `weight`（当前权重还由遗忘曲线算）、
 * `derivedFrom`（来源 id）这类实现细节。账本是给用户看的，
 * 它需要的是"这是什么、什么时候、它还记不记得住、为什么记得"，
 * 而不是一个浮点权重。
 *
 * 两者刻意不共用：内部形态一变，不该连带把界面契约也改掉。
 * 转换只发生在主进程的 IPC 处理器里，是**唯一**一处。
 */
export interface MemoryLedgerEntry {
  readonly id: number
  /** 记忆层级（情景 / 语义 / 情感）。 */
  readonly kind: 'episodic' | 'semantic' | 'emotional'
  /** 事件发生时刻（Unix 毫秒）。 */
  readonly occurredAt: number
  /** 自然语言描述。 */
  readonly content: string
  readonly tags: readonly string[]
  /** 仅情感记忆有。 */
  readonly emotion?: Emotion
  /** 仅情感记忆有：**单次**事件强度 ∈ [0,1]（ADR-0003：不做跨事件累加）。 */
  readonly intensity?: number
  /**
   * 它"记得有多牢" ∈ [0,1]，由遗忘曲线算出。
   *
   * 语义记忆恒为 1（不衰减）。给用户看这个值是为了让"遗忘"这件事**可见**——
   * 否则一条记忆某天自己消失会显得像 bug。
   */
  readonly strength: number
  /** 来源情景记忆的 id（仅语义记忆、且是推断出来的时候有）。 */
  readonly derivedFrom?: number
  /**
   * 是不是用户**手动**让它记住的（而不是它自己推断出来的）。
   *
   * 这个区分很重要：用户手写的事实不该被遗忘曲线清掉，
   * 也不该让用户以为"这是它自己总结出来的"。
   */
  readonly userAuthored: boolean
}
