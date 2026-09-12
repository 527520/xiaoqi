/**
 * 网格**变换语义**的隔离实验驱动端。
 *
 * ── 为什么需要它 ──
 *
 * 把 GPU 光照接进 `PetStage` 时卡住了：网格的 `position` / `scale` 对渲染
 * 结果**完全没有影响**（扫了 6 组位置、又试了 2 倍缩放，可见包围盒始终不变）。
 * 而 `worldTransform` 的值确实在变，所以起初误判成"已经修好"——
 * **变换的值在变，不等于顶点被正确变换**。
 *
 * 与其在 800 行的 `PetStage` 里继续试，不如让探针页并排画出三种画法，
 * 各自放在明确的位置上：
 *
 *   A. `MeshPlane`（内置 shader + 默认几何）     圆心应在 x=20
 *   B. `Mesh` + 自建几何 + 自定义 shader         圆心应在 x=90
 *   C. `Graphics`（对照组，一定是好的）          圆心应在 x=160
 *
 * 判据是**位置与左右顺序**：三者都出现在各自设定的横坐标上，
 * 就说明变换对这两种 Mesh 都生效；只有 C 出现，就说明 Mesh 那条路有问题。
 *
 * 用 `XIAOQI_MESH_VARIANTS=1` 让主进程加载带 `?variants` 的页面。
 *
 * 用法：node scripts/probe-mesh-transform.mjs
 * 产物：docs/evidence/runtime/mesh-probe/variants.png + transform.json
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { connectCdp, delay, launchApp } from './cdp.mjs'
import { decodePng } from './lib/png.mjs'

const outDir = join(process.cwd(), 'docs', 'evidence', 'runtime', 'mesh-probe')
const debugPort = 9892

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

mkdirSync(outDir, { recursive: true })
console.log('启动探针窗口（?variants）…\n')

const { child, browserUrl } = launchApp({
  port: debugPort,
  env: {
    XIAOQI_MEMORY_DB: join(outDir, 'unused.db'),
    XIAOQI_DEBUG_STATE: '0',
    XIAOQI_MESH_PROBE: 'variants',
    XIAOQI_KEEP_OPEN_MS: '35000',
  },
})

/** 在给定 y 行上找出"非透明像素"的横向区段（连续簇）。 */
function clustersOnRow(image, y, alphaMin = 24) {
  const runs = []
  let start = -1
  for (let x = 0; x < image.width; x++) {
    const a = image.rgba[(y * image.width + x) * 4 + 3]
    const solid = a > alphaMin
    if (solid && start < 0) start = x
    if (!solid && start >= 0) {
      runs.push({ from: start, to: x - 1, center: Math.round((start + x - 1) / 2) })
      start = -1
    }
  }
  if (start >= 0)
    runs.push({
      from: start,
      to: image.width - 1,
      center: Math.round((start + image.width - 1) / 2),
    })
  return runs.filter((r) => r.to - r.from >= 4)
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
  await delay(2200)

  const info = await cdp.evaluate(
    'JSON.stringify(window.__meshProbe ? window.__meshProbe.info() : null)',
  )
  check(info !== 'null', '探针页起来了（三种画法都建好）', String(info))

  const variants = await cdp.evaluate(
    'JSON.stringify(window.__meshProbe ? window.__meshProbe.variants() : null)',
  )
  console.log(`     场景位置：${String(variants)}`)

  const tree = await cdp.evaluate('window.__meshProbe ? window.__meshProbe.tree() : "null"')
  console.log(`     场景图：${String(tree)}`)

  // 每个网格的自述：不可见 / 不可渲染 / 纹理是空的——三种病必须分清
  const meshes = await cdp.evaluate(
    'JSON.stringify(window.__meshProbe ? window.__meshProbe.meshes() : null)',
  )
  console.log(`     网格自述：${String(meshes)}`)

  const png = Buffer.from(await cdp.screenshot(), 'base64')
  writeFileSync(join(outDir, 'variants.png'), png)
  const image = decodePng(png)

  // 三种画法的圆心都在 y=110，所以扫这一行即可
  const runs = clustersOnRow(image, 130)
  console.log(`\n     y=110 上的像素区段：${JSON.stringify(runs.map((r) => r.center))}`)

  check(runs.length > 0, '这一行上画出了东西', `${String(runs.length)} 段`)

  /**
   * 判据：找**最接近** x=20 / 90 / 160 的区段。
   *
   * 用"最近"而不是"必须精确等于"，是为了容忍抗锯齿与 1–2px 的取整差；
   * 但容差刻意给得很小（6px）——若变换完全没生效，偏差会是几十像素，
   * 那种情况下这条断言**必须失败**。
   */
  const expected = [
    { name: 'A MeshPlane', x: 50 },
    { name: 'B Mesh+自定义shader', x: 140 },
    { name: 'C Graphics 对照', x: 230 },
    { name: 'D Graphics->RT->MeshPlane', x: 320 },
  ]

  const results = []
  for (const want of expected) {
    let best = null
    for (const run of runs) {
      const distance = Math.abs(run.center - want.x)
      if (!best || distance < best.distance) best = { ...run, distance }
    }
    const ok = best !== null && best.distance <= 6
    results.push({ ...want, found: best?.center ?? null, distance: best?.distance ?? null, ok })
    check(
      ok,
      `${want.name} 出现在 x≈${String(want.x)}`,
      best ? `实测圆心 x=${String(best.center)}（差 ${String(best.distance)}px）` : '**没找到**',
    )
  }

  // 顺序检查：三者必须左→右递增，否则说明有东西被画到了别处
  const centers = results.map((r) => r.found).filter((v) => v !== null)
  const ordered = centers.every((v, i) => i === 0 || v > centers[i - 1])
  check(
    ordered && centers.length === expected.length,
    '三者的左右顺序正确（说明**变换真的作用到了顶点**）',
    `实测顺序：[${centers.join(', ')}]`,
  )

  writeFileSync(
    join(outDir, 'transform.json'),
    JSON.stringify({ info: JSON.parse(String(info)), variants, runs, results, failures }, null, 2),
    'utf8',
  )
} catch (error) {
  check(false, '探针执行出错', String(error))
} finally {
  cdp?.close()
  child.kill()
  await delay(500)
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
