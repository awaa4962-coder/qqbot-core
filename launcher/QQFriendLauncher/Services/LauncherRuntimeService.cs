using System.Diagnostics;
using System.Net.NetworkInformation;
using QQFriendLauncher.Config;
using QQFriendLauncher.Processes;

namespace QQFriendLauncher.Services;

internal sealed class LauncherRuntimeService
{
    private readonly LauncherConfig _config;
    private readonly LauncherLogger _logger;
    private readonly ProcessRunner _runner;
    private readonly NodeToolResolver _nodeTools;
    private readonly NapCatClient _napCat;
    private readonly BridgeClient _bridge;
    private Process? _bridgeProcess;
    private Process? _watchdogProcess;

    public LauncherRuntimeService(
        LauncherConfig config,
        LauncherLogger logger,
        ProcessRunner runner,
        NodeToolResolver nodeTools,
        NapCatClient napCat,
        BridgeClient bridge)
    {
        _config = config;
        _logger = logger;
        _runner = runner;
        _nodeTools = nodeTools;
        _napCat = napCat;
        _bridge = bridge;
    }

    public void LogToolStatus()
    {
        _logger.Log("Node: " + _nodeTools.NodeExe);
        _logger.Log("npm CLI: " + (string.IsNullOrWhiteSpace(_nodeTools.NpmCliJs) ? "fallback to npm command" : _nodeTools.NpmCliJs));
    }

    public async Task StartAllAsync()
    {
        EnsureProjectDir();
        await CheckNodeAsync();
        await EnsureDependenciesAsync();
        await StartNapCatAsync();
        await StartBridgeAsync();
        if (_config.AutoStartWatchdog) await StartWatchdogAsync();
        if (_config.AutoCheckJm) await CheckJmAsync();
        if (_config.AutoCheckSummaryModule) await CheckSummaryModuleAsync();
        await HealthCheckAsync();
    }

    public async Task HealthCheckAsync()
    {
        EnsureProjectDir();
        _logger.Log("开始健康检查。");
        var napcat = await _napCat.CheckDetailedAsync();
        _logger.Log("NapCat OneBot: " + (napcat.IsReady ? "OK" : "未就绪 - " + napcat.Detail));

        var bridge = await _bridge.CheckDetailedAsync();
        _logger.Log("Bridge /health: " + (bridge.IsReady ? "OK" : "未就绪 - " + bridge.Detail));

        if (_config.AutoCheckJm) await CheckJmAsync();
        if (_config.AutoCheckSummaryModule) await CheckSummaryModuleAsync();

        if (!napcat.IsReady || !bridge.IsReady)
        {
            var failures = new List<string>();
            if (!napcat.IsReady) failures.Add("NapCat " + napcat.Detail);
            if (!bridge.IsReady) failures.Add("Bridge " + bridge.Detail);
            throw new InvalidOperationException("健康检查未通过：" + string.Join("；", failures));
        }
    }

    public async Task RestartBridgeAsync()
    {
        EnsureProjectDir();
        _logger.Log("正在停止 Bridge 进程。");
        await StopNodeEntrypointsAsync("napcat_bridge\\.mjs");
        await StartBridgeAsync();
        await HealthCheckAsync();
    }

    public async Task StopBridgeAndWatchdogAsync()
    {
        EnsureProjectDir();
        _logger.Log("正在停止 Bridge 和 watchdog。");
        ProcessRunner.KillTrackedProcess(_bridgeProcess);
        ProcessRunner.KillTrackedProcess(_watchdogProcess);
        _bridgeProcess = null;
        _watchdogProcess = null;
        await StopNodeEntrypointsAsync("napcat_bridge\\.mjs|scripts[\\\\/]watchdog\\.mjs");
    }

    public async Task StopAllAsync()
    {
        await StopBridgeAndWatchdogAsync();
        await StopNapCatAsync();
    }

    public async Task StopNapCatAsync()
    {
        var runtimeDir = Path.GetDirectoryName(_config.ResolvedNapCatExe()) ?? _config.ProjectDir;
        var escapedRuntime = runtimeDir.Replace("'", "''");
        var script =
            "$runtime = '" + escapedRuntime + "';" +
            "Get-CimInstance Win32_Process | Where-Object { " +
            "$_.ExecutablePath -and " +
            "[IO.Path]::GetDirectoryName($_.ExecutablePath) -eq $runtime -and " +
            "@('NapCatWinBootMain.exe', 'QQ.exe') -contains $_.Name } | " +
            "Sort-Object { if ($_.Name -eq 'QQ.exe') { 0 } else { 1 } } | " +
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
        await _runner.RunPowerShellAsync(
            script,
            _config.ProjectDir,
            "停止 NapCat");
    }

    public string LogsDir()
    {
        return Path.Combine(_config.ProjectDir, "logs");
    }

    private async Task CheckNodeAsync()
    {
        _logger.Log("检查 Node.js / npm。");
        await _runner.RunProcessAsync(_nodeTools.NodeExe, "--version", _config.ProjectDir, "node --version", 15_000);
        await RunNpmAsync("--version", "npm --version", 15_000);
    }

