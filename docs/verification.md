# M0 前置验证结果

**验证日期**：2026-09-11
**机器**：Windows 11 专业版 build 26200 · x64 · 单显示器 2560×1440 @1x · NVIDIA RTX 5060 Ti + Intel 核显
**运行时**：Electron 44.3.0（Chromium 152.0.7977.78 / Node 24.20.0 / Node-API 10）
**依赖**：koffi 3.2.1 · better-sqlite3 13.0.3
**复现**：`cd verify && pnpm verify`（捕获取证加 `XIAOQI_CHECK_CAPTURE=1`）
**原始输出**：`verify/verification-result.json` · `verify/quns-timeline.json`

**结论：27 项通过、0 项失败、5 项待确认（均为本机条件所限，非方案缺陷）。技术方案在本机成立。**

---

## 逐项结果

### V1 better-sqlite3 无需 rebuild ✅

N-API 预编译二进制**直接在 Electron 主进程里加载成功**，`electron-rebuild` 确实不再需要（此前只能依据维护者"理论上可行"的措辞，现已实测）。

- 建表、读写正常（`SELECT → 小奇`）
- **FTS5 全文检索可用**：`MATCH '加班'` 命中"用户昨天也在加班"
- 中文分词：FTS5 默认 `unicode61` 对中文按字切分，子串检索可用，满足千条级记忆的检索需求

### V2 koffi 调 Win32：三项感知信号全部可得 ✅

- `SHQueryUserNotificationState` → `hr=0 state=5`
- `GetLastInputInfo` → `ok=true cbSize=8`，空闲时长正常
- **负向对照有效**：故意传 `cbSize=4` 时返回 `false`，证明结构体真在 marshalling（不是恰好返回 true 的假阳性）
- 前台进程名 → `msedge`，场景分类 → 浏览

用 `OpenProcess` + `QueryFullProcessImageNameW` 取进程名，**不 spawn 子进程**——子进程会阻塞事件循环，而这次验证依赖窗口持续渲染。

### V3 透明 + 无边框 + 置顶窗正常 ✅

`frame:false` + `transparent:true` + `backgroundColor:'#00000000'` + `resizable:false` 组合正常显示；置顶生效；渲染产出经像素校验（左上角 RGB = 255,0,255 洋红）。

**自捕获无法证明透明**——Chromium 自捕获合成的是不透明位图，所以透明度的判定必须走桌面取样（V4）。

### V4 桌面上真的画出来了，遮挡开关就位 ✅

- 探针窗在桌面捕获中可见 → 窗口真的渲染在桌面上，未被遮挡节流
- 主进程 `disable-features=CalculateNativeWinOcclusion` 已到达 Chromium

### V5 一键隐身可靠 ✅（重要）

**这是之前唯一无法确认的开放问题（electron#47834），现在有了确定答案。**

用纯洋红探针窗做取证——不透明方块，因此"能否在桌面捕获里看到洋红"就是判据：

| 条件                          | 捕获结果                       |
| ----------------------------- | ------------------------------ |
| `setContentProtection(false)` | 洋红块**可见**（取证前提成立） |
| `setContentProtection(true)`  | 洋红块**消失**                 |

→ **捕获排除在本机（Electron 44.3.0 / Win11 build 26200）确实生效，一键隐身可靠。** #47834 那个回归不影响这个组合。

边界（必须写进 README，不要让用户误以为是安全保证）：这不是安全特性。微软官方明确说明它不保证保护窗口内容——**手机拍屏依然能拍到**。

### V6 setShape：可用，但发现两个实测陷阱 ⚠️

- ✅ **参数必须用小写 `{x, y, width, height}`**。Electron 的类型定义写的是 `Rectangle`（`X/Y/Width/Height`），**运行时大写会抛 `conversion failure from`**。实测对照：小写成功、大写失败、`null` 失败、`[]` 成功（复原为矩形）。
- ⚠️ `GetWindowRgnBox` 用 `getNativeWindowHandle()` 传 Buffer 时返回 `type=0`（ERROR），未能确认 OS 层区域真的建立。**可能是我调用姿势的问题**（koffi 指针解码 / x64 句柄），**不代表 setShape 无效**——`setShape` 调用本身未抛异常。
- ⚠️ **矩形是并集，无法挖洞**，只能定义外轮廓 → 宠物必须是单一连通轮廓。

