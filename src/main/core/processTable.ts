import type { WorkMode } from '@shared/types'

/**
 * 进程名 → 应用类别 的映射表。
 *
 * ── 这张表就是这个产品的隐私承诺本身 ──
 *
 * 它只认得**进程名**（`code.exe`、`msedge.exe`），因此只能回答
 * "你在用什么软件"，永远回答不了"你在看什么"。
 * 浏览器在这里就是 `browser` 一个类别——**不区分网页**，
 * 因为我们不读窗口标题（施工令 §1.1④ / ADR-0002）。
 *
 * 代价是准确率上限更低，**这是刻意接受的**：用可解释的"认得几个应用"
 * 换取永不触碰内容。ADR-0002 的结论是——按数据类型分级的模型会系统性地
 * 低估某一级的风险上限（一级的风险取决于最坏的那个应用，不是平均值）。
 *
 * ── ★ 匹配方式：默认**精确**，不是子串 ★ ──
 *
 * 初版用子串匹配，实测立刻出问题：`et`（WPS 表格）命中了
 * `acme-widget.exe` —— 因为 "widget" 里含 "et"。
 * 这类误判**不会报错**，只会让宠物在用户干别的事时以为他在做表格。
 *
 * 所以现在有两条路：
 * - `group`（默认）：与去掉扩展名后的进程名**完全相同**才命中；
 * - `loose`（少数）：显式声明的子串匹配，用于同一软件的不同发行版
 *   （`code` 要同时命中 `code.exe` 与 `vscode.exe`）。
 *
 * 新增条目时**默认用 group**。用 loose 需要想清楚"会不会命中别的软件"。
 *
 * ── 维护说明 ──
 *
 * 新增敏感度时**新增一个进程白名单项**，不要新增"数据类型"级别（ADR-0002）。
 */
interface ProcessEntry {
  /** 进程名主干（不含 `.exe`）。 */
  readonly name: string
  readonly category: AppCategory
  /** 用子串匹配而不是精确匹配。只给"同一软件的多个发行版"用。 */
  readonly contains?: boolean
}

/** 应用类别。**刻意只有这几类**——类别越少，推断越可解释。 */
export type AppCategory =
  /** 干活用的工具：编辑器、终端、文档、设计 */
  | 'devTool'
  /** 会议 / 通话 */
  | 'meeting'
  /** 邮件 */
  | 'mail'
  /** 浏览器：只知是浏览器，不知在看什么 */
  | 'browser'
  /** 娱乐 */
  | 'entertainment'
  /** 认得但没归类，或根本没有前台窗口 */
  | 'unknown'

/**
 * 把"一串进程名 + 一个类别"展开成条目。
 *
 * 用分组写法而不是逐条写 `{ name, category }`：后者在加条目时极易漏掉类别，
 * 而且一漏就是编译期才发现（本机确实这么错过一次，一百多条一起报缺失字段）。
 * 按类别分块则不可能漏。
 */
function group(category: AppCategory, names: readonly string[]): ProcessEntry[] {
  return names.map((name) => ({ name, category }))
}

/** 需要**子串**匹配的少数条目（同一软件的多个发行版）。 */
function loose(category: AppCategory, names: readonly string[]): ProcessEntry[] {
  return names.map((name) => ({ name, category, contains: true }))
}

