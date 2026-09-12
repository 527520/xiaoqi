import type { CodexAnimationName, PetSpriteAtlas, SpriteVersion } from './petAtlas'
import { atlasForVersion, CELL_HEIGHT, CELL_WIDTH } from './petAtlas'

/**
 * 「当前是哪种宠物」的**唯一真相** —— 纯数据 + 纯函数，可单测。
 *
 * ── 为什么需要这一层 ──
 *
 * 这一版要同时支持两条渲染后端：
 *   1. `procedural` —— 我们画的矢量小奇（`PET_GEOMETRY`，正方形窗口）；
 *   2. `sprite`     —— Codex 图集（192×208 的格子，**不是正方形**）。
 *
 * 两者在**四个地方**同时被读到：主进程放窗、主进程命中测试、
 * 渲染进程建 canvas、渲染进程建 hitArea。如果这四处各自判断
 * "现在是不是精灵图"，迟早会出现"窗口按正方形开、判断按格子做"
 * 这种错位——表现为宠物被压扁，且只有换素材时才暴露。
 *
 * 所以这里给出一个**带判别的联合类型**：谁要尺寸就问 `petWindowSizeFor(def, scale)`，
 * 谁要后端就 switch `def.kind`，编译器强制处理全部分支。
 *
 * ── 素材目录的约定（与 Codex 桌宠包一致）──
 *
 * 一个目录 = 一只宠物，里面**只有**两个文件：
 *
 *     <宠物目录>/
 *       pet.json            ← 元数据（这个文件）
 *       spritesheet.webp    ← 图集（无损 RGBA WebP；PNG 也接受）
 *
 * `spriteVersionNumber` 字段：2 → V2（8×11），省略 → V1（8×9）。
 * 版本直接决定图集应有的像素尺寸，所以**不能猜**：写错版本会让整张图
 * 按错误的格高切分，表现为"宠物每隔几帧跳到别的动作上去"。
 */

/** 精灵图集的文件名（契约固定，不支持自定义）。 */
export const SPRITE_SHEET_FILE = 'spritesheet.webp'
/** 备用文件名：规范允许 PNG。 */
export const SPRITE_SHEET_PNG_FILE = 'spritesheet.png'
/** 元数据文件名（契约固定）。 */
export const PET_MANIFEST_FILE = 'pet.json'

/**
 * 素材授权信息。
 *
 * ⚠️ 这不是装饰：本项目的素材来自第三方（Codex 桌宠社区），
 *    其中**相当一部分是非商用授权**（CC BY-NC 4.0）。
 *    把它读出来并在启动日志里打印，是为了让"用了谁的图、什么授权"
 *    在运行时可见——而不是埋在某个 README 里等着被忘记。
 */
export interface PetSource {
  /** 作者。 */
  readonly author?: string
  /** 授权标识（如 `CC-BY-NC-4.0`、`MIT`）。 */
  readonly license?: string
  /** 出处链接。 */
  readonly url?: string
}

/** 程序化宠物（我们自己画的）。 */
export interface ProceduralPetDefinition {
  readonly kind: 'procedural'
  /** 展示名。 */
  readonly displayName: string
}

/** 图集宠物。 */
export interface SpritePetDefinition {
  readonly kind: 'sprite'
  readonly displayName: string
  readonly atlasVersion: SpriteVersion
  /** 图集的文件名（`spritesheet.webp` 或 `spritesheet.png`）。 */
  readonly sheetFile: string
  /** 栅格契约（列/行/格尺寸/逐帧时长）。 */
  readonly atlas: PetSpriteAtlas
  readonly source?: PetSource
}

export type PetDefinition = ProceduralPetDefinition | SpritePetDefinition

/** 默认宠物：程序化小奇。没有提供 `XIAOQI_PET_DIR` 时用它。 */
export const PROCEDURAL_PET: ProceduralPetDefinition = {
  kind: 'procedural',
  displayName: '小奇',
}

