/**
 * M2 证据（施工令 §5 M2 明确要求：**调试面板截图**）。
 *
 * ── 这个脚本证明什么 ──
 *
 * 1. 调试面板**真的在打印**，且四类状态（工作模式/情绪/生理/关系）都在里面；
 * 2. **关系层真的接进了状态引擎**——不是"写了个模块没人调"。
 *    这是本轮最容易发生的静默失效：`relationship.ts` 单测全绿、
 *    `perception.ts` 也接上了，但**主进程没把它推给渲染层**，
 *    于是画面上什么都看不到，而所有测试仍然是绿的。
 *    所以这里从**渲染进程**那一侧取状态来核对。
 * 3. **关系基调真的影响到了画面**：分别锁成三种基调各截一张图，
 *    并核对舞台里的动画系数确实不同。这堵的是
 *    "传进来一个字段但没人用"这类静默失效。
 * 4. 点击链路可用（交互动画计时器在工作）。
 *
 * 用法：node scripts/verify-m2.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connectCdp, delay, launchApp } from './cdp.mjs'

const outDir = join(process.cwd(), 'docs', 'evidence', 'runtime', 'm2')
/**
 * 记忆数据库放**临时目录**，不放证据目录。
 *
 * `.gitignore` 已经忽略了 `*.db`，但它们仍然会堆在 `docs/evidence/` 下，
 * 让"证据目录"里混进一堆一次性文件——真正要看的截图会被淹掉，
 * 而"这个目录里哪些是要提交的"也变得需要判断。
 * 临时目录的东西由系统清理，不需要我们操心。
 */
const dbDir = mkdtempSync(join(tmpdir(), 'xiaoqi-m2-'))
const debugPort = 9897

/** 三种基调应当各自对应一组不同的动画系数。 */
const EXPECTED_COEFFICIENTS = {
  reserved: { breathScale: 1, swayScale: 1, fidgetScale: 1, lean: 0 },
  warm: { breathScale: 1.15, swayScale: 1.3, fidgetScale: 1.25, lean: 0.012 },
  attached: { breathScale: 1.35, swayScale: 1.6, fidgetScale: 1.5, lean: 0.024 },
}

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures++
}

/** 启动一次应用、锁定某个基调、截一张图，返回日志与舞台快照。 */
async function captureMood(mood) {
  const { child, logs, browserUrl } = launchApp({
    port: debugPort,
    env: {
      XIAOQI_MEMORY_DB: join(dbDir, `mood-${mood}.db`),
      XIAOQI_DEBUG_STATE: '1',
      // 感知间隔调快，好在几秒内看到面板动起来
      // （生理量每小时只变几个百分点，默认 2 秒一拍看不出变化）。
      XIAOQI_PERCEPTION_INTERVAL_MS: '700',
      XIAOQI_FORCE_MOOD: mood,
      XIAOQI_KEEP_OPEN_MS: '14000',
    },
  })

  let cdp = null
  try {
    const url = await Promise.race([
      browserUrl,
      delay(20_000).then(() => {
        throw new Error('等待 DevTools 端点超时')
      }),
    ])
    cdp = await connectCdp(url, 'index.html')
    await delay(5000)

    const stateJson = await cdp.evaluate('window.xiaoqi.getState().then((s) => JSON.stringify(s))')
    const snapshotJson = await cdp.evaluate(
      'typeof window.__petDebug === "function" ? JSON.stringify(window.__petDebug()) : "null"',
    )

    mkdirSync(outDir, { recursive: true })
    const shot = join(outDir, `mood-${mood}.png`)
    writeFileSync(shot, Buffer.from(await cdp.screenshot(), 'base64'))

    return {
      logs: logs.join(''),
      state: JSON.parse(stateJson),
      snapshot: snapshotJson === 'null' ? null : JSON.parse(snapshotJson),
      shot,
    }
  } finally {
    cdp?.close()
    child.kill()
    await delay(800)
  }
}

mkdirSync(outDir, { recursive: true })

// ── ① 先跑一次默认（不锁基调），核对调试面板 ──
console.log('① 启动应用，核对调试面板…\n')
const baseline = await captureMood('reserved')
const log = baseline.logs
/** 面板的**表头**行（`[状态] +Ns`）。 */
const panelHeaders = log.split('\n').filter((line) => line.includes('[状态]'))
/**
 * 要存档的**完整**面板输出：表头 + 缩进的明细行。
 *
 * ⚠️ 必须连明细一起抓。最初只挑含 `[状态]` 的行，于是存档里只剩
 *    `[状态] +0s` 这种空壳——真正的状态内容（前台进程、工作模式、
 *    情绪、生理、关系）全在缩进行里，一条都没存上。
 *    这种"存档看着有内容、其实什么都没存"的失败很隐蔽。
 */
const panelArchive = log
  .split('\n')
  .filter((line) => line.includes('[状态]') || /\[xiaoqi\]\s{2,}\S/.test(line))

check(
  panelHeaders.length > 0,
  '★ 调试面板真的在打印状态行（XIAOQI_DEBUG_STATE=1）',
  panelHeaders.length > 0 ? `共 ${String(panelHeaders.length)} 行` : '**一行都没有**',
)

for (const [label, pattern] of [
  ['工作模式', /msedge|code\.exe|→/],
  ['情绪', /情绪/],
  ['生理', /精力/],
  ['关系', /好感/],
]) {
  check(pattern.test(log), `调试面板里出现了「${label}」`, pattern.test(log) ? '' : '**没找到**')
}

