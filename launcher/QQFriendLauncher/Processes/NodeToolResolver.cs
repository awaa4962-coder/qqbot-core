namespace QQFriendLauncher.Processes;

internal sealed class NodeToolResolver
{
    public string NodeExe { get; private set; } = "node";
    public string NpmCliJs { get; private set; } = "";

    public void Resolve()
    {
        NodeExe = ResolveExecutable("node.exe");
        var nodeDir = Path.GetDirectoryName(NodeExe);
        if (string.IsNullOrWhiteSpace(nodeDir)) return;

        var npmCli = Path.Combine(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
        if (File.Exists(npmCli)) NpmCliJs = npmCli;
    }

    private static string ResolveExecutable(string name)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), name);
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // Ignore malformed PATH entries.
            }
        }

        return name;
    }
}
