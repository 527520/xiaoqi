# Q5 — Electron `screen` module: fullscreen detection & multi-monitor DPI

Research/verification only. No product code written.

**Research context (observed via tool output, not assumed):**
- Electron stable at research time: **v44.3.0**, published **2026-09-08** (GitHub Releases API, `repos/electron/electron/releases`). Newest prerelease: `v45.0.0-alpha.6`.
- Docs source of truth: `raw.githubusercontent.com/electron/electron/main/docs/...`, cross-checked against tag `v44.3.0`.
- `docs/api/screen.md` on `main` and at tag `v44.3.0` are **byte-identical** (both 5137 chars). Same for `docs/api/structures/display.md` (1908 chars).
- `web_fetch` is unusable in this environment (fake-IP DNS). All page content below was retrieved with `pwsh` + `Invoke-RestMethod`/`Invoke-WebRequest` and the GitHub REST API. `web_search` was used for discovery only.

Legend: **[C]** confirmed · **[P]** partially confirmed · **[U]** UNVERIFIED

---

## Q5a — What the `screen` module actually exposes

### Methods — exhaustive list from the source binding table

CLAIM: The `screen` module exposes exactly 10 methods, and these are the only ones.
EVIDENCE: `https://raw.githubusercontent.com/electron/electron/main/shell/browser/api/electron_api_screen.cc` lines 221–238, the complete `GetObjectTemplateBuilder`:
```cpp
.SetMethod("getCursorScreenPoint", &Screen::GetCursorScreenPoint)
.SetMethod("getPrimaryDisplay", &Screen::GetPrimaryDisplay)
.SetMethod("getAllDisplays", &Screen::GetAllDisplays)
.SetMethod("getDisplayNearestPoint", &Screen::GetDisplayNearestPoint)
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
.SetMethod("screenToDipPoint", &Screen::ScreenToDIPPoint)
.SetMethod("dipToScreenPoint", &Screen::DIPToScreenPoint)
#endif
#if BUILDFLAG(IS_WIN)
.SetMethod("screenToDipRect", &ScreenToDIPRect)
.SetMethod("dipToScreenRect", &DIPToScreenRect)
#endif
.SetMethod("getDisplayMatching", &Screen::GetDisplayMatching);
```
CONFIDENCE: **[C]** — this is the binding table itself, and it is a closed set.

### Official doc text per member

All quotes below are from `https://raw.githubusercontent.com/electron/electron/main/docs/api/screen.md` (identical at `v44.3.0`); the published page `https://www.electronjs.org/docs/latest/api/screen` renders the same content (fetched, HTTP 200, 63250 bytes; its trailing API index lists exactly the 10 methods above **[C]**).

| Member | Doc text (verbatim) |
|---|---|
| `screen.getCursorScreenPoint()` | "The current absolute position of the mouse pointer. / Not supported on Wayland (Linux)." + NOTE: "The return value is a DIP point, not a screen physical point." |
| `screen.getPrimaryDisplay()` | "Returns `Display` - The primary display." |
| `screen.getAllDisplays()` | "Returns `Display[]` - An array of displays that are currently available." |
| `screen.getDisplayNearestPoint(point)` | "Returns `Display` - The display nearest the specified point." |
| `screen.getDisplayMatching(rect)` | "Returns `Display` - The display that most closely intersects the provided bounds." |
| `screen.screenToDipPoint(point)` _Windows_ _Linux_ | "Converts a screen physical point to a screen DIP point. / The DPI scale is performed relative to the display containing the physical point." / "Not currently supported on Wayland - if used there it will return the point passed in with no changes." |
| `screen.dipToScreenPoint(point)` _Windows_ _Linux_ | "Converts a screen DIP point to a screen physical point. / The DPI scale is performed relative to the display containing the DIP point." |
| `screen.screenToDipRect(window, rect)` _Windows_ | "Converts a screen physical rect to a screen DIP rect. / The DPI scale is performed relative to the display nearest to `window`. If `window` is null, scaling will be performed to the display nearest to `rect`." |
| `screen.dipToScreenRect(window, rect)` _Windows_ | "Converts a screen DIP rect to a screen physical rect. / The DPI scale is performed relative to the display nearest to `window`. If `window` is null, scaling will be performed to the display nearest to `rect`." |

CONFIDENCE: **[C]**.

The module-level coordinate note (same file, lines 61–67) is the key one for DIP reasoning:
> "**Physical screen points** are raw hardware pixels on a display. / **Device-independent pixel (DIP) points** are virtualized screen points scaled based on the DPI (dots per inch) of the display."

### ⚠️ The "Electron renamed these at some point" premise is NOT supported by evidence

CLAIM: `screenToDipPoint` / `dipToScreenPoint` / `screenToDipRect` / `dipToScreenRect` have **never been renamed**. They were introduced with these exact names in Electron 3.0.0 and are unchanged in current stable.
EVIDENCE:
1. Method-list diff across tags (fetched each `docs/api/screen.md` and listed its `###` headings):
   - `v2.0.18` (2995 chars): `getCursorScreenPoint`, `getMenuBarHeight` (macOS), `getPrimaryDisplay`, `getAllDisplays`, `getDisplayNearestPoint`, `getDisplayMatching` — **no DIP methods**.
   - `v3.0.0` (4244 chars): all four DIP methods present, annotated `_Windows_` only.
   - `v8.5.5`, `v9.0.0`, `v18.3.7`, `v25.9.8`, `v30.5.1`, `v44.3.0`, `main`: identical four names.
