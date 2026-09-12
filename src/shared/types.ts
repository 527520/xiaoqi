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
  /**
   * 头部椭圆中心与半径。
   *
   * 字段名保留 `body` 是历史原因（第一版宠物只有一个"身体"，
   * 其实那就是头）。改名会牵动命中测试、图标生成与多处测试，
   * 收益只是措辞更准，所以留名不改，由注释说明它现在是**头**。
   */
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
  /**
   * 躯干椭圆 —— 让宠物**不只是个脑袋**的关键一块。
   *
   * ⚠️ 它与 `body`（头）**相交**，这是连通性要求：`setShape` 的并集
   * 无法表达"两个分离的块"，所以任何新增部件都必须与已有部件重叠。
   */
  readonly torso: {
    readonly cx: number
    readonly cy: number
    readonly rx: number
    readonly ry: number
  }
  /** 左前腿。与躯干相交（腿根埋在躯干里）。 */
  readonly frontLegLeft: {
    readonly cx: number
    readonly cy: number
    readonly rx: number
    readonly ry: number
  }
  /** 右前腿。 */
  readonly frontLegRight: {
    readonly cx: number
    readonly cy: number
    readonly rx: number
    readonly ry: number
  }
  /** 左后腿。坐姿时收在躯干侧面，比前腿更靠外。 */
  readonly hindLegLeft: {
    readonly cx: number
    readonly cy: number
    readonly rx: number
    readonly ry: number
  }
  /** 右后腿。 */
  readonly hindLegRight: {
    readonly cx: number
    readonly cy: number
    readonly rx: number
    readonly ry: number
  }
  /** 尾巴末端圆形（宠物是**单一连通轮廓**，尾巴必须挂得住命中区）。 */
  readonly tailTip: { readonly cx: number; readonly cy: number; readonly r: number }
}

/** 椭圆形的几何参数（中心 + 双半径）。 */
export interface EllipseShape {
  readonly cx: number
  readonly cy: number
  readonly rx: number
  readonly ry: number
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

/**
 * 主进程推给渲染进程的**渲染指令**。
 *
 * ── 为什么推"指令"而不是推完整定义 ──
 *
 * `PetDefinition` 里带着整张图集的栅格契约（9 个动作的逐帧时长表）。
 * 渲染进程确实需要那份契约，但它**不该靠 IPC 传**——那份数据在
 * `@shared/petAtlas` 里是常量，两边 import 同一份才是同一个真相。
 * 传过去只会造出"两处各有一份、可能不一致"的机会。
 *
 * 所以这里只传**渲染进程无法自己知道**的东西：跑哪条后端、图集在哪。
 */
export interface PetRenderInfo {
  readonly backend: 'procedural' | 'sprite'
  /**
   * 图集的 URL（自定义协议 `xiaoqi-pet://`）；程序化后端为 null。
   *
   * 用自定义协议而不是 `file://`：渲染进程是沙箱化的，
   * 不该获得读任意文件的能力。协议处理器只放行素材目录里的三个白名单文件。
   */
  readonly sheetUrl: string | null
  /** 精灵图版本（决定用哪份栅格契约）；程序化后端为 1（无意义）。 */
  readonly spriteVersion: number
  /** 展示名（日志与调试面板用）。 */
  readonly displayName: string
}

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
  /**
   * 关系决定的**表现基调**（§5 M2 的关系层）。
   *
   * ⚠️ 它影响的是**怎么表现**（更黏人 / 更放松），
   *    **绝不**影响"是否回应"。三个取值都是更亲近，
   *    没有任何一个是"冷淡/拒绝"——见 `main/core/relationship.ts`。
   *
   * 推给渲染层的理由：关系是累积量，用户看不到数字，
   * 但应该能**感觉到**它——相处久了它会更主动地凑过来。
   */
  readonly mood: RelationshipMood
  /**
   * 当前宠物形象（哪条渲染后端、图集在哪）。
   *
   * 加进状态快照而不是单独一条 IPC：它必须与 `scale` **同时到达**——
   * 渲染进程要按"后端 + 缩放"一起决定 canvas 尺寸，分两次到达会出现
   * 一帧用正方形容器画非正方形图集的错位。
   */
  readonly pet: PetRenderInfo
}

/**
 * 关系决定的**表现基调**。
 *
 * 刻意是一个只有三个取值的联合类型，而不是一个数字区间：
 * 它的存在意义就是**没有"拒绝"这个档位**。
 * 想加"关系低就懒得理你"的人，必须先在类型里显式加一个取值——
 * 那是个会被 review 抓到的动作，而不是一行改掉的判断。
 */
export type RelationshipMood = 'reserved' | 'warm' | 'attached'

/** 核心块的种类（与 `core/memory/blocks.ts` 的 `MemoryBlockKind` 一致）。 */
export type MemoryBlockKind =
  /** 它自己是谁、什么脾气。**只描述宠物自己。** */
  | 'persona'
  /** 关于用户的稳定事实。 */
  | 'human'
  /** 当前会话状态（模式/情绪/关系基调）。 */
  | 'now'

/**
 * 账本界面用的核心块视图。
 *
 * ⚠️ 带上 `limit` 而不是让界面自己去 import `BLOCK_LIMITS`：
 *    渲染进程 import 主进程的 `core/` 是架构越界（那正是我们把
 *    蒙版编解码放进 `shared/` 的原因），而复制一份上限就是等着两边漂移。
 *    上限决定了"常驻内容吃多少 token"，漂移的代价是预算失控。
 */
export interface MemoryBlockView {
  readonly kind: MemoryBlockKind
  /** 界面上的中文名（「它自己」/「关于你」/「此刻」）。 */
  readonly label: string
  readonly content: string
  /** 字符上限。 */
  readonly limit: number
  /** 最后修改时刻（Unix 毫秒）。 */
  readonly updatedAt: number
  /**
   * 是不是**默认值**（库里没有这一行，用兜底内容顶上）。
   *
   * 界面据此提示"这条还没落库"，否则用户改完再打开会发现改动"没生效"
   * ——其实只是从没写过库。
   */
  readonly isDefault: boolean
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
  /**
   * 这条事实是不是**已被新事实取代**（双时间字段）。
   *
   * `true` 时它只出现在账本的"历史"视图里，**不会**进检索与 prompt——
   * 旧事实与新事实是互相矛盾的，两条同时进上下文等于让模型掷硬币。
   */
  readonly superseded?: boolean
  /** 取代它的那一条的 id（界面据此标出"现在信的是哪条"）。 */
  readonly supersededBy?: number
  /** 被取代的时刻（Unix 毫秒）。 */
  readonly supersededAt?: number
}