**处置**：`setShape` 在 v0.1 只作为 `setIgnoreMouseEvents` 的可选补充，**不作为依赖**。是否采用留到 M1 用真实轮廓视觉确认。

### V7 QUNS 全屏检测成立 ✅（重要，且纠正了一个天真假设）

自动化制造全屏窗并轮询 QUNS：

| 场景                               | QUNS                      |
| ---------------------------------- | ------------------------- |
| 基线（无全屏应用）                 | `5` ACCEPTS_NOTIFICATIONS |
| **同一窗口 `setFullScreen(true)`** | **`2` BUSY**              |
| 退出全屏                           | 恢复 `5`                  |
| 有边框窗口**最大化**               | `5`（**正确地不算全屏**） |

**关键纠正**：最初我用「无边框窗口几何覆盖整个显示器」制造全屏，QUNS 保持 `5` —— 一度误判方案失败。独立诊断证明：

```
A1 无边框 + 几何覆盖整屏   →  5   ← 天真做法，Windows 不认
A2 同一窗口 setFullScreen  →  2   ← 真正的全屏
A3 真全屏 + alwaysOnTop    →  2   ← 游戏/置顶全屏同样触发
A4 有边框窗口最大化        →  5   ← 最大化不是全屏（正确行为）
```

→ **Windows 只把真正进入全屏的窗口算作全屏应用。** 这对产品有利：用户最大化窗口工作时，宠物不会被误判静默。

### 附带发现：`GetWindowRect` 比真实可视边界大 16px ✅

```
显示器物理分辨率              : 2560x1440
前台窗口 GetWindowRect       : 2576x1456   ← 大 16px
DWM 扩展外框（真实可视边界）  : 2560x1440
```

Win10/11 窗口有不可见的调整边框。**任何拿 `GetWindowRect` 做像素比对判断全屏的做法都会永远判否。** 正确做法是 `DWMWA_EXTENDED_FRAME_BOUNDS`，或直接信任 QUNS。

这也解释了为什么先前某个流行启发式（`workArea == bounds`）在使用中时灵时不灵。

### 场景识别表自检 ✅

10 类 / 163 个进程名，自检命中率 163/163。

编码(42) 会议(20) 游戏(20) 娱乐(18) 设计(16) 浏览(14) 文档(10) 笔记(10) 邮件(7) 文件(6)

**仅用进程名，永不读窗口标题**（见 `docs/adr/0002`）。

---

## 待确认的 5 项（本机条件所限，非方案缺陷）

| 项                                | 原因                                           | 处置                                                                  |
| --------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| 多屏与混合 DPI                    | 本机只有一块显示器                             | 实现后**如实标注未验证**，接第二块屏再测                              |
| 「全屏应用下不变空白」的视觉确认  | 需人眼判断宠物是否变黑                         | 用 `XIAOQI_KEEP_OPEN_MS=20000` 保留窗口后手工开全屏视频               |
| `setShape` 的 OS 层区域是否真建立 | `GetWindowRgnBox` 返回 ERROR，疑似调用姿势问题 | M1 用真实轮廓做视觉确认；不作为 v0.1 依赖                             |
| `Display.scaleFactor` 污染        | 本机 1x、无文字缩放，观察不到                  | 在有文字缩放的机器上复测；实现上已用 `resolution:1` + 全 DIP 坐标规避 |
| 捕获排除对各录制工具的覆盖度      | 只测了 Chromium 自己的 desktopCapturer         | 用 OBS / 截图工具手工复测（`XIAOQI_CHECK_CAPTURE=1` 已留好路径）      |

---

## 对规格的影响

已将下列实测结论回填 `AGENT-BUILD-PROMPT.md` §4.3：

1. **`setShape` 必须用小写字段**（类型定义有误导性）
2. **几何覆盖整屏 ≠ 全屏**——QUNS 只认真正的全屏窗口；不要试图用像素比对替代
3. **`GetWindowRect` 有 16px 不可见边框**——必须用 `DWMWA_EXTENDED_FRAME_BOUNDS`
4. **`setContentProtection` 在本机确认可靠**——不再是"待验证"，但边界要如实说明
5. **`better-sqlite3` / `koffi` 均已实测可用**——M0 不再需要"试探"，可直接进入实现

## 踩坑记录（给下一个人的省时提示）

