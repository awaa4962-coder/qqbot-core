namespace QQFriendLauncher.Config;

internal sealed class LauncherConfig
{
    public string ProjectDir { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".openclaw",
        "workspace",
        "qqfriend");
    public string NapCatExe { get; set; } = "";
    public string NapCatApi { get; set; } = "http://127.0.0.1:6700";
    public string BridgeHealthUrl { get; set; } = "http://127.0.0.1:16789/health";
    public string AdminToken { get; set; } = "";
    public bool AutoInstallDependencies { get; set; } = true;
    public bool AutoStartWatchdog { get; set; } = true;
    public bool AutoCheckJm { get; set; } = true;
    public bool AutoCheckSummaryModule { get; set; } = true;
    public int WaitNapCatSeconds { get; set; } = 90;
    public int WaitBridgeSeconds { get; set; } = 60;

    public string ResolvedNapCatExe()
    {
        if (!string.IsNullOrWhiteSpace(NapCatExe)) return NapCatExe;

        var fromEnvironment = Environment.GetEnvironmentVariable("QQBOT_NAPCAT_EXE");
        if (!string.IsNullOrWhiteSpace(fromEnvironment)) return Path.GetFullPath(fromEnvironment);

        var pathFile = Path.Combine(ProjectDir, ".env_napcat_exe");
        if (File.Exists(pathFile))
        {
            var configured = File.ReadAllText(pathFile).Trim();
            if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        }

        var napCatRoot = Path.Combine(ProjectDir, "NapCat");
        if (Directory.Exists(napCatRoot))
        {
            var versioned = Directory.GetDirectories(napCatRoot, "NapCat.v*.Shell")
                .Select(directory => new
                {
                    Directory = directory,
                    Version = ParseVersion(Path.GetFileName(directory)),
                })
                .Where(item => item.Version != null)
                .OrderByDescending(item => IsCompleteOfficialRuntime(item.Directory))
                .ThenByDescending(item => item.Version)
                .Select(item => Path.Combine(item.Directory, "NapCatWinBootMain.exe"))
                .FirstOrDefault(File.Exists);
            if (!string.IsNullOrWhiteSpace(versioned)) return versioned;
        }

        return Path.Combine(napCatRoot, "NapCat.44498.Shell", "NapCatWinBootMain.exe");
    }

    public System.Diagnostics.ProcessStartInfo CreateNapCatStartInfo()
    {
        var executable = ResolvedNapCatExe();
        var runtimeDir = Path.GetDirectoryName(executable) ?? ProjectDir;
        var mainModule = Path.Combine(runtimeDir, "napcat.mjs");
        var hook = Path.Combine(runtimeDir, "NapCatWinBootHook.dll");
        var qqExecutable = Path.Combine(runtimeDir, "QQ.exe");
        if (!File.Exists(mainModule) || !File.Exists(hook) || !File.Exists(qqExecutable))
        {
            return new System.Diagnostics.ProcessStartInfo(executable)
            {
                WorkingDirectory = runtimeDir,
                UseShellExecute = true,
            };
        }

        var loadModule = Path.Combine(runtimeDir, "loadNapCat.js");
        File.WriteAllText(
            loadModule,
            "(async () => {await import(\"" + new Uri(mainModule).AbsoluteUri + "\")})()\n");
        var startInfo = new System.Diagnostics.ProcessStartInfo(executable)
        {
            WorkingDirectory = runtimeDir,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(qqExecutable);
        startInfo.ArgumentList.Add(hook);
        var account = ReadNapCatAutoLoginAccount(Path.Combine(runtimeDir, "config", "webui.json"));
        if (!string.IsNullOrWhiteSpace(account))
        {
            startInfo.ArgumentList.Add("-q");
            startInfo.ArgumentList.Add(account);
        }

        startInfo.Environment["NAPCAT_PATCH_PACKAGE"] = Path.Combine(runtimeDir, "qqnt.json");
        startInfo.Environment["NAPCAT_LOAD_PATH"] = loadModule;
        startInfo.Environment["NAPCAT_INJECT_PATH"] = hook;
        startInfo.Environment["NAPCAT_LAUNCHER_PATH"] = executable;
        startInfo.Environment["NAPCAT_MAIN_PATH"] = mainModule;
        return startInfo;
    }

    private static string ReadNapCatAutoLoginAccount(string filename)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(filename));
            if (!document.RootElement.TryGetProperty("autoLoginAccount", out var value)) return "";
            var account = value.ValueKind == System.Text.Json.JsonValueKind.String
                ? value.GetString() ?? ""
                : value.ToString();
            return account.All(char.IsDigit) ? account : "";
        }
        catch
        {
            return "";
        }
    }

    private static Version? ParseVersion(string directoryName)
    {
        const string prefix = "NapCat.v";
        const string suffix = ".Shell";
        if (!directoryName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
            !directoryName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var value = directoryName[prefix.Length..^suffix.Length];
        return Version.TryParse(value, out var version) ? version : null;
    }

    private static bool IsCompleteOfficialRuntime(string runtimeDir)
    {
        return new[]
        {
            "NapCatWinBootMain.exe",
            "NapCatWinBootHook.dll",
            "QQ.exe",
            "napcat.mjs",
        }.All(filename => File.Exists(Path.Combine(runtimeDir, filename)));
    }
}