const TABLE: readonly ProcessEntry[] = [
  // ── 编辑器 / IDE ──
  ...loose('devTool', ['code']), // code.exe / vscode.exe / code-insiders.exe
  ...group('devTool', [
    'cursor',
    'windsurf',
    'zed',
    'devenv', // Visual Studio
    'idea64',
    'idea',
    'pycharm64',
    'pycharm',
    'webstorm64',
    'webstorm',
    'goland64',
    'goland',
    'clion64',
    'clion',
    'rider64',
    'rider',
    'datagrip64',
    'datagrip',
    'sublime_text',
    'notepad++',
    'nvim',
    'vim',
    'emacs',
    'studio64', // Android Studio
    'xcode',
    'postman',
    'insomnia',
  ]),

  // ── 终端（写代码的人大部分时间在这里）──
  ...group('devTool', [
    'windowsterminal',
    'wt',
    'powershell',
    'pwsh',
    'cmd',
    'conhost',
    'wezterm',
    'wezterm-gui',
    'alacritty',
    'mintty',
    'git-bash',
    'bash',
    'wsl',
    'docker desktop',
  ]),

  // ── 会议 / 通话 ──
  ...loose('meeting', ['teams']), // ms-teams.exe / teams.exe
  ...group('meeting', [
    'zoom',
    'webexmta',
    'webex',
    'skype',
    'wemeetapp',
    'wemeet',
    'dingtalk',
    'feishu',
    'lark',
    'voov',
    'slack', // Slack 的 huddle 是通话形态
    'discord',
    'mstsc', // 远程桌面：多半在被开会 / 被演示
  ]),

  // ── 邮件 ──
  ...loose('mail', ['outlook']), // outlook.exe / hxoutlook.exe
  ...group('mail', ['thunderbird', 'foxmail', 'mailspring']),

  // ── 浏览器：只有这一个类别，**不区分内容** ──
  ...group('browser', [
    'msedge',
    'chrome',
    'firefox',
    'brave',
    'opera',
    'vivaldi',
    '360se',
    '360se6',
    '360chrome',
    'qqbrowser',
    'sogouexplorer',
    'iexplore',
  ]),

  // ── 娱乐（用来判断"用户在休息"）──
  ...group('entertainment', [
    'steam',
    'steamwebhelper',
    'bilibili',
    'potplayer',
    'potplayermini64',
    'vlc',
    'mpc-hc',
    'mpc-hc64',
    'netflix',
    'spotify',
    'qqmusic',
    'cloudmusic',
  ]),

  // ── 文档 / 笔记（都是"在产出东西"的工具，归到干活）──
  // ⚠️ `et` / `wpp` 这种两字母名**必须**走精确匹配：
  //    子串匹配时 `et` 会命中 `widget`（实测踩过）。
  ...group('devTool', [
    'winword',
    'excel',
    'powerpnt',
    'wps',
    'et',
    'wpp',
    'onenote',
    'notion',
    'obsidian',
    'typora',
    'acrord32',
    'sumatrapdf',
  ]),

  // ── 设计 / 影音制作 ──
  ...group('devTool', [
    'photoshop',
    'illustrator',
    'figma',
    'sketch',
    'blender',
    'afterfx',
    'premiere',
    'obs64',
  ]),
]

/** 把 `name` 归一化：去掉 `.exe`、转小写。 */
export function normalizeProcessName(raw: string): string {
  const lower = raw.toLowerCase()
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower
}

// 建一次索引，轮询时不做线性扫描里的字符串比较。
const EXACT_INDEX = new Map<string, AppCategory>()
const CONTAINS_ENTRIES: { needle: string; category: AppCategory }[] = []

for (const entry of TABLE) {
  if (entry.contains) {
    CONTAINS_ENTRIES.push({ needle: entry.name, category: entry.category })
  } else if (!EXACT_INDEX.has(entry.name)) {
    // 同名条目以**先出现**的为准；表里已经保证不冲突。
    EXACT_INDEX.set(entry.name, entry.category)
  }
}

/**
 * 由进程名判断应用类别。
 *
 * `null`（拿不到前台进程）与"认得但没归类"都返回 `unknown`——
 * 两者对推断的意义相同：**不知道用户在干什么**，此时应当保守。
 */
export function categorizeProcess(processName: string | null): AppCategory {
  if (!processName) return 'unknown'
  const name = normalizeProcessName(processName)

  const exact = EXACT_INDEX.get(name)
  if (exact) return exact

  // 子串匹配放在最后，且只对显式标注的少数条目生效。
  for (const entry of CONTAINS_ENTRIES) {
    if (name.includes(entry.needle)) return entry.category
  }
  return 'unknown'
}

/** 某一类应用是否算"确知在干活"。 */
export function isWorkCategory(category: AppCategory): boolean {
  return category === 'devTool' || category === 'meeting' || category === 'mail'
}

/** 各类别的可读名（调试面板用）。 */
export const CATEGORY_LABELS: Record<AppCategory, string> = {
  devTool: '工作工具',
  meeting: '会议',
  mail: '邮件',
  browser: '浏览器',
  entertainment: '娱乐',
  unknown: '未归类',
}

/** 工作模式的可读名（调试面板用）。 */
export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  coding: '编码',
  meeting: '会议',
  email: '邮件',
  focus: '专注',
  rest: '休息',
  overtime: '加班',
  offWork: '下班',
  weekend: '周末',
}
