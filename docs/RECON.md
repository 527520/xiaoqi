# 开源桌宠调研（M0 · 设计参考与许可证边界）

**调研日期**：2026-09-11
**调研方法**：`web_search` + PowerShell `Invoke-RestMethod`/`Invoke-WebRequest` 调用 GitHub REST API 与 `raw.githubusercontent.com`（本机 `web_fetch` 因 fake-IP DNS 不可用，全程未使用）
**许可证核验方式**：全部通过 GitHub REST API 的 `license` 字段读取，非人工猜测。5 个仓库一次性用 `/search/repositories?q=repo:...` 查询，未超未认证配额。

---

## 许可证边界总表

| 项目                                                                            | 许可证       | 能否借鉴代码                                 | 依据                                                                                                          |
| ------------------------------------------------------------------------------- | ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [OpenPetsHQ/openpets](https://github.com/OpenPetsHQ/openpets)                   | **MIT**      | ✅ 可借鉴/改编代码                           | API 返回 `license.spdx_id = MIT`（1,184★，TypeScript，最后推送 2026-09-05）                                   |
| [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat)                       | **MIT**      | ✅ 可借鉴代码（但技术栈为 Tauri/Rust，见下） | API 返回 `license.spdx_id = MIT`（23,084★，Vue，最后推送 2026-09-11）                                         |
| [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) | **AGPL-3.0** | ⛔ **绝不抄代码**，仅可读设计                | API 返回 `AGPL-3.0`（6,202★）。README 明确 artwork 与 theme 资产**不在 AGPL 覆盖范围内**，各自版权保留        |
| [ChaozhongLiu/DyberPet](https://github.com/ChaozhongLiu/DyberPet)               | **GPL-3.0**  | ⛔ **绝不抄代码**，仅可读设计                | API 返回 `GPL-3.0`（972★，Python/PySide6）                                                                    |
| [Adrianotiger/desktopPet](https://github.com/Adrianotiger/desktopPet)           | **无许可证** | ⛔ **禁止抄代码**，仅可读设计                | API `license` 字段为空（`spdx_id` 与 `name` 均为空串）；仓库根目录 `contents/` 列表无 `LICENSE`（1,144★，C#） |

> **判定规则（本项目沿用）**：许可证不明确 = 视为「保留所有权利」，只做设计阅读，不复制任何代码、配置或素材。
> BongoCat 为 MIT，但其实现是 Rust + Tauri v2，与我们的 Electron 栈不可直接复用代码，**只能借鉴它的产品思路与平台适配结论**。

### 素材（宠物形象）的许可证 —— **与代码许可证是两件事**

进入"图集宠物"这一版之后必须单独核一遍：**仓库的代码许可证不覆盖它附带的素材**。
这一轮用 GitHub API + 直接读 `ASSETS-LICENSE.md` / `README` 核过：

| 来源                                                                                            | 代码   | **素材**                                                            | 结论                                     |
| ----------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- | ---------------------------------------- |
| [legeling/awesome-codex-pet](https://github.com/legeling/awesome-codex-pet)（917★）             | MIT    | **默认 CC BY-NC 4.0（非商用）**；239 只里 28 只 MIT、4 只 CC BY 4.0 | ⚠️ 非商用可用；**其中没有 MIT 授权的猫** |
| [Luyu2026/Codex-Pet-Skill](https://github.com/Luyu2026/Codex-Pet-Skill)                         | MIT    | README **明确排除**示例宠物与美术资源                               | ⛔ 示例素材不可用                        |
| [backnotprop/codex-pets-react](https://github.com/backnotprop/codex-pets-react)                 | MIT    | 随包的 `tater` 美术**未标注授权**                                   | ⛔ 授权不明确 = 视为保留所有权利         |
| [gmskywalker/codex-pet-creation-guide](https://github.com/gmskywalker/codex-pet-creation-guide) | **无** | 只有校验器与模板                                                    | ⛔ 无许可证，不采纳                      |

**本项目据此定下的三条纪律**：

1. 仓库里**不附带**任何第三方宠物素材。`assets/pets/` 下只有**程序化生成**的
   测试图集（CC0，且被 `.gitignore` 忽略）。
2. 用户自带素材时，`pet.json` 的授权字段会被读出来并**打进启动日志**
   （`宠物形象：<名字> · <作者> · <授权>`）。授权决定能不能分发，
   必须在运行时可见，而不是埋在 README 里等着被忘记。
3. 缺授权字段时**只警告不拒绝**：社区包里很常见，拒绝加载既解决不了问题
   又把用户挡在门外。但警告要说清楚"请自行核实后再分发"。

> 一句话：**"代码 MIT"不等于"素材 MIT"**——本轮 239 只里能商用的猫是零。
> 这一条如果不主动去核，很容易在"我引用的是 MIT 仓库"的错觉里踩上去。

---

## 逐项目分析

### OpenPetsHQ/openpets（MIT）— **主架构参考**

**是什么**：Local-first 的桌面伴侣平台，桌宠会对编程 Agent 的活动做出反应，带插件 SDK 与宠物目录。pnpm + TypeScript monorepo，Electron 桌面端 + 一组 npm 包（`@open-pets/client`、`mcp`、`claude`、`dsh` 等）。
来源：[README](https://github.com/OpenPetsHQ/openpets)、[docs/architecture.md](https://github.com/OpenPetsHQ/openpets/blob/main/docs/architecture.md)。

**架构（对我们最有价值的四个点）**

1. **三运行时边界**：桌面 App（唯一长生命周期进程，持有状态/窗口/托盘/插件运行时/本地 IPC 服务）↔ Agent 侧集成（短生命周期，通过本地 IPC 发「reaction」命令）↔ 公共 Web 源（目录与 ZIP 托管）。IPC 走 Unix socket / Windows 命名管道 / TCP，协议带版本号，并写 discovery 文件供客户端发现。远程控制**不是** IPC 的一个模式，而是独立服务，默认关闭，只接受私有/loopback/link-local/CGNAT IPv4，拒绝通配符、公网地址、主机名、IPv6，载荷上限 4 KiB。
   → 对我们的启示：**主/渲染进程 + 窄 preload 桥**要比「一个大 preload 暴露一切」好维护得多。
2. **主/渲染分离**：main 持有全部权限；渲染进程默认沙箱化、`contextIsolation`，每个窗口只拿到**窄 preload**：Control Center 走 `control-center-preload.cjs`，宠物窗口走 `pet-preload.cjs`，插件宿主/面板走 `plugin-sdk-preload.cjs`。而且**没有默认主窗口** —— 应用是「托盘优先」（tray-first），托盘动作打开单例 Control Center 并路由到指定页。单例锁用 `app.requestSingleInstanceLock()`。
3. **启动顺序是确定性的**（值得照抄的纪律）：安装生命周期处理 → 初始化 app state → 初始化 logger → 注册 Talk 快捷键 → 建托盘 → 启本地 IPC → （可选）启远程控制 → 初始化并启动插件服务 → 构造 Pet Assistant → （可选）显示默认宠物。关闭时逆序：先注销快捷键，再停语音，再停 Assistant 回合，然后插件、远程监听、IPC 服务、宠物窗口。
4. **宠物窗口双角色 + 租约**：`default-pet-controller.ts` 管常驻伴侣（非租约绑定，按显示器记忆位置，显示器变化后夹回工作区）；`agent-pet-controller.ts` 管 Agent 宠物，按**租约**路由，第一个租约开窗、最后一个租约释放关窗，用 **PID 存活检测**在客户端进程退出后约 5 s 释放租约。右击任意宠物提供「水平翻转」（`preferences.petHorizontalFlip`，按 pet ID 持久化，气泡/HUD/命中区不镜像）。

**透明窗、置顶与点击穿透（本项目最关键的一节）**

- 宠物窗口由 `pet-window.ts` 创建为**透明 + 无边框 + 常置顶**，拖拽与点击穿透行为由 `pet-preload.cjs` 驱动。
- **点击穿透用 `setIgnoreMouseEvents(true, { forward: true })`**。这是一个**整窗开关**，不是逐像素命中测试。关键陷阱：一旦穿透，宠物只能通过 **forwarded 鼠标事件**感知光标在其上方 —— 而 Electron 只在 **macOS 与 Windows** 转发，**Linux 不转发**（所以 OpenPets 在 Linux 上让宠物窗口保持可交互）。
- **转发会静默失效**：macOS 在切换 Space、显示器睡眠、全屏切换后会失效；Windows 在宠物快速重载与全屏扫描后会失效。后果是宠物卡在穿透状态、**永远抓不住**。对策：`pet-window.ts` 里有一个**光标探针看门狗**，从主进程用 `screen.getCursorScreenPoint()` 重新武装转发 —— 探针在转发已死时依然有效。平台判定谓词隔离在 `mouse-forwarding.ts`。
- **Windows 全屏会剥掉 `HWND_TOPMOST`**：Shell 在别的应用进入全屏（浏览器视频、游戏）时静默移除其他窗口的 TOPMOST 且**不恢复**，而且**不触发任何 Electron 事件**（所以 `show`/`restore` 时的重新断言根本不会跑）。对策：宠物窗口在可见时**每 1 s 重新断言置顶**（Shell 每 ~2–4 s 扫一次，所以 1 s 节奏把「被埋」时间压到 1 s 内）。**并且必须先清掉 Electron 缓存的置顶标志** —— Electron 在缓存状态已匹配时会短路 `setAlwaysOnTop(true)`，不 cache-bust 的话这次调用根本到不了 OS。
- **Chromium 原生窗口遮挡跟踪**：全屏应用在前台时，遮挡跟踪器认为该显示器上所有窗口都被遮挡并**停止绘制** —— 透明宠物窗口会**变空白**，即使 z-order 完好。对策：Windows 上禁用 `CalculateNativeWinOcclusion`。
- **Linux/Wayland**：`main.ts` 在 `app` ready **之前**追加 `--ozone-platform=x11`，强制走 x11/XWayland，因为原生 Wayland 禁止客户端定位与重排自己的 toplevel —— `setPosition`/`setBounds`/`setAlwaysOnTop` 会被合成器静默忽略，导致重力、走动、跨屏、拖拽、置顶全部变空操作。强制是**无条件**的（连显式 `--ozone-platform=wayland` 也覆盖）。逃生舱是 `OPENPETS_ALLOW_WAYLAND=1`，此时启动打一次性警告。该分支由 `check-packaging-contract.ts` 断言，防止静默回归。
- 触屏/权限细节：Linux 上被动宠物窗口创建为 **non-focusable** 并以 inactive 显示，避免抢键盘焦点（Wayland 合成器如 Niri 上的焦点抢占问题）；当插件气泡含内联 input/select 时临时恢复可聚焦。

**宠物资源包与动画数据（与我们 `assets/pets/<name>/pet.json` 最可直接对照的约定）**

- 宠物包 = `pet.json` + `spritesheet.webp`。`pet.json` 字段：`id`、`displayName`、`description`、`spritesheetPath`，可选 `category`/`subcategory`/`sourceUrl`/`xHandle`。
- 精灵表是**帧网格**，帧尺寸**至少 192×208**；缩略图从精灵表派生。Codex V1 约定为 **8×9** 图集（9 行标准动画）；V2 需 `pet.json` 带 `"spriteVersionNumber": 2` 且源图是**可完整解码、带 alpha 的单图 WebP**、精确 **1536×2288（8×11）** 网格，否则在原子导入写入任何东西之前就被拒绝。
- **渲染方式是 CSS sprite 动画**（不是 PixiJS）：`pet-window.ts` 用 CSS 渲染选定动画。等待动画周期是全局偏好：Normal 用默认 `1010 ms`，Relaxed 用 `2200 ms`；渲染进程**重新推导**一张精灵状态表而不去改 `defaultPetSprite.states`。
- **三层解耦（强烈建议照搬）**：`reaction-animation-mapping.ts` 把 reaction 解析成精灵动画状态（`resolveReactionSpriteState`）；`reaction-messages.ts` 从文案池选一句话；`pet-window.ts` 负责渲染。可选的动画状态为 idle、review、running、waiting、waving、jumping、failed。**映射是用户可配置的**，覆盖项持久化在 app state 里。设计意图明确写着：Agent 与插件只说 _reaction_，宿主拥有「长什么样、说什么」。
- 三种来源：内置宠物（`built-in-pet.ts`，离线兜底）、目录宠物（解压到 `userData/pets/{id}/`）、Codex 宠物（从 `~/.codex/pets/` 导入，本地创作工作流）。
- **ZIP 安全（值得抄的硬约束）**：只允许 allowlist 上的 HTTPS 目录/ZIP 主机；禁止加密条目；只允许 stored/deflate；校验 Unix mode；必需文件 `pet.json` + `spritesheet.webp`；`yauzl` 严格条目校验（**无路径穿越、无符号链接、大小写冲突检测、大小/文件数上限**）；原子解压（临时目录 → rename）；独立安装器限额 50 MB 下载 / 200 MB 解压 / 500 文件 / 100 MB 单文件，并用 `.install-pet.lock`（10 分钟过期）防并发。`id` 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$` 且不能叫 `builtin`。
- **图片协议与 CSP**：宠物图片通过内部协议（`openpets-codex:`、`openpets-installed:`、`openpets-pet-preview:`）提供给渲染进程。**任何新协议或新图片来源都必须同时加进 `vite.config.ts` 和 `src/renderer/index.html` 的 CSP**，否则图片会静默回退到默认宠物 —— 文档直接称这是「为什么我的宠物显示错精灵」这类 bug 的**头号原因**。
- **移动引擎**：单个共享 ticker（≈60 fps）驱动所有宠物窗口；每只宠物在 `Map<petHandleId, MotionState>` 里有独立状态，但共用一个 `setInterval`，每 tick 只读一次 `getAllDisplaysCached()`。引擎是**唯一的位置写入者**（所有逐宠物 step 循环都被删除，以防多个写入者互相抖动）；用**亚像素小数累加器**（`fracX`/`fracY`）保证任意 tick 率下都平滑。显示器夹取优先级：confinement > 跨屏漫游（默认**关**）> 旧的单屏夹取。跨屏模式只在宠物**完全离开屏幕**时才吸附到最近显示器边缘。
- **无障碍**：reduced-motion 用户看到的是**静态首帧**而不是动画（见 desktop.md 对 delivery 精灵网格的描述）。
- 打包：`electron-builder.yml` 覆盖 macOS/Windows/Linux。

### ayangweb/BongoCat（MIT）— **功能清单参考**

**是什么**：跨平台互动桌宠，用键盘/鼠标/手柄事件驱动一只 Live2D 猫。**技术栈不是 Electron**：Tauri v2 + Rust + Vue 3 + Pinia + Live2D（`live2dcubismcore.min.js`），打包 NSIS/dmg/app/appimage/deb/rpm。
来源：[仓库](https://github.com/ayangweb/BongoCat)、[README](https://github.com/ayangweb/BongoCat/blob/master/README.md)、[tauri.conf.json](https://github.com/ayangweb/BongoCat/blob/master/src-tauri/tauri.conf.json)。

- **窗口配置**（`tauri.conf.json`）：主窗口 `transparent: true`、`decorations: false`、`alwaysOnTop: true`、`shadow: false`、`acceptFirstMouse: true`、`skipTaskbar: true`、`maximizable: false`；偏好窗口单独一个 label，`visible: false`。macOS 开了 `macOSPrivateApi`。
- **置顶用 Rust 侧 16 ms 轮询线程**：`SetWindowPos(HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` 循环（[windows.rs](https://github.com/ayangweb/BongoCat/blob/master/src-tauri/src/plugins/window/src/commands/windows.rs)）。**代价已被自己记录下来**：右键菜单会被自己的置顶窗口盖住，所以弹出菜单前必须先临时关掉置顶、关掉后再恢复。
- **点击穿透用 `setIgnoreCursorEvents`**，一个布尔偏好 `window.passThrough`，在托盘菜单里做成**可勾选项**（[useAppMenu.ts](https://github.com/ayangweb/BongoCat/blob/master/src/composables/useAppMenu.ts)）。注意它也是**整窗开关**，不做逐像素命中测试。
- **hide-on-hover 的实现方式值得注意**：Rust 侧有**光标轮询**把光标位置推给渲染进程，渲染进程用窗口 bounds 判断光标是否进入，进入后在延迟到期时把 `body` 透明度设 0 并 `setIgnoreCursorEvents(true)`，离开时恢复（[useDevice.ts](https://github.com/ayangweb/BongoCat/blob/master/src/composables/useDevice.ts)）。
- **窗口状态持久化/还原**（[useWindowState.ts](https://github.com/ayangweb/BongoCat/blob/master/src/composables/useWindowState.ts)）：监听 `onMoved`/`onResized` 存位置与尺寸；还原前先查 `availableMonitors()`，**只有存下来的坐标仍落在某台显示器范围内才应用**；`keepInScreen` 时用 500 ms debounce 把窗口夹回**光标所在**显示器。
- **暴露给用户的外观旋钮**（`stores/cat.ts`）：`window`：visible、passThrough、alwaysOnTop、scale、opacity、radius、hideOnHover、hideOnHoverDelay、keepInScreen；`model`：mirror、mouseMirror、motionSound、behavior、autoReleaseDelay、maxFPS。scale 档位 50–150%（步进 25），opacity 档位 25–100%。
- **性能旋钮**：`maxFPS` 直接写 PixiJS `Ticker.shared.maxFPS`（[live2d.ts](https://github.com/ayangweb/BongoCat/blob/master/src/utils/live2d.ts)），默认 60。另有「穿透」与「无边框顺手拖动」等取舍。
- 托盘：`iconAsTemplate: true`（macOS 模板图标）、`menuOnLeftClick: true`、tooltip 带版本号，菜单含偏好/隐藏猫/穿透/窗口尺寸/不透明度/检查更新/开源地址/版本号/重启/退出（[useTray.ts](https://github.com/ayangweb/BongoCat/blob/master/src/composables/useTray.ts)）。
- macOS 用 `tauri-nspanel` 的 `CollectionBehavior`（`stationary().can_join_all_spaces().full_screen_auxiliary()`）实现「全屏辅助」层级，`PanelLevel::Dock` 作为置顶档位。
- ⚠️ 它用 **Live2D 模型**（`cat.model3.json` + `.moc3` + `.motion3.json` + `.exp3.json` + `.flac`）而非 PNG 帧序列，与我们的帧序列约定不兼容，**不要模仿其资源格式**。

### rullerzhou-afk/clawd-on-desk（AGPL-3.0）— **仅读设计**

**是什么**：像素风桌宠，实时反映 Claude Code / Codex / Cursor / Copilot / Gemini 等一大批编程 Agent 的状态。Electron（JavaScript）。
来源：[README](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/README.md)。

**只读、可带走的设计思想**（实现一律不看、不抄）：

- **Do Not Disturb 的语义划分很精准**：「DND 抑制的是**要求你行动**的东西，不是状态」。进 DND 后宠物停止反应，**权限气泡被抑制**（回落到各 Agent 原生提示），但远程**完成**通知照常送达 —— 理由是「那正是你离开工位的意义」。
- **防骚扰的量化规则**：音效仅用于任务完成与权限请求，**10 s 冷却**，且在 DND 期间**自动静音**。
- **全局快捷键只在需要时注册**：`Ctrl+Shift+Y`/`Ctrl+Shift+N` 用来 Allow/Deny 最新权限气泡，**仅在气泡可见期间注册**。这是个很值得抄的模式（避免长期占用全局热键）。
- **气泡不堆积**：多个权限请求从右下角**向上堆叠**；如果你先在终端回答了，气泡**自动消失**；可按 Agent 单独关闭「弹窗气泡」。
- 交互细节：idle 跟随光标（身体倾斜 + 影子拉伸）；**60 s 无操作**后走「哈欠 → 打盹 → 瘫倒 → 睡眠」序列，鼠标移动触发惊醒动画；双击拍拍、连点 4 次甩尾；任意状态都能拖（用 Pointer Capture 防止快速甩动掉手）；**Mini 模式**贴边隐藏 + 悬停探头 + 抛物线跳跃过渡；位置跨重启记忆；单实例锁。
- 主题约定（`theme.json`）：**每个状态一个独立资源文件**（SVG/GIF/APNG/WebP/PNG/JPG），最小可用主题 = 1 个 SVG（带视线跟随的 idle）+ 7 个 GIF/APNG（thinking、working、error、happy、notification、sleeping、waking）；关掉视线跟随后所有状态都能用任意格式；`create-theme.js` 脚手架 + `validate-theme.js` 校验；主题卡片显示能力徽章（`Tracked idle`、`Static theme`、`Mini`、`Direct sleep`、`No reactions`），**让用户在切换前就知道这个主题支持什么**。第三方 SVG 会被自动消毒。
- ⚠️ **许可证边界注意**：代码 AGPL-3.0，但 README 明确写着 **artwork 与内置主题资产不受 AGPL 覆盖、各自版权保留**（Clawd 角色属 Anthropic，Calico/Cloudling 版权属作者）。**连素材也不能拿。**

### ChaozhongLiu/DyberPet（GPL-3.0）— **仅读设计**

**是什么**：基于 PySide6 的桌宠**框架**，强调模组自由度（宠物、迷你宠物、物品、音效均可扩展，JSON 配置上手）。
来源：[仓库](https://github.com/ChaozhongLiu/DyberPet)、[README](https://github.com/ChaozhongLiu/DyberPet/blob/main/README.md)。

- 配置面：`res/role/<PETNAME>/pet_conf.json`（含 `coin_config`）、`res/items/Default/items_config.json`、`res/role/<PETNAME>/note/note_config.json`（通知图标与声音按 `note_type` 关联）。
- 动画配置字段（README 变更日志）：`timeout`（true/false = 动画结束后关闭 / 不断循环）、`closable`（能否右键菜单关闭）。
- **他们的「防烦人」补丁史本身就是证据**（详见下一节）。
- 与我们差别大（Python/Qt），只取产品思路。

### Adrianotiger/desktopPet / eSheep（**无许可证 = 保留所有权利**）— **仅读设计**

**是什么**：1995 年 eSheep 的现代复刻（C#）。用一份简单 XML（`animations.xml`）就能换宠物与动画；宠物会下落、能**探测桌面上的窗口**，从而在窗口上走动；支持多屏。
来源：[仓库](https://github.com/Adrianotiger/desktopPet)、[Readme.md](https://github.com/Adrianotiger/desktopPet/blob/master/Readme.md)。

- 它的**资源约定极简**，可作对比参考：只需 1 个 `.ico` 应用图标 + 1 张**带透明通道的 PNG 精灵表**（「所有可能姿势」放在一张图里，约 1000×500 px），动画区域由 XML 描述；配套离线 Pet Editor 与在线编辑器。
- ⚠️ **无 LICENSE 文件**（已用 API + 根目录列表双重确认），**连它的 `Pets/` 素材也不要碰**。

### 额外发现（未在任务清单内，但有直接价值）

**[openai/codex](https://github.com/openai/codex) 的桌面宠物**（闭源桌面端，仅 issue 公开）：这是本轮**命中率最高**的负面证据来源。它的 issue 区有 4 个标签为 `bug/windows-os/app/pets` 的公开缺陷，全部围绕「宠物交互区与可见形象脱节」。详见「用户抱怨证据」一节。**仅作问题清单参考，其桌面端渲染器源码未公开，无任何代码可读。**

---

## 可借鉴的设计要点

### 透明窗与点击穿透

1. **先接受一个事实：这两家成熟项目都做的是「整窗开关」，没有逐像素命中测试。** 我没有在 openpets 或 BongoCat 中找到任何 `setShape`/`setInputRegion`/alpha-mask 命中测试的用法（对下载到的全部源码做了 `setShape|hit.?test|SetInputRegion|alpha.?mask|per.?pixel` 全文检索，**零命中**）。Electron 的 `setShape` 历史上虽有过 PR/backport，但**不在本项目应采用的路径上**；实践中的做法是 `setIgnoreMouseEvents` + 让气泡/HUD 等非宠物 UI 走常规 DOM 命中。
2. **`setIgnoreMouseEvents(true, { forward: true })` 的 `forward` 不是可选项，是必需品**：穿透后若没有转发事件，宠物就再也感知不到光标，等价于「永久抓不住」。
3. **必须有看门狗重新武装转发**：openpets 用主进程 `screen.getCursorScreenPoint()` 光标探针，因为 macOS（Space 切换、显示器睡眠、全屏切换）与 Windows（宠物快速重载、全屏扫描）都会**静默**停止转发。这条经验几乎是「不做就一定会踩」。
4. **Windows 置顶要周期性重断言，且必须先 cache-bust**：Shell 在全屏应用前台时静默剥夺 `HWND_TOPMOST` 且不发事件；Electron 又会因为缓存状态一致而短路 `setAlwaysOnTop(true)`。openpets 选 **1 s** 节奏（低耗），BongoCat 选 **16 ms** 循环（高耗，副作用已现）。**我们应取 openpets 的 1 s**。
5. **Windows 上禁用 `CalculateNativeWinOcclusion`**，否则全屏视频/游戏期间透明宠物窗口会变空白。
6. **置顶窗口会盖住自己的右键菜单**（BongoCat 实测），弹菜单前临时降级置顶、关闭后恢复 —— 这是个小而必踩的坑。
7. **Linux：强制 x11/XWayland**（在 `app` ready 之前追加 `--ozone-platform=x11`），并留一个环境变量逃生舱 + 一次性启动警告。理由必须写进代码注释：原生 Wayland 禁止客户端定位/重排 toplevel，会让位移、重力、拖拽、置顶**全部静默失效**。
8. **Linux 上不要指望转发**：Electron 的鼠标转发在 Linux 不生效，应像 openpets 一样让 Linux 宠物窗口保持可交互。另可选：Linux 被动窗口设为 **non-focusable** 以免抢焦点。

### 架构与 IPC

9. **托盘优先（tray-first），无默认主窗口**；单例锁 + 二次启动聚焦已有实例。
10. **每个窗口一个窄 preload**，渲染进程默认沙箱 + `contextIsolation`；main 独占状态与权限。
11. **确定性启动/关闭顺序**，关闭严格逆序（先注销快捷键/停语音，最后才关窗口与 IPC 服务）。
12. **「reaction」作为宿主与插件/Agent 之间的中立词汇**：集成方只说 reaction 名，宿主决定动画、文案、时长。三层解耦（reaction → animation state / speech 池 → 渲染）。
13. **位置单一写入者**：一个共享 ticker + `Map<handleId, MotionState>`，**禁止**每只宠物各自 step 循环（openpets 明确说这是为了消除多写入者抖动）；亚像素累加器保证平滑。
14. **生命周期用租约 + PID 存活检测**：Agent 宠物随客户端进程退出自动回收（~5 s）。
15. **显示几何集中在一个模块**，层级明确：confinement > 跨屏 > 单屏；显示器增删/分辨率变化后统一 reclamp。

### 资源包与动画数据

16. **`assets/pets/<name>/pet.json` + 精灵表是业界已验证的约定**（openpets 完全同构：`pet.json` + `spritesheet.webp`）。建议采纳并吸收这几点：
    - 元数据显式声明**帧尺寸**（openpets 下限 192×208）、**图集网格**（V1 8×9 / V2 8×11）、**版本号**（`spriteVersionNumber`），并在导入前**校验精确像素尺寸 + alpha 通道**，不合格就拒绝，绝不半途写入。
    - **状态 → 动画映射放进配置且允许用户覆盖**（openpets 的 `reaction-animation-mapping` 用户可配置并持久化）。
    - **时长是可配置的渲染身份**：openpets 把等待动画周期做成 Normal `1010 ms` / Relaxed `2200 ms` 全局偏好，且该时长是窗口渲染身份的一部分（已开窗口会立即重载）。
    - 我们若用 **PNG 帧序列**（而非图集），应学 clawd 的**逐状态独立文件**心智：单状态可替换、可静态（无动画也能用）、可用不同格式，并给资源包做**能力徽章**与 `validate` 脚本。
17. **导入必须原子且安全**：临时目录 → rename；拒绝路径穿越与符号链接；大小写冲突检测；大小/文件数上限；只允许 HTTPS allowlist 主机；校验 magic bytes；独立锁文件防并发。
18. **资源加载走内部协议 + CSP 必须双写**：这是 openpets 记录的**头号 bug 来源**（新协议忘了加进两处 CSP → 静默回退默认宠物）。我们若用 Vite + 自定义协议，务必同时改 `vite.config.ts` 与 `index.html`，并加一个启动自检。
19. **提供内置兜底宠物**，保证离线/无安装时也能渲染。
20. **无障碍**：reduced-motion 时渲染**静态首帧**。

### 托盘与快捷键

21. 托盘菜单是桌宠的**主控制面**：显示/隐藏、穿透开关、尺寸、不透明度、置顶、DND、开机自启、检查更新、版本号、重启、退出。BongoCat 的档位化（scale 50–150 步进 25、opacity 25–100 步进 25）比滑动条更好放菜单。
22. macOS 托盘用**模板图标**（`iconAsTemplate`）。
23. **全局快捷键按需注册**（clawd 只在气泡可见时注册 Allow/Deny 热键），并像 openpets 一样记录运行态（`registered`/`conflict`/`unavailable`/`invalid`），**替换前先注销旧 accelerator**，失败不得展示为生效。

### 耗电与性能

24. **`maxFPS` 暴露给用户**（BongoCat 直接写 PixiJS `Ticker.shared.maxFPS`，默认 60），并考虑无操作时降帧/暂停渲染。
25. **不要在 Rust/主进程里跑 16 ms 置顶轮询**（BongoCat 的做法）；1 s 重断言足够（openpets）。
26. **浮点累积而非每帧取整**，避免高刷新率下的抖动与无谓重绘。
27. BongoCat 的 Steam 讨论区有直指优化问题的帖子（见下节），说明 Live2D + 高频 ticker 的组合确有性能口碑风险 —— 我们的 PixiJS 方案要**从第一天就把帧率上限与「静止时停更」做进去**。

---

## 明确不采纳的做法（附理由）

| 不采纳                                    | 出处                       | 理由                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 直接复用 BongoCat 代码                    | BongoCat                   | MIT 但为 **Tauri v2 + Rust + Vue + Live2D**，与 Electron 44 + TS + React + PixiJS 不同构；资源格式（`cat.model3.json`/`.moc3`）也不兼容                                                          |
| Live2D 模型格式                           | BongoCat                   | 我们已定 PNG 帧序列 + `pet.json`；Live2D 引入 Cubism Core 与授权复杂度                                                                                                                           |
| 16 ms 无限置顶轮询                        | BongoCat `windows.rs`      | 每帧一次的 `SetWindowPos` 是持续的 CPU/消息开销；且已导致右键菜单被盖住的副作用。用 openpets 的 1 s 重断言 + cache-bust 替代                                                                     |
| 整屏 `opacity: 0` 实现 hide-on-hover      | BongoCat `useDevice.ts`    | 会让宠物变不可见但仍占位/仍渲染；应优先「暂停渲染 + 穿透」，避免无谓绘制                                                                                                                         |
| 每一帧都写入窗口位置的多写入者循环        | openpets 反面教材          | openpets 明确删除了所有逐宠物 step 循环以消除竞争写入导致的抖动                                                                                                                                  |
| 直接采用 clawd 的 `theme.json` 结构或素材 | clawd-on-desk              | **AGPL-3.0，且 artwork/主题资产明确不在 AGPL 覆盖内、各自版权保留**。连素材都不能拿                                                                                                              |
| 采用 DyberPet 的任何代码/配置             | DyberPet                   | **GPL-3.0**，传染性许可证                                                                                                                                                                        |
| 采用 desktopPet 的任何代码/素材           | Adrianotiger/desktopPet    | **无 LICENSE = 保留所有权利**，`Pets/` 素材同样不可用                                                                                                                                            |
| 自动更新走明文 HTTP 或第三方加速端点      | BongoCat `tauri.conf.json` | 其 updater 配了 `dangerousInsecureTransportProtocol: true` 和 `/gh-proxy.com/` 代理端点。我们不复制这种降级                                                                                      |
| 全屏时把宠物强行压在游戏/视频之上         | openpets 的选择            | openpets 明确选择「保持在全屏内容之上」（1 s 重断言 + 禁用遮挡跟踪）。**这与我们「别烦人」的原则冲突** —— 见下节，应改为**全屏时自动隐藏**（此处两种路线存在取舍，需用户拍板，已列入未确认事项） |

---

## 用户抱怨证据（"别烦人"设计的依据）

以下均为**可核实的公开记录**，不是我的推测。

### 1. 命中区/拖拽失效 —— 最高频的一类硬 bug

[openai/codex](https://github.com/openai/codex) 桌面宠物的 4 个公开 issue（标签均含 `bug` + `windows-os` + `pets`）：

- [#42190](https://github.com/openai/codex/issues/42190)（open，2026-09-02，15 条评论）「Desktop pet hit-testing and dragging break after moving or resizing the pet」：拖动或缩放后，**交互区与可见位置脱节**，鼠标会**穿透宠物去点到底下的窗口**；不止宠物本身，连它周围的 chat / voice / close 按钮也一起失效；某些状态下**只有左上角一小块**还能交互；重置宠物可临时恢复但宠物会跳到别处，再拖一次问题复现。
- [#34227](https://github.com/openai/codex/issues/34227)（open，2026-07-19，29 条评论）「Windows pet overlay hit region desynchronizes from the visible mascot over time」：**运行一段时间后**命中区漂移，只有上半身可点，下半身穿透；内置宠物与自定义 v2 宠物**都**中招；切换宠物资源无效，**重启 Windows 才临时恢复**。报告者甚至从打包后的应用里反查出了 `[data-avatar-overlay-hit-region]` / `[data-avatar-mascot='true']` 这些**DOM 命中区选择器**。
- [#21508](https://github.com/openai/codex/issues/21508)（closed，2026-05-07）：**副屏上无法拖拽**，主屏正常；报告者贴出的状态显示副屏用了**负坐标**（`x: -387`，主窗口 `x: -1904`），指向 Windows 多显示器坐标/命中测试问题。

> **对我们的直接要求**：命中区必须与渲染身份**同源**（用同一份 bounds/缩放推导），在多显示器（含负坐标）与 DPI 变化时必须重新推导并重新武装，且要有「位置/缩放变更后自检命中区」的机制。openpets 的 `window-tracker-latch` / `display.ts` / `reclampAllLivePetWindows` 正是针对这一类问题。

### 2. 性能与资源占用

- BongoCat Steam 讨论区有一条主题直接叫 **[「I think bongo cat has some serious optimisation issues.」](https://steamcommunity.com/app/3419430/discussions/0/597411322165097780)**，另一条叫 **[「Bongo cat makes my PC die」](https://steamcommunity.com/app/3419430/discussions/0/725769023703418594)**。
- 中文社区已有专门的 **[「BongoCat 流畅运行指南：让低配置设备也能享受萌猫陪伴」](https://blog.gitcode.com/5b46ad9fb3755953c8f1bf68d9096eb1.html)**，说明「默认配置在低配机上不够流畅」是普遍观感。
- 相关的通用参照：Electron 应用的 **[高 CPU 占用问题报告](https://github.com/standardnotes/forum/issues/3866)**（Windows 桌面版 Electron 常见病症）。

> **对我们的直接要求**：把 `maxFPS`（默认 60，可降至 30/15）、**静止/不可见时暂停 ticker**、**避免每帧窗口写入**列为 P0，并把 CPU 占用做进验收标准。

### 3. 「别烦人」的具体设计对策（来自各项目的**修复记录**，即用户抱怨的化石层）

DyberPet 的变更日志几乎就是一份「用户嫌烦」的修复清单（[README](https://github.com/ChaozhongLiu/DyberPet/blob/main/README.md)）：

- **「在设置中添加了关闭对话气泡的选项」**、**「微调了各类对话气泡的概率」** → 弹话太多、必须能关、且要有概率控制。
- **「优化了气泡的显示逻辑：避免同一种气泡同一时间出现多个」** → 同种气泡重复刷屏是真实抱怨。
- **「优化了通知栏和对话气泡的位置决定逻辑，避免了可能出现的通知重叠」** / **「弹窗通知新增了合并功能：饱食度、好感度、物品的增减通知会与正在显示的旧通知合并」** → **通知必须去重与合并**，否则会糊满屏幕。
- **「添加了频繁点击桌宠时 (1s 内 >= 7 次) 触发的气泡」** → 反过来把「被骚扰」做成了彩蛋，说明连点骚扰是用户真实行为。
- **「限制金币掉落动画的最大个数为 10」** → 动画/粒子要有并发上限。
- **「设置中可以静音了」** / 通知语音新增 `sound_priority` 优先级 → 声音必须可全局静音且要有优先级仲裁。
- **「优化了语音优先级逻辑」**、**「为物品使用和数值变化添加了通知」** → 通知种类膨胀后必须仲裁。
- **「在系统设置中添加了关闭弹出通知栏的功能」** → 最终一定要给一个总开关。

openpets 的对应设计：**每个显示器一条有界 FIFO 队列**承载插件 delivery，过期/主动关闭/显示器移除/插件重载/停用/卸载/应用退出都是**宿主生命周期事件**（[desktop.md](https://github.com/OpenPetsHQ/openpets/blob/main/docs/desktop.md)）—— 也就是「同一时刻屏幕上只允许一个有界队列，且生命周期归宿主」。**这正是「别烦人」的可实现形态，建议直接照搬这个模型。**

clawd 的对应设计：DND 只压制**要求你行动**的东西、音效 10 s 冷却 + DND 静音、气泡只在可见时占用全局热键、终端先答了气泡**自动消失**。

### 4. 其他相关抱怨线索（未逐条核实）

- Steam 上有关于「Whether there is an Always On Top option」的讨论（Pocket Waifu 桌宠），说明**置顶开关是用户的基本诉求**。
- 搜索还命中若干中文「桌宠长期使用体验，聊聊真实优缺点」类文章（知乎/百家号）以及「全屏游戏自动隐藏，托盘一键唤醒」类文章，指向**全屏时自动隐藏 + 托盘一键唤醒**是用户期待的标配能力。这些页面我**未逐篇打开核实**，仅作为方向提示。

---

## 未能确认的事项

1. **clawd-on-desk 的点击穿透实现方式未核实。** 它的 README 声称「transparent areas pass clicks to windows below; only Clawd's body is interactive」（[README](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/README.md)），但我**没有阅读其源码**确认它到底是逐像素命中、DOM 命中区还是别的机制 —— 这是**刻意**的：AGPL-3.0 边界下我只做设计阅读，不去复制实现。若确需知道机制，建议只看 issue 讨论层级的公开描述。
2. **Electron `setShape` 的可用性未在本机验证。** 搜索命中了相关 PR/backport（[electron#13789](https://github.com/electron/electron/pull/13789)）与 Linux `SetInputRegion` 的修复 PR（[electron#51144](https://github.com/electron/electron/pull/51144)），但我**没有核实它们在 Electron 44 上的当前状态与 Windows 行为**。且我已在 openpets 与 BongoCat 的源码中确认**两者都没用它**。**结论存疑，需要实测后再定。**
3. **Tauri 的 `forward` 选项**：搜索命中 [tauri-apps/tauri#6164](https://github.com/tauri-apps/tauri/issues/6164)（为 `setIgnoreCursorEvents` 增加 forward 选项），但未核实其最终状态；与我们的 Electron 栈无关，仅记录。
4. **「全屏时自动隐藏」vs「全屏时保持置顶」存在路线冲突，需要你拍板。** openpets 明确选择了**保持在全屏内容之上**（1 s 重断言 + 禁用 `CalculateNativeWinOcclusion`，见 [desktop.md](https://github.com/OpenPetsHQ/openpets/blob/main/docs/desktop.md)）；而中文社区线索与「别烦人」原则倾向**全屏时自动隐藏**。两者技术上互斥，**我没有找到同时满足的成熟实现**。建议默认「检测到全屏应用 → 自动穿透 + 暂停渲染」，并把「始终置顶」做成显式开关。
5. **BongoCat 的 CPU/内存具体数值未取得。** 只有 Steam 用户的主观抱怨帖与第三方「流畅运行指南」，**没有官方或权威的基准测试数据**。
6. **未逐一打开核实的页面**：Steam 讨论帖正文、知乎/百家号「长期使用体验」文章、`blog.gitcode.com` 的 BongoCat 优化指南。它们的**标题**来自搜索结果，内容我未展开阅读。
7. **`docs/pets.md` 中提到的 Codex V2 规范来源是第三方仓库**（`mySebbe/malou-codex-pet` 的 `pet.json` 与 `atlas.json`），我**未核实该仓库的许可证**。若我们要采纳 8×11 图集约定，需另行核验（**作为格式约定的参考可以，但其素材与实现不应引入**）。
8. **Adrianotiger/desktopPet 的在线文档/Manual 中的动画 XML 细节未读取**。仅从 Readme 得知「一张透明 PNG + `animations.xml`」的粗粒度约定。该项目无许可证，**不建议深入**。
9. **OpenPets 的 `pet-window.ts` / `mouse-forwarding.ts` 源码未逐行阅读**，上述关于点击穿透、看门狗、置顶重断言的结论全部来自其**官方文档**（`docs/pets.md`、`docs/desktop.md`、`docs/wayland.md`）。文档描述相当具体（含具体变量名与间隔数值），但在动工前建议**直接读这三个源文件确认**（MIT，可自由参考）。
10. **GitHub API 配额**：本轮共使用 9 次（1 次 `search/repositories` + 3 次 `git/trees` + 1 次 `repos` 详情 + 1 次 `contents` 根目录列举 + 3 次 `issues` 详情），未触发限流，因此**没有失败信息可报告**。所有许可证结论均为 API 实测值；文中其余事实来自 `raw.githubusercontent.com` 原始文件（不消耗 API 配额）。
