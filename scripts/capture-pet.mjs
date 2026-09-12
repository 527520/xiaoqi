/**
 * 用真实素材起一次宠物窗口并截图 —— 纯取证，不做判定。
 *
 * 用途：让"它现在长什么样"变成一张**可以看**的图。
 * 本项目不能用 DevTools 调试渲染进程（打开它透明窗会变不透明），
 * 而 CDP 是外部连接、走合成结果，因此既能截到 WebGL 画布又不干扰窗口。
 *
 * 用法：
 *   node scripts/capture-pet.mjs <素材目录> [输出 png]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { connectCdp, delay, launchApp } from './cdp.mjs'

const petDir = process.argv[2]
if (!petDir) {
  console.error('用法：node scripts/capture-pet.mjs <素材目录> [输出 png]')
  process.exit(1)
}
const outPath = process.argv[3] ?? join('docs', 'evidence', 'runtime', 'sprite', 'pet.png')

const port = 9699
const { child, browserUrl } = launchApp({
  port,
  env: { XIAOQI_PET_DIR: petDir },
})

let cdp = null
try {
  cdp = await connectCdp(await browserUrl, 'index.html')
  // 等图集解码 + 首帧渲染。图集 2MB，解码与建纹理需要一点时间。
  await delay(3500)

  // 顺带把舞台内部状态读出来：截图只能看"是什么样"，
  // 而"它认为自己在播哪个动作、切了哪些帧"只能从内部读。
  const snapshot = await cdp.evaluate('JSON.stringify(window.__petDebug?.() ?? null)')
  console.log('舞台状态：')
  console.log(JSON.stringify(JSON.parse(snapshot), null, 2))

  const png = Buffer.from(await cdp.screenshot(), 'base64')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, png)
  console.log(`\n截图已保存：${outPath}（${String(png.length)} 字节）`)
} finally {
  cdp?.close()
  child.kill()
  await delay(600)
}
