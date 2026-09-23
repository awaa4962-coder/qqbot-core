import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";

// Imported runtime modules must never read the operator's config or memory files.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memory-commands-"));
const environment = {
  NODE_ENV: "test",
  QQBOT_CONFIG_ROOT: path.join(sandbox, "config"),
  QQBOT_DATA_DIR: path.join(sandbox, "data"),
  QQBOT_LOG_DIR: path.join(sandbox, "logs"),
  QQBOT_TEMP_DIR: path.join(sandbox, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(sandbox, "memory.json"),
};
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const {
  buildCommandReply, buildCommandReplyAsync,
  buildGroupCommandReply, buildGroupCommandReplyAsync,
  buildPrivateCommandReply, buildPrivateCommandReplyAsync,
} = await import("../bridge/commands/dispatcher.mjs");
const { dispatchGroupCommand, isCommandContext } = await import("../bridge/commands/action-dispatcher.mjs");
const { isKnownCommand } = await import("../bridge/commands/registry.mjs");
const { COMMAND_DEFINITIONS, helpLinesForPage } = await import("../bridge/commands/manifest.mjs");
const { buildCapabilityCatalog, buildCapabilityHelpText, CAPABILITY_DEFINITIONS } = await import("../bridge/capabilities/catalog.mjs");
const { buildMemoryCommandReplyAsync, isSelfMemoryCommand, memoryCommandHelp } = await import("../bridge/commands/modules/memory.mjs");
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { handlePrivateMessage } = await import("../bridge/reply-private.mjs");
const { CFG } = await import("../bridge/config.mjs");

before(context => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("Memory commands must not call a model or the network"));
});
after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const now = Date.parse("2026-09-23T00:00:00Z");
const cfg = {
  friendWhitelist: [42], adminUins: [84], selfUin: 999,
  groupWhitelist: [100, 200], botBlacklist: [], jmUserWhitelist: [66],
};
const optionsFor = (noteService, extra = {}) => ({
  cfg, userId: 42, groupId: 100, messageId: 71, now, noteService, skipSave: true, ...extra,
});
const groupContext = (text, extra = {}) => ({
  message_type: "group", isAtMe: true, text, rawText: text,
  user_id: 42, group_id: 100, message_id: 71, mentions: [], mentionedUsers: [], ...extra,
});
const privateContext = (text, extra = {}) => ({
  message_type: "private", text, user_id: 42, message_id: -72, files: [], images: [], ...extra,
});

function fakeService() {
  const calls = [];
  const scopes = new Map();
  function get(scope) {
    const key = String(scope.userId) + ":" + String(scope.groupId);
    if (!scopes.has(key)) scopes.set(key, { revision: "Rev_A0", items: [] });
    return scopes.get(key);
  }
  return {
    calls,
    snapshot(scope) {
      calls.push({ method: "snapshot", scope: { ...scope } });
      return JSON.parse(JSON.stringify(get(scope)));
    },
    act(payload, context) {
      calls.push({ method: "act", payload, context });
      const current = get(payload);
      assert.equal(payload.revision, current.revision);
      const index = current.items.findIndex(item => item.id === payload.id);
      if (payload.action !== "create" && index < 0) throw Object.assign(new Error("这条记忆不存在或不属于当前范围。"), { statusCode: 404 });
      if (payload.action === "create") current.items.push({
        id: "Note_A1", title: payload.title, text: payload.text,
        kind: "user_statement", source: { kind: "user_command" },
        expiresAt: now + 30 * 86400000, state: "active",
      });
      if (payload.action === "update") current.items[index].text = payload.text;
      if (payload.action === "remove") current.items.splice(index, 1);
      current.revision += "x";
      return JSON.parse(JSON.stringify(current));
    },
  };
}

