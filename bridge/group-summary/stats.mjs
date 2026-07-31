export function buildSummaryStats(messages) {
  const userMap = {};
  for (const m of messages || []) {
    const key = String(m.uid || "unknown");
    if (!userMap[key]) userMap[key] = { nick: m.nickname || "群友", count: 0 };
    userMap[key].count++;
  }
  const users = Object.values(userMap).sort((a, b) => b.count - a.count);
  return {
    messageCount: messages.length,
    speakerCount: users.length,
    top3: users.slice(0, 3).map(u => `${u.nick}（${u.count}条）`).join("、") || "暂无",
  };
}
