// bridge/self-description.mjs - machine-readable project facts for agents and console.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommandCatalog } from "./admin-api/command-catalog.mjs";
import { buildModuleCatalog } from "./admin-api/module-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildProjectSelfDescription(options = {}) {
  const root = options.root || ROOT;
  return {
    architecture: buildArchitectureDescription(root),
    modules: buildModuleDescription(options),
    commands: buildCommandDescription(),
    workflows: buildWorkflowDescription(),
    diagnostics: buildDiagnosticsDescription(),
  };
}

export function buildArchitectureDescription(root = ROOT) {
  const pkg = readPackage(root);
  return {
    schemaVersion: 1,
    project: {
      name: pkg.name || "qqfriend",
      version: pkg.version || "unknown",
      runtime: "Node.js ESM + Windows WinForms launcher",
      entrypoint: "napcat_bridge.mjs",
    },
    roots: {
      bridge: "bridge/",
      launcher: "launcher/QQFriendLauncher/",
      scripts: "scripts/",
      tests: "test/",
      docs: "docs/",
      generated: ".qqfriend/",
    },
    layers: [
      { id: "transport", name: "NapCat OneBot HTTP/WebSocket", files: ["bridge/startup.mjs", "bridge/napcat.mjs"] },
      { id: "routing", name: "message parsing and reply routing", files: ["bridge/reply.mjs", "bridge/reply-group.mjs", "bridge/reply-private.mjs"] },
      { id: "commands", name: "command registry and manifest", files: ["bridge/commands/"] },
      { id: "context", name: "context, memory, image and relationship signals", files: ["bridge/context/", "bridge/context-retriever.mjs", "bridge/system-prompts/", "bridge/knowledge/memes/", "bridge/memory-profile.mjs", "bridge/relationship.mjs"] },
      { id: "models", name: "model routing with fallback", files: ["bridge/model-router.mjs", "bridge/model-mimo.mjs", "bridge/model-ds.mjs"] },
      { id: "ops", name: "admin api, launcher, diagnostics and release", files: ["bridge/admin-api/", "launcher/QQFriendLauncher/", "scripts/release.mjs"] },
      { id: "plugin-center", name: "readonly plugin and workflow inventory", files: ["bridge/admin-api/plugin-catalog.mjs", "bridge/admin-api/backup-manager.mjs"] },
    ],
    safetyBoundaries: [
      "Do not expose model keys or .env_* values.",
      "Do not send reasoning_content, analysis, thinking fields or chain-of-thought.",
      "Do not enable relationship export unless explicitly implemented and reviewed.",
      "Do not call real model APIs from diagnostics.",
      "Image meme cache may store perceptual fingerprints and objective descriptions, never image files or raw group chat.",
      "Keep release packages free of logs, memory files, private docs and .env_* files.",
    ],
  };
}

export function buildModuleDescription(options = {}) {
  return {
    schemaVersion: 1,
    generatedFrom: "bridge/modules/manifest.mjs",
    ...buildModuleCatalog(options),
  };
}

export function buildCommandDescription() {
  return {
    schemaVersion: 1,
    generatedFrom: "bridge/commands/manifest.mjs",
    ...buildCommandCatalog(),
  };
}

export function buildWorkflowDescription() {
  return {
    schemaVersion: 1,
    count: WORKFLOWS.length,
    workflows: WORKFLOWS.map(workflow => ({ ...workflow })),
  };
}

export function buildDiagnosticsDescription() {
  return {
    schemaVersion: 1,
    count: DIAGNOSTICS.length,
    diagnostics: DIAGNOSTICS.map(item => ({ ...item })),
  };
}

export function writeProjectSelfDescription(options = {}) {
  const root = options.root || ROOT;
  const outputDir = options.outputDir || path.join(root, ".qqfriend");
  const data = buildProjectSelfDescription({ ...options, root });
  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, "architecture.json"), data.architecture);
  writeJson(path.join(outputDir, "modules.json"), data.modules);
  writeJson(path.join(outputDir, "commands.json"), data.commands);
  writeJson(path.join(outputDir, "workflows.json"), data.workflows);
  writeJson(path.join(outputDir, "diagnostics.json"), data.diagnostics);
  writeJson(path.join(outputDir, "index.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files: ["architecture.json", "modules.json", "commands.json", "workflows.json", "diagnostics.json"],
  });
  return { outputDir, files: data };
}

