import { CELL_HEIGHT, CELL_WIDTH, type CodexAnimationName } from '@shared/petAtlas'

/**
 * 精灵图的 **alpha 命中蒙版** —— 纯数据 + 纯函数，可单测。
 *
 * ── 为什么需要它 ──
 *
 * 程序化小奇的命中测试用的是 `PET_GEOMETRY` 的椭圆并集，那是**已知几何**。
 * 但精灵图的剪影是**不规则的 alpha**：一只坐着的猫、一只奔跑的猫、
 * 中间帧与边缘帧的占地形状都不同。用几何表达不了，用整格矩形又会
 * 让"透明的地方也挡住下层窗口"——那正是 `cursorRouter.ts` 里记过的
 * 最典型桌宠 bug。
 *
 * ── 方案：把剪影下采样成位图，从渲染进程推给主进程 ──
 *
 * 图集在**渲染进程**里被解码（那里本来就有图），顺手把 alpha 下采样成点阵，
 * 一次 IPC 推给主进程，之后每次光标轮询只需查一位。
 *
 * 因此这个文件在 `shared/`：**渲染进程编码、主进程解码**，两边必须用同一套
 * 网格定义与位序。放在任一侧都会出问题——渲染器不能 import `src/main/`
 * （`tsconfig.web.json` 里根本没有 `@main` 别名），而复制一份常量
 * 就是等着两边漂移。
 *
 * ── 为什么按**动作**而不是按**帧**存蒙版 ──
 *
 * 逐帧存要 51 张蒙版（V2 全部有效格），而**同一动作内各帧的剪影高度重合**
 * （角色的站姿不变，只有四肢/道具在动）。按动作存：
 *   - 数据量降一个数量级；
 *   - 代价是"抬手那一帧的指尖点不到"。对桌宠可接受。
 *
 * ⚠️ 这个取舍是**有意的**，写在 `docs/verify-sprite.md` 里，不假装逐帧精确。
 */

/**
 * 蒙版点阵的列数 / 行数。
 *
 * ── 这两个数是怎么定的 ──
 *
 * 取 13 列 × 16 行，因为格子是 **192×208**，于是
 *
 *     192 / 13 ≈ 14.8 像素/点      208 / 16 = 13 像素/点
 *
 * **横向与纵向的点尺寸几乎相等**（14.8 vs 13），点阵不会被拉成
 * 明显偏长的长方形。这一点比"整除"更重要：点若一边 16 像素、一边 8 像素，
 * 判定区就会在某个方向上系统性偏胖或偏瘦，表现为"明明点在猫身上却穿透"。
 *
 * 13 列的行数据是 `ceil(13/4) = 4` 个十六进制字符（16 位，用掉 13 位），
 * 16 行 → 每个动作 16×4 = 64 字符。9 个动作合计约 600 字节，
 * 一次 IPC 绰绰有余 —— 所以这里可以放心用比"够用就行"更细的网格。
 *
 * ⚠️ 改这两个数只需改这里：`MASK_ROW_HEX_LEN` 与主进程的换算都是推出来的。
 */
export const MASK_COLS = 13
export const MASK_ROWS = 16

/** 一行蒙版的十六进制字符数（`ceil(COLS / 4)`，每位十六进制放 4 列）。 */
export const MASK_ROW_HEX_LEN = Math.ceil(MASK_COLS / 4)

/**
 * 光标是否落在剪影上的 α 阈值。
 *
 * 抗锯齿会在剪影外缘留一圈 alpha 1–40 的像素。若用 `> 0`，剪影会
 * **向外胖一圈**，透明的边角被算成可点——而"透明白边挡住下层窗口"
 * 正是我们最想避免的那个 bug。取 128（半透明）让边界落在真正的轮廓上。
 *
 * 放在 `shared/` 而不是渲染器里：`scripts/verify-sprite.mjs` 要用同一个数
 * 复算蒙版并比对，两处不同的阈值会让"验证通过"变成假象。
 */
export const ALPHA_THRESHOLD = 128

/**
 * 一个动作的蒙版。
 *
 * `rows[y]` 是长度 `MASK_ROW_HEX_LEN` 的十六进制字符串。
 * 位序：**低位对应左列**（第 0 列 = 最低位），与屏幕坐标的 x 方向一致。
 */
export interface AnimationMask {
  readonly rows: readonly string[]
}

