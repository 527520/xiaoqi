import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

import { protocol } from 'electron'
import { SPRITE_SHEET_PNG_FILE } from '@shared/petDefinition'

/**
 * 自定义协议 —— 让**沙箱化的渲染进程**能读到宠物素材，而不给它文件系统能力。
 *
 * ── 为什么不能直接把路径给渲染进程 ──
 *
 * 渲染进程是 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`
 * 的，它**没有 Node**，所以既不能 `fs.readFile`，也不该拿到一个绝对路径
 * （那等于把"读任意文件"的能力通过 `file://` 递出去）。
 *
 * 也不能把图集塞进 IPC：1536×2288 的 RGBA 解码后是 14MB，
 * 每次都走结构化克隆是纯浪费——而且 Chromium 的解码器本来就在渲染进程里，
 * 让 `<img>` / `fetch` 走正常资源加载路径最快。
 *
 * 所以注册一个**只读、只认自己那个目录**的协议：
 *
 *     xiaoqi-pet://sheet/spritesheet.webp
 *
 * ── 安全边界就是"路径必须落在素材目录内" ──
 *
 * `resolve()` 之后必须仍然以素材目录为前缀，否则拒绝。这一条防的是
 * `xiaoqi-pet://sheet/../../../Windows/System32/config/SAM` 这类穿越。
 * 素材目录本身来自 `XIAOQI_PET_DIR`（用户自己指定），所以即使被读到，
 * 泄露的也只是用户自己放进去的东西——但仍要拦，因为"渲染进程能读文件"
 * 这件事本身就是个不该打开的缺口。
 */

/** 协议名。带 `-` 的自定义 scheme 必须用 `registerSchemesAsPrivileged` 声明可 fetch。 */
export const PET_ASSET_SCHEME = 'xiaoqi-pet'

/** 素材目录（由 `registerPetAssetProtocol` 设置）。 */
let assetRoot: string | null = null

/**
 * 声明这个 scheme 是"特权"的。
 *
 * ⚠️ **必须在 `app.ready` 之前调用**，否则 `fetch`/`<img>` 会拒绝加载它。
 *    这一点不满足时的表现是"图集永远加载不出来"，而报错信息是
 *    "URL scheme must be http/https" 之类看起来无关的话。
 */
export function declarePetAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PET_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        /**
         * ★ `corsEnabled` 是**必需的**，而且原因很不直观。
         *
         * 渲染进程是从 `file://` 加载的（打包后 `loadFile`），而
         * `fetch('xiaoqi-pet://...')` 在 Chromium 眼里是一次**跨源**请求。
         * 没有这个标志时它会直接拒掉，报的是：
         *
         *     Access to fetch at 'xiaoqi-pet://...' from origin 'file://' has been
         *     blocked by CORS policy: Cross origin requests are only supported for
         *     protocol schemes: chrome, chrome-extension, chrome-untrusted, data,
         *     http, https.
         *
         * 这句话会把人引向"要不要换成 http"——而真正缺的就是这一行。
         * 实测踩过一次（CSP 放开之后接着撞上它，两条报错完全不同、指向也不同）。
         */
        corsEnabled: true,
        // 不声明 `bypassCSP`：CSP 仍然有效，我们只在那份策略里显式放行
        // `connect-src xiaoqi-pet:`。让 CSP 保持能拦住其他东西。
        bypassCSP: false,
      },
    },
  ])
}

/** 素材目录里允许被读取的文件名（白名单，不是黑名单）。 */
const ALLOWED_FILES = new Set([SPRITE_SHEET_PNG_FILE, 'spritesheet.webp', 'pet.json'])

/**
 * 注册协议处理。必须在 `app.ready` **之后**调用。
 *
 * @param root 素材目录（绝对路径）
 */
export function registerPetAssetProtocol(root: string): void {
  const resolvedRoot = resolve(root)
  assetRoot = resolvedRoot

  protocol.handle(PET_ASSET_SCHEME, async (request) => {
    const requested = resolveRequestPath(request.url, resolvedRoot)
    if (!requested) {
      return new Response('素材请求被拒绝：路径不在素材目录内', { status: 403 })
    }
    if (!ALLOWED_FILES.has(requested.fileName)) {
      return new Response(`素材请求被拒绝：不允许读取 ${requested.fileName}`, { status: 403 })
    }

    try {
      const data = await readFile(requested.path)
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'content-type': contentTypeFor(requested.fileName),
          // ★ 必须显式给出，且不能是 `*`。
          //
          // 渲染进程的源是 `file://`，而 `Access-Control-Allow-Origin: *`
          // 对**非 http(s) 的源**不生效（规范如此：通配符不匹配"不透明源"）。
          // 实测用 `*` 时 Chromium 仍然报 CORS 失败，换成 `file://` 才通。
          //
          // 素材只在本地、只由本应用的渲染进程读取，所以这个放行面
          // 就是"我们自己"。
          'access-control-allow-origin': 'file://',
          // 素材在运行期不会变，缓存起来省掉重复读盘
          'cache-control': 'no-cache',
        },
      })
    } catch (error) {
      return new Response(`素材读取失败：${(error as Error).message}`, { status: 404 })
    }
  })
}

/**
 * 把请求 URL 解析成一个**经校验的**文件路径。
 *
 * 抽成纯函数是为了能被单测覆盖路径穿越那几条——它错了就是安全边界破了，
 * 而"安全边界破了"不会自己报错。
 *
 * @returns 合法时返回路径与文件名；越界或格式不对时返回 null
 */
export function resolveRequestPath(
  url: string,
  root: string,
): { path: string; fileName: string } | null {
  let pathname: string
  try {
    // URL 里的 host 部分是 `sheet`，path 部分才是文件名
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }

  // 去掉开头的 `/`，统一分隔符
  const relative = pathname.replace(/^\/+/, '').replace(/\\/g, '/')
  if (relative === '') return null

  // 只允许单层文件名：任何子目录（包括 `..`）一律拒绝。
  // 比"拼接后判断前缀"更严——前缀判断在 Windows 上还有大小写与短名的坑。
  if (relative.includes('/')) return null

  const fileName = relative
  const full = normalize(join(root, fileName))

  // 双重保险：normalize 之后必须仍在 root 之内
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (!full.startsWith(rootWithSep)) return null

  // 扩展名白名单（防止读到同目录下别的文件）
  const ext = extname(fileName).toLowerCase()
  if (ext !== '.webp' && ext !== '.png' && ext !== '.json') return null

  return { path: full, fileName }
}

/** 由扩展名给 content-type。 */
function contentTypeFor(fileName: string): string {
  if (fileName.toLowerCase().endsWith('.png')) return 'image/png'
  if (fileName.toLowerCase().endsWith('.json')) return 'application/json'
  return 'image/webp'
}

/**
 * 给渲染进程用的图集 URL。
 *
 * ⚠️ 用 `net.fetch` 之外不要拼 `file://`：Chromium 对自定义 scheme 的
 *    "标准 URL" 解析需要 host 部分存在，所以固定给一个 `sheet` host。
 */
export function petAssetUrl(fileName: string): string {
  return `${PET_ASSET_SCHEME}://sheet/${encodeURIComponent(fileName)}`
}

/** 当前素材目录（诊断用）。 */
export function petAssetRoot(): string | null {
  return assetRoot
}