const WORKFLOWS = [
  {
    id: "start-all",
    name: "启动全部",
    surface: "launcher",
    steps: ["检查 Node/npm", "确认依赖可用", "启动 NapCat", "启动 Bridge", "启动 watchdog", "检查 JM", "检查日报模块", "GET /health"],
    verify: ["控制台日志显示 Bridge /health OK", "/health 返回 ok"],
  },
  {
    id: "test-release",
    name: "发布前检查",
    surface: "cli",
    steps: ["npm run lint", "npm test", "npm run check:runtime:ci", "npm run check:jm", "npm run release:check"],
    verify: ["lint 0 errors / 0 warnings", "全部测试通过", "release check complete"],
  },
  {
    id: "publish-github",
    name: "发布到 GitHub",
    surface: "cli/github",
    steps: ["检查 git status 和本轮范围", "运行发布前检查", "扫描密钥与运行时文件", "显式暂存源码", "提交并推送分支", "核对远端 commit"],
    verify: ["远端分支包含本次 commit", "没有私密或运行时文件", "最终报告包含分支与 commit"],
  },
  {
    id: "diagnose-reply",
    name: "回复链路诊断",
    surface: "launcher/admin-api",
    steps: ["打开诊断 tab", "粘贴 OneBot 事件或简化 JSON", "POST /admin/diagnose/reply", "查看 gates/command/interjection/replyPlan"],
    verify: ["dryRun=true", "sendsMessage=false", "callsModel=false"],
  },
  {
    id: "edit-config",
    name: "编辑非密钥配置",
    surface: "launcher/admin-api",
    steps: ["GET /admin/config", "只修改 editable 字段", "POST /admin/config", "重启 Bridge"],
    verify: ["只写 .env_bot_names/.env_groups 等非密钥文件", "模型 key 文件不变"],
  },
  {
    id: "add-command",
    name: "新增命令",
    surface: "cli",
    steps: ["npm run command:scaffold -- <id>", "编辑 bridge/commands/modules/<id>.mjs", "补 manifest entry", "补测试", "运行 lint/test"],
    verify: ["command catalog 包含新 id", "help 文案和权限测试通过"],
  },
  {
    id: "refresh-self-description",
    name: "刷新项目自描述",
    surface: "cli",
    steps: ["npm run self:describe", "检查 .qqfriend/*.json", "运行 lint/test"],
    verify: [".qqfriend/index.json 存在", "modules.json 和 commands.json 与 manifest 同步"],
  },
  {
    id: "review-plugins",
    name: "查看插件中心",
    surface: "launcher/admin-api",
    steps: ["GET /admin/plugins", "按 category/riskLevel 查看内置模块", "只使用诊断入口，不启停模块"],
    verify: ["mode=readonly-skeleton", "canInstall/canDisable 均为 false"],
  },
  {
    id: "scaffold-command",
    name: "生成命令骨架",
    surface: "launcher/admin-api",
    steps: ["POST /admin/command-scaffold", "先 dry-run 预览文件和 manifestSnippet", "确认后 write=true 生成模板", "手动接入 manifest 和 dispatcher", "运行 lint/test"],
    verify: ["不覆盖已有文件", "不修改模型、storage、auth 或 reply 主链路"],
  },
  {
    id: "safe-backup",
    name: "安全备份与恢复预案",
    surface: "launcher/admin-api",
    steps: ["POST /admin/backups action=create", "GET /admin/backups 查看备份", "POST /admin/backups action=restore-plan 查看恢复步骤"],
    verify: ["不包含 .env_*", "不包含 logs/memory/user_memory/group_chats", "恢复只输出预案，不自动覆盖文件"],
  },
  {
    id: "audit-admin-ops",
    name: "查看管理操作审计",
    surface: "launcher/admin-api",
    steps: ["GET /admin/audit", "查看最近管理路由访问", "必要时结合 logs tab 排查"],
    verify: ["不记录请求体", "不记录 key 或聊天原文"],
  },
];

const DIAGNOSTICS = [
  {
    id: "group-no-reply",
    symptom: "群聊没有回复",
    check: ["POST /admin/diagnose/reply", "确认 groupWhitelisted", "确认 isAtMe 或 interjection decision", "检查日志里的 cooldown 或 model output risks"],
    likelyCauses: ["group_not_whitelisted", "not mentioned", "cooldown", "model returned unsafe/empty content"],
    safeFixes: ["把群加入 .env_groups", "使用已配置 bot 名称 @", "配置变更后重启 Bridge"],
  },
  {
    id: "mention-not-recognized",
    symptom: "@ 后机器人不触发",
    check: ["诊断 mentions.isAtMe", "检查 CQ at qq 是否等于 CFG.selfUin", "检查 QQBOT_NAMES/.env_bot_names 是否包含可见 @ 名"],
    likelyCauses: ["bot qq 配置错误", "可见名称未配置", "消息 segment 缺少 at item"],
    safeFixes: ["更新 botNames", "重启 Bridge", "抓取 raw OneBot event 做诊断"],
  },
  {
    id: "jm-failure",
    symptom: "JM 下载失败",
    check: ["npm run check:jm", "查看 admin modules 里的 jm healthChecks", "检查日志是否有 missing_jmcomic_source 或 missing_python_dependency"],
    likelyCauses: ["Python 依赖缺失", "镜像/API 不可用", "7z 不可用", "群不在资源白名单"],
    safeFixes: ["npm run check:jm:install", "配置 QQBOT_JM_DOMAINS", "保留临时文件直到上传完成"],
  },
  {
    id: "daily-summary-issue",
    symptom: "日报缺失或日期不对",
    check: ["summaryGroupWhitelist", "logs", "summary:date command", "北京时间 00:00-05:59 默认总结昨天"],
    likelyCauses: ["群被排除", "消息太少", "计划任务未运行", "模型输出为空"],
    safeFixes: ["编辑 .env_summary_groups", "手动运行 summary:date", "检查 Windows scheduled task"],
  },
  {
    id: "release-risk",
    symptom: "发布包可能带入私密文件",
    check: ["npm run release:check", "dist/release-file-list.txt", "release forbidden paths tests"],
    likelyCauses: ["release root 新增后未排除私有文件", "private file 未加入 forbidden list"],
    safeFixes: ["更新 scripts/release.mjs forbidden lists", "补 release test"],
  },
];

function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
