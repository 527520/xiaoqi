/**
 * 端到端验证**精灵图后端**：从磁盘上的素材一路验到"哪个像素可点"。
 *
 * ── 为什么必须是这条端到端链路 ──
 *
 * 精灵图后端的每一环都能**单独看起来是对的**，而合起来是错的：
 *
 *   - 元数据对、图集错     → 切格错位，宠物每隔几帧跳到别的动作上
 *   - 图集对、蒙版错       → 看得见但点不到，或者点在空气上也有反应
 *   - 蒙版对、坐标换算错   → 只有某个角落可点（"放大后只有左上角能点"那一类）
 *   - 换算对、方向搞反     → 上下镜像，光标在头顶时它看着脚底
 *
 * 单测覆盖了每一条纯函数，但"磁盘上这个文件真的能被这条链路读通"
 * 只有端到端能证明。而且本机的诊断条件很差（DevTools 一开透明窗就不透明），
 * 所以这个脚本是主要的取证手段。
 *
 * ── ★ 每条断言都配一个反例 ★ ──
 *
 * "扫描没发现问题"本身没有价值——要先证明这个扫描**能发现问题**。
 * 所以下面每个关键判定都成对出现：
 *   - 命中宠物 → 也必须有一个**不命中**的点（否则恒真也算通过）
 *   - 掩码点数 > 0 → 也必须 < 总点数（否则"全可点"也算通过）
 *   - 切帧序列有变化 → 也必须有一个**不同**的帧矩形
 *
 * 用法：
 *   node scripts/verify-sprite.mjs               # 用生成好的测试图集
 *   node scripts/verify-sprite.mjs <素材目录>
 *
 * 依赖：Python + Pillow（用来把 WebP 解成原始 RGBA；Node 侧没有解码器）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importTsModules } from './lib/import-ts.mjs'

const DEFAULT_DIR = join(process.cwd(), 'assets', 'pets', 'test-sprite')

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  const mark = ok ? '  ✔' : '  ✘'
  // 用普通空格而不是全角空格：全角空格会被 eslint 的 no-irregular-whitespace 拦下
  console.log(`${mark} ${label}${detail ? `    ${detail}` : ''}`)
  if (ok) passed++
  else failed++
}

/** 反向断言：证明这个检查**能**失败。 */
function checkCanFail(label, okIfDetectionWorks, detail = '') {
  check(`[反例] ${label}`, okIfDetectionWorks, detail)
}

/**
 * 提示（既不计通过也不计失败）。
 *
 * 用于"素材的**元数据**有缺项，但技术上完全可用"这一类情况。
 * 为什么不计失败：授权字段缺失是**第三方素材的常见状况**，
 * 它不影响能不能渲染。把它算失败会让验证脚本在真实素材上永远红，
 * 而红着的脚本等于没有脚本——真正的问题会被淹没。
 * 但它必须**打印出来**：授权决定能不能分发，不能悄悄放过。
 */
function info(label, detail = '') {
  console.log(`  • ${label}${detail ? `    ${detail}` : ''}`)
}

/**
 * 用 Python/Pillow 把图集解成原始 RGBA。
 *
 * 为什么绕 Python：Node 侧没有 WebP 解码器，而本机装不了原生模块
 * （没有 C++ 工具链）。Pillow 是已经验证过能用的。
 *
 * 产物写成**文件**而不是从 stdout 读：1536×2288×4 ≈ 14MB，
 * 管道里传 base64 会更慢也更容易踩缓冲区上限。
 */
function decodeWithPython(sheetPath) {
  const dir = mkdtempSync(join(tmpdir(), 'xiaoqi-sprite-'))
  const outPath = join(dir, 'rgba.bin')
  const metaPath = join(dir, 'meta.json')

  const script = `
import json, sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGBA")
with open(sys.argv[2], "wb") as f:
    f.write(img.tobytes())
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump({"width": img.width, "height": img.height, "mode": img.mode}, f)
`
  execFileSync('python', ['-c', script, sheetPath, outPath, metaPath], { encoding: 'utf8' })

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  return {
    width: meta.width,
    height: meta.height,
    data: new Uint8ClampedArray(readFileSync(outPath)),
  }
}

