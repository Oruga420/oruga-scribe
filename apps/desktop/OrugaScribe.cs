// OrugaScribe.cs - the desktop recorder. Watches ONE monitor and writes down every click.
//
// The flow Alejandro asked for, end to end:
//   double click the desktop icon
//     -> pick which monitor to record, with a live preview of each one
//     -> a coloured frame appears around that monitor and pulses while recording
//     -> work normally. Every click inside that monitor becomes a step
//     -> Stop. The steps and screenshots land in out\session-<stamp>\
//
// Why this is not a standalone .exe: Smart App Control is enforced on this machine
// (VerifiedAndReputablePolicyState = 1) and blocks a freshly built binary with no reputation.
// A compiled exe AND a compiled dll were both blocked, the dll non deterministically, which is
// worse than a hard no. So the code is compiled in process by powershell.exe, which Windows
// already trusts. See run.ps1. The icon on the desktop points at that launcher, so from
// Alejandro's side it is still a double click.
//
// Two invariants carried over from the capture spike, both load bearing:
//   1. The mouse hook callback ONLY enqueues. A low level hook that blocks gets silently
//      unhooked by Windows and the recording dies with no error at all.
//   2. Secure fields have THREE states. Unknown fails closed. A UI Automation query that
//      returns nothing is not the same as a field that is not a password.
//
// And one found while building this:
//   3. The frame and the control panel must be excluded from screen capture, or every
//      screenshot contains the recording UI. SetWindowDisplayAffinity with
//      WDA_EXCLUDEFROMCAPTURE does it at the compositor, so the windows stay visible to
//      Alejandro and invisible to our own screenshots.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using WinFormsTimer = System.Windows.Forms.Timer;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Forms;

namespace OrugaScribe.Desktop
{
    public static class Native
    {
        public const int WH_MOUSE_LL = 14;
        public const int WM_LBUTTONDOWN = 0x0201;

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TRANSPARENT = 0x20;      // clicks fall through the frame
        public const int WS_EX_LAYERED = 0x80000;
        public const int WS_EX_TOOLWINDOW = 0x80;       // keeps the frame out of alt-tab

        // Windows 10 2004 and up. The window keeps rendering to the user and is removed from
        // anything that captures the screen, which is exactly what we need for our own overlay.
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;

        public const int WM_GETMINMAXINFO = 0x0024;

        [StructLayout(LayoutKind.Sequential)]
        public struct MINMAXINFO
        {
            public POINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

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
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    }

    public enum SecureState { Secure, NotSecure, Unknown }

    /// <summary>One click. Tier 1 fields are never null; tier 2 fields may be.</summary>
    public sealed class Step
    {
        public int Index;
        public DateTime CapturedUtc;
        public int ScreenX, ScreenY;
        public double NormX, NormY;
        public string WindowTitle = "";
        public string ProcessName = "";
        public string ExePath = "";
        public string ScreenshotPath = "";
        public string Tier = "1";
        public string ControlName;
        public string ControlType;
        public int UiaMillis;
        public SecureState Secure = SecureState.Unknown;
        public string SecureReason = "not queried";
    }

