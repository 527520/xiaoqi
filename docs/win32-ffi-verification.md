# Win32-from-Electron Verification Report

**Scope:** de-risking an Electron 44.x desktop-pet app on Windows 11 (build 26200) that must auto-silence
during fullscreen games/video, and must do click-through window shaping.

**Verification date:** 2026-09-11
**Method note:** `web_fetch` is **broken in this environment for every host** — every URL returns
`Error: URL hostname "<host>" resolves to a non-public IP address` (DNS fake-IP). The `web_search`
tool works. All primary sources below were retrieved with `pwsh` + `Invoke-RestMethod` /
`Invoke-WebRequest` against `registry.npmjs.org`, `api.github.com`, `raw.githubusercontent.com`,
`releases.electronjs.org`, `docs.npmjs.com`, `learn.microsoft.com`, `koffi.dev`.

## Verification environment (the strongest evidence here is empirical)

| Item | Value |
|---|---|
| OS | Windows 11 build **26200** (25H2) |
| System Node | v24.15.0, npm 11.12.1, x64 |
| **C++ compiler present** | **NONE** — `cl.exe`, `gcc.exe`, `clang.exe`, `link.exe`, `vswhere.exe` all absent; no VS/Build Tools |
| Electron used for testing | **44.3.0** → Node **24.20.0**, Chromium **152.0.7977.78**, `process.versions.modules` = **149**, `napi` = **10** |
| koffi tested | 3.2.1, both on bare Node 24.15.0 **and inside the Electron 44.3.0 main process** |

Because no compiler exists on this machine, any package that installs and runs successfully here
**provably requires no C++ toolchain**.

---

## 1. koffi — VERDICT: ✅ USE IT. All claims confirmed.

### Maintenance / release cadence
* **Actively maintained — YES.** Latest **3.2.1**, published **2026-09-04** (`registry.npmjs.org/koffi`
  `time` field). 282 published versions since 2022-02-23; 12 releases in the last ~6 months
  (3.0.0 on 2026-05-16 → 3.2.1 on 2026-09-04). A `2.16.3` maintenance line is even still backported.
* GitHub `Koromix/koffi`: **414 stars, 28 open issues, last push 2026-09-04**, MIT, not archived.

### Prebuilt win32-x64 binaries — CONFIRMED FROM TARBALL CONTENTS
The `koffi` package itself ships **no** binary. It declares **18 platform `optionalDependencies`**
named `@koromix/koffi-<platform>-<arch>`. I downloaded and extracted both tarballs:

* `@koromix/koffi-win32-x64@3.2.1` (published 2026-09-04) contains exactly 5 files:
  * **`win32_x64/koffi.node` — 1,036,800 bytes**
  * `index.js` = `module.exports = require('./win32_x64/koffi.node')`
  * `package.json` with `"os": ["win32"], "cpu": ["x64"]`, **no scripts**
* PE inspection of `koffi.node`: `MZ` / `PE` signature, **machine `0x8664` (x64)**, exports
  `napi_register_module_v1` and `node_api_module_get_api_version_v1`, and contains **no
  `NODE_MODULE_VERSION` string** → it is a genuine **Node-API (N-API)** addon, not an
  ABI-versioned addon.
* Loader logic (`src/koffi/src/static.cjs`) is `require('@koromix/koffi-win32-x64')` for
  `win32-x64`; `src/koffi/index.cjs` does `loadStatic(pkg) ?? loadDynamic(...)`.

### No compiler required — PROVEN EMPIRICALLY
```
npm install koffi@3.2.1     →  exit 0, "added 2 packages in 784ms"
                              (koffi + @koromix/koffi-win32-x64)
```
koffi's only script is `install: node ./cnoke.cjs -P . -D src/koffi --prebuild --release`.
`--prebuild` means "use prebuilt binary if available", so it exits 0 without invoking CMake/Clang.
On a machine with **no MSVC at all**, install succeeded and the module loaded.

### Node-API version / Electron ABI / electron-rebuild
* `koffi/package.json` → `"cnoke": { "node": 16, "napi": 8 }` ⇒ **requires Node-API ≥ 8**.
* The loader throws a clear error if `process.versions.napi < 8`.
* Electron 44.3.0 reports `napi = 10` ⇒ satisfied.
* **`electron-rebuild` is NOT required.** N-API is ABI-stable across Node and Electron versions;
  `process.versions.modules` (149 in Electron 44) is irrelevant to N-API addons. No `.node`
  recompilation step is needed at any point.
* **End-to-end proof inside Electron** (`electron.exe` v44.3.0 main process, no rebuild step):
  ```
  koffi.version  = 3.2.1
  versions: electron=44.3.0 chrome=152.0.7977.78 node=24.20.0 napi=10 modules=149
  SHQueryUserNotificationState -> hr=0  state=5
  GetLastInputInfo -> ok=true  cbSize=8  idleMs=31
  DONE
  ```

### Calling the two required Win32 APIs — VERIFIED WORKING
Both APIs work from koffi, on bare Node 24.15.0 **and** inside Electron 44.3.0:

