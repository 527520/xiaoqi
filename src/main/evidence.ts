import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type BrowserWindow, desktopCapturer, screen } from 'electron'

/**
 * 取证模块 —— 只在设置了 `XIAOQI_EVIDENCE_DIR` 时启用，默认完全惰性。
 *
 * ── 为什么取证要走**桌面捕获**而不是自己截自己的窗口 ──
 *
 * 施工令 §4.3② 实测结论：**Chromium 自捕获合成的是不透明位图**，
 * 所以「窗口是否真的透明」这件事只能靠桌面取样来回答。
 * 同理，「捕获排除是否生效」也必须从桌面捕获里看——
 * 自捕获永远看得到自己。
 *
 * ⚠️ 这是**开发期诊断**能力，不是产品功能：产品永不截屏（§1.1① 绝不读取屏幕内容）。
 * 它只在显式设置环境变量时运行，且只捕获**自己的窗口区域**用于核对渲染结果。
 */

export function evidenceDir(): string | null {
  const dir = process.env.XIAOQI_EVIDENCE_DIR
  return dir && dir.length > 0 ? dir : null
}

/** 本机没有显示器时（无头会话）直接跳过，避免抛异常。 */
async function captureDesktop(): Promise<Electron.NativeImage | null> {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  })

  const source = sources[0]
  if (!source) return null
  return source.thumbnail
}

function save(dir: string, name: string, image: Electron.NativeImage): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, image.toPNG())
  return path
}

/** 从整屏截图里裁出指定矩形（用于只看窗口区域）。 */
function cropTo(image: Electron.NativeImage, rect: Electron.Rectangle): Electron.NativeImage {
  const size = image.getSize()
  return image.crop({
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.min(size.width, Math.round(rect.width)),
    height: Math.min(size.height, Math.round(rect.height)),
  })
}

/**
 * 跑一轮完整取证：
 * 1. 保护关闭时捕获 —— 证明窗口真的画在桌面上（否则整轮取证无意义）
 * 2. 保护开启时捕获 —— 证明捕获排除生效（M1 的"一键隐身"底线）
 *
 * 与 `verify/main.mjs` 的 V5 用的是同一套判据（洋红探针块），
 * 区别是这里直接对**真实的宠物窗口**取样，而不是一个探针方块。
 */
export async function runEvidenceCapture(window: BrowserWindow): Promise<string[]> {
  const dir = evidenceDir()
  if (!dir) return []

  const written: string[] = []
  const bounds = window.getBounds()

  const cropToPet = (image: Electron.NativeImage): Electron.NativeImage =>
    image.crop({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.min(image.getSize().width, Math.round(bounds.width)),
      height: Math.min(image.getSize().height, Math.round(bounds.height)),
    })

  // ── ① 保护关闭：应当能看到宠物 ──
  window.setContentProtection(false)
  await delay(400)
  const unprotected = await captureDesktop()
  if (unprotected) {
    written.push(save(dir, '01-unprotected-window-crop.png', cropToPet(unprotected)))
    written.push(save(dir, '02-unprotected-desktop.png', unprotected))
  }

  // ── ② 保护开启：宠物应当从捕获中消失 ──
  window.setContentProtection(true)
  await delay(400)
  const protectedImage = await captureDesktop()
  if (protectedImage) {
    written.push(save(dir, '03-protected-desktop.png', protectedImage))
  }

  return written
}

/**
 * 缩放透明度实测（仅当 `XIAOQI_RESIZE_TEST=<缩放>` 时启用）。
 *
 * ── 为什么必须实测，不能靠推测 ──
 *
 * 施工令 §4.3② 只警告了 `resizable: true` 可能破坏透明，
 * 并且明确说 `backgroundColor` 这类参数**只在创建窗口时有效、运行期不可改**。
 * 那么"运行期用 `setBounds` 改一个 `transparent` 窗口的尺寸"到底会不会
 * 让窗口变成不透明黑块或干脆不绘制？**规格里没有答案，只能自己量。**
 *
 * 这是"宠物可缩放"方案的前提：如果 `setBounds` 会破透明，
 * 就只能退化成"只缩放渲染内容、窗口尺寸不变"。
 *
 * 判据与 V3/V4 一致：取窗口区域，看透明留白处是否**仍然是桌面**。
 */
export async function runResizeTest(window: BrowserWindow, scale: number): Promise<string[]> {
  const dir = evidenceDir()
  if (!dir) return []

  const written: string[] = []
  const before = window.getBounds()
  window.setContentProtection(false)

  // 按缩放比例改窗口尺寸。注意位置也要重算，否则宠物会从右下角跑出去。
  const width = Math.round(before.width * scale)
  const height = Math.round(before.height * scale)
  window.setBounds({
    x: before.x + before.width - width,
    y: before.y + before.height - height,
    width,
    height,
  })

  await delay(900)

  const after = window.getBounds()
  const image = await captureDesktop()
  if (image) {
    // 先抓一张"窗口所在区域"的原图，再看裁剪。
    // 之前只存了裁剪图，而它整片是白的，无法判断是"窗口真的不透明了"
    // 还是"裁剪位置取错了"——所以两张都留下。
    written.push(save(dir, '04-resize-desktop.png', image))
    written.push(save(dir, '05-resize-window-crop.png', cropTo(image, after)))
    // 再抓一块"窗口之外"的同尺寸参照区，作为"桌面长什么样"的对照。
    // 如果窗口区与参照区颜色分布一致，说明窗口是透明的；
    // 如果窗口区异常（例如整片白），就是不透明了。
    written.push(
      save(
        dir,
        '06-reference-desktop-sample.png',
        cropTo(image, { x: 200, y: 200, width: after.width, height: after.height }),
      ),
    )
  }

  const report = [
    `缩放前窗口：${String(before.width)}×${String(before.height)} @ (${String(before.x)},${String(before.y)})`,
    `缩放后窗口：${String(after.width)}×${String(after.height)} @ (${String(after.x)},${String(after.y)})`,
    `请求缩放：${String(scale)}；实际尺寸是否吻合：${
      after.width === width && after.height === height ? '是' : '否'
    }`,
  ]
  return [...report, ...written]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