/**
 * 当前宠物的窗口尺寸（DIP）。
 *
 * ★ **唯一入口**。主进程放窗、渲染进程设 canvas、命中测试换算都必须走这里。
 *
 * 两条后端的差别就在这里：
 *   - 程序化：正方形（`PET_DESIGN_SIZE` × 缩放）；
 *   - 精灵图：格的宽高比（192×208）而不是正方形。
 *     硬套正方形会把图拉变形，加信箱边又会浪费"透明区域不可点"的
 *     好处——不如让窗口就照格子的比例。
 */
export function petWindowSizeFor(
  definition: PetDefinition,
  scale: number,
): { width: number; height: number } {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  const base =
    definition.kind === 'sprite'
      ? { width: definition.atlas.cellWidth, height: definition.atlas.cellHeight }
      : // 设计空间是正方形的；这里刻意不 import constants.ts，
        // 免得 shared/ 内部出现"常量文件依赖定义文件 + 定义文件依赖常量文件"的环。
        { width: PROCEDURAL_DESIGN_SIZE, height: PROCEDURAL_DESIGN_SIZE }
  return {
    width: Math.max(1, Math.round(base.width * safeScale)),
    height: Math.max(1, Math.round(base.height * safeScale)),
  }
}

/**
 * 程序化宠物的设计空间边长。
 *
 * ⚠️ 必须与 `constants.ts` 的 `PET_DESIGN_SIZE` 相等，有一个测试钉住这件事。
 *    之所以在这里重复一个数，是为了避免 shared/ 内部的循环 import
 *    （`constants.ts` 依赖 `types.ts`，而这里要的只是一个边长）。
 */
export const PROCEDURAL_DESIGN_SIZE = 220

/** `pet.json` 的解析结果。 */
export interface ManifestParseResult {
  readonly definition: SpritePetDefinition | null
  /** 致命问题：`definition` 为 null 时这里非空。 */
  readonly errors: readonly string[]
  /** 非致命问题：能降级使用，但要让人看见。 */
  readonly warnings: readonly string[]
}

/** 从 `unknown` 里安全取字符串。 */
function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 解析 `pet.json`。
 *
 * ── 宽容的边界在哪里 ──
 *
 * 与 `validateAtlas` 同一套思路：**能救就救，救不了要说清楚**。
 *   - 缺 `name` / 缺授权信息 → 警告，用目录名兜底（社区素材的元数据
 *     质量参差不齐，为了一个展示名拒绝整只宠物不值当）；
 *   - 版本号不认识 / 版本与图集尺寸对不上 → **错误**。
 *     这一条不能宽容：版本错 = 切格错 = 宠物每隔几帧跳到别的动作上，
 *     用户会以为是我们的渲染 bug。
 *
 * @param raw `pet.json` 解析后的对象（调用方负责 `JSON.parse`）
 * @param options `fallbackName` 用于缺 `name` 时兜底；`sheetPixels` 是
 *        从文件头读出的真实像素尺寸（读不到就不传，跳过这条校验）。
 */
