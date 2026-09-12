import type { CodexAnimationName, PetSpriteAtlas } from '@shared/petAtlas'
import { frameRect, lookFrameRect, type LookDirection } from '@shared/petAtlas'
import { extractSpriteMask, countFramesInRow, type PixelSource } from './spriteMask'
import type { SpriteMask } from '@shared/spriteMask'

/**
 * 图集解码后的**一次性准备结果**。
 *
 * 这个名字不好起。它的内容就是"为了画出这只宠物、并且让它可点，
 * 渲染进程必须先从像素里算出来的那几样东西"：
 *
 *   - `mask`：alpha 剪影点阵，要推给主进程做命中测试；
 *   - `availableFrames`：每个动作实际画了几帧（素材可能少画，要降级播放）；
 *   - `frames`：每个动作实际可播的帧数（与上一项的区别见下）。
 *
 * ── 为什么"实际可播帧数"要单独算一遍 ──
 *
 * `availableFrames` 是**占格扫描**的结果（从第 0 列起连续非空的格数）。
 * 但契约允许素材只画了前几帧而后面的格全空，**同时也允许素材把所有帧都画满
 * 但帧数比规范少**——后一种情况下扫描会一直数到规范帧数，多出来的空格
 * 会被当作有效帧，表现为"宠物每隔一会儿闪一下"（播到空白格）。
 *
 * 所以最终播放帧数取 `min(规范帧数, 扫描结果)`，且**至少 1 帧**
 * （0 帧会让"当前帧索引"除零，表现为宠物消失）。
 */
export interface PreparedSpriteSheet {
  readonly atlas: PetSpriteAtlas
  readonly mask: SpriteMask
  /** 每个动作实际可播的帧数（≥1）。 */
  readonly playableFrames: Readonly<Partial<Record<CodexAnimationName, number>>>
  /** 占格扫描的原始结果，供日志与验证脚本核对。 */
  readonly scannedFrames: Readonly<Partial<Record<CodexAnimationName, number>>>
  /** 图集里一共画了多少个非空格（用于判断素材质量）。 */
  readonly drawnCells: number
}

/**
 * 从像素里算出命中蒙版与各动作的可用帧数。
 *
 * 纯函数，可单测——这是渲染进程里**唯一**需要读懂素材像素的地方，
 * 所以它必须能被喂假像素验证。
 */
export function prepareSpriteSheet(
  pixels: PixelSource,
  atlas: PetSpriteAtlas,
): PreparedSpriteSheet {
  const scanned: Partial<Record<CodexAnimationName, number>> = {}
  const playable: Partial<Record<CodexAnimationName, number>> = {}
  let drawnCells = 0

  for (const name of Object.keys(atlas.animations) as CodexAnimationName[]) {
    const count = countFramesInRow(pixels, atlas, name)
    scanned[name] = count
    // 至少 1 帧：0 会让帧索引除零
    playable[name] = Math.max(1, count)
    drawnCells += count
  }

  const mask = extractSpriteMask({ pixels, atlas, availableFrames: scanned })

  return { atlas, mask, playableFrames: playable, scannedFrames: scanned, drawnCells }
}

/**
 * 一个动作的帧矩形序列（供纹理切分）。
 *
 * 抽成纯函数而不是写在 `SpriteStage` 里：切帧错位的表现是
 * "宠物的一半是另一个动作"，而它在运行时只表现为画面不对、不报错。
 */
export function frameRectsFor(
  atlas: PetSpriteAtlas,
  animation: CodexAnimationName,
  frames: number,
): { x: number; y: number; width: number; height: number }[] {
  const total = Math.max(1, Math.min(frames, atlas.animations[animation].frames))
  const out: { x: number; y: number; width: number; height: number }[] = []
  for (let index = 0; index < total; index++) {
    const rect = frameRect(atlas, animation, index)
    out.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  }
  return out
}

/** 一个注视方向对应的矩形；V1 或非法方向返回 null。 */
export function lookRectFor(
  atlas: PetSpriteAtlas,
  direction: LookDirection,
): { x: number; y: number; width: number; height: number } | null {
  const rect = lookFrameRect(atlas, direction)
  return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
}

/** 版本守卫：图集版本与定义不一致时说明是哪个环节出的问题。 */
export function assertAtlasVersion(version: number, atlas: PetSpriteAtlas): string | null {
  if (version !== atlas.version) {
    return `图集版本不一致：定义说 V${String(version)}，契约表是 V${String(atlas.version)}`
  }
  return null
}