2. The introducing PR is `https://github.com/electron/electron/pull/12879` — title "Expose Windows specific DIP <-> screen coordinate conversion methods", `merged=True`, `merged_at=2018-05-16T09:34:10Z`, base `master`. Its body: *"These methods are mapped to the following APIs in `display::win::ScreenWin` ... `ScreenToDIPPoint`, `DIPToScreenPoint`, `ScreenToDIPRect`, `DIPToScreenRect`"* — the JS names were already the `*DipPoint`/`*ScreenPoint` form.
3. Commit history of `docs/api/screen.md` (GitHub commits API, 63 commits) contains **no commit message mentioning a rename** of these methods. The one relevant commit is `211d7825` (2018-05-16) "feat: DIP <-> screen coordinate conversions (#12879)".
CONFIDENCE: **[C]** that no rename occurred (introduction + version-by-version method lists + full commit-message scan).

CLAIM: What *did* change is the **platform support annotation**: the Point variants went from Windows-only to Windows **and Linux (X11)**.
EVIDENCE: commit `ede84fc3`, dated **2025-05-02**, message "feat: support dip <-> screen conversion on Linux X11 (#46211)" touching `docs/api/screen.md`. Current doc heading is `### screen.screenToDipPoint(point)` _Windows_ _Linux_ , while `screenToDipRect`/`dipToScreenRect` remain _Windows_ only (matching the `#if` guards in the source above, where the Point methods are under `IS_WIN || IS_LINUX` and the Rect methods under `IS_WIN`).
CONFIDENCE: **[C]**.

### `Display` object fields

CLAIM: All the fields you listed exist in current Electron, and the Rust… rather, C++ → JS field mapping is explicit and matches the docs one-for-one.
EVIDENCE: `https://raw.githubusercontent.com/electron/electron/main/shell/common/gin_converters/gfx_converter.cc`, `Converter<display::Display>::ToV8`, lines 173–200, sets exactly:
`accelerometerSupport`, `bounds`, `colorDepth`, `colorSpace`, `depthPerComponent`, `detected`, `displayFrequency`, `id`, `internal`, `label`, `maximumCursorSize`, `monochrome`, `nativeOrigin`, `rotation`, `scaleFactor`, `size`, `workArea`, `workAreaSize`, `touchSupport`.
Doc definitions from `docs/api/structures/display.md` (identical on `main` and `v44.3.0`), verbatim:
- `accelerometerSupport` string — "Can be `available`, `unavailable`, `unknown`."
- `bounds` Rectangle — "the bounds of the display **in DIP points**."
- `colorDepth` number — "The number of bits per pixel."
- `colorSpace` string — "represent a color space (three-dimensional object which contains all realizable color combinations) for the purpose of color conversions."
- `depthPerComponent` number — "The number of bits per color component."
- `detected` boolean — "`true` if the display is detected by the system."
- `displayFrequency` number — "The display refresh rate."
- `id` number — "Unique identifier associated with the display. A value of -1 means the display is invalid or the correct `id` is not yet known, and a value of -10 means the display is a virtual display assigned to a unified desktop."
- `internal` boolean — "`true` for an internal display and `false` for an external display."
- `label` string — "User-friendly label, determined by the platform."
- `maximumCursorSize` Size — "Maximum cursor size in native pixels."
- `nativeOrigin` Point — "Returns the display's origin in pixel coordinates. **Only available on windowing systems like X11** that position displays in pixel coordinates."
- `rotation` number — "Can be 0, 90, 180, 270, represents screen rotation in clock-wise degrees."
- `scaleFactor` number — "Output device's pixel scale factor."
- `size` Size — *(documented with **no description string at all** — see the DIP analysis below)*
- `workArea` Rectangle — "the work area of the display **in DIP points**."
- `workAreaSize` Size — "The size of the work area."
- `touchSupport` string — "Can be `available`, `unavailable`, `unknown`."
- `monochrome` boolean — "Whether or not the display is a monochrome display."
CONFIDENCE: **[C]** for existence and doc text. **[U]** for the runtime reliability of `internal`, `detected`, `displayFrequency`, `maximumCursorSize` on Windows specifically — I found no evidence either way. `nativeOrigin` is documented as X11-oriented, so treat it as non-functional on Windows **[C]** for the doc statement.

### `bounds` vs `workArea` vs `scaleFactor` — DIP or physical pixels?

CLAIM: `bounds` and `workArea` are in **DIP**, not physical pixels. `size` == `bounds.size()` and `workAreaSize` == `workArea.size()`, so they are DIP too. `scaleFactor` is the device pixel ratio that converts between the two.
EVIDENCE:
1. Doc text above: `bounds` "in DIP points", `workArea` "in DIP points" (main + v44.3.0).
2. `https://github.com/electron/electron/pull/27157` — title "docs: coordinate system of Display.bounds and Display.workArea", `merged=True`, `merged_at=2021-01-07T10:49:46Z`, base `master` (landed in Electron 12; a backport PR `#29708` also exists). Body verbatim: *"These properties are in DIP points (rather than screen points). We can use `screen.dipToScreen*` to convert to screen points."*
3. `size`/`workAreaSize` semantics, from Chromium `ui/display/display.h` (mirror `https://raw.githubusercontent.com/chromium/chromium/main/ui/display/display.h`, HTTP 200, 14073 chars), lines 199–200:
   - `const gfx::Size& size() const { return bounds_.size(); }`
   - `const gfx::Size& work_area_size() const { return work_area_.size(); }`
   Electron's `ToV8` maps exactly those three getters, so `Display.size` and `Display.workAreaSize` live in the same coordinate space as `bounds`/`workArea` — DIP.
4. `scaleFactor` maps to `val.device_scale_factor()` (`gfx_converter.cc` line 194). Chromium `display.h` lines 142–146: *"Output device's pixel scale factor. This specifies how much the UI should be scaled when the actual output has more pixels than standard displays (which is about 100~120dpi.) The potential return values depend on each platforms."* — the same wording Electron's doc borrows.
5. Corroborating measurement source: PR `#12879` body says the conversion API exists because native node modules "operate on physical coordinates".
CONFIDENCE: **[C]**.

