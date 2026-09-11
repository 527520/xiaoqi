/**
 * 行为验证：点击穿透路由是否真按"宠物轮廓"翻转整窗开关。
 *
 * ── 为什么要端到端验，而不只跑单测 ──
 *
 * `core/cursorRouter.test.ts` 只证明 `resolveCursorRoute()` **算得对**，
 * 证明不了主进程真的按它的结论去调用了 `setIgnoreMouseEvents`。
 * M1 的核心风险恰恰在后者，所以这里做真实的光标移动 + 真实的应用。
 *
 * 做法：
 * 1. 启动真实应用（带 CDP 端口，但**不打开 DevTools 窗口**，因此透明窗不受影响）；
 * 2. 用 Win32 `SetCursorPos` 把光标移到若干探针位置；
 * 3. 读应用自身输出的 `[xiaoqi] 穿透 → ...` 日志，比对判定是否符合预期。
 *
 * 测完把光标还原到原位——不打扰用户是本项目的第一优先级，
 * 验证脚本自己没有理由例外。
 *
 * 用法：node scripts/verify-clickthrough.mjs
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

const PET_WINDOW_SIZE = 220

/**
 * 探针点（宠物**设计空间**坐标）。
 *
 * ⚠️ 这些坐标必须与 `src/shared/constants.ts` 的 `PET_GEOMETRY` 保持一致。
 *    它们不是"随便取几个点"，而是**判别性探针**：
 *    - `notch` 在窗口内、两耳水平范围内，但落在轮廓之外 ——
 *      这一项是"逐轮廓判定"与"整窗矩形判定"的分水岭。
 *    改了宠物形状之后必须回来更新，否则验证会变成"测了个旧形状"。
 */
const PROBES_LOCAL = {
  bodyCentre: { x: 110, y: 139 },
  /** 右耳内部（设计空间）。耳心 (136,90)，半径 19。 */
  earRight: { x: 136, y: 86 },
  /** 双耳之间的凹口：窗口内，但轮廓外。 */
  notch: { x: 110, y: 48 },
  /** 窗口左上角透明留白。 */
  corner: { x: 4, y: 4 },
  /** 窗口上边缘右侧留白。 */
  edgeRight: { x: PET_WINDOW_SIZE - 6, y: 4 },
}

