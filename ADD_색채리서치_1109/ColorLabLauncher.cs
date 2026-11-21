using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class ColorLabLauncher
{
    private const string Title = "송정동 거리 색채 연구";

    [STAThread]
    private static int Main(string[] args)
    {
        string verificationPath = args.Length == 2 && args[0] == "--verify" ? args[1] : null;
        try
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string python = Path.Combine(folder, "runtime", "python.exe");
            string server = Path.Combine(folder, "server.py");
            if (!File.Exists(python) || !File.Exists(server))
                throw new InvalidOperationException("ZIP의 모든 파일을 같은 폴더에 압축 해제한 뒤 실행하세요.");

            string id;
            using (var sha = SHA256.Create())
                id = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(
                    Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant()
                ))).Replace("-", "").Substring(0, 24);
            string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SongjeongColorLab", "instances");
            Directory.CreateDirectory(state);
            string addressFile = Path.Combine(state, id + ".txt");

            using (var mutex = new Mutex(false, @"Local\SongjeongColorLab-" + id))
            {
                bool owns;
                try { owns = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { owns = true; }
                if (!owns)
                {
                    if (verificationPath != null)
                        throw new InvalidOperationException("이 폴더의 프로그램이 이미 실행 중입니다.");
                    for (int i = 0; i < 50; i++)
                    {
                        string address;
                        if (File.Exists(addressFile) && IsLocalAddress(File.ReadAllText(addressFile).Trim(), out address))
                        {
                            Open(address);
                            return 0;
                        }
                        Thread.Sleep(100);
                    }
                    throw new InvalidOperationException("실행 준비 중입니다. 잠시 후 다시 열어 주세요.");
                }
                try { return Run(python, server, folder, addressFile, verificationPath); }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            if (verificationPath != null) File.WriteAllText(verificationPath, error.ToString());
            else MessageBox.Show(error.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static int Run(string python, string server, string folder, string addressFile, string verificationPath)
    {
        if (File.Exists(addressFile)) File.Delete(addressFile);
        var start = new ProcessStartInfo(python,
            "-B -X utf8 \"" + server + "\" --no-open " +
            (verificationPath == null ? "--fallback-port" : "--port 0"));
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = Encoding.UTF8;
        start.StandardErrorEncoding = Encoding.UTF8;
        start.WorkingDirectory = folder;

        string url = null;
        var errors = new StringBuilder();
        using (var ready = new ManualResetEvent(false))
        using (var child = new Process { StartInfo = start, EnableRaisingEvents = true })
        {
            child.OutputDataReceived += (sender, value) =>
            {
                string address;
                if (value.Data != null && IsLocalAddress(value.Data, out address))
                {
                    url = address;
                    ready.Set();
                }
            };
            child.ErrorDataReceived += (sender, value) =>
            {
                if (value.Data == null) return;
                lock (errors) { if (errors.Length < 3000) errors.AppendLine(value.Data); }
            };
            child.Exited += (sender, value) => ready.Set();
            child.Start();
            try
            {
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                if (!ready.WaitOne(25000) || url == null || child.HasExited)
                    throw new InvalidOperationException("프로그램을 시작하지 못했습니다.\n" + errors);
                if (verificationPath != null)
                {
                    using (var client = new WebClient { Proxy = null })
                        File.WriteAllText(verificationPath, client.DownloadString(url + "api/analysis/info"));
                    return 0;
                }

                File.WriteAllText(addressFile, url);
                Open(url);
                using (var menu = new ContextMenuStrip())
                using (var tray = new NotifyIcon())
                using (var timer = new System.Windows.Forms.Timer { Interval = 1000 })
                {
                    menu.Items.Add("브라우저에서 열기", null, (sender, value) => Open(url));
                    menu.Items.Add("프로그램 종료", null, (sender, value) =>
                    {
                        if (MessageBox.Show("진행 중인 수집과 분석을 마쳤다면 종료하세요.", Title,
                                            MessageBoxButtons.OKCancel) == DialogResult.OK)
                            Application.ExitThread();
                    });
                    tray.Icon = SystemIcons.Application;
                    tray.Text = Title;
                    tray.ContextMenuStrip = menu;
                    tray.DoubleClick += (sender, value) => Open(url);
                    tray.Visible = true;
                    timer.Tick += (sender, value) => { if (child.HasExited) Application.ExitThread(); };
                    timer.Start();
                    Application.Run();
                    tray.Visible = false;
                }
                return 0;
            }
            finally
            {
                if (!child.HasExited)
                {
                    try { child.Kill(); }
                    catch (InvalidOperationException) { }
                }
                child.WaitForExit();
                if (File.Exists(addressFile)) File.Delete(addressFile);
            }
        }
    }

    private static bool IsLocalAddress(string line, out string url)
    {
        url = null;
        Uri address;
        if (!Uri.TryCreate(line.Trim(), UriKind.Absolute, out address) ||
            address.Scheme != Uri.UriSchemeHttp || address.Host != "127.0.0.1" ||
            address.AbsolutePath != "/" || address.Query.Length != 0 || address.UserInfo.Length != 0)
            return false;
        url = address.AbsoluteUri;
        return true;
    }

    private static void Open(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
