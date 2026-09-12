import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  describeAtlas,
  describeAttribution,
  parsePetManifest,
  PET_MANIFEST_FILE,
  PROCEDURAL_PET,
  SPRITE_SHEET_FILE,
  SPRITE_SHEET_PNG_FILE,
  type PetDefinition,
  type SpritePetDefinition,
} from '@shared/petDefinition'
import { parseImageSize } from '@shared/webpSize'

/**
 * 从磁盘上加载宠物定义。
 *
 * ── 入口 ──
 *
 * `XIAOQI_PET_DIR=<目录>` 指向一个素材目录。目录里应当只有两个文件：
 *
 *     pet.json          元数据
 *     spritesheet.webp  图集（PNG 也接受）
 *
 * 没设这个变量、或者素材有问题时，**回落到内置的程序化小奇**。
 *
 * ── 为什么"加载失败"绝不抛错 ──
 *
 * 素材是**用户放进去的东西**：可能是我还没支持的版本、可能是从网上下了一半、
 * 可能 pet.json 里有个手写的错别字。这些都不该让桌宠启动失败——
 * 用户看到的应该是"它换回了原来的样子，并且日志里说清楚了为什么"。
 * 静默黑屏是最糟的结果：用户既不知道发生了什么，也不知道该改什么。
 *
 * 所以这里的策略是：**能降级就降级 + 把原因说清楚**。
 */

/** 加载结果。 */
export interface PetLoadResult {
  readonly definition: PetDefinition
  /** 素材目录（`null` = 用的内置形象）。 */
  readonly directory: string | null
  /** 给启动日志用的一行署名。 */
  readonly attribution: string
  /** 图集结构描述（程序化宠物为 null）。 */
  readonly atlasDescription: string | null
  /** 非致命问题（会打进日志）。 */
  readonly warnings: readonly string[]
  /** 致命问题：非空表示已回落到内置形象。 */
  readonly errors: readonly string[]
}

/** 只读文件开头的若干字节（用于读图集尺寸）。 */
function readHead(path: string, length = 64): Uint8Array | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = new Uint8Array(length)
      const read = readSync(fd, buffer, 0, length, 0)
      return buffer.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * 加载宠物定义。
 *
 * @param env 环境变量表（注入而不是直接读 `process.env`，便于单测）
 * @param logger 可选的日志回调（把"为什么回退了"讲清楚）
 */
export function loadPetDefinition(
  env: Readonly<Record<string, string | undefined>>,
  logger?: (message: string) => void,
): PetLoadResult {
  const log = (message: string): void => {
    logger?.(message)
  }

  const raw = env.XIAOQI_PET_DIR?.trim()
  if (!raw) {
    return {
      definition: PROCEDURAL_PET,
      directory: null,
      attribution: describeAttribution(PROCEDURAL_PET),
      atlasDescription: null,
      warnings: [],
      errors: [],
    }
  }

  const directory = raw
  const fallback = (
    errors: readonly string[],
    warnings: readonly string[] = [],
  ): PetLoadResult => ({
    definition: PROCEDURAL_PET,
    directory: null,
    attribution: describeAttribution(PROCEDURAL_PET),
    atlasDescription: null,
    warnings,
    errors,
  })

  // ── 目录 ──
  if (!existsSync(directory)) {
    return fallback([`XIAOQI_PET_DIR 指向的目录不存在：${directory}`])
  }
  try {
    if (!statSync(directory).isDirectory()) {
      return fallback([`XIAOQI_PET_DIR 不是目录：${directory}`])
    }
  } catch (error) {
    return fallback([`无法读取素材目录：${(error as Error).message}`])
  }

  const name = basename(directory)

  // ── 图集文件 ──
  //
  // 顺序：先 `.webp`（契约的主格式），再 `.png`（规范也允许）。
  const candidates = [SPRITE_SHEET_FILE, SPRITE_SHEET_PNG_FILE]
  const sheetFile = candidates.find((file) => existsSync(join(directory, file)))
  if (!sheetFile) {
    return fallback([
      `素材目录里没有 ${SPRITE_SHEET_FILE}（也没有 ${SPRITE_SHEET_PNG_FILE}）：${directory}`,
    ])
  }

  // ── 元数据 ──
  const manifestPath = join(directory, PET_MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    return fallback([`素材目录里没有 ${PET_MANIFEST_FILE}：${directory}`])
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return fallback([`${PET_MANIFEST_FILE} 不是合法 JSON：${(error as Error).message}`])
  }

  // ── 图集像素尺寸（读文件头，不解码）──
  const head = readHead(join(directory, sheetFile))
  const sheetPixels = head ? parseImageSize(head, sheetFile) : null

  const parsed = parsePetManifest(manifest, { fallbackName: name, sheetFile, sheetPixels })
  for (const warning of parsed.warnings) log(`⚠️ 素材：${warning}`)
  if (parsed.definition === null) {
    return fallback(parsed.errors, parsed.warnings)
  }

  const definition: SpritePetDefinition = parsed.definition
  log(`素材已加载：${describeAttribution(definition)}（${describeAtlas(definition)}）`)

  return {
    definition,
    directory,
    attribution: describeAttribution(definition),
    atlasDescription: describeAtlas(definition),
    warnings: parsed.warnings,
    errors: [],
  }
}
