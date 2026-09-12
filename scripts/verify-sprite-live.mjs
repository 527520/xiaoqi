/**
 * 端到端验证**精灵图后端的点击穿透**：真的把光标移过去，看主进程翻不翻。
 *
 * ── 为什么必须真跑 ──
 *
 * `verify-sprite.mjs` 证明了"蒙版算得对、路由函数判得对"，
 * 但它证明不了**这条判定真的被执行了**：
 *
 *   - 蒙版有没有真的过 IPC 到主进程？
 *   - 主进程收到之后有没有真的换掉判定分支（而不是继续用几何版本）？
 *   - `setIgnoreMouseEvents` 有没有真的被调用？
 *   - 精灵图窗口不是正方形（192×208），坐标换算有没有跟着改？
 *
 * 这四件事每一件都只能靠"把光标移过去看结果"来证明。纯函数单测再多
 * 也证明不了它们——本项目在 `docs/RECON.md` 里把这条记为验收原则。
 *
 * ── 探针点从哪来 ──
 *
 * **从真实蒙版算出来**，不是我手填的坐标。这样探针与被测对象同源：
 * 蒙版说哪里该命中，光标就移到哪里。手填坐标会在素材一换就失效，
 * 而且失效的方式是"探针点在不该点的地方"，看起来像功能坏了。
 *
 * 用法：node scripts/verify-sprite-live.mjs [素材目录] [调试端口]
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importTsModules } from './lib/import-ts.mjs'

const DEFAULT_DIR = join(process.cwd(), 'assets', 'pets', 'test-sprite')

function electronBinary() {
  return join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

function runCursorTool(args) {
  return new Promise((resolve, reject) => {
    // ⚠️ 不要加 Chromium 开关：ELECTRON_RUN_AS_NODE=1 之后是纯 Node 参数解析。
    const child = spawn(electronBinary(), ['scripts/cursor-tool.cjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(`cursor-tool 退出码 ${String(code)}：${err}`))
    })
  })
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const petDir = process.argv[2] ?? DEFAULT_DIR
  const debugPort = process.argv[3] ?? '9677'

  if (!existsSync(petDir)) {
    console.error(`素材目录不存在：${petDir}\n先运行：pnpm pets:gen`)
    process.exit(1)
  }

  // ── ① 先从蒙版算出探针点 ──
  const mods = await importTsModules({
    petAtlas: '/src/shared/petAtlas.ts',
    spriteMask: '/src/shared/spriteMask.ts',
    spriteSheet: '/src/renderer/src/pet/spriteSheet.ts',
  })
  const { CODEX_V2_ATLAS } = mods.petAtlas
  const { MASK_COLS, MASK_ROWS } = mods.spriteMask
  const { prepareSpriteSheet } = mods.spriteSheet

  const pixels = decodeWithPythonSync(join(petDir, 'spritesheet.webp'))
  const sheet = prepareSpriteSheet(pixels, CODEX_V2_ATLAS)
  const idle = sheet.mask.masks.idle
  if (!idle) {
    console.error('图集里没有 idle 蒙版，无法验证')
    process.exit(1)
  }

  /** 点阵区域里每个点的中心（格子像素）。 */
  const dotCentre = (col, row) => ({
    x: sheet.mask.grid.x + ((col + 0.5) * sheet.mask.grid.width) / MASK_COLS,
    y: sheet.mask.grid.y + ((row + 0.5) * sheet.mask.grid.height) / MASK_ROWS,
  })

  const lit = []
  const dark = []
  for (let row = 0; row < MASK_ROWS; row++) {
    const value = Number.parseInt(idle.rows[row], 16)
    for (let col = 0; col < MASK_COLS; col++) {
      ;(((value >> col) & 1) === 1 ? lit : dark).push({ col, row, ...dotCentre(col, row) })
    }
  }
  if (lit.length === 0 || dark.length === 0) {
    console.error(`蒙版缺少对照点（亮 ${lit.length} 个、暗 ${dark.length} 个）`)
    process.exit(1)
  }

  // 选探针：取最中心的一个亮点，以及离它最近的暗点（保证两者都在窗口内、
  // 且尽量靠近——这样"判定跟着轮廓走"这件事才有说服力：两个点在窗口里
  // 相距不到一个点大小，结果却不同）。
  const centreOfMass = lit.reduce(
    (acc, p) => ({ x: acc.x + p.x / lit.length, y: acc.y + p.y / lit.length }),
    { x: 0, y: 0 },
  )
  const pickNearest = (list) =>
    list.reduce((best, p) =>
      Math.hypot(p.x - centreOfMass.x, p.y - centreOfMass.y) <
      Math.hypot(best.x - centreOfMass.x, best.y - centreOfMass.y)
        ? p
        : best,
    )
  const hitProbe = pickNearest(lit)
  const missProbe = pickNearest(dark)
  const cornerProbe = { x: 4, y: 4 }

  console.log(`素材目录：${petDir}`)
  console.log(
    `蒙版：${lit.length} 个亮点 / ${dark.length} 个暗点；` +
      `点阵区域 ${sheet.mask.grid.width}×${sheet.mask.grid.height} @ (${sheet.mask.grid.x},${sheet.mask.grid.y})`,
  )
  console.log(
    `探针（格子像素）：命中 (${Math.round(hitProbe.x)},${Math.round(hitProbe.y)})、` +
      `穿透 (${Math.round(missProbe.x)},${Math.round(missProbe.y)})、` +
      `角 (${cornerProbe.x},${cornerProbe.y})`,
  )

  // ── ② 起应用（带 XIAOQI_PET_DIR）──
  const original = JSON.parse(await runCursorTool(['get']))
  console.log(`原始光标位置：(${original.x}, ${original.y})`)

  const logs = []
  const child = spawn(electronBinary(), ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XIAOQI_PET_DIR: petDir,
      XIAOQI_EVIDENCE_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => {
    logs.push(String(d))
    process.stdout.write('[app] ' + String(d))
  })

  let failures = 0
  try {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline && !logs.join('').includes('宠物已就绪')) {
      await delay(250)
    }
    const logText = () => logs.join('')

    const checks = []
    const check = (ok, label, detail = '') => {
      console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
      if (!ok) failures++
      checks.push(ok)
    }

    // ── 前置条件：素材真的加载了、蒙版真的到了主进程 ──
    check(logText().includes('宠物形象：'), '主进程打印了宠物形象署名')
    check(
      /精灵图蒙版已接收（\d+ 个动作/.test(logText()),
      '★ 蒙版经 IPC 到达主进程',
      (logText().match(/精灵图蒙版已接收[^\n]*/) ?? ['（日志里没有这一行）'])[0],
    )
    check(/⚠️ 精灵图蒙版被拒收/.test(logText()) === false, '蒙版没有被拒收')

    // 等窗口稳定
    await delay(1200)

    // ── 解析窗口矩形 ──
    const restored = logText().match(/恢复保存的位置 \((-?\d+),(-?\d+)\)/)
    const placement = logText().match(
      /初始状态：光标 \(-?\d+,-?\d+\) 窗口 \((-?\d+),(-?\d+)\) (\d+)×(\d+)/,
    )
    if (!placement && !restored) throw new Error('没能解析出宠物窗口位置')
    const win = {
      x: Number(restored?.[1] ?? placement?.[1]),
      y: Number(restored?.[2] ?? placement?.[2]),
      w: Number(placement?.[3] ?? CODEX_V2_ATLAS.cellWidth),
      h: Number(placement?.[4] ?? CODEX_V2_ATLAS.cellHeight),
    }
    console.log(`\n宠物窗口：(${win.x}, ${win.y}) ${win.w}×${win.h}`)

    check(
      win.w !== win.h && win.h > win.w,
      `★ 窗口尺寸是格子的比例（${CODEX_V2_ATLAS.cellWidth}×${CODEX_V2_ATLAS.cellHeight} × 缩放），**不是**正方形`,
      `实际 ${win.w}×${win.h}`,
    )
    check(
      win.w === CODEX_V2_ATLAS.cellWidth,
      '窗口宽度等于 V2 格宽（缩放 1）',
      `实际 ${win.w}，期望 ${CODEX_V2_ATLAS.cellWidth}`,
    )

    // ── 逐个探针 ──
    const probes = [
      { label: '窗口左上角（格内但轮廓外）', local: cornerProbe, expect: 'passthrough' },
      { label: '★ 蒙版点亮的点（轮廓内）', local: hitProbe, expect: 'pet' },
      { label: '★ 蒙版未点亮的点（同窗口内，轮廓外）', local: missProbe, expect: 'passthrough' },
      { label: '回到轮廓内（证明是可逆的翻转，不是一次性的）', local: hitProbe, expect: 'pet' },
      { label: '窗口外', local: { x: -200, y: -200 }, expect: 'passthrough' },
    ]

    let lastRoute = 'passthrough'
    for (const probe of probes) {
      logs.length = 0
      const x = Math.round(win.x + probe.local.x)
      const y = Math.round(win.y + probe.local.y)
      await runCursorTool(['set', String(x), String(y)])
      await delay(700)
      const flip = logText().match(/穿透 → (pet|passthrough)/)
      const actual = flip ? flip[1] : lastRoute
      lastRoute = actual
      check(
        actual === probe.expect,
        probe.label,
        `光标 (${x}, ${y}) → 实际 ${actual}，期望 ${probe.expect}${flip ? '' : '（状态未变）'}`,
      )
    }

    console.log(`\n结果：${String(checks.length - failures)}/${String(checks.length)} 项符合预期`)
  } finally {
    await runCursorTool(['set', String(original.x), String(original.y)]).catch((error) => {
      console.warn(`⚠️ 光标还原失败（请手动移回 (${original.x}, ${original.y})）：${String(error)}`)
    })
    console.log(`光标已还原到 (${original.x}, ${original.y})`)
    child.kill()
    await delay(600)
  }

  if (failures > 0) {
    console.error('\n❌ 精灵图实时验证未通过')
    process.exit(1)
  }
  console.log('\n✅ 精灵图实时验证通过')
}

/**
 * 同步版解码（这个脚本全程是同步流程，用 async 只会增加一层噪音）。
 *
 * ⚠️ 与 `verify-sprite.mjs` 里那份是**同一段 Python**。两处都写是因为
 *    它们是两个独立可运行的脚本，抽公共模块会让"单独跑其中一个"变麻烦。
 *    改动时请同步——判据是"解出来的字节数与尺寸"，有断言兜底。
 */
function decodeWithPythonSync(sheetPath) {
  const dir = mkdtempSync(join(tmpdir(), 'xiaoqi-sprite-live-'))
  const outPath = join(dir, 'rgba.bin')
  const metaPath = join(dir, 'meta.json')
  const script = `
import json, sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGBA")
with open(sys.argv[2], "wb") as f:
    f.write(img.tobytes())
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump({"width": img.width, "height": img.height}, f)
`
  execFileSync('python', ['-c', script, sheetPath, outPath, metaPath], { encoding: 'utf8' })
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  return {
    width: meta.width,
    height: meta.height,
    data: new Uint8ClampedArray(readFileSync(outPath)),
  }
}

main().catch((error) => {
  console.error('实时验证失败：' + String(error))
  process.exit(1)
})