- **`window-all-closed` 会提前杀掉验证流程**：诊断脚本销毁窗口时该事件入队，导致后续检查永远跑不到。验证程序**不要注册**这个处理器，生命周期由显式 `app.exit()` 控制。
- **pnpm 10+ 默认阻止依赖构建脚本**，会报 `ERR_PNPM_IGNORED_BUILDS`。本项目所有原生依赖都自带预编译，**脚本本就不该跑**——用 `pnpm.onlyBuiltDependencies: []` 显式禁掉即可，不要为此安装编译器。
- **pnpm 12 不遵守 `shamefully-hoist`**，`require('better-sqlite3/package.json')` 在严格 node_modules 下可能失败；本项目直接依赖了它所以能解析，若改成仅传递依赖需注意。

---

# M0 复跑复核（增量，不覆盖以上结论）

**复跑日期**：2026-09-11（同一天，环境未变）
**目的**：确认环境未变，作为开工前的基线。
**命令**：`cd verify; pnpm install; pnpm verify`

## 结果：与上文结论一致，**0 失败**

不加取证开关的第一次复跑：`INFO=18 WARN=6 PASS=26`。
加上 `XIAOQI_CHECK_CAPTURE=1`（捕获取证）后：**`INFO=19 WARN=5 PASS=28`，无失败项**。

两次的 WARN 数差 1，原因就是"捕获取证未启用"那一条本身——
启用后它变成一条 PASS（"开启保护后洋红块从捕获中消失"），于是
**待确认项正好收敛为上文记录的 5 项**。因此复跑结论与本文记录的
「27 通过 / 0 失败 / 5 待确认」逐项吻合（PASS 计数的 1 项差异来自
本次额外启用了一项取证，不是环境变化）。

关键项复跑值：

| 项                             | 本次实测                                             |
| ------------------------------ | ---------------------------------------------------- |
| `better-sqlite3`               | 13.0.3 加载、读写、FTS5 中文子串检索均通过           |
| `koffi`                        | 3.2.1                                                |
| `SHQueryUserNotificationState` | `hr=0 state=5`                                       |
| `GetLastInputInfo`             | `ok=true cbSize=8`；负向对照（`cbSize=4`）返回 false |
| 前台进程名                     | `msedge` → 场景"浏览"                                |
| 场景识别表                     | 10 类 / 163 进程名，自检 163/163                     |
| `GetWindowRect` 比真实边界大   | 16px（陷阱仍在）                                     |
| QUNS 全屏跳变                  | 全屏期间 `state ∈ {2}`，退出后回到 `5`               |
| 捕获取证（V5）                 | 未保护时洋红块可见；**开启保护后从捕获中消失**       |

## M0 阶段新增的环境事实（施工中发现，补充记录）

以下是**复跑之外**、搭建工程骨架时实测到的新事实，供后续参考：

1. **pnpm 12.3.4 已不再读取 `package.json` 里的 `pnpm` 字段**。
   安装时它会自动生成一个 `pnpm-workspace.yaml`，其中的 `allowBuilds`
   才是"允许哪些依赖跑构建脚本"的唯一配置位置。施工令 §3 提到的
   `pnpm.onlyBuiltDependencies: []` 写法在本机**已被忽略**（会有 WARN 明说）。
2. **`koffi` 的 install 脚本确实可以安全忽略**。它的 install 走
   `cnoke --prebuild`，而平台二进制由 `optionalDependencies`
   （`@koromix/koffi-win32-x64`）提供。实测配成 `koffi: false` 之后，
   `require('koffi')` 与 Win32 调用都正常——`verify/` 一直就是这么配的。
   因此**需要放行构建脚本的只有 `esbuild`**（它的 postinstall 只是把预编译二进制放到位）。
3. **类型工具链存在硬性版本边界（很容易踩）**：
   - `typescript-eslint@8.70` 的 peer 是 `typescript >=4.8.4 <6.1.0`，
     所以 **TypeScript 7.0.2 不可用**（npm 上的 latest 已经是 7）；本项目用 **6.0.3**。
   - `electron-vite@5` 的 peer 是 `vite ^5||^6||^7`，因此不能用 vite 8；
     而 `@vitejs/plugin-react@6` 又要求 vite 8。两者的交集是
     **vite 7.3.6 + @vitejs/plugin-react 5.2.0**。
   - `electron-vite@5` 声明 `@swc/core` 为 peer，但它是可选的，不需要安装。
4. **TypeScript 6 已废弃 `baseUrl`**，保留会直接报 `TS5101`；
   只用 `paths`（相对 tsconfig 解析）即可，不必加 `ignoreDeprecations` 掩盖。
