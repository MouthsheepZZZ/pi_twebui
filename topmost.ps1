# Pins or unpins the Chrome window that is showing this Pi TWebui page.
# Reads JSON from PI_TOPMOST_JSON: { title, host, enabled, hwnd }.
$ErrorActionPreference = "Stop"
$payload = $env:PI_TOPMOST_JSON | ConvertFrom-Json
$title = [string]$payload.title
$pageHost = [string]$payload.host
$enabled = $payload.enabled -eq $true
$saved = [int64]0
if ([string]$payload.hwnd -match '^-?\d+$') { $saved = [int64]$payload.hwnd }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
public static class PiTopmost {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

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
  public static string Apply(string title, string pageHost, bool enabled, long saved) {
    var deadline = DateTime.UtcNow.AddMilliseconds(1200);
    long found = 0;
    string problem = "missing";
    do {
      found = Locate(title ?? "", pageHost ?? "", saved, out problem);
      if (found != 0 || problem == "ambiguous") break;
      Thread.Sleep(80);
    } while (DateTime.UtcNow < deadline);
    if (found == 0) return problem;
    var after = enabled ? new IntPtr(-1) : new IntPtr(-2);
    if (!SetWindowPos(new IntPtr(found), after, 0, 0, 0, 0, 0x13)) return "failed";
    return found.ToString();
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
}
'@

$result = [PiTopmost]::Apply($title, $pageHost, $enabled, $saved)
if ($result -eq "missing") { [Console]::Error.WriteLine("Could not find the Pi TWebui window. Focus it and try again."); exit 2 }
if ($result -eq "ambiguous") { [Console]::Error.WriteLine("More than one window has this title. Focus the Pi TWebui window and try again."); exit 3 }
if ($result -eq "failed") { [Console]::Error.WriteLine("Windows could not change the window z-order."); exit 4 }
Write-Output $result