describe("ordinary self memory commands", () => {
  it("registers all five commands as ordinary deterministic commands", () => {
    const cases = ["我的记忆", "记忆帮助", "记住 Stack = JavaScript", "纠正记忆 Note_A1 = TypeScript", "删除记忆 Note_A1"];
    for (const command of cases) {
      assert.equal(isKnownCommand(command), true);
      assert.equal(isSelfMemoryCommand(command), true);
      assert.equal(isCommandContext(groupContext(command)), true);
      assert.equal(isCommandContext(groupContext(command, { isAtMe: false })), false);
      assert.equal(isCommandContext(privateContext(command)), true);
      assert.ok(COMMAND_DEFINITIONS.some(entry => entry.permission === "user" && (entry.aliases.includes(command) || entry.pattern?.test(command))));
    }
    for (const text of ["请帮我记住 JavaScript", "记住了", "我想删除记忆", "纠正记忆力", "记住Stack=JavaScript", "我的记忆是什么"]) {
      assert.equal(isSelfMemoryCommand(text), false);
      assert.equal(isCommandContext(privateContext(text)), false);
    }
  });

  it("keeps every capability example in the actual registry and documents private opt-in", async () => {
    const definition = CAPABILITY_DEFINITIONS.find(item => item.id === "personal.memory");
    assert.equal(definition.permission, "user");
    assert.equal(definition.examples.length, 5);
    for (const example of definition.examples) assert.equal(isKnownCommand(example.replace(/^@夜星\s*/, "")), true);
    assert.match(helpLinesForPage(4).join("\n"), /我的记忆[\s\S]*记忆帮助[\s\S]*记住[\s\S]*纠正记忆[\s\S]*删除记忆/);
    assert.match(memoryCommandHelp(), /只授权保存这一条/);
    assert.match(memoryCommandHelp(), /不会开启自动保存私聊历史/);
    const service = fakeService();
    assert.match(await buildCommandReplyAsync("记忆帮助", optionsFor(service)), /记住 <标题> = <内容>/);
    assert.match(buildCommandReply("记忆帮助", optionsFor(service)), /纠正记忆 <id>/);
    assert.deepEqual(service.calls, []);
    assert.match(buildCapabilityHelpText("我的记忆", { cfg, surface: "group", groupId: 100, userId: 42, modelHealth: {} }), /删除记忆 <id>/);
  });

  it("preserves raw title, id, case, whitespace, equals and final punctuation", async () => {
    const service = fakeService();
    const options = optionsFor(service, { botNames: ["QQFriend"] });
    const created = await buildGroupCommandReplyAsync(groupContext("@QQFriend /记住 MyAPI = I use JavaScript  and MiMo.\nURL=https://Example.com/CasePath?"), options);
    const create = service.calls.find(call => call.method === "act");
    assert.deepEqual(create.payload, {
      action: "create", userId: 42, groupId: 100, revision: "Rev_A0", title: "MyAPI",
      text: "I use JavaScript  and MiMo.\nURL=https://Example.com/CasePath?",
    });
    assert.deepEqual(create.context, { origin: "user_command", messageId: 71, now });
    assert.match(created, /Note_A1 \| MyAPI/);
    assert.match(created, /JavaScript {2}and MiMo/);
    assert.match(created, /2026-10-23/);
    const updated = await buildCommandReplyAsync("纠正记忆 Note_A1 = Prefer TypeScript!", options);
    assert.match(updated, /记忆已纠正/);
    assert.match(updated, /Prefer TypeScript!/);
    assert.equal(service.calls.at(-1).payload.id, "Note_A1");
    assert.equal(service.calls.at(-1).payload.revision, "Rev_A0x");
    assert.deepEqual(service.calls.at(-1).payload, { action: "update", userId: 42, groupId: 100, revision: "Rev_A0x", id: "Note_A1", text: "Prefer TypeScript!" });
    const removed = await buildCommandReplyAsync("删除记忆 Note_A1", options);
    assert.match(removed, /记忆已删除/);
    assert.match(removed, /当前没有记忆/);
    assert.deepEqual(service.calls.at(-1).payload, { action: "remove", userId: 42, groupId: 100, revision: "Rev_A0xx", id: "Note_A1" });
  });

  it("uses fresh snapshots for listing and never creates a note from free text", async () => {
    const service = fakeService();
    const options = optionsFor(service);
    assert.match(await buildCommandReplyAsync("我的记忆", options), /当前没有记忆/);
    assert.deepEqual(service.calls, [{ method: "snapshot", scope: { userId: 42, groupId: 100 } }]);
    for (const text of ["请记住我喜欢 JavaScript", "记住了", "我的记忆是什么"]) {
      assert.equal(await buildMemoryCommandReplyAsync(text, { ...options, rawCommandText: text }), null);
    }
    assert.equal(service.calls.length, 1);
  });

  it("rejects malformed syntax without reading or changing stored notes", async () => {
    const service = fakeService();
    for (const command of ["记住", "记住 MissingDelimiter", "记住 = Data", "记住 Title =", "记住 Title ＝ Data", "纠正记忆", "纠正记忆 Note_A1", "纠正记忆 Note_A1 =", "纠正记忆 Note_A1 other = data", "删除记忆", "删除记忆 Note_A1 extra", "我的记忆 84", "记忆帮助 @Other"]) {
      assert.ok(await buildCommandReplyAsync(command, optionsFor(service)), command);
    }
    assert.deepEqual(service.calls, []);
  });

  it("never uses mentioned people or target options as the note owner", async () => {
    const service = fakeService();
    const options = optionsFor(service, { userId: 84, groupId: 200, messageId: 900, targetUserId: 84 });
    const denied = await buildGroupCommandReplyAsync(groupContext("我的记忆", { mentionedUsers: [{ qq: "84", isBot: false }] }), options);
    assert.match(denied, /不能指定其他用户或群/);
    assert.deepEqual(service.calls, []);
    await buildGroupCommandReplyAsync(groupContext("记住 Owner = My Own Note"), options);
    assert.equal(service.calls.at(-1).payload.userId, 42);
    assert.equal(service.calls.at(-1).payload.groupId, 100);
    assert.equal(service.calls.at(-1).context.messageId, 71);
    const rejected = await buildCommandReplyAsync("我的记忆 @84", optionsFor(service));
    assert.match(rejected, /只能管理你自己/);
    assert.equal(service.calls.length, 2);
  });

  it("requires group mention in every wrapper and binds event ids in catalog dispatch", async () => {
    const service = fakeService();
    const calls = [];
    const options = optionsFor(service, {
      userId: 84, groupId: 200, messageId: 9999, replyToId: 1234, botNames: ["QQFriend"],
      sender: async (...args) => { calls.push(args); return { status: "ok", retcode: 0 }; },
      recordCommand: () => {},
    });
    const silent = groupContext("记住 Tool = MiMo", { isAtMe: false });
    assert.equal(buildGroupCommandReply(silent, options), null);
    assert.equal(await buildGroupCommandReplyAsync(silent, options), null);
    assert.equal(await dispatchGroupCommand(silent, options), false);
    assert.deepEqual(service.calls, []);
    assert.equal(await dispatchGroupCommand(groupContext("@QQFriend 记住 Tool = MiMo!"), options), true);
    assert.deepEqual(service.calls[0].scope, { userId: 42, groupId: 100 });
    assert.equal(service.calls[1].context.messageId, 71);
    assert.equal(service.calls[1].payload.text, "MiMo!");
    assert.equal(calls[0][0], 100);
    assert.equal(calls[0][2], 1234);
    assert.match(calls[0][1], /记忆已保存/);
  });

  it("binds private scope and message id to the caller, not options or ctx.group_id", async () => {
    const service = fakeService();
    const options = optionsFor(service, { userId: 84, groupId: 200, messageId: 9999, requireMention: true });
    const reply = await buildPrivateCommandReplyAsync(privateContext("记住 Stack = JavaScript", { group_id: 200 }), options);
    assert.match(reply, /我的记忆（私聊）/);
    assert.deepEqual(service.calls[0].scope, { userId: 42, groupId: "private" });
    assert.deepEqual(service.calls[1].context, { origin: "user_command", messageId: -72, now });
    assert.equal(service.calls[1].payload.userId, 42);
    assert.equal(service.calls[1].payload.groupId, "private");
    assert.match(buildPrivateCommandReply(privateContext("记忆帮助"), options), /私聊.*白名单/);
  });

  it("requires the ordinary private whitelist, with only the existing admin command exception", async () => {
    const service = fakeService();
    for (const userId of [66, 77]) {
      for (const text of ["我的记忆", "记忆帮助", "记住 Tool = MiMo", "纠正记忆 Note_A1 = MiMo", "删除记忆 Note_A1"]) {
        assert.match(await buildPrivateCommandReplyAsync(privateContext(text, { user_id: userId }), optionsFor(service)), /普通私聊白名单/);
      }
    }
    assert.deepEqual(service.calls, []);
    const reply = await buildPrivateCommandReplyAsync(privateContext("记住 Tool = MiMo", { user_id: 84 }), optionsFor(service));
    assert.match(reply, /记忆已保存/);
    assert.equal(service.calls[1].payload.userId, 84);
    assert.equal(service.calls[1].payload.groupId, "private");
    for (const userId of [42, 66, 77, 84]) {
      const catalog = buildCapabilityCatalog({ cfg, surface: "private", userId, modelHealth: {}, jmHealth: {} });
      const memory = catalog.capabilities.find(item => item.id === "personal.memory");
      assert.equal(memory.state.permitted, userId === 42 || userId === 84);
      if (userId === 84) assert.equal(catalog.capabilities.find(item => item.id === "chat.reply").state.permitted, false);
    }
  });

  it("leaves the runtime private AI gate closed for admins and JM-only users", async context => {
    const previous = { friends: CFG.friendWhitelist, admins: CFG.adminUins, jm: CFG.jmUserWhitelist };
    const sent = [];
    context.mock.method(globalThis, "fetch", async (url, request) => {
      assert.match(String(url), /send_private_msg$/);
      sent.push(JSON.parse(request.body));
      return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
    });
    CFG.friendWhitelist = [];
    CFG.adminUins = [84];
    CFG.jmUserWhitelist = [66];
    try {
      await handlePrivateMessage(privateContext("记忆帮助", { user_id: 84 }));
      assert.equal(sent.length, 1);
      assert.match(JSON.stringify(sent[0]), /我的记忆帮助/);
      await handlePrivateMessage(privateContext("聊聊天", { user_id: 84 }));
      await handlePrivateMessage(privateContext("记忆帮助", { user_id: 66 }));
      await handlePrivateMessage(privateContext("记住 Tool = MiMo", { user_id: 77 }));
      assert.equal(sent.length, 1);
    } finally {
      CFG.friendWhitelist = previous.friends;
      CFG.adminUins = previous.admins;
      CFG.jmUserWhitelist = previous.jm;
    }
  });

  it("fails closed for invalid caller or group context", async () => {
    const service = fakeService();
    for (const extra of [{ userId: undefined }, { userId: 0 }, { userId: "not-a-QQ" }, { groupId: 0 }, { groupId: "invalid" }, { surface: "group", groupId: undefined }]) {
      assert.match(await buildCommandReplyAsync("我的记忆", optionsFor(service, extra)), /无法确认/);
    }
    assert.deepEqual(service.calls, []);
  });

  it("never accesses the production service for skipSave or synchronous command calls", async () => {
    const options = optionsFor(undefined, { users: {}, groupChats: [] });
    assert.match(await buildCommandReplyAsync("记住 Title = Data", options), /注入 noteService/);
    const service = fakeService();
    assert.match(buildCommandReply("记住 Title = Data", optionsFor(service)), /异步处理/);
    assert.deepEqual(service.calls, []);
  });

  it("never changes notes when the event source is missing or invalid", async () => {
    const service = fakeService();
    for (const messageId of [undefined, null, "", "unknown", "1e3", NaN, true]) {
      for (const command of ["记住 Title = Data", "纠正记忆 Note_A1 = Data", "删除记忆 Note_A1"]) {
        assert.match(await buildGroupCommandReplyAsync(groupContext(command, { message_id: messageId }), optionsFor(service)), /缺少有效消息来源/);
      }
    }
    assert.deepEqual(service.calls, []);
  });

  it("stops deferred reads and edits after a concurrent forget, even with a fresh revision", async () => {
    for (const command of ["我的记忆", "记住 Title = Data", "纠正记忆 Note_A1 = Data", "删除记忆 Note_A1"]) {
      let completeSnapshot;
      let announceSnapshot;
      const ready = new Promise(resolve => { announceSnapshot = resolve; });
      const snapshot = new Promise(resolve => { completeSnapshot = resolve; });
      const service = {
        snapshot: () => { announceSnapshot(); return snapshot; },
        act: () => assert.fail("A command started before forgetting cannot apply a late edit"),
      };
      const pending = buildCommandReplyAsync(command, optionsFor(service));
      await ready;
      invalidateMemoryPrivacyGeneration();
      completeSnapshot({ revision: "Fresh_After_Forget", items: [{ id: "Note_A1", text: "ForgottenSecret" }] });
      const reply = await pending;
      assert.match(reply, /隐私状态已更新/);
      assert.doesNotMatch(reply, /ForgottenSecret|已保存|已纠正|已删除/);
    }
  });

  it("accepts its own commit invalidation but hides a reply invalidated after commit", async () => {
    const service = fakeService();
    const act = service.act;
    service.act = (payload, context) => {
      const result = act(payload, context);
      invalidateMemoryPrivacyGeneration();
      return result;
    };
    assert.match(await buildCommandReplyAsync("记住 Title = Data", optionsFor(service)), /记忆已保存/);
    service.act = (payload, context) => {
      const result = act(payload, context);
      invalidateMemoryPrivacyGeneration();
      return Promise.resolve().then(() => {
        invalidateMemoryPrivacyGeneration();
        return result;
      });
    };
    const reply = await buildCommandReplyAsync("纠正记忆 Note_A1 = ForgottenSecret", optionsFor(service));
    assert.match(reply, /隐私状态已更新/);
    assert.doesNotMatch(reply, /ForgottenSecret|已纠正/);
  });

  it("surfaces safe backend errors and never retries a stale revision", async () => {
    for (const [statusCode, message] of [[400, "内容含敏感信息，未保存。"], [403, "来源校验失败。"], [404, "这条记忆不存在或不属于当前范围。"], [409, "记忆已变化。"], [503, "记忆未保存，请检查存储后重试。"]]) {
      const service = fakeService();
      let attempts = 0;
      service.act = () => { attempts++; throw Object.assign(new Error(message), { statusCode }); };
      const reply = await buildCommandReplyAsync("记住 Tool = MiMo", optionsFor(service));
      assert.ok(reply.includes(message));
      assert.doesNotMatch(reply, /记忆已保存/);
      assert.equal(attempts, 1);
      if (statusCode === 409) assert.match(reply, /我的记忆.*刷新/);
    }
    const service = { snapshot: () => { throw new Error("secret stack at C:/operator/config"); } };
    const reply = await buildCommandReplyAsync("我的记忆", optionsFor(service));
    assert.match(reply, /记忆服务暂时不可用/);
    assert.doesNotMatch(reply, /secret|operator|stack/);
  });

  it("integrates with an isolated backend for self scope, source attribution and validation", async () => {
    const profiles = {};
    let saves = 0;
    const service = createMemoryNoteService({
      profiles, now: () => now, available: () => true,
      persist: () => { saves++; return true; }, invalidate: () => {}, readPrivacy: () => ({ users: {} }),
    });
    const options = optionsFor(service);
    assert.match(await buildGroupCommandReplyAsync(groupContext("记住 Stack = JavaScript!"), options), /记忆已保存/);
    const item = service.snapshot({ userId: 42, groupId: 100 }).items[0];
    assert.equal(item.title, "Stack");
    assert.equal(item.text, "JavaScript!");
    assert.equal(item.source.kind, "user_command");
    assert.equal(item.source.messageId, "71");
    for (const scope of [{ userId: 84, groupId: 100 }, { userId: 42, groupId: 200 }, { userId: 42, groupId: undefined }]) {
      assert.match(await buildCommandReplyAsync("我的记忆", optionsFor(service, scope)), /当前没有记忆/);
      assert.match(await buildCommandReplyAsync("删除记忆 " + item.id, optionsFor(service, scope)), /不存在或不属于当前范围/);
    }
    assert.match(await buildPrivateCommandReplyAsync(privateContext("记住 Stack = TypeScript"), options), /记忆已保存/);
    assert.equal(service.snapshot({ userId: 42, groupId: "private" }).items[0].source.messageId, "-72");
    assert.equal(service.snapshot({ userId: 42, groupId: 100 }).items[0].text, "JavaScript!");
    assert.equal(saves, 2);
    for (const command of ["记住 " + "T".repeat(33) + " = Data", "记住 Long = " + "X".repeat(301)]) {
      assert.match(await buildCommandReplyAsync(command, options), /标题最多 32 字，内容最多 300 字/);
    }
    assert.match(await buildGroupCommandReplyAsync(groupContext("记住 Missing = Source", { message_id: undefined }), options), /缺少有效消息来源/);
    assert.equal(saves, 2);
    assert.match(await buildCommandReplyAsync("纠正记忆 " + item.id + " = Prefer MiMo", options), /记忆已纠正/);
    assert.match(await buildCommandReplyAsync("删除记忆 " + item.id, options), /记忆已删除/);
    assert.equal(service.snapshot({ userId: 42, groupId: 100 }).items.length, 0);
    assert.equal(service.snapshot({ userId: 42, groupId: "private" }).items.length, 1);
    assert.equal(saves, 4);
  });
});