```js
// QUNS
const shell32 = koffi.load('shell32.dll');
const SHQueryUserNotificationState =
  shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int *peState)');
const st = [0];
const hr = SHQueryUserNotificationState(st);   // hr = 0 (S_OK), st[0] = 5

// Idle time — NOTE: must be _Inout_, not _Out_
const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });
const GetLastInputInfo =
  koffi.load('user32.dll').func('bool __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *plii)');
const lii = { cbSize: koffi.sizeof(LASTINPUTINFO), dwTime: 0 };
const ok = GetLastInputInfo(lii);              // ok = true, cbSize = 8
```
Struct layout verified: `sizeof(LASTINPUTINFO) = 8`, `alignof = 4`, `offsetof(dwTime) = 4` — correct.
Control test: passing `cbSize: 4` makes `GetLastInputInfo` return `false`, proving the struct is
really marshalled in/out (not silently ignored).

**Documented gotcha (this is the one real trap):** `GetLastInputInfo` **must** be declared `_Inout_`.
With `_Out_` the call returns `false` and `cbSize` reads back as `0`.
* koffi issue **#227** "Having problem with GetLastInputInfo and output structure"
  (opened & closed 2025-03-12, `completed`). Author Koromix: *"You need to use `_Inout_` for the
  GetLastInputInfo() parameter: the cbSize must be copied in, and then the entire struct must be
  copied out."*
* Officially documented at **https://koffi.dev/output** — *"In order to use these functions in
  Koffi, you must define the parameter as `_Inout_` … An example of such a function is
  `GetLastInputInfo()`."*

**Calling conventions:** `__stdcall` is accepted and is a **no-op on x64** — koffi's `doc/load.md`
states the two declaration forms are equivalent and *"use stdcall on x86 (and the default ABI on
other platforms)"*. I also confirmed the call works with **no** calling-convention qualifier at all
on x64. No `__cdecl`/mangling problems for these two APIs.

**Other verified gotchas:**
* `CreateRectRgn` is **not** in `user32.dll` — koffi correctly errors
  `Cannot find function 'CreateRectRgn' in shared library`. It lives in **`gdi32.dll`** (confirmed:
  resolving it from `gdi32.dll` succeeds, as does `CreateRoundRectRgn`).
* `SetWindowRgn`, `GetWindowRgn`, `SetWindowLongPtrW`, `SetLayeredWindowAttributes`,
  `SetWindowDisplayAffinity` all resolve from `user32.dll` via koffi.
* `GetTickCount64()` returned a plain JS **`number`** (not BigInt) in koffi 3.2.1; `uint32` values
  also come back as `number`. Don't blindly wrap in `BigInt()`.

### Known issues to be aware of
* **Regression window — avoid koffi 3.1.3 and 3.1.4 on win32-x64.** Issue **#275**
  "win32-x64 prebuilt binary crashes (access violation) since 3.1.3 — 3.1.2 works, regression
  matches Clang cross-compile switch" (2026-08-13, closed `completed` 2026-08-20). The maintainer
  could not reproduce but shipped **3.1.5** as the fix; the reporter confirmed 3.1.5 fixed other
  projects. **3.2.1 (current) verified working here** — including clean process exit.
