using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using QQFriendLauncher.Config;

namespace QQFriendLauncher.Services;

internal sealed class BridgeAdminClient
{
    private readonly HttpClient _http;
    private readonly LauncherConfig _config;

    public BridgeAdminClient(HttpClient http, LauncherConfig config)
    {
        _http = http;
        _config = config;
    }

    public async Task<string> GetStatusTextAsync()
    {
        using var doc = await GetJsonAsync("/admin/status");
        var root = doc.RootElement;
        var lines = new List<string>
        {
            "QQFriend 控制台总览",
            "",
            "Bridge: " + ReadString(root, "status", "unknown"),
            "版本: " + ReadString(root, "version", "-") + " (" + ReadString(root, "versionName", "-") + ")",
            "生成时间: " + ReadString(root, "generatedAt", "-"),
            "",
            "进程",
            "- PID: " + ReadNumber(root, "process", "pid"),
            "- Uptime: " + FormatSeconds(ReadDouble(root, "process", "uptime")),
            "- RSS: " + FormatBytes(ReadDouble(root, "process", "rss")),
            "- Heap: " + FormatBytes(ReadDouble(root, "process", "heapUsed")) + " / " + FormatBytes(ReadDouble(root, "process", "heapTotal")),
            "",
            "存储",
            "- 用户数: " + ReadNumber(root, "storage", "users"),
            "- 群数: " + ReadNumber(root, "storage", "groups"),
            "",
            "配置",
            "- 监听端口: " + ReadNumber(root, "config", "listenPort"),
            "- NapCat API: " + ReadNestedString(root, "config", "napcatApi", "-"),
            "- Bot 名称: " + JoinArray(root, "config", "botNames"),
            "- 群白名单: " + JoinArray(root, "config", "groupWhitelist"),
            "- 日报群: " + JoinArray(root, "config", "summaryGroupWhitelist"),
            "- 资源/JM 群: " + JoinArray(root, "config", "resourceGroupWhitelist"),
            "- 管理员: " + JoinArray(root, "config", "adminUins"),
            "",
            "模块",
            "- JM: " + ReadModuleEnabled(root, "jm") + "，Python=" + ReadPath(root, "modules", "jm", "python") + "，镜像域名数=" + ReadPath(root, "modules", "jm", "domains"),
            "- 日报: " + ReadModuleEnabled(root, "groupSummary"),
            "- 关系: " + ReadModuleEnabled(root, "relationship") + "，导出仍为 reserved",
            "- 记忆: " + ReadModuleEnabled(root, "memory"),
            "",
            "模型凭据状态",
            "- MiMo: " + BoolStatus(root, "modelKeys", "mimo"),
            "- DeepSeek: " + BoolStatus(root, "modelKeys", "deepseek"),
            "- Tavily: " + BoolStatus(root, "modelKeys", "tavily"),
            "- Doubao: " + BoolStatus(root, "modelKeys", "doubao"),
            "",
            "风暴保护",
            "- processingCount: " + ReadNumber(root, "storm", "processingCount"),
            "- eventDropped: " + ReadNumber(root, "storm", "eventDropped"),
            "- logTruncated: " + BoolStatus(root, "storm", "logTruncated"),
        };
        return string.Join(Environment.NewLine, lines);
    }

