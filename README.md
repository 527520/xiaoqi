# 小奇 · 桌面宠物

> 一个住在你桌面上的 AI 生命体。它不催你干活，它陪你干活。

**当前状态：M1 垂直切片完成。** 桌面上已经站着一只可点、可穿透、可隐身的几何宠物；
记忆、人设、技能等业务逻辑尚未开始（M2 起）。

```powershell
pnpm install
pnpm dev          # 跑起来看它
```

首次启动后它会待在**工作区右下角**。快捷键：`Ctrl+Shift+H` 隐身、`Ctrl+Shift+J` 显示；
托盘图标上是其余操作（含「恢复点击」，用于宠物点不到时）。

已实测通过的能力与**明确未验证**的事项，都逐条附命令输出记在
[`docs/verify-m1.md`](docs/verify-m1.md)；技术取舍记在 [`docs/DECISIONS.md`](docs/DECISIONS.md)。

---

## 它是什么

一只常驻桌面的宠物。它感知你的工作状态，用不同形态陪伴你，有记忆、有情绪。

**它不是工具，是室友。**

## 三条设计底线

1. **不打扰**——「烦」是这类产品差评的第一来源。主动度默认最低。
2. **不越权**——见下节。它的感知少到近乎简陋，这是刻意的。
3. **不道德绑架**——永不使用内疚感驱动互动。它难过时的表现是傲娇，不是指责。

## 它到底能看见什么

**只有三件事：当前前台进程名、系统空闲时长、系统级状态（全屏/锁屏/电池/时间）。**

没有别的。永远不会有的：

| 不做 | 原因 |
|---|---|
| 读屏幕 / OCR | 内容级隐私，投入产出比最低 |
| 录屏 / 截屏 | 同上 |
| 捕获音频 | 不做任何"理解会议内容"的功能 |
| 全局键盘钩子 | 不读按键 |
| **读窗口标题** | 实测证明浏览器标题等于网页内容摘要（见 [ADR-0002](docs/adr/0002-perception-granularity-by-process.md)） |
| 读取其他应用内容 | 邮件正文、代码内容、日历一律不读 |
| 操作其他应用 | 不代点按钮、不代填表单 |

感知授权**按进程分级，不按数据类型分级**——因为同一项「前台应用」信号，对 IDE 和对银行网页的风险差两个数量级。

**它的记忆全部存在本地。只有生成某一句话时才会联网，且只发送必要上下文。**

### 它看不见什么（一句话版）

> **它只会认得你在用什么软件，不知道你在看什么。**

### 关于"一键隐身"的边界（必须说清楚）

一键隐身会让宠物**从屏幕捕获中消失**（内部走
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`），本机已实测：
开启后宠物在整屏桌面捕获里**一个像素都不剩**（见
[`docs/verify-m1.md`](docs/verify-m1.md) 证据 3）。

**但这不是安全特性，我们不把它宣传成"防截屏"。**
微软官方明确说明它不保证保护窗口内容——**手机拍屏依然拍得到**。
它的用途是"屏幕共享时不让同事看见"，不是"防止被记录"。

## 性格

首发两种，都写透：

- **温柔**——默默递热水那一类
- **傲娇**——「哼，又加班，我才不管你」，然后默默把屏幕调暗

另外四种（搞笑 / 哲学家 / 社恐 / 社牛）在路线图上，不在选择器里。

默认名字叫**小奇**，可一键改。

## 它可以被养成

- **形象可换**：往资源目录丢一个文件夹（精灵图 + 状态映射）即可，不需要改代码
- **性格可调**：话痨度、毒舌度、主动度、称呼、禁忌词
- **技能可插拔**：内置技能与第三方插件使用**同一套接口**，应用自己是第一个插件作者
- **一切可自定义，但首次暴露极浅**：默认值必须好用，高级项折叠在二级页面

## 仓库结构

```
CONTEXT.md                  术语基准（这份文件定义了所有领域词汇）
AGENT-BUILD-PROMPT.md       施工规格（交给 coding agent 自动执行的开发流程）
src/
  main/                     主进程
    platform/               ★ 所有 OS 调用的唯一入口（win32.ts 是唯一加载 koffi 的文件）
    core/                   ★ 宠物内核：纯 TS、零 Electron 依赖、可纯 Node 单测
    window/                 透明窗构造与运行时控制器
  preload/                  contextBridge 白名单桥（产出 .cjs，沙箱 preload 不支持 ESM）
  renderer/                 React + PixiJS（严格 CSP、全 DIP 坐标、resolution: 1）
  shared/                   三段进程共用的数据与纯函数（宠物几何的唯一真相源）
scripts/
  generate-icons.mjs        程序化生成图标，并与宠物几何做防漂移自检
  verify-clickthrough.mjs   点击穿透的端到端行为验证（真的移动光标）
  attach-cdp.mjs            用 CDP 诊断真实应用（不打开 DevTools，故不破坏透明窗）
  inspect-canvas.mjs        截图取证：颜色统计、包围盒、ASCII 概览
docs/
  adr/                      架构决策记录
  ARCHITECTURE.md           模块图、IPC 清单、记忆表结构、配置与插件 schema
  DECISIONS.md              自主技术决策记录（含被否决方案与理由）
  RECON.md                  开源桌宠调研与许可证边界
  verify-m1.md              M1 验收证据（每条结论附实际命令输出）
  BLOCKERS.md               阻塞项与待人工确认事项
  verification.md           M0 前置验证结果 + 复跑复核
  feasibility.md            可行性与能力天花板分析
  weight-audit.md           轻量化取舍
  electron-desktop-pet-tech-verification.md   Electron 能力与已知陷阱（含源码级证据）
  win32-ffi-verification.md Win32 调用方案与实测结果
  electron-screen-module-research.md          screen 模块与多屏 DPI
  desktop-pet-design-references.md            开源参考项目与许可证边界
probe/
  perception-probe.ps1      感知层探针：实测你的机器上能读到什么（零依赖）
verify/
  main.mjs                  M0 前置验证程序（27 通过 / 0 失败 / 5 待确认）
```

## 质量门

每个里程碑都必须全绿：

```powershell
pnpm typecheck    # TS strict，0 error
pnpm lint         # 0 error 0 warning
pnpm test         # 0 skip（配置层禁用了 test.skip / it.only）
pnpm build        # 成功
```

另外两项**不是**常规质量门，而是按需跑的证据生成器：

```powershell
pnpm verify:clickthrough   # 端到端验证点击穿透（会真的移动光标，结束自动还原）
pnpm icons                 # 重新生成图标（改了宠物几何后必须跑，否则自检会失败）
```

## 想试试感知探针

零依赖，不读屏幕内容、不安装任何东西：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\probe\perception-probe.ps1 -Seconds 30
```

运行期间正常干活，结束时它会告诉你：**你的机器上，前台应用名和窗口标题究竟能被读到多少。**

## 技术底座

Electron + TypeScript + React + PixiJS，SQLite 本地记忆，OpenAI 兼容接口（用户自带 key），纯插件式技能系统。

**无本地模型、无向量库、无服务器。** 详见 [ADR-0001](docs/adr/0001-electron-typescript-stack.md)。

## 贡献

项目处于早期实现阶段。现在最有价值的反馈是**质疑设计决策**——尤其是 `docs/adr/` 里的每一条，
以及 `docs/DECISIONS.md` 里那些"我替你定了"的取舍。如果你认为某条红线画错了位置，开 issue 说明理由。