/**
 * 蒙版覆盖的区域（相对格子左上角，单位：精灵像素）。
 *
 * ── 为什么需要偏移与尺寸，而不是直接铺满整格 ──
 *
 * 一张 192×208 的格里，宠物通常只占中间一块（四周是透明留白）。
 * 若把点阵铺满整格，13×16 个点里有一批浪费在永远点不到的空白上，
 * 真正贴着轮廓的点就变少了。
 *
 * 由**渲染进程**在提取时按实际内容算出这块区域（见
 * `src/renderer/src/pet/spriteMask.ts` 的 `selectMaskGrid`），随蒙版一起送来。
 * 主进程不重新计算，只按同一套映射把光标坐标换算过来 ——
 * 于是编码端与解码端不可能用不同的网格。
 */
export interface MaskGrid {
  /** 左边界（相对格子，精灵像素）。 */
  readonly x: number
  /** 上边界（相对格子，精灵像素）。 */
  readonly y: number
  /** 覆盖宽度（精灵像素）。 */
  readonly width: number
  /** 覆盖高度（精灵像素）。 */
  readonly height: number
}

/** 整套蒙版：按动作索引。 */
export interface SpriteMask {
  readonly kind: 'sprite'
  readonly atlasVersion: number
  /** 所有动作共用的点阵区域。 */
  readonly grid: MaskGrid
  readonly masks: Readonly<Partial<Record<CodexAnimationName, AnimationMask>>>
}

/** 铺满整格的默认区域（`extractSpriteMask` 在算不出内容边界时的兜底）。 */
export const FULL_CELL_GRID: MaskGrid = {
  x: 0,
  y: 0,
  width: CELL_WIDTH,
  height: CELL_HEIGHT,
}

const HEX_DIGITS = /^[0-9a-f]+$/

/** 把一行的十六进制串解成布尔数组。长度不足时右侧补 false，非法输入全 false。 */
export function decodeMaskRow(hex: string): boolean[] {
  const value = HEX_DIGITS.test(hex) ? Number.parseInt(hex, 16) : Number.NaN
  const bits: boolean[] = []
  for (let x = 0; x < MASK_COLS; x++) {
    if (!Number.isFinite(value)) {
      bits.push(false)
      continue
    }
    bits.push(((value >> x) & 1) === 1)
  }
  return bits
}

/** 把布尔数组编成十六进制串（低位 = 左列），左侧补零到固定长度。 */
export function encodeMaskRow(bits: readonly boolean[]): string {
  let value = 0
  for (let x = 0; x < bits.length && x < MASK_COLS; x++) {
    if (bits[x]) value |= 1 << x
  }
  return value.toString(16).padStart(MASK_ROW_HEX_LEN, '0')
}

/**
 * 光标是否落在这一动作的剪影上。
 *
 * @param mask 该动作的蒙版；`undefined` = 没有蒙版 → **一律算穿透**
 * @param localX 相对窗口左上角的 X（DIP）
 * @param localY 相对窗口左上角的 Y（DIP）
 * @param windowWidth 窗口宽（DIP，= 格宽 × 缩放）
 * @param windowHeight 窗口高（DIP，= 格高 × 缩放）
 * @param grid 点阵区域（随蒙版一起来）
 *
 * ── 换算为什么这样写 ──
 *
 * 窗口里的一点 → 格子里的点：窗口就是整格等比放大，所以
 * `格子x = localX × 格宽 / 窗口宽`。再用 `grid.x` 减掉点阵左边界，
 * 除以 `格宽 / 列数` 得到列号。
 *
 * 这里**不出现缩放倍数**：它隐含在"窗口宽 vs 格宽"的比值里。
 * 于是 100% 与 200% 缩放下判定形状完全一致，不需要另一条分支。
 *
 * ── ★ 没有蒙版时返回 false（穿透），这是**安全侧** ──
 *
 * 蒙版要经过"解码 → 下采样 → IPC"才到主进程。在它到达之前的那个窗口期里，
 * 若默认判"可点"，宠物会**挡住下层窗口却点不动**——用户会以为应用卡死，
 * 那是直接卸载级别的故障。反过来，默认穿透只是"宠物暂时点不到"，
 * 而它本来也只有几百毫秒。
 *
 * @returns 落在剪影上返回 true
 */
export function hitTestSpriteMask(
  mask: AnimationMask | undefined,
  localX: number,
  localY: number,
  windowWidth: number,
  windowHeight: number,
  grid: MaskGrid,
): boolean {
  if (!mask) return false
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) return false
  if (!(windowWidth > 0) || !(windowHeight > 0)) return false
  if (!(grid.width > 0) || !(grid.height > 0)) return false

  // 窗口外直接穿透（省掉查表；绝大多数时候是这种情况）
  if (localX < 0 || localY < 0 || localX >= windowWidth || localY >= windowHeight) return false

  // 窗口局部 DIP → 点阵坐标（精灵像素）
  const spriteX = (localX * CELL_WIDTH) / windowWidth
  const spriteY = (localY * CELL_HEIGHT) / windowHeight

  const col = Math.floor((spriteX - grid.x) / (grid.width / MASK_COLS))
  const row = Math.floor((spriteY - grid.y) / (grid.height / MASK_ROWS))
  if (col < 0 || row < 0 || col >= MASK_COLS || row >= MASK_ROWS) return false

  const hex = mask.rows[row]
  if (hex === undefined) return false
  if (!HEX_DIGITS.test(hex)) return false
  return ((Number.parseInt(hex, 16) >> col) & 1) === 1
}

