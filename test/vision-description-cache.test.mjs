import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVisionDescriptionCache,
  visionDescriptionCache,
  clearVisionDescriptionCache,
  getVisionDescriptionCacheStatus,
} from "../bridge/vision/description-cache.mjs";

const TTL_MS = 600_000;
const DESCRIPTION = "A red square is centered on a white background.";
const EMPTY_STATUS = { enabled: true, entries: 0, hits: 0, misses: 0,
  storesImages: false, storesChatText: false, persistent: false };
const digest = number => number.toString(16).padStart(64, "0");

function identity(overrides = {}) {
  return {
    scope: { surface: "private", userId: 601 },
    digests: digest(1),
    provider: { id: "synthetic-provider", model: "vision-test", protocol: "openai-chat",
      endpoint: "https://vision.invalid/v1", auth: "none",
      task: "vision", route: { primary: "synthetic-provider", fallback: null, reasoning: "economy" } },
    promptVersion: "objective-vision-v1",
    ...overrides,
  };
}

function fixture() {
  let time = 1_000_000;
  return { cache: createVisionDescriptionCache({ now: () => time }),
    advance: amount => { time += amount; }, clock: value => { time = value; } };
}

function freezeTree(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

describe("objective vision description cache", () => {
  it("counts only successful reads as hits and valid lookups as misses", () => {
    const { cache } = fixture();
    assert.deepEqual(cache.status(), EMPTY_STATUS);
    assert.equal(cache.get(identity()), "");
    assert.equal(cache.set(identity(), DESCRIPTION), true);
    assert.equal(cache.get(identity()), DESCRIPTION);
    assert.equal(cache.get(null), "");
    assert.equal(cache.set(null, DESCRIPTION), false);
    assert.deepEqual(cache.status(), { ...EMPTY_STATUS, entries: 1, hits: 1, misses: 1 });
  });

  it("expires at ten minutes without extending TTL on a hit", () => {
    const { cache, advance } = fixture();
    cache.set(identity(), DESCRIPTION);
    advance(TTL_MS - 1);
    assert.equal(cache.get(identity()), DESCRIPTION);
    advance(1);
    assert.equal(cache.get(identity()), "");
    assert.deepEqual(cache.status(), { ...EMPTY_STATUS, hits: 1, misses: 1 });
    advance(-1);
    assert.equal(cache.get(identity()), "");
  });

  it("prunes expired entries on status and writes without recording misses", () => {
    const { cache, advance } = fixture();
    cache.set(identity(), DESCRIPTION);
    advance(TTL_MS);
    assert.deepEqual(cache.status(), EMPTY_STATUS);
    cache.set(identity(), DESCRIPTION);
    advance(TTL_MS);
    cache.set(identity({ digests: digest(2) }), DESCRIPTION);
    assert.deepEqual(cache.status(), { ...EMPTY_STATUS, entries: 1 });
  });

  it("fails closed on future ages and backward clock changes", () => {
    const { cache, advance } = fixture();
    cache.set(identity(), DESCRIPTION);
    advance(-1);
    assert.equal(cache.get(identity()), "");
    advance(1);
    assert.equal(cache.get(identity()), "");
    cache.set(identity(), DESCRIPTION);
    advance(100);
    assert.equal(cache.get(identity()), DESCRIPTION);
    advance(-1);
    assert.equal(cache.get(identity()), "");
  });

  it("accepts a zero-based monotonic clock and rejects invalid clock values", () => {
    const { cache, clock } = fixture();
    clock(0);
    assert.equal(cache.set(identity(), DESCRIPTION), true);
    clock(TTL_MS - 0.5);
    assert.equal(cache.get(identity()), DESCRIPTION);
    for (const invalid of [NaN, Infinity, -Infinity, -1, "1000000", null, undefined, Number.MAX_VALUE]) {
      clock(1_000_000);
      cache.set(identity(), DESCRIPTION);
      clock(invalid);
      assert.equal(cache.get(identity()), "");
      assert.equal(cache.set(identity(), DESCRIPTION), false);
      assert.equal(cache.status().entries, 0);
      clock(1_000_000);
      assert.equal(cache.get(identity()), "");
    }
    const broken = createVisionDescriptionCache({ now: () => { throw new Error("clock unavailable"); } });
    assert.equal(broken.set(identity(), DESCRIPTION), false);
    assert.equal(broken.get(identity()), "");
    assert.deepEqual(broken.status(), { ...EMPTY_STATUS, misses: 1 });
    assert.throws(() => createVisionDescriptionCache({ now: 1 }), TypeError);
  });

  it("caps capacity at 128 using LRU eviction", () => {
    const { cache } = fixture();
    for (let index = 1; index <= 128; index++) cache.set(identity({ digests: digest(index) }), DESCRIPTION);
    assert.equal(cache.get(identity()), DESCRIPTION);
    cache.set(identity({ digests: digest(129) }), DESCRIPTION);
    assert.equal(cache.status().entries, 128);
    assert.equal(cache.get(identity({ digests: digest(2) })), "");
    assert.equal(cache.get(identity()), DESCRIPTION);
    assert.equal(cache.get(identity({ digests: digest(129) })), DESCRIPTION);
  });

  it("caps UTF-8 text at 128 KiB even when fewer than 128 entries fit", () => {
    const { cache } = fixture();
    const text = "\u753b".repeat(800);
    const capacity = Math.floor(128 * 1024 / 2400);
    for (let index = 1; index <= 128; index++) cache.set(identity({ digests: digest(index) }), text);
    assert.equal(cache.status().entries, capacity);
    assert.equal(cache.get(identity({ digests: digest(128 - capacity) })), "");
    assert.equal(cache.get(identity({ digests: digest(129 - capacity) })), text);
    assert.equal(cache.get(identity({ digests: digest(128) })), text);
  });

  it("accounts for replacements, expiration and clear in the byte budget", () => {
    const { cache, advance } = fixture();
    for (let index = 1; index <= 54; index++) cache.set(identity({ digests: digest(index) }), "\u753b".repeat(800));
    for (let index = 1; index <= 54; index++) cache.set(identity({ digests: digest(index) }), DESCRIPTION);
    for (let index = 55; index <= 128; index++) cache.set(identity({ digests: digest(index) }), DESCRIPTION);
    assert.equal(cache.status().entries, 128);
    advance(TTL_MS);
    cache.set(identity(), DESCRIPTION);
    assert.equal(cache.status().entries, 1);
    cache.clear();
    for (let index = 1; index <= 54; index++) cache.set(identity({ digests: digest(index) }), "\u753b".repeat(800));
    assert.equal(cache.status().entries, 54);
  });

  it("trims and caps each description at 800 UTF-16 units without splitting a surrogate pair", () => {
    const { cache } = fixture();
    assert.equal(cache.set(identity(), "  " + "x".repeat(801) + "  "), true);
    assert.equal(cache.get(identity()), "x".repeat(800));
    cache.set(identity(), "x".repeat(799) + "\u{1F7E5}");
    assert.equal(cache.get(identity()), "x".repeat(799));
  });

  it("matches exact digests only, preserving array order, count and duplicates", () => {
    const { cache } = fixture();
    const hash = "ab".repeat(32);
    cache.set(identity({ digests: hash }), DESCRIPTION);
    assert.equal(cache.get(identity({ digests: [hash.toUpperCase()] })), DESCRIPTION);
    assert.equal(cache.get(identity({ digests: hash.slice(0, -1) + "c" })), "");
    assert.equal(cache.get(identity({ digests: [hash, hash] })), "");
    cache.set(identity({ digests: [hash, digest(2), digest(3)] }), "Three colored squares.");
    assert.equal(cache.get(identity({ digests: [hash, digest(2), digest(3)] })), "Three colored squares.");
    assert.equal(cache.get(identity({ digests: [digest(3), digest(2), hash] })), "");
    assert.equal(cache.get(identity({ digests: [hash, digest(2)] })), "");
  });

  it("normalizes numeric scope IDs and private group markers without crossing scopes", () => {
    const { cache } = fixture();
    cache.set(identity(), DESCRIPTION);
    for (const groupId of [undefined, null, "private"]) {
      assert.equal(cache.get(identity({ scope: { surface: "private", userId: "601", groupId } })), DESCRIPTION);
    }
    assert.equal(cache.get(identity({ scope: { surface: "private", userId: 602 } })), "");
    const grouped = identity({ scope: { surface: "group", userId: 601, groupId: 701 } });
    assert.equal(cache.get(grouped), "");
    cache.set(grouped, "A blue circle.");
    assert.equal(cache.get(identity({ scope: { surface: "group", userId: "601", groupId: "701" } })), "A blue circle.");
    assert.equal(cache.get(identity({ scope: { surface: "group", userId: 602, groupId: 701 } })), "");
    assert.equal(cache.get(identity({ scope: { surface: "group", userId: 601, groupId: 702 } })), "");
    assert.equal(cache.get(identity()), DESCRIPTION);
  });

  it("projects chat-run scope metadata out of the cache identity", () => {
    const { cache } = fixture();
    cache.set(identity({ scope: { surface: "private", userId: 601, currentMessageId: "-10" } }), DESCRIPTION);
    for (const currentMessageId of [undefined, "11", 12, "12345678901234567890"]) {
      assert.equal(cache.get(identity({ scope: { surface: "private", userId: 601, currentMessageId } })), DESCRIPTION);
    }
    for (const currentMessageId of [null, false, {}, "chat text", "", NaN, 1.5]) {
      const input = identity({ scope: { surface: "private", userId: 601, currentMessageId } });
      assert.equal(cache.set(input, DESCRIPTION), false);
      assert.equal(cache.get(input), "");
    }
    assert.equal(cache.status().misses, 0);
  });

  for (const [field, value] of Object.entries({ id: "another-provider", model: "vision-next",
    protocol: "openai-responses", endpoint: "https://other.invalid/v1", auth: "bearer",
    task: "chat", route: { primary: "synthetic-provider", fallback: null, reasoning: "deep" } })) {
    it(`separates provider ${field}`, () => {
      const { cache } = fixture();
      const original = identity();
      const changed = identity({ provider: { ...original.provider, [field]: value } });
      cache.set(original, DESCRIPTION);
      assert.equal(cache.get(changed), "");
      cache.set(changed, "A blue circle.");
      assert.equal(cache.get(original), DESCRIPTION);
      assert.equal(cache.get(changed), "A blue circle.");
    });
  }

  it("separates nested routing, auth material, reasoning settings and prompt versions", () => {
    const { cache } = fixture();
    const original = identity();
    cache.set(original, DESCRIPTION);
    for (const provider of [
      { ...original.provider, route: { ...original.provider.route, primary: "other" } },
      { ...original.provider, route: { ...original.provider.route, fallback: "other" } },
      { ...original.provider, reasoning: { effort: "high", enabled: true } },
      { ...original.provider, apiKey: "synthetic-credential" },
    ]) assert.equal(cache.get(identity({ provider })), "");
    assert.equal(cache.get(identity({ promptVersion: "objective-vision-v2" })), "");
  });

  it("canonically serializes frozen providers independent of property order", () => {
    const { cache } = fixture();
    const original = freezeTree(identity());
    assert.equal(cache.set(original, DESCRIPTION), true);
    const provider = Object.fromEntries(Object.entries(original.provider).reverse());
    provider.route = Object.fromEntries(Object.entries(provider.route).reverse());
    assert.equal(cache.get(identity({ provider: freezeTree(provider) })), DESCRIPTION);
    assert.equal(cache.get(original), DESCRIPTION);
  });

  it("does not retain or mutate caller identity objects", () => {
    const { cache } = fixture();
    const input = identity({ digests: [digest(1)] });
    cache.set(input, DESCRIPTION);
    input.scope.userId = 999;
    input.digests[0] = digest(2);
    input.provider.route.reasoning = "deep";
    assert.equal(cache.get(input), "");
    assert.equal(cache.get(identity()), DESCRIPTION);
  });

  it("uses structured fields so delimiter-like values cannot collide", () => {
    const { cache } = fixture();
    const provider = identity().provider;
    cache.set(identity({ provider: { ...provider, id: "a:b", model: "c" } }), DESCRIPTION);
    assert.equal(cache.get(identity({ provider: { ...provider, id: "a", model: "b:c" } })), "");
  });

  it("rejects invalid identities without caching or counting misses", () => {
    const { cache } = fixture();
    const invalid = [undefined, null, false, 1, "key", [], {},
      ...["scope", "digests", "provider", "promptVersion"].map(field => {
        const input = identity();
        delete input[field];
        return input;
      }),
      ...[null, {}, [], { surface: "unknown", userId: 601 }, { surface: "group", userId: 601 },
        { surface: "private", userId: 601, groupId: 701 }, { surface: "group", userId: 601, groupId: "private" },
        { surface: "private", userId: 601, chat: "context" }].map(scope => identity({ scope })),
      ...[0, -1, true, {}, "", " 601 ", "0601", "6e2", "1.5", 1.5, NaN, Infinity,
        Number.MAX_SAFE_INTEGER + 1, "9007199254740993"].flatMap(id => [
        identity({ scope: { surface: "private", userId: id } }),
        identity({ scope: { surface: "group", userId: 601, groupId: id } }),
      ]),
      ...[null, [], [digest(1), digest(2), digest(3), digest(4)], new Array(1), [undefined],
        "a".repeat(16), "a".repeat(63), "a".repeat(65), "g".repeat(64), " " + digest(1),
        "https://image.invalid/a.png", { hash: digest(1) }, [digest(1), 2]].map(digests => identity({ digests })),
      ...[null, [], {}, "provider", { ...identity().provider, model: " " }].map(provider => identity({ provider })),
      ...["id", "model", "protocol", "endpoint", "auth"].flatMap(field => {
        const provider = identity().provider;
        delete provider[field];
        return [identity({ provider }), identity({ provider: { ...provider, [field]: 1 } })];
      }),
      ...[null, "", 1, {}, "actual prompt\ntext", "a".repeat(129)].map(promptVersion => identity({ promptVersion })),
      identity({ url: "https://image.invalid/a.png" }), identity({ context: "chat text" }),
    ];
    for (const input of invalid) {
      assert.equal(cache.set(input, DESCRIPTION), false);
      assert.equal(cache.get(input), "");
    }
    assert.deepEqual(cache.status(), EMPTY_STATUS);
  });

  it("rejects lossy or executable provider data instead of colliding with valid keys", () => {
    const { cache } = fixture();
    const cycle = {};
    cycle.self = cycle;
    let getterCalls = 0;
    const accessor = { get value() { getterCalls++; return "hidden"; } };
    const decoratedArray = [1];
    decoratedArray.extra = "hidden";
    for (const extra of [undefined, NaN, Infinity, 1n, () => {}, Symbol("field"), new Date(0),
      new Map(), cycle, accessor, decoratedArray, new Array(2), "x".repeat(17 * 1024),
      Array.from({ length: 513 }, () => 1)]) {
      const input = identity({ provider: { ...identity().provider, extra } });
      assert.equal(cache.set(input, DESCRIPTION), false);
      assert.equal(cache.get(input), "");
    }
    const hidden = identity();
    Object.defineProperty(hidden.provider, "secret", { value: "hidden", enumerable: false });
    const symbolic = identity();
    symbolic.provider[Symbol("hidden")] = "hidden";
    const getterIdentity = { get scope() { getterCalls++; return identity().scope; } };
    for (const input of [hidden, symbolic, getterIdentity]) {
      assert.equal(cache.set(input, DESCRIPTION), false);
      assert.equal(cache.get(input), "");
    }
    assert.equal(getterCalls, 0);
    assert.deepEqual(cache.status(), EMPTY_STATUS);
  });

  it("never caches failures, empty values, raw image payloads or URLs", () => {
    const { cache } = fixture();
    for (const text of [null, undefined, false, 0, "", " \n\t ", new Error("offline"),
      { ok: false, text: "offline" }, { text: DESCRIPTION, context: "chat" }, [DESCRIPTION],
      "https://image.invalid/raw.png", "data:image/png;base64,AAAA", "[CQ:image,file=raw.png]"]) {
      assert.equal(cache.set(identity(), text), false);
    }
    assert.deepEqual(cache.status(), EMPTY_STATUS);
    assert.equal(cache.get(identity()), "");
    assert.equal(cache.set(identity(), DESCRIPTION), true);
    assert.equal(cache.set(identity(), null), false);
    assert.equal(cache.get(identity()), DESCRIPTION);
  });

  it("rejects sensitive descriptions before truncation instead of storing redacted text", () => {
    const { cache } = fixture();
    for (const text of ["api_key=synthetic-key", "password=synthetic-value", "Bearer synthetic-value",
      "sk-synthetic_test_key", "phone=13800138000", "identity=123456789012345678",
      "x".repeat(801) + " password=synthetic-value", "x".repeat(801) + " https://image.invalid/a.png"]) {
      assert.equal(cache.set(identity(), text), false);
      assert.equal(cache.status().entries, 0);
    }
    cache.set(identity(), DESCRIPTION);
    assert.equal(cache.set(identity(), "token=synthetic-value"), false);
    assert.equal(cache.get(identity()), DESCRIPTION);
  });

  it("returns detached metadata only and clears synchronously", () => {
    const { cache } = fixture();
    cache.set(identity(), DESCRIPTION);
    cache.get(identity());
    const status = cache.status();
    assert.deepEqual(status, { ...EMPTY_STATUS, entries: 1, hits: 1 });
    assert.doesNotMatch(JSON.stringify(status), /synthetic-provider|vision-test|601|description|vision\.invalid/);
    status.entries = 900;
    assert.equal(cache.status().entries, 1);
    assert.deepEqual(Object.keys(cache).sort(), ["clear", "get", "set", "status"]);
    cache.clear();
    assert.deepEqual(cache.status(), EMPTY_STATUS);
    assert.equal(cache.get(identity()), "");
  });

  it("exposes singleton clear/status wrappers without clearing other instances", () => {
    const { cache } = fixture();
    clearVisionDescriptionCache();
    try {
      assert.deepEqual(getVisionDescriptionCacheStatus(), EMPTY_STATUS);
      visionDescriptionCache.set(identity(), DESCRIPTION);
      cache.set(identity(), DESCRIPTION);
      assert.equal(visionDescriptionCache.get(identity()), DESCRIPTION);
      assert.deepEqual(getVisionDescriptionCacheStatus(), { ...EMPTY_STATUS, entries: 1, hits: 1 });
      clearVisionDescriptionCache();
      assert.deepEqual(getVisionDescriptionCacheStatus(), EMPTY_STATUS);
      assert.equal(visionDescriptionCache.get(identity()), "");
      assert.equal(cache.get(identity()), DESCRIPTION);
    } finally {
      clearVisionDescriptionCache();
    }
  });
});