    private async Task EnsureDependenciesAsync()
    {
        if (Directory.Exists(Path.Combine(_config.ProjectDir, "node_modules")))
        {
            _logger.Log("node_modules 已存在，跳过 npm ci。");
            return;
        }

        if (!_config.AutoInstallDependencies)
        {
            _logger.Log("node_modules 不存在，且 AutoInstallDependencies=false，跳过自动安装。");
            return;
        }

        _logger.Log("node_modules 不存在，执行 npm ci。");
        await RunNpmAsync("ci", "npm ci", 10 * 60_000);
    }

    private async Task StartNapCatAsync()
    {
        var exe = _config.ResolvedNapCatExe();
        var existing = FindNapCatProcessIds(exe);
        var initial = await _napCat.CheckDetailedAsync();
        if (initial.IsReady)
        {
            _logger.Log("NapCat OneBot 已在线。");
            LogDuplicateNapCatProcesses(existing);
            return;
        }

        if (existing.Count > 0)
        {
            _logger.Log("NapCat 进程已存在，PID: " + string.Join(", ", existing) + "；等待 OneBot 就绪，不重复启动。");
            var existingReady = await WaitUntilAsync(_napCat.CheckAsync, TimeSpan.FromSeconds(_config.WaitNapCatSeconds));
            if (existingReady)
            {
                _logger.Log("NapCat OneBot 已就绪。");
            }
            else
            {
                var final = await _napCat.CheckDetailedAsync();
                _logger.Log("NapCat 进程仍在运行，但 OneBot 未就绪 - " + final.Detail);
            }
            LogDuplicateNapCatProcesses(existing);
            return;
        }

        if (!File.Exists(exe))
        {
            _logger.Log("找不到 NapCat: " + exe);
            return;
        }

        _logger.Log("启动 NapCat: " + exe);
        Process.Start(_config.CreateNapCatStartInfo());

        var ok = await WaitUntilAsync(_napCat.CheckAsync, TimeSpan.FromSeconds(_config.WaitNapCatSeconds));
        if (ok)
        {
            _logger.Log("NapCat OneBot 已就绪。");
        }
        else
        {
            var final = await _napCat.CheckDetailedAsync();
            _logger.Log("NapCat 仍未就绪，可能需要扫码登录或等待插件加载 - " + final.Detail);
        }
    }

    private async Task StartBridgeAsync()
    {
        var initial = await _bridge.CheckDetailedAsync();
        if (initial.IsReady)
        {
            _logger.Log("Bridge 已在线。");
            return;
        }

        var existing = await FindNodeEntrypointProcessIdsAsync("napcat_bridge\\.mjs");
        if (existing.Count > 0)
        {
            _logger.Log("Bridge 进程已存在，PID: " + string.Join(", ", existing) + "；等待 /health 就绪，不重复启动。");
            var existingReady = await WaitUntilAsync(_bridge.CheckAsync, TimeSpan.FromSeconds(_config.WaitBridgeSeconds));
            if (existingReady)
            {
                _logger.Log("Bridge /health 已就绪。");
                return;
            }

            var final = await _bridge.CheckDetailedAsync();
            throw new InvalidOperationException(
                "Bridge 进程存在但 /health 未就绪，PID: " + string.Join(", ", existing) + "；" + final.Detail);
        }

        if (IsBridgePortListening())
        {
            throw new InvalidOperationException(
                "Bridge 端口 " + BridgePort() + " 已被其他进程占用；为避免重复启动，已取消本次操作。");
        }

        _logger.Log("启动 QQFriend Bridge。");
        _bridgeProcess = StartLongNodeProcess("napcat_bridge.mjs", "bridge");

        var ok = await WaitUntilAsync(_bridge.CheckAsync, TimeSpan.FromSeconds(_config.WaitBridgeSeconds));
        if (ok)
        {
            _logger.Log("Bridge /health 已就绪。");
            return;
        }

        var failed = await _bridge.CheckDetailedAsync();
        _logger.Log("Bridge 暂未就绪 - " + failed.Detail);
        throw new InvalidOperationException("Bridge 启动后 /health 未就绪：" + failed.Detail);
    }

    private async Task StartWatchdogAsync()
    {
        var existing = await FindNodeEntrypointProcessIdsAsync("scripts[\\\\/]watchdog\\.mjs");
        if (existing.Count > 0)
        {
            _logger.Log("watchdog 已在运行，PID: " + string.Join(", ", existing));
            return;
        }

        _logger.Log("启动 watchdog 保活。");
        _watchdogProcess = StartLongNodeProcess("scripts/watchdog.mjs", "watchdog");
    }

    private async Task CheckJmAsync()
    {
        _logger.Log("检查 JM 运行时。");
        var ok = await RunNpmAsync("run check:jm", "npm run check:jm", 120_000, false);
        if (ok || !_config.AutoInstallDependencies) return;

        _logger.Log("JM 运行时缺依赖，执行自动安装后复查。");
        await RunNpmAsync("run check:jm:install", "npm run check:jm:install", 10 * 60_000, false);
        await RunNpmAsync("run check:jm", "npm run check:jm", 120_000, false);
    }

