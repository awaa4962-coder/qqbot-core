using QQFriendLauncher.Config;

namespace QQFriendLauncher.Services;

internal sealed class BridgeClient
{
    private readonly HttpClient _http;
    private readonly LauncherConfig _config;

    public BridgeClient(HttpClient http, LauncherConfig config)
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
            using var response = await _http.GetAsync(_config.BridgeHealthUrl);
            var text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                return new ServiceCheckResult(false, "HTTP " + (int)response.StatusCode);
            }

            var ready = text.Contains("ok", StringComparison.OrdinalIgnoreCase);
            return new ServiceCheckResult(ready, ready ? "OK" : "响应中没有 ok");
        }
        catch (Exception ex)
        {
            return new ServiceCheckResult(false, ex.GetType().Name + ": " + ex.Message);
        }
    }
}