* **Electron bundling:** issue **#224** "electron-forge example fails with `Cannot find the native
  Koffi module; did you bundle it correctly?`" (closed 2025-02-13). Cause was webpack module
  caching on dev-server restart; fix is to mark koffi as an **external**:
  `externals: { koffi: "commonjs koffi" }`. Relevant only if you bundle the main process with
  webpack/vite. For electron-builder + asar, see §5 (auto-unpacked).
* Electron-forge/Vite (#233) and a Windows-10 "Failed to load share library" report (#203) exist,
  both closed.

---

## 2. Alternatives to koffi — RANKED

| Rank | Option | Maintained? | Compiler needed? | Works on Electron 44? | Verdict |
|---|---|---|---|---|---|
| **1** | **`koffi` 3.2.1** | ✅ Yes (2026-09-04) | ❌ **No** — proven | ✅ **Proven in-process** | **Use this** |
| 2 | `node-ffi-rs` 1.3.7 | ✅ Yes (2026-08-09) | ❌ No — proven | ⚠️ Not tested; plausible | Credible fallback |
| 3 | spawn PowerShell + `Add-Type` P/Invoke | ✅ (ships with Windows) | ❌ No | ✅ Works (proven on Node; not in Electron) | Emergency fallback only |
| 4 | `ffi-napi` 4.0.3 | ❌ **Abandoned** | ✅ **Yes — install FAILS** | ❌ No | **Do not use** |
| 5 | `@lwahonen/ffi-napi` 4.0.12 | ❌ No (2023) | ✅ **Yes — no Windows prebuild** | ❌ No | **Do not use** |
| — | Pure-JS registry/WMI | n/a | ❌ No | n/a | **Impossible** (see below) |

### (a) `ffi-napi` / `node-ffi-napi` — ABANDONED, and it does not install
* npm: latest **4.0.3, published 2021-03-18** (~5.5 years old). 19 versions total; last metadata
  change 2022-05-02. `engines: node >= 10`.
* GitHub `node-ffi-napi/node-ffi-napi`: **165 open issues**, last push **2024-08-16**, 1095 stars.
* It *does* ship prebuilds — I extracted the tarball and found
  `prebuilds/win32-x64/node.napi.uv1.node` (602,112 bytes).
* **But installing it fails on a compiler-less Windows machine.** I ran it:
  ```
  npm install ffi-napi@4.0.3   →  EXIT 1
  gyp ERR! find VS Could not find any Visual Studio installation to use
  gyp ERR! command "...node-gyp.js" "rebuild"
  ```
  npm's debug log shows npm ran ffi-napi's **own declared** script (`install: node-gyp-build`,
  not an npm-injected one), and `node-gyp-build` fell back to `node-gyp rebuild`.
  Mechanically: `node-gyp-build/bin.js` runs `node-gyp-build-test`; if that probe fails it calls
  `build()` → `node-gyp rebuild`. (Interestingly, `node-gyp-build`'s resolver *does* find and
  return that prebuild path, and the `.node` file *does* `dlopen` successfully in isolation on
  Node 24 — so the failure is in the install-time probe/context, not provably the binary's ABI.
  Either way, **the install hard-fails without MSVC**, which is disqualifying.)
  Koffi has no such probe-and-fallback: its prebuilt comes from a dependency package with no
  scripts at all.

### (b) `@lwahonen/ffi-napi` — no Windows prebuild at all
* npm: latest **4.0.12**, published **2023-03-01**. It is the **only version ever published**.
* Extracted tarball: `prebuilds/` contains **`darwin-arm64`, `darwin-x64`, `linux-arm64`,
  `linux-x64` only — there is no `win32-*` directory and no Windows binary.** It also ships
  `binding.gyp` and `install: node-gyp-build`.
* ⇒ On Windows it **must compile from source** ⇒ requires MSVC + Python. **Disqualified.**
* Its `prebuild` script only ever targeted Node 12.22.12 → 19.3.0, so even the non-Windows
  prebuilds predate Node 24.
* I found no other actively maintained `ffi-napi` fork in this investigation. (Stated as a
  negative result, not an exhaustive registry sweep.)

### (c) `node-ffi-rs` — actively maintained, no compiler needed
* npm: latest **1.3.7, published 2026-08-09**; 73 versions; Rust-based.
* GitHub `zhangyuang/node-ffi-rs`: **347 stars, 7 open issues, last push 2026-08-09**, MIT.
* Ships prebuilt platform packages, including **`@yuuang/ffi-rs-win32-x64-msvc@1.3.7`**
  (published 2026-08-09) containing `ffi-rs.win32-x64-msvc.node` (755,712 bytes). PE x64 with
  `napi_register_module_v1` and **no `NODE_MODULE_VERSION`** → N-API, so no electron-rebuild.
* **Empirically verified on this compiler-less machine:**
  * `npm install node-ffi-rs@1.3.7` → **exit 0**, "added 3 packages".
  * Simple call works: `GetDoubleClickTime` → `500`.
  * **`SHQueryUserNotificationState` works** via out-pointer:
    ```js
    const pointer = ffi.createPointer({ paramsType: [DataType.I32], paramsValue: [0] });
    const hr = ffi.load({ library:'shell32', funcName:'SHQueryUserNotificationState',
                          retType: DataType.I32,
                          paramsType: [DataType.External], paramsValue: pointer });
    const back = ffi.restorePointer({ retType: [DataType.I32], paramsValue: pointer });
    // hr = 0, back = [5]   ← matches koffi and the independent P/Invoke check
    ```
* **Caveats vs koffi:** the API is markedly less ergonomic — out-parameters require
  `createPointer`/`restorePointer` with `JsExternal` wrappers and a different signature for each
  (`createPointer` takes `paramsType`, `restorePointer` takes `retType`); struct support is more
  manual (`define`, `funcConstructor`, `StackStruct`). Its own `index.d.ts` notes that *"On runtimes
  that forbid external buffers (e.g. **Electron**) this silently falls back to copying the data"* —
  a behavioural caveat in Electron. **I did not test node-ffi-rs inside Electron 44**, and I did
  not test `LASTINPUTINFO` struct handling through it. Treat as a fallback, not the primary.

### (d) Pure-JS ways to read Windows notification state — NOT POSSIBLE
I looked for a no-native-code path and found **none** that can reproduce `QUNS_BUSY`:
* **Registry — verified absent.** There is no key reporting "a fullscreen app is running".
  On this machine `HKCU\Software\Microsoft\Windows\CurrentVersion\PresentationSettings` **does not
  exist**, and there is no `Presentation*` key under
  `HKCU\Software\Microsoft\Windows\CurrentVersion`. `HKCU\Control Panel\Desktop` only exposes
  `ScreenSaveActive` (screensaver *enabled* flag, not *currently running*) plus unrelated UI
  timings. `HKCU\Software\Microsoft\Windows\CurrentVersion\ImmersiveShell` has only `TabletMode`.
* **WMI — no documented class exposes `QUERY_USER_NOTIFICATION_STATE`.** (I did not exhaustively
  enumerate every WMI class; stated as a strong negative rather than a proof.)
* **Spawn-a-child fallback works but is ugly.** I verified the exact PowerShell that does it —
  `Add-Type` with `[DllImport("shell32.dll")] SHQueryUserNotificationState` — returns `hr=0 state=5`,
  and `GetLastInputInfo` returns `ok=True cbSize=8`. Note `Add-Type` needs .NET's own C# compiler,
  **not** MSVC, so this works on a build-tools-free machine. Cost: process spawn (~100s of ms) per
  poll, plus PowerShell availability/ExecutionPolicy concerns. Only sensible as a one-shot probe,
  not a 1 Hz poll.

**Recommendation:** use **koffi**. `node-ffi-rs` is the only viable alternative; everything else
either needs a compiler, is abandoned, or cannot see the required OS state at all.

---

## 3. Electron `win.setShape(rects)` — VERDICT: ⚠️ documented, experimental, does give click-through, but rects are UNION-only

### Exact current state (Electron **v44.3.0**, `docs/api/browser-window.md` line 1405, verbatim)
```md
#### `win.setShape(rects)` _Windows_ _Linux_ _Experimental_