function electronBinary() {
  return join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

/** 用 Electron 的 Node 模式跑光标小工具（这样能 require 到项目里的 koffi）。 */
function runCursorTool(args) {
  return new Promise((resolve, reject) => {
    // ⚠️ 不要加 `--no-sandbox` 之类的 Chromium 开关：
    //    `ELECTRON_RUN_AS_NODE=1` 之后是**纯 Node 参数解析**，
    //    任何 Chromium 开关都会让进程以 "bad option" 退出（实测退出码 9）。
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
  const original = JSON.parse(await runCursorTool(['get']))
  console.log(`原始光标位置：(${original.x}, ${original.y})`)

  const logs = []
  const child = spawn(electronBinary(), ['.'], {
    cwd: process.cwd(),
    env: { ...process.env, XIAOQI_EVIDENCE_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => {
    const text = String(d)
    logs.push(text)
    process.stdout.write('[app] ' + text)
  })

  try {
    // 等"宠物已就绪"出现，而不是死等一个固定秒数。
    // 固定 6 秒在本机实测不够——主进程要跑平台自检、建窗、等 ready-to-show，
    // 于是验证脚本会在窗口还没放好时就去解析日志，报出"没解析到窗口位置"，
    // 看起来像功能坏了，其实只是等太短。
    const readyDeadline = Date.now() + 20000
    while (Date.now() < readyDeadline && !logs.join('').includes('宠物已就绪')) {
      await delay(250)
    }
    if (!logs.join('').includes('宠物已就绪')) {
      throw new Error('等待"宠物已就绪"超时（20s）')
    }
    // 再给一轮心跳时间，确保窗口位置已经稳定
    await delay(1200)

    // 从**初始状态快照**里解析窗口位置。
    //
    // 不要指望"穿透 →"那行：它只在状态**翻转**时打印，而启动后的初始状态
    // 就已经是 passthrough，光标又常常不在宠物上，于是可能整轮都没有翻转日志——
    // 本机因此误判成"功能没跑"。初始快照是无条件的，拿它当基准更可靠。
    const placement = logs
      .join('')
      .match(/初始状态：光标 \(-?\d+,-?\d+\) 窗口 \((-?\d+),(-?\d+)\) (\d+)×(\d+)/)
    if (!placement) {
      throw new Error('没能从应用日志里解析出宠物窗口位置（应含"[xiaoqi] 初始状态："行）')
    }
    const win = {
      x: Number(placement[1]),
      y: Number(placement[2]),
      w: Number(placement[3]),
      h: Number(placement[4]),
    }
    console.log(`\n宠物窗口：(${win.x}, ${win.y}) ${win.w}×${win.h}`)

    const w = PROBES_LOCAL
    const probes = [
      { label: '从窗口外进入身体中心', local: w.bodyCentre, expect: 'pet' },
      { label: '窗口左上角透明留白', local: w.corner, expect: 'passthrough' },
      {
        // 用窗口上边缘的右侧留白，而不是右下角：
        // 宠物默认贴在**工作区**右下角，窗口右下角在 y≈1416，
        // 而任务栏会把可用光标位置夹到约 y≤1412——那时 SetCursorPos 到不了目标点，
        // 看起来像"应用没翻转"，其实是光标压根没动（本机踩过这个假失败）。
        label: '窗口上边缘右侧留白',
        local: w.edgeRight,
        expect: 'passthrough',
      },
      // ── 下面两项用来证明"判定是跟着**宠物轮廓**走的"，而不是只看窗口矩形 ──
      // 右耳在轮廓内 → 应可点；若实现退化成"整窗矩形判定"，这一项也会通过，
      // 所以紧跟一个同在窗口内、但**不在轮廓上**的点形成对照。
      { label: '右耳（轮廓内，应可点）', local: w.earRight, expect: 'pet' },
      {
        // 双耳之间的凹口：在窗口内、也在两耳的水平范围内，但落在轮廓之外。
        // 这一项是"逐轮廓判定"与"整窗判定"的分水岭。
        label: '双耳之间的凹口（窗口内但轮廓外，应穿透）',
        local: w.notch,
        expect: 'passthrough',
      },
      { label: '回到身体中心', local: w.bodyCentre, expect: 'pet' },
      { label: '移到窗口外', offset: { x: -200, y: -200 }, expect: 'passthrough' },
    ].map((probe) => {
      const local = probe.local ?? { x: 0, y: 0 }
      const offset = probe.offset ?? { x: 0, y: 0 }
      // 缩放会让"设计空间坐标"与"窗口像素"不再是一一对应，
      // 但本脚本在默认缩放（1.0）下运行，所以直接相加即可。
      // 若将来要在别的缩放下验证，这里要乘上 `${win.w} / ${PET_WINDOW_SIZE}`。
      const scale = win.w / PET_WINDOW_SIZE
      return {
        label: probe.label,
        expect: probe.expect,
        x: win.x + (local.x + offset.x) * scale,
        y: win.y + (local.y + offset.y) * scale,
      }
    })

    let failures = 0
    // 上一次的判定结果；日志里没有翻转行时用它。
    // 初值取自启动心跳（启动时必定是 passthrough，见 PetWindowController.start()）。
    let lastRoute = 'passthrough'
    for (const probe of probes) {
      logs.length = 0
      await runCursorTool(['set', String(probe.x), String(probe.y)])
      // 轮询间隔 80ms，留足余量让主进程重算并翻转
      await delay(700)

      // 读数来源要**两者兼顾**：
      // - 若这一轮发生了翻转，日志里有"穿透 → X"；
      // - 若没翻转（状态本来就没变），日志里没有该行，此时状态等于上一次的结果。
      // 只认日志会把"状态未变"误判成失败——本机因此出现过一次假失败。
      const flip = logs.join('').match(/穿透 → (pet|passthrough)/)
      const actual = flip ? flip[1] : lastRoute
      lastRoute = actual

      const ok = actual === probe.expect
      if (!ok) failures++
      console.log(
        `\n${ok ? '✅' : '❌'} ${probe.label}\n     光标 (${probe.x}, ${probe.y}) → 实际 ${actual}，期望 ${probe.expect}${flip ? '' : '（状态未变）'}`,
      )
    }

    console.log(`\n结果：${String(probes.length - failures)}/${String(probes.length)} 项符合预期`)
    if (failures > 0) process.exitCode = 1
  } finally {
    // 还原光标必须**尽最大努力**：即使前面的断言失败、或应用已经卡住，
    // 也不能把用户的光标留在我们挪过去的位置上。
    await runCursorTool(['set', String(original.x), String(original.y)]).catch((error) => {
      console.warn(`⚠️ 光标还原失败（请手动移回 (${original.x}, ${original.y})）：${String(error)}`)
    })
    console.log(`光标已还原到 (${original.x}, ${original.y})`)
    child.kill()
    await delay(600)
  }
}

main().catch((error) => {
  console.error('行为验证失败：' + String(error))
  process.exit(1)
})
