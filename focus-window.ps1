# Puts the Chrome window showing this Pi TWebui page back in the foreground.
# One JSON object per stdin line: { title, host, hwnd }. title is base64 UTF-8.
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
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

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
      if (IsWindow(h) && (Match(h, title) || (Chrome(h) && IsWindowVisible(h) && Text(h, false).Contains("Pi TWebui")))) return h.ToInt64();
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
  public static string Force(string title, string pageHost, long saved) {
    string problem;
    long found = Locate(title ?? "", pageHost ?? "", saved, out problem);
    if (found == 0) return problem;
    var hwnd = new IntPtr(found);
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
		$pageHost = [string]$payload.host
		$saved = [int64]0
		if ([string]$payload.hwnd -match '^\d+$') { $saved = [int64]$payload.hwnd }
		$result = [PiFocus]::Force($title, $pageHost, $saved)
	} catch {
		$result = "failed"
	}
	[Console]::Out.WriteLine($result)
	[Console]::Out.Flush()
}
