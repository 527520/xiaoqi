# 架构

**版本**：M1 完成时（2026-09-11）
**状态**：M1 垂直切片已实现并验证；M2–M6 的接口在此预先立好，避免后补时到处开洞。

本文覆盖施工令 §5 M0 第 5 项要求的四份内容：**模块图、IPC 通道清单、记忆表结构、
配置 schema、插件清单 schema**。

---

## 1. 分层与模块图

```
┌─────────────────────────────────────────────────────────────────────┐
│ 渲染进程 (sandbox: true · contextIsolation: true · 无 Node)          │
│                                                                     │
│   src/renderer/                                                     │
│     index.html          严格 CSP：default-src 'none'                │
│     src/main.tsx        入口；**首行安装错误上报**                   │
│     src/App.tsx         根组件（只做两件事：挂 canvas + 接状态）      │
│     src/installErrorReporting.ts  未捕获错误 → 主进程日志（同步）     │
│     src/hooks/useRuntimeState.ts  订阅主进程状态（纯投影）            │
│     src/pet/PetStage.ts      PixiJS 程序化几何宠物                   │
│     src/pet/animation.ts     动画曲线（纯函数，可单测）               │
│     src/pet/usePetStage.ts   把 Pixi 接到 React；帧率与形态联动       │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ contextBridge 白名单（src/preload/index.ts）
                           │ 产出 .cjs —— 沙箱 preload 不支持 ESM
┌──────────────────────────┴──────────────────────────────────────────┐
│ 主进程 (Node 全权限)                                                 │
│                                                                     │
│   src/main/index.ts          唯一入口；★ disable-features 顶层单次调用 │
│   src/main/window/                                                  │
│     createPetWindow.ts       透明窗参数（含 5 条硬约束）              │
│     petWindow.ts             PetWindowController：轮询 + 执行         │
│   src/main/platform/         ★ 所有 OS 调用的唯一入口                 │
│     index.ts                 Platform 接口 + 启动冒烟自检             │
│     win32.ts                 ★ koffi 只允许出现在这个文件            │
│   src/main/core/             ★ 纯 TS，零 Electron、零 koffi，可单测   │
│     cursorRouter.ts          穿透路由判定（纯函数）                   │
│     modeGate.ts              QUNS → 形态闸门（纯函数）                │
│     frameRate.ts             帧率预算（纯函数）                       │
│     (M2+) state-machine/ memory/ persona/ ai/ plugins/              │
│   src/main/evidence.ts       开发期取证（仅在设了环境变量时启用）      │
└─────────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────────┐
│ src/shared/  三段进程共用（**只放数据与纯函数，零副作用**）           │
│   types.ts        Rect/Point/PetGeometry/QUNS/VisibilityMode/…       │
│   constants.ts    宠物几何（唯一真相源）+ 各轮询间隔 + 帧率档位        │
│   geometry.ts     命中测试、QUNS → 静默判定（纯函数）                 │
│   palette.ts      配色；与图标生成脚本同源                            │
│   ipc.ts          IPC 通道白名单 + bridge 接口类型                    │
└─────────────────────────────────────────────────────────────────────┘
```

### 铁律（由自动化测试与 lint 守护，不靠自觉）

| 铁律 | 守护方式 |
|---|---|
| `core/` 不得 `import electron`，不得 `require('koffi')` | `src/main/core/boundary.test.ts` 文本断言 |
| `koffi` 只允许在 `platform/win32.ts` 出现 | 同上的第 4 个用例 + eslint `no-restricted-imports` |
| `disable-features` 必须**恰好一次**且在 `app.whenReady()` 之前 | eslint 自定义规则 `xiaoqi/disable-features-invariants` |
| 宠物几何只有一个真相源 | 图标脚本启动自检；命中测试与渲染共用 `PET_GEOMETRY` |

### 数据流（M1 现状）

```
Win32 (koffi)                       Electron
  SHQueryUserNotificationState ──┐
                                  ├─→ PetWindowController ─→ core/ 纯函数判定
  screen.getCursorScreenPoint ────┘        │                      │
                                            │  setIgnoreMouseEvents / hide / show
                                            │  setContentProtection / setAlwaysOnTop
                                            ▼
                                    IPC stateChanged ─→ 渲染进程投影 ─→ Pixi 形态 + 帧率
```

**渲染进程不持有真相**：形态、穿透状态、帧率全部由主进程算出后推送。
这样"现在到底是什么状态"永远只有一个答案。

---

## 2. IPC 通道清单（白名单）

定义在 `src/shared/ipc.ts`。preload **只暴露这些通道**，不暴露 `ipcRenderer` 本身
（一旦整个交出去，白名单就形同虚设）。

