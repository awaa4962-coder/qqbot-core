using System.Drawing;
using System.Drawing.Drawing2D;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace QQFriendLauncher.App;

internal sealed partial class LauncherForm
{
    private readonly WebView2 _homeWebView = new();
    private bool _homeReady;

    private TabPage BuildHomePage()
    {
        var page = new TabPage("主页");
        _homeWebView.Dock = DockStyle.Fill;
        page.Controls.Add(_homeWebView);
        return page;
    }

    private async Task InitializeHomePageAsync()
    {
        try
        {
            await _homeWebView.EnsureCoreWebView2Async();
            _homeWebView.CoreWebView2.WebMessageReceived += (_, args) => _ = HandleHomeMessageAsync(args);
            _homeWebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;

            var indexPath = Path.Combine(AppContext.BaseDirectory, "Web", "index.html");
            if (File.Exists(indexPath))
            {
                _homeWebView.Source = new Uri(indexPath);
                _mainTabs.SelectedIndex = 0;
                UpdateNativeNavigationVisibility();
            }
            else
            {
                _homeWebView.NavigateToString(HomeFallbackHtml("找不到 Web/index.html，发布目录不完整。"));
            }

            _homeReady = true;
        }
        catch (Exception ex)
        {
            _homeReady = false;
            _homeWebView.NavigateToString(HomeFallbackHtml("WebView2 初始化失败：" + ex.Message));
        }
    }

    private async Task HandleHomeMessageAsync(CoreWebView2WebMessageReceivedEventArgs args)
    {
        var id = "";
        var action = "";

        try
        {
            using var doc = JsonDocument.Parse(args.WebMessageAsJson);
            var root = doc.RootElement;
            id = ReadHomeString(root, "id");
            action = ReadHomeString(root, "action");
            var payload = root.TryGetProperty("payload", out var payloadElement)
                ? payloadElement.GetRawText()
                : "{}";

            var data = await ExecuteHomeActionAsync(action, payload);
            PostHomeMessage(new JsonObject
            {
                ["id"] = id,
                ["action"] = action,
                ["ok"] = true,
                ["data"] = data,
            });
        }
        catch (Exception ex)
        {
            PostHomeMessage(new JsonObject
            {
                ["id"] = id,
                ["action"] = action,
                ["ok"] = false,
                ["error"] = ex.Message,
            });
        }
    }

    private async Task<JsonNode?> ExecuteHomeActionAsync(string action, string payload)
    {
        return action switch
        {
            "ready" => BuildLauncherInfo(),
            "refresh" => await BuildHomeSnapshotAsync(),
            "refreshStatus" => JsonNode.Parse(await _adminClient.GetStatusJsonAsync()),
            "getCapabilities" => JsonNode.Parse(await _adminClient.GetCapabilitiesJsonAsync()),
            "getLogs" => JsonNode.Parse(await _adminClient.GetLogsJsonAsync("", 120)),
            "getConfig" => JsonNode.Parse(await _adminClient.GetConfigJsonAsync()),
            "refreshConfig" => JsonNode.Parse(await _adminClient.GetConfigJsonAsync()),
            "saveConfig" => JsonNode.Parse(await _adminClient.SaveConfigJsonAsync(payload)),
            "getApiProviders" => JsonNode.Parse(await _adminClient.GetApiProvidersJsonAsync()),
            "manageApiProviders" => JsonNode.Parse(await _adminClient.ManageApiProvidersJsonAsync(payload)),
            "getBackground" => BuildBackgroundState(),
            "setBackground" => SetBackground(payload),
            "chooseBackgroundImage" => ChooseBackgroundImage(),
            "startAll" => await RunHomeOperationAsync("启动全部", _runtime.StartAllAsync, true),
            "health" => await RunHomeOperationAsync("健康检查", _runtime.HealthCheckAsync, true),
            "restartBridge" => await RunHomeOperationAsync("重启 Bridge", _runtime.RestartBridgeAsync, true),
            "stopBridge" => await RunHomeStopOperationAsync(),
            "stopAll" => await RunHomeStopAllOperationAsync(),
            "createBackup" => JsonNode.Parse(await _adminClient.CreateBackupJsonAsync()),
            "diagnose" => JsonNode.Parse(await _adminClient.DiagnoseReplyJsonAsync(payload)),
            "getMemes" => JsonNode.Parse(await _adminClient.GetMemesJsonAsync()),
            "getStickers" => JsonNode.Parse(await _adminClient.GetStickersJsonAsync()),
            "manageStickers" => JsonNode.Parse(await _adminClient.ManageStickersJsonAsync(payload)),
            "saveMeme" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "toggleMeme" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "deleteMeme" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "clearMemeCandidates" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "runMemeWebUpdate" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "researchMemeWeb" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "rollbackMemeWebUpdate" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "restoreMemeHistory" => JsonNode.Parse(await _adminClient.SaveMemeJsonAsync(payload)),
            "openLogs" => OpenLogsAndReturn(),
            "openNativePage" => OpenNativePage(payload),
            _ => throw new InvalidOperationException("未知主页动作: " + action),
        };
    }

