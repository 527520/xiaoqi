# Electron Desktop-Pet — Technical Fact Verification

**Verification date:** 2026-09-11
**Version context observed:** Electron latest stable **v44.3.0** (released 2026-09-08); Electron 44.0.0 bundles **Chromium 152.0.7977.54, Node v24.18.1, V8 15.2**. `better-sqlite3` **13.0.3** (2026-08-05). `keytar` **7.9.0** (2022-02-17).

## Method & tooling caveat (read this before trusting anything below)

`web_fetch` was **unusable in this environment**: DNS resolves through a fake-IP proxy range (`198.18.0.0/15` — e.g. `electronjs.org → 198.18.0.23`, `github.com → 198.18.0.9`), and the tool rejects non-public IPs. `web_search` worked (discovery only).

All page content below was fetched over **direct HTTPS via `pwsh` `Invoke-WebRequest`** and is quoted from the live pages / raw files: `electronjs.org` docs, `raw.githubusercontent.com` (Electron, Chromium, better-sqlite3, keytar sources), `registry.npmjs.org`, `api.github.com`, `nodejs.org`, `learn.microsoft.com`.

**Confidence legend:** ✅ confirmed by primary source quoted here · ⚠️ partially confirmed / inferential · ❌ could NOT verify (stated explicitly, never guessed).

---

## 1. `better-sqlite3` in Electron with `sandbox: true` + `contextIsolation: true`

### Verdict
✅ **Yes, it works — but the module can only live in the main process and must be reached over IPC.** A sandboxed renderer *and its preload script* cannot load it at all. ✅ Native modules generally need to be built for Electron's ABI — **but `better-sqlite3` v13 changed this** by moving to N-API with bundled prebuilds, so a rebuild may be unnecessary (maintainer's word: "should **theoretically** work").

### Evidence