| 通道 | 方向 | 类型 | 载荷 | 说明 |
|---|---|---|---|---|
| `state:get` | 渲染 → 主 | invoke | — → `PetRuntimeState` | 启动时拉一次完整快照 |
| `mode:set` | 渲染 → 主 | invoke | `VisibilityMode` → `PetRuntimeState` | 手动设置形态 |
| `pet:interact` | 渲染 → 主 | send | — | 用户点了宠物 |
| `pet:animating` | 渲染 → 主 | send | `boolean` | 交互动画开始/结束，用于帧率降档 |
| `renderer:error` | 渲染 → 主 | **sendSync** | `message, stack` | 未捕获错误 + 堆栈 → 主进程日志 |
| `state:changed` | 主 → 渲染 | on | `PetRuntimeState` | 状态变化推送 |

**为什么 `renderer:error` 用 `sendSync`**：宠物启动期的错误可能发生在
"渲染进程已开始执行、主进程日志却还没建立"的时间窗里，异步消息会晚到甚至丢在
窗口关闭之后。实测第一次排查时最关键的一条启动期堆栈就是这样丢掉的。

`PetRuntimeState` = `{ mode, cursorRoute, workArea, frameRate }`。
`frameRate` 由**主进程**算，因为只有主进程同时知道"形态"与"是否正在播放交互动画"。

---

## 3. 记忆表结构（M3 实现，此处先定契约）

SQLite + **FTS5**。施工令 §5 M3 明确「**不引入任何向量库**」——
记忆规模是千条级，FTS + 时间/情绪/标签过滤完全够用，且比向量检索更可解释。

### 四层记忆

| 表 | 语义 | 对应 `CONTEXT.md` |
|---|---|---|
| `episodic` | 带时间戳的事件记录，按遗忘曲线衰减 | **情景记忆** |
| `semantic` | 关于用户的稳定事实，由反复出现的情景记忆升级而来 | **语义记忆** |
| `emotional` | 带情绪标签的事件，**衰减最慢** | **情感记忆** |
| `working` | 当前会话的短期上下文 | 工作记忆 |

```sql
-- 情景记忆
CREATE TABLE episodic (
  id           INTEGER PRIMARY KEY,
  occurred_at  INTEGER NOT NULL,          -- Unix ms
  kind         TEXT    NOT NULL,          -- 事件类型（interaction / mode_change / …）
  content      TEXT    NOT NULL,          -- 自然语言描述（供检索与拼 prompt）
  tags         TEXT    NOT NULL DEFAULT '',-- 逗号分隔；与工作模式标签对齐
  weight       REAL    NOT NULL DEFAULT 1.0,-- 遗忘曲线作用对象
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_episodic_occurred ON episodic(occurred_at);
CREATE INDEX idx_episodic_weight   ON episodic(weight);

-- 语义记忆（由情景记忆升级而来；记来源以便解释"为什么它记得"）
CREATE TABLE semantic (
  id           INTEGER PRIMARY KEY,
  subject      TEXT    NOT NULL,          -- 关于谁/什么（多为 user）
  fact         TEXT    NOT NULL,
  confidence   REAL    NOT NULL DEFAULT 0.5,
  derived_from INTEGER,                   -- → episodic.id（可空：用户手动添加）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 情感记忆
-- ★ 施工令 §1.2⑪：「删掉的记忆必须真的消失」。因此这里**不设软删除标记**，
--   DELETE 就是真 DELETE；FTS 侧用触发器同步（见下），不留痕。
-- ★ ADR-0003：「被冷落」只存在于这一层，且**不可累积成怨气**。
--   因此不设"累积强度"字段，只记录离散事件；上限与每日重置在 core/ 里做。
CREATE TABLE emotional (
  id           INTEGER PRIMARY KEY,
  occurred_at  INTEGER NOT NULL,
  emotion      TEXT    NOT NULL,          -- 8 种情绪之一（§4.6）
  intensity    REAL    NOT NULL,          -- 单次事件的强度，不做跨事件累加
  content      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);

-- 工作记忆（当前会话；退出即清）
CREATE TABLE working (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- FTS5 全文索引（unicode61：对中文按字切分，子串检索可用，已在 verify V1 实测）
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  tags,
  source_table UNINDEXED,
  source_id    UNINDEXED,
  tokenize = 'unicode61'
);
```

**删除必须真的删除**（§1.2⑪）：`episodic` / `emotional` / `semantic` 上的
`AFTER DELETE` 触发器同步删 `memory_fts` 对应行；配合 `PRAGMA secure_delete = ON`
让被删内容不在数据库空闲页里残留。**日志与缓存中同样不得留痕**——
删除路径不写日志内容，只写"删除了一条记忆"这一事实。

---

## 4. 配置 schema（M6 界面据此生成）

存储：`userData/config.json`（**不含任何密钥**）。密钥单独走 `safeStorage`。