check(
  log.includes('关系基调已锁定为 reserved'),
  '取证开关生效（XIAOQI_FORCE_MOOD）',
  log.includes('关系基调已锁定') ? '' : '**没有出现锁定日志**',
)

// ── ② 关系层真的被推到了渲染进程 ──
check(
  ['reserved', 'warm', 'attached'].includes(baseline.state.mood),
  '★ 主进程把关系基调推给了渲染层（不是只写了个没人调的模块）',
  `mood = ${JSON.stringify(baseline.state.mood)}`,
)
check(
  baseline.snapshot !== null,
  '舞台诊断钩子可用（__petDebug）',
  baseline.snapshot ? '' : '**拿不到舞台快照**',
)
check(
  baseline.snapshot?.mood === baseline.state.mood,
  '★ 舞台里的基调与主进程推送的一致（传下来没被丢掉）',
  `舞台 ${JSON.stringify(baseline.snapshot?.mood)} vs 主进程 ${JSON.stringify(baseline.state.mood)}`,
)

// ── ③ 三种基调各自截图，并核对系数 ──
console.log('\n② 逐个基调截图并核对动画系数…\n')
const seen = new Map()
for (const mood of ['reserved', 'warm', 'attached']) {
  const result = mood === 'reserved' ? baseline : await captureMood(mood)
  const anim = result.snapshot?.moodAnimation

  check(
    JSON.stringify(anim) === JSON.stringify(EXPECTED_COEFFICIENTS[mood]),
    `基调 ${mood} → 动画系数正确`,
    `期望 ${JSON.stringify(EXPECTED_COEFFICIENTS[mood])}，实际 ${JSON.stringify(anim)}`,
  )
  check(result.snapshot?.mood === mood, `基调 ${mood} 真的传到了舞台`, result.shot)
  seen.set(mood, JSON.stringify(anim))
}

// ★ 三种系数必须**互不相同**，否则"关系影响画面"就是空话。
check(
  new Set(seen.values()).size === 3,
  '★ 三种基调的动画系数**互不相同**（关系确实改变了画面）',
  [...seen.entries()].map(([m, v]) => `${m}: ${v}`).join('\n     '),
)

// ── ④ 调试面板输出存档（截图看不全日志）──
//
// ⚠️ 扩展名用 `.txt` 而不是 `.log`：`.gitignore` 顶层有一条 `*.log`
//    （那是给运行期日志用的），它**优先于**后面针对证据目录的否定规则，
//    于是 `.log` 的证据文件会静静地进不了仓库。改名比再叠一条否定规则干净。
const logPath = join(outDir, 'debug-panel.txt')
writeFileSync(logPath, panelArchive.join('\n'), 'utf8')
check(
  panelArchive.length >= 4,
  '调试面板输出已存档（含明细行）',
  `${String(panelArchive.length)} 行 → ${logPath}`,
)

// ── ⑤ 点击链路 ──
console.log('\n③ 核对点击链路…\n')
{
  const { child, browserUrl } = launchApp({
    port: debugPort,
    env: {
      XIAOQI_MEMORY_DB: join(dbDir, 'click.db'),
      XIAOQI_DEBUG_STATE: '0',
      XIAOQI_KEEP_OPEN_MS: '12000',
    },
  })
  let cdp = null
  try {
    const url = await Promise.race([
      browserUrl,
      delay(20_000).then(() => {
        throw new Error('超时')
      }),
    ])
    cdp = await connectCdp(url, 'index.html')
    await delay(4000)

    const before = JSON.parse(await cdp.evaluate('JSON.stringify(window.__petDebug().animation)'))
    // ★ 必须用 `__petInteract()` 而不是 `window.xiaoqi.notifyInteraction()`。
    //   后者只把"用户点了"告诉主进程（记记忆、推进生理），**不经过 Pixi 的
    //   pointerup**，因此不会触发舞台上的弹跳。要验证"点了会有动效"，
    //   必须走那个真的调用 `#trigger()` 的钩子。
    //   第一版就是用了 notifyInteraction，于是这条断言失败而实现其实没问题——
    //   是"测错了东西"，不是"东西坏了"。
    await cdp.evaluate('(window.__petInteract(), true)')
    await delay(250)
    const after = JSON.parse(await cdp.evaluate('JSON.stringify(window.__petDebug().animation)'))

    check(
      before.reactionRemaining === 0 && after.reactionRemaining > 0,
      '★ 点击后交互动画被触发了（反应计时器从 0 变成正数）',
      `点击前 ${String(before.reactionRemaining)} → 点击后 ${String(after.reactionRemaining)}`,
    )

    // 动画必须**自己结束**并回到 0，否则帧率预算会永远停在"交互动画"档，
    // 宠物会一直以 60fps 空转（施工令 §4.3⑩：耗电是隐形差评源）。
    await delay(1400)
    const settled = JSON.parse(await cdp.evaluate('JSON.stringify(window.__petDebug().animation)'))
    check(
      settled.reactionRemaining === 0,
      '★ 交互动画自己结束了（回到待机，不会一直满帧空转）',
      `1.4 秒后 reactionRemaining = ${String(settled.reactionRemaining)}`,
    )
  } catch (error) {
    check(false, '点击链路验证出错', String(error))
  } finally {
    cdp?.close()
    child.kill()
    await delay(600)
  }
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
