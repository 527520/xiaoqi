#Requires -Version 5.1
<#
    Desktop Pet - Perception Layer Feasibility Probe (L0-L2)
    Zero dependencies: only P/Invoke into user32/dwmapi.
    Reads NO screen content, installs nothing, writes no files.

    Purpose: measure what a desktop pet can ACTUALLY see on this real machine,
    to ground the "tiered permission" design in evidence instead of guesses.

    Run (Windows PowerShell 5.1 or PowerShell 7+):
        powershell -NoProfile -ExecutionPolicy Bypass -File .\probe\perception-probe.ps1 -Seconds 30

    While it runs, work normally: switch browser tabs, edit code, watch a video,
    join a meeting. Then answer the 4 self-check questions printed at the end.
#>
[CmdletBinding()]
param(
    [int]$Seconds = 30,
    [int]$IntervalMs = 1000
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Probe {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

    // Must compare against PHYSICAL pixels: with 150% DPI scaling a maximized
    // window's logical rect never equals the monitor rect, so fullscreen
    // detection silently breaks if you use GetWindowRect + virtual desktop size.
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    public delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);

    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int val, int size);

    // GetTickCount64, not Environment.TickCount (which is 32-bit and wraps).
    [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();

    public static string GetMonitorBounds() {
        var sb = new StringBuilder();
        MonitorEnumProc cb = delegate(IntPtr h, IntPtr hdc, ref RECT r, IntPtr d) {
            sb.Append(string.Format("[{0},{1} {2}x{3}]", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top));
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return sb.ToString();
    }

    public static bool TryGetDwmRect(IntPtr h, out RECT r) {
        r = new RECT();
        int l, t, rr, b;
        if (DwmGetWindowAttribute(h, 9, out l, 4) != 0) return false;   // DWMWA_EXTENDED_FRAME_BOUNDS
        if (DwmGetWindowAttribute(h, 10, out t, 4) != 0) return false;
        if (DwmGetWindowAttribute(h, 11, out rr, 4) != 0) return false;
        if (DwmGetWindowAttribute(h, 12, out b, 4) != 0) return false;
        r.Left = l; r.Top = t; r.Right = rr; r.Bottom = b;
        return true;
    }

    public static bool IsFullscreen(IntPtr h) {
        if (h == IntPtr.Zero || h == GetShellWindow() || h == GetDesktopWindow()) return false;
        RECT r;
        if (!TryGetDwmRect(h, out r)) { if (!GetWindowRect(h, out r)) return false; }
        string mine = string.Format("[{0},{1} {2}x{3}]", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
        return GetMonitorBounds().Contains(mine);
    }

    // Cloaked windows: UWP apps that were suspended, or windows on another
    // virtual desktop. Without this check a hidden window looks like "foreground".
    public static int Cloaked(IntPtr h) {
        int v;
        if (DwmGetWindowAttribute(h, 14, out v, 4) != 0) return -1;     // DWMWA_CLOAKED
        return v;
    }
}
'@ -ErrorAction Stop

function Get-IdleSeconds {
    $lii = New-Object Probe+LASTINPUTINFO
    $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
    if (-not [Probe]::GetLastInputInfo([ref]$lii)) { return -1 }
    return [math]::Round((([Probe]::GetTickCount64() - [uint32]$lii.dwTime)) / 1000.0, 1)
}

Write-Host ""
Write-Host "=== Monitors (physical pixels) ===" -ForegroundColor Cyan
Write-Host ("  " + [Probe]::GetMonitorBounds())
Write-Host ("  virtual desktop: {0}x{1}" -f [Probe]::GetSystemMetrics(78), [Probe]::GetSystemMetrics(79))
Write-Host ""

$script:procCache = @{}
function Get-ProcName([uint32]$procId) {
    if ($script:procCache.ContainsKey($procId)) { return $script:procCache[$procId] }
    $n = "?"
    try { $n = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
    $script:procCache[$procId] = $n
    return $n
}

Write-Host "Sampling for $Seconds s (every $IntervalMs ms). Work normally now." -ForegroundColor Yellow
Write-Host "Watch for: is the window title readable, does FULLSCREEN flip to True, does idle reset." -ForegroundColor DarkGray
Write-Host ""
Write-Host ("{0,-8} {1,-24} {2,-7} {3,-6} {4,-6} {5,-10} {6}" -f "TIME","PROCESS","IDLE_s","FULLSCR","CLOAK","WNDCLASS","WINDOW TITLE")
Write-Host ("-" * 120) -ForegroundColor DarkGray

$start = Get-Date
$lastKey = ""
$distinctWindows = New-Object System.Collections.Generic.HashSet[string]
$distinctProcs = New-Object System.Collections.Generic.HashSet[string]
$emptyTitles = New-Object System.Collections.Generic.HashSet[string]
$sawFullscreen = $false

while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
    $h = [Probe]::GetForegroundWindow()
    $procId = [uint32]0
    [void][Probe]::GetWindowThreadProcessId($h, [ref]$procId)

    $sbT = New-Object System.Text.StringBuilder 512
    [void][Probe]::GetWindowTextW($h, $sbT, 512)
    $title = $sbT.ToString()

    $sbC = New-Object System.Text.StringBuilder 256
    [void][Probe]::GetClassNameW($h, $sbC, 256)
    $cls = $sbC.ToString()

    $pname = Get-ProcName $procId
    $idle = Get-IdleSeconds
    $full = [Probe]::IsFullscreen($h)
    $cloak = [Probe]::Cloaked($h)
    if ($full) { $sawFullscreen = $true }
    if ([string]::IsNullOrWhiteSpace($title)) { [void]$emptyTitles.Add($pname) }

    $key = "$procId|$title"
    if ($key -ne $lastKey) {
        $lastKey = $key
        [void]$distinctWindows.Add("$pname :: $title")
        [void]$distinctProcs.Add($pname)
        $color = if ($full) { "Magenta" } else { "White" }
        $shown = if ($title.Length -gt 62) { $title.Substring(0,59) + "..." } else { $title }
        Write-Host ("{0,-8} {1,-24} {2,-7} {3,-6} {4,-6} {5,-10} {6}" -f `
            (Get-Date -Format "HH:mm:ss"), $pname, $idle, $full, $cloak, $cls, $shown) -ForegroundColor $color
    }

    Start-Sleep -Milliseconds $IntervalMs
}

Write-Host ""
Write-Host "=== RESULTS ===" -ForegroundColor Cyan
Write-Host ("  distinct foreground windows : {0}" -f $distinctWindows.Count)
Write-Host ("  distinct processes          : {0}" -f $distinctProcs.Count)
Write-Host ("  fullscreen observed         : {0}" -f $sawFullscreen)
Write-Host ("  processes with EMPTY title  : {0}" -f $emptyTitles.Count)
Write-Host ""
Write-Host "  Processes seen:" -ForegroundColor DarkGray
$distinctProcs | Sort-Object | ForEach-Object { Write-Host "    - $_" }
Write-Host ""
Write-Host "  Windows seen (process :: title) -- this IS the entire raw material of L1 sensing:" -ForegroundColor DarkGray
$distinctWindows | Sort-Object | ForEach-Object { Write-Host "    - $_" }
if ($emptyTitles.Count -gt 0) {
    Write-Host ""
    Write-Host "  EMPTY-TITLE processes (app refuses to expose info; process name is your only fallback):" -ForegroundColor Red
    $emptyTitles | Sort-Object | ForEach-Object { Write-Host "    - $_" }
}
Write-Host ""
Write-Host "Self-check questions:" -ForegroundColor Yellow
Write-Host "  1. Did your browser tab titles come through in full, or just 'Google Chrome'?"
Write-Host "  2. Did the FULLSCR column flip to True while watching video / gaming?"
Write-Host "  3. Did your meeting app expose the meeting name, or only 'Zoom Workplace'?"
Write-Host "  4. Any window with an empty title (that app blocks inspection; bad for pet logic)?"
Write-Host ""