### Lifecycle constraint (asked about in Q5c, kept here for the API surface)

CLAIM: `screen` cannot be used before `app` emits `ready`.
EVIDENCE: `docs/api/screen.md` lines 5–8 verbatim: *"Process: [Main] / This module cannot be used until the `ready` event of the `app` module is emitted."* Same on the published page (fetched: "Process: Main / This module cannot be used until the ready event of the app module is emitted."). The constraint was added to the docs in commit `0fda86f7` (2016-09-16, "Mention not requiring module until app is ready"). Real-world consequence, see Q5c: issue `#33414` was closed by its own author with *"This was my fault, I didnt hook into the events after the ready event"*.
CONFIDENCE: **[C]**.

---

## Q5b — Fullscreen detection

### What Electron gives you for fullscreen

CLAIM: Electron reports **only your own** `BrowserWindow`'s fullscreen state.
EVIDENCE: `docs/api/browser-window.md` (main, 63431 chars):
- `#### win.fullScreen` — "A `boolean` property that determines whether the window is in fullscreen mode."
- `#### win.isFullScreen()` — "Returns `boolean` - Whether the window is in fullscreen mode." with NOTE: "On macOS, fullscreen transitions take place asynchronously. When querying for a BrowserWindow's fullscreen status, you should ensure that either the ['enter-full-screen'] or ['leave-full-screen'] events have been emitted."
CONFIDENCE: **[C]**.

### There is NO native API for other applications' windows going fullscreen on Windows

CLAIM: Electron exposes no API — on any platform — that reports whether another application's window is fullscreen, or even what other top-level windows exist. Your expectation ("NO") is correct.
EVIDENCE (proof by exhaustive enumeration of the API surface, not by a doc sentence — read the caveat below):
1. The `screen` module's complete binding table (quoted in Q5a) contains nothing about window state, window enumeration, or foreground/fullscreen windows. Its complete event set is 3 events.
2. Window enumeration is application-scoped, not system-scoped: `BrowserWindow.getAllWindows()` — "Returns `BrowserWindow[]` - An array of all opened browser windows." Plus `BrowserWindow.getFocusedWindow()` — "The window that is focused **in this application**, otherwise returns `null`." (quoted from `docs/api/browser-window.md` lines 468–475). The phrase "in this application" is Electron's own wording and makes the scoping explicit **[C]**.
3. `desktopCapturer` — the only Electron API that can see other apps' windows — cannot answer the question. `docs/api/structures/desktop-capturer-source.md` defines `DesktopCapturerSource` as exactly: `id` ("The format of the identifier will be `window:XX:YY` or `screen:ZZ:0`. XX is the windowID/handle. YY is 1 for the current process, and 0 for all others."), `name` ("the name of a window source will match the window title"), `thumbnail`, `display_id`, `appIcon`. There is **no bounds, no rectangle, no fullscreen/visibility field**. Even the thumbnail size is not a measurement: "There is no guarantee that the size of the thumbnail is the same as the `thumbnailSize` specified ... The actual size depends on the scale of the screen or window." **[C]**
4. Search of electron/electron issues for a fullscreen-detection-for-other-apps request or feature returned no matching issue (queries: `fullscreen detect other application window`, `isFullScreen other app in:title,body`, `detect fullscreen application`, `"another application" OR "other applications" fullscreen`, `getForegroundWindow OR "foreground window"`). The nearest hits were about the app's own windows (`#39614`, `#51396`, `#35360`). **[P]** — a negative search result is weaker than an enumeration; it shows no *known* API/request, not that none could be filed under wording I didn't guess.
CONFIDENCE: **[C]** that no such API exists in the documented+bound surface; **[P]** that no upstream request exists.

Caveat I want to be explicit about: there is no doc sentence saying "you cannot read other apps' fullscreen state". The "NO" conclusion rests on enumerating the complete binding table (a closed set) plus the app-scoped wording of window enumeration. That is strong but it is inference from completeness, not a quoted denial.

### The `bounds` vs `workArea` heuristic — what the docs/issues actually support

CLAIM: Comparing `display.bounds` against `display.workArea` measures the **taskbar/desktop-toolbar inset**, not a fullscreen application. There is no evidence that a fullscreen application changes `workArea`.
EVIDENCE:
- The work area is a Win32-defined concept and Microsoft defines it as the monitor rectangle minus shell UI, not minus other apps' windows: `MONITORINFO` (`https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-monitorinfo`) — `rcMonitor` = "the display monitor rectangle, expressed in virtual-screen coordinates"; `rcWork` = "the work area rectangle of the display monitor, expressed in virtual-screen coordinates". Neither field is described as reflecting other applications. **[C]** for the definitions; **[U]** for the specific claim that a fullscreen app leaves `workArea` unchanged — I found no source that states this either way, so treat "fullscreen app ⇒ workArea == bounds" as an unverified hypothesis.
- Historically the heuristic was additionally unreliable on Windows for a *different* reason: `#6312` "Windows: WorkArea property not updated" (`https://github.com/electron/electron/issues/6312`, `state=closed`, `state_reason=completed`, created 2016-07-01, closed 2017-05-19, labels `platform/windows`, 20 comments). Body verbatim: *"With newer Electron version the WorkArea property never changes. It's always returns the values according to what the WorkArea are when the application started. ... The `display-metrics-changed` event of screen doesn't respond to taskbar changes either."* It was closed as completed (fixed), so this describes old (1.x-era) behaviour, not current. **[C]** for the historical report; **[U]** for whether current v44 reacts promptly to every taskbar auto-hide/show transition.
- I searched `repo:electron/electron "workArea" fullscreen taskbar in:title,body` → `TOTAL_COUNT: 0` (no issue claims workArea tracks fullscreen apps). **[P]**