    private JsonObject OpenNativePage(string payload)
    {
        using var doc = JsonDocument.Parse(payload);
        var pageName = ReadHomeString(doc.RootElement, "page");
        var page = _mainTabs.TabPages.Cast<TabPage>().FirstOrDefault(item => item.Text == pageName);
        if (page == null)
        {
            throw new InvalidOperationException("找不到高级页面: " + pageName);
        }

        _mainTabs.SelectedTab = page;
        return new JsonObject
        {
            ["message"] = "已打开" + pageName,
            ["page"] = pageName,
        };
    }

    private async Task<JsonObject> BuildHomeSnapshotAsync()
    {
        var statusTask = _adminClient.GetStatusJsonAsync();
        var configTask = _adminClient.GetConfigJsonAsync();
        var logsTask = _adminClient.GetLogsJsonAsync("", 80);
        await Task.WhenAll(statusTask, configTask, logsTask);

        return new JsonObject
        {
            ["launcher"] = BuildLauncherInfo(),
            ["status"] = JsonNode.Parse(await statusTask),
            ["config"] = JsonNode.Parse(await configTask),
            ["logs"] = JsonNode.Parse(await logsTask),
        };
    }

    private async Task<JsonObject> BuildHomeStatusSnapshotAsync()
    {
        return new JsonObject
        {
            ["status"] = JsonNode.Parse(await _adminClient.GetStatusJsonAsync()),
        };
    }

    private async Task RefreshHomeSnapshotAsync()
    {
        if (!_homeReady || _homeWebView.CoreWebView2 == null) return;
        try
        {
            PostHomeMessage(new JsonObject
            {
                ["action"] = "snapshot",
                ["ok"] = true,
                ["data"] = await BuildHomeSnapshotAsync(),
            });
        }
        catch
        {
            // Native pages still refresh even when the WebView home is unavailable.
        }
    }

    private async Task<JsonObject> RunHomeOperationAsync(string title, Func<Task> operation, bool includeSnapshot)
    {
        if (_busy) throw new InvalidOperationException("已有任务正在执行，请稍等。");

        SetBusy(true, title + "中...");
        try
        {
            await operation();
            var result = new JsonObject
            {
                ["message"] = title + "完成",
            };

            if (includeSnapshot)
            {
                result["snapshot"] = await BuildHomeStatusSnapshotAsync();
            }

            return result;
        }
        finally
        {
            SetBusy(false, "就绪");
        }
    }

    private async Task<JsonObject> RunHomeStopOperationAsync()
    {
        var result = await RunHomeOperationAsync("停止 Bridge", _runtime.StopBridgeAndWatchdogAsync, false);
        result["runtimeState"] = "stopped";
        result["generatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        return result;
    }

    private async Task<JsonObject> RunHomeStopAllOperationAsync()
    {
        var result = await RunHomeOperationAsync("停止全部", _runtime.StopAllAsync, false);
        result["runtimeState"] = "stopped";
        result["generatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        return result;
    }

    private JsonObject OpenLogsAndReturn()
    {
        OpenLogs();
        return new JsonObject
        {
            ["message"] = "已打开日志目录",
            ["logsDir"] = LogsDir(),
        };
    }

    private JsonObject BuildLauncherInfo()
    {
        return new JsonObject
        {
            ["projectDir"] = _config.ProjectDir,
            ["logsDir"] = LogsDir(),
            ["configPath"] = _configStore.ConfigPath,
            ["bridgeHealthUrl"] = _config.BridgeHealthUrl,
            ["napcatApi"] = _config.NapCatApi,
            ["autoInstallDependencies"] = _config.AutoInstallDependencies,
            ["autoStartWatchdog"] = _config.AutoStartWatchdog,
            ["autoCheckJm"] = _config.AutoCheckJm,
            ["autoCheckSummaryModule"] = _config.AutoCheckSummaryModule,
        };
    }

    private JsonObject BuildBackgroundState()
    {
        var settings = ReadBackgroundSettings();
        var mode = settings.mode;
        var path = settings.path;
        var wallpaper = ReadDesktopWallpaperPath();

        if (mode == "desktop")
        {
            path = wallpaper;
        }

        var uri = File.Exists(path) ? new Uri(path).AbsoluteUri : "";
        return new JsonObject
        {
            ["mode"] = mode,
            ["path"] = path,
            ["uri"] = uri,
            ["wallpaperPath"] = wallpaper,
            ["wallpaperUri"] = File.Exists(wallpaper) ? new Uri(wallpaper).AbsoluteUri : "",
        };
    }

    private JsonObject SetBackground(string payload)
    {
        using var doc = JsonDocument.Parse(payload);
        var mode = ReadHomeString(doc.RootElement, "mode");
        var path = ReadHomeString(doc.RootElement, "path");
        if (mode is not ("built-in" or "desktop" or "image"))
        {
            throw new InvalidOperationException("未知背景模式: " + mode);
        }

        if (mode == "image" && !File.Exists(path))
        {
            throw new FileNotFoundException("背景图片不存在", path);
        }

        SaveBackgroundSettings(mode, mode == "image" ? path : "");
        ApplyLauncherBackgroundChrome();
        return BuildBackgroundState();
    }

    private JsonObject ChooseBackgroundImage()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "选择 QQFriend 控制台背景",
            Filter = "图片文件|*.jpg;*.jpeg;*.png;*.webp;*.bmp|所有文件|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };

        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return BuildBackgroundState();
        }

        SaveBackgroundSettings("image", dialog.FileName);
        ApplyLauncherBackgroundChrome();
        return BuildBackgroundState();
    }

