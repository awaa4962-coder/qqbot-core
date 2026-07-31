using System.Drawing;
using System.Drawing.Drawing2D;
using System.Net.Http;
using System.Windows.Forms;
using QQFriendLauncher.Config;
using QQFriendLauncher.Processes;
using QQFriendLauncher.Services;

namespace QQFriendLauncher.App;

internal sealed partial class LauncherForm : Form
{
    private readonly TextBox _launcherLogBox = new();
    private readonly TextBox _overviewBox = new();
    private readonly TextBox _adminLogsBox = new();
    private readonly TextBox _commandsBox = new();
    private readonly TextBox _modulesBox = new();
    private readonly TextBox _workflowsBox = new();
    private readonly TextBox _pluginsBox = new();
    private readonly TextBox _scaffoldInputBox = new();
    private readonly TextBox _scaffoldOutputBox = new();
    private readonly TextBox _backupInputBox = new();
    private readonly TextBox _backupsBox = new();
    private readonly TextBox _auditBox = new();
    private readonly TextBox _selfDescriptionBox = new();
    private readonly TextBox _configBox = new();
    private readonly TextBox _diagnoseInputBox = new();
    private readonly TextBox _diagnoseOutputBox = new();
    private readonly TextBox _logFilterBox = new();
    private readonly Label _statusLabel = new();
    private readonly Button _refreshOverviewButton = new();
    private readonly Button _refreshLogsButton = new();
    private readonly Button _refreshCommandsButton = new();
    private readonly Button _refreshModulesButton = new();
    private readonly Button _refreshWorkflowsButton = new();
    private readonly Button _refreshPluginsButton = new();
    private readonly Button _previewScaffoldButton = new();
    private readonly Button _writeScaffoldButton = new();
    private readonly Button _refreshBackupsButton = new();
    private readonly Button _createBackupButton = new();
    private readonly Button _runBackupActionButton = new();
    private readonly Button _refreshAuditButton = new();
    private readonly Button _refreshSelfDescriptionButton = new();
    private readonly Button _refreshConfigButton = new();
    private readonly Button _saveConfigButton = new();
    private readonly Button _runDiagnoseButton = new();
    private readonly Button _loadDiagnoseSampleButton = new();
    private readonly TableLayoutPanel _rootPanel = new();
    private readonly FlowLayoutPanel _navPanel = new();
    private readonly TabControl _mainTabs = new();
    private readonly List<Button> _navButtons = new();
    private readonly Button _advancedNavButton = new();
    private readonly HashSet<int> _loadedNativePages = new();
    private readonly LauncherConfig _config;
    private readonly LauncherConfigStore _configStore;
    private readonly LauncherRuntimeService _runtime;
    private readonly BridgeAdminClient _adminClient;
    private readonly LauncherLogger _logger;
    private Image? _chromeBackgroundImage;
    private bool _busy;

