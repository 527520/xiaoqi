/**
 * 截出同一个动作的**多个帧**，用来证明"动画真的在推进"。
 *
 * 为什么单独一个脚本：静态截图只能证明"画出来了"，
 * 证明不了"它在动"。而切帧错误的典型表现恰恰是**看起来有画面但不动**
 * （时间基准被每帧重置、帧索引恒为 0）。
 *
 * 做法：连拍若干张，每张之间隔一小段，然后比对它们的字节
 * —— 不同帧必须产出**不同**的 PNG。相同就说明画面是冻住的。
 *
 * 用法：
 *   node scripts/capture-pet-frames.mjs <素材目录> [张数] [间隔ms]
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { connectCdp, delay, launchApp } from './cdp.mjs'

const petDir = process.argv[2]
if (!petDir) {
  console.error('用法：node scripts/capture-pet-frames.mjs <素材目录> [张数] [间隔ms]')
  process.exit(1)
}
const count = Number(process.argv[3] ?? 6)
const gapMs = Number(process.argv[4] ?? 260)
const outDir = join('docs', 'evidence', 'runtime', 'sprite')

const port = 9698
const { child, browserUrl } = launchApp({ port, env: { XIAOQI_PET_DIR: petDir } })

let cdp = null
try {
  cdp = await connectCdp(await browserUrl, 'index.html')
  await delay(3500)
  mkdirSync(outDir, { recursive: true })

  const digests = []
  for (let index = 0; index < count; index++) {
    const png = Buffer.from(await cdp.screenshot(), 'base64')
    const digest = createHash('sha256').update(png).digest('hex')
    digests.push(digest)
    const path = join(outDir, `frame-${String(index)}.png`)
    writeFileSync(path, png)

    // 顺便读一下舞台自己认为现在在第几帧——截图与内部状态要对得上
    const rect = await cdp.evaluate(
      'JSON.stringify(window.__petDebug?.()?.currentFrameRect ?? null)',
    )
    console.log(`帧 ${String(index)}：${path}  frameRect=${rect}`)
    await delay(gapMs)
  }

  const unique = new Set(digests).size
  console.log(`\n${String(count)} 张截图里有 ${String(unique)} 张互不相同`)
  if (unique <= 1) {
    console.error('❌ 画面是冻住的：所有截图逐字节相同（查时间基准是否被每帧重置）')
    process.exitCode = 1
  } else {
    console.log('✅ 画面在变（切帧确实在推进）')
  }
} finally {
  cdp?.close()
  child.kill()
  await delay(600)
}
