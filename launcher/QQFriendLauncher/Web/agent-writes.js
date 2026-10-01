const MAX_ITEMS = 128;
const MAX_TIME = 253402271999999;
const actions = {
  set_name: "修改称呼", set_style: "修改风格", memory_create: "新增记忆",
  memory_update: "修改记忆", memory_remove: "删除记忆", create: "创建提醒", cancel: "取消提醒",
};
const phases = {
  pending: "待本人确认", executing: "执行中", applied: "已应用", not_applied: "未应用",
  unknown: "结果未知", revoked: "已撤销", expired: "已过期", invalidated: "已失效", armed: "待发送",
  sending: "发送中", sent: "已发送", failed: "失败", cancelled: "已取消",
  partial: "部分完成", interrupted: "已中断",
};
const known = (labels, value) => typeof value === "string" && Object.hasOwn(labels, value);
const data = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructor = data(prototype, "constructor");
  return Object.getPrototypeOf(prototype) === null && typeof constructor === "function" &&
    data(constructor, "name") === "Object";
}

const own = (value, key) => record(value) ? data(value, key) : undefined;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;

function timeValue(value) {
  if (timestamp(value)) return value;
  if (typeof value !== "string" || value.length > 29) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, millisecond = "000", zone, sign, offsetHour, offsetMinute] = match;
  const parts = [year, month, day, hour, minute, second, millisecond].map(Number);
  if (parts[0] < 1970 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59 ||
      zone !== "Z" && (Number(offsetHour) > 14 || Number(offsetMinute) > 59 || Number(offsetHour) === 14 && Number(offsetMinute) !== 0)) return undefined;
  const local = Date.UTC(parts[0], parts[1] - 1, ...parts.slice(2));
  const date = new Date(local);
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() + 1 !== parts[1] || date.getUTCDate() !== parts[2]) return undefined;
  const offset = zone === "Z" ? 0 : (Number(offsetHour) * 60 + Number(offsetMinute)) * 60000 * (sign === "+" ? 1 : -1);
  const result = local - offset;
  return timestamp(result) ? result : undefined;
}

const timeLabel = value => new Date(value + 28800000).toISOString().slice(0, 19).replace("T", " ");

function itemView(value, kind) {
  const ref = own(value, "ref");
  const phase = own(value, "phase");
  const action = kind === "confirmations" ? own(value, "action") : undefined;
  const createdAt = timeValue(own(value, "createdAt"));
  const deadline = timeValue(own(value, kind === "confirmations" ? "expiresAt" : "dueAt"));
  const prefix = kind === "confirmations" ? "cf_" : "rem_";
  if (typeof ref !== "string" || ref.length !== prefix.length + 32 || !ref.startsWith(prefix) ||
      !/^[a-f0-9]{32}$/.test(ref.slice(prefix.length)) || !known(phases, phase) ||
      kind === "confirmations" && !known(actions, action) || createdAt === undefined || deadline === undefined || deadline <= createdAt) return undefined;
  return { ref, phase, action, createdAt, deadline };
}

function listView(value, kind) {
  if (own(value, "status") === "unavailable") return { state: "unavailable" };
  if (own(value, "status") !== "ready") return { state: "malformed" };
  const items = own(value, "items");
  if (!Array.isArray(items)) return { state: "malformed" };
  const length = data(items, "length");
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ITEMS) return { state: "malformed" };
  const rows = []; const refs = new Set();
  for (let index = 0; index < length; index++) {
    const row = itemView(data(items, String(index)), kind);
    if (!row || refs.has(row.ref)) return { state: "malformed" };
    refs.add(row.ref); rows.push(row);
  }
  return { state: "ready", rows };
}

function snapshotView(snapshot) {
  try {
    const status = own(snapshot, "status");
    const enabled = own(snapshot, "enabled");
    if (typeof enabled !== "boolean" || !["ready", "unavailable"].includes(status)) return { state: "malformed" };
    if (status === "unavailable") return { state: "unavailable", enabled };
    return { state: "ready", enabled,
      confirmations: listView(own(snapshot, "confirmations"), "confirmations"),
      reminders: listView(own(snapshot, "reminders"), "reminders") };
  } catch {
    return { state: "malformed" };
  }
}