    private void ApplyLauncherBackgroundChrome()
    {
        var (mode, savedPath) = ReadBackgroundSettings();
        var path = mode == "desktop" ? ReadDesktopWallpaperPath() : savedPath;

        if (File.Exists(path))
        {
            try
            {
                var nextImage = CreateBlurredChromeBackground(path);
                var oldImage = _chromeBackgroundImage;
                _chromeBackgroundImage = nextImage;
                BackgroundImage = nextImage;
                BackgroundImageLayout = ImageLayout.Stretch;
                oldImage?.Dispose();
            }
            catch
            {
                ClearLauncherBackgroundImage();
            }
        }
        else
        {
            ClearLauncherBackgroundImage();
        }

        var baseColor = File.Exists(path) ? Color.FromArgb(210, 221, 218) : Color.FromArgb(219, 230, 226);
        BackColor = baseColor;
        _rootPanel.BackColor = Color.Transparent;
        _statusLabel.BackColor = Color.Transparent;
        _mainTabs.BackColor = baseColor;
        _mainTabs.Invalidate();
    }

    private static Image CreateBlurredChromeBackground(string path)
    {
        using var source = Image.FromFile(path);
        var smallWidth = Math.Max(96, source.Width / 12);
        var smallHeight = Math.Max(54, source.Height / 12);
        using var small = new Bitmap(smallWidth, smallHeight);
        using (var graphics = Graphics.FromImage(small))
        {
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.DrawImage(source, new Rectangle(0, 0, smallWidth, smallHeight));
        }

        using var passA = BoxBlur(small, 5);
        using var passB = BoxBlur(passA, 5);
        return BoxBlur(passB, 5);
    }

    private static Bitmap BoxBlur(Bitmap source, int radius)
    {
        var target = new Bitmap(source.Width, source.Height);
        for (var y = 0; y < source.Height; y++)
        {
            for (var x = 0; x < source.Width; x++)
            {
                var red = 0;
                var green = 0;
                var blue = 0;
                var alpha = 0;
                var count = 0;

                for (var yy = Math.Max(0, y - radius); yy <= Math.Min(source.Height - 1, y + radius); yy++)
                {
                    for (var xx = Math.Max(0, x - radius); xx <= Math.Min(source.Width - 1, x + radius); xx++)
                    {
                        var color = source.GetPixel(xx, yy);
                        red += color.R;
                        green += color.G;
                        blue += color.B;
                        alpha += color.A;
                        count++;
                    }
                }

                target.SetPixel(x, y, Color.FromArgb(alpha / count, red / count, green / count, blue / count));
            }
        }

        return target;
    }

    private void ClearLauncherBackgroundImage()
    {
        BackgroundImage = null;
        _chromeBackgroundImage?.Dispose();
        _chromeBackgroundImage = null;
    }

    private (string mode, string path) ReadBackgroundSettings()
    {
        var path = BackgroundSettingsPath();
        if (!File.Exists(path)) return ("built-in", "");

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            var mode = ReadHomeString(root, "mode");
            var imagePath = ReadHomeString(root, "path");
            if (mode is "built-in" or "desktop" or "image")
            {
                return (mode, imagePath);
            }
        }
        catch
        {
            // Invalid local UI settings should not block the launcher.
        }

        return ("built-in", "");
    }

    private void SaveBackgroundSettings(string mode, string path)
    {
        var json = new JsonObject
        {
            ["mode"] = mode,
            ["path"] = path,
        }.ToJsonString(new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true });
        File.WriteAllText(BackgroundSettingsPath(), json);
    }

    private string BackgroundSettingsPath()
    {
        return Path.Combine(AppContext.BaseDirectory, "launcher-background.json");
    }

    private static string ReadDesktopWallpaperPath()
    {
        var value = Registry.GetValue(@"HKEY_CURRENT_USER\Control Panel\Desktop", "WallPaper", "") as string;
        return string.IsNullOrWhiteSpace(value) ? "" : Environment.ExpandEnvironmentVariables(value);
    }

    private void PostHomeMessage(JsonObject message)
    {
        if (!_homeReady || _homeWebView.CoreWebView2 == null) return;
        var json = message.ToJsonString(new JsonSerializerOptions(JsonSerializerDefaults.Web));
        BeginInvoke(() => _homeWebView.CoreWebView2.PostWebMessageAsJson(json));
    }

    private static string ReadHomeString(JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";
    }

    private static string HomeFallbackHtml(string message)
    {
        return "<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:Microsoft YaHei UI;padding:32px\">" +
            "<h2>QQFriend 主页不可用</h2><p>" + System.Net.WebUtility.HtmlEncode(message) + "</p></body>";
    }
}
