using System.Text;

namespace QQFriendLauncher.Services;

internal sealed class LauncherLogger
{
    private readonly Func<string> _logsDir;
    private readonly Action<string> _uiWriter;

    public LauncherLogger(Func<string> logsDir, Action<string> uiWriter)
    {
        _logsDir = logsDir;
        _uiWriter = uiWriter;
    }

    public void Log(string text)
    {
        var line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + text;
        _uiWriter(line);
        try
        {
            Directory.CreateDirectory(_logsDir());
            File.AppendAllText(
                Path.Combine(_logsDir(), "launcher-" + DateTime.Now.ToString("yyyy-MM-dd") + ".log"),
                line + Environment.NewLine,
                Encoding.UTF8);
        }
        catch
        {
            // UI logging must not fail startup.
        }
    }

    public void AppendProcessLine(string logPath, string? line)
    {
        if (line == null) return;
        try
        {
            File.AppendAllText(logPath, line + Environment.NewLine, Encoding.UTF8);
        }
        catch
        {
            // Best-effort log capture.
        }
    }
}
