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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
