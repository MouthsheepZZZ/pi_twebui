# Puts a window back in the foreground.
# One JSON object per stdin line:
#   { target:"page", title, host, hwnd } focuses the Chrome page. title is base64 UTF-8.
#   { target:"terminal", pid, title, hwnd } focuses the console running this Pi process.
# Prints "ok <hwnd>" or "missing" / "ambiguous" / "failed". Stays running.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PiFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] static extern uint WindowProcess(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitle(StringBuilder text, uint size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  static string Text(IntPtr h, bool cls) {
    var sb = new StringBuilder(1024);
    if (cls) GetClassName(h, sb, sb.Capacity); else GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  static bool Chrome(IntPtr h) {
    return h != IntPtr.Zero && Text(h, true).StartsWith("Chrome_WidgetWin");
  }
  static bool Match(IntPtr h, string title) {
    if (!Chrome(h) || !IsWindowVisible(h) || title.Length == 0) return false;
    var text = Text(h, false);
    return text == title || text.StartsWith(title + " - ") || text.StartsWith(title + " — ");
  }
  static bool HostHit(IntPtr h, string pageHost) {
    if (pageHost.Length < 9 || !Chrome(h) || !IsWindowVisible(h)) return false;
    return Text(h, false).IndexOf(pageHost, StringComparison.OrdinalIgnoreCase) >= 0;
  }
  static long Locate(string title, string pageHost, long saved, out string problem) {
    problem = "missing";
    var fg = GetForegroundWindow();
    if (Match(fg, title) || HostHit(fg, pageHost)) return fg.ToInt64();
    if (saved != 0) {
      var h = new IntPtr(saved);
      if (IsWindow(h) && Chrome(h) && IsWindowVisible(h)) return h.ToInt64();
    }
    long only = 0;
    int count = 0;
    EnumProc cb = (h, l) => {
      if (Match(h, title)) { only = h.ToInt64(); count++; }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    if (count == 1) return only;
    if (count > 1) problem = "ambiguous";
    return 0;
  }
  static string Activate(IntPtr hwnd) {
    long found = hwnd.ToInt64();
    if (GetForegroundWindow() == hwnd) return "ok " + found.ToString();
    var fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint thisThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != thisThread) attached = AttachThreadInput(thisThread, fgThread, true);
    ShowWindow(hwnd, 5);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    if (GetForegroundWindow() != hwnd) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(hwnd);
    }
    if (attached) AttachThreadInput(thisThread, fgThread, false);
    if (GetForegroundWindow() != hwnd) return "failed";
    return "ok " + found.ToString();
  }
  public static string Force(string title, string pageHost, long saved) {
    string problem;
    long found = Locate(title ?? "", pageHost ?? "", saved, out problem);
    if (found == 0) return problem;
    return Activate(new IntPtr(found));
  }

  static uint ParentOf(uint pid) {
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return 0;
    try {
      var entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snap, ref entry)) return 0;
      do {
        if (entry.th32ProcessID == pid) return entry.th32ParentProcessID;
      } while (Process32Next(snap, ref entry));
      return 0;
    } finally {
      CloseHandle(snap);
    }
  }
  static bool TitleHit(string text, string title) {
    if (title.Length == 0 || text.Length == 0) return false;
    return text == title || text.StartsWith(title + " ") || text.StartsWith(title + " - ") || text.StartsWith(title + " — ");
  }
  static bool Usable(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindowVisible(h)) return false;
    RECT rect;
    if (!GetWindowRect(h, out rect)) return false;
    return rect.Right - rect.Left > 80 && rect.Bottom - rect.Top > 40;
  }
  static string LiveTitle(uint procId) {
    FreeConsole();
    if (!AttachConsole(procId)) return "";
    try {
      var sb = new StringBuilder(1024);
      GetConsoleTitle(sb, (uint)sb.Capacity);
      return sb.ToString();
    } finally {
      FreeConsole();
    }
  }
  static string FolderOf(string title) {
    int at = title.LastIndexOf(" - ", StringComparison.Ordinal);
    if (at < 0 || at + 3 >= title.Length) return "";
    return title.Substring(at + 3);
  }
  // The Pi process rarely owns the window the user sees. The console title is read from
  // that process; the visible window may be a parent console, Windows Terminal, or the only terminal.
  static long LocateTerminal(uint procId, string title, long saved) {
    string live = LiveTitle(procId);
    if (live.Length > 0) title = live;
    var ids = new uint[8];
    int count = 0;
    uint cur = procId;
    while (cur != 0 && count < ids.Length) {
      ids[count++] = cur;
      uint parent = ParentOf(cur);
      if (parent == 0 || parent == cur) break;
      bool seen = false;
      for (int i = 0; i < count; i++) if (ids[i] == parent) seen = true;
      if (seen) break;
      cur = parent;
    }
    if (count == 0) return 0;
    long best = 0;
    int bestScore = -1;
    EnumProc cb = (h, l) => {
      if (!IsWindowVisible(h)) return true;
      string text = Text(h, false);
      if (text.Length == 0) return true;
      uint owner;
      WindowProcess(h, out owner);
      int dist = -1;
      for (int i = 0; i < count; i++) if (ids[i] == owner) { dist = i; break; }
      if (dist < 0 || dist > 3) return true;
      string cls = Text(h, true);
      bool titleMatch = TitleHit(text, title) || text.StartsWith("\u03c0");
      bool shell = cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS";
      if (!titleMatch && !shell && dist > 2) return true;
      int score = 400 - dist * 20;
      if (TitleHit(text, title)) score += 3000;
      else if (text.StartsWith("\u03c0")) score += 1500;
      if (cls == "ConsoleWindowClass") score += 400;
      else if (cls == "CASCADIA_HOSTING_WINDOW_CLASS") score += 350;
      if (saved != 0 && h.ToInt64() == saved) score += 50;
      if (score > bestScore) { bestScore = score; best = h.ToInt64(); }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    if (best != 0 && Usable(new IntPtr(best))) return best;
    long titled = 0;
    int titledCount = 0;
    string folder = FolderOf(title);
    long hosted = 0;
    int hostedCount = 0;
    EnumProc scan = (h, l) => {
      if (!Usable(h)) return true;
      string text = Text(h, false);
      string cls = Text(h, true);
      if (TitleHit(text, title) || text.StartsWith("\u03c0")) {
        titled = h.ToInt64();
        titledCount++;
      }
      bool shell = cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS";
      if (shell && folder.Length > 0 && text.IndexOf(folder, StringComparison.OrdinalIgnoreCase) >= 0) {
        hosted = h.ToInt64();
        hostedCount++;
      }
      return true;
    };
    EnumWindows(scan, IntPtr.Zero);
    GC.KeepAlive(scan);
    if (titledCount == 1) return titled;
    if (hostedCount == 1) return hosted;
    if (saved != 0 && Usable(new IntPtr(saved))) return saved;
    return 0;
  }
  public static string ForceTerminal(uint procId, string title, long saved) {
    long found = LocateTerminal(procId, title ?? "", saved);
    if (found == 0) return "missing";
    return Activate(new IntPtr(found));
  }
}
'@

function Decode-Title([string]$b64) {
	if (-not $b64) { return "" }
	return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	if ($line.Trim().Length -eq 0) { continue }
	$result = "failed"
	try {
		$payload = $line | ConvertFrom-Json
		$title = Decode-Title ([string]$payload.title)
		$saved = [int64]0
		if ([string]$payload.hwnd -match '^\d+$') { $saved = [int64]$payload.hwnd }
		if ([string]$payload.target -eq "terminal") {
			$procId = [uint32]0
			if ([string]$payload.pid -match '^\d+$') { $procId = [uint32]$payload.pid }
			$result = [PiFocus]::ForceTerminal($procId, $title, $saved)
		} else {
			$pageHost = [string]$payload.host
			$result = [PiFocus]::Force($title, $pageHost, $saved)
		}
	} catch {
		$result = "failed"
	}
	[Console]::Out.WriteLine($result)
	[Console]::Out.Flush()
}
