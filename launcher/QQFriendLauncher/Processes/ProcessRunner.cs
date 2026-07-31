using System.Diagnostics;
using System.Text;
using QQFriendLauncher.Services;

namespace QQFriendLauncher.Processes;

internal sealed class ProcessRunner
{
    private readonly LauncherLogger _logger;

    public ProcessRunner(LauncherLogger logger)
    {
        _logger = logger;
    }

    public async Task<bool> RunProcessAsync(
        string fileName,
        string args,
        string workingDir,
        string title,
        int timeoutMs,
        bool throwOnError = true)
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo(fileName, args)
            {
                WorkingDirectory = workingDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            },
        };

        var output = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var cts = new CancellationTokenSource(timeoutMs);
        try
        {
            await process.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            var message = title + " 超时。";
            _logger.Log(message);
            if (throwOnError) throw new TimeoutException(message);
            return false;
        }

        var text = output.ToString().Trim();
        if (!string.IsNullOrWhiteSpace(text)) _logger.Log(title + " 输出:\r\n" + TrimLog(text, 3000));
        if (process.ExitCode == 0)
        {
            _logger.Log(title + " 通过。");
            return true;
        }

        var fail = title + " 失败，ExitCode=" + process.ExitCode;
        _logger.Log(fail);
        if (throwOnError) throw new InvalidOperationException(fail);
        return false;
    }

    public Process StartLongProcess(string fileName, string args, string workingDir, string logPath, string logName)
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo(fileName, args)
            {
                WorkingDirectory = workingDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            },
            EnableRaisingEvents = true,
        };

        process.OutputDataReceived += (_, e) => _logger.AppendProcessLine(logPath, e.Data);
        process.ErrorDataReceived += (_, e) => _logger.AppendProcessLine(logPath, e.Data);
        process.Exited += (_, _) => _logger.Log(logName + " 已退出，ExitCode=" + process.ExitCode);
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _logger.Log(logName + " 已启动，PID: " + process.Id);
        return process;
    }

    public async Task<string> RunPowerShellAsync(string script, string workingDir, string title, bool logOutput = true)
    {
        var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command " + QuoteForProcess(script))
        {
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        using var process = Process.Start(psi) ?? throw new InvalidOperationException("无法启动 PowerShell");
        var output = await process.StandardOutput.ReadToEndAsync();
        var error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var text = (output + error).Trim();
        if (logOutput && !string.IsNullOrWhiteSpace(text)) _logger.Log(title + " 输出:\r\n" + TrimLog(text, 2000));
        return text;
    }

    public static void KillTrackedProcess(Process? process)
    {
        if (process == null) return;
        TryKill(process);
    }

    public static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(true);
        }
        catch
        {
            // Best effort.
        }
    }

    public static string QuoteForProcess(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    public static string TrimLog(string value, int maxChars)
    {
        if (value.Length <= maxChars) return value;
        return value[..maxChars] + "\r\n...(已截断)";
    }
}
