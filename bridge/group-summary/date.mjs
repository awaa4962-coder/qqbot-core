export function formatDate(date = new Date()) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function shanghaiDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

export function resolveSummaryDate(now = new Date(), options = {}) {
  const rolloverHour = Number(options.rolloverHour ?? 6);
  const parts = shanghaiDateParts(now);
  const dateText = parts.year + "-" + parts.month + "-" + parts.day;
  if (Number(parts.hour) >= rolloverHour) return dateText;
  return formatDate(new Date(Date.parse(dateText + "T00:00:00+08:00") - 24 * 60 * 60 * 1000));
}

export function dateRange(dateText) {
  const start = Date.parse(String(dateText) + "T00:00:00+08:00");
  if (!Number.isFinite(start)) throw new Error("invalid date: " + dateText);
  return { start, end: start + 24 * 60 * 60 * 1000 - 1 };
}

export function dateLabel(dateText) {
  const { start } = dateRange(dateText);
  return new Date(start).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  });
}
