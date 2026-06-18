// bridge/services/link-preview/bilibili.mjs — B站视频预览
import { safeFetch } from "./safe-fetch.mjs";

function formatNum(n) {
  if (!n) return n;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
}

/**
 * 检测 URL 是否为 B站视频链接
 */
export function isBilibiliUrl(url) {
  return /bilibili\.com\/video\/BV[a-zA-Z0-9]+/.test(url) || /b23\.tv\/[a-zA-Z0-9]+/.test(url);
}

/**
 * 从 URL 提取 BV 号
 */
export function extractBvid(url) {
  const m1 = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/b23\.tv\/([a-zA-Z0-9]+)/);
  return m2 ? m2[1] : null;
}

/**
 * 解析 B站视频信息
 * @returns {{text:string, image:string|null, bvid:string}|null}
 */
export async function fetchBilibiliInfo(url) {
  let bvid = extractBvid(url);
  if (!bvid) return null;

  // b23.tv 短链重定向
  if (url.includes("b23.tv")) {
    try {
      const redir = await fetch("https://b23.tv/" + bvid, {
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "manual",
      });
      const loc = redir.headers.get("location") || "";
      const m = loc.match(/\/video\/(BV[a-zA-Z0-9]+)/);
      if (m) bvid = m[1];
    } catch {
      return null;
    }
  }

  try {
    const r = await fetch("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.bilibili.com",
      },
    });
    const d = await r.json();
    if (d?.code !== 0 || !d?.data) return null;

    const { title, desc, owner, stat, pic, duration, pubdate, tname } = d.data;
    const durMin = Math.floor((duration || 0) / 60);
    const durSec = (duration || 0) % 60;
    const durStr = duration ? durMin + ":" + String(durSec).padStart(2, "0") : "";
    const dateStr = pubdate ? new Date(pubdate * 1000).toLocaleDateString("zh-CN") : "";

    const info = ["🎬 " + title, "UP " + (owner?.name || "?")];
    const metaParts = [];
    if (durStr) metaParts.push("⏱" + durStr);
    if (dateStr) metaParts.push("📅" + dateStr);
    if (tname) metaParts.push("🏷" + tname);
    if (metaParts.length) info.push(metaParts.join("  "));

    if (stat) {
      if (stat.view) info.push("▶ 播放 " + formatNum(stat.view));
      const stat2 = [];
      if (stat.danmaku) stat2.push("💬 弹幕 " + formatNum(stat.danmaku));
      if (stat.like) stat2.push("👍 " + formatNum(stat.like));
      if (stat2.length) info.push(stat2.join("  "));
      const stat3 = [];
      if (stat.coin) stat3.push("🪙 " + formatNum(stat.coin));
      if (stat.favorite) stat3.push("⭐ " + formatNum(stat.favorite));
      if (stat.share) stat3.push("↗ " + formatNum(stat.share));
      if (stat3.length) info.push(stat3.join("  "));
    }

    if (desc) info.push("📝 " + desc.slice(0, 120));
    return { text: info.join("\n"), image: pic || "", bvid };
  } catch {
    return null;
  }
}
