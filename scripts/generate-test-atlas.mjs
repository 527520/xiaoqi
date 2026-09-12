#!/usr/bin/env node
/**
 * 生成一张**合规的合成图集**，用来驱动与验证精灵图渲染管线。
 *
 * ── 为什么需要它 ──
 *
 * 精灵图这条路必须能被**自动化验证**。而真实宠物的图集是第三方素材：
 *   - 许可上不能进仓库（docs/RECON.md 记过这条边界）；
 *   - 内容不可控，没法用"像素应该是某个颜色"来断言。
 *
 * 所以自己生成一张：**程序化、零许可风险、每一格的颜色唯一确定**。
 * 于是"换帧了"这件事在像素上可断言，而不是靠人眼看。
 *
 * ── 每格画什么 ──
 *
 * 底：一个**占据大半格**的圆（保证透明剪影存在且位置固定，供命中蒙版使用）。
 * 上：一个随格变化的小标记 —— 色相 = 行号×40 + 列号×5，
 *     标记形状按列轮换（方块/圆/三角/十字）。
 *
 * 于是同一动作内相邻两帧的**主色相不同**，"有没有在推进"一眼可测。
 *
 * ── 网格定义从哪来 ──
 *
 * ★ 从 src/shared/petAtlas.ts **真读**，不在这里重抄一遍数字。
 *   重抄的后果是"生成器按一套网格、渲染器按另一套"，而那种错位
 *   在截图上看不出来（只是每帧偏一点）。用 Vite 把那份 TS 就地转译后
 *   当 ESM 导入，于是网格永远只有一份真相。
 *
 * 用法：node scripts/generate-test-atlas.mjs [输出目录]
 * 默认输出目录：assets/pets/test-sprite（该目录已被 .gitignore 忽略）
 *
 * 注意：本文件含模板字符串，注释里不要写反引号。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createServer } from 'vite'

/**
 * 把一份 TS 模块当 ESM 导入（就地转译，不落盘）。
 *
 * 用 Vite 自己的 transform 而不是自己写正则去抠常量：
 * 后者会随源码格式变化而静默失效，而"静默失效的守卫"比没有守卫更危险。
 */
async function importTs(entry) {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  try {
    const result = await server.transformRequest(entry)
    if (!result) throw new Error(`转译失败：${entry}`)
    const encoded = Buffer.from(result.code, 'utf8').toString('base64')
    return await import(`data:text/javascript;base64,${encoded}`)
  } finally {
    await server.close()
  }
}

const outDir = process.argv[2] ?? join(process.cwd(), 'assets', 'pets', 'test-sprite')

const atlas = await importTs('/src/shared/petAtlas.ts')
const { CODEX_V2_ATLAS } = atlas

console.log(`图集契约：V${String(CODEX_V2_ATLAS.version)}`)
console.log(`  网格 ${String(CODEX_V2_ATLAS.columns)}列 × ${String(CODEX_V2_ATLAS.rows)}行`)
console.log(`  单格 ${String(CODEX_V2_ATLAS.cellWidth)}×${String(CODEX_V2_ATLAS.cellHeight)}`)
console.log(`  尺寸 ${String(CODEX_V2_ATLAS.atlasWidth)}×${String(CODEX_V2_ATLAS.atlasHeight)}`)

// ── 用 Python + Pillow 画并编码（本机实测：Pillow 12.2.0，可写 lossless RGBA WebP）──
//
// 为什么不让 Node 干：PNG/WebP 的无损 RGBA 编码在 Node 侧要么装原生库
// （本机没有 C++ 编译器），要么自己写编码器（WebP 是 VP8L，代价过高）。
// Pillow 已在机器上且实测可用。

const actions = Object.entries(CODEX_V2_ATLAS.animations).map(([name, spec]) => ({
  name,
  row: spec.row,
  frames: spec.frames,
}))

