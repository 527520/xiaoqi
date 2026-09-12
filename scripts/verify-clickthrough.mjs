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
/**
 * 探针位置（**设计空间 220×220**）。
 *
 * ⚠️ 改了宠物形状就必须回来更新这里，否则验证会变成"测了一个旧形状"。
 *    本轮把宠物从"只有一个头"改成完整解剖（头/躯干/四肢）之后，
 *    旧的探针点全部落在新轮廓之外，`verify:clickthrough` 立刻从 9/9
 *    掉到 8/9 —— 那是**探针过期**，不是判定坏了。
 */
const PROBES_LOCAL = {
  /** 躯干中心（新轮廓里最"实"的地方）。 */
  bodyCentre: { x: 110, y: 152 },
  /** 右耳内部。耳心 (133,36)，半径 17。 */
  earRight: { x: 133, y: 32 },
  /** 双耳之间的凹口：窗口内，但轮廓外。耳内缘 x=116/104、头顶 y≈28。 */
  notch: { x: 110, y: 14 },
  /**
   * ★ 新增：**躯干与后腿之间的凹口**。
   *
   * 这是完整解剖带来的、比"双耳之间"更强的一条判据：
   * 它要求命中测试**逐轮廓**求并集，而不是"取一个包围盒"。
   * 若有人图省事改成矩形/凸包判定，这一项会立刻失败。
   */
  betweenLegs: { x: 110, y: 208 },
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

/**
 * 通过 CDP 读渲染进程里的一个表达式。
 *
 * 本机不能用 DevTools 调试渲染进程（施工令 §4.3② 实测：DevTools 打开时
 * 透明窗会变不透明），而 CDP 是**外部连接**，不打开任何 DevTools 窗口，
 * 因此既能读到内部状态又不干扰窗口。
 */
async function withCdp(debugPort, fn) {
  const deadline = Date.now() + 20000
  let browserUrl = null
  while (Date.now() < deadline && !browserUrl) {
    try {
      // 实测本机 Electron 只打印 browser WebSocket URL，HTTP 的 /json/list 会被拒，
      // 所以走 browser 端点 + Target.attachToTarget(flatten)。
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null)
      if (res?.ok) {
        const info = await res.json()
        browserUrl = info.webSocketDebuggerUrl ?? null
      }
    } catch {
      // 端口还没起
    }
    if (!browserUrl) await delay(300)
  }
  if (!browserUrl) throw new Error('拿不到 CDP browser WebSocket URL')

  const ws = new WebSocket(browserUrl)
  let nextId = 0
  const pending = new Map()
  const send = (method, params, session) => {
    const id = ++nextId
    const payload = { id, method, params: params ?? {} }
    if (session) payload.sessionId = session
    ws.send(JSON.stringify(payload))
    return new Promise((resolve) => pending.set(id, resolve))
  }
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result ?? msg.error)
      pending.delete(msg.id)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
  })

  try {
    let page = null
    for (let i = 0; i < 30 && !page; i++) {
      const res = await send('Target.getTargets')
      page = (res?.targetInfos ?? []).find((t) => t.type === 'page')
      if (!page) await delay(400)
    }
    if (!page) throw new Error('找不到 page 目标')
    const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const session = attached.sessionId
    return await fn(async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true }, session)
      return res?.result?.value
    })
  } finally {
    ws.close()
  }
}

/**
 * 验证视线跟随：把光标放到宠物的左下 / 右下 / 正上方，
 * 读回舞台的 gaze 向量，判断它是否**跟着方向变**。
 *
 * 只验"有偏移"是不够的（那可能是个常驻偏移），必须验"方向随之改变"。
 * 整段复用**同一个 CDP 会话**——每次读都新开一个会话既慢又容易踩到端口竞争。
 */
