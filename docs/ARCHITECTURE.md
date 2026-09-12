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

| 铁律                                                           | 守护方式                                               |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `core/` 不得 `import electron`，不得 `require('koffi')`        | `src/main/core/boundary.test.ts` 文本断言              |
| `koffi` 只允许在 `platform/win32.ts` 出现                      | 同上的第 4 个用例 + eslint `no-restricted-imports`     |
| `disable-features` 必须**恰好一次**且在 `app.whenReady()` 之前 | eslint 自定义规则 `xiaoqi/disable-features-invariants` |
| 宠物几何只有一个真相源                                         | 图标脚本启动自检；命中测试与渲染共用 `PET_GEOMETRY`    |

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

| 通道                      | 方向      | 类型         | 载荷                                 | 说明                                     |
| ------------------------- | --------- | ------------ | ------------------------------------ | ---------------------------------------- |
| `state:get`               | 渲染 → 主 | invoke       | — → `PetRuntimeState`                | 启动时拉一次完整快照                     |
| `mode:set`                | 渲染 → 主 | invoke       | `VisibilityMode` → `PetRuntimeState` | 手动设置形态                             |
| `scale:set`               | 渲染 → 主 | invoke       | `number` → `PetRuntimeState`         | 设置缩放（渲染进程侧入口，也便于自动化） |
| `drag:start` / `drag:end` | 渲染 → 主 | send         | `{x,y}`（偏移）                      | 拖动：主进程按偏移跟随光标               |
| `pet:interact`            | 渲染 → 主 | send         | —                                    | 用户点了宠物                             |
| `pet:animating`           | 渲染 → 主 | send         | `boolean`                            | 交互动画开始/结束，用于帧率降档          |
| `sprite:mask`             | 渲染 → 主 | send         | `SpriteMask`（约 600 字节）          | **alpha 命中蒙版**，图集后端用           |
| `sprite:animation`        | 渲染 → 主 | send         | `CodexAnimationName`                 | 当前动作（蒙版按动作存，据此选表）       |
| `renderer:error`          | 渲染 → 主 | **sendSync** | `message, stack`                     | 未捕获错误 + 堆栈 → 主进程日志           |
| `state:changed`           | 主 → 渲染 | on           | `PetRuntimeState`                    | 状态变化推送                             |
| `memory:*`（5 条）        | 双向      | invoke/on    | 见 §3                                | 记忆账本（M3）                           |

**为什么 `renderer:error` 用 `sendSync`**：宠物启动期的错误可能发生在
"渲染进程已开始执行、主进程日志却还没建立"的时间窗里，异步消息会晚到甚至丢在
窗口关闭之后。实测第一次排查时最关键的一条启动期堆栈就是这样丢掉的。

**为什么蒙版要分两条通道而不是塞进 `state:changed`**：
`state:changed` 每 80ms 就可能推一次（光标移动），而蒙版是**一次性**的
（约 600 字节，解码后算一次）。塞进去会让它每帧重复过一遍结构化克隆。
动作名则相反，它是随状态变的，所以单独一条轻量通道。

`PetRuntimeState` = `{ mode, cursorRoute, workArea, frameRate, scale, cursor,
workMode, emotion, disturbLevel, mood, pet }`。
`frameRate` 由**主进程**算，因为只有主进程同时知道"形态"与"是否正在播放交互动画"。
`pet` = `{ backend, sheetUrl, spriteVersion, displayName }` —— 只推**渲染进程
无法自己知道**的东西；栅格契约（逐帧时长表）在 `@shared/petAtlas` 里是常量，
两边 import 同一份，不靠 IPC 传（传过去只会造出"两份可能不一致"的机会）。
`pet` 与 `scale` 必须在**同一次**快照里到达：渲染进程要按"后端 + 缩放"
一起决定 canvas 尺寸，分两次会出现一帧用正方形容器画非正方形图集的错位。

---

## 3. 记忆表结构（M3 已实现；本节于 M3 施工后按**实际表结构**更正）

