using System.Text;
using System.Text.Json;
using QQFriendLauncher.Config;

namespace QQFriendLauncher.Services;

internal sealed class NapCatClient
{
    private readonly HttpClient _http;
    private readonly LauncherConfig _config;

    public NapCatClient(HttpClient http, LauncherConfig config)
    {
        _http = http;
        _config = config;
    }

    public async Task<bool> CheckAsync()
    {
        return (await CheckDetailedAsync()).IsReady;
    }

    public async Task<ServiceCheckResult> CheckDetailedAsync()
    {
        try
        {
            using var content = new StringContent("{}", Encoding.UTF8, "application/json");
            using var response = await _http.PostAsync(_config.NapCatApi.TrimEnd('/') + "/get_login_info", content);
            if (!response.IsSuccessStatusCode)
            {
                return new ServiceCheckResult(false, "HTTP " + (int)response.StatusCode);
            }

            var payload = await response.Content.ReadAsStringAsync();
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            var statusOk = root.TryGetProperty("status", out var status) &&
                string.Equals(status.GetString(), "ok", StringComparison.OrdinalIgnoreCase);
            var loggedIn = root.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Object &&
                data.TryGetProperty("user_id", out var userId) &&
                !string.IsNullOrWhiteSpace(userId.ToString());
            return statusOk && loggedIn
                ? new ServiceCheckResult(true, "OK")
                : new ServiceCheckResult(false, "OneBot 已启动，但 QQ 尚未登录");
        }
        catch (Exception ex)
        {
            return new ServiceCheckResult(false, ex.GetType().Name + ": " + ex.Message);
        }
    }
}