async function verifyGaze({ win, runCursorTool, delay: wait, debugPort }) {
  return withCdp(debugPort, async (evaluate) => {
    const readGaze = async () =>
      JSON.parse(
        String(
          await evaluate(
            'JSON.stringify(typeof window.__petDebug === "function" ? window.__petDebug().gaze : null)',
          ),
        ),
      )

    const bodyCentre = PROBES_LOCAL.bodyCentre
    const directions = [
      { label: '左下', local: { x: bodyCentre.x - 40, y: bodyCentre.y + 40 } },
      { label: '右下', local: { x: bodyCentre.x + 40, y: bodyCentre.y + 40 } },
      { label: '正上', local: { x: bodyCentre.x, y: bodyCentre.y - 40 } },
    ]

    const samples = []
    for (const dir of directions) {
      await runCursorTool(['set', String(win.x + dir.local.x), String(win.y + dir.local.y)])
      // 轮询 80ms + 渲染进程指数平滑（半衰期 0.12s），留足时间收敛
      await wait(900)
      const gaze = await readGaze()
      samples.push({ ...dir, gaze })
      console.log(`  视线探针「${dir.label}」→ gaze = (${String(gaze?.x)}, ${String(gaze?.y)})`)
    }

    const [left, right, up] = samples
    let failures = 0
    const check = (ok, label) => {
      console.log(`${ok ? '✅' : '❌'} ${label}`)
      if (!ok) failures++
    }

    check(
      Boolean(left.gaze && right.gaze) && left.gaze.x < right.gaze.x,
      '★ 视线随光标左右改变（左下的 gaze.x < 右下的 gaze.x）',
    )
    check(
      Boolean(up.gaze && left.gaze) && up.gaze.y < left.gaze.y,
      '★ 视线随光标上下改变（正上的 gaze.y < 左下的 gaze.y）',
    )

    return failures
  })
}

async function main() {
  const original = JSON.parse(await runCursorTool(['get']))
  console.log(`原始光标位置：(${original.x}, ${original.y})`)

  const logs = []
  const debugPort = process.argv[2] ?? '9666'
  const child = spawn(electronBinary(), ['.', `--remote-debugging-port=${debugPort}`], {
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

    // 解析窗口位置。
    //
    // 优先用**「恢复保存的位置」**那一行 —— 它才是窗口真正落脚的地方。
    //
    // ⚠️ 为什么不能只用「初始状态」：那一行由光标轮询在**启动后第一拍**
    //    打印，而位置恢复是**之后**才执行的。两者可能差很远
    //    （初始那一拍常常还是 `placeAtDefaultPosition()` 的结果）。
    //    拿它当基准，探针就会点在宠物外面的透明区域上，于是
    //    「应可点」的几项全部报 passthrough —— 表象像"穿透判定坏了"，
    //    真因是**脚本用了一个过期的原点**。
    //
    //    （另外也别指望"穿透 →"那行：它只在状态**翻转**时打印，
    //      初始状态本身就是 passthrough，可能整轮都没有翻转日志。）
    const logText = logs.join('')
    const restored = logText.match(/恢复保存的位置 \((-?\d+),(-?\d+)\)/)
    const placement = logText.match(
      /初始状态：光标 \(-?\d+,-?\d+\) 窗口 \((-?\d+),(-?\d+)\) (\d+)×(\d+)/,
    )
    if (!placement && !restored) {
      throw new Error('没能从应用日志里解析出宠物窗口位置（应有"初始状态"或"恢复保存的位置"行）')
    }
    const win = {
      x: Number(restored?.[1] ?? placement?.[1]),
      y: Number(restored?.[2] ?? placement?.[2]),
      w: Number(placement?.[3] ?? PET_WINDOW_SIZE),
      h: Number(placement?.[4] ?? PET_WINDOW_SIZE),
    }
    console.log(
      `\n宠物窗口：(${win.x}, ${win.y}) ${win.w}×${win.h}` +
        `（原点来源：${restored ? '恢复保存的位置' : '初始状态'}）`,
    )

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
      {
        // ★ 完整解剖之后新增的更强判据：**两条前腿之间的凹口**。
        // 它比"双耳之间"更难蒙混——耳朵之间可以靠"头顶大致是圆"糊过去，
        // 而腿间凹口要求判定真的把躯干与两条腿当成**三个相交的块**。
        label: '两条前腿之间的凹口（窗口内但轮廓外，应穿透）',
        local: w.betweenLegs,
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

    // ── 视线跟随 ──
    //
    // 它有一个很隐蔽的失效方式：如果主进程只在**穿透路由翻转**时才推状态，
    // 那么宠物在光标进入轮廓的那一刻看一眼、之后眼睛就冻住了——
    // 看起来像卡住（本机加完视线跟随之后真的引入过这个 bug）。
    // 所以判据不是"有没有偏移"，而是"**光标换了方向之后偏移跟着换**"。
    const gazeFailures = await verifyGaze({ win, runCursorTool, delay, debugPort })
    failures += gazeFailures

    console.log(
      `\n总计：${String(probes.length + 2 - failures)}/${String(probes.length + 2)} 项符合预期`,
    )
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
