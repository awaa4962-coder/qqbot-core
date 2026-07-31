using System.Text;
using System.Text.Json;

namespace QQFriendLauncher.Config;

internal sealed class LauncherConfigStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public LauncherConfigStore(string baseDir)
    {
        ConfigPath = Path.Combine(baseDir, "launcher-config.json");
    }

    public string ConfigPath { get; }

    public LauncherConfig LoadOrCreate()
    {
        if (File.Exists(ConfigPath))
        {
            try
            {
                var loaded = JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(ConfigPath, Encoding.UTF8));
                if (loaded != null) return loaded;
            }
            catch
            {
                // Fall through and recreate a clean config.
            }
        }

        var config = new LauncherConfig();
        Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, JsonOptions), Encoding.UTF8);
        return config;
    }
}
