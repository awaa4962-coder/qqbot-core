const MAX_HYDRATE = 4;

export async function hydrateMentions(mentions, options = {}) {
  const groupId = String(options.groupId || options.group_id || "");
  const fetchMember = options.getGroupMemberInfo;
  if (!groupId || typeof fetchMember !== "function") return mentions || [];

  const targets = (Array.isArray(mentions) ? mentions : [])
    .filter(item => !item.isBot && !item.isAll)
    .slice(0, options.limit || MAX_HYDRATE);

  for (const mention of targets) {
    const info = await safeFetchMember(fetchMember, groupId, mention.qq);
    applyMemberInfo(mention, info);
  }
  return mentions;
}

async function safeFetchMember(fetchMember, groupId, qq) {
  try {
    return await fetchMember(groupId, qq);
  } catch {
    return null;
  }
}

function applyMemberInfo(mention, info) {
  if (!info) return;
  const card = safeName(info.card);
  const nickname = safeName(info.nickname || info.nick);
  mention.groupCard = card;
  mention.nickname = nickname;
  mention.displayName = card || nickname || mention.displayName || "";
}

function safeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
}
