# 桌面宠物：技术底座选 Electron + TypeScript

**Status**: accepted（2026-09-11）

## 背景

要在 Windows 上做一个常驻的透明置顶桌宠，需要：无边框透明窗、点击穿透、托盘、可被 JS 插件扩展、体积与耗电尽量低。

## 决策

桌面壳用 **Electron**（v44.x，Chromium 152），构建用 electron-vite + TypeScript strict，渲染用 React + PixiJS。

## 理由

1. **本机零安装即可动工**：已有 Node 24.15 / npm 11.12 / git 2.54；Tauri 需要 Rust 工具链 + MSVC Build Tools（数 GB）且首日大概率卡在环境上。
2. **透明窗 + 点击穿透的生态最成熟**，而这正是本项目头号技术风险。
3. **"插件式、一切可自定义"用 JS/TS 最自然**。.NET/WPF 虽在 Win32 上更强，但插件层要退化成 C# 脚本引擎或内嵌 JS 引擎，生态和易用性都掉一档。
4. **原生依赖问题已解决且无需编译器**（见下）——这曾是推翻本决策的唯一触发器。

## 原生依赖：已确认为 koffi，零编译器

本机**没有任何 C++ 编译器**（无 cl/link/vswhere，无 Windows SDK），因此"写一个 200 行 C++ N-API 模块"实际等于"安装数 GB 的 Build Tools"——与否决 Tauri 的理由同构。

**解法：`koffi` v3.2.1**（MIT，2026-09-04）经 `@koromix/koffi-win32-x64` 提供 win32-x64 预编译二进制，**已在本机 Electron 44.3.0 主进程内实测通过**：

- `SHQueryUserNotificationState` → `hr=0`（全屏检测的唯一权威原语，Electron 不暴露）
- `GetLastInputInfo` → struct 布局验证正确

实测确认 `QUNS_BUSY` 在 Win11 build 26200 上真实返回：全屏窗口取得前景时 `state` 从 5 变为 **2**，整个全屏期间保持 2。**核心前提成立。**

该依赖**限定在 `src/main/platform/win32.ts` 单个文件内**，其余代码保持纯 TS 可单测。

## 已知陷阱（必须遵守，否则会静默失效）

| 陷阱 | 事实 |
|---|---|
| `disable-features` 会**覆盖**而非合并 | `appendSwitch` 实测是覆盖（两次调用只剩最后一个）。**必须**合并成一次逗号分隔调用：`appendSwitch('disable-features','CalculateNativeWinOcclusion,其他特性')` |
| 该调用**必须在 main.js 顶层** | 放在 `app.whenReady().then(...)` 或任何异步回调里**太晚**——Electron 只在主脚本执行完后重新初始化 FeatureList |
| `GetLastInputInfo` 必须是 `_Inout_` 不能是 `_Out_` | 否则静默返回 false、`cbSize` 读成 0。koffi issue #227 及官方文档均已确认 |
| **避开 koffi 3.1.3 / 3.1.4** | win32-x64 预编译二进制会 access violation，3.1.5 修复 |
| `better-sqlite3` 必须 **≥13.0.2** | 13.0.0/13.0.1 被 npm 注入 `install: node-gyp rebuild`，在无编译器机器上安装失败；#1503 已关闭修复 |
| `setShape` 的矩形是**并集**，**无法挖洞** | 只能定义外轮廓。宠物必须是单一连通轮廓 |
| `transparent:true` 在 Windows 上必须配 `frame:false`；`resizable:true` 可能破坏透明 | 且 `backgroundColor` 用 Electron 特有的 **#AARRGGBB**（alpha 在前） |
| DevTools 打开时窗口不透明 | 影响开发期与自动化视觉验证 |
| `setContentProtection` 需在窗口 Show 之后设置，且**隐藏/显示后要重新断言** | Chromium 在窗口不可见时设置 affinity 会导致空白窗。另有开放回归 #47834 |
| 不要用 `Display.scaleFactor` 算精灵尺寸 | 被文字缩放污染（1.5 文字 × 2.0 显示 = 3.0）。**改用 Pixi `resolution: 1` + 全部 DIP 坐标，把 DPI 缩放交给 Chromium 合成器** |
| `Display.id` 重启后可能不持久 | 不可作为"宠物住在几号屏"的持久化依据 |

## 接受已知代价

- 安装包 80–150MB（非"轻量"），但软件架构保持轻量：无本地模型、无向量库、无服务器。
- Electron **没有逐像素点击穿透**（#1335 开放 11 年）→ 用 `setIgnoreMouseEvents` + 主进程轮询 `getCursorScreenPoint()` 自行命中测试；**`setShape` 只作可选补充，因为"`setShape` + `transparent:true`"的组合尚未验证过**。
- 必须有"解除卡死穿透"的恢复路径（托盘命令 + 快捷键）：#49982 记录了渲染进程崩溃后穿透状态**卡死**的开放 bug。
- Chromium 遮挡节流会让透明置顶窗在全屏应用下**变空白** → 必须禁用 `CalculateNativeWinOcclusion`。

## 被否决的方案

- **Tauri**：体积优势明显，且 `ayangweb/BongoCat`（MIT，2.3 万星）证明该产品形态在 Tauri 上完全成立。否决仅因本机缺少 Rust 工具链、以及透明方案需额外试错。**若环境阻塞成为现实，这是第一个应重新评估的备选。**
- **.NET/WPF**：透明窗与 P/Invoke 是一等公民，体积远小于 Chromium，全屏检测无额外依赖。否决因插件层会显著退化。**koffi 验证通过后，触发本备选的唯一条件已消失。**

## 参考

- `docs/electron-desktop-pet-tech-verification.md` — Electron 能力与坑（含 ssource 级证据）
- `docs/win32-ffi-verification.md` — koffi 选型与 Win32 调用实测
- `docs/electron-screen-module-research.md` — screen 模块与多屏 DPI
- `docs/desktop-pet-design-references.md` — 开源参考项目与许可证边界