### The three `screen` events (which exist)

CLAIM: Exactly three events exist, and `display-metrics-changed` can report exactly four metric names.
EVIDENCE: `docs/api/screen.md` verbatim:
- `### Event: 'display-added'` — "Emitted when `newDisplay` has been added."
- `### Event: 'display-removed'` — "Emitted when `oldDisplay` has been removed."
- `### Event: 'display-metrics-changed'` — "Emitted when one or more metrics change in a `display`. The `changedMetrics` is an array of strings that describe the changes. Possible changes are `bounds`, `workArea`, `scaleFactor` and `rotation`."
Source confirmation of the exact four strings: `electron_api_screen.cc` lines 43–55, `MetricsToArray()`:
```cpp
if (metrics & display::DisplayObserver::DISPLAY_METRIC_BOUNDS) array.emplace_back("bounds");
if (metrics & display::DisplayObserver::DISPLAY_METRIC_WORK_AREA) array.emplace_back("workArea");
if (metrics & display::DisplayObserver::DISPLAY_METRIC_DEVICE_SCALE_FACTOR) array.emplace_back("scaleFactor");
if (metrics & display::DisplayObserver::DISPLAY_METRIC_ROTATION) array.emplace_back("rotation");
```
The events are emitted through `DelayEmit` / `DelayEmitWithMetrics` (lines 57–68), driven by Chromium's `display::DisplayObserver` callbacks (`OnDisplayAdded`, `OnDisplaysRemoved`, `OnDisplayMetricsChanged`).
CONFIDENCE: **[C]**.

### The viable native answer on Windows, for contrast