/**
 * 某个动作的蒙版是否**结构可用**（行数正确、每行长度正确、只含十六进制）。
 *
 * 单独一个函数是因为调用方需要区分"这个动作没蒙版"与"蒙版说光标不在剪影上"：
 * 前者应回落到几何判定（如果有），后者就是穿透。
 *
 * 校验放在这里而不是只靠 `validateMask`：`validateMask` 只在收到 IPC 的那一刻
 * 跑一次，而每次光标轮询都会问"这个动作有没有蒙版"。
 */
export function hasMask(mask: SpriteMask | null, animation: CodexAnimationName): boolean {
  if (!mask) return false
  const entry = mask.masks[animation]
  if (entry?.rows.length !== MASK_ROWS) return false
  return entry.rows.every((row) => row.length === MASK_ROW_HEX_LEN && HEX_DIGITS.test(row))
}

/**
 * 校验一份蒙版是否可用。
 *
 * 与 `validateAtlas` 同一套思路：**宽容但不含糊**。结构不对就整体拒收
 * （回落到几何判定），因为半张蒙版会让命中区在某些动作下神秘缺失；
 * 但只要结构成立，内容再稀疏也照用。
 *
 * ⚠️ 入参是 `unknown` 且下面几条 `typeof` 检查看起来"多余"（TS 认为
 *    非空对象必有 `masks`）。它们**不多余**：这个函数就是 IPC 的入口，
 *    运行时真的可能收到数组、字符串、缺字段的对象。喂给它任何东西都
 *    不许抛错——抛错的位置在每 80ms 跑一次的光标轮询里。
 */
// The four `typeof` guards below look redundant to TypeScript (a non-null object
// "must" have `masks`/`grid`), but this function is the IPC entry point: it can
// genuinely receive an array, a string, or an object missing fields. It must
// never throw — it is called from the 80ms cursor-poll path.
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime entry point for unknown IPC payloads */
export function validateMask(input: unknown): { usable: boolean; reason?: string } {
  if (typeof input !== 'object' || input === null) return { usable: false, reason: '不是对象' }
  const candidate = input as Partial<SpriteMask>
  if (candidate.kind !== 'sprite') return { usable: false, reason: 'kind 不是 sprite' }
  if (typeof candidate.masks !== 'object' || candidate.masks === null) {
    return { usable: false, reason: '缺少 masks' }
  }

  const grid = candidate.grid
  if (typeof grid !== 'object' || grid === null) return { usable: false, reason: '缺少 grid' }
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (!Number.isFinite(grid[key])) return { usable: false, reason: `grid.${key} 不是有限数` }
  }
  if (!(grid.width > 0) || !(grid.height > 0)) {
    return { usable: false, reason: 'grid 的宽或高不是正数' }
  }

  for (const [name, mask] of Object.entries(candidate.masks)) {
    if (typeof mask !== 'object' || mask === null || !Array.isArray(mask.rows)) {
      return { usable: false, reason: `${name} 的 rows 不是数组` }
    }
    if (mask.rows.length !== MASK_ROWS) {
      return {
        usable: false,
        reason: `${name} 有 ${String(mask.rows.length)} 行，应为 ${String(MASK_ROWS)}`,
      }
    }
    for (const [index, row] of mask.rows.entries()) {
      if (typeof row !== 'string' || row.length !== MASK_ROW_HEX_LEN || !HEX_DIGITS.test(row)) {
        return {
          usable: false,
          reason: `${name} 第 ${String(index)} 行不是 ${String(MASK_ROW_HEX_LEN)} 位十六进制`,
        }
      }
    }
  }
  return { usable: true }
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

/**
 * 精灵图模式下窗口的像素尺寸。
 *
 * ⚠️ 与 `petWindowSize`（程序化宠物用，恒为正方形）**分开**：
 *    精灵格是 192×208，**不是正方形**。硬套正方形会把图拉变形，
 *    或者要加信箱边——两者都不如"窗口就按格子的比例"。
 */
export function spriteWindowSize(
  atlas: { readonly cellWidth: number; readonly cellHeight: number },
  scale: number,
): { width: number; height: number } {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    width: Math.max(1, Math.round(atlas.cellWidth * safeScale)),
    height: Math.max(1, Math.round(atlas.cellHeight * safeScale)),
  }
}