```jsonc
{
  "version": 1,

  // ── 它是什么样 ──（对应"养它"语气的第一层）
  "persona": {
    "name": "小奇",
    "personality": "gentle",        // "gentle" | "tsundere"（首发只有两种；§5 M5）
    "chattiness": 0.3,              // 0..1 话痨度
    "sarcasm": 0.1,                 // 0..1 毒舌度
    "proactiveness": 0.15,          // ★ 主动度：默认必须低（§9.1「宁可少说话」）
    "addressAs": "你",              // 称呼
    "forbiddenWords": []            // 禁忌词
  },

  // ── 它做什么 ──
  "behavior": {
    "skills": {},                   // 技能 id → { enabled, params }
    "dnd": {                        // 勿扰时段（默认含深夜）
      "enabled": true,
      "ranges": [{ "from": "23:00", "to": "08:00" }]
    },
    "autoStart": false,             // ★ 开机自启默认关，且引导里不提（§5 M6）
    "appearance": {
      "scale": 1.0,
      "alwaysOnTop": true,
      "hideOnFullscreen": true      // QUNS {1,2,3,4} → 静默
    }
  },

  // ── 它知道什么 ──（感知授权；措辞用行为语言，不用"权限等级"）
  "perception": {
    "foregroundProcess": true,      // "它只会认得你在用什么软件，不知道你在看什么"
    "idleTime": true,
    "systemState": true,            // 全屏/锁屏/电池/时间
    "windowTitle": false,           // ★ v0.1 恒为 false，不暴露开关（ADR-0002）
    "processAllowlist": []          // 按**进程**分级，不按数据类型分级
  },

  "api": {
    "baseUrl": "",
    "model": "",
    "dailyTokenBudget": 200000,     // 默认开启预算
    "budgetEnabled": true
  },

  "debug": { "showStatusPanel": false }
}
```

**约束**：`windowTitle` 在 v0.1 不可开启（ADR-0002 / §1.1④）；
`proactiveness` 默认低；`autoStart` 默认关；感知全部默认最低。

---

## 5. 插件清单 schema（M4 实现）

**声明式**是刻意的（施工令 §5 M4c）：它让宿主能在**用户授权范围内**决定
是否满足插件的感知需求，而不是让插件自己去要权限。

```jsonc
{
  "manifestVersion": 1,
  "id": "example-plugin",             // ^[a-z0-9][a-z0-9_-]{0,63}$
  "name": "示例插件",
  "version": "0.1.0",
  "description": "证明插件接口对外可用",
  "author": "",

  // ★ 声明式感知需求：宿主按用户已授权的范围决定"满足哪些"，
  //   插件**不能**自己读感知信号。缺失的需求不会让插件崩溃，只是不触发。
  "perception": ["foregroundProcess", "idleTime"],   // 只能是 §1.1 的三项

  // 触发条件：全部为声明式，宿主求值
  "triggers": [
    { "type": "mode", "value": "coding" },
    { "type": "idle", "minSeconds": 300 },
    { "type": "schedule", "cron": "0 10 * * *" }
  ],

  "config": [                          // 配置项 schema → M6 自动生成界面
    { "key": "interval", "type": "number", "label": "间隔（分钟）", "default": 45,
      "min": 5, "max": 240 }
  ],

  "memory": { "read": ["semantic"], "write": ["episodic"] },  // 记忆写入声明

  "entry": "index.js"                  // 相对插件目录
}
```

**宿主职责**（M4）：加载、生命周期、**错误隔离（单插件抛错不得拖垮主进程）**、
按用户授权裁剪感知需求、把插件写入的记忆纳入记忆账本。

**v0.1 不做**（§5 M4c）：沙箱隔离、签名校验、审核流程、在线市场。
**定接口 ≠ 建市场。**

---

## 6. 资源包约定（`assets/pets/<名字>/`）

```
assets/pets/xiaoqi/
  pet.json      # 状态→动画映射、帧尺寸、锚点、各形态参数
  idle.png      # 精灵图（帧序列）
  ...
```

v0.1 的默认宠物（小奇）**不用图片**，而是由 `src/renderer/src/pet/PetStage.ts`
按 `src/shared/constants.ts` 的几何**程序化绘制**——
所以当前的 `assets/pets/xiaoqi/` 尚未落地为资源包。
引入资源包（M6 之后的"形象可自定义"）时，`pet.json` 需显式声明
**帧尺寸**、**图集网格**与**版本号**，并在导入前校验像素尺寸与 alpha 通道，
不合格**原子拒绝**（临时目录 → rename），绝不半途写入。

调研补充（`docs/RECON.md`）：openpets 用的是 `pet.json` + 精灵表，
与我们的约定同构；其记录的头号 bug 来源是"新资源协议忘了同时改两处 CSP"。
本项目当前不用自定义协议，因此**不需要**放开 `index.html` 里的 CSP
（`default-src 'none'`）；将来若引入，必须两处同步并加启动自检。
