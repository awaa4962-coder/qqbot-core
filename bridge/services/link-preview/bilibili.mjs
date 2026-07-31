function formatNum(n) {
  if (!n) return n;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
}

export function isBilibiliUrl(url) {
  return /bilibili\.com\/video\/BV[a-zA-Z0-9]+/.test(url) || /b23\.tv\/[a-zA-Z0-9]+/.test(url);
}

export function extractBvid(url) {
  const m1 = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/b23\.tv\/([a-zA-Z0-9]+)/);
  return m2 ? m2[1] : null;
}

async function resolveBilibiliUrl(url, bvid) {
  if (!url.includes("b23.tv")) return bvid;
  try {
    const redir = await fetch("https://b23.tv/" + bvid, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
    });
    const loc = redir.headers.get("location") || "";
    const m = loc.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    return m ? m[1] : bvid;
  } catch {
    return null;
  }
}

async function fetchBilibiliPage(bvid) {
  const r = await fetch("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://www.bilibili.com",
    },
  });
  const data = await r.json();
  return data?.code === 0 ? data.data : null;
}

function formatDuration(duration) {
  const durMin = Math.floor((duration || 0) / 60);
  const durSec = (duration || 0) % 60;
  return duration ? durMin + ":" + String(durSec).padStart(2, "0") : "";
}

function formatVideoMeta(data) {
  const metaParts = [];
  const durStr = formatDuration(data.duration);
  const dateStr = data.pubdate ? new Date(data.pubdate * 1000).toLocaleDateString("zh-CN") : "";
  if (durStr) metaParts.push("⏱ " + durStr);
  if (dateStr) metaParts.push("📅 " + dateStr);
  if (data.tname) metaParts.push("🏷 " + data.tname);
  return metaParts;
}

function formatVideoStats(stat) {
  const lines = [];
  if (!stat) return lines;

  if (stat.view) lines.push("▶ 播放 " + formatNum(stat.view));

  const stat2 = [];
  if (stat.danmaku) stat2.push("💬 弹幕 " + formatNum(stat.danmaku));
  if (stat.like) stat2.push("👍 " + formatNum(stat.like));
  if (stat2.length) lines.push(stat2.join("  "));

  const stat3 = [];
  if (stat.coin) stat3.push("🪙 " + formatNum(stat.coin));
  if (stat.favorite) stat3.push("⭐ " + formatNum(stat.favorite));
  if (stat.share) stat3.push("↗ " + formatNum(stat.share));
  if (stat3.length) lines.push(stat3.join("  "));
  return lines;
}

function formatBilibiliPreview(data, bvid) {
  const { title, desc, owner, stat, pic } = data;
  const info = ["🎬 " + title, "UP " + (owner?.name || "?")];
  const metaParts = formatVideoMeta(data);
  if (metaParts.length) info.push(metaParts.join("  "));
  info.push(...formatVideoStats(stat));
  if (desc) info.push("📝 " + desc.slice(0, 120));
  return { text: info.join("\n"), image: pic || "", bvid };
}

export async function fetchBilibiliInfo(url) {
  let bvid = extractBvid(url);
  if (!bvid) return null;

  bvid = await resolveBilibiliUrl(url, bvid);
  if (!bvid) return null;

  try {
    const data = await fetchBilibiliPage(bvid);
    return data ? formatBilibiliPreview(data, bvid) : null;
  } catch {
    return null;
  }
}