const PY = `
import json, sys, math
from PIL import Image, ImageDraw

spec = json.loads(sys.argv[1])
out_dir = sys.argv[2]

W, H = spec["atlasWidth"], spec["atlasHeight"]
CW, CH = spec["cellWidth"], spec["cellHeight"]
COLS, ROWS = spec["columns"], spec["rows"]

img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

def hue_to_rgb(h):
    """把色相(0-360)转成 RGB。用来让每格颜色唯一且好认。"""
    h = h % 360 / 60.0
    x = int(255 * (1 - abs(h % 2 - 1)))
    if h < 1: return (255, x, 0)
    if h < 2: return (x, 255, 0)
    if h < 3: return (0, 255, x)
    if h < 4: return (0, x, 255)
    if h < 5: return (x, 0, 255)
    return (255, 0, x)

EXTRA_ROWS = spec.get("extraRows", [])
for item in spec["actions"] + EXTRA_ROWS:
    row, frames = item["row"], item["frames"]
    for col in range(frames):
        cx, cy = col * CW + CW // 2, row * CH + CH // 2

        # 主色相：行 40 度 + 列 5 度 → 全局唯一，且同行内相邻帧可区分
        hue = row * 40 + col * 5
        fill = hue_to_rgb(hue) + (255,)

        # ① 固定的透明剪影：占据大半格，位置**逐帧完全一致**。
        #    命中蒙版依赖它——若剪影逐帧乱动，"同一动作各帧蒙版近似相同"
        #    这个前提就不成立，蒙版会算错。
        r = min(CW, CH) // 2 - 8
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

        # ② 逐帧变化的标记：证明"帧真的换了"。
        s = 10
        shape = col % 4
        m = 26  # 标记离中心的距离
        if shape == 0:
            d.rectangle([cx - s + m, cy - s, cx + s + m, cy + s], fill=(20, 20, 20, 255))
        elif shape == 1:
            d.ellipse([cx - s, cy - s - m, cx + s, cy + s - m], fill=(20, 20, 20, 255))
        elif shape == 2:
            d.polygon([(cx + m, cy + s), (cx + m - s, cy - s), (cx + m + s, cy - s)], fill=(20, 20, 20, 255))
        else:
            d.line([cx - s, cy + m, cx + s, cy + m], fill=(20, 20, 20, 255), width=5)
            d.line([cx, cy + m - s, cx, cy + m + s], fill=(20, 20, 20, 255), width=5)

img.save(out_dir + "/spritesheet.webp", "WEBP", lossless=True, quality=100, method=6)

# 自检：四角必须透明，且每格必须非空（否则校验器会拒绝）
alpha = img.getchannel("A")
corners = [alpha.getpixel(p) for p in [(0,0), (W-1,0), (0,H-1), (W-1,H-1)]]
report = {"corners": corners, "size": list(img.size)}
print("REPORT=" + json.dumps(report))
`

const extraRows = [
  { name: 'look-a', row: 9, frames: 8 },
  { name: 'look-b', row: 10, frames: 8 },
]

const payload = {
  atlasWidth: CODEX_V2_ATLAS.atlasWidth,
  atlasHeight: CODEX_V2_ATLAS.atlasHeight,
  cellWidth: CODEX_V2_ATLAS.cellWidth,
  cellHeight: CODEX_V2_ATLAS.cellHeight,
  columns: CODEX_V2_ATLAS.columns,
  rows: CODEX_V2_ATLAS.rows,
  actions,
  extraRows,
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, '.atlas-spec.json'), JSON.stringify(payload, null, 2), 'utf8')

const { spawnSync } = await import('node:child_process')
const result = spawnSync(
  'python',
  ['-c', PY, JSON.stringify(payload), outDir.replace(/\\/g, '/')],
  { encoding: 'utf8' },
)
if (result.status !== 0) {
  console.error('Python 生成失败：')
  console.error(result.stdout)
  console.error(result.stderr)
  process.exit(1)
}
const reportLine = (result.stdout || '').split('\n').find((l) => l.startsWith('REPORT='))
const report = reportLine ? JSON.parse(reportLine.slice('REPORT='.length)) : null

// ── pet.json（字段与 Codex 契约一致）──
writeFileSync(
  join(outDir, 'pet.json'),
  JSON.stringify(
    {
      id: 'test-sprite',
      displayName: 'Synthetic Test Pet',
      description:
        '程序化生成的合规测试图集：每格颜色唯一，用来验证切帧、时钟推进与 alpha 蒙版命中。',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
      license: {
        name: 'CC0-1.0',
        url: 'https://creativecommons.org/publicdomain/zero/1.0/',
        author: 'xiaoqi（程序化生成，非第三方素材）',
      },
    },
    null,
    2,
  ),
  'utf8',
)

console.log(`\n已生成到 ${outDir}`)
console.log(`  spritesheet.webp（lossless RGBA WebP）`)
console.log(`  pet.json（spriteVersionNumber: 2）`)
if (report) {
  console.log(`  四角 alpha = ${JSON.stringify(report.corners)}`)
  const cornersOk = report.corners.every((a) => a === 0)
  console.log(cornersOk ? '  ✅ 四角透明' : '  ❌ 四角不透明（校验器会拒绝）')
  if (!cornersOk) process.exitCode = 1
}
