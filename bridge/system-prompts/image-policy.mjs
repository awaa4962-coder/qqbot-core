export const IMAGE_POLICY_STABLE = "stable-v3";
export const IMAGE_POLICY_EVIDENCE = "evidence-v4";

export function resolveImagePolicy(scope = {}, rollout = process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT) {
  const value = typeof rollout === "string" ? rollout.trim() : "";
  if (value === "all") return IMAGE_POLICY_EVIDENCE;
  if (!value || value.length > 672 || scope.surface === "private" || scope.groupId === null || scope.groupId === undefined) return IMAGE_POLICY_STABLE;
  const groups = value.split(/[\s,;]+/);
  if (groups.length > 32 || groups.some(group => !/^[1-9]\d{0,19}$/.test(group))) return IMAGE_POLICY_STABLE;
  return groups.includes(String(scope.groupId)) ? IMAGE_POLICY_EVIDENCE : IMAGE_POLICY_STABLE;
}

export function imagePolicyFromOptions(options = {}) {
  if (options.imagePolicy === IMAGE_POLICY_EVIDENCE || options.imagePolicy === IMAGE_POLICY_STABLE) return options.imagePolicy;
  return resolveImagePolicy(options);
}