function metadataTable(element, view, kind) {
  const table = element("table", undefined, "agent-writes-table");
  Object.assign(table.style, { width: "100%", maxWidth: "100%", minWidth: "0", tableLayout: "fixed",
    borderCollapse: "collapse", fontSize: "12px", lineHeight: "1.6" });
  const head = element("thead"); const heading = element("tr");
  for (const [label, width] of [["记录", "38%"], ["状态", "22%"], ["北京时间", "40%"]]) {
    const cell = element("th", label); cell.scope = "col";
    Object.assign(cell.style, { width, padding: "6px 4px", textAlign: "left", overflowWrap: "anywhere" });
    heading.append(cell);
  }
  head.append(heading); table.append(head);
  const body = element("tbody");
  for (const item of view.rows) {
    const row = element("tr"); const cells = [element("td"), element("td", phases[item.phase]), element("td")];
    for (const cell of cells) Object.assign(cell.style, { padding: "8px 4px", verticalAlign: "top",
      whiteSpace: "normal", overflowWrap: "anywhere", borderBottom: "1px solid var(--line)" });
    if (item.action !== undefined) cells[0].append(element("div", actions[item.action]));
    const ref = element("code", item.ref);
    Object.assign(ref.style, { fontSize: "11px", whiteSpace: "normal", overflowWrap: "anywhere" });
    cells[0].append(ref);
    cells[2].append(element("div", `创建：${timeLabel(item.createdAt)}`),
      element("div", `${kind === "confirmations" ? "到期" : "计划"}：${timeLabel(item.deadline)}`));
    row.append(...cells); body.append(row);
  }
  table.append(body); return table;
}

function metadataList(element, view, kind) {
  const label = kind === "confirmations" ? "确认记录" : "提醒记录";
  const region = element("div", undefined, `agent-writes-${kind}`);
  Object.assign(region.style, { minWidth: "0", maxWidth: "100%", marginTop: "16px" });
  region.setAttribute("role", "region"); region.setAttribute("aria-label", label);
  const heading = element("h4", label);
  Object.assign(heading.style, { fontSize: "13px", margin: "0 0 8px", lineHeight: "1.5" });
  region.append(heading);
  if (view.state === "ready" && view.rows.length) region.append(metadataTable(element, view, kind));
  else {
    const text = view.state === "ready" ? `服务端未列出${label}` :
      view.state === "unavailable" ? `${label}无法读取` : `${label}状态未知`;
    const notice = element("p", text, "diagnostic-notice"); notice.setAttribute("role", "status");
    region.append(notice);
  }
  return region;
}

/** Metadata only. The parent owns refresh delegation, API calls and actual author confirmation. */
export function mountAgentWrites(container, snapshot) {
  if (!container?.ownerDocument || typeof container.ownerDocument.createElement !== "function" ||
      typeof container.replaceChildren !== "function") throw new TypeError("DOM container required");
  const document = container.ownerDocument;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const view = snapshotView(snapshot);
  const panel = element("section", undefined, "agent-tools agent-writes");
  Object.assign(panel.style, { minWidth: "0", maxWidth: "100%", overflowWrap: "anywhere" });
  panel.setAttribute("aria-label", "Agent 写入状态");
  const head = element("div", undefined, "section-head agent-writes-head");
  Object.assign(head.style, { flexWrap: "wrap", alignItems: "center" });
  const refresh = element("button", "\u21bb", "memory-icon agent-writes-refresh");
  refresh.type = "button"; refresh.dataset.action = "refreshAgentWrites";
  refresh.setAttribute("title", "刷新状态"); refresh.setAttribute("aria-label", "刷新状态");
  Object.assign(refresh.style, { width: "36px", minWidth: "36px", maxWidth: "100%", height: "34px", flexShrink: "0" });
  head.append(element("h3", "Agent 写入"), refresh);
  const notice = element("p", `${view.state === "ready" ? "服务端状态" : view.state === "unavailable" ? "状态无法读取" : "状态未知"} · ${
    view.enabled === false ? "未开放" : view.state === "ready" ? "已开放" : "开放状态未知"}`, "diagnostic-notice");
  notice.setAttribute("role", "status"); panel.append(head, notice);
  for (const kind of ["confirmations", "reminders"]) panel.append(metadataList(element,
    view.state === "ready" ? view[kind] : { state: view.state }, kind));
  container.replaceChildren(panel);
  return panel;
}
