/**
 * 光照模型 —— **纯函数，可单测**。
 *
 * ── 为什么把光照抽成纯函数 ──
 *
 * "立体感"不是一种感觉，它是四个**可计算的量**：
 *
 * | 量 | 作用 | 少了它会怎样 |
 * |---|---|---|
 * | 漫反射 | 明暗交界线 | 平涂，没有体积 |
 * | 半球环境光 | 暗部不是死黑，上冷下暖 | 像剪纸上色 |
 * | 轮廓光 | 把角色从背景"剪"出来 | 边缘糊进壁纸 |
 * | 高光 | 材质感（眼睛是玻璃、身体是哑光） | 像塑料片 |
 *
 * 这些量的**方向性**是可以断言的（"光源右上时，右上必须比左下亮"），
 * 而"看起来立不立体"不能断言。所以把可断言的那一半抽到这里，
 * 用单测钉死方向与边界，着色器只负责把同样的算式搬到 GPU 上。
 *
 * ⚠️ 着色器里的 GLSL 是这份逻辑的**另一份实现**（无法共享代码）。
 *    改动这里的公式时**必须同步改 `petShader.ts`**，否则 CPU 侧的测试
 *    会在验证一个 GPU 上并不成立的结论。这条是这一层最大的风险，
 *    所以在两个文件里都写了同样的提醒。
 */

/** 单位向量。 */
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * 设计空间里的法线参数：把一块平面区域当作椭球表面。
 *
 * 宠物是程序化几何角色，形状本来就是圆/椭圆，所以**法线可以解析求出**，
 * 不需要法线贴图：
 *
 *     n = normalize(vec3((p - c) / r, sqrt(1 - |(p - c) / r|²)))
 *
 * 也就是说：距离中心越远，法线越"侧过去"，受光越少 —— 这正是球体的
 * 受光方式。这一步是"平面图形变成有体积的东西"的关键。
 */
export interface EllipsoidSurface {
  readonly cx: number
  readonly cy: number
  /** 横向半径。 */
  readonly rx: number
  /** 纵向半径。 */
  readonly ry: number
}

/**
 * 光源方向（设计空间，**已归一化**）。
 *
 * 全局唯一光源，固定**右上方**。统一光源是"看起来像一个物体"的前提：
 * 多个方向的光会让不同部件的明暗互相矛盾，大脑立刻读成"拼贴"。
 */
export const KEY_LIGHT: Vec3 = normalize({ x: 0.55, y: -0.62, z: 0.56 })

/**
 * 观察方向。桌面宠物是正交视角、正对着看，所以视线就是 +z。
 */
export const VIEW_DIR: Vec3 = { x: 0, y: 0, z: 1 }