> **更正说明（2026-09-12）**：本节初版（M0 时）写的是一张表一层记忆 +
> 一张 FTS5 虚表 + 三个同步触发器，检索用 `MATCH`。M3 施工后实测**两处都要改**：
> ①FTS5 做不到中文子串检索（见 `docs/verify-m3-fts5.md`）；
> ②四张表在只有一层需要 FTS 的情况下，把"跨层按时间取最近记忆"变成了
> 四次查询 + 归并，而四层的**字段**其实几乎相同。
> 现在以 `src/main/core/memory/store.ts` 的 `SCHEMA_SQL` 为准（**表结构即文档**）。

SQLite，**不引入任何向量库**（施工令 §5 M3 明确）。记忆规模是千条级，
时间/层级/情绪过滤 + 子串检索完全够用，且比向量检索更可解释。

### 四层记忆

四层是**同一个 `kind` 维度的四个取值**，共用一张 `memories` 表——
这样"按时间取最近 N 条"（拼 prompt 的主查询）是**一次查询**，不用跨表归并。

| `kind`      | 语义                                             | 对应 `CONTEXT.md` |
| ----------- | ------------------------------------------------ | ----------------- |
| `episodic`  | 带时间戳的事件记录，按遗忘曲线衰减               | **情景记忆**      |
| `semantic`  | 关于用户的稳定事实，由反复出现的情景记忆升级而来 | **语义记忆**      |
| `emotional` | 带情绪标签的事件，**衰减最慢**                   | **情感记忆**      |
| `working`   | 当前会话的短期上下文（**单独一张表**，见下）     | 工作记忆          |

