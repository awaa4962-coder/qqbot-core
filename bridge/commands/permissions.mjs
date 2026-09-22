import { CFG } from "../config.mjs";

export function isAdminUser(userId, admins = CFG.adminUins) {
  return admins.map(String).includes(String(userId));
}

export function requireAdmin(userId, admins) {
  return isAdminUser(userId, admins) ? "" : "这个命令需要管理员权限。";
}

export function canUsePrivateChat(userId, cfg = CFG) {
  return (cfg.friendWhitelist || []).map(String).includes(String(userId));
}