**The renderer cannot load it (hard constraint, not a gotcha).**
Electron, *Process Sandboxing* ([docs](https://www.electronjs.org/docs/latest/tutorial/sandbox)):
> "When renderer processes in Electron are sandboxed, they behave in the same way as a regular Chromium renderer would. A sandboxed renderer won't have a Node.js environment initialized." … "renderer processes can only perform privileged tasks (such as interacting with the filesystem …) by delegating these tasks to the main process via inter-process communication (IPC)."

The preload escape hatch is explicitly closed — the sandboxed-preload `require` can only import:
> "electron (following renderer process modules: contextBridge, crashReporter, ipcRenderer, nativeImage, webFrame, webUtils), events, timers, url" (+ `node:events`, `node:timers`, `node:url`)

`better-sqlite3` is not in that list, and native `.node` loading is not available. Also: "Enabling Node.js integration for a renderer process by setting `nodeIntegration: true` disables the sandbox for the process" — so you cannot keep `sandbox: true` and load it in the renderer. **Pattern: `ipcMain.handle(...)` + `ipcRenderer.invoke(...)` exposed through `contextBridge`.**

**ABI / rebuild background.**
Electron, *Native Node Modules* ([docs](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)):
> "Native Node.js modules are supported by Electron, but since Electron has a different application binary interface (ABI) from a given Node.js binary (due to differences such as using Chromium's BoringSSL instead of OpenSSL), the native modules you use will need to be recompiled for Electron."
> Error signature: `NODE_MODULE_VERSION $XYZ. This version of Node.js requires NODE_MODULE_VERSION $ABC.`
> "After you upgrade Electron, you usually need to rebuild the modules." · Recommended tool: `@electron/rebuild` ("If you are using Electron Forge, this tool is used automatically"). Windows binary: `.\node_modules\.bin\electron-rebuild.cmd`.

**What changed in better-sqlite3 v13 (important, and recent).**
[v13.0.0 release notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0) (published 2026-07-21):
> "Version `13.0.0` marks a major milestone, as it's the first version of `better-sqlite3` to run on **the N-API**. This means prebuilt binaries should **theoretically** work across different versions of Node.js and Electron… As a result, we've removed the deprecated `prebuild-install` dependency, and now prebuilt binaries are published directly with the `better-sqlite3` code itself."

Verified in the published artifact (npm tarball `better-sqlite3-13.0.3.tgz`, inspected locally):
- bundled prebuilds: `prebuilds/win32-x64.node`, `win32-arm64.node`, `darwin-{x64,arm64}.node`, `linux-{x64,arm64}.node`, `linuxmusl-*.node` — **one binary per platform/arch, no per-Electron/per-ABI variants**;
- `"gypfile": false`, **no `install` script**;
- `lib/binding.js` loads `prebuilds/<platform>-<arch>.node` first, falling back to `build/Release/better_sqlite3.node`;
- `binding.gyp` defines `NAPI_VERSION=10`.
Node-API 10 is supported by "**v22.14.0+, 23.6.0+ and all later versions**" ([Node-API version matrix](https://nodejs.org/api/n-api.html)); Electron 43/44 ship Node 24.x, so the requirement is met. Node docs also state Node-API "ensures ABI stability across Node.js versions and different compiler levels".
⚠️ Inference (not an official Electron statement): Electron's own docs **never mention N-API** in the native-modules material (grep of that page for `Node-API|N-API|napi` → no match), so "prebuild works in Electron without rebuild" rests on the maintainer's wording + the N-API guarantee, not on an Electron doc. **Test it on your pinned Electron version.**

**Known gotchas (all observed, with dates):**

| Gotcha | Evidence |
|---|---|
| `electron-rebuild` is still the official advice for Electron | better-sqlite3 [troubleshooting doc](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/troubleshooting.md): "If you're using Electron, use `electron-rebuild`." |
| **Install-time breakage on Windows** — npm implicitly injects `"install": "node-gyp rebuild"` when a package has `binding.gyp` and no install script, so Python + MSVC are demanded even though a prebuild ships | [issue #1503](https://github.com/WiseLibs/better-sqlite3/issues/1503) (opened 2026-07-24, closed 2026-07-28): "`gyp ERR! find Python` … even though `prebuilds/win32-x64.node` is included". Fix = `gypfile: false` ([PR #1505](https://github.com/WiseLibs/better-sqlite3/pull/1505), shipped ~13.0.2, 2026-07-29). **Still reported on Windows 2026-08-20** in the same thread (npm re-creating the implicit script — [npm/cli#9837](https://github.com/npm/cli/issues/9837)). Workarounds in-thread: pnpm `allowBuilds: better-sqlite3: false`, Yarn `dependenciesMeta.better-sqlite3.built: false`, or pin `^12`. |
| `@electron/rebuild` will try to rebuild it anyway (it has `binding.gyp`), discarding the bundled prebuild | Reproduced by a downstream Electron user in [#1503 comments](https://github.com/WiseLibs/better-sqlite3/issues/1503) (2026-07-30, Electron 42→43 + v13); they narrowed it with `onlyModules`. `@electron/rebuild` documents `-o, --only` / `onlyModules` ([README](https://raw.githubusercontent.com/electron/rebuild/main/README.md)). Note this is user-reported behaviour, not an official @electron/rebuild doc statement. |
| `@electron/rebuild` + `prebuild`/`prebuild-install` modules downloads prebuilds instead of compiling | [rebuild README](https://raw.githubusercontent.com/electron/rebuild/main/README.md): "electron-rebuild will run `prebuild-install` to download the correct binaries from the project's GitHub Releases instead of rebuilding them." (v13 no longer uses prebuild-install.) |
| **asar:** `.node` files must be unpacked | better-sqlite3 troubleshooting: "If you're using an app.asar bundle, be sure all native libraries are 'unpacked'." Electron [ASAR docs](https://www.electronjs.org/docs/latest/tutorial/asar-archives) list `process.dlopen - Used by require on native modules` among APIs that force Electron to "extract the needed file into a temporary file", and prescribe `asar pack app app.asar --unpack *.node` as the workaround (also notes AV scanners may be triggered by temp extraction). |
| electron-builder packaging knobs | [AsarOptions](https://www.electron.build/docs/api/app-builder-lib.interface.asaroptions/): `smartUnpack?` — "Whether to automatically unpack executables files." and `unpack?`. [Configuration](https://www.electron.build/docs/api/app-builder-lib.interface.configuration/): `nativeModules?: NativeModulesConfig` — "Groups all options that control how electron-builder handles native modules — from forcing source builds during install through to the `@electron/rebuild` compilation mode." ⚠️ The exact sub-option names were not enumerated in this session. For v13 the prebuild lives at `node_modules/better-sqlite3/prebuilds/*.node`, so an explicit `asarUnpack` for that path is the safe move. |
| Cross-arch builds | Prebuilds are per platform/arch; `win32-arm64.node` exists, so a Windows-arm64 build is covered, but any other target still compiles from source. |

**Practical recommendation:** keep `sandbox: true` + `contextIsolation: true`, put `better-sqlite3` in the main process only, pin Electron, and add a startup smoke test that actually opens the DB (this catches ABI/prebuild problems immediately instead of in the field). Prefer explicit `asarUnpack` over trusting `smartUnpack`.

---

## 2. Secure API-key storage: Electron `safeStorage` vs `keytar`

### Verdict
✅ **Use Electron's built-in `safeStorage`. `keytar` is archived and unmaintained** (last npm release 2022-02-17; repo archived 2022-12-12). ✅ `safeStorage` is a main-process Electron API with **no extra native dependency** — nothing to rebuild or unpack. ✅ On Windows it is DPAPI-backed and only usable after `app` is ready. ⚠️ **Use the async API where available**: Electron now recommends it and the sync API is on a deprecation path (open PRs, Sept 2026).

### Evidence

**safeStorage** ([docs](https://www.electronjs.org/docs/latest/api/safe-storage)) — `Process: Main`:
> "We recommend using the asynchronous API (`encryptStringAsync`/`decryptStringAsync`) over the synchronous API. The async API is non-blocking, supports key rotation, and handles temporary unavailability gracefully. **The synchronous API may be deprecated in a future version of Electron.**"

Windows security model:
> "Windows: Encryption keys are generated via **DPAPI**. As per the Windows documentation: 'Typically, only a user with the same logon credential as the user who encrypted the data can typically decrypt the data'. Therefore, content is protected from other users on the same machine, **but not from other apps running in the same userspace**."

`app.whenReady` requirement (Windows):
> `safeStorage.isEncryptionAvailable()` — "On Windows, returns true once the app has emitted the `ready` event."
> `isAsyncEncryptionAvailable()` — "The asynchronous encryptor is initialized lazily the first time this method, `encryptStringAsync`, or `decryptStringAsync` is called after the app is ready."

Signatures: `encryptString(plainText)` → `Buffer`, "will throw an error if encryption fails"; `decryptString(encrypted)` → `string`; `decryptStringAsync(encrypted)` → `Promise<{ shouldReEncrypt: boolean, result: string }>` — "whether data that has just been returned from the decrypt operation should be re-encrypted, as the key has been rotated…". `setUsePlainTextEncryption` is "a no-op on Windows and MacOS".

Async API is **new** — introduced by [PR #49054 "feat: introduce `os_crypt_async` in `safeStorage`"](https://github.com/electron/electron/pull/49054), created 2025-11-24, **merged 2026-02-15**, labels `semver/major`, `no-backport`. Deprecation of sync is in flight but **not merged** as of 2026-09-11: [PR #53670 "chore: deprecate synchronous safeStorage methods"](https://github.com/electron/electron/pull/53670) and [PR #53662 "chore!: remove synchronous safeStorage methods"](https://github.com/electron/electron/pull/53662), both created 2026-09-07, both **open**. ⚠️ Consequence: on an older Electron major you may only have the sync API — check your pinned version before coding against `encryptStringAsync`.

**keytar** — abandonment evidence:
- GitHub API `atom/node-keytar`: `archived = True`, `pushed_at = 2022-12-12`, 1,425 stars.
- npm registry: latest `7.9.0` published **2022-02-17**; `deprecated` field is **empty** — i.e. it is *not* npm-deprecated, it is simply **archived upstream with no release for ~4.5 years**.
- keytar 7.9.0 `package.json`: `"install": "prebuild-install || npm run build"`, `"prebuild-napi-x64": "prebuild -t 3 -r napi -a x64"`, `"binary": { "napi_versions": [3] }` — it *is* N-API-based, so its bundled N-API 3 prebuilds are ABI-stable and might still load on modern Electron. ❌ **UNVERIFIED**: I did not test keytar on current Electron, and there is no maintained release, issue triage, or security response.

**Other limitations worth knowing**
- DPAPI is a *per-user* boundary, not a same-user-app boundary: any other process running as the same user can in principle ask DPAPI to decrypt. Do not treat `safeStorage` as protection against malware running as the user.
- Non-Windows caveats (this app is Windows-first, but for portability planning): Linux falls back to a hardcoded plaintext password when no secret store exists (`getSelectedStorageBackend()` returns `basic_text`); macOS requires code signing for consistent behaviour ("Without a valid, consistent signature, macOS may not recognize different builds of your app as the same application, which can cause the Keychain to re-prompt the user for permission on every update").
- Practically: `safeStorage` must be called from the main process (it is a main-process module) — expose narrow `get/set secret` IPC instead of shipping the ciphertext to the renderer.

---

## 3. Transparent + click-through pet window on Windows 11

### Verdict
✅ Transparency + `setIgnoreMouseEvents(ignore, { forward: true })` are supported and documented for Windows. ❌ **Electron has no per-pixel click-through**: "You cannot click through the transparent area" is a documented, still-open limitation ([#1335](https://github.com/electron/electron/issues/1335), open since 2015-03-31, 105 comments, 155 reactions). So click-through-over-sprite = **your own hit-testing**. ⚠️ Forwarded-mouse reliability on Windows has **multiple open bugs as of 2026-09-11**; design a fallback.

### 3a. `setIgnoreMouseEvents(ignore, { forward: true })`

Official semantics ([browser-window.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/browser-window.md)):
> `win.setIgnoreMouseEvents(ignore[, options])` — `forward` boolean (optional) **_macOS_ _Windows_** — "If true, forwards mouse move messages to Chromium, enabling mouse related events such as `mouseleave`. **Only used when `ignore` is true.** If `ignore` is false, forwarding is always disabled regardless of this value."
> "Makes the window ignore all mouse events. All mouse events happened in this window will be passed to the window below this window, but if this window has focus, it will still receive keyboard events."

Note the platform tag: `forward` is **macOS + Windows only**, and it only forwards **mouse-move** messages (that is how you can still know where the cursor is).

**Open/known Windows problems (issue evidence):**

| Issue | State | Details |
|---|---|---|
| [#48035 "setIgnoreMouseEvents on Windows / Flickering Cursor"](https://github.com/electron/electron/issues/48035) | **OPEN**, `status/confirmed`, `platform/windows` | Created 2025-08-11; Electron 36.0.0, Win10/Win11; "Has been an issue since at least Electron v20"; 12 comments; older dupes #35414/#48036/#48037 closed. |
| [#49982 "setIgnoreMouseEvents causes mouseenter/mouseleave oscillation and stuck click-through after renderer crash + webContents.reload()"](https://github.com/electron/electron/issues/49982) | **OPEN**, `platform/windows` | Created 2026-02-28, Electron 38.8.4 on **Windows 11**. Oscillation + a *stuck* click-through state — directly relevant to a pet window. |
| [#52633 "fix: setIgnoreMouseEvents forward subclass invalidates after web content view change"](https://github.com/electron/electron/pull/52633) | **OPEN, NOT merged** | Created 2026-08-04: "Fixes #49982, Fixes #48035, Fixes #30808 (partially)… The original approach that was used to fetch the legacy window will never be updated after the actual legacy window has been updated." Merge status verified via the GitHub search API on 2026-09-11: `state=open`, `merged_at` empty. |
| [#52631 "fix: mouse stuck at hovered state in forward mode"](https://github.com/electron/electron/pull/52631) | **OPEN, NOT merged** | Created 2026-08-04 — the second half of the same fix set. Verified `state=open`, `merged_at` empty. |
| [#49682 "fix(native-window): prevent cursor flickering when setIgnoreMouseEvents forwards messages"](https://github.com/electron/electron/pull/49682) | **CLOSED, never merged** | Verified `state=closed`, `merged_at` empty → **no fix landed from this PR.** (An earlier draft of this report said "merged"; corrected.) |
| [#51418](https://github.com/electron/electron/pull/51418) / [#51419](https://github.com/electron/electron/pull/51419) "fix: preserve mouse hook handle when UnhookWindowsHookEx fails" | **MERGED 2026-04-30** | The one recent *merged* fix on the Windows forwarding path (mouse-hook handle handling). |
| [#53026 "docs: add UIPI note for setIgnoreMouseEvents forward option"](https://github.com/electron/electron/pull/53026) | **OPEN** (docs only) | Created 2026-08-19: "Mouse forwarding will stop working **temporary** if a window with higher privileges (integrity level) is the foreground window." → e.g. Task Manager / any elevated app focused kills forwarding until focus changes. |
| [#36372 "forwarding not working when a non electron app is focused"](https://github.com/electron/electron/issues/36372) | closed 2023-06-17 | 2022 report; historically fragile focus interactions. |
| [#40213](https://github.com/electron/electron/issues/40213) | closed 2023-10-18 | Wacom tablet driver broke `mousemove`/`mouseenter` with `forward: true`. |

**Bottom line for a pet:** `forward: true` is usable but **cannot be the only mechanism** — the Windows fixes for flicker and stuck-hover are still **unmerged PRs as of 2026-09-11**, forwarding pauses when an elevated window has focus (UIPI), and the forwarding subclass has been reported to go stale after web-content/UI changes.

### 3b. How to get click-through *except* over the pet sprite

Electron documents **no official pattern** — the only official statement is the negative one (see 3c). Three viable approaches, with the evidence for each:

1. **`win.setShape(rects)` — OS-level region hit-testing (Windows/Linux, _Experimental_).** ✅ Documented:
   > "Setting a window shape determines the area within the window where the system permits drawing and user interaction. **Outside of the given region, no pixels will be drawn and no mouse events will be registered.** Mouse events outside of the region will not be received by that window, but will fall through to whatever is behind the window." (passing an empty list reverts to a rectangle)
   Pros: real OS hit-testing, independent of `forward: true`. Cons: rectangle-list granularity (not per-pixel), experimental, and the region must be recomputed as the pet moves/animates.
2. **Toggle `setIgnoreMouseEvents` from the renderer based on pointer position** (community pattern): on `mousemove` in the renderer, decide whether the cursor is over the sprite (`document.elementFromPoint()` / canvas alpha test) and send an IPC message so the main process flips `setIgnoreMouseEvents(true|false)`. ⚠️ This relies on the same forwarded-mouse path flagged above; a real project's hardening is instructive — [`rullerzhou-afk/clawd-on-desk`](https://github.com/rullerzhou-afk/clawd-on-desk) (Electron, AGPL-3.0) keeps the big pet window click-through and overlays a **tiny opaque "hit window" over the hitbox** that receives all pointer events, routing everything through "pet-window-runtime's **single ignore-mouse writer** instead of … calling `hitWin.setIgnoreMouseEvents()` directly" (source comment, `src/main.js`).
3. **Poll `screen.getCursorScreenPoint()` in the main process** and compare against the sprite's rectangle, then flip the ignore state. ⚠️ **My recommendation, not a documented pattern**: it does not depend on forwarded mouse messages at all (immune to UIPI pause and forward-subclass invalidation), at the cost of a timer and a small latency. Combine with (1) or (2) rather than replacing them.

Note `app-region: drag` is *not* a click-through mechanism: the [Custom Window Interactions tutorial](https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/custom-window-interactions.md) says "draggable areas **ignore all pointer events**… Setting `app-region: no-drag` reenables pointer events by excluding a rectangular area".

### 3c. `transparent: true` caveats on Windows

Official limitations ([docs/tutorial/custom-window-styles.md](https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/custom-window-styles.md), "Transparent windows → Limitations"):
> "* You cannot click through the transparent area. See [#1335](https://github.com/electron/electron/issues/1335) for details.
> * **Transparent windows are not resizable.** Setting `resizable` to `true` may make a transparent window stop working on some platforms.
> * The CSS `blur()` filter only applies to the window's web contents… no way to apply blur effect to the content below the window.
> * **The window will not be transparent when DevTools is opened.**
> * On _Windows_: Transparent windows can not be maximized using the Windows system menu or by double clicking the title bar ([PR #28207](https://github.com/electron/electron/pull/28207))."

Option semantics ([base-window-options.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/structures/base-window-options.md)):
> `backgroundColor` — "Alpha in **#AARRGGBB** format is supported if `transparent` is set to `true`." → note the ordering: **alpha first** (Electron-specific), *not* CSS `#RRGGBBAA`. `'#00000000'` therefore works as fully transparent; `#00000000` in CSS order would also be transparent here, but a value like `#FF000080` means something different than a CSS author expects — be careful.
> `transparent` — "**On Windows, does not work unless the window is frameless.**"

Practical recipe implied by the docs: `frame: false` + `transparent: true` + `backgroundColor: '#00000000'` (or `#00xxxxxx`) + `resizable: false` + `skipTaskbar: true` + `alwaysOnTop: true`.

**⚠️ The Windows bug that will bite a pet: occlusion paint-throttling blanks the overlay during fullscreen games/video.** A real Electron pet project hit and documented this — [`OpenPetsHQ/openpets`](https://github.com/OpenPetsHQ/openpets) `apps/desktop/src/main.ts` (verified 2026-09-11):
> "Chromium's native window occlusion tracker treats every window on a display as occluded while a fullscreen app is active there and stops painting it. For transparent always-on-top pet windows that means **the pet goes blank during any fullscreen video or game even when its z-order is intact**. Occlusion-based paint throttling saves next to nothing for windows this small, so trade it away to keep the pet drawn."
> ```js
> if (process.platform === "win32") {
>   app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
> }
> ```
Note this is a community workaround (not an Electron doc), and it interacts with the fullscreen question in §5 — it is the strongest concrete reason to keep a "hide while fullscreen" policy rather than fighting for z-order.

**Community workaround for transparency + input:** `electron-transparency-mouse-fix` ("Click-through and drag&drop for transparent Electron windows", MIT) exists on npm, but its newest publish is **`1.0.0-rc.1` dated 2019-10-12** (registry metadata, 2026-09-11) — effectively unmaintained; do not adopt it as a dependency.

❌ **NOT verified in this session:** any current requirement to disable GPU acceleration (`--disable-gpu`) or a DirectComposition workaround for transparency on Windows 11 — I found no such statement in current Electron docs. Historically-reported "black instead of transparent" issues were not re-confirmed here; treat any such advice as version-specific folklore until reproduced on your target Electron + Windows 11 build.

---

## 4. Screen-capture exclusion — `win.setContentProtection(true)`

### Verdict
✅ **Confirmed and correctly implemented**: on Windows Electron calls `SetWindowDisplayAffinity` with **`WDA_EXCLUDEFROMCAPTURE`**, and on Windows 10 2004+ (which includes Windows 11) "the window will be removed from capture entirely". ✅ It is **not** a security guarantee — Microsoft says so explicitly.

### Evidence

Electron docs ([browser-window.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/browser-window.md)):
> `win.setContentProtection(enable)` **_macOS_ _Windows_** — "Prevents the window contents from being captured by other apps.
> On Windows, it calls `SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`. **For Windows 10 version 2004 and up the window will be removed from capture entirely**, older Windows versions behave as if `WDA_MONITOR` is applied capturing a black window.
> On macOS, it sets the `NSWindow`'s `sharingType`…"

Implementation chain verified in source:
1. **Electron** `shell/browser/native_window_views.cc` ([raw](https://raw.githubusercontent.com/electron/electron/main/shell/browser/native_window_views.cc)):
   ```cpp
   void NativeWindowViews::SetContentProtection(const bool enable) {
   #if BUILDFLAG(IS_WIN)
     content_protected_ = enable;
     widget()->SetExcludeFromScreenCapture(enable);
   #endif
   }
   ```
2. **Chromium** `ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc` ([raw](https://raw.githubusercontent.com/chromium/chromium/main/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc)) — the OS-version switch:
   ```cpp
   // Returns the display affinity value to use for excluding a window from screen
   // capture, based on the Windows OS version.
   DWORD GetExclusionAffinity() {
     return (base::win::GetVersion() >= base::win::Version::WIN10_20H1)
         ? WDA_EXCLUDEFROMCAPTURE
         : WDA_MONITOR;
   }
   ```
   Same file, timing caveat inside `DesktopWindowTreeHostWin::SetAllowScreenshots`: "**If the window is not visible, do not set the window display affinity because `SetWindowDisplayAffinity` will attempt to compose the window, resulting in a blank window.** Instead, we will update it in the `Show` function." → apply protection **after** the window is shown, or at least be aware it is deferred until Show.
3. **Microsoft** [`SetWindowDisplayAffinity`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity):
   - `WDA_EXCLUDEFROMCAPTURE` = `0x00000011` — "The window is displayed only on a monitor. **Everywhere else, the window does not appear at all.**" Introduced in Windows 10 Version 2004.
   - `WDA_MONITOR` = `0x00000001` — "Everywhere else, the window appears with no content" (i.e. black).
   - "Setting the display affinity to `WDA_EXCLUDEFROMCAPTURE` on previous version of Windows will behave as if `WDA_MONITOR` is applied."
   - "**it works only when the Desktop Window Manager (DWM) is composing the desktop**"
   - "unlike a security feature or an implementation of Digital Rights Management (DRM), **there is no guarantee** that using `SetWindowDisplayAffinity` … will strictly protect windowed content, for example where someone takes a **photograph of the screen**."

### Caveats
- ✅ **There is an open, maintainer-confirmed regression:** [#47834 "`BrowserWindow` with `setContentProtection(true)` captured on some Windows OSs"](https://github.com/electron/electron/issues/47834) — **OPEN**, labels `platform/windows`, `bug`, `bug/regression`, `status/confirmed`, `component/BrowserWindow`, `36-x-y`, `38-x-y`, `has-repro-gist`. Reported 2025-07-20 against **Electron 36.3.2 on Windows 10 Pro 19045**, with "Last Known Working Electron version: **36.3.1**" — i.e. content protection stopped working in a patch release, and the reporter notes it does **not** reproduce in Chrome. The report is Windows-10-specific; ❌ I could not confirm whether it affects Windows 11 or whether it is fixed in current releases — **test on your exact target OS build**.
- ✅ Window visibility timing matters, exactly as Chromium's comment implies: [#29085 "[Bug]: setContentProtection issue after hiding and showing the BrowserWindow"](https://github.com/electron/electron/issues/29085) (created 2021-05-10, closed 2021-10-11, Electron 12.x). Practical rule: set content protection **after** `win.show()`, and re-assert it if you hide/show the window.
- Protection is per top-level window and requires DWM composition; a non-top-level window fails (`SetWindowDisplayAffinity` "returns FALSE when, for example, the function call is made on a non top-level window").
- ❌ Individual capture tools (OBS display capture, Snipping Tool, PrintScreen, DXGI duplication, third-party recorders) were **not** tested here; neither Electron's docs nor MS Learn enumerate per-tool behaviour beyond "removed from capture entirely" on Win10 2004+. Do not claim blanket coverage — and note that a camera/phone defeats it by definition.
- For a pet window the effect is that the pet simply won't appear in recordings/screenshots — which may be desirable (privacy) or confusing to users; make it an explicit setting.

---

## 5. Fullscreen detection & multi-monitor DPI

### Verdict
✅ Electron's `screen` module gives you **DIP-based, DPI-aware display geometry and cursor position** — no manual `GetDpiForMonitor`/`EnumDisplayMonitors` + Per-Monitor-V2 plumbing. ✅ It also exposes `screenToDipPoint`/`dipToScreenPoint` and (Windows-only) rect converters for crossing the physical↔DIP boundary. ❌ **Electron cannot tell you that *another* application is fullscreen** — there is no such API; `win.isFullScreen()` only reports *your own* window. Fullscreen detection is a heuristic you build.

### 5a. What the `screen` module gives you

[screen.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/screen.md) — **`Process: Main`**:
> "**This module cannot be used until the `ready` event of the `app` module is emitted.**" (And: "In the renderer / DevTools, `window.screen` is a reserved DOM property, so writing `let { screen } = require('electron')` will not work.")

Coordinate model:
> "There are two kinds of coordinates available to the process:
> • **Physical screen points** are raw hardware pixels on a display.
> • **Device-independent pixel (DIP) points** are virtualized screen points scaled based on the DPI (dots per inch) of the display."

Methods relevant to a pet:
- `screen.getCursorScreenPoint()` — "The current absolute position of the mouse pointer." + "**The return value is a DIP point, not a screen physical point.**" (Not supported on Wayland — irrelevant on Windows.)
- `screen.getPrimaryDisplay()`, `screen.getAllDisplays()`, `screen.getDisplayNearestPoint(point)` — "The display nearest the specified point.", `screen.getDisplayMatching(rect)` — "The display that most closely intersects the provided bounds."
- `screen.screenToDipPoint(point)` / `screen.dipToScreenPoint(point)` — _Windows_ _Linux_ — "Converts a screen physical point to a screen DIP point. The DPI scale is performed relative to the display containing the physical point."
- `screen.screenToDipRect(window, rect)` / `screen.dipToScreenRect(window, rect)` — **_Windows_** — rect versions; "The DPI scale is performed relative to the display nearest to `window`."

Events (all present): `display-added`, `display-removed`, `display-metrics-changed` — the last "Emitted when one or more metrics change in a `display`. The `changedMetrics` is an array of strings… Possible changes are `bounds`, `workArea`, `scaleFactor` and `rotation`."

[Display object](https://raw.githubusercontent.com/electron/electron/main/docs/api/structures/display.md):
> `bounds` — "the bounds of the display **in DIP points**."
> `workArea` — "the work area of the display **in DIP points**." / `workAreaSize` — "The size of the work area."
> `scaleFactor` — "Output device's pixel scale factor."
> `nativeOrigin` — "Returns the display's origin in **pixel** coordinates. Only available on windowing systems like X11 that position displays in pixel coordinates." → **not on Windows**; on Windows treat `bounds` as DIP and use `dipToScreenRect` when you need physical pixels.
Plus `id`, `label`, `internal`, `rotation`, `touchSupport`, `colorDepth`, `colorSpace`, `depthPerComponent`, `displayFrequency`, `accelerometerSupport`, `monochrome`, `maximumCursorSize`, `size`.

### 5b. Fullscreen detection — what Electron does *not* have

- `win.isFullScreen()` — "Returns `boolean` - Whether the window is in fullscreen mode." ([browser-window.md](https://raw.githubusercontent.com/electron/electron/main/docs/api/browser-window.md)); plus the window's own `enter-full-screen` / `leave-full-screen` events. **This is your own window only.**
- ❌ The `screen` module documents **no** API that reports another process's fullscreen state. The only related signals are the display/geometry ones above. (Verified by enumeration, not by a doc denial: the screen binding table exposes only the 10 methods listed above, `BrowserWindow.getFocusedWindow()` is explicitly scoped "in this application", and `desktopCapturer`'s source object exposes only `id`/`name`/`thumbnail`/`display_id`/`appIcon` — no bounds or fullscreen field.)
- ⚠️ **The popular `workArea == bounds` "fullscreen" heuristic is NOT documented anywhere and should be treated as unverified.** Microsoft defines a monitor's work area (`MONITORINFO.rcWork`) as the monitor rectangle minus **shell UI** (taskbar/appbars) — *not* minus other applications' windows. I found no source stating that a fullscreen app changes `workArea`. It may still be a useful *signal* (a fullscreen app usually hides the taskbar, which does change the work area and fires `display-metrics-changed`), but validate it on real fullscreen games/browsers before depending on it. (Historical note: [#6312](https://github.com/electron/electron/issues/6312), Electron 1.x, reported work area *and* `display-metrics-changed` ignoring taskbar moves — long closed, but an illustration that this signal is shell-driven.)
- ✅ The actual Win32 answer for "is a full-screen application running" is [`SHQueryUserNotificationState`](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state): `QUNS_BUSY` = "A full-screen application is running or Presentation Settings are applied"; `QUNS_RUNNING_D3D_FULL_SCREEN` = "A full-screen (exclusive mode) Direct3D application is running." Electron does not surface it, it is **system-global (not per-display)**, and it requires native code — but it is the only authoritative primitive here.

### 5c. Mixed-DPI / `scaleFactor` issues (this is the sharp edge)

✅ Documented constraint: only use `screen` after `app` ready (5a). ✅ Because `bounds`/`workArea`/`getCursorScreenPoint` are **DIP**, a window positioned with DIP coordinates on a 150% display lands correctly — the main win over raw Win32.

⚠️ **Electron ships Per-Monitor **V1** DPI awareness, not V2 — do not describe it as PerMonitorV2.** Verified: `shell/browser/resources/win/dpi_aware.manifest` at tag **v44.3.0** contains only `<dpiAware>true/pm</dpiAware>` (no `<dpiAwareness>` element, no `gdiScaling`). The PR that would have added PerMonitorV2 ([#48468 "fix(windows): reduce blurriness on mixed-DPI displays by enabling Per…"](https://github.com/electron/electron/pull/48468)) is **CLOSED and was not merged** (verified from the PR page on 2026-09-11). Microsoft's own guidance is that PMv1 "is very limited" and recommends PMv2 — so expect known mixed-DPI rough edges to persist.

⚠️ **You cannot recover the true monitor DPI ratio from `Display.scaleFactor` on Windows.** `scaleFactor` maps to Chromium's `device_scale_factor()`, and Chromium documents that the *text scale multiplier* is folded into it ([`ui/display/display.h`](https://raw.githubusercontent.com/chromium/chromium/main/ui/display/display.h)):
> "This value is also expected to be factored into the **device_scale_factor**. For example, if the user has selected a 1.5x text size, and the actual native device scale factor is 2.0x, then this value is expected to be 1.5, and the device_scale_factor is expected to be 1.5x2.0=3.0."

Electron exposes no text-scale field, and this is tracked as an open issue: [#47057 "`Display.scaleFactor` should NOT equal textScaleFactor × monitorScaleFactor on Windows"](https://github.com/electron/electron/issues/47057) — **OPEN** (verified 2026-09-11; Electron 35.0.0, Windows 10/11). **Do not size pet sprites from `scaleFactor`**; if you need a real ratio, measure it (e.g. compare `dipToScreenPoint` geometry) or query DPI natively.

Open mixed-DPI window-geometry issues (all verified **OPEN** on 2026-09-11 via the GitHub issue pages):

| Issue | Title | Note |
|---|---|---|
| [#10862](https://github.com/electron/electron/issues/10862) | "Per monitor DPI awareness causes issues with window positioning and sizing" | The canonical mixed-DPI issue — **open since 2017-10-20**, ~71 comments. Reported: with one monitor at non-100% and another at 100%, `setSize`/`setPosition` set values "incorrectly by a factor exactly equal to the scale factor of the screen". |
| [#27651](https://github.com/electron/electron/issues/27651) | "[Bug]: setBounds make BrowserWindows larger every time on Windows" | `status/confirmed`; window grows on repeated `setBounds` calls. |
| [#52208](https://github.com/electron/electron/issues/52208) | "titleBarOverlay height resolves incorrectly after Windows DPI scaling" | Electron 43.0.0. |
| [#47649](https://github.com/electron/electron/issues/47649) | "Unique and persistent ID for Display" | Says `Display.id` is unique but **not persistent across reboots** (reporter's assertion — the docs are silent). Persisting "pet lives on monitor X" needs a PnP device path from native code. |

⚠️ Recommendation (**my analysis**, not a documented pattern): given PMv1 + open #10862/#27651, **do not build the pet's positioning around programmatic cross-monitor `setBounds`**. Prefer `getDisplayNearestPoint(getCursorScreenPoint())` / `getAllDisplays()` to choose a monitor, place the window with DIP coordinates, and re-query on `display-metrics-changed` + your window's `moved`/`resized` events rather than caching geometry.

---

## 6. Real open-source desktop pet projects (design references)

Requirements: actively maintained, at least one Chinese-language project, and a clear license split. **All metadata below was observed on 2026-09-11.** Companion detail file: `docs/desktop-pet-design-references.md`.

| Repo | Stack | License (SPDX) | Stars | Last push |
|---|---|---|---|---|
| [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) 🇨🇳 | Tauri v2 + Rust + Vue 3/TS | **MIT** | 23,084 | **2026-09-11** |
| [OpenPetsHQ/openpets](https://github.com/OpenPetsHQ/openpets) | **Electron + TypeScript** (pnpm monorepo, React/Vite renderer) | **MIT** | 1,184 | 2026-09-05 |
| [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) | Electron + JavaScript | **AGPL-3.0** | 6,202 | **2026-09-11** |
| [ChaozhongLiu/DyberPet](https://github.com/ChaozhongLiu/DyberPet) 🇨🇳 | Python 3 + PySide6 (Qt) | **GPL-3.0** | 972 | 2026-08-15 |
| [zenghongtu/PPet](https://github.com/zenghongtu/PPet) 🇨🇳 *(stale)* | Electron + TS + React + Live2D | **MIT** | 2,032 | 2024-06-18 |

### Details

**1. `ayangweb/BongoCat` — best *feature/UX* checklist (Chinese, Tauri, MIT).**
API: `language=Vue`, `license.spdx_id=MIT`, stars 23,084, `pushed_at` 2026-09-11, created 2025-03-28, `archived=false`. Stack from `package.json` (v1.1.0): `@tauri-apps/api ^2.10.1`, `vue ^3.5.32`, **`pixi.js ^8.18.1`, `easy-live2d ^0.4.4`**; `src-tauri/tauri.conf.json` declares Tauri v2 schema. Confirmed window flags (tauri.conf.json, `main` window): `transparent: true`, `decorations: false`, `shadow: false`, `alwaysOnTop: true`, `skipTaskbar: true` + a second hidden `preference` window. Tray in `src/composables/useTray.ts` (`TrayIcon` id `BONGO_CAT_TRAY`, menu rebuilt reactively on window state incl. `window.passThrough`). Pass-through exists as a **store field** (`src/stores/cat.ts`), but the OS-level ignore-cursor call site was **UNVERIFIED**. No AI chat observed. ⚠️ It is **not Electron** — borrow the design, not the plumbing.

**2. `OpenPetsHQ/openpets` — best *Electron/TS architecture* reference (MIT).**
Root `package.json`: `"license": "MIT"`, pnpm workspace, `apps/desktop` v3.5.0, `engines.node >=20`; Electron + TypeScript with electron-builder. Confirmed from its docs/source: tray-first desktop companion; **separate transparent pet windows vs Control Center vs plugin panels**; a plugin SDK (permissions/quotas, sandboxed JS, host-rendered UI); reaction→sprite-animation mapping; a motion module; and an explicitly documented **Chromium occlusion-paint-throttling problem for "transparent always-on-top pet windows"** (their `main.ts` comment notes the pet "goes blank during any fullscreen video or game even when its z-order is intact") — that is a concrete bug an Electron pet will hit. ⚠️ **UNVERIFIED:** Live2D usage and the exact click-through call site; the `package.json` repository URL points at `alvinunreal/openpets` while the canonical name is `OpenPetsHQ/openpets` (likely an org move).

**3. `rullerzhou-afk/clawd-on-desk` — best *click-through/topmost hardening* reference (AGPL-3.0 ⚠️ design only).**
`package.json` (v1.0.0): "A desktop pet that reacts to your Claude Code sessions in real-time."; `LICENSE` = **GNU Affero GPL v3**. Electron + JS, electron-builder targets (win nsis x64/arm64, mac dmg, linux AppImage/deb). Observed in `src/main.js`: `alwaysOnTop: true`, `frame: false`, `transparent: true`, `skipTaskbar: true`; a **tiny opaque `hitWin`** over the hitbox "receives all pointer events" while the big window stays click-through, with a **single centralized ignore-mouse writer**; explicit topmost re-assertion (`reassertWinTopmost()`), taskbar keep-out, and fullscreen auto-hide override. Feature loop: it watches Claude Code/Codex/Cursor sessions and animates the pet accordingly.

**4. `ChaozhongLiu/DyberPet` — best *"pet as platform"* reference (Chinese, GPL-3.0 ⚠️ design only).**
`README.md` is Chinese-first (呆啵宠物 DyberPet, "让喜欢的角色住进桌面，模组自由，AI 相伴"); `LICENSE` = **GNU GPL v3, Copyright (C) 2022 Chaozhong Liu**. Python + PySide6. Confirmed: frameless + translucent + always-on-top overlay (`Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.SubWindow`, `WA_TranslucentBackground`), system tray, drag/throw physics, JSON-driven characters/items, dashboard window separate from the pet overlay, speech-bubble manager. Note: its README states the LLM module is **not fully open source** ("LLM 模块仍在持续开发中，相关能力暂未完全开源").

**5. `zenghongtu/PPet` — historical Electron+Live2D reference only (Chinese, MIT, stale).**
API: MIT, stars 2,032, `pushed_at` 2024-06-18 (~2 years stale), `archived=false`, topics include `electron`, `live2d`, `live2dv3`, `react`, `vite`. `master` branch `package.json` pins a **very old Electron 7.1.2 / electron-builder 21**; the maintained work sits on another branch (reported as `dev`, Electron 16). README confirms Live2D model import (`model.json` with `model`/`textures`/`motions`), a plugin center, and a tray. Nice reading for *how the pieces fit*; not a dependency baseline.

### License implications for a proprietary app

| | Projects | Can you copy code? |
|---|---|---|
| **Permissive (MIT)** | BongoCat, openpets, PPet | ✅ Yes, with copyright/license notice preserved. Still write your own code where the reference is a different stack (Tauri/Qt). |
| **GPL-3.0** | DyberPet | ❌ No — copyleft; study for design only. |
| **AGPL-3.0** | clawd-on-desk | ❌ No — strongest copyleft (network use triggers source disclosure); design only. |
| **No license detected** | `Adrianotiger/desktopPet` (C#, 1,144 stars, pushed 2026-09-09 — GitHub API reports **no** license) | ❌ Treat as all-rights-reserved; do not copy. |

Blunt version: **read GPL/AGPL projects to learn architecture, window-flag recipes and UX, then write your own implementation.** Separately, the **Live2D Cubism SDK and individual Live2D models carry their own proprietary licenses, independent of the app's license** — ❌ not verified in this session, but check before shipping any Live2D content commercially.

---

## Explicitly NOT verified (no guessing)

1. ❌ That `better-sqlite3` v13's bundled N-API prebuild **actually loads** in Electron 43/44 without `@electron/rebuild` — the maintainer says "should theoretically work"; Electron's own docs still say native modules must be rebuilt. Needs a 10-minute local smoke test on the pinned versions.
2. ❌ Whether `@electron/rebuild` ignores N-API/prebuilt modules by default (user-reported that it does not; the README only documents `--only`).
3. ❌ Whether `keytar` still functions on current Electron (it is N-API 3, but unmaintained) — and any official Electron recommendation of one package over the other (Electron's `safeStorage` docs never mention keytar).
4. ❌ Any requirement to disable GPU acceleration / DirectComposition workarounds for transparency on **Windows 11** with current Electron; also no reproduced "black background" case on Win11.
5. ❌ Per-tool behaviour of `setContentProtection` against OBS, Snipping Tool, DXGI desktop duplication, or third-party recorders.
6. ⚠️ Mixed-DPI `scaleFactor` issues **were** confirmed (see 5c: #47057, #10862, #27651, #52208, #47649, and the Per-Monitor-V1 manifest). Still unverified: whether a fullscreen app actually changes `workArea`; whether `display-metrics-changed` reliably fires for **scaleFactor-only** changes on current Windows versions; and whether `Display.id` really is non-persistent across reboots (reporter assertion only).
7. ❌ electron-builder `NativeModulesConfig` sub-option names (`buildDependenciesFromSource`, `npmRebuild`, `nodeGypRebuild`) — the interface page was fetched but only the group description was read.
8. ❌ The exact OS-level click-through API call site in `BongoCat` (`setIgnoreCursorEvents`) and in `openpets`.

## Source index

**Electron docs:** [Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox) · [Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) · [ASAR Archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives) · [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) · [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) · [base-window-options](https://www.electronjs.org/docs/latest/api/structures/base-window-options) · [Custom Window Styles (transparency limitations)](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles) · [Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) · [screen](https://www.electronjs.org/docs/latest/api/screen) · [Display](https://www.electronjs.org/docs/latest/api/structures/display) · [Electron timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
**Electron source/issues:** [native_window_views.cc](https://raw.githubusercontent.com/electron/electron/main/shell/browser/native_window_views.cc) · [#1335 click-through (open)](https://github.com/electron/electron/issues/1335) · [#48035 cursor flicker (open)](https://github.com/electron/electron/issues/48035) · [#49982 oscillation/stuck (open)](https://github.com/electron/electron/issues/49982) · [#52633 pending fix](https://github.com/electron/electron/pull/52633) · [#53026 UIPI note](https://github.com/electron/electron/pull/53026) · [#49682 flicker fix](https://github.com/electron/electron/issues/49682) · [#36372](https://github.com/electron/electron/issues/36372) · [#40213](https://github.com/electron/electron/issues/40213) · [#49054 async safeStorage](https://github.com/electron/electron/pull/49054) · [#53670](https://github.com/electron/electron/pull/53670) / [#53662](https://github.com/electron/electron/pull/53662) sync deprecation (open) · [v44.0.0 release notes](https://github.com/electron/electron/releases/tag/v44.0.0)
**better-sqlite3:** [v13.0.0 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0) · [troubleshooting](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/troubleshooting.md) · [#1503 install regression](https://github.com/WiseLibs/better-sqlite3/issues/1503) · [#1481 npm RFC #868](https://github.com/WiseLibs/better-sqlite3/issues/1481) · [npm tarball 13.0.3](https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz) (inspected locally)
**Other:** [keytar repo (archived)](https://github.com/atom/node-keytar) · [keytar on npm](https://registry.npmjs.org/keytar) · [Node-API docs & version matrix](https://nodejs.org/api/n-api.html) · [MS Learn SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity) · [Chromium desktop_window_tree_host_win.cc](https://raw.githubusercontent.com/chromium/chromium/main/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc) · [@electron/rebuild README](https://raw.githubusercontent.com/electron/rebuild/main/README.md) · [electron-builder AsarOptions](https://www.electron.build/docs/api/app-builder-lib.interface.asaroptions/) / [Configuration](https://www.electron.build/docs/api/app-builder-lib.interface.configuration/)
**Pet projects:** [BongoCat](https://github.com/ayangweb/BongoCat) · [openpets](https://github.com/OpenPetsHQ/openpets) · [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) · [DyberPet](https://github.com/ChaozhongLiu/DyberPet) · [PPet](https://github.com/zenghongtu/PPet)