export function parsePetManifest(
  raw: unknown,
  options: {
    readonly fallbackName?: string
    readonly sheetFile?: string
    readonly sheetPixels?: { readonly width: number; readonly height: number } | null
  } = {},
): ManifestParseResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { definition: null, errors: ['pet.json 不是一个对象'], warnings }
  }
  const input = raw as Record<string, unknown>

  // ── 版本 ──
  // 字段缺失 = V1（规范如此：V1 不写这个字段）。写了就必须是 1 或 2。
  const rawVersion = input.spriteVersionNumber
  let version: SpriteVersion = 1
  if (rawVersion !== undefined) {
    if (rawVersion === 1 || rawVersion === 2) {
      version = rawVersion
    } else {
      errors.push(`spriteVersionNumber 只能是 1 或 2，实际是 ${JSON.stringify(rawVersion)}`)
    }
  }

  const atlas = atlasForVersion(version)

  // ── 图集像素尺寸 ──
  // 从文件头读到的真实尺寸优先；读不到（如某些扩展 WebP）就跳过。
  const pixels = options.sheetPixels
  if (pixels) {
    if (pixels.width !== atlas.atlasWidth || pixels.height !== atlas.atlasHeight) {
      errors.push(
        `图集应为 ${String(atlas.atlasWidth)}×${String(atlas.atlasHeight)}（V${String(version)}），` +
          `实际 ${String(pixels.width)}×${String(pixels.height)}`,
      )
    }
  } else {
    warnings.push('没能从图集文件头读出像素尺寸，跳过尺寸校验（改由渲染进程解码后校验）')
  }

  // ── 展示名 ──
  const name = readString(input, 'name') ?? readString(input, 'displayName')
  if (!name) {
    const fallback = options.fallbackName ?? '未命名'
    warnings.push(`pet.json 没有 name，用目录名「${fallback}」代替`)
  }

  // ── 授权信息 ──
  const source: PetSource = {}
  const author = readString(input, 'author')
  const license = readString(input, 'license')
  const url = readString(input, 'url') ?? readString(input, 'source')
  if (author) Object.assign(source, { author })
  if (license) Object.assign(source, { license })
  if (url) Object.assign(source, { url })
  if (!license) {
    // 只警告不拒绝：社区包里缺授权字段的很常见，而"拒绝加载"会把
    // 用户挡在门外、什么也解决不了。但要在日志里说清楚，
    // 因为授权是**能不能用**的前提（见 docs/RECON.md 的素材授权结论）。
    warnings.push('pet.json 没有 license 字段 —— 无法确认素材授权，请自行核实后再分发')
  }

  if (errors.length > 0) return { definition: null, errors, warnings }

  const definition: SpritePetDefinition = {
    kind: 'sprite',
    displayName: name ?? options.fallbackName ?? '未命名',
    atlasVersion: version,
    sheetFile: options.sheetFile ?? SPRITE_SHEET_FILE,
    atlas,
    ...(Object.keys(source).length > 0 ? { source } : {}),
  }
  return { definition, errors, warnings }
}

/**
 * 一行启动日志用的素材署名。
 *
 * 格式固定，便于在日志里 grep：`小奇 · 作者 · CC-BY-NC-4.0`。
 * 缺字段时给出明确的占位，而不是留空——空字符串会让人以为"没问题"。
 */
export function describeAttribution(definition: PetDefinition): string {
  const parts = [definition.displayName]
  if (definition.kind === 'sprite') {
    parts.push(definition.source?.author ?? '作者未注明')
    parts.push(definition.source?.license ?? '授权未注明')
    parts.push(`V${String(definition.atlasVersion)} 图集`)
  } else {
    parts.push('内置矢量形象')
  }
  return parts.join(' · ')
}

/** 一个动作在图集里占的格数与格尺寸（给验证脚本与日志用）。 */
export function describeAtlas(definition: SpritePetDefinition): string {
  const { atlas } = definition
  const cells = (Object.keys(atlas.animations) as CodexAnimationName[]).map(
    (name) => atlas.animations[name].frames,
  )
  const total = cells.reduce((sum, n) => sum + n, 0)
  return (
    `${String(atlas.columns)}列×${String(atlas.rows)}行 · ` +
    `格 ${String(atlas.cellWidth)}×${String(atlas.cellHeight)} · ` +
    `标准动作 ${String(cells.length)} 个共 ${String(total)} 帧`
  )
}

/**
 * 图集格宽/格高的默认值（V1/V2 相同）。
 *
 * 从 `petAtlas` 重新导出，是为了让调用方只 import 一个模块就能拿到
 * "宠物定义"相关的全部尺寸——少一处 import 就少一处漂移的机会。
 */
export { CELL_HEIGHT, CELL_WIDTH }
