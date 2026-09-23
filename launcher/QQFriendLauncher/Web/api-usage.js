(function initializeApiUsage() {
  "use strict";
  const host = window.QQFriendHost;
  if (host?.mode !== "browser") return;
  const $ = id => document.getElementById(id);
  const panel = $("apiUsagePanel");
  const view = document.querySelector('[data-view-panel="api-center"]');
  if (!panel || !view) return;
  const filters = [
    ["model", "models", "apiUsageModel"], ["task", "tasks", "apiUsageTask"],
    ["provider", "providers", "apiUsageProvider"], ["position", "positions", "apiUsagePosition"],
    ["promptVersion", "promptVersions", "apiUsagePromptVersion"], ["effectiveMode", "effectiveModes", "apiUsageEffectiveMode"],
  ];
  const modes = { economy: "省额度", auto: "智能", deep: "深度", provider_default: "供应商默认", not_supported: "不支持", unknown: "未知" };
  const applied = { yes: "已应用", no: "未应用", unknown: "未知" };
  const unknown = "未知";
  let requestId = 0;
  let loaded = false;
  let pending = false;
  let taskLabels = {};
  const positions = { primary: "主模型", fallback: "备用模型", direct: "直接调用", unknown: "未知" };
  const controls = { "provider-default": "供应商默认", "mimo-toggle": "MiMo 开关", "deepseek-toggle": "DeepSeek 开关", effort: "强度档位", none: "不支持", unknown: "未知" };

  const validNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const number = value => validNumber(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : unknown;
  const text = value => typeof value === "string" && value.trim() && value !== "unknown" ? value : unknown;
  const mode = value => Object.hasOwn(modes, value) ? modes[value] : text(value);
  const task = value => Object.hasOwn(taskLabels, value) ? text(taskLabels[value]) : text(value);
  const position = value => Object.hasOwn(positions, value) ? positions[value] : text(value);
  const control = value => Object.hasOwn(controls, value) ? controls[value] : text(value);
  const elapsed = value => !validNumber(value) ? unknown : value >= 1000 ? `${number(value / 1000)} 秒` : `${number(value)} ms`;
  const measured = (leaf, key, flag) => leaf[flag] > 0 && validNumber(leaf[flag]) ? number(leaf[key]) : unknown;
  const transport = leaf => Object.hasOwn(leaf, "transportReportedCalls") ? measured(leaf, "transportAttempts", "transportReportedCalls") : number(leaf.transportAttempts);
  const duration = (leaf, key) => Object.hasOwn(leaf, "durationReportedCalls") && !(leaf.durationReportedCalls > 0) ? unknown : elapsed(leaf[key]);
  const reported = (leaf, flag) => `已上报 ${number(leaf[flag])} / ${number(leaf.calls)} 次`;
  const partial = (leaf, flag) => !validNumber(leaf[flag]) || !validNumber(leaf.calls) || leaf[flag] < leaf.calls;

  function node(tag, value, className) {
    const result = document.createElement(tag);
    if (value !== undefined) result.textContent = value;
    if (className) result.className = className;
    return result;
  }

  function cacheRate(leaf) {
    // Weight only cache-reported input, never all prompt tokens or per-call rates.
    if (!validNumber(leaf.cacheReportedCalls) || !(leaf.cacheReportedCalls > 0) || !validNumber(leaf.cachedTokens) || !validNumber(leaf.measuredPromptTokens)
      || leaf.measuredPromptTokens === 0 || leaf.cachedTokens > leaf.measuredPromptTokens) return unknown;
    return `${(100 * leaf.cachedTokens / leaf.measuredPromptTokens).toFixed(1)}%`;
  }

  function cacheDetail(leaf) {
    return `命中 ${measured(leaf, "cachedTokens", "cacheReportedCalls")} / 实测输入 ${measured(leaf, "measuredPromptTokens", "cacheReportedCalls")} Token`;
  }

  function notice(value, state) {
    $("apiUsageNotice").textContent = value;
    $("apiUsageNotice").dataset.state = state;
  }

  function query() {
    const result = { days: Number($("apiUsageDays").value) };
    for (const [key, , id] of filters) if ($(id).value) result[key] = $(id).value;
    return result;
  }

  function renderFacets(facets) {
    for (const [key, facet, id] of filters) {
      const select = $(id);
      const selected = select.value;
      const values = [...new Set([...(Array.isArray(facets?.[facet]) ? facets[facet] : []), selected]
        .filter(value => typeof value === "string" && value))];
      const all = node("option", "全部"); all.value = "";
      select.replaceChildren(all);
      for (const value of values) {
        const label = key === "task" ? task(value) : key === "position" ? position(value) : key === "effectiveMode" ? mode(value) : text(value);
        const option = node("option", label);
        option.value = value;
        select.append(option);
      }
      select.value = selected;
      select.title = selected || "全部";
    }
  }

  function renderSummary(leaf) {
    const root = $("apiUsageSummary");
    root.replaceChildren();
    const metrics = [
      ["调用记录 / 失败", `${number(leaf.calls)} / ${number(leaf.failedCalls)}`, `成功 ${number(leaf.successfulCalls)} · 传输尝试 ${transport(leaf)}`],
      ["输入 Token", measured(leaf, "promptTokens", "promptReportedCalls"), reported(leaf, "promptReportedCalls")],
      ["输出 Token", measured(leaf, "completionTokens", "completionReportedCalls"), reported(leaf, "completionReportedCalls")],
      ["推理 Token", measured(leaf, "reasoningTokens", "reasoningReportedCalls"), reported(leaf, "reasoningReportedCalls")],
      ["总计 Token", measured(leaf, "totalTokens", "totalReportedCalls"), reported(leaf, "totalReportedCalls")],
      ["缓存 Token 比例", cacheRate(leaf), `${cacheDetail(leaf)} · ${reported(leaf, "cacheReportedCalls")}`],
      ["平均耗时", leaf.calls > 0 ? duration(leaf, "avgDurationMs") : unknown, `累计 ${duration(leaf, "durationMs")}`],
      ["已报告用量", `${number(leaf.usageReportedCalls)} / ${number(leaf.calls)} 次`, partial(leaf, "usageReportedCalls") ? "部分上报" : "全部上报"],
    ];
    for (const [label, value, detail] of metrics) {
      const item = node("div");
      item.append(node("dt", label), node("dd", value), node("small", detail));
      root.append(item);
    }
  }

  function renderRows(rows, complete) {
    const body = $("apiUsageRows");
    body.replaceChildren();
    if (!rows.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = 10; cell.textContent = complete ? "当前范围与筛选无记录" : "记录未完整读取，暂无可展示分组";
    }
    for (const leaf of rows) {
      const row = body.insertRow();
      const cell = (value, detail, wrap = false) => {
        const result = row.insertCell();
        if (wrap) { result.className = "api-usage-text"; result.title = [value, detail].filter(Boolean).join(" · "); }
        result.append(node("strong", value));
        if (detail) result.append(node("small", detail));
        return result;
      };
      cell(text(leaf.model), text(leaf.provider), true);
      cell(task(leaf.task), position(leaf.position), true);
      cell(text(leaf.promptVersion), `指纹 ${text(leaf.promptFingerprint)}`, true);
      cell(`${mode(leaf.configuredMode)} → ${mode(leaf.effectiveMode)}`,
        `控制 ${control(leaf.reasoningControl)} · ${Object.hasOwn(applied, leaf.reasoningApplied) ? applied[leaf.reasoningApplied] : unknown}`, true);
      cell(`${number(leaf.calls)} / ${number(leaf.failedCalls)}`, `传输 ${transport(leaf)}`).dataset.error = String(leaf.failedCalls > 0);
      for (const [key, flag] of [["promptTokens", "promptReportedCalls"], ["completionTokens", "completionReportedCalls"], ["reasoningTokens", "reasoningReportedCalls"]]) {
        cell(measured(leaf, key, flag), reported(leaf, flag)).dataset.partial = String(partial(leaf, flag));
      }
      const cache = cell(cacheRate(leaf), cacheDetail(leaf));
      cache.append(node("small", reported(leaf, "cacheReportedCalls")));
      cache.dataset.partial = String(partial(leaf, "cacheReportedCalls"));
      cell(leaf.calls > 0 ? duration(leaf, "avgDurationMs") : unknown,
        Object.hasOwn(leaf, "durationReportedCalls") ? reported(leaf, "durationReportedCalls") : "");
    }
  }

  function date(value) {
    if (typeof value !== "number" && typeof value !== "string") return unknown;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("zh-CN", { hour12: false }) : unknown;
  }

  function render(data) {
    taskLabels = data.taskLabels && typeof data.taskLabels === "object" ? data.taskLabels : {};
    renderFacets(data.facets);
    renderSummary(data.summary);
    renderRows(data.rows, data.coverage?.complete === true);
    $("apiUsageWindow").textContent = `${date(data.since)} 至 ${date(data.now)} · ${number(data.days)} 天`;
    const coverage = data.coverage || {};
    const incomplete = coverage.complete !== true || coverage.truncated === true
      || [coverage.invalidRecords, coverage.unreadableFiles, coverage.rowsOmitted].some(value => !validNumber(value) || value > 0);
    $("apiUsageCoverage").dataset.partial = String(incomplete);
    $("apiUsageCoverage").textContent = [
      incomplete ? "部分覆盖" : "记录覆盖完整", coverage.truncated === true && "已截断",
      `已读文件 ${number(coverage.filesRead)}`, `无效记录 ${number(coverage.invalidRecords)}`,
      `不可读文件 ${number(coverage.unreadableFiles)}`, `省略分组 ${number(coverage.rowsOmitted)}`,
      coverage.writeFailuresSinceStart > 0 && `本进程写入失败 ${number(coverage.writeFailuresSinceStart)} 次`,
      data.summary.legacyCalls > 0 && `旧版记录 ${number(data.summary.legacyCalls)} 条，模型/版本/重试信息可能未知`,
    ].filter(Boolean).join(" · ");
    const cache = data.localCaches?.imageDescription || {};
    $("apiUsageLocalCache").textContent = `本地图片描述缓存 · ${cache.enabled === true ? "已启用" : cache.enabled === false ? "已停用" : unknown}`
      + ` · 条目 ${number(cache.entries)} · 命中 ${number(cache.hits)} · 未命中 ${number(cache.misses)}`
      + ` · ${cache.persistent === false ? "仅本次进程，不持久化" : "持久化状态未知"}`;
    $("apiUsageResults").hidden = false;
    const emptyText = incomplete ? "记录未完整读取，暂无可展示分组" : "当前范围与筛选无记录";
    notice(data.rows.length ? `${number(data.rows.length)} 个分组${incomplete ? " · 部分覆盖" : ""}` : emptyText, data.rows.length ? "ready" : "empty");
  }

  async function refresh() {
    if (view.hidden) return;
    const id = ++requestId;
    pending = true;
    panel.setAttribute("aria-busy", "true");
    $("apiUsageRefresh").disabled = true;
    // Hide the old query's data while filters change or a refresh fails.
    $("apiUsageResults").hidden = true;
    notice("正在读取用量…", "loading");
    try {
      const data = await host.call("getApiUsage", query());
      if (id !== requestId) return;
      if (data?.schema !== 2 || !data.summary || !Array.isArray(data.rows) || data.rows.some(row => !row || typeof row !== "object")) {
        throw new Error("用量数据格式不兼容（需要 schema 2）");
      }
      render(data);
      loaded = true;
    } catch (error) {
      if (id !== requestId) return;
      loaded = false;
      notice(`读取失败：${typeof error?.message === "string" ? error.message : "用量暂不可用"}`, "error");
    } finally {
      if (id === requestId) {
        pending = false;
        panel.setAttribute("aria-busy", "false");
        $("apiUsageRefresh").disabled = false;
      }
    }
  }

  function visibilityChanged() {
    if (view.hidden && pending) {
      requestId++;
      pending = false;
      loaded = false;
      panel.setAttribute("aria-busy", "false");
      $("apiUsageRefresh").disabled = false;
    } else if (!view.hidden && !loaded && !pending) refresh();
  }

  panel.hidden = false;
  $("apiUsageRefresh").addEventListener("click", refresh);
  $("apiUsageDays").addEventListener("change", refresh);
  for (const [, , id] of filters) $(id).addEventListener("change", refresh);
  new MutationObserver(visibilityChanged).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  visibilityChanged();
})();