    public LauncherForm()
    {
        Text = "QQFriend 控制台";
        MinimumSize = new Size(940, 620);
        Size = new Size(1080, 760);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = Color.FromArgb(219, 230, 226);

        _configStore = new LauncherConfigStore(AppContext.BaseDirectory);
        _config = _configStore.LoadOrCreate();
        var runtimeHttp = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(5),
        };
        var adminHttp = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromMinutes(4),
        };
        var nodeTools = new NodeToolResolver();
        nodeTools.Resolve();

        _logger = new LauncherLogger(LogsDir, AppendLogLine);
        var runner = new ProcessRunner(_logger);
        _runtime = new LauncherRuntimeService(
            _config,
            _logger,
            runner,
            nodeTools,
            new NapCatClient(runtimeHttp, _config),
            new BridgeClient(runtimeHttp, _config));
        _adminClient = new BridgeAdminClient(adminHttp, _config);
        FormClosed += (_, _) =>
        {
            runtimeHttp.Dispose();
            adminHttp.Dispose();
        };

        BuildLayout();
        Shown += (_, _) => UpdateNativeNavigationVisibility();
        _ = InitializeHomePageAsync();
        _runtime.LogToolStatus();
        AppendStartupInfo();
    }

    private void BuildLayout()
    {
        _rootPanel.Dock = DockStyle.Fill;
        _rootPanel.ColumnCount = 1;
        _rootPanel.RowCount = 2;
        _rootPanel.Padding = Padding.Empty;
        _rootPanel.BackColor = Color.Transparent;
        _rootPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 0));
        _rootPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(_rootPanel);

        _statusLabel.AutoSize = false;
        _statusLabel.Width = 150;
        _statusLabel.Height = 30;
        _statusLabel.Margin = new Padding(4, 0, 0, 0);
        _statusLabel.TextAlign = ContentAlignment.MiddleLeft;
        _statusLabel.ForeColor = Color.FromArgb(36, 113, 82);
        _statusLabel.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        _statusLabel.BackColor = Color.Transparent;
        _statusLabel.BorderStyle = BorderStyle.None;
        _statusLabel.Text = "● 就绪";

        _navPanel.Dock = DockStyle.Fill;
        _navPanel.Margin = Padding.Empty;
        _navPanel.FlowDirection = FlowDirection.LeftToRight;
        _navPanel.WrapContents = false;
        _navPanel.Padding = new Padding(0, 2, 0, 2);
        _navPanel.BackColor = Color.Transparent;
        _rootPanel.Controls.Add(_navPanel, 0, 0);

        _mainTabs.Dock = DockStyle.Fill;
        _mainTabs.Margin = Padding.Empty;
        ConfigureTabs(_mainTabs);
        _rootPanel.Controls.Add(_mainTabs, 0, 1);

        _mainTabs.TabPages.Add(BuildHomePage());
        _mainTabs.TabPages.Add(BuildOverviewPage());
        _mainTabs.TabPages.Add(BuildLogsPage());
        _mainTabs.TabPages.Add(BuildCommandsPage());
        _mainTabs.TabPages.Add(BuildModulesPage());
        _mainTabs.TabPages.Add(BuildWorkflowsPage());
        _mainTabs.TabPages.Add(BuildPluginsPage());
        _mainTabs.TabPages.Add(BuildScaffoldPage());
        _mainTabs.TabPages.Add(BuildBackupsPage());
        _mainTabs.TabPages.Add(BuildAuditPage());
        _mainTabs.TabPages.Add(BuildSelfDescriptionPage());
        _mainTabs.TabPages.Add(BuildConfigPage());
        _mainTabs.TabPages.Add(BuildDiagnosePage());
        _mainTabs.TabPages.Add(BuildLauncherOutputPage());
        BuildNavigation();
        ApplyLauncherBackgroundChrome();
    }

    private TabPage BuildOverviewPage()
    {
        var page = new TabPage("总览");
        var panel = BuildPagePanel(_overviewBox);
        ConfigurePlainButton(_refreshOverviewButton, "刷新总览", () => _ = RefreshOverviewAsync());
        panel.Controls.Add(_refreshOverviewButton, 0, 0);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildLogsPage()
    {
        var page = new TabPage("日志");
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Padding = new Padding(10),
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var tools = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
        };
        _logFilterBox.Width = 260;
        _logFilterBox.Height = 28;
        _logFilterBox.Margin = new Padding(0, 4, 10, 0);
        _logFilterBox.PlaceholderText = "过滤关键词，可留空";
        ConfigurePlainButton(_refreshLogsButton, "刷新日志", () => _ = RefreshLogsAsync());
        var openLogsButton = new Button();
        ConfigurePlainButton(openLogsButton, "打开目录", OpenLogs);
        tools.Controls.AddRange(new Control[] { _logFilterBox, _refreshLogsButton, openLogsButton });

        ConfigureTextBox(_adminLogsBox);
        panel.Controls.Add(tools, 0, 0);
        panel.Controls.Add(_adminLogsBox, 0, 1);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildCommandsPage()
    {
        var page = new TabPage("命令");
        var panel = BuildPagePanel(_commandsBox);
        ConfigurePlainButton(_refreshCommandsButton, "刷新命令", () => _ = RefreshCommandsAsync());
        panel.Controls.Add(_refreshCommandsButton, 0, 0);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildModulesPage()
    {
        var page = new TabPage("模块");
        var panel = BuildPagePanel(_modulesBox);
        ConfigurePlainButton(_refreshModulesButton, "刷新模块", () => _ = RefreshModulesAsync());
        panel.Controls.Add(_refreshModulesButton, 0, 0);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildWorkflowsPage()
    {
        var page = new TabPage("工作流");
        var panel = BuildPagePanel(_workflowsBox);
        ConfigurePlainButton(_refreshWorkflowsButton, "刷新工作流", () => _ = RefreshWorkflowsAsync());
        panel.Controls.Add(_refreshWorkflowsButton, 0, 0);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildPluginsPage()
    {
        var page = new TabPage("插件");
        var panel = BuildPagePanel(_pluginsBox);
        ConfigurePlainButton(_refreshPluginsButton, "刷新插件", () => _ = RefreshPluginsAsync());
        panel.Controls.Add(_refreshPluginsButton, 0, 0);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildScaffoldPage()
    {
        var page = new TabPage("命令生成");
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Padding = new Padding(10),
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 55));

        var tools = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
        };
        ConfigurePlainButton(_previewScaffoldButton, "预览命令", () => _ = PreviewScaffoldAsync());
        ConfigurePlainButton(_writeScaffoldButton, "生成文件", () => _ = WriteScaffoldAsync());
        tools.Controls.AddRange(new Control[] { _previewScaffoldButton, _writeScaffoldButton });

        ConfigureTextBox(_scaffoldInputBox, readOnly: false);
        ConfigureTextBox(_scaffoldOutputBox);
        _scaffoldInputBox.Text = DefaultScaffoldSample();
        panel.Controls.Add(tools, 0, 0);
        panel.Controls.Add(_scaffoldInputBox, 0, 1);
        panel.Controls.Add(_scaffoldOutputBox, 0, 2);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildBackupsPage()
    {
        var page = new TabPage("备份");
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Padding = new Padding(10),
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 35));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 65));

        var tools = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
        };
        ConfigurePlainButton(_refreshBackupsButton, "刷新备份", () => _ = RefreshBackupsAsync());
        ConfigurePlainButton(_createBackupButton, "创建备份", () => _ = CreateBackupAsync());
        ConfigurePlainButton(_runBackupActionButton, "运行备份JSON", () => _ = RunBackupActionAsync());
        tools.Controls.AddRange(new Control[] { _refreshBackupsButton, _createBackupButton, _runBackupActionButton });

        ConfigureTextBox(_backupInputBox, readOnly: false);
        ConfigureTextBox(_backupsBox);
        _backupInputBox.Text = DefaultBackupSample();
        panel.Controls.Add(tools, 0, 0);
        panel.Controls.Add(_backupInputBox, 0, 1);
        panel.Controls.Add(_backupsBox, 0, 2);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildAuditPage()
    {
        var page = new TabPage("审计");
        var panel = BuildPagePanel(_auditBox);
        ConfigurePlainButton(_refreshAuditButton, "刷新审计", () => _ = RefreshAuditAsync());
        panel.Controls.Add(_refreshAuditButton, 0, 0);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildSelfDescriptionPage()
    {
        var page = new TabPage("自描述");
        var panel = BuildPagePanel(_selfDescriptionBox);
        ConfigurePlainButton(_refreshSelfDescriptionButton, "刷新自描述", () => _ = RefreshSelfDescriptionAsync());
        panel.Controls.Add(_refreshSelfDescriptionButton, 0, 0);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildConfigPage()
    {
        var page = new TabPage("配置");
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Padding = new Padding(10),
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var tools = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
        };
        ConfigurePlainButton(_refreshConfigButton, "刷新配置", () => _ = RefreshConfigAsync());
        ConfigurePlainButton(_saveConfigButton, "保存配置", () => _ = SaveConfigAsync());
        tools.Controls.AddRange(new Control[] { _refreshConfigButton, _saveConfigButton });

        ConfigureTextBox(_configBox, readOnly: false);
        panel.Controls.Add(tools, 0, 0);
        panel.Controls.Add(_configBox, 0, 1);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildDiagnosePage()
    {
        var page = new TabPage("诊断");
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Padding = new Padding(10),
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 55));

        var tools = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
        };
        ConfigurePlainButton(_runDiagnoseButton, "运行诊断", () => _ = RunDiagnoseAsync());
        ConfigurePlainButton(_loadDiagnoseSampleButton, "填入示例", LoadDiagnoseSample);
        tools.Controls.AddRange(new Control[] { _runDiagnoseButton, _loadDiagnoseSampleButton });

        ConfigureTextBox(_diagnoseInputBox, readOnly: false);
        ConfigureTextBox(_diagnoseOutputBox);
        _diagnoseInputBox.Text = DefaultDiagnoseSample();
        panel.Controls.Add(tools, 0, 0);
        panel.Controls.Add(_diagnoseInputBox, 0, 1);
        panel.Controls.Add(_diagnoseOutputBox, 0, 2);
        page.Controls.Add(panel);
        return page;
    }

    private TabPage BuildLauncherOutputPage()
    {
        var page = new TabPage("启动输出");
        ConfigureTextBox(_launcherLogBox);
        _launcherLogBox.Dock = DockStyle.Fill;
        _launcherLogBox.BackColor = Color.FromArgb(18, 18, 18);
        _launcherLogBox.ForeColor = Color.FromArgb(235, 235, 235);
        page.Controls.Add(_launcherLogBox);
        return page;
    }

    private static TableLayoutPanel BuildPagePanel(TextBox textBox)
    {
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Padding = new Padding(10),
        };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        ConfigureTextBox(textBox);
        panel.Controls.Add(textBox, 0, 1);
        return panel;
    }

    private static void ConfigureTextBox(TextBox box, bool readOnly = true)
    {
        box.Dock = DockStyle.Fill;
        box.Multiline = true;
        box.ScrollBars = ScrollBars.Both;
        box.ReadOnly = readOnly;
        box.WordWrap = readOnly;
        box.BackColor = Color.White;
        box.ForeColor = Color.FromArgb(28, 28, 28);
        box.Font = readOnly ? new Font("Microsoft YaHei UI", 9.5F) : new Font("Consolas", 10F);
    }

    private void AppendStartupInfo()
    {
        _logger.Log("启动器已加载。");
        _logger.Log("项目目录: " + _config.ProjectDir);
        _logger.Log("配置文件: " + _configStore.ConfigPath);
    }

    private static void ConfigurePlainButton(Button button, string text, Action action)
    {
        button.Text = text;
        button.Width = 118;
        button.Height = 32;
        button.Margin = new Padding(0, 0, 10, 0);
        button.Cursor = Cursors.Hand;
        button.FlatStyle = FlatStyle.Flat;
        button.UseVisualStyleBackColor = false;
        button.BackColor = ButtonBackColor(text);
        button.ForeColor = ButtonForeColor(text);
        button.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = button.BackColor;
        button.FlatAppearance.MouseDownBackColor = button.BackColor;
        button.Paint += PaintGlassButton;
        button.Resize += (_, _) => ApplyRoundedButtonRegion(button);
        button.MouseEnter += (_, _) => button.BackColor = ButtonHoverBackColor(text);
        button.MouseLeave += (_, _) => button.BackColor = ButtonBackColor(text);
        button.MouseDown += (_, _) => button.BackColor = ButtonDownBackColor(text);
        button.MouseUp += (_, _) => button.BackColor = ButtonHoverBackColor(text);
        ApplyRoundedButtonRegion(button);
        button.Click += (_, _) => action();
    }

    private static Color ButtonBackColor(string text)
    {
        if (text.Contains("启动", StringComparison.OrdinalIgnoreCase)) return Color.FromArgb(218, 239, 232);
        if (text.Contains("停止", StringComparison.OrdinalIgnoreCase)) return Color.FromArgb(245, 226, 226);
        if (text.Contains("重启", StringComparison.OrdinalIgnoreCase)) return Color.FromArgb(226, 236, 242);
        return Color.FromArgb(238, 246, 244);
    }

    private static Color ButtonHoverBackColor(string text)
    {
        return ControlPaint.Light(ButtonBackColor(text), 0.18F);
    }

    private static Color ButtonDownBackColor(string text)
    {
        return ControlPaint.Dark(ButtonBackColor(text), 0.08F);
    }

    private static Color ButtonForeColor(string text)
    {
        if (text.Contains("启动", StringComparison.OrdinalIgnoreCase)) return Color.FromArgb(24, 104, 78);
        if (text.Contains("停止", StringComparison.OrdinalIgnoreCase)) return Color.FromArgb(139, 49, 49);
        if (text.Contains("重启", StringComparison.OrdinalIgnoreCase)) return Color.FromArgb(45, 76, 102);
        return Color.FromArgb(30, 42, 48);
    }

    private static void PaintGlassButton(object? sender, PaintEventArgs e)
    {
        if (sender is not Button button) return;

        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new Rectangle(0, 0, button.Width - 1, button.Height - 1);
        using var path = RoundedRect(bounds, 8);
        using var brush = new SolidBrush(button.Enabled ? button.BackColor : Color.FromArgb(226, 234, 232));
        using var pen = new Pen(Color.FromArgb(150, 178, 184));
        e.Graphics.FillPath(brush, path);
        e.Graphics.DrawPath(pen, path);

        var textColor = button.Enabled ? button.ForeColor : Color.FromArgb(132, 148, 154);
        TextRenderer.DrawText(
            e.Graphics,
            button.Text,
            button.Font,
            bounds,
            textColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }

    private static void ApplyRoundedButtonRegion(Button button)
    {
        if (button.Width <= 0 || button.Height <= 0) return;
        using var path = RoundedRect(new Rectangle(0, 0, button.Width, button.Height), 8);
        button.Region?.Dispose();
        button.Region = new Region(path);
    }

    private static void ConfigureTabs(TabControl tabs)
    {
        tabs.Appearance = TabAppearance.FlatButtons;
        tabs.SizeMode = TabSizeMode.Fixed;
        tabs.ItemSize = new Size(0, 1);
        tabs.Padding = new Point(0, 0);
        tabs.BackColor = Color.FromArgb(219, 230, 226);
        tabs.DrawMode = TabDrawMode.OwnerDrawFixed;
        tabs.DrawItem += (_, _) => { };
        tabs.SelectedIndexChanged += (_, _) => { };
    }

    private void BuildNavigation()
    {
        _navPanel.Controls.Clear();
        _navButtons.Clear();

        var primaryPages = new[] { 0, 1, 2, 12 };
        foreach (var index in primaryPages)
        {
            AddNavigationButton(index);
        }

        var advancedMenu = new ContextMenuStrip
        {
            Font = new Font("Microsoft YaHei UI", 9F),
            BackColor = Color.FromArgb(236, 245, 242),
            ForeColor = Color.FromArgb(30, 52, 53),
            ShowImageMargin = false,
            ShowCheckMargin = false,
            Padding = new Padding(4),
            Renderer = new ToolStripProfessionalRenderer(new GlassMenuColorTable()),
        };
        var advancedPages = new[] { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13 };
        foreach (var index in advancedPages)
        {
            var item = advancedMenu.Items.Add(_mainTabs.TabPages[index].Text);
            item.AutoSize = false;
            item.Size = new Size(136, 30);
            item.Padding = new Padding(10, 0, 10, 0);
            item.Click += (_, _) => _mainTabs.SelectedIndex = index;
        }

        ConfigureNavigationButton(_advancedNavButton, "更多工具", -1);
        _advancedNavButton.Width = 92;
        _advancedNavButton.Click += (_, _) => advancedMenu.Show(_advancedNavButton, new Point(0, _advancedNavButton.Height));
        _navPanel.Controls.Add(_advancedNavButton);
        _navPanel.Controls.Add(_statusLabel);

        _mainTabs.SelectedIndexChanged += (_, _) =>
        {
            UpdateNativeNavigationVisibility();
            UpdateNavigationState();
            _ = RefreshSelectedPageAsync();
        };
        UpdateNativeNavigationVisibility();
        UpdateNavigationState();
    }

    private void UpdateNativeNavigationVisibility()
    {
        var visible = _mainTabs.SelectedIndex != 0;
        _rootPanel.SuspendLayout();
        _navPanel.Visible = visible;
        _navPanel.Height = visible ? 40 : 0;
        _rootPanel.RowStyles[0].SizeType = SizeType.Absolute;
        _rootPanel.RowStyles[0].Height = visible ? 40F : 0F;
        _rootPanel.ResumeLayout(true);
    }

    private void AddNavigationButton(int pageIndex)
    {
        var button = new Button();
        ConfigureNavigationButton(button, _mainTabs.TabPages[pageIndex].Text, pageIndex);
        button.Click += (_, _) => _mainTabs.SelectedIndex = pageIndex;
        _navButtons.Add(button);
        _navPanel.Controls.Add(button);
    }

    private static void ConfigureNavigationButton(Button button, string text, int pageIndex)
    {
        button.Text = text;
        button.Tag = pageIndex;
        button.Width = NavButtonWidth(text);
        button.Height = 28;
        button.Margin = new Padding(0, 0, 8, 0);
        button.Cursor = Cursors.Hand;
        button.FlatStyle = FlatStyle.Flat;
        button.UseVisualStyleBackColor = false;
        button.Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Bold);
        button.FlatAppearance.BorderSize = 0;
        button.Paint += PaintNavButton;
        button.Resize += (_, _) => ApplyRoundedButtonRegion(button);
        ApplyRoundedButtonRegion(button);
    }

    private void UpdateNavigationState()
    {
        foreach (var button in _navButtons)
        {
            var selected = button.Tag is int pageIndex && pageIndex == _mainTabs.SelectedIndex;
            button.BackColor = selected ? Color.FromArgb(235, 249, 246) : Color.FromArgb(205, 224, 220);
            button.ForeColor = selected ? Color.FromArgb(22, 68, 66) : Color.FromArgb(70, 91, 96);
            button.Invalidate();
        }

        var advancedSelected = _navButtons.All((button) => button.Tag is not int pageIndex || pageIndex != _mainTabs.SelectedIndex);
        _advancedNavButton.BackColor = advancedSelected ? Color.FromArgb(235, 249, 246) : Color.FromArgb(205, 224, 220);
        _advancedNavButton.ForeColor = advancedSelected ? Color.FromArgb(22, 68, 66) : Color.FromArgb(70, 91, 96);
        _advancedNavButton.Invalidate();
    }

    private static int NavButtonWidth(string text)
    {
        return text.Length switch
        {
            <= 2 => 58,
            <= 3 => 68,
            <= 4 => 78,
            _ => 88,
        };
    }

    private static void PaintNavButton(object? sender, PaintEventArgs e)
    {
        if (sender is not Button button) return;
        var selected = button.BackColor.R > 220;
        var bounds = new Rectangle(0, 0, button.Width - 1, button.Height - 1);

        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = RoundedRect(bounds, 8);
        using var brush = new SolidBrush(button.BackColor);
        using var pen = new Pen(selected ? Color.FromArgb(82, 146, 141) : Color.FromArgb(158, 187, 187));
        e.Graphics.FillPath(brush, path);
        e.Graphics.DrawPath(pen, path);

        TextRenderer.DrawText(
            e.Graphics,
            button.Text,
            button.Font,
            bounds,
            button.ForeColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }

    private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
    {
        var diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private async Task RefreshSelectedPageAsync(bool force = false)
    {
        var index = _mainTabs.SelectedIndex;
        if (index < 0) return;
        if (index != 0 && !force && _loadedNativePages.Contains(index)) return;

        switch (index)
        {
            case 0:
                await RefreshHomeSnapshotAsync();
                break;
            case 1:
                await RefreshOverviewAsync();
                break;
            case 2:
                await RefreshLogsAsync();
                break;
            case 3:
                await RefreshCommandsAsync();
                break;
            case 4:
                await RefreshModulesAsync();
                break;
            case 5:
                await RefreshWorkflowsAsync();
                break;
            case 6:
                await RefreshPluginsAsync();
                break;
            case 8:
                await RefreshBackupsAsync();
                break;
            case 9:
                await RefreshAuditAsync();
                break;
            case 10:
                await RefreshSelfDescriptionAsync();
                break;
            case 11:
                await RefreshConfigAsync();
                break;
        }

        if (index != 0) _loadedNativePages.Add(index);
    }

    private async Task RefreshOverviewAsync()
    {
        await RefreshBoxAsync(_overviewBox, "刷新总览", _adminClient.GetStatusTextAsync);
    }

    private async Task RefreshLogsAsync()
    {
        var filter = ReadControlText(_logFilterBox);
        await RefreshBoxAsync(_adminLogsBox, "刷新日志", () => _adminClient.GetLogsTextAsync(filter));
    }

    private async Task RefreshCommandsAsync()
    {
        await RefreshBoxAsync(_commandsBox, "刷新命令", _adminClient.GetCommandsTextAsync);
    }

    private async Task RefreshModulesAsync()
    {
        await RefreshBoxAsync(_modulesBox, "刷新模块", _adminClient.GetModulesTextAsync);
    }

    private async Task RefreshWorkflowsAsync()
    {
        await RefreshBoxAsync(_workflowsBox, "刷新工作流", _adminClient.GetWorkflowsTextAsync);
    }

    private async Task RefreshPluginsAsync()
    {
        await RefreshBoxAsync(_pluginsBox, "刷新插件", _adminClient.GetPluginsTextAsync);
    }

    private async Task RefreshBackupsAsync()
    {
        await RefreshBoxAsync(_backupsBox, "刷新备份", _adminClient.GetBackupsJsonAsync);
    }

    private async Task RefreshAuditAsync()
    {
        await RefreshBoxAsync(_auditBox, "刷新审计", () => _adminClient.GetAuditTextAsync());
    }

    private async Task PreviewScaffoldAsync()
    {
        await RefreshBoxAsync(_scaffoldOutputBox, "预览命令", () => _adminClient.PreviewCommandScaffoldJsonAsync(ReadControlText(_scaffoldInputBox)));
    }

    private async Task WriteScaffoldAsync()
    {
        var result = MessageBox.Show(
            "将创建命令模板文件，但不会自动接入 manifest 或 dispatcher。是否继续？",
            "生成命令文件",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);
        if (result != DialogResult.Yes) return;
        await RefreshBoxAsync(_scaffoldOutputBox, "生成命令", () => _adminClient.WriteCommandScaffoldJsonAsync(ReadControlText(_scaffoldInputBox)));
    }

    private async Task CreateBackupAsync()
    {
        await RefreshBoxAsync(_backupsBox, "创建备份", _adminClient.CreateBackupJsonAsync);
    }

    private async Task RunBackupActionAsync()
    {
        await RefreshBoxAsync(_backupsBox, "运行备份JSON", () => _adminClient.RunBackupActionJsonAsync(ReadControlText(_backupInputBox)));
    }

    private async Task RefreshSelfDescriptionAsync()
    {
        await RefreshBoxAsync(_selfDescriptionBox, "刷新自描述", _adminClient.GetSelfDescriptionJsonAsync);
    }

    private async Task RefreshConfigAsync()
    {
        await RefreshBoxAsync(_configBox, "刷新配置", _adminClient.GetConfigJsonAsync);
    }

    private async Task SaveConfigAsync()
    {
        var result = MessageBox.Show(
            "保存后需要重启 Bridge 才会生效。是否继续？",
            "保存配置",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);
        if (result != DialogResult.Yes) return;

        await RefreshBoxAsync(_configBox, "保存配置", async () =>
        {
            var response = await _adminClient.SaveConfigJsonAsync(ReadControlText(_configBox));
            _logger.Log("配置已保存，需要重启 Bridge 后生效。");
            return response;
        });
    }

    private async Task RunDiagnoseAsync()
    {
        await RefreshBoxAsync(_diagnoseOutputBox, "运行诊断", () => _adminClient.DiagnoseReplyJsonAsync(ReadControlText(_diagnoseInputBox)));
    }

    private void LoadDiagnoseSample()
    {
        SetBoxText(_diagnoseInputBox, DefaultDiagnoseSample());
    }

    private async Task RefreshBoxAsync(TextBox box, string title, Func<Task<string>> loader)
    {
        try
        {
            SetStatus(title + "中...");
            var text = await loader();
            if (box.ReadOnly)
            {
                text = BuildBeginnerSummary(title) + text;
            }
            SetBoxText(box, text);
        }
        catch (Exception ex)
        {
            SetBoxText(box, "Bridge Admin API 暂不可用。\r\n\r\n" + ex.Message + "\r\n\r\n如果 Bridge 已经在运行，请重启 Bridge 后再刷新。");
        }
        finally
        {
            SetStatus("就绪");
        }
    }

    private static string BuildBeginnerSummary(string title)
    {
        var lines = BeginnerSummaryLines(title);
        if (lines.Length == 0) return "";

        return "【先看这里】\r\n" + string.Join("\r\n", lines.Select(line => "- " + line)) + "\r\n\r\n【详细内容】\r\n";
    }

    private static string[] BeginnerSummaryLines(string title)
    {
        if (title.Contains("总览", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "只要 Bridge 是 ok/在线，机器人主体就是活的。",
                "群、用户、白名单、模型 Key 这里只显示状态，不会显示真实密钥。",
                "看不懂细项时，先回主页点“健康检查”。",
            ];
        }
        if (title.Contains("日志", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里用来查“为什么不回、为什么报错”。",
                "优先找 [E]、error、failed、timeout 这类关键词。",
                "日志里的 key 会脱敏，正常不会泄漏密钥。",
            ];
        }
        if (title.Contains("命令", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里是机器人认识的命令列表。",
                "群聊一般要用 @夜星 开头；私聊可以直接发命令。",
                "permission=admin 表示只有管理员能用。",
            ];
        }
        if (title.Contains("模块", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里看每个功能模块是否启用、入口在哪里、有没有诊断项。",
                "enabled=true 表示模块已接入；reserved 表示预留但没有正式启用。",
            ];
        }
        if (title.Contains("工作流", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里是给以后维护用的操作流程。",
                "普通使用基本不用管；出问题时按对应流程排查。",
            ];
        }
        if (title.Contains("插件", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里目前是只读插件/模块清单。",
                "它只告诉你有什么能力，不会自动安装或卸载东西。",
            ];
        }
        if (title.Contains("备份", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "点“创建备份”会打一个不含隐私和密钥的安全快照。",
                "恢复不会自动覆盖文件，只会给你恢复预案。",
            ];
        }
        if (title.Contains("审计", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里记录本地控制台做过哪些管理操作。",
                "只记路由和时间，不记录聊天原文、请求体或密钥。",
            ];
        }
        if (title.Contains("自描述", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里是项目能力地图，给 Codex/OpenClaw 或以后交接时看。",
                "普通使用可以忽略。",
            ];
        }
        if (title.Contains("预览命令", StringComparison.OrdinalIgnoreCase) || title.Contains("生成命令", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这是命令脚手架输出。",
                "预览只看会生成什么；生成文件不会自动接入主流程。",
            ];
        }
        if (title.Contains("诊断", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里模拟一条消息，判断机器人会不会回复、为什么不回复。",
                "诊断不会真的发消息，也不会调用模型。",
            ];
        }
        if (title.Contains("启动", StringComparison.OrdinalIgnoreCase))
        {
            return [
                "这里是启动器自己的输出。",
                "如果按钮没反应，先看这里有没有路径、权限或依赖错误。",
            ];
        }

        return [];
    }

    private void OpenLogs()
    {
        var logs = LogsDir();
        Directory.CreateDirectory(logs);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", ProcessRunner.QuoteForProcess(logs))
        {
            UseShellExecute = true,
        });
    }

    private string LogsDir()
    {
        return Path.Combine(_config.ProjectDir, "logs");
    }

    private void SetBusy(bool busy, string status)
    {
        _busy = busy;
        _refreshOverviewButton.Enabled = !busy;
        _refreshLogsButton.Enabled = !busy;
        _refreshCommandsButton.Enabled = !busy;
        _refreshModulesButton.Enabled = !busy;
        _refreshWorkflowsButton.Enabled = !busy;
        _refreshPluginsButton.Enabled = !busy;
        _previewScaffoldButton.Enabled = !busy;
        _writeScaffoldButton.Enabled = !busy;
        _refreshBackupsButton.Enabled = !busy;
        _createBackupButton.Enabled = !busy;
        _runBackupActionButton.Enabled = !busy;
        _refreshAuditButton.Enabled = !busy;
        _refreshSelfDescriptionButton.Enabled = !busy;
        _refreshConfigButton.Enabled = !busy;
        _saveConfigButton.Enabled = !busy;
        _runDiagnoseButton.Enabled = !busy;
        _loadDiagnoseSampleButton.Enabled = !busy;
        SetStatus(status);
    }

    private sealed class GlassMenuColorTable : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => Color.FromArgb(236, 245, 242);
        public override Color ImageMarginGradientBegin => ToolStripDropDownBackground;
        public override Color ImageMarginGradientMiddle => ToolStripDropDownBackground;
        public override Color ImageMarginGradientEnd => ToolStripDropDownBackground;
        public override Color MenuBorder => Color.FromArgb(143, 176, 171);
        public override Color MenuItemBorder => Color.FromArgb(112, 159, 151);
        public override Color MenuItemSelected => Color.FromArgb(207, 230, 224);
        public override Color MenuItemSelectedGradientBegin => MenuItemSelected;
        public override Color MenuItemSelectedGradientEnd => MenuItemSelected;
        public override Color MenuItemPressedGradientBegin => Color.FromArgb(194, 221, 214);
        public override Color MenuItemPressedGradientMiddle => MenuItemPressedGradientBegin;
        public override Color MenuItemPressedGradientEnd => MenuItemPressedGradientBegin;
    }

    private void SetStatus(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetStatus(text));
            return;
        }

        _statusLabel.Text = "● " + text;
        _statusLabel.ForeColor = text.Contains("失败", StringComparison.OrdinalIgnoreCase)
            ? Color.FromArgb(150, 55, 55)
            : text.Contains("中", StringComparison.OrdinalIgnoreCase)
                ? Color.FromArgb(45, 96, 126)
                : Color.FromArgb(36, 113, 82);
    }

    private void SetBoxText(TextBox box, string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetBoxText(box, text));
            return;
        }

        box.Text = text;
        box.SelectionStart = 0;
        box.SelectionLength = 0;
    }

    private string ReadControlText(TextBox box)
    {
        if (InvokeRequired)
        {
            return (string)(Invoke(() => ReadControlText(box)) ?? "");
        }

        return box.Text;
    }

    private void AppendLogLine(string line)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendLogLine(line));
            return;
        }

        _launcherLogBox.AppendText(line + Environment.NewLine);
    }

    private static string DefaultScaffoldSample()
    {
        return """
{
  "id": "sample-command",
  "permission": "user",
  "aliases": ["sample", "示例命令"],
  "helpLine": "@夜星 sample-command - 示例命令骨架",
  "write": false
}
""";
    }

    private static string DefaultBackupSample()
    {
        return """
{
  "action": "restore-plan",
  "name": "launcher-YYYYMMDDHHMMSS"
}
""";
    }

    private static string DefaultDiagnoseSample()
    {
        return """
{
  "message_type": "group",
  "group_id": 1000000002,
  "user_id": 1000000010,
  "message": [
    { "type": "at", "data": { "qq": "1000000006" } },
    { "type": "text", "data": { "text": " help" } }
  ],
  "raw_message": "[CQ:at,qq=1000000006] help"
}
""";
    }
}