```sql
CREATE TABLE memories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,          -- episodic / semantic / emotional
  occurred_at  INTEGER NOT NULL,          -- Unix ms
  content      TEXT    NOT NULL,          -- 自然语言描述（检索与拼 prompt 的对象）
  tags         TEXT    NOT NULL DEFAULT '',-- 逗号分隔；与工作模式标签对齐
  weight       REAL    NOT NULL DEFAULT 1.0,-- 遗忘曲线作用对象
  emotion      TEXT,                      -- 8 种情绪之一（§4.6）；仅 emotional 层有
  intensity    REAL,                      -- 单次事件强度，**不做跨事件累加**
  derived_from INTEGER,                   -- → memories.id（语义记忆记来源，可解释"为什么它记得"）
  created_at   INTEGER NOT NULL
);

-- 时间与层级是最常用的筛选维度（"最近的""还没忘的"）
CREATE INDEX idx_memories_occurred ON memories(occurred_at);
CREATE INDEX idx_memories_kind     ON memories(kind);
-- 情感记忆按情绪聚合时用
CREATE INDEX idx_memories_emotion  ON memories(emotion);

-- 工作记忆：独立表。它是 key→value 的**短生命周期**映射，
-- 没有时间/权重/情绪这些字段，硬并进 memories 会让一半列恒为 NULL。
CREATE TABLE working (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**★ 刻意不建索引的地方**：`content` 列上**不建任何索引**。
检索模式是 `LIKE '%词%'`，而**前导通配符在结构上使 B-tree 索引不可用**——
`EXPLAIN QUERY PLAN` 实测任何子串查询都是 `SCAN`。建了不会被用到，
只会拖慢写入并占空间。

**★ 四层记忆的字段差异用可空列表达**，不用四张表：`emotion`/`intensity`
只有 `emotional` 层有，`derived_from` 只有 `semantic` 层有。
代价是列可空，收益是"拼 prompt 取最近记忆"只需一次查询。

**删除必须真的删除**（§1.2⑪，硬约束）：`deleteMemory()` 是**物理 `DELETE`**，
不是软删除标记——软删除会让数据仍留在文件里，只是被查询过滤掉，
与这条约束**直接冲突**。配合：

- `PRAGMA secure_delete = ON`（打开库即设），让被删内容不在空闲页里残留；
- `VACUUM` 整理文件；
- **删除路径不写日志内容**，只写"删除了一条记忆"这一事实。

**这条约束是"删除必须可验证"的**，因此配了 `scripts/verify-memory-delete.mjs`：
把真实 `.db` 文件当**二进制**扫原文的 UTF-8 字节，并带**对照组**
（未删除的那条必须仍能扫到，否则"扫不到"可能只是扫描方法无效）。
见 `pnpm verify:memory-delete`。

---

## 4. 配置 schema（M6 界面据此生成）

存储：`userData/config.json`（**不含任何密钥**）。密钥单独走 `safeStorage`。

```jsonc
{
  "version": 1,

  // ── 它是什么样 ──（对应"养它"语气的第一层）
  "persona": {
    "name": "小奇",
    "personality": "gentle", // "gentle" | "tsundere"（首发只有两种；§5 M5）
    "chattiness": 0.3, // 0..1 话痨度
    "sarcasm": 0.1, // 0..1 毒舌度
    "proactiveness": 0.15, // ★ 主动度：默认必须低（§9.1「宁可少说话」）
    "addressAs": "你", // 称呼
    "forbiddenWords": [], // 禁忌词
  },

  // ── 它做什么 ──
  "behavior": {
    "skills": {}, // 技能 id → { enabled, params }
    "dnd": {
      // 勿扰时段（默认含深夜）
      "enabled": true,
      "ranges": [{ "from": "23:00", "to": "08:00" }],
    },
    "autoStart": false, // ★ 开机自启默认关，且引导里不提（§5 M6）
    "appearance": {
      "scale": 1.0,
      "alwaysOnTop": true,
      "hideOnFullscreen": true, // QUNS {1,2,3,4} → 静默
    },
  },

  // ── 它知道什么 ──（感知授权；措辞用行为语言，不用"权限等级"）
  "perception": {
    "foregroundProcess": true, // "它只会认得你在用什么软件，不知道你在看什么"
    "idleTime": true,
    "systemState": true, // 全屏/锁屏/电池/时间
    "windowTitle": false, // ★ v0.1 恒为 false，不暴露开关（ADR-0002）
    "processAllowlist": [], // 按**进程**分级，不按数据类型分级
  },

  "api": {
    "baseUrl": "",
    "model": "",
    "dailyTokenBudget": 200000, // 默认开启预算
    "budgetEnabled": true,
  },

  "debug": { "showStatusPanel": false },
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
  "id": "example-plugin", // ^[a-z0-9][a-z0-9_-]{0,63}$
  "name": "示例插件",
  "version": "0.1.0",
  "description": "证明插件接口对外可用",
  "author": "",

  // ★ 声明式感知需求：宿主按用户已授权的范围决定"满足哪些"，
  //   插件**不能**自己读感知信号。缺失的需求不会让插件崩溃，只是不触发。
  "perception": ["foregroundProcess", "idleTime"], // 只能是 §1.1 的三项

  // 触发条件：全部为声明式，宿主求值
  "triggers": [
    { "type": "mode", "value": "coding" },
    { "type": "idle", "minSeconds": 300 },
    { "type": "schedule", "cron": "0 10 * * *" },
  ],

  "config": [
    // 配置项 schema → M6 自动生成界面
    {
      "key": "interval",
      "type": "number",
      "label": "间隔（分钟）",
      "default": 45,
      "min": 5,
      "max": 240,
    },
  ],

  "memory": { "read": ["semantic"], "write": ["episodic"] }, // 记忆写入声明

  "entry": "index.js", // 相对插件目录
}
```

**宿主职责**（M4）：加载、生命周期、**错误隔离（单插件抛错不得拖垮主进程）**、
按用户授权裁剪感知需求、把插件写入的记忆纳入记忆账本。

**v0.1 不做**（§5 M4c）：沙箱隔离、签名校验、审核流程、在线市场。
**定接口 ≠ 建市场。**

---

## 6. 资源包约定（`assets/pets/<名字>/`）—— **已落地**

这一节原本是"将来"的约定，现在已经是**实际实现**（精灵图后端）。
下面是按实际代码更正后的内容。

### 6.1 目录结构（契约固定，只认这两个文件名）

```
<宠物目录>/
  pet.json           元数据
  spritesheet.webp   图集（无损 RGBA；PNG 也接受，文件名 spritesheet.png）
