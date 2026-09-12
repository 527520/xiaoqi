/**
 * 网格着色器探针的**驱动端**：在真实 Electron 透明窗里验证
 * `Mesh` + 自定义 GLSL 是否可用，并做**对照实验**。
 *
 * ── 四条判据（第 4 条是关键）──
 *
 * 1. 页面加载成功，且**着色器建立成功**（失败时探针页会把原因与
 *    "卡在哪一步"写进 DOM，这里读出来）；
 * 2. 网格真的画出了像素；
 * 3. **四角仍然完全透明**——透明窗的命脉，退化会让桌宠变成黑方块；
 * 4. ★ **只改光源方向，画面必须不同**。这条是**对照实验**：
 *    若两个方向渲染出同样（或几乎同样）的像素，说明 uniform 根本没进
 *    shader，那"立体化"就是自欺欺人。
 *
 * ── 像素判据一律走截图，不走页面 canvas ──
 *
 * WebGL 的 drawing buffer 在合成后就被清空（`preserveDrawingBuffer: false`），
 * 读页面 canvas 拿到的**永远是全透明**。本项目的 `docs/RETRO.md` 记过
 * 这个误判，所以这里用 `Page.captureScreenshot`（走合成结果）再解 PNG。
 *
 * 用法：node scripts/probe-mesh-shader.mjs
 * 产物：docs/evidence/runtime/mesh-probe/{light-ur.png,light-ll.png,result.json}
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { connectCdp, delay, launchApp } from './cdp.mjs'
import { compareMidRows, decodePng, summarize } from './lib/png.mjs'

const outDir = join(process.cwd(), 'docs', 'evidence', 'runtime', 'mesh-probe')
const debugPort = 9896

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

mkdirSync(outDir, { recursive: true })
console.log('启动应用并打开渲染探针窗口（XIAOQI_MESH_PROBE=1）…\n')

const { child, logs, browserUrl } = launchApp({
  port: debugPort,
  env: {
    XIAOQI_MEMORY_DB: join(outDir, 'unused.db'),
    XIAOQI_DEBUG_STATE: '0',
    XIAOQI_MESH_PROBE: '1',
    XIAOQI_KEEP_OPEN_MS: '45000',
  },
})

/** 截一张图、解出来、返回统计。 */
async function capture(cdp, label) {
  const base64 = await cdp.screenshot()
  const png = Buffer.from(base64, 'base64')
  writeFileSync(join(outDir, `${label}.png`), png)
  return summarize(decodePng(png))
}

let cdp = null
try {
  const url = await Promise.race([
    browserUrl,
    delay(20_000).then(() => {
      throw new Error('等待 DevTools 端点超时')
    }),
  ])

  cdp = await connectCdp(url, 'mesh.html')
  console.log(`探针页：${cdp.target.url}\n`)
  await delay(2500)

  // ── ① 页面与着色器建立 ──
  //
  // 读 `document.title` **与** body 文本：title 只放第一行，
  // 而探针页把"卡在哪一步"写在 body 里。只读 title 会丢掉分步信息。
  const title = await cdp.evaluate('document.title')
  const bodyText = await cdp.evaluate('document.body?.innerText ?? ""')
  const bootSteps = await cdp.evaluate('JSON.stringify(window.__meshProbeSteps ?? [])')
  const failed = String(title).includes('失败')

  check(
    !failed,
    '★ 探针页加载且自定义着色器**建立成功**',
    failed
      ? `**失败**：${String(bodyText).split('\n')[0]}`
      : `document.title = ${JSON.stringify(title)}`,
  )
  console.log(`     分步：${bootSteps}`)

  const info = await cdp.evaluate(
    'JSON.stringify(window.__meshProbe ? window.__meshProbe.info() : null)',
  )
  check(info !== 'null', '调试面已挂载（着色器与网格都已建立）', String(info))

  if (failed || info === 'null') {
    throw new Error('探针页没有起来，后续判据无法进行')
  }

  // ── ② 光源右上：截图 + 采样 ──
  await cdp.evaluate('window.__meshProbe.setLight(0.55, -0.6, 0.58)')
  await delay(400)
  const upperRight = await capture(cdp, 'light-ur')

  check(
    upperRight.opaquePixels > 5000,
    '★ 网格真的画出了像素（不是空白）',
    `不透明像素 ${String(upperRight.opaquePixels)} / ${String(upperRight.totalPixels)}`,
  )

  const [cx, cy] = [Math.floor(upperRight.size[0] / 2), Math.floor(upperRight.size[1] / 2)]
  const center = upperRight.midRow[Math.floor(cx / 2)]
  void cy
  const centerIsBlack = center[0] < 12 && center[1] < 12 && center[2] < 12
  check(
    !centerIsBlack && center[3] > 200,
    '★ 中心像素不透明且**不是纯黑**（纯黑通常意味着着色器没生效）',
    `中心 rgba = ${JSON.stringify(center)}`,
  )

  // ── ③ 透明区域仍然透明（桌宠的命脉）──
  const opaqueCorners = upperRight.corners.filter((px) => px[3] > 8)
  check(
    opaqueCorners.length === 0,
    '★ 四角**完全透明**（透明窗没有退化成黑方块）',
    opaqueCorners.length === 0
      ? `四角 alpha 全为 0：${JSON.stringify(upperRight.corners.map((p) => p[3]))}`
      : `**有角变不透明**：${JSON.stringify(opaqueCorners)}`,
  )

  // ── ④ ★ 对照实验：只改光源方向，画面必须不同 ──
  await cdp.evaluate('window.__meshProbe.setLight(-0.6, 0.5, 0.62)')
  await delay(400)
  const lowerLeft = await capture(cdp, 'light-ll')

  const { differing, maxDelta } = compareMidRows(upperRight.midRow, lowerLeft.midRow)

  check(
    differing > 10 && maxDelta > 20,
    '★ 改变光源方向后画面**显著不同**（uniform 真的进了着色器）',
    `有差异的采样点 ${String(differing)} 个，最大通道差 ${String(maxDelta)}`,
  )

  // ── 存档结论 ──
  writeFileSync(
    join(outDir, 'result.json'),
    JSON.stringify(
      {
        shaderBuilt: !failed,
        steps: JSON.parse(bootSteps),
        opaquePixels: upperRight.opaquePixels,
        cornersAlpha: upperRight.corners.map((p) => p[3]),
        centerRgba: center,
        lightDirectionDelta: { differingSamples: differing, maxChannelDelta: maxDelta },
        failures,
      },
      null,
      2,
    ),
    'utf8',
  )
} catch (error) {
  check(false, '探针执行出错', String(error))
} finally {
  cdp?.close()
  child.kill()
  await delay(600)
}

writeFileSync(join(outDir, 'app.log'), logs.join(''), 'utf8')

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
console.log(`产物：${outDir}`)
process.exit(failures === 0 ? 0 : 1)
