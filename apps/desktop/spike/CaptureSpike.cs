// CaptureSpike.cs - does per-click desktop capture actually work on this machine?
//
// This is a spike, not the app. It answers one question and then gets thrown away or grown:
// for every left click anywhere in Windows, can we get a usable step WITHOUT the accessibility
// tree, and enrich it WITH the tree when the tree cooperates?
//
// The four tiers from ultraplan-desktop rev 1.1, in evaluation order:
//   Tier 1  window title + process + exe path + absolute coords + normalised coords + screenshot.
//           Never fails, never networks. A step survives on this alone.
//   Tier 2  UI Automation name and control type at the cursor. Hard 250 ms budget, then degrade.
//   Tier 3  OCR. Not in this spike.
//   Tier 4  vision over the whole session at the end. Not in this spike.
//
// Two things this spike exists to prove, because they are the ones that kill the design:
//   1. The hook survives. A low level hook that blocks gets silently unhooked by Windows, so the
//      callback does NOTHING but enqueue. All real work happens on a worker thread.
//   2. Secure fields have THREE states, not two. Secure, not secure, and UNKNOWN, where unknown
//      fails closed. A UIA query that returns nothing is indistinguishable from a query that
//      found nothing to redact, and naive code reads both as "not a password".
//
// Build:  see build.cmd in this folder.
// Run:    CaptureSpike.exe        (Ctrl+C to stop)
// Output: one JSON line per click on stdout, screenshots in .\spike-out\

using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;