    private async Task CheckSummaryModuleAsync()
    {
        _logger.Log("检查日报模块导入。");
        var js = "import('./bridge/group-summary/index.mjs').then(()=>console.log('summary module ok')).catch(e=>{console.error(e?.stack||e?.message||e);process.exit(1)})";
        await _runner.RunProcessAsync(_nodeTools.NodeExe, "-e " + ProcessRunner.QuoteForProcess(js), _config.ProjectDir, "summary module import", 60_000, false);
    }

    private Process StartLongNodeProcess(string entrypoint, string logName)
    {
        Directory.CreateDirectory(LogsDir());
        var logPath = Path.Combine(LogsDir(), "launcher-" + logName + "-" + Stamp() + ".log");
        _logger.Log(logName + " 日志: " + logPath);
        return _runner.StartLongProcess(_nodeTools.NodeExe, ProcessRunner.QuoteForProcess(entrypoint), _config.ProjectDir, logPath, logName);
    }

    private async Task<bool> RunNpmAsync(string args, string title, int timeoutMs, bool throwOnError = true)
    {
        if (!string.IsNullOrWhiteSpace(_nodeTools.NpmCliJs) && File.Exists(_nodeTools.NpmCliJs))
        {
            return await _runner.RunProcessAsync(
                _nodeTools.NodeExe,
                ProcessRunner.QuoteForProcess(_nodeTools.NpmCliJs) + " " + args,
                _config.ProjectDir,
                title,
                timeoutMs,
                throwOnError);
        }

        return await _runner.RunProcessAsync(
            "cmd.exe",
            "/d /s /c " + ProcessRunner.QuoteForProcess("npm " + args),
            _config.ProjectDir,
            title,
            timeoutMs,
            throwOnError);
    }

    private async Task StopNodeEntrypointsAsync(string pattern)
    {
        var script =
            "$pattern = '" + pattern.Replace("'", "''") + "';" +
            "Get-CimInstance Win32_Process | Where-Object { " +
            "$_.Name -eq 'node.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -match $pattern } | " +
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
        await _runner.RunPowerShellAsync(script, _config.ProjectDir, "停止 Node 入口");
    }

    private async Task<List<int>> FindNodeEntrypointProcessIdsAsync(string pattern)
    {
        var script =
            "$pattern = '" + pattern.Replace("'", "''") + "';" +
            "Get-CimInstance Win32_Process | Where-Object { " +
            "$_.Name -eq 'node.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -match $pattern } | " +
            "Select-Object -ExpandProperty ProcessId";
        var output = await _runner.RunPowerShellAsync(script, _config.ProjectDir, "查找进程", false);
        return output
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(value => int.TryParse(value, out var pid) ? pid : 0)
            .Where(pid => pid > 0)
            .Distinct()
            .ToList();
    }

    private static List<int> FindNapCatProcessIds(string exe)
    {
        var expectedDirectory = Path.GetDirectoryName(Path.GetFullPath(exe)) ?? "";
        var result = new List<int>();

        foreach (var processName in new[] { "NapCatWinBootMain", "QQ" })
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                using (process)
                {
                    try
                    {
                        var actualPath = process.MainModule?.FileName;
                        var actualDirectory = string.IsNullOrWhiteSpace(actualPath)
                            ? ""
                            : Path.GetDirectoryName(Path.GetFullPath(actualPath)) ?? "";
                        if (!actualDirectory.Equals(expectedDirectory, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                    }
                    catch
                    {
                        // If the path cannot be inspected, do not treat an arbitrary QQ process as NapCat.
                        if (processName.Equals("QQ", StringComparison.OrdinalIgnoreCase)) continue;
                    }

                    result.Add(process.Id);
                }
            }
        }

        return result.Distinct().Order().ToList();
    }

    private void LogDuplicateNapCatProcesses(IReadOnlyCollection<int> processIds)
    {
        if (processIds.Count <= 1) return;
        _logger.Log("检测到多个 NapCat 启动进程，PID: " + string.Join(", ", processIds) + "；本次不会继续启动新的实例。");
    }

    private int BridgePort()
    {
        return Uri.TryCreate(_config.BridgeHealthUrl, UriKind.Absolute, out var uri)
            ? uri.Port
            : 16789;
    }

    private bool IsBridgePortListening()
    {
        var port = BridgePort();
        try
        {
            return IPGlobalProperties.GetIPGlobalProperties()
                .GetActiveTcpListeners()
                .Any(endpoint => endpoint.Port == port);
        }
        catch
        {
            return false;
        }
    }

    private void EnsureProjectDir()
    {
        if (!Directory.Exists(_config.ProjectDir))
        {
            throw new DirectoryNotFoundException("项目目录不存在: " + _config.ProjectDir);
        }
    }

    private static async Task<bool> WaitUntilAsync(Func<Task<bool>> check, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.Now + timeout;
        while (DateTimeOffset.Now < deadline)
        {
            if (await check()) return true;
            await Task.Delay(1500);
        }
        return false;
    }

    private static string Stamp()
    {
        return DateTime.Now.ToString("yyyyMMdd-HHmmss");
    }
}