```

一个目录 = 一只宠物。用 `XIAOQI_PET_DIR=<目录>` 选择；不设时用内置的
程序化小奇。

### 6.2 图集契约（来自 Codex 官方 `hatch-pet-v2` skill，Apache-2.0）

|          | V1                             | V2                                |
| -------- | ------------------------------ | --------------------------------- |
| 尺寸     | 1536×1872                      | 1536×2288                         |
| 网格     | 8 列 × 9 行                    | 8 列 × 11 行                      |
| 单格     | 192×208                        | 192×208                           |
| 版本字段 | **省略** `spriteVersionNumber` | `spriteVersionNumber: 2`          |
| 注视方向 | 无                             | 行 9–10 共 16 向（0° = **正上**） |

标准动作 9 个（行 0–8）：`idle` `running-right` `running-left` `waving`
`jumping` `failed` `waiting` `running` `review`。**逐帧时长表在我们这边**——
规范明确要求客户端不读图集里的时长，所以换素材时节奏不变，
换节奏必须改代码（节奏属于宿主，不属于素材）。

唯一真相在 `src/shared/petAtlas.ts`；渲染器、蒙版提取、验证脚本、
图集生成器全读它，因此"渲染的格"与"判定命中用的格"不可能漂移。

### 6.3 两条渲染后端

|          | 程序化（默认）          | 精灵图                                  |
| -------- | ----------------------- | --------------------------------------- |
| 窗口尺寸 | 220×220（正方形）       | 192×208 × 缩放（**不是正方形**）        |
| 命中判定 | `PET_GEOMETRY` 椭圆并集 | alpha 点阵蒙版（13×16）                 |
| 情绪表达 | 8 种                    | 最多 4 种（见 `docs/verify-sprite.md`） |

两者提供**同一套对外成员**（`src/renderer/src/pet/petStageContract.ts`），
两个类都显式 `implements`，少一个成员立刻编译失败——没有这条时
"两条后端成员一致"只是口头约定，而漏实现的表现是切换后端时的
运行期 undefined 调用。

尺寸走唯一入口 `petWindowSizeFor(definition, scale)`。
四条调用路径（主进程放窗、主进程命中、渲染建 canvas、渲染建 hitArea）
全部读它，所以不可能出现"窗口按正方形开、判定按格子做"的错位。

### 6.4 自定义协议（`xiaoqi-pet://`）

渲染进程是沙箱化的，没有 Node，也不该拿到绝对路径（那等于把"读任意文件"
通过 `file://` 递出去）。所以素材走一个**只读、只认自己那个目录**的协议：

```
xiaoqi-pet://sheet/spritesheet.webp
```

安全边界就是"路径必须落在素材目录内"：只允许**单层文件名**
（任何子目录与 `..` 一律拒绝），且只放行 `spritesheet.webp` /
`spritesheet.png` / `pet.json` 三个白名单文件名。

⚠️ **两处 CSP 必须同步，少改一处症状都是"图集永远加载不出来"**：

1. `src/renderer/index.html` 的 `connect-src` 要加 `xiaoqi-pet:`
   （scheme 限定，不是 `*`）；
2. `src/main/index.ts` 顶层要调 `declarePetAssetScheme()`，且**必须在
   `app.ready` 之前**。

另外 `registerSchemesAsPrivileged` 里**必须**给 `corsEnabled: true`，
响应头里必须显式给 `Access-Control-Allow-Origin: file://`（`*` 对
"不透明源"不生效）。这两条各自的报错完全不同、指向也不同，
踩坑记录见 `docs/verify-sprite.md` §5.1–5.2。

### 6.5 素材授权

仓库里**不附带**任何第三方宠物素材。`assets/pets/` 下只有程序化生成的
测试图集（CC0，且被 `.gitignore` 忽略）。

社区素材（如 `legeling/awesome-codex-pet` 收录的 239 只）**大多是
CC BY-NC 4.0 非商用授权**——代码 MIT 不等于素材 MIT。所以：

- `pet.json` 的 `license` 会被读出来（裸字符串与官方的
  `{ name, url, author }` 对象两种写法都认）；
- 启动日志**必定**打印署名：`宠物形象：<名字> · <作者> · <授权> · V2 图集`。

这不是装饰：授权决定能不能分发，必须在运行时可见，
而不是埋在某个 README 里等着被忘记。