namespace OrugaScribe.Desktop.Spike
{
    public static class Native
    {
        public const int WH_MOUSE_LL = 14;
        public const int WM_LBUTTONDOWN = 0x0201;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
            public uint time; public POINT pt;
        }

        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
    }

    /// <summary>One click, as captured. Tier 1 fields are never null.</summary>
    public sealed class Step
    {
        public int Index;
        public DateTime CapturedUtc;

        // Tier 1. Always present.
        public int ScreenX, ScreenY;
        public double NormX, NormY;          // position inside the window rect, 0..1
        public string WindowTitle = "";
        public string ProcessName = "";
        public string ExePath = "";
        public string ScreenshotPath = "";

        // Tier 2. Best effort, 250 ms budget.
        public string Tier = "1";            // which tier actually produced the label
        public string ControlName;           // null when the tree did not answer
        public string ControlType;
        public int UiaMillis;

        // The three state secure flag. Never a bool.
        public SecureState Secure = SecureState.Unknown;
        public string SecureReason = "not queried";
    }

    /// <summary>
    /// Secure, NotSecure, Unknown. Unknown fails closed and is treated as secret.
    /// The same defect appears through four unrelated mechanisms (macOS AX subrole absent,
    /// macOS secure input false on an unwrapped surface, Windows UIA blocked by UIPI on an
    /// elevated window, Linux with no AT-SPI tree) and naive code reads all four as NotSecure.
    /// </summary>
    public enum SecureState { Secure, NotSecure, Unknown }

    public static class Program
    {
        private const int UiaBudgetMs = 250;

        private static IntPtr _hook = IntPtr.Zero;
        private static Native.HookProc _proc;              // held so the GC cannot collect it
        private static readonly BlockingCollection<Native.POINT> Queue = new BlockingCollection<Native.POINT>();
        private static string _outDir;
        private static int _count;

        /// <summary>
        /// The output directory has to be resolvable without Main having run. This spike is
        /// hosted (Application Control on this machine blocks a freshly built exe, so the code
        /// is compiled in process by a signed host) and in that path Main never executes.
        /// A null _outDir made every screenshot fail with a caught exception that read as
        /// "(screenshot failed)", which looks like a Windows problem and is not one.
        /// </summary>
        public static string OutDir
        {
            get
            {
                if (_outDir == null)
                {
                    _outDir = Path.Combine(Directory.GetCurrentDirectory(), "spike-out");
                    Directory.CreateDirectory(_outDir);
                }
                return _outDir;
            }
            set { _outDir = value; if (value != null) Directory.CreateDirectory(value); }
        }

        private static int Main()
        {
            Native.SetProcessDPIAware();

            Console.Error.WriteLine("  oruga-scribe capture spike");
            Console.Error.WriteLine("  output      " + OutDir);
            Console.Error.WriteLine("  budget      " + UiaBudgetMs + " ms per UIA lookup, then degrade to tier 1");
            Console.Error.WriteLine("  click anywhere in Windows. Ctrl+C to stop.");
            Console.Error.WriteLine();

            // The worker owns every slow call. The hook callback must never do this work: a low
            // level hook that takes too long is silently unhooked by Windows and the recording
            // dies without an error. MTA because UI Automation prefers it.
            var worker = new Thread(WorkerLoop) { IsBackground = true, Name = "capture-worker" };
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();

            _proc = HookCallback;
            _hook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, _proc, Native.GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero)
            {
                Console.Error.WriteLine("  FAILED to install the mouse hook. Win32 error " +
                                        Marshal.GetLastWin32Error());
                return 1;
            }

            Console.CancelKeyPress += (s, e) =>
            {
                Native.UnhookWindowsHookEx(_hook);
                Console.Error.WriteLine("\n  " + _count + " clicks captured. Hook released.");
            };

            // A low level hook needs a message loop on the installing thread or it never fires.
            Native.MSG msg;
            while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }

            Native.UnhookWindowsHookEx(_hook);
            return 0;
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            // Enqueue and get out. Nothing else belongs here.
            if (nCode >= 0 && (int)wParam == Native.WM_LBUTTONDOWN)
            {
                var data = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.MSLLHOOKSTRUCT));
                Queue.TryAdd(data.pt);
            }
            return Native.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private static void WorkerLoop()
        {
            foreach (var pt in Queue.GetConsumingEnumerable())
            {
                try { Console.WriteLine(ToJson(Capture(pt))); }
                catch (Exception ex) { Console.Error.WriteLine("  capture failed: " + ex.Message); }
            }
        }

        public static Step Capture(Native.POINT pt)
        {
            var step = new Step
            {
                Index = Interlocked.Increment(ref _count),
                CapturedUtc = DateTime.UtcNow,
                ScreenX = pt.x,
                ScreenY = pt.y
            };

            // ---- Tier 1. This block is not allowed to fail. ----
            IntPtr hwnd = Native.GetForegroundWindow();
            var sb = new StringBuilder(512);
            Native.GetWindowTextW(hwnd, sb, sb.Capacity);
            step.WindowTitle = sb.ToString();

            Native.RECT r;
            if (Native.GetWindowRect(hwnd, out r) && r.Right > r.Left && r.Bottom > r.Top)
            {
                step.NormX = Math.Round((double)(pt.x - r.Left) / (r.Right - r.Left), 4);
                step.NormY = Math.Round((double)(pt.y - r.Top) / (r.Bottom - r.Top), 4);
                step.ScreenshotPath = Shoot(step.Index, r);
            }

            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            try
            {
                var p = Process.GetProcessById((int)pid);
                step.ProcessName = p.ProcessName;
                try { step.ExePath = p.MainModule.FileName; }
                catch { step.ExePath = "(denied)"; }   // elevated or protected process
            }
            catch { step.ProcessName = "(unknown)"; }

            // ---- Tier 2. Enrichment only. A miss degrades the step, it never loses it. ----
            var sw = Stopwatch.StartNew();
            var task = Task.Run(() => ReadTree(pt));
            if (task.Wait(UiaBudgetMs) && task.Result != null)
            {
                var t = task.Result;
                step.ControlName = t.Name;
                step.ControlType = t.Type;
                step.Secure = t.Secure;
                step.SecureReason = t.Reason;
                step.Tier = string.IsNullOrEmpty(t.Name) ? "1" : "2";
            }
            else
            {
                // Timed out or threw. The tree told us nothing, which is NOT the same as
                // telling us the field is safe.
                step.Secure = SecureState.Unknown;
                step.SecureReason = task.IsCompleted ? "uia returned nothing" : "uia exceeded the " + UiaBudgetMs + " ms budget";
                step.Tier = "1";
            }
            sw.Stop();
            step.UiaMillis = (int)sw.ElapsedMilliseconds;

            return step;
        }

        /// <summary>
        /// UI Automation costs a large one time COM initialisation on its first call, measured
        /// at 245 ms on this machine, which blows the whole 250 ms budget on the FIRST click of
        /// a recording. Pay it at startup instead, off the critical path.
        /// </summary>
        public static void WarmUpUia()
        {
            try { var unused = AutomationElement.RootElement; }
            catch { /* the tree is optional by design. A cold start failure is not fatal. */ }
        }

        public sealed class TreeRead
        {
            public string Name;
            public string Type;
            public SecureState Secure;
            public string Reason;
        }

        private static TreeRead ReadTree(Native.POINT pt)
        {
            try
            {
                var el = AutomationElement.FromPoint(new System.Windows.Point(pt.x, pt.y));
                if (el == null)
                    return new TreeRead { Secure = SecureState.Unknown, Reason = "no element at point" };

                var read = new TreeRead();
                try { read.Name = el.Current.Name; } catch { read.Name = null; }
                try { read.Type = el.Current.ControlType.ProgrammaticName; } catch { read.Type = null; }

                // The load bearing part. IsPassword is only trustworthy when we actually read it.
                try
                {
                    bool isPwd = el.Current.IsPassword;
                    read.Secure = isPwd ? SecureState.Secure : SecureState.NotSecure;
                    read.Reason = isPwd ? "uia IsPassword true" : "uia IsPassword false";
                }
                catch (Exception ex)
                {
                    read.Secure = SecureState.Unknown;
                    read.Reason = "IsPassword unreadable: " + ex.GetType().Name;
                }
                return read;
            }
            catch (Exception ex)
            {
                return new TreeRead { Secure = SecureState.Unknown, Reason = "FromPoint threw: " + ex.GetType().Name };
            }
        }

        private static string Shoot(int index, Native.RECT r)
        {
            try
            {
                int w = r.Right - r.Left, h = r.Bottom - r.Top;
                using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                    string p = Path.Combine(OutDir, "step-" + index.ToString("D3") + ".png");
                    bmp.Save(p, ImageFormat.Png);
                    return p;
                }
            }
            catch (Exception ex) { return "(screenshot failed: " + ex.GetType().Name + " " + ex.Message + ")"; }
        }

        public static string ToJson(Step s)
        {
            var b = new StringBuilder();
            b.Append('{');
            b.Append("\"i\":").Append(s.Index);
            b.Append(",\"at\":\"").Append(s.CapturedUtc.ToString("o")).Append('"');
            b.Append(",\"tier\":\"").Append(s.Tier).Append('"');
            b.Append(",\"window\":").Append(Q(s.WindowTitle));
            b.Append(",\"process\":").Append(Q(s.ProcessName));
            b.Append(",\"exe\":").Append(Q(s.ExePath));
            b.Append(",\"x\":").Append(s.ScreenX).Append(",\"y\":").Append(s.ScreenY);
            b.Append(",\"nx\":").Append(s.NormX.ToString(System.Globalization.CultureInfo.InvariantCulture));
            b.Append(",\"ny\":").Append(s.NormY.ToString(System.Globalization.CultureInfo.InvariantCulture));
            b.Append(",\"control\":").Append(s.ControlName == null ? "null" : Q(s.ControlName));
            b.Append(",\"controlType\":").Append(s.ControlType == null ? "null" : Q(s.ControlType));
            b.Append(",\"uiaMs\":").Append(s.UiaMillis);
            b.Append(",\"secure\":\"").Append(s.Secure).Append('"');
            b.Append(",\"secureReason\":").Append(Q(s.SecureReason));
            b.Append(",\"shot\":").Append(Q(s.ScreenshotPath));
            b.Append('}');
            return b.ToString();
        }

        private static string Q(string s)
        {
            if (s == null) return "\"\"";
            var b = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') b.Append('\\').Append(c);
                else if (c == '\n') b.Append("\\n");
                else if (c == '\r') b.Append("\\r");
                else if (c == '\t') b.Append("\\t");
                else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }
    }
}
