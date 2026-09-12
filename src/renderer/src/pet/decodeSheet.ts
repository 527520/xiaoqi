import { atlasForVersion, type SpriteVersion } from '@shared/petAtlas'

/**
 * 把图集图**解码成像素** —— 渲染进程里唯一碰 DOM 的一小步。
 *
 * ── 为什么要绕一趟 canvas ──
 *
 * 图集在渲染进程里是"一张图"，而命中蒙版需要的是**每个像素的 alpha**。
 * 拿到 alpha 只有一条路：把图绘到 2D canvas 上再 `getImageData`。
 *
 * ⚠️ 用 `<canvas>` 而不是 `OffscreenCanvas`：本机实测过 Electron 里
 *    `OffscreenCanvas` 的可用性，但 `ImageBitmap` 在离屏画布上的
 *    `drawImage` 行为与 DOM canvas 有细微差别（色彩空间与预乘 alpha），
 *    而我们要读的**恰好是 alpha**。用一个附在文档上的隐藏 canvas 最稳，
 *    代价只是一次几十毫秒的同步绘制（开机时一次）。
 *
 * 这个文件刻意保持**薄**：它只做"URL → 像素"，所有判断与换算都在
 * `spriteSheet.ts` 的纯函数里。于是"像素读出来是什么样"这件事
 * 可以被假的 `PixelSource` 完整测试，不需要真的跑浏览器。
 */

/** 解码结果：像素 + 用于建纹理的 canvas。 */
export interface DecodedSheet {
  readonly pixels: {
    readonly width: number
    readonly height: number
    readonly data: Uint8ClampedArray
  }
  /** 纹理源。Pixi 可以直接从它建纹理，省掉第二次上传。 */
  readonly canvas: HTMLCanvasElement
}

/** 解码失败的原因（给日志用，不抛给用户看）。 */
export class SheetDecodeError extends Error {}

/**
 * 加载并解码图集。
 *
 * @param url 图集 URL（自定义协议 `xiaoqi-pet://`）
 * @param version 期望的图集版本（决定校验用的尺寸）
 *
 * @throws {SheetDecodeError} 加载失败或尺寸不符
 */
export async function decodeSpriteSheet(
  url: string,
  version: SpriteVersion,
): Promise<DecodedSheet> {
  const atlas = atlasForVersion(version)

  const response = await fetch(url)
  if (!response.ok) {
    throw new SheetDecodeError(`图集加载失败（HTTP ${String(response.status)}）：${url}`)
  }
  const blob = await response.blob()

  // `createImageBitmap` 比 `<img>` + `onload` 快，且不受"图片尚未解码"的竞态影响。
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (error) {
    throw new SheetDecodeError(`图集无法解码（不是有效的图片？）：${String(error)}`)
  }

  try {
    if (bitmap.width !== atlas.atlasWidth || bitmap.height !== atlas.atlasHeight) {
      throw new SheetDecodeError(
        `图集尺寸与契约不符：应为 ${String(atlas.atlasWidth)}×${String(atlas.atlasHeight)}` +
          `（V${String(version)}），实际 ${String(bitmap.width)}×${String(bitmap.height)}`,
      )
    }

    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    // `willReadFrequently`：我们**一定**会调 getImageData，声明出来让
    // Chromium 用 CPU 后备存储，否则它会为 GPU 合成优化，读回时明显更慢。
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new SheetDecodeError('无法取得 2D 绘图上下文（canvas.getContext 返回 null）')
    }

    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)

    return {
      pixels: { width: imageData.width, height: imageData.height, data: imageData.data },
      canvas,
    }
  } finally {
    // ImageBitmap 占的是 GPU/系统内存，用完必须显式释放——
    // 一张 1536×2288 的位图约 14MB，不释放会在常驻进程里一直占着。
    bitmap.close()
  }
}