CLAIM: Win32 has a purpose-built API for "is a fullscreen app running" — and Electron does not surface it.
EVIDENCE: `QUERY_USER_NOTIFICATION_STATE` enum (`https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state`, returned by `SHQueryUserNotificationState`, header `shellapi.h`, min client "Windows Vista, Windows 7 [desktop apps only]"), verbatim constants:
- `QUNS_BUSY` Value: 2 — "A full-screen application is running or Presentation Settings are applied."
- `QUNS_RUNNING_D3D_FULL_SCREEN` Value: 3 — "A full-screen (exclusive mode) Direct3D application is running."
- `QUNS_ACCEPTS_NOTIFICATIONS` Value: 5 — "None of the other states are found, notifications can be freely sent."
No Electron module in the documented API surface wraps this (see the enumeration above). Note it is **system-global**, not per-display: the docs give no per-monitor variant, so it cannot tell you *which* monitor a fullscreen app occupies. **[C]** for the enum and its doc text; **[P]** for the "no per-display variant" conclusion (inferred from the enum's shape and docs).
CONFIDENCE: **[C]** / **[P]** as marked.

---

## Q5c — Known `scaleFactor` / mixed-DPI problems, with issue numbers, states, dates, versions

### The headline current issue: `scaleFactor` includes the Windows accessibility text-scale multiplier

CLAIM: On Windows, `Display.scaleFactor` equals `textScaleFactor × monitorScaleFactor`. This is **open**, reported against Electron 35/36, and is actually *documented Chromium behaviour* that Electron gives you no way to decompose.
EVIDENCE:
1. Issue `#47057` — title "`Display.scaleFactor` should NOT equal textScaleFactor × monitorScaleFactor on Windows", `https://github.com/electron/electron/issues/47057`. `state=open`, created **2025-05-12T11:52:25Z**, not closed, last updated **2025-05-14T19:19:15Z**, 9 comments. Labels: `enhancement`, `platform/windows`, `has-repro-gist`, `component/screen`, `35-x-y`, `36-x-y`. Reported Electron version: **35.0.0**, OS "All Windows systems that have text scaling functionality(eg.win10&win11)", x64, "Last Known Working Electron version: none". Body: *"On Windows, `Display.scaleFactor` should reflect only the **monitor scale factor** ... It should **NOT** incorporate the **text scale factor** (i.e., text size scaling configured in Accessibility Settings)."*
   Reproduction, per the reporter's comment: *"change your TextScale settings in Settings → Accessibility → Text Size. Then try to get the scaleFactor and you'll find the issue"*. Repro gist supplied: `https://gist.github.com/b1df9c23cdbcc0cf06cbf6508c1272ea`. The reporter also asked: *"could someone clarify why this API behaves this way and why it was reclassified from a bug to an enhancement?"* — i.e. it was reclassified bug → enhancement.
2. The explanation is in Chromium, not Electron. `ui/display/display.h` lines 149–164, verbatim:
   > "Gets/Sets the display's text scale multiplier. / For most users this is expected to be 1.0, but some platforms offer an accessibility option to increase the text size without increasing the size of other UI elements. When the user has selected such an option, this value is expected to match their selection. / **This value is also expected to be factored into the device_scale_factor.** For example, if the user has selected a 1.5x text size, and the actual native device scale factor is 2.0x, then this value is expected to be 1.5, and the device_scale_factor is expected to be 1.5x2.0=3.0."
3. Electron maps `scaleFactor` to exactly that fused value (`gfx_converter.cc` line 194: `dict.Set("scaleFactor", val.device_scale_factor())`) and does **not** expose `text_scale_multiplier` — the full `ToV8` field list (19 fields, quoted in Q5a) contains no text-scale field.
CONSEQUENCE FOR A DESKTOP PET: **you cannot recover the true monitor DPI ratio from `Display.scaleFactor` on Windows**; a user at 150% text size on a 100% monitor will see `scaleFactor` 1.5 on a display whose physical pixel geometry is 1:1. Sizing a pet sprite by `scaleFactor` will over-scale it. There is no Electron field to divide out. CONFIDENCE: **[C]** for the mechanism (source chain + Chromium's own comment) and for the issue's metadata; **[C]** that Electron exposes no text-scale field (closed field list).

### Canonical mixed-DPI positioning/sizing bug (still open)

CLAIM: With one non-100% monitor and one 100% monitor on Windows, `setSize` and `setPosition` are wrong by exactly the scale factor. This is the umbrella issue and it is still open after ~9 years.
EVIDENCE: Issue `#10862` — "Per monitor DPI awareness causes issues with window positioning and sizing", `https://github.com/electron/electron/issues/10862`. `state=open`, created **2017-10-20T10:31:19Z**, never closed, last updated **2026-08-16T09:20:41Z**, **71 comments**. Labels: `platform/windows`, `machine-dependent`, `bug`, `bug/regression`, `2-0-x`, `5-0-x`, `component/BrowserWindow`. Body verbatim: *"If you have one monitor with non-100% scaling and one monitor with 100% scaling both `setSize` and `setPosition` do not act as expected (they always set incorrectly by a factor exactly equal to the scale factor of the screen). ... All future issues regarding DPI scaling and window positioning / sizing should be merged into this one."* It supersedes `#9560`.
CONFIDENCE: **[C]**.

### `scaleFactor` reported as 1 at 125%

CLAIM: `screen.getPrimaryDisplay().scaleFactor` returned `1` at 125% on Windows — real, old, fixed.
EVIDENCE: Issue `#6571` — "screen.scaleFactor always returns 1 for 125% DPI", `https://github.com/electron/electron/issues/6571`. `state=closed`, `state_reason=completed`, created **2016-07-22T16:48:56Z**, closed **2017-01-19T21:33:49Z**, 12 comments, label `platform/windows`. Body verbatim: *"Electron version: 1.2.8 ... I have a hidpi screen on my laptop and a normal main monitor that has some scaling applied through windows' display properties. In both cases the following code returns 1 even though I would expect something larger: `require('electron').screen.getPrimaryDisplay().scaleFactor`"*.
CONFIDENCE: **[C]** for the report and closure; this is Electron **1.2.8** — do not treat it as a current-version defect.

### Scale-factor changes not propagating to windows

CLAIM: Changing a monitor's scale factor did not resize existing frameless windows (multiple windows), reported on Electron 18.3.0 / 22.0.0.
EVIDENCE: Issue `#36791` — "[Bug]: When changing monitor's scale factor while having multiple frameless windows, windows are not resized automatically", `https://github.com/electron/electron/issues/36791`. `state=closed`, `state_reason=completed`, created **2023-01-04T16:36:48Z**, closed **2023-07-25T08:29:27Z**, 5 comments. Labels: `bug`, `component/BrowserWindow`, `has-repro-gist`, `stale` (note: closed as `stale`, i.e. auto-closed for inactivity, not necessarily fixed). Electron version **22.0.0**; Windows 10 21H2; repro gist `https://gist.github.com/fuzatii/664f0407e52aa5d871283155480f2726`. Body: one monitor 1920x1080 at 100% → set scale to 150% → *"Windows are not resized when scale factor is changed"*; *"If there is only one frameless window, it resizes correctly"*.
CONFIDENCE: **[C]** for metadata/body; **[P]** that it remains fixed in v44 (closed `stale`, no verified fix commit identified).

### Other Windows DPI issues worth knowing

| Issue | Title | State | Created → closed | Version(s) | Relevance |
|---|---|---|---|---|---|
| `#20527` | BrowserWindow: minHeight/minWidth broken on mixed DPI monitors on Windows in Electron 6.0.6 | closed | 2019-10-10 → 2019-11-15 | `6-0-x`, `platform/windows`, `bug` | mixed-DPI sizing |
| `#52208` | titleBarOverlay height resolves incorrectly after Windows DPI scaling | **open** | 2026-06-30 → — | **43.0.0**, `platform/windows`, `bug`, `component/BrowserWindow`, `has-repro-gist` | **current**: at 150%/175% scale the native overlay controls mis-size |
| `#48492` | incorrect coordinate calculation Screen method | closed | 2025-10-08 → 2025-11-04 | `platform/windows`, `blocked/need-info`, closed without repro | screen coordinate math on Windows |
| `#15018` | BrowserWindow positioning is not updated with docked Windows Magnifier | closed | 2018-10-08 → 2019-08-19 | `platform/windows`, `1.8.x`, `3-0-x` | work-area changes from a shell accessory |
| `#27651` | [Bug]: setBounds make BrowserWindows larger every time on Windows | **open** | 2021-02-08 → — (updated 2025-08-30) | `platform/windows`, `status/confirmed`, `21-x-y`, `22-x-y` | DIP↔pixel drift on setBounds |
| `#29605` | BrowserWindow.getBounds() cannot be restored as they were with multiple monitors and differing scale levels | closed (stale) | 2021-06-09 → 2025-02-27 | `12-x-y`, `bug`, `has-repro-gist` | persisting window geometry across DPIs |
| `#51645` | fix: preserve DIP size on programmatic cross-DPI setBounds on Windows (PR) | closed, **not merged** (`merged=False`) | 2026-05-15 → 2026-06-24 | label `blocked/upstream` | the cross-DPI setBounds fix is blocked upstream in Chromium |
| `#10237` | Screen bounds and workarea Y coordinate shows negative for positive position… | closed | 2017-08-10 → 2019-01-15 | `platform/windows`, `1.7.x`, `bug` | historical sign/coordinate confusion |
| `#8069` | workArea not calculated correctly with multiple monitors | closed | 2016-11-23 → 2017-05-31 | (no labels) | historical multi-monitor workArea |

CONFIDENCE: **[C]** for every row's number/title/state/dates/labels (each fetched from the GitHub REST API); **[C]** that `#51645` and `#48468` were closed unmerged (`merged=False` from the pulls endpoint).

### `display-metrics-changed` reliability

- `#3403` — "Windows: Screen display-metrics-changed event not triggered", `https://github.com/electron/electron/issues/3403`. `state=closed`, created **2015-11-11T10:50:24Z**, closed **2015-11-11T16:06:30Z**, 3 comments, no labels. Reporter follow-up in-thread: *"not only I don't get the event but the values are not updated if I query the display bounds and workArea"*. Maintainer `zcbenz`: *"I'm merging this to #3075."* **[C]** for the thread; **[U]** for `#3075`'s current state — the GitHub API returned `403 rate limit exceeded` when I tried, so I could not confirm what became of the umbrella issue.
- `#1704` — "'display-metrics-changed' event does not trigger when changing resolution", `state=closed`, created **2015-05-15T20:22:21Z**, closed **2015-05-21T06:58:27Z**. **[C]**
- `#6312` — (quoted in Q5b) workArea and the event both ignoring taskbar moves, Electron 1.x, closed `completed` 2017-05-19. **[C]**
- `#33414` — "[Bug]: Event 'display-removed' and 'display-metrics-changed' not emitted", `state=closed`, created **2022-03-23T18:41:17Z**, closed **2022-03-24T11:21:48Z**, label `bug`. Closed by the reporter, sole comment verbatim: *"This was my fault, I didnt hook into the events after the ready event"*. **This is user error, not an Electron bug** — and it is the concrete illustration of the `ready`-event requirement. **[C]**
- `#36951` (macOS, `21-x-y`, closed need-info), `#23421` and `#23087` (macOS Catalina, closed need-info) are macOS-only. **[C]**
- I found **no open Electron issue** asserting that `display-metrics-changed` fails to fire for `scaleFactor` changes on Windows in a current version. The only open `component/screen` issues are three: `#42519` (Linux `getCursorScreenPoint` regression, `blocked/upstream`, `tracking-upstream`, `status/confirmed`), `#47649` (persistent Display ID, enhancement), and `#47057` (scaleFactor/text-scale). **[C]** for that enumeration (query `repo:electron/electron label:component/screen state:open` → `TOTAL_COUNT: 3`).

### Per-monitor DPI awareness: Electron ships Per-Monitor **V1**, and the V2 upgrade was rejected

CLAIM: Electron's Windows manifest declares `<dpiAware>true/pm</dpiAware>` — Per-Monitor **V1**, not V2 — and this is true in current stable v44.3.0. The PR that would have moved it to PerMonitorV2 was closed **unmerged**.
EVIDENCE:
1. `https://raw.githubusercontent.com/electron/electron/v44.3.0/shell/browser/resources/win/dpi_aware.manifest` (HTTP 200) — and byte-identical on `main` — contains only:
```xml
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <asmv3:application xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
    <asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">
      <!-- See: https://docs.microsoft.com/en-us/windows/desktop/sbscs/application-manifests#dpiAware -->
      <dpiAware>true/pm</dpiAware>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>
```
No `dpiAwareness` element, no `gdiScaling`.
2. Microsoft confirms what `true/pm` means — `https://learn.microsoft.com/en-us/windows/win32/sbscs/application-manifests`, `dpiAware` table verbatim: *"Contains \"true/pm\" / Windows Vista, Windows 7 and Windows 8: The current process is system dpi aware. / **Windows 8.1 and Windows 10: The current process is per-monitor dpi aware.**"* Also: *"Windows 10, version 1607: The dpiAware element is ignored if the dpiAwareness element is present."*
3. Microsoft's own guidance rates PMv1 poorly — `https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows` verbatim: *"Per-Monitor V1 (PMv1) awareness is very limited. It is recommended that applications use PMv2."*; *"Per-Monitor V1 DPI awareness mode (PMv1) was introduced with Windows 8.1. ... The initial support for per-monitor awareness only offered applications the following: Top-level HWNDs are notified of a DPI change and provided a new suggested size; Windows will not bitmap stretch the application UI"*; *"Registering a process as running in PMv2 awareness mode results in: The application being notified when the DPI changes (both the top-level and child HWNDs); The application seeing the raw pixels of each display ... Win32 dialogs (from CreateDialog) automatically DPI scaled by Windows; Theme-drawn bitmap assets in common controls ... being automatically rendered at the appropriate DPI scale factor"*.
4. PR `#48468` — "fix(windows): reduce blurriness on mixed-DPI displays by enabling Per…" (truncated title), `https://github.com/electron/electron/pull/48468`. `state=closed`, **`merged=False`**, `merged_at` empty, `mergeable_state=unstable`, 1 commit, 1 changed file, head `utahisnotastate:fix/windows-dpi-permonitorv2`, created **2025-10-05T11:01:14Z**, closed **2025-10-13T09:18:15Z**. Single comment, from maintainer `codebytere`, verbatim: *"Closing due to lack of response."* Body had proposed adding `<dpiAwareness>PerMonitorV2</dpiAwareness>` and `<gdiScaling>true</gdiScaling>` while *"Kept legacy Per‑Monitor v1: `<dpiAware>true/pm</dpiAware>` (2005 WindowsSettings) for older Windows"*, and stated: *"Prior behavior relied on Per‑Monitor v1 (`<dpiAware>true/pm</dpiAware>`), which can still yield blurry content on mixed‑DPI setups (e.g., 100% ↔ 150%)."*
CONFIDENCE: **[C]** for the manifest content at v44.3.0 and main, for the Microsoft definitions, and for the PR being closed unmerged. This is a **notable correction to a plausible-sounding assumption**: do not describe Electron as Per-Monitor-V2 aware.

### `--high-dpi-support`

CLAIM: There is no DPI-related command-line switch documented anywhere in Electron's current switch list.
EVIDENCE: `docs/api/command-line-switches.md` fetched at `main` (15764 chars) and at tags `v9.0.0`, `v11.5.0`, `v15.5.7`; the complete `###` heading list for `main` is: `--auth-server-whitelist`, `--auth-negotiate-delegate-whitelist`, `--disable-ntlm-v2`, `--disable-http-cache`, `--disable-http2`, `--disable-geolocation`, `--disable-renderer-backgrounding`, `--disk-cache-size`, `--enable-logging`, `--force-fieldtrials`, `--host-rules`, `--host-resolver-rules`, `--ignore-certificate-errors`, `--ignore-connections-limit`, `--js-flags`, `--lang`, `--log-file`, `--log-net-log`, `--log-level`, `--no-proxy-server`, `--no-sandbox`, `--no-stdio-init`, `--proxy-bypass-list`, `--proxy-pac-url`, `--proxy-server`, `--remote-debugging-port`, `--v`, `--vmodule`, `--force_high_performance_gpu`, `--force_low_power_gpu`, `--xdg-portal-required-version`, `--inspect-brk`, `--inspect-port`, `--inspect`, `--inspect-publish-uid`, `--experimental-network-inspection`, `--experimental-inspector-network-resource`, `--no-deprecation`, `--throw-deprecation`, `--trace-deprecation`, `--dns-result-order`, `--diagnostic-dir`, `--no-experimental-global-navigator`, `--experimental-transform-types`. **No `--high-dpi-support`, no `dpi` substring at all** in `main`, `v9.0.0`, `v11.5.0`, or `v15.5.7`. `docs/breaking-changes.md` (128745 chars, main) contains no `high-dpi` reference either (its only `dpi` hit is the Electron 46 `capturePage` scale-factor behaviour change).
CONFIDENCE: **[C]** that it is undocumented in Electron v9 → v44 and absent from breaking-changes. **[U]** whether Chromium still accepts it as an undocumented passthrough switch (I did not inspect Chromium's switch list), and **[U]** whether it existed in Electron ≤ v8 (tags `v1.8.8`, `v2.0.0`, `v3.0.0`, `v4.2.12`, `v5.0.13`, `v6.1.12` all returned HTTP 404 for that doc path, so I could not check them).

### Adjacent, non-Electron but closely related evidence

CLAIM (explicitly labelled as **WebView2, not Electron**): in PerMonitorV2 mode, screen geometry reported to web content is wrong and changes depending on which monitor the app sits on.
EVIDENCE: `MicrosoftEdge/WebView2Feedback` issue `#4826`, "Screen details are incorrect and change unexpectedly in PerMonitorV2 DPI awareness mode", `https://github.com/MicrosoftEdge/WebView2Feedback/issues/4826`. `state=closed`, `state_reason=completed`, created **2024-09-20T14:00:03Z**, closed **2026-03-02T05:56:00Z**, 4 comments, labels `bug`, `tracked`. Body describes two 1920x1080 monitors where *"the screen details returned by a call to `await getScreenDetails();` are incorrect and also change depending on which monitor the application is showing on"*, and that moving the app to the unscaled monitor changed `devicePixelRatio` from 1.5 to 1 and the reported screen list along with it, whereas *"Edge does not have this problem."*
CONFIDENCE: **[C]** for the issue metadata and body. **[U]** whether any of this transfers to Electron — Electron uses Chromium's `display::Screen` directly and does **not** use WebView2, so this is context on the general mixed-DPI hazard, **not** evidence about Electron behaviour. Label it as such.

Also relevant, same caveat (not read): `https://stackoverflow.com/questions/78525200/check-if-any-system-app-is-running-in-fullscreen-nodejs` was returned by `web_search` as a community answer on this exact problem, but fetching it returned **HTTP 403 (Forbidden)**, so I did **not** read it and cite nothing from it.

---

## Q5d — Comparison to raw Win32

The first two blocks are evidenced; the third is explicitly my own analysis.

### What Electron/Chromium genuinely handles for you — **[C]**

- **Per-monitor DPI awareness is declared in the manifest**, so you never call `SetProcessDpiAwareness`/`SetProcessDPIAware`: `shell/browser/resources/win/dpi_aware.manifest` ships `<dpiAware>true/pm</dpiAware>`, which Microsoft defines as "per-monitor dpi aware" on Windows 8.1/10. (Confirmed at v44.3.0.) Level caveat: it is **PMv1**, and Microsoft says PMv1 "is very limited"; Electron is not PMv2 (PR #48468 closed unmerged).
- **DIP coordinates are the default currency of the whole API.** `Display.bounds` / `workArea` / `size` / `workAreaSize`, `getCursorScreenPoint()`, and `BrowserWindow` geometry are all DIP (docs + PR #27157 + Chromium `display.h` `size() { return bounds_.size(); }`). You do not scale these yourself.
- **`WM_DPICHANGED` plumbing, monitor enumeration and topology changes are surfaced as JS**, so you don't write `EnumDisplayMonitors` + `GetMonitorInfo` + window-proc DPI messages yourself: `screen.getAllDisplays()`, `getPrimaryDisplay()`, `getDisplayNearestPoint(point)`, `getDisplayMatching(rect)`, plus the `display-added` / `display-removed` / `display-metrics-changed` events with a `changedMetrics` array whose exact vocabulary (`bounds`, `workArea`, `scaleFactor`, `rotation`) I confirmed in `MetricsToArray()`.
- **Physical↔DIP conversion is exposed**, which is precisely the interop seam PR #12879 was written for: its body states the API "is useful when calling Windows APIs in native code (node modules), which operate on physical coordinates."

### What is genuinely still needed from native code — **[C]** for the gap's existence, reasoning where noted

- **Detecting another application going fullscreen.** No Electron API exists (Q5b). The Win32 answer is `SHQueryUserNotificationState` (`shellapi.h`), where `QUNS_BUSY` = "A full-screen application is running" and `QUNS_RUNNING_D3D_FULL_SCREEN` = "A full-screen (exclusive mode) Direct3D application is running". It is system-global — **[P]** (inferred) that it cannot attribute fullscreen to a specific monitor.
- **The true monitor DPI / scale percentage.** Because `Display.scaleFactor` is Chromium's `device_scale_factor()`, which Chromium documents as already having `text_scale_multiplier` folded in, and because Electron exposes no text-scale field (closed 19-field list in `ToV8`), the accessibility text size cannot be divided back out in JS. Getting the pure monitor DPI means native calls — Microsoft's guidance lists `GetDpiForMonitor`/`GetDpiForWindow` as the per-monitor replacements for `GetSystemMetrics` (high-dpi doc: "GetSystemMetrics → GetSystemMetricsForDpi ... GetDpiForMonitor → GetDpiForWindow"). Note the Microsoft doc's own warning that the return value "depends on the DPI_AWARENESS of the window".
- **A stable monitor identity.** `Display.id` is documented only as "Unique identifier associated with the display", with `-1` invalid and `-10` unified-desktop-virtual. Issue `#47649` ("Unique and persistent ID for Display", `state=open`, created **2025-07-03T07:34:01Z**, labels `enhancement`, `component/screen`, 3 comments) requests exactly this and states in its body: *"screen position can be rearranged and id is unique but not persistent across system reboots"*, proposing the monitor serial number or PnP device ID. So persisting "put the pet on monitor X" needs native monitor-device-path enumeration. **[C]** for issue/body; **[U]** for the claim itself (it is the reporter's assertion; Electron's docs do not state persistence semantics either way).
- **Physical-pixel rectangles** for any native/overlay interop — use `screenToDipRect`/`dipToScreenRect` (Windows-only) rather than reimplementing it. Note `Point` requires integers: `docs/api/structures/point.md` — "Both `x` and `y` must be whole integers, when providing a point object as input to an Electron API we will automatically round your `x` and `y` values to the nearest whole integer." **[C]**

### My own analysis — not directly evidenced, treat as engineering judgement

- Given PMv1 + the open `#10862` (mixed-DPI `setSize`/`setPosition` off by exactly the scale factor, open since 2017) + `#27651` (`setBounds` inflating, `status/confirmed`) + `#51645` (cross-DPI `setBounds` fix **blocked upstream**), I would not build a desktop pet that relies on programmatic cross-monitor window geometry as its core mechanism. Prefer reading `getDisplayNearestPoint`/`getCursorScreenPoint` (DIP) for placement and treat exact `setBounds` pixel fidelity as best-effort.
- For "is a fullscreen app covering my display?", the honest architecture is: poll (or event-drive) `screen.getAllDisplays()` for topology/workArea changes, and take the actual fullscreen verdict from native `SHQueryUserNotificationState` — accepting that it is global, so a multi-monitor pet cannot know *which* display is covered from that call alone. Combining it with `getCursorScreenPoint()` (which display the pointer is on) is a heuristic, not a determination. I did not find any source that validates this combination.
- Because `scaleFactor` is text-scale-contaminated on Windows, any DPI-dependent sprite sizing should be derived from measured DIP-vs-physical geometry (e.g. ratio of `dipToScreenPoint` output to input for a point on the target display) rather than from `scaleFactor`. **This is my proposal; I did not test it and found no source endorsing it.**

---

## Explicitly NOT verified

1. **`#3075`** — the umbrella issue that `#3403` was merged into. The GitHub API returned `403 rate limit exceeded`; I do not know its title, state, or resolution.
2. **`Display.id` persistence semantics.** `#47649`'s body asserts IDs are not persistent across reboots; Electron's docs say only "Unique identifier". No authoritative statement found either way.
3. **Runtime reliability on Windows of `internal`, `detected`, `displayFrequency`, `maximumCursorSize`** — no evidence found, and no per-platform caveats in the docs for these.
4. **Whether `bounds` vs `workArea` actually detects a fullscreen application on Windows.** I verified what the two rectangles mean and that the historical workArea-update bug (`#6312`) was closed as fixed, but found no source confirming that a fullscreen app *does* or *does not* alter `workArea`, and no source endorsing the heuristic. The specific behaviour is unverified.
5. **Whether `display-metrics-changed` fires reliably for a `scaleFactor`-only change on Windows in Electron ≥ 40.** No current open issue found; no current positive confirmation found either.
6. **Chromium-side bugs** for mixed-DPI `scaleFactor`. I could not fetch `issues.chromium.org` content; the `chromium.googlesource.com` code-review link surfaced by `web_search` (`Allow Forced Scale Factor with Per-Monitor DPI`) was **not read**. The only Chromium primary source I actually read is `ui/display/display.h` (via the `chromium/chromium` GitHub mirror).
7. **`--high-dpi-support`**: whether it exists as an undocumented Chromium passthrough in current Electron, and whether it existed in Electron ≤ v8 (all tags I tried for that doc path 404'd). Only established: it is not documented in v9, v11, v15, v44, or main.
8. **`#48468`'s rejection reason beyond the recorded comment.** The only comment is "Closing due to lack of response." (maintainer `codebytere`); I do not know whether PerMonitorV2 remains wanted by the team.
9. **WebView2 `#4826`'s applicability to Electron** — I explicitly did not establish any transfer; Electron does not use WebView2.
10. **The StackOverflow question** `78525200` ("Check if any system app is running in fullscreen nodeJS") — returned **HTTP 403**, never read; nothing here relies on it.
11. **`electron` npm type definitions** (`electron.d.ts`) for the current stable were not fetched; all API-surface claims come from `docs/*.md`, the C++ binding table, and the converter source at `main`/`v44.3.0`.
12. **`Display.label` format on Windows** — the docs say only "User-friendly label, determined by the platform"; I did not verify what Windows actually populates.