/** 归一化（零向量返回 +z，避免除零产生 NaN 污染整条着色链路）。 */
export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  if (len < 1e-6) return { x: 0, y: 0, z: 1 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * 由椭圆内的位置求**假想球面法线**。
 *
 * @param point 设计空间坐标
 * @param surface 椭球参数
 * @returns 单位法线；点在椭球外时返回到中心的方向（**不返回 NaN**）
 *
 * ── 为什么越界要显式处理 ──
 *
 * `sqrt(负数)` 是 NaN，而 NaN 在着色链路里会**扩散**：一个像素的 NaN
 * 乘以任何颜色都是 NaN，最终表现是整块区域变黑或闪烁，且完全不报错。
 * 所以这里把"椭圆外"钳到边缘（z=0 的侧向法线），是**有意的容错**：
 * 边缘像素读起来是"最暗的侧面"，比 NaN 好得多。
 */
export function surfaceNormal(point: { x: number; y: number }, surface: EllipsoidSurface): Vec3 {
  const nx = (point.x - surface.cx) / surface.rx
  const ny = (point.y - surface.cy) / surface.ry
  const r2 = nx * nx + ny * ny

  if (!Number.isFinite(r2)) return VIEW_DIR
  if (r2 >= 1) {
    // 边缘：z = 0，法线完全侧向（最暗）
    return normalize({ x: nx, y: ny, z: 0 })
  }
  return normalize({ x: nx, y: ny, z: Math.sqrt(1 - r2) })
}

/** 着色结果，各分量都已夹到 [0,1]。 */
export interface Shading {
  /** 漫反射强度 ∈ [0,1]。 */
  readonly diffuse: number
  /** 半球环境光强度 ∈ [0,1]（已按法线的上下混合冷暖，这里给的是**亮度**）。 */
  readonly ambient: number
  /** 轮廓光强度 ∈ [0,1]。 */
  readonly rim: number
  /** 高光强度 ∈ [0,1]。 */
  readonly specular: number
}

/** 材质参数。不同部件用不同参数，才有"眼睛是玻璃、身体是磨砂"的区别。 */
export interface Material {
  /** 高光锐利度（等价于 Blinn-Phong 的指数）。越大越像镜面。 */
  readonly shininess: number
  /** 高光强度倍数。 */
  readonly specularStrength: number
  /** 轮廓光强度倍数。 */
  readonly rimStrength: number
  /** 环境光遮蔽强度倍数（凹陷处压暗的程度）。 */
  readonly occlusion: number
}

/** 磨砂身体：高光散而弱、轮廓光中等。 */
export const BODY_MATERIAL: Material = {
  shininess: 16,
  specularStrength: 0.22,
  rimStrength: 0.5,
  occlusion: 1,
}

/**
 * 玻璃质感眼睛：高光**锐而强**。
 *
 * 与身体的差别主要来自 `specularStrength`（0.22 → 0.9，约 4 倍）而不是
 * 指数：指数只改变高光的**大小**，强度才决定"像不像反光材质"。
 */
export const EYE_MATERIAL: Material = {
  shininess: 64,
  specularStrength: 0.9,
  rimStrength: 0.15,
  occlusion: 0.4,
}

/** 耳朵内侧：更柔软、几乎不反光。 */
export const INNER_MATERIAL: Material = {
  shininess: 8,
  specularStrength: 0.06,
  rimStrength: 0.7,
  occlusion: 1.2,
}

/** 环境光的下限与上限（朝下 / 朝上）。 */
export const AMBIENT_GROUND = 0.32
export const AMBIENT_SKY = 0.78

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 主光的**镜面反射方向**，即高光最亮的那个法线朝向。
 *
 * 单独导出是为了让"高光出现在该出现的地方"可被断言：
 * Blinn-Phong 的峰值在 `normal == normalize(L + V)`，**不是** `normal == L`。
 * 第一版测试就是错把这个位置当成了 `L`，于是断言了一个模型从不产生的值。
 */
export function highlightNormal(light: Vec3 = KEY_LIGHT): Vec3 {
  const l = normalize(light)
  return normalize({ x: l.x + VIEW_DIR.x, y: l.y + VIEW_DIR.y, z: l.z + VIEW_DIR.z })
}

/**
 * 算一个法线处的着色。
 *
 * @param normal 单位法线
 * @param material 材质
 * @param light 光源方向（默认全局主光）
 */
export function shade(
  normal: Vec3,
  material: Material = BODY_MATERIAL,
  light: Vec3 = KEY_LIGHT,
): Shading {
  const n = normalize(normal)
  const l = normalize(light)

  // ① 漫反射：明暗交界线来自这一项。
  //    刻意用纯 Lambert 而不是半兰伯特：半兰伯特会把背光面也提亮，
  //    于是**明暗交界线消失**，而交界线正是球体感的来源。
  const diffuse = clamp01(dot(n, l))

  // ② 半球环境光：朝上的面接天光（亮），朝下的面接地面反弹（暗）。
  //
  // ⚠️ **符号是个坑**：设计空间 y 轴**向下**（屏幕坐标系），所以"朝上"
  //    对应 `n.y < 0`。第一版写成 `n.y * 0.5 + 0.5`，把上下面**接反了**——
  //    后果是下巴比额头亮，看起来像从地板打光。是单测里
  //    「朝上比朝下亮」那条把它抓出来的。
  const upward = clamp01(-n.y * 0.5 + 0.5)
  const ambient = AMBIENT_GROUND + upward * (AMBIENT_SKY - AMBIENT_GROUND)

  // ③ 轮廓光：法线越垂直于视线，越靠近边缘 → 越亮。
  //    指数 2.5 让亮边**窄**；太宽会变成一圈发光的描边，很廉价。
  const rim = clamp01(Math.pow(1 - clamp01(dot(n, VIEW_DIR)), 2.5)) * material.rimStrength

  // ④ 高光：Blinn-Phong（半程向量）。
  //
  // ⚠️ 必须做**归一化**。裸的 `dot(n,h)^s` 在 s 稍大时就塌成 0：
  //    在正对观察者的球面上，半程向量与法线的夹角下限约 50°，
  //    s=90 时 `cos(50°)^90 ≈ 1e-7` —— 高光**实际上不存在**。
  //    （第一版就是这样，单测报 `expected 1.3e-8 to be greater than 0.4`。）
  //    乘 `(s+8)/(8π)` 是 Blinn-Phong 的标准归一化，让"强度"与"锐利度"
  //    可以独立调节。
  const half = highlightNormal(l)
  const specular =
    clamp01(Math.pow(Math.max(0, dot(n, half)), material.shininess)) *
    material.specularStrength *
    ((material.shininess + 8) / (8 * Math.PI))

  return { diffuse, ambient, rim, specular }
}

/**
 * 把着色合成成**亮度倍数**（1 = 原色，<1 变暗，>1 提亮）。
 *
 * 单列一个函数是为了让"整体明暗是否合理"可被断言：
 * 亮度永远不该为负，也不该把中间调烧成纯白（那会丢掉所有体积信息）。
 */
export function luminanceFactor(shading: Shading, material: Material = BODY_MATERIAL): number {
  const value =
    shading.ambient + shading.diffuse * 0.85 + shading.rim + shading.specular * material.occlusion
  // 上限 1.6：允许高光提亮，但不允许烧白到看不见形。
  return Math.min(1.6, Math.max(0, value))
}

/**
 * 接触阴影：物体贴地处的软阴影强度。
 *
 * @param distanceFromGround 距地面（设计空间像素）
 * @param radius 阴影半径（像素）
 *
 * 与"投影"不同，接触阴影只负责**接地感**——没有它，宠物看起来是浮在
 * 桌面上的贴纸。衰减用平方，让核心更实、边缘更虚。
 */
export function contactShadowAlpha(distanceFromGround: number, radius: number): number {
  if (radius <= 0 || !Number.isFinite(distanceFromGround)) return 0
  const t = clamp01(1 - distanceFromGround / radius)
  return t * t * 0.42
}

/**
 * 环境光遮蔽：两个部件交叠处（耳根、尾根、下巴）压暗的强度。
 *
 * @param distance 到交叠处的距离（设计空间像素）
 * @param falloff 衰减半径
 *
 * ★ 这一项是"组装感"与"长在一起"的分界：没有 AO，耳朵和身体只是两个
 *   前后叠放的图形；有了 AO，交叠处变暗，读起来才是"从身体里长出来的"。
 */
export function occlusionAt(distance: number, falloff: number): number {
  if (falloff <= 0 || !Number.isFinite(distance)) return 0
  const t = clamp01(1 - distance / falloff)
  // 平滑衰减（smoothstep），避免出现硬边
  return t * t * (3 - 2 * t)
}