    public async Task<string> GetStatusJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/status");
        return doc.RootElement.GetRawText();
    }

    public async Task<string> GetLogsJsonAsync(string filter = "", int tail = 120)
    {
        var path = "/admin/logs?tail=" + tail;
        if (!string.IsNullOrWhiteSpace(filter)) path += "&filter=" + Uri.EscapeDataString(filter.Trim());

        using var doc = await GetJsonAsync(path);
        return doc.RootElement.GetRawText();
    }

    public async Task<string> GetCommandsTextAsync()
    {
        using var doc = await GetJsonAsync("/admin/commands");
        var root = doc.RootElement;
        var builder = new StringBuilder();
        builder.AppendLine("命令目录");
        builder.AppendLine("总数: " + ReadString(root, "count", "0"));
        builder.AppendLine();

        if (root.TryGetProperty("commands", out var commands) && commands.ValueKind == JsonValueKind.Array)
        {
            foreach (var command in commands.EnumerateArray())
            {
                builder.AppendLine("[" + ReadString(command, "permission", "user") + "] " + ReadString(command, "id", "-"));
                var aliases = ArrayToText(command, "aliases");
                builder.AppendLine("  aliases: " + (string.IsNullOrWhiteSpace(aliases) ? "-" : aliases));
                var helpLine = ReadString(command, "helpLine", "");
                if (!string.IsNullOrWhiteSpace(helpLine)) builder.AppendLine("  help: " + helpLine.Trim());
                if (ReadBool(command, "reserved")) builder.AppendLine("  reserved: true");
                if (ReadBool(command, "hasPattern")) builder.AppendLine("  pattern: " + ReadString(command, "pattern", ""));
                builder.AppendLine();
            }
        }

        return builder.ToString().TrimEnd();
    }

    public async Task<string> GetCapabilitiesJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/capabilities");
        return doc.RootElement.GetRawText();
    }

    public async Task<string> GetModulesTextAsync()
    {
        using var doc = await GetJsonAsync("/admin/modules");
        var root = doc.RootElement;
        var builder = new StringBuilder();
        builder.AppendLine("模块清单");
        builder.AppendLine("总数: " + ReadString(root, "count", "0"));
        builder.AppendLine();

        if (root.TryGetProperty("modules", out var modules) && modules.ValueKind == JsonValueKind.Array)
        {
            foreach (var module in modules.EnumerateArray())
            {
                builder.AppendLine("[" + ReadString(module, "category", "-") + "] " + ReadString(module, "name", "-") + " (" + ReadString(module, "id", "-") + ")");
                builder.AppendLine("  enabled: " + BoolStatus(module, "enabled") + " / risk: " + ReadString(module, "riskLevel", "-"));
                builder.AppendLine("  entrypoints: " + ArrayToText(module, "entrypoints"));
                builder.AppendLine("  commands: " + ValueOrDash(ArrayToText(module, "commands")));
                builder.AppendLine("  editable config: " + ValueOrDash(ArrayToText(module, "editableConfigFields")));
                builder.AppendLine("  health: " + ValueOrDash(ArrayToText(module, "healthChecks")));
                builder.AppendLine("  diagnostics: " + ValueOrDash(ArrayToText(module, "diagnostics")));
                builder.AppendLine("  privacy: " + ReadString(module, "privacy", "-"));
                builder.AppendLine();
            }
        }

        return builder.ToString().TrimEnd();
    }

    public async Task<string> GetWorkflowsTextAsync()
    {
        using var doc = await GetJsonAsync("/admin/workflows");
        var root = doc.RootElement;
        var builder = new StringBuilder();
        builder.AppendLine("工作流中心");
        builder.AppendLine("总数: " + ReadString(root, "count", "0"));
        builder.AppendLine();

        if (root.TryGetProperty("workflows", out var workflows) && workflows.ValueKind == JsonValueKind.Array)
        {
            foreach (var workflow in workflows.EnumerateArray())
            {
                builder.AppendLine(ReadString(workflow, "name", "-") + " (" + ReadString(workflow, "id", "-") + ")");
                builder.AppendLine("  surface: " + ReadString(workflow, "surface", "-"));
                builder.AppendLine("  steps: " + ValueOrDash(ArrayToText(workflow, "steps")));
                builder.AppendLine("  verify: " + ValueOrDash(ArrayToText(workflow, "verify")));
                builder.AppendLine();
            }
        }

        return builder.ToString().TrimEnd();
    }

    public async Task<string> GetPluginsTextAsync()
    {
        using var doc = await GetJsonAsync("/admin/plugins");
        var root = doc.RootElement;
        var builder = new StringBuilder();
        builder.AppendLine("插件中心");
        builder.AppendLine("模式: " + ReadString(root, "mode", "-"));
        builder.AppendLine("总数: " + ReadString(root, "count", "0"));
        builder.AppendLine();

        if (root.TryGetProperty("plugins", out var plugins) && plugins.ValueKind == JsonValueKind.Array)
        {
            foreach (var plugin in plugins.EnumerateArray())
            {
                builder.AppendLine("[" + ReadString(plugin, "category", "-") + "] " + ReadString(plugin, "name", "-") + " (" + ReadString(plugin, "id", "-") + ")");
                builder.AppendLine("  status: " + ReadString(plugin, "status", "-") + " / risk: " + ReadString(plugin, "riskLevel", "-"));
                builder.AppendLine("  commands: " + ValueOrDash(ArrayToText(plugin, "commands")));
                builder.AppendLine("  diagnostics: " + ValueOrDash(ArrayToText(plugin, "diagnostics")));
                builder.AppendLine("  privacy: " + ReadString(plugin, "privacy", "-"));
                builder.AppendLine();
            }
        }

        return builder.ToString().TrimEnd();
    }

    public async Task<string> GetSelfDescriptionJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/self-description");
        return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> GetAuditTextAsync(int tail = 100)
    {
        using var doc = await GetJsonAsync("/admin/audit?tail=" + tail);
        var root = doc.RootElement;
        var builder = new StringBuilder();
        builder.AppendLine("管理操作审计");
        builder.AppendLine();
        if (root.TryGetProperty("current", out var current) &&
            current.TryGetProperty("lines", out var lines) &&
            lines.ValueKind == JsonValueKind.Array)
        {
            foreach (var line in lines.EnumerateArray())
            {
                builder.AppendLine(line.GetString() ?? "");
            }
        }
        return builder.ToString().TrimEnd();
    }

    public async Task<string> GetBackupsJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/backups");
        return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> RunBackupActionJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(json);
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/backups", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> CreateBackupJsonAsync()
    {
        var name = "launcher-" + DateTime.Now.ToString("yyyyMMddHHmmss");
        return await RunBackupActionJsonAsync("{\"action\":\"create\",\"name\":\"" + name + "\"}");
    }

    public async Task<string> PreviewCommandScaffoldJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(ForceJsonBool(json, "write", false));
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/command-scaffold", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> WriteCommandScaffoldJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(ForceJsonBool(json, "write", true));
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/command-scaffold", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> GetLogsTextAsync(string filter = "", int tail = 300)
    {
        var path = "/admin/logs?tail=" + tail;
        if (!string.IsNullOrWhiteSpace(filter)) path += "&filter=" + Uri.EscapeDataString(filter.Trim());

        using var doc = await GetJsonAsync(path);
        var root = doc.RootElement;
        var builder = new StringBuilder();
        builder.AppendLine("日志视图");

        if (root.TryGetProperty("current", out var current))
        {
            builder.AppendLine("文件: " + ReadString(current, "file", "-"));
            builder.AppendLine("行数: " + ReadString(current, "count", "0"));
            builder.AppendLine("截断读取: " + BoolStatus(current, "truncated"));
            builder.AppendLine();
            if (current.TryGetProperty("lines", out var lines) && lines.ValueKind == JsonValueKind.Array)
            {
                foreach (var line in lines.EnumerateArray())
                {
                    builder.AppendLine(line.GetString() ?? "");
                }
            }
        }

        return builder.ToString().TrimEnd();
    }

    public async Task<string> GetConfigJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/config");
        return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> SaveConfigJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(json);
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/config", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> GetApiProvidersJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/api-providers");
        return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> ManageApiProvidersJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(json);
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/api-providers", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> GetMemesJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/memes");
        return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> SaveMemeJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(json);
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/memes", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> GetStickersJsonAsync()
    {
        using var doc = await GetJsonAsync("/admin/stickers");
        return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> ManageStickersJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(json);
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/stickers", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    public async Task<string> DiagnoseReplyJsonAsync(string json)
    {
        using var doc = JsonDocument.Parse(json);
        using var response = await SendJsonAsync(HttpMethod.Post, "/admin/diagnose/reply", doc.RootElement.GetRawText());
        return JsonSerializer.Serialize(response.RootElement, new JsonSerializerOptions { WriteIndented = true });
    }

    private async Task<JsonDocument> GetJsonAsync(string path)
    {
        return await SendJsonAsync(HttpMethod.Get, path, null);
    }

    private async Task<JsonDocument> SendJsonAsync(HttpMethod method, string path, string? body)
    {
        var baseUri = AdminBaseUri();
        using var request = new HttpRequestMessage(method, new Uri(baseUri, path));
        if (!string.IsNullOrWhiteSpace(_config.AdminToken))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.AdminToken.Trim());
        }
        if (body != null)
        {
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }

        using var response = await _http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException("Admin API 请求失败: " + (int)response.StatusCode + " " + text);
        }

        return JsonDocument.Parse(text);
    }

    private Uri AdminBaseUri()
    {
        var health = new Uri(_config.BridgeHealthUrl);
        return new Uri(health.GetLeftPart(UriPartial.Authority));
    }

    private static string ReadNestedString(JsonElement root, string parent, string property, string fallback)
    {
        if (root.TryGetProperty(parent, out var obj) && obj.TryGetProperty(property, out var value)) return ValueToString(value, fallback);
        return fallback;
    }

    private static string ReadString(JsonElement root, string property, string fallback)
    {
        if (root.TryGetProperty(property, out var value)) return ValueToString(value, fallback);
        return fallback;
    }

    private static string ReadNumber(JsonElement root, string parent, string property)
    {
        if (root.TryGetProperty(parent, out var obj) && obj.TryGetProperty(property, out var value)) return ValueToString(value, "0");
        return "0";
    }

    private static double ReadDouble(JsonElement root, string parent, string property)
    {
        if (root.TryGetProperty(parent, out var obj) && obj.TryGetProperty(property, out var value) && value.TryGetDouble(out var number)) return number;
        return 0;
    }

    private static string ReadModuleEnabled(JsonElement root, string module)
    {
        if (root.TryGetProperty("modules", out var modules) &&
            modules.TryGetProperty(module, out var item) &&
            item.TryGetProperty("enabled", out var enabled))
        {
            return enabled.ValueKind == JsonValueKind.True ? "启用" : "未启用";
        }

        return "未知";
    }

    private static string ReadPath(JsonElement root, string first, string second, string third)
    {
        if (root.TryGetProperty(first, out var a) &&
            a.TryGetProperty(second, out var b) &&
            b.TryGetProperty(third, out var c))
        {
            return ValueToString(c, "-");
        }
        return "-";
    }

    private static string JoinArray(JsonElement root, string parent, string property)
    {
        if (root.TryGetProperty(parent, out var obj) && obj.TryGetProperty(property, out var array)) return ArrayToText(array);
        return "-";
    }

    private static string ArrayToText(JsonElement root, string property)
    {
        if (root.TryGetProperty(property, out var array)) return ArrayToText(array);
        return "";
    }

    private static string ArrayToText(JsonElement array)
    {
        if (array.ValueKind != JsonValueKind.Array) return "";
        return string.Join(", ", array.EnumerateArray().Select(item => ValueToString(item, "")));
    }

    private static string ValueOrDash(string value)
    {
        return string.IsNullOrWhiteSpace(value) ? "-" : value;
    }

    private static bool ReadBool(JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.True;
    }

    private static string BoolStatus(JsonElement root, string parent, string property)
    {
        if (root.TryGetProperty(parent, out var obj) && obj.TryGetProperty(property, out var value)) return BoolStatus(value);
        return "未知";
    }

    private static string BoolStatus(JsonElement root, string property)
    {
        if (root.TryGetProperty(property, out var value)) return BoolStatus(value);
        return "未知";
    }

    private static string BoolStatus(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.True => "是",
            JsonValueKind.False => "否",
            _ => "未知",
        };
    }

    private static string ValueToString(JsonElement value, string fallback)
    {
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? fallback,
            JsonValueKind.Number => value.ToString(),
            JsonValueKind.True => "True",
            JsonValueKind.False => "False",
            JsonValueKind.Null => fallback,
            _ => value.ToString(),
        };
    }

    private static string ForceJsonBool(string json, string property, bool value)
    {
        var node = JsonNode.Parse(json);
        if (node is not JsonObject obj) throw new InvalidOperationException("JSON must be an object");
        obj[property] = value;
        return obj.ToJsonString();
    }

    private static string FormatBytes(double value)
    {
        if (value <= 0) return "0 B";
        string[] units = ["B", "KB", "MB", "GB"];
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        return value.ToString("0.##") + " " + units[unit];
    }

    private static string FormatSeconds(double seconds)
    {
        var span = TimeSpan.FromSeconds(Math.Max(0, seconds));
        if (span.TotalDays >= 1) return span.TotalDays.ToString("0.0") + " 天";
        if (span.TotalHours >= 1) return span.TotalHours.ToString("0.0") + " 小时";
        if (span.TotalMinutes >= 1) return span.TotalMinutes.ToString("0.0") + " 分钟";
        return span.TotalSeconds.ToString("0") + " 秒";
    }
}