* `rects` [Rectangle[]](structures/rectangle.md) - Sets a shape on the window.
  Passing an empty list reverts the window to being rectangular.

Setting a window shape determines the area within the window where the system
permits drawing and user interaction. Outside of the given region, no pixels
will be drawn and no mouse events will be registered. Mouse events outside of
the region will not be received by that window, but will fall through to
whatever is behind the window.
```
* **Platforms: Windows + Linux. Not macOS.**
* **`_Experimental_`** — still flagged experimental in v44.3.0 (no change from `main`).
* **It affects hit-testing as well as rendering.** The doc text is explicit: outside the region
  "no mouse events will be registered" and they "fall through to whatever is behind the window".
  So yes — `setShape` **is** a genuine OS-level click-through primitive.
* `setShape([])` **reverts to rectangular** (documented, and see implementation below).

### Implementation chain (traced through source)
`electron_api_base_window.cc` → `BaseWindow::SetShape` (L727) → `native_window.cc`
`NativeWindow::SetShape` (L318) → `widget()->SetShape(std::make_unique<std::vector<gfx::Rect>>(rects))`
→ Chromium `ui/views/widget/widget.cc` `Widget::SetShape` (L970) → `DesktopWindowTreeHostWin::SetShape`
(`ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc` L423) →
`HWNDMessageHandler::SetRegion` (`ui/views/win/hwnd_message_handler.cc` L737) →
`::SetWindowRgn(hwnd(), region, redraw)` (L1841).

Inside `DesktopWindowTreeHostWin::SetShape`:
```cc
if (!native_shape || native_shape->empty()) { message_handler_->SetRegion(nullptr); return; }
SkRegion shape;
...
shape.op(gfx::RectToSkIRect(rect), SkRegion::kUnion_Op);   // <-- UNION only
message_handler_->SetRegion(gfx::CreateHRGNFromSkRegion(shape));
```
* **CRITICAL DESIGN CONSTRAINT: rects are UNIONed — you cannot subtract.** There is no way to punch
  a transparent *hole* in the middle of a `setShape` region. Only an outer silhouette is possible.
  This matters for a pet with a hollow/cut-out body.
* Empty/null list → `SetRegion(nullptr)` → `SetWindowRgn(hwnd(), nullptr, redraw)`, i.e. back to the
  full rectangle. **So `setShape([])` does work on Windows.**
* HiDPI: rects are scaled by the monitor scale factor and `roundOut()`-ed (`SetShape` handles
  `scale > 1.0` separately).
* The `transform` argument of the Chromium API is **not used** by the Windows implementation.

### `transparent: true` interaction — IMPORTANT
Electron's own v44.3.0 `docs/tutorial/custom-window-styles.md` lists under **Limitations**:
> * **You cannot click through the transparent area.** See
>   [#1335](https://github.com/electron/electron/issues/1335) for details.
> * Transparent windows are not resizable. Setting `resizable` to `true` may make a transparent
>   window stop working on some platforms.
> * The window will not be transparent when DevTools is opened.
> * On _Windows_: Transparent windows can not be maximized using the Windows system menu or by
>   double clicking the title bar.

This is corroborated at the Chromium source level (`hwnd_message_handler.cc` L1793-1796):
```cc
// WS_EX_LAYERED automatically makes clicks on transparent pixels fall
// through, but that isn't the case when using Direct3D to draw transparent
// windows. So we route translucent windows throught to the delegate to
// allow for a custom hit mask.
```
⇒ **A `transparent: true` frameless Electron window on Windows gets NO free click-through on its
transparent pixels.** That is the whole reason you need `setShape` or `setIgnoreMouseEvents`.
`setShape` **does** take precedence in `ResetWindowRegion`, because `custom_window_region_` is
checked *first* (L1813) before the maximized/`GetWindowMask` branches — so a shape you set is not
clobbered by Electron's own translucent-window handling.

**What I could NOT verify:** I did not empirically test `setShape` on a `transparent: true` window
on build 26200. I found no doc statement that the combination is supported/tested, and no
open Windows bug proving it broken either. Treat "setShape works on a transparent Windows window"
as **plausible but unproven** — test it early.

### `setIgnoreMouseEvents` interaction
* Implementation on Windows (`native_window_views.cc` L1394-1410) is entirely different: it toggles
  extended window styles —
  `ex_style |= (WS_EX_TRANSPARENT | WS_EX_LAYERED)` to ignore, and clears them to restore
  (keeping `WS_EX_LAYERED` if the window is `layered_`). It also drives
  `SetForwardMouseMessages(forward)`.
* **`setIgnoreMouseEvents` is all-or-nothing**: the entire window stops receiving mouse events.
  It cannot by itself produce a partial click-through region — the usual pattern is to toggle it
  dynamically from CSS hit-testing on `mousemove`.
* **No source-level conflict found.** `setShape` operates on the window *region*
  (`SetWindowRgn`); `setIgnoreMouseEvents` operates on *extended window styles*
  (`WS_EX_TRANSPARENT`/`WS_EX_LAYERED`). They are independent mechanisms. **However** I found no
  documentation or test confirming they behave well *together*, and I did not test the combination.
  Note that `setIgnoreMouseEvents` adds `WS_EX_LAYERED`, which routes `ResetWindowRegion` down the
  translucent path — but `custom_window_region_` still wins there.
* Practical guidance: pick **one** primary mechanism. For a pet with a simple silhouette,
  `setShape` alone gives real OS click-through. For per-pixel CSS-shaped hit areas, use
  `setIgnoreMouseEvents(ignore, { forward: true })` toggled from the renderer.

### Open / notable bugs about `setShape`
GitHub search (`repo:electron/electron setShape in:title,body`) returned **10** issues total
(3 open, 8 closed markers on the issues page). The relevant ones:

| Issue | State | Relevance |
|---|---|---|
| [#40552](https://github.com/electron/electron/issues/40552) | **closed, `not_planned`** (label `blocked/need-repro`), 2023-11-28 | "`BrowserWindow.setShape` cause app background black in win 10 1809 version when rect array over one", Electron 27.1.0 — *"even if i set window background transparent"*. **Windows 10 1809 only; closed as unreproducible.** Low risk for Win11 26200, but it is the one report of a setShape ↔ transparency interaction. |
| [#40302](https://github.com/electron/electron/issues/40302) | closed | Duplicate of #40552. |
| [#31642](https://github.com/electron/electron/issues/31642) | closed | "`setShape([])` does not clear shape" — **Linux only**; Windows handles empty → `SetRegion(nullptr)` correctly. |
| [#18304](https://github.com/electron/electron/issues/18304) | closed | `setShape(rects)` + titlebar. |
| [#47131](https://github.com/electron/electron/issues/47131) | closed (2025-05) | `refactor: add NativeWindow::SetShape()` — explains why the impl moved to `native_window.cc` → `widget()->SetShape`. |
| [#51662](https://github.com/electron/electron/issues/51662) | closed (2026-05) | "Transparent frameless window shows white corners on focus loss (DWM inactive frame)" — matched the setShape search; a transparent-frameless Windows rendering bug. |
| [#51949](https://github.com/electron/electron/issues/51949) | **OPEN**, updated 2026-08-19 | Labels `platform/windows`, `bug`, `component/BrowserWindow`, `41-x-y`, `42-x-y`. Short-window height inconsistent across monitors with different DPI scaling. It matched the `setShape` search, but the issue body shown concerns DPI scaling of short windows — **not confirmed to be a `setShape` bug**; I did not read its full comment thread. |

**No currently-open, Windows-specific `setShape` bug was found.**

---

## 4. Occlusion fix — VERDICT: ✅ flag name confirmed at Chromium 152 / Electron 44; mechanism and merge semantics settled empirically

### Flag name is still current in Chromium 152 (Electron 44's Chromium)
Retrieved from Chromium tag **`152.0.7977.78`** — the exact Chromium version in Electron 44.3.0:

`ui/base/ui_base_features.h` (L53-55):
```cc
#if BUILDFLAG(IS_WIN)
COMPONENT_EXPORT(UI_BASE_FEATURES)
BASE_DECLARE_FEATURE(kCalculateNativeWinOcclusion);
```
`ui/base/ui_base_features.cc` (L38-40):
```cc
#if BUILDFLAG(IS_WIN)
// If enabled, calculate native window occlusion - Windows-only.
BASE_FEATURE(kCalculateNativeWinOcclusion, base::FEATURE_ENABLED_BY_DEFAULT);
```
Note it is **Windows-only** and **enabled by default**, which is exactly why a desktop pet gets
occlusion-throttled and needs it disabled.

### The string name is derived by stripping the leading `k`
`base/feature_internal.h` (definitive):
```cc
#define BASE_FEATURE_INTERNAL_2_ARGS(is_runtime_mutable, feature, default_state) \
  constinit const base::Feature feature(                                        \
      []() {                                                                    \
        static_assert(#feature[0] == 'k');                                      \
        return std::string_view(#feature).substr(1).data();                     \
      }(),
```
So `BASE_FEATURE(kCalculateNativeWinOcclusion, …)` ⇒ feature name string is exactly
**`CalculateNativeWinOcclusion`**. ⇒ `--disable-features=CalculateNativeWinOcclusion` is correct.

### Mechanism — YES, `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`
Electron's `app.commandLine.appendSwitch` maps to Chromium's `AppendSwitchNative`
(`shell/common/api/electron_api_command_line.cc` L31-49). **Empirically verified in Electron
44.3.0** that a value appended from `main.js` reaches Chromium: the GPU/utility/renderer process
command lines contained
```
--enable-features=PdfUseShowSaveFilePicker
--disable-features=DeltaFeatureDDD,DropInputEventsWhilePaintHolding,GammaFeatureGGG,LocalNetworkAccessChecks,NetworkServiceSandbox,ScreenAIOCREnabled,SpareRendererForSitePerProcess,TraceSiteInstanceGetProcessCreation
```
i.e. **Chromium merged my app's disabled features with its own defaults into a single switch**, so
you do not lose Chromium's defaults.

### Can it be called before `app.whenReady()`? — YES, and it **must** be at main.js top level
This is guaranteed **by design**, per Electron's own source
(`shell/browser/electron_browser_main_parts.cc`, v44.3.0, L379-384):
```cc
  // We already initialized the feature list in PreEarlyInitialization(), but
  // the user JS script would not have had a chance to alter the command-line
  // switches at that point. Lets reinitialize it here to pick up the
  // command-line changes.
  base::FeatureList::ClearInstanceForTesting();
  InitializeFeatureList();
```
Ordering inside `PostEarlyInitialization()`:
1. L364 `node_bindings_->LoadEnvironment(node_env_.get())`
2. L367 `node_bindings_->JoinAppCode()` — **waits for the app's main script**
3. L383-384 — **FeatureList is re-created from the (now-modified) command line**
4. L387 `InitializeFieldTrials()`

I confirmed `app.isReady() === false` when the main script starts, matching this ordering.
**Caveat:** because the re-init happens immediately after the main script's *synchronous top-level*
execution, `appendSwitch` must be called at **top level** of `main.js`. Calling it inside
`app.whenReady().then(...)` or any async callback is **too late** for the browser-process
FeatureList.

```js
// main.js — TOP LEVEL, before app.whenReady()
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
```

### `appendSwitch` MERGES or OVERWRITES? → **IT OVERWRITES.** Combine into ONE call.
Proven empirically on Electron 44.3.0:
```
appendSwitch('disable-features', 'AlphaFeatureAAA')
appendSwitch('disable-features', 'BetaFeatureBBB')
getSwitchValue('disable-features')  →  "BetaFeatureBBB"      // AlphaFeatureAAA is GONE
appendSwitch('disable-features', 'GammaFeatureGGG,DeltaFeatureDDD')
getSwitchValue('disable-features')  →  "GammaFeatureGGG,DeltaFeatureDDD"   // both survive
```
Source confirmation — Chromium `base/command_line.cc` `AppendSwitchNative` (L433-465):
```cc
  if (g_duplicate_switch_handler) {
    g_duplicate_switch_handler->ResolveDuplicate(key, value, switches_[std::string(key)]);
  } else {
    switches_[std::string(key)] = StringType(value);   // <-- OVERWRITE (last wins)
  }
  ...
  argv_.insert(argv_.begin() + begin_args_, combined_switch_string);   // argv gets an extra token
```
`g_duplicate_switch_handler` is `nullptr` unless an embedder installs one, and Electron does not.
The feature list is built from these strings (`FeatureList::InitInstance(enable_features,
disable_features)`), which can only carry one string per list — so **last-wins is structural**.

**Correct pattern:**
```js
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,SomeOtherFeature')
```

---

## 5. better-sqlite3 packaging

### Issue #1503 — **CLOSED as COMPLETED (fixed upstream)**
* Title: *"[Bug] v13: `npm install` on Windows still invokes Python/node-gyp even when bundled
  prebuilt exists"* — https://github.com/WiseLibs/better-sqlite3/issues/1503
* Opened **2026-07-24** by `greg-hammond`.
* **State: `CLOSED`, `state_reason = COMPLETED`**, `ClosedEvent` at **2026-07-28T08:58:41Z** by
  `Prinzhorn`. 10 comments / 11 timeline events.
* Latest activity extends past closure (comments #9-#11 discuss v13.0.2 and an
  electron-forge-specific recurrence).
* Fix PR: **https://github.com/WiseLibs/better-sqlite3/pull/1505** — comment #8: *"Will be fixed
  with the next release."*

### Root cause (verified independently against the npm registry)
better-sqlite3 v13.0.0 removed its `install` script — and that is exactly what triggered npm to
inject one. The reporter's own diagnosis (comment #5):
> *"at publish time, npm publish code will itself ADD AN INSTALL SCRIPT to the manifest. If a
> package has `binding.gyp` but no `install`/`preinstall` script, npm injects
> `"install": "node-gyp rebuild"` and `"gypfile": true` into the registry manifest … So it seems
> that the deletion of the install script in v13 is paradoxically what TRIGGERED the install
> script to make it into the published package."*

**I confirmed this directly from `registry.npmjs.org`** by reading the published manifest scripts:

| Version | Published | Registry manifest `install` script |
|---|---|---|
| 13.0.0 | 2026-07-21 | **`install=node-gyp rebuild`** ← bug present |
| 13.0.1 | 2026-07-21 | **`install=node-gyp rebuild`** ← bug present |
| 13.0.2 | 2026-07-29 | *absent* ← **fixed by PR #1505** |
| 13.0.3 | 2026-08-05 | *absent* ← fixed |

The npm behaviour is documented at
https://docs.npmjs.com/cli/v11/using-npm/scripts:
> *"If there is a `binding.gyp` file in the root of your package and you haven't defined your own
> `install` or `preinstall` scripts, npm will default the `install` command to compile using
> node-gyp via `node-gyp rebuild`"*

The upstream fix uses npm's documented **`gypfile`** option: better-sqlite3 13.0.3's package.json
contains **`"gypfile": false`** (plus `binding.gyp` is still shipped in `files`).
Latest release: **13.0.3, published 2026-08-05**, `engines: node >= 22`, dep `node-addon-api@^8.0.0`.

### Currently recommended workaround
1. **Best: upgrade to `better-sqlite3` ≥ 13.0.2.** The problem is fixed; no workaround needed.
2. If pinned to an affected version (13.0.0 / 13.0.1), reported in-thread:
   * **Yarn Berry:** `"dependenciesMeta": { "better-sqlite3": { "built": false } }`
     (forces the prebuilt instead of node-gyp).
   * **pnpm:** in `pnpm-workspace.yaml`: `allowBuilds: { better-sqlite3: false }`.
   * **npm:** set the documented **`"gypfile": false`** option in the consuming package.json
     (this is what upstream adopted), or use `--ignore-scripts`.
     *(The `--ignore-scripts` suggestion is my inference from the mechanics, not a quote from the
     thread — flagging it as such.)*
3. Note comment #10: a report on v13.0.2 turned out to be **electron-forge explicitly compiling for
   Electron**, plus a stale `better-sqlite3: 12.11.1` override — i.e. not this bug. Check for
   `electron-rebuild`/forge rebuild steps in your own pipeline before blaming the package.

### Does better-sqlite3 need `electron-rebuild`? → **NO**
* 13.0.3 ships `prebuilds/` in the tarball: `win32-x64.node`, `win32-arm64.node`, `darwin-x64.node`,
  `darwin-arm64.node`, `linux-x64.node`, `linux-arm64.node`, `linuxmusl-x64.node`,
  `linuxmusl-arm64.node`.
* PE probe of `prebuilds/win32-x64.node` (1,989,632 bytes): PE x64, contains
  `napi_register_module_v1` + `node_api_module_get_api_version_v1`, and **no `NODE_MODULE_VERSION`**
  ⇒ **Node-API addon** ⇒ works in Electron 44 without recompilation.
* Loader (`lib/binding.js`): prefers `prebuilds/<platform>-<arch>.node` (with musl detection), falls
  back to `build/Debug|Release/better_sqlite3.node`. There are also per-platform entry points
  (`better-sqlite3/win32-x64`) that `require('../prebuilds/win32-x64.node')` directly.
* `binding.gyp` invokes `lib/binding.js` to detect a prebuild (prints `1`/`0`) — designed to skip
  compilation. But **node-gyp still needs Python/MSVC merely to evaluate `binding.gyp`**, which is
  precisely why the injected install script broke everyone.

### `asarUnpack` — better-sqlite3 does **NOT** need it (auto-unpacked), but here is the exact syntax
**electron-builder automatically unpacks any module that contains native code.** Source
(`packages/app-builder-lib/src/asar/unpackDetector.ts`):
```ts
export function isLibOrExe(file: string): boolean {
  return file.endsWith(".dll") || file.endsWith(".exe") || file.endsWith(".dylib")
      || file.endsWith(".so")  || file.endsWith(".node")
}
...
if (moduleName === "ffprobe-static" || moduleName === "ffmpeg-static" || isLibOrExe(file)) {
  shouldUnpack = true
}
...
autoUnpackDirs.add(stat.moduleRootPath)
```
and `asarUtil.ts`: `if (this.config.options.smartUnpack !== false) { detectUnpackedDirs(...) }`.
The published typings (`app-builder-lib@26.15.3`,
`out/options/PlatformSpecificBuildOptions.d.ts` L124) say so explicitly:
> *"Node modules, that must be unpacked, will be detected automatically, you don't need to
> explicitly set `asarUnpack` - please file an issue if this doesn't work."*

⇒ **`better-sqlite3` needs no explicit `asarUnpack`**, because its module root contains
`prebuilds/*.node`. The same applies to koffi's `@koromix/koffi-win32-x64` (contains
`win32_x64/koffi.node`).

**Exact syntax if you want to be explicit anyway** — `asarUnpack` is a
`PlatformSpecificBuildOptions` property accepting `Array<string> | string | null`; values are
**glob patterns relative to the app directory**:
```jsonc
// electron-builder.json / package.json "build"
{
  // array form (most common)
  "asarUnpack": ["**/node_modules/better-sqlite3/**", "**/node_modules/@koromix/koffi-win32-x64/**"],
  // or string form
  // "asarUnpack": "**/*.node",

  // per-platform also works (win/mac/linux inherit PlatformSpecificBuildOptions)
  "win": { "asarUnpack": ["**/*.node"] },

  // equivalent nested form
  "asar": { "smartUnpack": true, "unpack": "**/*.node" }
}
```
Mechanically, `asarUnpack` is turned into `asar.unpack` via
`getFileMatchers(config, "asarUnpack", …)` in `platformPackager.ts` (L401), and
`computeAsarOptions()` reads `customBuildOptions.asar` / `this.config.asar`; `asarOptions.unpack`
is then compiled into the asar `unpackPattern`. Note it accepts a single string **or** an array
(`const pats = Array.isArray(unpackPatterns) ? unpackPatterns : [unpackPatterns]`).

**One inconsistency worth flagging:** the **`master` branch `scheme.json` on GitHub has ZERO
occurrences of `asarUnpack`**, while the **published `app-builder-lib@26.15.3` `scheme.json` has
10**, and the published `.d.ts` and `platformPackager.js` both reference it. This looks like a
regeneration/doc-pipeline discrepancy on master. The **published artifact — which is what npm
installs — supports `asarUnpack`**; I verified it there directly.

---

## Appendix A — the "does a fullscreen app actually report QUNS_BUSY?" experiment

This was the single highest-value empirical check, run on **Windows 11 build 26200**:

1. A polling probe called `SHQueryUserNotificationState` every 1.2 s and also read the foreground
   window title.
2. A separate process opened a **borderless, maximized, topmost WinForms window** (a real
   fullscreen app) and held it for 15 s.

Observed:
```
[21:27:25] state=5 fg='…DeepSeek Harness…Microsoft Edge'
[21:27:28] state=5 fg='…DeepSeek Harness…Microsoft Edge'
[21:27:29] state=2 fg=''          <-- fullscreen window took foreground
[21:27:30] state=2 fg=''
…            state=2 …           (for the whole fullscreen period)
```
⇒ **`QUNS_BUSY` (value 2) is genuinely returned when a fullscreen application is in the
foreground, on build 26200.** The core premise of the plan is sound.

Independent cross-check via a completely different binding path (`Add-Type` P/Invoke, no koffi):
`SHQueryUserNotificationState` → `hr=0 state=5`; `GetLastInputInfo` → `ok=True cbSize=8
idleMs=802406`. koffi and node-ffi-rs both reproduced `hr=0 state=5`.

### Authoritative enum (Microsoft Learn, `shellapi.h`)
```c
typedef enum {
  QUNS_NOT_PRESENT              = 1,  // screen saver displayed, machine locked, or inactive FUS session
  QUNS_BUSY                     = 2,  // a full-screen application is running OR Presentation Settings applied
  QUNS_RUNNING_D3D_FULL_SCREEN  = 3,  // exclusive-mode Direct3D app running
  QUNS_PRESENTATION_MODE        = 4,  // presentation settings active
  QUNS_ACCEPTS_NOTIFICATIONS    = 5,  // none of the above; notifications OK
  QUNS_QUIET_TIME               = 6,  // first hour after a new user logs in
  QUNS_APP                      = 7   // a Windows Store app is running
} QUERY_USER_NOTIFICATION_STATE;
```
Note for the silence logic: `QUNS_QUIET_TIME` is **never** reported when one of the blocking
states applies — MS docs state `SHQueryUserNotificationState` returns only the blocking value in
that case. Also `QUNS_NOT_PRESENT` (1) covers a **locked machine/screensaver**, which a pet app
almost certainly also wants to treat as "hide/silence". Consider treating **{1, 2, 3, 4}** as
"silence", and think carefully about 7 (a Store app may be windowed).

---

## Appendix B — what I could NOT verify (no guessing)

1. **`setShape` on a `transparent: true` frameless window on Windows 11 26200** — not empirically
   tested. Docs do not confirm the combination; the only related report (#40552) is Windows 10 1809
   and was closed as unreproducible. **Test this early.**
2. **`setShape` combined with `setIgnoreMouseEvents`** — no documented conflict and no source-level
   coupling found (different mechanisms), but the combination is untested here and undocumented.
3. **`node-ffi-rs` inside Electron 44** — verified only on bare Node 24.15.0. Its own typings warn
   about Electron's treatment of external buffers.
4. **`node-ffi-rs` + `LASTINPUTINFO` struct handling** — I verified its out-pointer path with
   `SHQueryUserNotificationState` but did not implement the struct call.
5. **Exhaustive WMI enumeration** for a class exposing QUNS — I established the registry negative
   conclusively and found no documented WMI class, but did not enumerate every WMI class.
6. **Other maintained `ffi-napi` forks** — only `@lwahonen/ffi-napi` was named in the brief and
   checked; I did not sweep the registry for every fork.
7. **`electron-builder` `master` vs published `scheme.json` discrepancy** for `asarUnpack` —
   observed and reported, root cause not determined.
8. **Authoritative source for `InitializeFeatureList()`'s body** — I located its call sites
   (`electron_main_delegate.cc` L356 and `electron_browser_main_parts.cc` L384) and Electron's own
   explanatory comment, but not the function definition, so I am relying on Electron's stated
   intent plus the empirical child-process command line rather than on reading that function.
9. **`better-sqlite3` end-to-end install on this compiler-less machine** — I verified the registry
   manifests, tarball contents and N-API nature, but did not run a full
   `npm install better-sqlite3@13.0.3` (which would need the SQLite deps downloaded).