    // ---------------------------------------------------------------------------------------
    //  The coloured frame. Four thin always on top strips around the recorded monitor.
    //  Four strips rather than one big transparent window on purpose: no transparency key, no
    //  colour bleed, and nothing covering the middle of the screen that could ever eat a click.
    // ---------------------------------------------------------------------------------------
    /// <summary>
    /// A single edge of the frame.
    /// Windows refuses to make an ordinary window smaller than the system minimum tracking size,
    /// measured at 136 x 39 on this machine. A 6 pixel strip silently became a 39 pixel band
    /// across the top of the screen and 136 pixel bands down both sides, covering real content.
    /// The only way to get a genuinely thin window is to answer WM_GETMINMAXINFO and say the
    /// minimum is 1 x 1.
    /// </summary>
    public sealed class FrameStrip : Form
    {
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_GETMINMAXINFO)
            {
                var info = (Native.MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(Native.MINMAXINFO));
                info.ptMinTrackSize.x = 1;
                info.ptMinTrackSize.y = 1;
                Marshal.StructureToPtr(info, m.LParam, false);
                return;
            }
            base.WndProc(ref m);
        }
    }

    public sealed class RecordingFrame : IDisposable
    {
        // Proportional, not a fixed pixel count. The app makes itself DPI aware before any
        // window exists, so Screen.Bounds is in PHYSICAL pixels, while a DPI unaware host sees
        // logical ones. A hardcoded thickness renders at two different sizes depending on which
        // of those is true, so derive it from the monitor and the question stops existing.
        private readonly int _thickness;
        private readonly List<Form> _strips = new List<Form>();
        private readonly WinFormsTimer _pulse;
        private bool _bright = true;

        private static readonly Color Bright = Color.FromArgb(255, 64, 64);
        private static readonly Color Dim = Color.FromArgb(150, 20, 20);

        public RecordingFrame(Rectangle bounds)
        {
            _thickness = Math.Max(6, bounds.Height / 110);

            // top, bottom, left, right
            Add(new Rectangle(bounds.Left, bounds.Top, bounds.Width, _thickness));
            Add(new Rectangle(bounds.Left, bounds.Bottom - _thickness, bounds.Width, _thickness));
            Add(new Rectangle(bounds.Left, bounds.Top, _thickness, bounds.Height));
            Add(new Rectangle(bounds.Right - _thickness, bounds.Top, _thickness, bounds.Height));

            _pulse = new WinFormsTimer { Interval = 700 };
            _pulse.Tick += (s, e) =>
            {
                _bright = !_bright;
                foreach (var f in _strips) f.BackColor = _bright ? Bright : Dim;
            };
            _pulse.Start();
        }

        private void Add(Rectangle r)
        {
            var f = new FrameStrip
            {
                FormBorderStyle = FormBorderStyle.None,
                StartPosition = FormStartPosition.Manual,
                Bounds = r,
                BackColor = Bright,
                TopMost = true,
                ShowInTaskbar = false
            };
            f.Load += (s, e) =>
            {
                int ex = Native.GetWindowLong(f.Handle, Native.GWL_EXSTYLE);
                Native.SetWindowLong(f.Handle, Native.GWL_EXSTYLE,
                    ex | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED | Native.WS_EX_TOOLWINDOW);
                // Invisible to our own screenshots, still visible to Alejandro.
                Native.SetWindowDisplayAffinity(f.Handle, Native.WDA_EXCLUDEFROMCAPTURE);
            };
            f.Show();
            _strips.Add(f);
        }

        public void Dispose()
        {
            _pulse.Stop();
            _pulse.Dispose();
            foreach (var f in _strips) { try { f.Close(); f.Dispose(); } catch { } }
            _strips.Clear();
        }
    }

    // ---------------------------------------------------------------------------------------
    //  Monitor picker. Shows a real thumbnail of each monitor so there is no guessing which
    //  physical screen "Monitor 2" is.
    // ---------------------------------------------------------------------------------------
    public sealed class MonitorPicker : Form
    {
        public Screen Chosen { get; private set; }
        public string Goal { get { return _goal.Text.Trim(); } }

        private readonly ListBox _list = new ListBox();
        private readonly PictureBox _preview = new PictureBox();
        private readonly TextBox _goal = new TextBox();

        public MonitorPicker()
        {
            Text = "oruga-scribe";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            ClientSize = new Size(720, 460);
            BackColor = Color.FromArgb(24, 24, 27);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 9.75f);

            var head = new Label
            {
                Text = "Which monitor do you want to record?",
                Font = new Font("Segoe UI", 14f, FontStyle.Bold),
                ForeColor = Color.White,
                Bounds = new Rectangle(20, 16, 680, 30)
            };
            var sub = new Label
            {
                Text = "Everything you click on that monitor becomes a step. A red frame will show it is recording.",
                ForeColor = Color.FromArgb(160, 160, 170),
                Bounds = new Rectangle(20, 46, 680, 20)
            };

            _list.Bounds = new Rectangle(20, 78, 260, 190);
            _list.BackColor = Color.FromArgb(35, 35, 40);
            _list.ForeColor = Color.White;
            _list.BorderStyle = BorderStyle.FixedSingle;
            _list.SelectedIndexChanged += (s, e) => ShowPreview();

            _preview.Bounds = new Rectangle(296, 78, 404, 190);
            _preview.SizeMode = PictureBoxSizeMode.Zoom;
            _preview.BackColor = Color.FromArgb(35, 35, 40);
            _preview.BorderStyle = BorderStyle.FixedSingle;

            var goalLbl = new Label
            {
                Text = "What are you about to do?  (this becomes the title of the SOP)",
                ForeColor = Color.FromArgb(160, 160, 170),
                Bounds = new Rectangle(20, 286, 680, 20)
            };
            _goal.Bounds = new Rectangle(20, 308, 680, 26);
            _goal.BackColor = Color.FromArgb(35, 35, 40);
            _goal.ForeColor = Color.White;
            _goal.BorderStyle = BorderStyle.FixedSingle;

            var start = new Button
            {
                Text = "Start recording",
                Bounds = new Rectangle(516, 356, 184, 44),
                BackColor = Color.FromArgb(220, 50, 50),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 11f, FontStyle.Bold)
            };
            start.FlatAppearance.BorderSize = 0;
            start.Click += (s, e) =>
            {
                if (_list.SelectedIndex < 0) { MessageBox.Show("Pick a monitor first."); return; }
                Chosen = Screen.AllScreens[_list.SelectedIndex];
                DialogResult = DialogResult.OK;
                Close();
            };

            var cancel = new Button
            {
                Text = "Cancel",
                Bounds = new Rectangle(408, 356, 96, 44),
                BackColor = Color.FromArgb(45, 45, 52),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            cancel.FlatAppearance.BorderSize = 0;
            cancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };

            Controls.AddRange(new Control[] { head, sub, _list, _preview, goalLbl, _goal, start, cancel });
            AcceptButton = start;

            var screens = Screen.AllScreens;
            for (int i = 0; i < screens.Length; i++)
            {
                var b = screens[i].Bounds;
                _list.Items.Add("Monitor " + (i + 1) + "   " + b.Width + " x " + b.Height +
                                (screens[i].Primary ? "   (primary)" : ""));
            }
            if (_list.Items.Count > 0) _list.SelectedIndex = 0;
        }

        private void ShowPreview()
        {
            int i = _list.SelectedIndex;
            if (i < 0 || i >= Screen.AllScreens.Length) return;
            var b = Screen.AllScreens[i].Bounds;
            try
            {
                using (var full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(full))
                        g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
                    var old = _preview.Image;
                    _preview.Image = new Bitmap(full, new Size(404, 190));
                    if (old != null) old.Dispose();
                }
            }
            catch { /* a preview is a nicety, never a blocker */ }
        }
    }

    // ---------------------------------------------------------------------------------------
    //  The control panel. Small, always on top, parked in a corner of the recorded monitor.
    //  Also excluded from capture so it never lands in a screenshot.
    // ---------------------------------------------------------------------------------------
    public sealed class ControlPanel : Form
    {
        private readonly Label _dot = new Label();
        private readonly Label _time = new Label();
        private readonly Label _steps = new Label();
        private readonly WinFormsTimer _tick = new WinFormsTimer { Interval = 500 };
        private readonly DateTime _startedAt = DateTime.Now;
        private bool _blink;

        public event Action StopRequested;
        public int StepCount;

        public ControlPanel(Screen target, string goal)
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.FromArgb(18, 18, 20);
            Size = new Size(300, 96);
            Location = new Point(target.Bounds.Right - 320, target.Bounds.Top + 20);

            _dot.Text = "REC";
            _dot.ForeColor = Color.FromArgb(255, 64, 64);
            _dot.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
            _dot.Bounds = new Rectangle(14, 10, 60, 24);

            _time.Text = "00:00";
            _time.ForeColor = Color.White;
            _time.Font = new Font("Consolas", 13f);
            _time.Bounds = new Rectangle(76, 10, 90, 24);

            _steps.Text = "0 steps";
            _steps.ForeColor = Color.FromArgb(150, 150, 160);
            _steps.Bounds = new Rectangle(172, 14, 110, 20);

            var goalLbl = new Label
            {
                Text = string.IsNullOrEmpty(goal) ? "(no goal set)" : goal,
                ForeColor = Color.FromArgb(120, 120, 130),
                AutoEllipsis = true,
                Bounds = new Rectangle(14, 38, 180, 18)
            };

            var stop = new Button
            {
                Text = "Stop",
                Bounds = new Rectangle(196, 56, 90, 30),
                BackColor = Color.FromArgb(220, 50, 50),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            stop.FlatAppearance.BorderSize = 0;
            stop.Click += (s, e) => { var h = StopRequested; if (h != null) h(); };

            Controls.AddRange(new Control[] { _dot, _time, _steps, goalLbl, stop });

            _tick.Tick += (s, e) =>
            {
                _blink = !_blink;
                _dot.ForeColor = _blink ? Color.FromArgb(255, 64, 64) : Color.FromArgb(90, 25, 25);
                var el = DateTime.Now - _startedAt;
                _time.Text = ((int)el.TotalMinutes).ToString("D2") + ":" + el.Seconds.ToString("D2");
                _steps.Text = StepCount + (StepCount == 1 ? " step" : " steps");
            };
            _tick.Start();

            Load += (s, e) =>
            {
                int ex = Native.GetWindowLong(Handle, Native.GWL_EXSTYLE);
                Native.SetWindowLong(Handle, Native.GWL_EXSTYLE, ex | Native.WS_EX_TOOLWINDOW);
                Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE);
            };

            // Draggable by its own body, since it has no title bar.
            MouseDown += (s, e) => { if (e.Button == MouseButtons.Left) DragMove(); };
        }

        private void DragMove()
        {
            var start = Cursor.Position;
            var origin = Location;
            var t = new WinFormsTimer { Interval = 15 };
            t.Tick += (s, e) =>
            {
                if ((Control.MouseButtons & MouseButtons.Left) == 0) { t.Stop(); t.Dispose(); return; }
                var d = Cursor.Position;
                Location = new Point(origin.X + (d.X - start.X), origin.Y + (d.Y - start.Y));
            };
            t.Start();
        }
    }

    // ---------------------------------------------------------------------------------------
    //  The recorder itself.
    // ---------------------------------------------------------------------------------------
    public sealed class Recorder : IDisposable
    {
        private const int UiaBudgetMs = 250;

        private readonly Screen _target;
        private readonly string _outDir;
        private readonly BlockingCollection<Native.POINT> _queue = new BlockingCollection<Native.POINT>();
        private readonly List<Step> _steps = new List<Step>();
        private readonly StreamWriter _jsonl;
        private IntPtr _hook = IntPtr.Zero;
        private Native.HookProc _proc;
        private int _count;

        public event Action<int> StepCaptured;
        public string OutDir { get { return _outDir; } }
        public int Count { get { return _count; } }

        /// <summary>A snapshot, taken under the lock, because the worker thread is still writing.</summary>
        public List<Step> Snapshot()
        {
            lock (_steps) return new List<Step>(_steps);
        }

        public Recorder(Screen target, string goal, string root)
        {
            _target = target;
            _outDir = Path.Combine(root, "session-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"));
            Directory.CreateDirectory(_outDir);
            Directory.CreateDirectory(Path.Combine(_outDir, "screens"));

            _jsonl = new StreamWriter(Path.Combine(_outDir, "steps.jsonl"), false, new UTF8Encoding(false));
            _jsonl.AutoFlush = true;   // a crash must not cost the steps already captured
            File.WriteAllText(Path.Combine(_outDir, "goal.txt"), goal ?? "", new UTF8Encoding(false));

            var worker = new Thread(WorkerLoop) { IsBackground = true, Name = "capture-worker" };
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
        }

        public bool Start()
        {
            _proc = HookCallback;
            _hook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, _proc, Native.GetModuleHandle(null), 0);
            return _hook != IntPtr.Zero;
        }

        private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            // Enqueue and leave. Anything slow here and Windows unhooks us without a word.
            if (nCode >= 0 && (int)wParam == Native.WM_LBUTTONDOWN)
            {
                var d = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.MSLLHOOKSTRUCT));
                if (_target.Bounds.Contains(d.pt.x, d.pt.y)) _queue.TryAdd(d.pt);
            }
            return Native.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private void WorkerLoop()
        {
            foreach (var pt in _queue.GetConsumingEnumerable())
            {
                try
                {
                    var s = Capture(pt);
                    lock (_steps) _steps.Add(s);
                    _jsonl.WriteLine(ToJson(s));
                    var h = StepCaptured;
                    if (h != null) h(_count);
                }
                catch { /* one bad step never kills a recording */ }
            }
        }

        public static void WarmUpUia()
        {
            // Measured at 176 ms on this machine. Paying it here keeps the FIRST click of a
            // recording inside the 250 ms budget instead of blowing it and degrading to tier 1.
            try { var unused = AutomationElement.RootElement; } catch { }
        }

        private Step Capture(Native.POINT pt)
        {
            var step = new Step
            {
                Index = Interlocked.Increment(ref _count),
                CapturedUtc = DateTime.UtcNow,
                ScreenX = pt.x,
                ScreenY = pt.y
            };

            // Tier 1. Not allowed to fail.
            IntPtr hwnd = Native.GetForegroundWindow();
            var sb = new StringBuilder(512);
            Native.GetWindowTextW(hwnd, sb, sb.Capacity);
            step.WindowTitle = sb.ToString();

            Native.RECT r;
            if (Native.GetWindowRect(hwnd, out r) && r.Right > r.Left && r.Bottom > r.Top)
            {
                step.NormX = Math.Round((double)(pt.x - r.Left) / (r.Right - r.Left), 4);
                step.NormY = Math.Round((double)(pt.y - r.Top) / (r.Bottom - r.Top), 4);
            }

            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            try
            {
                var p = Process.GetProcessById((int)pid);
                step.ProcessName = p.ProcessName;
                try { step.ExePath = p.MainModule.FileName; } catch { step.ExePath = "(denied)"; }
            }
            catch { step.ProcessName = "(unknown)"; }

            // The whole recorded monitor, not just the window: context matters in an SOP, and
            // our own frame and panel are excluded from capture so they never show up here.
            step.ScreenshotPath = Shoot(step.Index);

            // Tier 2. Enrichment. A miss degrades the step, it never loses it.
            var sw = Stopwatch.StartNew();
            var task = Task.Run(() => ReadTree(pt));
            if (task.Wait(UiaBudgetMs) && task.Result != null)
            {
                var t = task.Result;
                step.ControlName = t.Name;
                step.ControlType = t.Type;
                step.Secure = t.Secure;
                step.SecureReason = t.Reason;
                step.Tier = IsUsefulName(t.Name, step.WindowTitle) ? "2" : "1";
                if (step.Tier == "1") step.ControlName = null;
            }
            else
            {
                step.Secure = SecureState.Unknown;
                step.SecureReason = task.IsCompleted
                    ? "uia returned nothing"
                    : "uia exceeded the " + UiaBudgetMs + " ms budget";
                step.Tier = "1";
            }
            sw.Stop();
            step.UiaMillis = (int)sw.ElapsedMilliseconds;

            return step;
        }

        /// <summary>
        /// A control name is only worth having if it names the CONTROL. On canvas applications
        /// (Blender, games, Flutter, Java Swing, Electron with accessibility off) the tree has
        /// nothing at the click point and UI Automation hands back the root element instead,
        /// whose Name is the window title. Alejandro's first real recording made this concrete:
        /// 5 of 11 steps counted as tier 2 carrying "(Unsaved) - Blender 5.1.1" as the label.
        ///
        /// Counting that as a hit is worse than admitting a miss, because the SOP writer then
        /// receives five identical fake labels and has to invent meaning for them. A degraded
        /// step that says so is honest; a step wearing the window title as a control name is not.
        /// </summary>
        public static bool IsUsefulName(string name, string windowTitle)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string n = name.Trim();
            if (n.Length == 0) return false;
            if (string.IsNullOrEmpty(windowTitle)) return true;

            string w = windowTitle.Trim();
            if (string.Equals(n, w, StringComparison.OrdinalIgnoreCase)) return false;

            // Windows prefixes a modified document title with "* ". The same element then reads
            // as a different string on the very next click, which would let it back through.
            if (string.Equals(n.TrimStart('*', ' '), w.TrimStart('*', ' '), StringComparison.OrdinalIgnoreCase))
                return false;

            return true;
        }

        public sealed class TreeRead
        {
            public string Name; public string Type; public SecureState Secure; public string Reason;
        }

        private static TreeRead ReadTree(Native.POINT pt)
        {
            try
            {
                var el = AutomationElement.FromPoint(new System.Windows.Point(pt.x, pt.y));
                if (el == null) return new TreeRead { Secure = SecureState.Unknown, Reason = "no element at point" };

                var read = new TreeRead();
                try { read.Name = el.Current.Name; } catch { read.Name = null; }
                try { read.Type = el.Current.ControlType.ProgrammaticName; } catch { read.Type = null; }
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

        private string Shoot(int index)
        {
            try
            {
                var b = _target.Bounds;
                using (var bmp = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(bmp))
                        g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
                    string p = Path.Combine(_outDir, "screens", "step-" + index.ToString("D3") + ".png");
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

        public void Dispose()
        {
            if (_hook != IntPtr.Zero) { Native.UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
            _queue.CompleteAdding();
            try { _jsonl.Flush(); _jsonl.Dispose(); } catch { }
        }
    }

    /// <summary>
    /// Synthesis takes tens of seconds and the app has no window left by then. Without this the
    /// screen looks like nothing happened and the user clicks the icon again.
    /// </summary>
    public sealed class WaitBox : Form
    {
        public WaitBox(int steps)
        {
            Text = "oruga-scribe";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false; MinimizeBox = false; ControlBox = false;
            ClientSize = new Size(420, 110);
            BackColor = Color.FromArgb(24, 24, 27);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 10f);
            Controls.Add(new Label
            {
                Text = "Writing the SOP from " + steps + " steps." + "\n" +
                       "This takes a moment and does not need the browser.",
                Bounds = new Rectangle(20, 24, 380, 60),
                ForeColor = Color.White
            });
        }
    }

    public static class App
    {
        /// <summary>Where the sources live. run.ps1 passes it, because a hosted assembly has no
        /// meaningful Location of its own to walk up from.</summary>
        public static string AppDir = "";

        /// <summary>Entry point called by run.ps1. Returns the output folder, or null if cancelled.</summary>
        public static string Run(string root, string appDir)
        {
            AppDir = appDir;
            Native.SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Recorder.WarmUpUia();

            Screen target;
            string goal;
            using (var picker = new MonitorPicker())
            {
                if (picker.ShowDialog() != DialogResult.OK) return null;
                target = picker.Chosen;
                goal = picker.Goal;
            }

            var recorder = new Recorder(target, goal, root);
            if (!recorder.Start())
            {
                MessageBox.Show("Could not install the mouse hook. Win32 error " +
                                Marshal.GetLastWin32Error(), "oruga-scribe");
                recorder.Dispose();
                return null;
            }

            var frame = new RecordingFrame(target.Bounds);
            var panel = new ControlPanel(target, goal);
            recorder.StepCaptured += n =>
            {
                try { panel.BeginInvoke((Action)(() => { panel.StepCount = n; })); } catch { }
            };
            panel.StopRequested += () => panel.Close();
            panel.FormClosed += (s, e) => Application.ExitThread();
            panel.Show();

            Application.Run();

            frame.Dispose();
            recorder.Dispose();

            var captured = recorder.Snapshot();
            if (captured.Count == 0)
            {
                MessageBox.Show("No clicks were captured, so there is no SOP to write.",
                                "oruga-scribe");
                return recorder.OutDir;
            }

            // The recording is already on disk and must survive whatever happens next. A failed
            // API call loses the document, never the steps.
            try
            {
                using (var wait = new WaitBox(captured.Count))
                {
                    wait.Show();
                    Application.DoEvents();
                    string sop = SopWriter.Write(recorder.OutDir, captured, goal, AppDir);
                    wait.Close();
                    if (MessageBox.Show("SOP written." + "\n\n" + sop + "\n\nOpen it?", "oruga-scribe",
                                        MessageBoxButtons.YesNo, MessageBoxIcon.Information)
                        == DialogResult.Yes)
                        Process.Start(new ProcessStartInfo(sop) { UseShellExecute = true });
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message + "\n\nThe recording is intact:\n" + recorder.OutDir,
                                "oruga-scribe: the SOP was not written",
                                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }

            return recorder.OutDir;
        }
    }
}
