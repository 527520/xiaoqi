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

    const placement = logs
      .join('')
      .match(/初始状态：光标 \(-?\d+,-?\d+\) 窗口 \((-?\d+),(-?\d+)\) (\d+)×(\d+)/)
    if (!placement) throw new Error('没能解析出宠物窗口位置')
    const win = { x: Number(placement[1]), y: Number(placement[2]) }

    console.log(`\n拖动前窗口左上角：(${win.x}, ${win.y})`)

    // 抓住身体中心，往左上拖 160px。
    // 刻意往**左上**拖：右下角是默认位置，那里已经贴着工作区边缘，
    // 再往右下拖可能被屏幕边界夹住，看不出"有没有跟手"。
    const grab = { x: win.x + BODY_CENTRE.x, y: win.y + BODY_CENTRE.y }
    const drop = { x: grab.x - 160, y: grab.y - 140 }
    await mouseSweep(grab, drop)
    await delay(1200)

    const after = logs.join('').match(/结束拖动 → \((-?\d+),(-?\d+)\)/)
    check(Boolean(after), '拖动结束后主进程记录了新位置', `日志：${after?.[0] ?? '（没有）'}`)

    if (after) {
      const moved = { x: Number(after[1]), y: Number(after[2]) }
      const dx = moved.x - win.x
      const dy = moved.y - win.y
      check(
        Math.abs(dx - (drop.x - grab.x)) <= 30 && Math.abs(dy - (drop.y - grab.y)) <= 30,
        '★ 窗口跟着光标移动了（位移与拖动距离一致）',
        `期望位移约 (${String(drop.x - grab.x)}, ${String(drop.y - grab.y)})，实际 (${String(dx)}, ${String(dy)})`,
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
