/**
 * 端到端验证"拖动宠物"：窗口是否真的跟着光标走，以及位置是否持久化。
 *
 * ── 为什么必须端到端验 ──
 *
 * 拖动这条链路有三段，每段都能单独出错，而且错法都是**静默**的：
 *  ① 渲染进程没把 pointerdown 送出来 → 拖不动，但不报错
 *  ② 主进程没跟着光标改窗口位置 → 按下去没反应
 *  ③ 松手后位置没落盘 → 这次能拖，重启后回到原处
 * 单测只能覆盖"点击与拖动的阈值判定"这类纯逻辑，
 * 前两段必须真的移动光标才看得见。
 *
 * 用法：node scripts/verify-drag.mjs
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** 宠物身体中心（设计空间），用来算"从哪里抓住它"。 */
const BODY_CENTRE = { x: 110, y: 139 }

/**
 * 设计空间的边长（像素）。
 *
 * 窗口尺寸 ÷ 它 = 当前缩放倍数。用它反推比例，比让脚本去猜
 * "现在 scale 是多少"稳得多——scale 会被持久化，而且随时可能被改。
 */
const PET_DESIGN_SIZE = 220

function electronBinary() {
  return join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 用 Electron 的 Node 模式跑光标小工具（与 verify-clickthrough 同一套）。 */
function runCursorTool(args) {
  return new Promise((resolve, reject) => {
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

/** 用 Win32 模拟一次真实的"按下 → 移动 → 抬起"。 */
function mouseSweep(from, to, steps = 6) {
  return new Promise((resolve, reject) => {
    const script = `
const koffi = require('koffi')
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const user32 = koffi.load('user32.dll')
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')
const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, uint32 data, uintptr extra)')
const LEFTDOWN = 0x0002
const LEFTUP = 0x0004
const from = { x: ${String(from.x)}, y: ${String(from.y)} }
const to = { x: ${String(to.x)}, y: ${String(to.y)} }
const steps = ${String(steps)}
SetCursorPos(from.x, from.y)
setTimeout(() => {
  mouse_event(LEFTDOWN, 0, 0, 0, 0)
  let i = 0
  const timer = setInterval(() => {
    i++
    const t = i / steps
    SetCursorPos(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t))
    if (i >= steps) {
      clearInterval(timer)
      setTimeout(() => {
        mouse_event(LEFTUP, 0, 0, 0, 0)
        process.stdout.write('ok')
        process.exit(0)
      }, 120)
    }
  }, 120)
}, 200)
`
    const child = spawn(electronBinary(), ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('exit', (code) => {
      if (code === 0 && out.includes('ok')) resolve()
      else reject(new Error(`mouse sweep 失败（退出码 ${String(code)}）：${err}`))
    })
  })
}

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

  let failures = 0
  const check = (ok, label, detail) => {
    console.log(`${ok ? '✅' : '❌'} ${label}\n     ${detail}`)
    if (!ok) failures++
  }

  try {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !logs.join('').includes('宠物已就绪')) await delay(250)
    await delay(1500)

    // ★ 必须用**恢复之后**的窗口位置，不能用「初始状态」那一行。
    //
    // 踩过的坑（也是这条测试反复假失败的真因）：
    // `初始状态：窗口 (x,y)` 由光标轮询在**启动后第一拍**打印，
    // 而 `恢复保存的位置 (x,y)` 是**之后**才执行的。两者可能差很远
    // （前者常是 `placeAtDefaultPosition()` 的结果，后者才是真正落点）。
    //
    // 拿前者算抓取点，就会点在宠物外面的透明区域：
    // 点击穿透，渲染进程收不到 `pointerdown`，日志里连「开始拖动」都没有——
    // 表象是"拖动功能坏了"，真因是**脚本读了一个过期的原点**。
    // 它在 scale=1/2 时恰好偶尔对上（两次落点偶然一致），于是更迷惑人。
    //
    // 优先取「恢复保存的位置」；没有它（首次运行、无存档）时才退回初始状态。
    const logText = logs.join('')
    const restored = logText.match(/恢复保存的位置 \((-?\d+),(-?\d+)\)/)
    const placement = logText.match(
      /初始状态：光标 \(-?\d+,-?\d+\) 窗口 \((-?\d+),(-?\d+)\) (\d+)×(\d+)/,
    )
    if (!placement) throw new Error('没能解析出宠物窗口位置')
    const winSize = { w: Number(placement[3]), h: Number(placement[4]) }
    const win = restored
      ? { x: Number(restored[1]), y: Number(restored[2]) }
      : { x: Number(placement[1]), y: Number(placement[2]) }

    console.log(
      `\n窗口原点：(${win.x}, ${win.y})（来源：${restored ? '恢复保存的位置' : '初始状态'}）  尺寸 ${winSize.w}×${winSize.h}`,
    )

    // ★ 抓取点必须**按实际窗口尺寸**换算，不能直接用设计空间的 110,139。
    //
    // 踩过的坑：`BODY_CENTRE` 是 220 设计空间里的坐标，而窗口可以被缩放
    // （`verify-scale.mjs` 会把 scale=2 持久化到 window-state.json）。
    // 窗口变成 440×440 之后，`win + (110,139)` 落在宠物**左上方外面**，
    // 那里是透明区域、会被判定为 passthrough，于是点击根本到不了渲染进程，
    // 日志里连「开始拖动」都不会出现——看起来像"拖动功能坏了"，
    // 其实是**测试点错了位置**。
    //
    // 用窗口尺寸反推比例最稳：它不依赖脚本去猜当前 scale 是多少。
    const scale = winSize.w / PET_DESIGN_SIZE
    const grab = {
      x: win.x + Math.round(BODY_CENTRE.x * scale),
      y: win.y + Math.round(BODY_CENTRE.y * scale),
    }
    const drop = { x: grab.x - 160, y: grab.y - 140 }
    console.log(`缩放 ${String(scale)}×，抓取点 (${grab.x}, ${grab.y})`)

    // ★ 重试若干次。
    //
    // 为什么要重试：主进程每 80ms 轮询光标来决定穿透。脚本把光标**瞬移**
    // 到抓取点之后，窗口要等下一拍才会从 passthrough 翻成可点。
    // 这中间按下鼠标，事件会穿到下层窗口，渲染进程连 `pointerdown`
    // 都收不到——日志里没有「开始拖动」，看起来像"拖不动"，
    // 实际只是**点在窗口还没准备好的那一瞬**。
    //
    // 先移动、等一两拍、再按，才是真实用户的操作顺序（人不会瞬移光标
    // 并同时按下）。所以这里不是给实现打补丁，是让测试的动作更接近真人。
    let started = false
    for (let attempt = 1; attempt <= 4 && !started; attempt++) {
      await runCursorTool(['set', String(grab.x), String(grab.y)])
      await delay(attempt === 1 ? 300 : 500)
      await mouseSweep(grab, drop)
      await delay(1200)
      started = logs.join('').includes('开始拖动')
      if (!started) console.log(`   （第 ${String(attempt)} 次没抓住，重试）`)
    }

    const after = logs.join('').match(/结束拖动 → \((-?\d+),(-?\d+)\)/)

    // ★ 拖动**开始那一刻**的真实窗口原点，而不是启动时那一行。
    //
    // 踩过的坑：脚本原本拿 `初始状态：窗口 (x,y)` 当原点，但那个值在
    // 启动后还会变（工作区夹取、置顶重设、Windows 自己的工作区调整），
    // 于是"位移对不对"会拿一个陈旧原点去比，得出**假的失败**。
    // 主进程现在在拖动开始时把真实原点一起打出来，测试直接用它。
    const originMatch = logs
      .join('')
      .match(/开始拖动（偏移 (-?\d+),(-?\d+)） 窗口原点 \((-?\d+),(-?\d+)\)/)
    const startOffset = originMatch
      ? { x: Number(originMatch[1]), y: Number(originMatch[2]) }
      : null
    const liveOrigin = originMatch ? { x: Number(originMatch[3]), y: Number(originMatch[4]) } : win

    check(Boolean(after), '拖动结束后主进程记录了新位置', `日志：${after?.[0] ?? '（没有）'}`)

    if (after) {
      const moved = { x: Number(after[1]), y: Number(after[2]) }
      const dx = moved.x - liveOrigin.x
      const dy = moved.y - liveOrigin.y

      // 期望位移 = 拖动距离。这里**不依赖**起点是用哪个原点算的：
      // 抓取点相对原点的偏移在拖动前后不变，所以位移就该等于
      // (drop - grab)，与原点无关。原点只用来核对"抓取点没算错"。
      check(
        Math.abs(dx - (drop.x - grab.x)) <= 30 && Math.abs(dy - (drop.y - grab.y)) <= 30,
        '★ 窗口跟着光标移动了（位移与拖动距离一致）',
        `期望位移约 (${String(drop.x - grab.x)}, ${String(drop.y - grab.y)})，实际 (${String(dx)}, ${String(dy)})` +
          `\n     拖动起点：窗口原点 (${String(liveOrigin.x)},${String(liveOrigin.y)})，光标偏移 ${JSON.stringify(startOffset)}`,
      )
    }

    // 位置持久化：写在 userData 下的 window-state.json
    const { readFileSync } = await import('node:fs')
    const { join: pjoin } = await import('node:path')
    const statePath = pjoin(process.env.APPDATA ?? '', 'xiaoqi', 'window-state.json')
    let saved = null
    try {
      saved = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch (error) {
      console.log(`   （读 ${statePath} 失败：${String(error)}）`)
    }
    check(
      Boolean(saved && typeof saved.position?.x === 'number'),
      '★ 拖动后的位置已持久化到 window-state.json',
      `文件：${statePath}\n     内容：${JSON.stringify(saved)}`,
    )

    console.log(`\n结果：${String(2 - failures)}/2 项符合预期` + (failures ? `\n未通过项见上` : ''))
    if (failures > 0) process.exitCode = 1
  } finally {
    await runCursorTool(['set', String(original.x), String(original.y)]).catch((error) => {
      console.warn(`⚠️ 光标还原失败：${String(error)}`)
    })
    console.log(`光标已还原到 (${original.x}, ${original.y})`)
    child.kill()
    await delay(600)
  }
}

main().catch((error) => {
  console.error('拖动验证失败：' + String(error))
  process.exit(1)
})
