# Desktop Pet / Desktop Mascot — Verified Open-Source Design References

Research date: **2026-09-11**. All GitHub API metadata below was observed on that date through
`Invoke-RestMethod` against `api.github.com`; all file/README/package.json facts were observed by
fetching `raw.githubusercontent.com`. Anything not directly observed is marked **UNVERIFIED**.

API budget used: **12 core calls** (2 × `rate_limit`, 4 × `/repos/{owner}/{repo}`, 4 × `git/trees`,
2 × extra `/repos`), **1 search call** (+1 SSL-failed attempt). Start check: 54/60 remaining.
End check: 55/60 remaining (hourly window rolled over; no call was ever throttled).
All other evidence came from raw.githubusercontent.com fetches, which do not consume API quota.

---

## Selected projects (all actively maintained except #5)

| # | Repo | Stack | License (SPDX) | Stars | Last push (pushed_at) |
|---|------|-------|----------------|-------|----------------------|
| 1 | [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) | Tauri v2 + Rust + Vue 3/TS | MIT | 23,084 | 2026-09-11 |
| 2 | [OpenPetsHQ/openpets](https://github.com/OpenPetsHQ/openpets) | Electron + TypeScript (+React/Tailwind renderer, Vite) | MIT | 1,184 | 2026-09-05 |
| 3 | [ChaozhongLiu/DyberPet](https://github.com/ChaozhongLiu/DyberPet) | Python 3 + PySide6 (Qt) | GPL-3.0 | 972 | 2026-08-15 |
| 4 | [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) | Electron + JavaScript | AGPL-3.0 | 6,202 | 2026-09-11 |
| 5 | [zenghongtu/PPet](https://github.com/zenghongtu/PPet) | Electron 16 + TS + React + Vite + Live2D | MIT | 2,032 | 2024-06-18 (**stale**) |

Chinese-language projects: **BongoCat** (Chinese README, 跨平台互动桌宠) and **DyberPet** (Chinese README,
呆啵宠物). PPet is also Chinese but stale.

---

## 1. ayangweb/BongoCat — the strongest actively-maintained reference (Chinese, Tauri)

- **URL:** https://github.com/ayangweb/BongoCat
- **API metadata observed 2026-09-11:** `full_name=ayangweb/BongoCat`;
  description `🐱跨平台互动桌宠 BongoCat，为桌面增添乐趣！`; `language=Vue`;
  stars 23,084; forks 1,122; `license.spdx_id=MIT`; `pushed_at` 2026-09-11 12:32:55;
  created 2025-03-28; `archived=false`; open issues 97; default branch `master`;
  topics: bongo-cat, bongocat, cross-platform, desktop-app, desktop-pet, linux, macos, pet,
  pet-project, rust, tauri, tauri-app, windows.
- **Stack (confirmed):** Tauri v2 — `src-tauri/tauri.conf.json` declares
  `"$schema": "https://schema.tauri.app/config/2"`; Rust backend (`src-tauri/src/`), Vue 3 frontend.
  `package.json` (v1.1.0) dependencies include `@tauri-apps/api ^2.10.1`, `vue ^3.5.32`, `pinia`,
  `vue-i18n`, `pixi.js ^8.18.1`, **`easy-live2d ^0.4.4`**, plus Tauri plugins for updater,
  autostart, global-shortcut, fs, dialog, os, process, log. **Not Electron.**
- **Features confirmed and where:**
  - **Transparent / frameless / always-on-top / skip-taskbar** — `src-tauri/tauri.conf.json`,
    `main` window block: `shadow:false`, `alwaysOnTop:true`, `transparent:true`,
    `decorations:false`, `acceptFirstMouse:true`, `skipTaskbar:true`, `maximizable:false`.
    A second hidden window `preference` holds settings.
  - **Tray icon** — `src/composables/useTray.ts`: creates `TrayIcon` with id `BONGO_CAT_TRAY`,
    icon resolved from bundled `assets/tray.png` / `assets/tray-mac.png`, tooltip
    `` `${appName} v${appVersion}` ``, `menuOnLeftClick: true`; tray menu rebuilt reactively on
    `window.visible`, **`window.passThrough`**, language, scale, opacity. `tauri.conf.json`
    bundle resources include `assets/tray.png` and `assets/models`.
  - **Live2D** — `easy-live2d` + `pixi.js` dependencies; source files `src/utils/live2d.ts`,
    `src/composables/useModel.ts`. Users can import custom models; third-party model hub at
    `ayangweb/Awesome-BongoCat` (linked from README).
  - **Pass-through (click-through) setting exists** — store field `window.passThrough`
    (`src/stores/cat.ts`, alongside `alwaysOnTop`, `scale`, `opacity`, `radius`, `hideOnHover`);
    a deprecated alias `penetrable` remains. The exact OS-level call site (e.g. Tauri
    `setIgnoreCursorEvents`) was **UNVERIFIED** — not fetched.
  - **Device-reactive animation** — `src-tauri/src/core/device.rs`, `core/gamepad.rs`,
    `core/prevent_default.rs`; frontend `src/composables/useDevice.ts`, `useGamepad.ts`,
    `useKeyPress.ts`. README: 「根据键盘、鼠标或手柄的操作，同步对应的动作」.
  - **Other** — auto-update (`tauri-plugin-updater` + release-it), autostart, i18n (`vue-i18n`),
    offline/no-telemetry claim in README. **AI/LLM chat: none observed** (no such feature in README
    or package.json) — treat "AI chat" as absent/UNVERIFIED.
- **Worth borrowing as design ideas:** the two-window split (tiny overlay + normal settings window);
  exposing pass-through / always-on-top / scale / opacity / radius / hide-on-hover as one
  store-driven "window behavior" block surfaced directly in the tray menu; a reactive tray menu that
  mirrors window state; treating "input device events → animation state" as the core loop; and
  shipping a model-import path plus a community model hub. Also worth weighing: **Tauri instead of
  Electron** buys a far smaller footprint for an always-running overlay, at the cost of a Rust
  toolchain and per-OS window quirks.

## 2. OpenPetsHQ/openpets — the best Electron/TypeScript reference (plugin SDK + agent layer)

- **URL:** https://github.com/OpenPetsHQ/openpets
- **API metadata observed 2026-09-11:** description `Local first, desktop companion platform with
  animated pets, plugin SDK and coding-agent integrations.`; `language=TypeScript`; stars 1,184;
  forks 105; `license.spdx_id=MIT`; `pushed_at` 2026-09-05 22:31:05; created 2026-05-04;
  `archived=false`; open issues 20; default branch `main`; topics include `electron`,
  `desktop-pet`, `plugin-sdk`, `ai-agents`, `mcp`, `claude-code`, `dsh-plugin`, `typescript`.
- **Stack (confirmed):** Electron + TypeScript monorepo (pnpm workspace, `apps/*`, `packages/*`,
  root `package.json` v3.5.0, `license: MIT`). `apps/desktop/package.json` (v3.5.0, `license: MIT`)
  description **"OpenPets tray-first desktop companion app."**, `main: dist/main.js`,
  `"dev": "pnpm build && electron ."`, packaging via **electron-builder**; renderer is a Vite
  **React/Tailwind** bundle (per `apps/desktop/src/codemap.md`).
- **Features confirmed and where:**
  - **Tray-first** — `apps/desktop/package.json` description; `apps/desktop/src/main.ts` imports
    `createAppTray, refreshTrayMenu` from `./tray.js` and calls `createAppTray()` in the ready path.
  - **Transparent + always-on-top pet windows** — `apps/desktop/src/main.ts` comment:
    *"For transparent always-on-top pet windows that means the pet goes blank during any fullscreen
    video or game even when its z-order is intact"* (they disable Chromium's occlusion-based paint
    throttling). `apps/desktop/src/codemap.md`: *"Control Center loads the Vite React/Tailwind bundle
    through a hardened BrowserWindow and narrow preload bridge; **transparent pet windows** and plugin
    SDK host windows stay separate."*
  - **Sprite animation + reaction mapping** — `codemap.md`: *"Reaction Animation Mapping:
    User-configurable mapping from reaction types to **sprite animation states**"*, and *"Motion
    Engine Abstraction: Advanced pet movement uses a small physics/interpolation engine rather than
    embedding movement math in window or SDK routing code."* Live2D: **UNVERIFIED / not observed.**
  - **Plugin system (very relevant)** — README: *"Plugin SDK v3: a sandboxed JavaScript/TypeScript
    runtime for building new pet abilities with permissions, quotas, storage, schedules, commands,
    panels, events, audio, notifications"*; `codemap.md`: validated manifests, approved permissions,
    persisted config, safe path checks, declarative timer-triggered actions, sandboxed JS entry
    modules via the SDK bridge; capability-split SDK modules (audio, bus, config, events, quotas,
    routes, state, storage, types, UI); **host-rendered plugin UI** — plugins describe bubbles,
    alerts, commands, panels and the host validates + renders them.
  - **AI/agent integration** — README: *"Optional agent layer: Claude Code, OpenCode, Cursor, Pi, and
    MCP clients can drive local pet reactions without exposing prompts, code, paths, logs, or secrets
    in speech bubbles."* Source confirms `agent-pet-controller.ts`, `agent-activity-payload.ts`,
    `codex-pets.ts`, `confinement-manager.ts`; `codemap.md` documents a **lease pattern** (agent pets
    hold expiring 15s-TTL leases with heartbeats; the default pet is persistent) and **protocol-first
    IPC** (versioned JSON over TCP/Unix socket with token auth). In-app LLM chat: `voice-assistant-host.ts`
    and `pet-assistant-archive.ts` exist; the actual model provider wiring is **UNVERIFIED**.
  - **Click-through / ignore-mouse-events: UNVERIFIED** — a targeted grep of `apps/desktop/src/windows.ts`
    for `setIgnoreMouseEvents|transparent|alwaysOnTop|frame:` returned no matches, so the pet-window
    factory lives elsewhere and was not located.
  - **i18n** — locale files observed for `en, es-419, ja, ko, pt-BR, zh-Hans, zh-Hant`; README lists
    the same set. (README is English-first, so this is *not* counted as the required Chinese project.)
- **Caveat:** `package.json` `repository.url` points at `github.com/alvinunreal/openpets` while the
  canonical `full_name` from the API is `OpenPetsHQ/openpets` — appears to be an org move/redirect;
  the redirect itself was not tested (**UNVERIFIED**).
- **Worth borrowing as design ideas:** a permissioned, quota'd plugin SDK with **host-rendered UI
  descriptors** (plugins never draw arbitrary UI themselves) — this is the cleanest plugin boundary
  seen in this survey; the data-driven reaction→animation mapping table; a separate motion/physics
  module instead of movement math in window code; the lease-with-heartbeat model for transient
  agent-driven pets; keeping the Control Center, the pet overlay and plugin panels in **separate
  BrowserWindows**; and the documented workaround for Chromium occlusion throttling blanking
  transparent always-on-top windows — a real bug an Electron pet will hit.

## 3. ChaozhongLiu/DyberPet — Chinese PySide6 pet *framework* (GPL-3.0, design-only)

- **URL:** https://github.com/ChaozhongLiu/DyberPet
- **API metadata observed 2026-09-11:** description `Desktop Cyber Pet Framework based on PySide6`;
  `language=Python`; stars 972; forks 104; `license.spdx_id=GPL-3.0`; `pushed_at` 2026-08-15;
  created 2022-11-09; `archived=false`; open issues 21; default branch `main`; topic `desktop-pet`.
- **Stack (confirmed):** Python + PySide6 (`DyberPet/DyberPet.py` imports `PySide6.QtWidgets`,
  `QtCore`); README pins `pyside6==6.5.2`, `PySide6-Fluent-Widgets==1.5.4`, `pynput`, `apscheduler`,
  `tendo`, conda + `run_DyberPet.py`. Chinese-first README (呆啵宠物 DyberPet; 「当前仓库以中文内容为主」).
- **Features confirmed and where:**
  - **Frameless + transparent + always-on-top overlay** — `DyberPet/DyberPet.py`:
    `self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.SubWindow |
    Qt.NoDropShadowWindowHint)` on Windows (macOS variant drops `SubWindow`), gated by a user setting
    `settings.on_top_hint`; `self.setAutoFillBackground(False)` and
    `self.setAttribute(Qt.WA_TranslucentBackground, True)`.
  - **Tray icon** — `DyberPet/DyberPet.py`: `self.tray = SystemTray(self.StatMenu, self)` with
    `self.tray.setIcon(QIcon(os.path.join(basedir, 'res/icons/icon.png')))` and `self.tray.show()`.
  - **Drag physics** — `import pynput.mouse as mouse`, `MouseMoveManager`, per-frame velocity
    computation (`settings.dragspeedx/dragspeedy`), `fall_right` state — i.e. the pet can be thrown
    and falls.
  - **Frame-based animation** — `self.workers['Animation']` + `self.set_img()`; characters, items and
    sounds are data-driven from JSON (`res/role/PETNAME/pet_conf.json`, `res/items/Default/items_config.json`
    per the README changelog). Frame image format (GIF vs sprite sheet) is **UNVERIFIED**; the README
    only contrasts itself with 「不只是"GIF 展示器"」.
  - **Game/platform systems** — source tree shows `DyberPet/Dashboard/` (status, task, shop, inventory,
    animation-design UIs), `buffModule.py`, `bubbleManager.py` (speech bubbles), `custom_roundmenu.py`,
    `Notification.py`, `extra_windows.py`, `HideDock/`, `SelfStartup/`, `Accessory.py`.
  - **AI/LLM** — README advertises 「AI 助手：桌宠系统接入大模型」 but states
    「LLM 模块仍在持续开发中，相关能力暂未完全开源」 — **the LLM module is not fully open source**.
  - **Platforms** — Windows packaged release v0.10.3; README says macOS is open-sourced only up to
    v0.6.7.
  - **Click-through / ignore-mouse-events: not observed (UNVERIFIED).**
- **Worth borrowing as design ideas:** the "pet as a platform" framing — items, shop, tasks, leveling
  and mini-pets driven entirely by JSON mod files, with a documented mod-authoring path; a dedicated
  **speech-bubble manager** decoupled from the pet window; the settings/status dashboard living in
  ordinary windows while the pet stays a translucent overlay; and physically plausible drag/throw
  handling. **GPL-3.0: study the design, do not copy code.**

## 4. rullerzhou-afk/clawd-on-desk — Electron pixel pet that watches AI coding agents (AGPL-3.0)

- **URL:** https://github.com/rullerzhou-afk/clawd-on-desk
- **API metadata observed 2026-09-11:** description `A pixel desktop pet that watches Claude Code,
  Codex, Cursor & other AI coding agents — so you don't have to.`; `language=JavaScript`;
  stars 6,202; `license.spdx_id=AGPL-3.0`; `pushed_at` 2026-09-11 07:26:53; `archived=false`;
  topics: claude-code, codex, copilot, cursor, **desktop-pet**, **electron**, gemini, **pixel-art**,
  **svg-animation**.
- **Stack (confirmed):** Electron — repository `package.json` (branch `main`): name `clawd-on-desk`,
  v1.0.0, `"main": "src/main.js"`, description `A desktop pet that reacts to your Claude Code sessions
  in real-time.`, build scripts all `electron-builder` (Windows nsis x64/arm64, macOS dmg/zip,
  Linux AppImage/deb).
- **Features confirmed and where (`src/main.js`, 5,087 lines, fetched in full):**
  - **Frameless / transparent / always-on-top / skip-taskbar BrowserWindow** — observed window options
    at ~line 3543: `alwaysOnTop: true, frame: false, transparent: true, skipTaskbar: true` (the block
    fetched is a modal input window; the main pet window's own options block was not fetched →
    partially **UNVERIFIED**).
  - **Tray icon with flashing notification state** — `src/tray-flash-icon.js`
    (`loadTrayNormalIcon`, `loadTrayFlashIcon`), `buildTrayMenu`, tray flash timers,
    `createTrayBalloonOwner()`.
  - **Click-through done right** — code comment: `let hitWin; // input window — small opaque rect over
    hitbox, receives all pointer events`, and a comment stating that intents are routed through
    *"pet-window-runtime's single ignore-mouse writer instead of this module calling
    `hitWin.setIgnoreMouseEvents()` directly"* → the big pet window stays click-through while a tiny
    opaque hit window receives input, with **one central owner of the ignore-mouse state**.
  - **Z-order re-assertion** — `topmostRuntime`, `reassertWinTopmost()`, `reapplyMacVisibility()`,
    `keepOutOfTaskbar()` (`src/taskbar.js`), fullscreen auto-hide override — direct evidence that
    another app stealing topmost is a real, recurring problem.
  - **AI-agent integration** — session watching for Claude Code / Codex / Cursor; modules required in
    `main.js` include `telegram-migration-controller`, `feishu-approval-migration-nudge`,
    `telegram-approval-migration-nudge` → the pet doubles as a remote approval/notification channel
    (Telegram/Feishu).
  - **Animation** — pixel-art / SVG animation per repo topics; implementation detail **UNVERIFIED**.
- **Worth borrowing as design ideas:** the **separate tiny hit-window** pattern for click-through with
  a single centralized ignore-mouse writer (cleaner than toggling the flag from many call sites); an
  explicit topmost re-assertion loop; the tray icon as a *flashing* notification channel; and
  "coding-agent activity → pet animation state" as the whole product loop. **AGPL-3.0: design study
  only, and note the network-copyleft clause.**

## 5. zenghongtu/PPet — verified, but NOT actively maintained (excluded from the active set)

- **URL:** https://github.com/zenghongtu/PPet
- **API metadata observed 2026-09-11:** description `👻在你的桌面放一个萌妹子，多一点乐趣😏~（支持Mac、Win和Linux）`;
  `language=TypeScript`; stars 2,032; forks 232; `license.spdx_id=MIT`; `pushed_at` **2024-06-18**
  (≈2 years stale); created 2020-01-03; `archived=false`; open issues 109; default branch `dev`;
  topics: electron, live2d, live2d-model, live2d-widget, live2dv3, react, vite.
- **Stack (confirmed):** `package.json` on branch `dev` — name `PPet3`, v3.3.0, `license: MIT`,
  `main: dist/main/index.cjs`; devDependencies include **`electron 16.0.6`**, `electron-builder`,
  `electron-store`, `electron-window-state`, `react 17`, `@rematch/core`, `redux`, `antd`, `vite`,
  `@electron/remote`, `globby`, and **`react-ga`** (Google Analytics).
- **Features:** Electron + TypeScript + React + Vite desktop pet with Live2D models (per API topics
  and dependencies); `electron-window-state` implies persisted pet position. Detailed window/tray/
  click-through behaviour: **UNVERIFIED** (source not fetched).
- **Verdict:** good historical architecture reference for an Electron + Live2D pet (multi-model
  scanning via `globby`, window-state persistence), but its Electron 16 baseline and 2024 last commit
  make it unsuitable as a maintained dependency. Note it ships analytics (`react-ga`) — not something
  to copy.

---

## Observed but NOT deep-verified (metadata from the GitHub search API, 2026-09-11 — features UNVERIFIED)

Do not treat these as recommendations; they are leads only.

| Repo | Language | License (SPDX) | Stars | pushed_at | Note |
|------|----------|----------------|-------|-----------|------|
| `Adrianotiger/desktopPet` | C# | **UNVERIFIED** (API returned no detected license) | 1,144 | 2026-09-09 | eSheep revival; Windows-native, not Electron |
| `NanmiCoder/cc-haha` | TypeScript | MIT | 14,332 | 2026-09-11 | Agent workspace; "task-aware desktop pets" is one feature, not a pet-first app |
| `SlimeBoyOwO/LingChat` | Rust | AGPL-3.0 | 2,148 | 2026-09-11 | LLM desktop pet; likely Tauri (UNVERIFIED) |
| `isHarryh/Ark-Pets` | Java | GPL-3.0 | 1,088 | 2026-09-05 | Arknights-themed; JVM stack |
| `ChaozhongLiu/DyberPet_GenshinImpact` | — | GPL-3.0 | 315 | 2026-04-25 | Asset pack for DyberPet |
| `OpenBMB/MiniCPM-Desk-Pet` | JavaScript | AGPL-3.0 | 480 | 2026-08-18 | Desk pet + MiniCPM model |

**`ChanceYu/cyber-pet` could NOT be verified.** A `web_search` for "ChanceYu cyber-pet github"
returned no such repository (only the unrelated `ChanceYu/front-end-rss`). Treat it as nonexistent
unless a direct URL is supplied. `Lemon-Quan/...`, `yuanshuai/...` and `kungfu321/...` were likewise
never confirmed and are **UNVERIFIED** — no repo of those names appeared in any tool result.

---

## License implications for a proprietary (closed-source) app

| Project | License (SPDX, observed) | Copy code into closed-source app? | What is allowed |
|---------|--------------------------|-----------------------------------|-----------------|
| ayangweb/BongoCat | MIT | **YES** | Copy/modify/sell; keep copyright + license notice |
| OpenPetsHQ/openpets | MIT | **YES** | Same as above |
| zenghongtu/PPet | MIT | **YES** | Same as above (but code is stale) |
| ChaozhongLiu/DyberPet | **GPL-3.0** | **NO** | Design study only; any copied code makes the whole app GPL-3.0 |
| rullerzhou-afk/clawd-on-desk | **AGPL-3.0** | **NO** | Design study only; strongest copyleft — network/interaction use can trigger source disclosure |
| SlimeBoyOwO/LingChat | AGPL-3.0 | **NO** | Design study only |
| OpenBMB/MiniCPM-Desk-Pet | AGPL-3.0 | **NO** | Design study only |
| isHarryh/Ark-Pets | GPL-3.0 | **NO** | Design study only |
| Adrianotiger/desktopPet | UNVERIFIED (no license detected by the API) | **NO** | Absent a license, default copyright applies — all rights reserved; do not copy |

- **Copy-PERMITTED families:** MIT, Apache-2.0, BSD-2/3-Clause (with notice/attribution
  requirements). In this verified set only **MIT** appears (BongoCat, openpets, PPet).
- **Copy-FORBIDDEN for a proprietary app:** GPL-2.0, GPL-3.0, AGPL-3.0. **LGPL caveat:** LGPL code
  can sometimes be used in a closed-source app only via dynamic linking plus relinking rights and
  license notices — none of the verified picks are LGPL, but this matters for *dependencies*
  (e.g. Qt/PySide6 ships under LGPL-3.0 in its open-source edition — **UNVERIFIED in this session**).
- **Plain statement:** the GPL-family projects here (DyberPet = GPL-3.0; clawd-on-desk, LingChat,
  MiniCPM-Desk-Pet = AGPL-3.0) **may be studied for design ideas, but their code must not be copied
  into a closed-source product.** Read them for architecture, window-flag recipes and UX patterns;
  write your own implementation.
- **Separate, non-OSS caveat:** Live2D Cubism SDK / model assets carry their own proprietary license
  terms independent of the host app's license. This was **not verified in this session** — check the
  Live2D SDK terms (and each model's own terms) before shipping Live2D in a commercial app.

---

## Bottom line for an Electron desktop-pet app

1. **Primary Electron/TypeScript reference: `OpenPetsHQ/openpets` (MIT).** Copy-permitted, actively
   maintained, and it has already solved the hard parts: separate transparent pet window vs Control
   Center vs plugin panels, a permissioned plugin SDK with host-rendered UI, reaction→animation
   mapping, a motion module, and the Chromium occlusion-throttling workaround for transparent
   always-on-top windows.
2. **Primary feature/UX reference: `ayangweb/BongoCat` (MIT, Chinese, 23k stars, pushed today).**
   Its `tauri.conf.json` window block is a ready-made checklist of overlay flags, and its tray +
   store-driven pass-through/scale/opacity model is exactly the shape an Electron pet's window-
   behavior layer should take. It is Tauri, so borrow the *design*, not the plumbing.
3. **Chinese-language, framework-idea reference: `ChaozhongLiu/DyberPet` (GPL-3.0).** Best example of
   a JSON-driven mod/shop/task ecosystem and a decoupled speech-bubble manager — design study only.
4. **Click-through + always-on-top hardening reference: `rullerzhou-afk/clawd-on-desk` (AGPL-3.0).**
   Tiny opaque hit-window over a click-through overlay, one central ignore-mouse writer, and an
   explicit topmost re-assertion loop — design study only.