async function main() {
  const petDir = process.argv[2] ?? DEFAULT_DIR

  console.log(`素材目录：${petDir}`)
  if (!existsSync(petDir)) {
    console.error(`\n素材目录不存在。先运行：pnpm pets:gen`)
    process.exit(1)
  }

  const mods = await importTsModules({
    petAtlas: '/src/shared/petAtlas.ts',
    petDefinition: '/src/shared/petDefinition.ts',
    webpSize: '/src/shared/webpSize.ts',
    spriteMask: '/src/shared/spriteMask.ts',
    constants: '/src/shared/constants.ts',
    cursorRouter: '/src/main/core/cursorRouter.ts',
    spriteSheet: '/src/renderer/src/pet/spriteSheet.ts',
    spriteAnimation: '/src/renderer/src/pet/spriteAnimation.ts',
  })
  const { atlasForVersion, animationDuration, frameAt, lookFrameRect } = mods.petAtlas
  const { parsePetManifest } = mods.petDefinition
  const { parseImageSize } = mods.webpSize
  const { hitTestSpriteMask, MASK_COLS, MASK_ROWS } = mods.spriteMask
  const { resolveSpriteCursorRoute } = mods.cursorRouter
  const { prepareSpriteSheet, frameRectsFor } = mods.spriteSheet
  const { lookFromCursor } = mods.spriteAnimation

  // ══ ① 元数据与文件头 ══
  console.log('\n① 元数据与图集文件头')
  const manifest = JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf8'))
  const sheetPath = join(petDir, 'spritesheet.webp')

  const head = readFileSync(sheetPath).subarray(0, 64)
  const headerSize = parseImageSize(head, 'spritesheet.webp')
  check('能从文件头读出图集尺寸', headerSize !== null)

  // ★ 版本由**清单**决定，不是脚本假定 V2。
  //
  // 踩过一次：初版把 V2 契约写死在脚本里，于是拿一只**完全合规的 V1 素材**
  // （1536×1872）去跑，得到"文件头尺寸不等于契约"——看起来像素材坏了，
  // 其实是校验脚本只认一种版本。
  //
  // V1 是规范里合法的格式（省略 spriteVersionNumber），必须支持。
  const declaredVersion = manifest.spriteVersionNumber === 2 ? 2 : 1
  const ATLAS = atlasForVersion(declaredVersion)
  check(
    `图集版本判定为 V${String(declaredVersion)}` +
      (manifest.spriteVersionNumber === undefined ? '（清单省略了 spriteVersionNumber）' : ''),
    declaredVersion === 1 || declaredVersion === 2,
    `契约应为 ${ATLAS.atlasWidth}×${ATLAS.atlasHeight}（${ATLAS.columns}列×${ATLAS.rows}行）`,
  )
  check(
    '文件头尺寸等于该版本的契约',
    headerSize?.width === ATLAS.atlasWidth && headerSize?.height === ATLAS.atlasHeight,
    `读到 ${headerSize?.width}×${headerSize?.height}，契约 ${ATLAS.atlasWidth}×${ATLAS.atlasHeight}`,
  )

  const parsed = parsePetManifest(manifest, {
    sheetPixels: headerSize,
    sheetFile: 'spritesheet.webp',
  })
  check('pet.json 解析通过', parsed.definition !== null, parsed.errors.join('；'))
  if (!parsed.definition) {
    console.error('\n元数据不可用，后续检查无法进行。')
    process.exit(1)
  }
  // 授权字段：有就报出来，没有就**提示**而不是失败。
  //
  // 判据不是"字段在不在"，而是"我们有没有把这个信息暴露给用户"——
  // 那件事由主进程的启动日志负责（`宠物形象：<名字> · <作者> · <授权>`），
  // 而它已经由实时脚本验证过了。
  if (parsed.definition.source?.license) {
    check(
      '★ 授权信息被读出来了',
      true,
      `作者=${parsed.definition.source.author ?? '未注明'} 授权=${parsed.definition.source.license}`,
    )
  } else {
    info(
      '素材未声明授权（技术上不影响使用，但**对外分发前必须自行核实**）',
      `作者=${parsed.definition.source?.author ?? '未注明'}`,
    )
  }

  // ★ 反例：把一个**与真实尺寸不符**的版本号写进去，必须被拒。
  //
  // 不能像初版那样固定用 1：素材本来就是 V1 时，"改成 1"等于没改，
  // 反例自然不成立（这正是拿真素材跑时暴露出来的脚本缺陷）。
  // 正确做法是声明**另一个**版本。
  const otherVersion = declaredVersion === 1 ? 2 : 1
  const wrongVersion = parsePetManifest(
    { ...manifest, spriteVersionNumber: otherVersion },
    { sheetPixels: headerSize },
  )
  checkCanFail(
    `把 spriteVersionNumber 改成 ${String(otherVersion)} 后解析**应该失败**（证明版本校验真的在跑）`,
    wrongVersion.definition === null,
    wrongVersion.errors[0] ?? '（没有报错，说明校验没生效）',
  )

  // ══ ② 像素与蒙版 ══
  console.log('\n② 像素解码与命中蒙版')
  const pixels = decodeWithPython(sheetPath)
  check(
    '解码后的尺寸等于契约',
    pixels.width === ATLAS.atlasWidth && pixels.height === ATLAS.atlasHeight,
    `${pixels.width}×${pixels.height}`,
  )

  // 四角必须完全透明（规范硬要求：不要让图集把窗口四角填满）
  const alphaAt = (x, y) => pixels.data[(y * pixels.width + x) * 4 + 3]
  const corners = [
    alphaAt(0, 0),
    alphaAt(pixels.width - 1, 0),
    alphaAt(0, pixels.height - 1),
    alphaAt(pixels.width - 1, pixels.height - 1),
  ]
  check(
    '四个角完全透明（alpha = 0）',
    corners.every((a) => a === 0),
    `角 alpha = ${corners.join(',')}`,
  )

  const sheet = prepareSpriteSheet(pixels, ATLAS)
  const actionNames = Object.keys(ATLAS.animations)
  const scannedComplete = actionNames.every(
    (name) => sheet.scannedFrames[name] === ATLAS.animations[name].frames,
  )
  check(
    '★ 九个标准动作的占格扫描都数满（等于契约帧数）',
    scannedComplete,
    actionNames
      .map((n) => `${n}=${sheet.scannedFrames[n]}/${ATLAS.animations[n].frames}`)
      .join(' '),
  )

  // ★ 反例：扫描器必须能区分"有内容"和"没内容"。
  //   把所有帧都当空时它应该报 0 —— 否则"数满了"这件事毫无信息量。
  const emptyPixels = {
    width: pixels.width,
    height: pixels.height,
    data: new Uint8ClampedArray(pixels.width * pixels.height * 4),
  }
  const emptySheet = prepareSpriteSheet(emptyPixels, ATLAS)
  checkCanFail(
    '喂全透明像素时扫描结果应为 0 帧（证明扫描真的在看像素）',
    actionNames.every((name) => emptySheet.scannedFrames[name] === 0),
    actionNames.map((n) => emptySheet.scannedFrames[n]).join(','),
  )
  check(
    '★ 全透明图集产出的蒙版一个点都不亮（不是"全亮"）',
    Object.values(emptySheet.mask.masks).every((m) =>
      m.rows.every((row) => Number.parseInt(row, 16) === 0),
    ),
  )

  // ══ ③ 蒙版密度：既不能空，也不能满 ══
  console.log('\n③ 蒙版密度（两头的反例都要有）')
  const idleMask = sheet.mask.masks.idle
  if (!idleMask) {
    check('idle 有蒙版', false)
  } else {
    const bitCount = idleMask.rows.reduce((sum, row) => {
      let n = 0
      const value = Number.parseInt(row, 16)
      for (let i = 0; i < MASK_COLS; i++) if (((value >> i) & 1) === 1) n++
      return sum + n
    }, 0)
    const total = MASK_COLS * MASK_ROWS
    check('蒙版有点亮的点（否则宠物永远点不到）', bitCount > 0, `${bitCount}/${total}`)
    checkCanFail('蒙版**不是**全亮（否则整格都可点=没有逐像素判定）', bitCount < total)
    // 测试图集画的是居中的圆，合理区间大致是 20%–70% 的点
    check(
      '点亮的比例落在合理区间（10%–90%）',
      bitCount / total > 0.1 && bitCount / total < 0.9,
      `${Math.round((bitCount / total) * 100)}%`,
    )
  }

  check(
    '点阵区域在格子内且非退化',
    sheet.mask.grid.width > 0 &&
      sheet.mask.grid.height > 0 &&
      sheet.mask.grid.x >= 0 &&
      sheet.mask.grid.y >= 0 &&
      sheet.mask.grid.x + sheet.mask.grid.width <= ATLAS.cellWidth &&
      sheet.mask.grid.y + sheet.mask.grid.height <= ATLAS.cellHeight,
    `区域 ${sheet.mask.grid.width}×${sheet.mask.grid.height} @ (${sheet.mask.grid.x},${sheet.mask.grid.y})`,
  )

  // ══ ④ 命中判定：模型位置 ══
  console.log('\n④ 命中判定（格子内实际是圆心）')
  const cellW = ATLAS.cellWidth
  const cellH = ATLAS.cellHeight
  const bounds = { x: 1000, y: 500, width: cellW, height: cellH }
  const toScreen = (x, y) => ({ x: bounds.x + x, y: bounds.y + y })

  // 找蒙版里**最亮**的点（真实素材的形状未知，所以由蒙版自己告诉我们
  // 宠物在哪里，而不是假设它在圆心——测试图集是圆的，但这条脚本
  // 也要能验真实素材）。
  const litPoints = []
  for (let row = 0; row < idleMask.rows.length; row++) {
    const value = Number.parseInt(idleMask.rows[row], 16)
    for (let col = 0; col < MASK_COLS; col++) {
      if (((value >> col) & 1) === 1) {
        litPoints.push({
          // 取该点的中心（格子像素）
          x: sheet.mask.grid.x + ((col + 0.5) * sheet.mask.grid.width) / MASK_COLS,
          y: sheet.mask.grid.y + ((row + 0.5) * sheet.mask.grid.height) / MASK_ROWS,
        })
      }
    }
  }
  check('至少有一个可点位置可用来做断言', litPoints.length > 0, `${litPoints.length} 个`)

  const onPet = litPoints[Math.floor(litPoints.length / 2)]
  const routeOnPet = resolveSpriteCursorRoute(
    sheet.mask,
    'idle',
    bounds,
    toScreen(onPet.x, onPet.y),
  )
  check(
    '轮廓内的点路由到 pet',
    routeOnPet === 'pet',
    `(${Math.round(onPet.x)},${Math.round(onPet.y)})`,
  )

  // 取所有**未点亮**的点里的第一个，作为明确的反例。
  const darkPoints = []
  for (let row = 0; row < idleMask.rows.length; row++) {
    const value = Number.parseInt(idleMask.rows[row], 16)
    for (let col = 0; col < MASK_COLS; col++) {
      if (((value >> col) & 1) === 0) {
        darkPoints.push({
          x: sheet.mask.grid.x + ((col + 0.5) * sheet.mask.grid.width) / MASK_COLS,
          y: sheet.mask.grid.y + ((row + 0.5) * sheet.mask.grid.height) / MASK_ROWS,
        })
      }
    }
  }
  check('存在未点亮的点（用来做反例）', darkPoints.length > 0, `${darkPoints.length} 个`)
  const offPet = darkPoints[0]
  checkCanFail(
    '★ 蒙版未点亮的点必须穿透（同一个窗口内，区别只在蒙版）',
    resolveSpriteCursorRoute(sheet.mask, 'idle', bounds, toScreen(offPet.x, offPet.y)) ===
      'passthrough',
    `(${Math.round(offPet.x)},${Math.round(offPet.y)})`,
  )

  // 窗口外
  check(
    '窗口外一律穿透',
    resolveSpriteCursorRoute(sheet.mask, 'idle', bounds, { x: bounds.x - 5, y: bounds.y + 10 }) ===
      'passthrough',
  )

  // ★ 安全侧：没有蒙版时必须全穿透
  checkCanFail(
    '★ 蒙版为 null 时**连轮廓内的点也穿透**（安全侧：不挡住下层窗口）',
    resolveSpriteCursorRoute(null, 'idle', bounds, toScreen(onPet.x, onPet.y)) === 'passthrough',
  )

  // ★ 反例：切到别的动作时，判定应该跟着换蒙版 ——
  //   把 idle 的蒙版当成 jumping 用，同一个点未必命中。
  const jumpingMask = sheet.mask.masks.jumping
  check('jumping 也有独立蒙版', Boolean(jumpingMask))

  // ══ ⑤ 坐标换算：缩放不变形 ══
  console.log('\n⑤ 缩放（窗口尺寸变了，判定形状不能变）')
  for (const scale of [1, 2]) {
    const scaledBounds = { x: 1000, y: 500, width: cellW * scale, height: cellH * scale }
    const hit = hitTestSpriteMask(
      idleMask,
      onPet.x * scale,
      onPet.y * scale,
      scaledBounds.width,
      scaledBounds.height,
      sheet.mask.grid,
    )
    const miss = hitTestSpriteMask(
      idleMask,
      offPet.x * scale,
      offPet.y * scale,
      scaledBounds.width,
      scaledBounds.height,
      sheet.mask.grid,
    )
    check(`缩放 ${scale}×：轮廓内仍命中`, hit)
    checkCanFail(`缩放 ${scale}×：轮廓外仍穿透`, !miss)
  }

  // ══ ⑥ 切帧与时钟 ══
  console.log('\n⑥ 切帧与时钟推进')
  // 用**素材实际画出来的**帧数，不是契约帧数——真实素材可能少画几帧，
  // 那时我们按实际播（`playableFrames`），而不是播到空白格。
  const idleFrames = sheet.playableFrames.idle ?? 1
  const idleRects = frameRectsFor(ATLAS, 'idle', idleFrames)
  check(
    `idle 切出 ${String(idleFrames)} 帧纹理`,
    idleRects.length === idleFrames,
    idleRects.map((r) => r.x).join(','),
  )
  check(
    `★ ${String(idleFrames)} 个帧矩形**互不相同**（相同就说明切帧没生效）`,
    new Set(idleRects.map((r) => `${r.x},${r.y}`)).size === idleRects.length,
  )
  check(
    '★ 所有帧矩形都落在图集范围内',
    idleRects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= pixels.width),
  )
  // 反例：帧矩形的 y 必须都在 idle 那一行（第 0 行）
  checkCanFail(
    '★ idle 的帧矩形 y 全为 0（若混入了别的行，说明行号算错）',
    idleRects.every((r) => r.y === 0),
  )

  const total = animationDuration(ATLAS, 'idle')
  const seen = new Set()
  for (let t = 0; t < total; t += 10) seen.add(frameAt(ATLAS, 'idle', t))
  check(
    `★ 时钟走完一轮会经过全部 ${String(idleFrames)} 帧`,
    seen.size === idleFrames,
    `经过了 ${String(seen.size)} 帧`,
  )
  checkCanFail(
    `★ 时钟不会越界（任何时刻的帧号都在 0..${String(idleFrames - 1)}）`,
    [...seen].every((f) => f >= 0 && f <= idleFrames - 1),
  )
  check(
    '动画总时长等于该动作逐帧时长之和',
    total === ATLAS.animations.idle.frameDurations.reduce((a, b) => a + b, 0),
    `${String(total)}ms`,
  )

  // ══ ⑦ 注视方向 ══
  console.log('\n⑦ 注视方向（0° = 正上）')
  check('正上方 → 0°', lookFromCursor({ x: 0, y: -50 }) === 0)
  check('正右方 → 90°', lookFromCursor({ x: 50, y: 0 }) === 90)
  checkCanFail('正下方 → 180°（不是 0°，防上下镜像）', lookFromCursor({ x: 0, y: 50 }) === 180)
  check('正左方 → 270°', lookFromCursor({ x: -50, y: 0 }) === 270)
  if (declaredVersion === 2) {
    const lookA = lookFrameRect(ATLAS, 0)
    const lookB = lookFrameRect(ATLAS, 180)
    check(
      'V2 的 0° 在第 9 行、180° 在第 10 行',
      lookA?.y === 9 * cellH && lookB?.y === 10 * cellH,
      `0°@y=${String(lookA?.y)} 180°@y=${String(lookB?.y)}`,
    )
  } else {
    // ★ V1 **没有**注视行。这不是缺陷，是版本能力所限——
    //   所以这里要断言的是"正确地什么也不给"，而不是"应该有"。
    checkCanFail(
      '★ V1 没有注视行 → lookFrameRect 返回 null（渲染器据此回落普通 idle）',
      lookFrameRect(ATLAS, 0) === null && lookFrameRect(ATLAS, 180) === null,
    )
  }
  check(
    '注视角度换算与版本无关（两条后端都靠它决定看向哪）',
    lookFromCursor({ x: 0, y: -50 }) === 0 && lookFromCursor({ x: 50, y: 0 }) === 90,
  )

  // ══ ⑧ 路由与几何后端不冲突 ══
  console.log('\n⑧ 回归：程序化后端的几何命中不受影响')
  {
    // 精灵图后端的常量不应污染程序化后端的窗口尺寸函数。
    const { petWindowSize } = mods.constants
    const procedural = petWindowSize(1)
    check(
      '程序化窗口仍是正方形 220×220',
      procedural.width === procedural.height && procedural.width === 220,
      `${procedural.width}×${procedural.height}`,
    )
    checkCanFail(
      '精灵图窗口**不是**正方形（两条后端确实不同）',
      cellW !== cellH,
      `${cellW}×${cellH}`,
    )
  }

  // ── 汇总 ──
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`通过 ${passed}，失败 ${failed}`)
  if (failed > 0) {
    console.error('\n❌ 精灵图端到端验证未通过')
    process.exit(1)
  }
  console.log('\n✅ 精灵图端到端验证通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
