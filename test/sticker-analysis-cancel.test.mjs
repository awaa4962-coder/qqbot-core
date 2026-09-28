import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { after, beforeEach, test } from "node:test";
import sharp from "sharp";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-analysis-cancel-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_TEMP_DIR: path.join(root, "temp") });
const { applyStickerManagerAction } = await import("../bridge/admin-api/sticker-manager.mjs");
const { analyzePendingStickers, analyzeStickerEntry } = await import("../bridge/features/stickers/analyzer.mjs");
const { classifyStickerCandidate } = await import("../bridge/features/stickers/image-classifier.mjs");
const { syncStickerFavorites, getStickerSyncStatus, resetStickerSyncForTest } =
  await import("../bridge/features/stickers/sync-service.mjs");
const catalog = await import("../bridge/features/stickers/catalog-store.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");

const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).png().toBuffer();
const image = { buffer: png, mimeType: "image/png" };
const description = { description: "SYNTHETIC_STICKER", tags: [] };
const classification = { kind: "sticker", confidence: 0.95, ...description };
const modelResult = value => ({ ok: true, provider: "synthetic", raw: {
  choices: [{ message: { content: JSON.stringify(value), reasoning_content: "PRIVATE_REASONING" } }],
} });
let number = 0;
let filename;

beforeEach(t => {
  resetStickerSyncForTest();
  filename = path.join(root, "catalog-" + (++number) + ".json");
  catalog.setStickerCatalogPath(filename);
  const denied = t.mock.method(globalThis, "fetch", () => assert.fail("no real network is allowed"));
  t.after(() => assert.equal(denied.mock.callCount(), 0, "no model, image or QQ network requests"));
});

after(() => {
  resetStickerSyncForTest();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

function addEntries(count = 2) {
  catalog.upsertFavoriteStickers(Array.from({ length: count }, (_, index) => "https://example.com/synthetic-" + index + ".png"));
  return catalog.getStickerCatalog().entries;
}

function assertCancelled(result, requested = 2, reason = "task_cancelled") {
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, reason);
  assert.equal(result.requested, requested);
  assert.equal(result.analyzed, 0);
  assert.equal(result.reused, 0);
  assert.equal(result.failed, 0);
}

function assertUntouched(before) {
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  assert.ok(catalog.getStickerCatalog().entries.every(entry => !entry.indexed && !entry.analysisAttempts && !entry.lastError));
}

for (const action of ["analyze", "sync"]) {
  test("admin " + action + " forwards the runner signal without changing batch bounds", async () => {
    const controller = new globalThis.AbortController();
    let calls = 0;
    const response = await applyStickerManagerAction({ action, limit: 50, analysisLimit: 50, analyze: false }, {
      signal: controller.signal,
      [action]: async options => {
        calls++;
        assert.equal(options.signal, controller.signal);
        assert.equal(action === "sync" ? options.analysisLimit : options.limit, 4);
        if (action === "sync") assert.equal(options.analyze, false);
        return { requested: 0 };
      },
    });
    assert.equal(calls, 1);
    assert.equal(response.result.requested, 0);
  });
}

test("entry analysis forwards signal and a live guard to injected download and description", async () => {
  const [entry] = addEntries(1);
  const controller = new globalThis.AbortController();
  let downloads = 0;
  let descriptions = 0;
  const output = await analyzeStickerEntry(entry, { signal: controller.signal,
    download: async (url, runtime) => {
      downloads++;
      assert.equal(url, entry.url);
      assert.equal(runtime.signal, controller.signal);
      runtime.assertCurrent();
      return image;
    },
    describe: async (input, runtime) => {
      descriptions++;
      assert.equal(input.buffer, png);
      assert.equal(runtime.signal, controller.signal);
      runtime.assertCurrent();
      return description;
    },
  });
  assert.equal(downloads, 1);
  assert.equal(descriptions, 1);
  assert.equal(output.description, description.description);
  assert.equal(catalog.getStickerEntry(entry.id).indexed, false, "direct analysis remains read-only");
});

test("pre-cancelled batches and direct entries never download, describe or write failures", async () => {
  const entries = addEntries();
  const before = fs.readFileSync(filename, "utf8");
  const controller = new globalThis.AbortController();
  controller.abort();
  let downloads = 0;
  const options = { signal: controller.signal, download: async () => { downloads++; return image; } };
  assertCancelled(await analyzePendingStickers(options));
  await assert.rejects(analyzeStickerEntry(entries[0], options), { name: "AbortError" });
  assert.equal(downloads, 0);
  assertUntouched(before);
});

test("empty analysis still reports cancellation rather than successful work", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  assertCancelled(await analyzePendingStickers({ signal: controller.signal }), 0);
});

for (const stage of ["download", "describe"]) {
  for (const reject of [false, true]) {
    test("batch cancellation during " + stage + " " + (reject ? "rejection" : "late output") + " stops subsequent entries", async () => {
      addEntries();
      const before = fs.readFileSync(filename, "utf8");
      const controller = new globalThis.AbortController();
      let downloads = 0;
      let descriptions = 0;
      const stop = runtime => {
        assert.equal(runtime.signal, controller.signal);
        controller.abort(new Error("synthetic cancellation"));
        assert.throws(runtime.assertCurrent, /synthetic cancellation/);
        if (reject) throw new Error("synthetic operation failure");
      };
      const output = await analyzePendingStickers({ signal: controller.signal,
        download: async (_url, runtime) => {
          downloads++;
          if (stage === "download") stop(runtime);
          return image;
        },
        describe: async (_image, runtime) => {
          descriptions++;
          stop(runtime);
          return description;
        },
      });
      assertCancelled(output);
      assert.equal(downloads, 1);
      assert.equal(descriptions, stage === "download" ? 0 : 1);
      assertUntouched(before);
    });
  }
}

test("default preview download forwards the signal and rejects swallowed late cancellation", async () => {
  const [entry] = addEntries(1);
  const controller = new globalThis.AbortController();
  let downloads = 0;
  let descriptions = 0;
  await assert.rejects(analyzeStickerEntry(entry, { signal: controller.signal,
    fetchImage: async (url, options) => {
      downloads++;
      assert.equal(url, entry.url);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.timeoutMs, 12000);
      assert.equal(options.maxBytes, 10 * 1024 * 1024);
      controller.abort();
      return image;
    },
    describe: async () => { descriptions++; return description; },
  }), { name: "AbortError" });
  assert.equal(downloads, 1);
  assert.equal(descriptions, 0);
});

for (const stage of ["download", "describe"]) {
  test("privacy change during " + stage + " remains cancellation without a model failure or later entry", async () => {
    addEntries();
    const before = fs.readFileSync(filename, "utf8");
    let downloads = 0;
    let descriptions = 0;
    const output = await analyzePendingStickers({
      download: async () => {
        downloads++;
        if (stage === "download") invalidateMemoryPrivacyGeneration();
        return image;
      },
      describe: async () => { descriptions++; invalidateMemoryPrivacyGeneration(); return description; },
    });
    assertCancelled(output, 2, "privacy_changed");
    assert.equal(downloads, 1);
    assert.equal(descriptions, stage === "download" ? 0 : 1);
    assertUntouched(before);
  });
}

test("ordinary model failures still schedule retries and continue other entries", async () => {
  addEntries();
  let calls = 0;
  const output = await analyzePendingStickers({ download: async () => image,
    describe: async () => { calls++; throw new Error("synthetic model unavailable"); },
  });
  assert.equal(calls, 2);
  assert.equal(output.failed, 2);
  assert.equal(output.cancelled, undefined);
  assert.ok(catalog.getStickerCatalog().entries.every(entry => entry.analysisAttempts === 1 && entry.nextAnalysisAt > 0));
});

test("default bounded vision analysis rejects late output before cache and catalog writes or fallback", async () => {
  addEntries();
  const before = fs.readFileSync(filename, "utf8");
  const controller = new globalThis.AbortController();
  let calls = 0;
  let cacheWrites = 0;
  const output = await analyzePendingStickers({ signal: controller.signal, download: async () => image,
    cache: { get: () => "", set: () => { cacheWrites++; } },
    callSlot: async (task, position, prepared) => {
      calls++;
      assert.equal(task, "vision");
      assert.equal(position, "primary");
      assert.equal(prepared.maxTokens, 220);
      assert.equal(prepared.maxAttempts, 2);
      assert.equal(prepared.maxResponseBytes, 262144);
      assert.equal(prepared.timeoutMs, 30000);
      assert.deepEqual(prepared.thinking, { type: "disabled" });
      assert.deepEqual(prepared.tools, []);
      assert.equal(prepared.beforeAttempt(), "");
      controller.abort();
      assert.equal(prepared.signal.aborted, true);
      assert.equal(prepared.beforeAttempt(), "task_cancelled");
      return modelResult(description);
    },
  });
  assertCancelled(output);
  assert.equal(calls, 1);
  assert.equal(cacheWrites, 0);
  assertUntouched(before);
});

test("cancellation while reading a vision cache rejects the cached analysis without model or catalog writes", async () => {
  addEntries();
  const before = fs.readFileSync(filename, "utf8");
  const controller = new globalThis.AbortController();
  let reads = 0;
  let calls = 0;
  let writes = 0;
  const output = await analyzePendingStickers({ signal: controller.signal, download: async () => image,
    cache: { get: () => { reads++; controller.abort(); return JSON.stringify(description); }, set: () => { writes++; } },
    callSlot: async () => { calls++; return modelResult(description); },
  });
  assertCancelled(output);
  assert.equal(reads, 1);
  assert.equal(calls, 0);
  assert.equal(writes, 0);
  assertUntouched(before);
});

test("cancellation immediately after cache storage still prevents applying the analysis", async () => {
  addEntries();
  const before = fs.readFileSync(filename, "utf8");
  const controller = new globalThis.AbortController();
  let calls = 0;
  let writes = 0;
  const output = await analyzePendingStickers({ signal: controller.signal, download: async () => image,
    cache: { get: () => "", set: () => { writes++; controller.abort(); } },
    callSlot: async () => { calls++; return modelResult(description); },
  });
  assertCancelled(output);
  assert.equal(calls, 1);
  assert.equal(writes, 1, "the completed cache write preceded cancellation");
  assertUntouched(before);
});

test("classification forwards cancellation to bounded vision and cannot return heuristic or cached late data", async () => {
  const controller = new globalThis.AbortController();
  let calls = 0;
  let cacheWrites = 0;
  await assert.rejects(classifyStickerCandidate(image, { signal: controller.signal,
    cache: { get: () => "", set: () => { cacheWrites++; } },
    callSlot: async (task, position, prepared) => {
      calls++;
      assert.equal(task, "vision");
      assert.equal(position, "primary");
      assert.equal(prepared.maxTokens, 240);
      assert.equal(prepared.maxAttempts, 2);
      assert.equal(prepared.beforeAttempt(), "");
      controller.abort();
      assert.equal(prepared.signal.aborted, true);
      assert.equal(prepared.beforeAttempt(), "task_cancelled");
      return modelResult(classification);
    },
  }), { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(cacheWrites, 0);
});

for (const reject of [false, true]) {
  test("injected classification " + (reject ? "rejection" : "output") + " cannot suppress cancellation", async () => {
    const controller = new globalThis.AbortController();
    let calls = 0;
    await assert.rejects(classifyStickerCandidate(image, { signal: controller.signal,
      classify: async (input, runtime) => {
        calls++;
        assert.equal(input.buffer, png);
        assert.equal(runtime.signal, controller.signal);
        runtime.assertCurrent();
        controller.abort();
        if (reject) throw new Error("synthetic classification failure");
        return classification;
      },
    }), { name: "AbortError" });
    assert.equal(calls, 1);
  });
}

test("pre-cancelled classification checks the signal before decoding an invalid image", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(classifyStickerCandidate({ buffer: Buffer.from("invalid") }, { signal: controller.signal }), { name: "AbortError" });
});

test("classification keeps privacy and current-capture guards instead of using heuristic fallback", async () => {
  let calls = 0;
  await assert.rejects(classifyStickerCandidate(image, { callSlot: async () => {
    calls++; invalidateMemoryPrivacyGeneration(); return { ok: false };
  } }), { code: "STICKER_PRIVACY_CHANGED" });
  assert.equal(calls, 1);
  let allowed = true;
  await assert.rejects(classifyStickerCandidate(image, {
    ensureAllowed: () => { if (!allowed) throw new Error("synthetic capture no longer allowed"); },
    classify: async () => { allowed = false; return classification; },
  }), /capture no longer allowed/);
});

test("ordinary classification unavailability retains its existing bounded model and heuristic fallback", async () => {
  const positions = [];
  const output = await classifyStickerCandidate(image, { callSlot: async (_task, position) => {
    positions.push(position); return { ok: false, error: "synthetic unavailable" };
  } });
  assert.deepEqual(positions, ["primary", "fallback"]);
  assert.equal(output.classification, "unknown");
  assert.equal(output.confidence, 0.45);
});

test("sync forwards the runner signal only to analysis and retains already merged favorites after cancellation", async () => {
  const controller = new globalThis.AbortController();
  let favorites = 0;
  let descriptions = 0;
  const output = await syncStickerFavorites({ signal: controller.signal,
    fetchFavorites: async options => {
      favorites++;
      assert.equal(Object.hasOwn(options, "signal"), false, "QQ favorite networking is unchanged");
      return { ok: true, items: ["https://example.com/sync-first.png", "https://example.com/sync-second.png"] };
    },
    analyzerOptions: { download: async () => image, describe: async (_input, runtime) => {
      descriptions++;
      assert.equal(runtime.signal.aborted, false);
      controller.abort();
      assert.equal(runtime.signal.aborted, true);
      return description;
    } },
  });
  assert.equal(favorites, 1);
  assert.equal(descriptions, 1);
  assert.equal(output.items, 2);
  assert.equal(output.ok, false);
  assertCancelled(output.analysis);
  assert.equal(catalog.getStickerCatalog().entries.length, 2);
  assert.ok(catalog.getStickerCatalog().entries.every(entry => !entry.indexed && !entry.analysisAttempts));
  assert.equal(getStickerSyncStatus().supported, true);
  assert.equal(getStickerSyncStatus().lastAnalysis.failed, 0);
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /SYNTHETIC_STICKER|PRIVATE_REASONING/);
});

for (const source of ["runner", "analyzer"]) {
  test("sync combines both signals and stops late analysis when the " + source + " signal cancels", async () => {
    const controllers = { runner: new globalThis.AbortController(), analyzer: new globalThis.AbortController() };
    let downloads = 0;
    let descriptions = 0;
    const output = await syncStickerFavorites({ signal: controllers.runner.signal,
      fetchFavorites: async () => ({ ok: true, items: ["https://example.com/combined-first.png", "https://example.com/combined-second.png"] }),
      analyzerOptions: { signal: controllers.analyzer.signal,
        download: async () => { downloads++; return image; },
        describe: async (_input, runtime) => {
          descriptions++;
          assert.notEqual(runtime.signal, controllers.runner.signal);
          assert.notEqual(runtime.signal, controllers.analyzer.signal);
          runtime.assertCurrent();
          controllers[source].abort();
          assert.equal(runtime.signal.aborted, true);
          assert.equal(controllers[source === "runner" ? "analyzer" : "runner"].signal.aborted, false);
          assert.throws(runtime.assertCurrent, { name: "AbortError" });
          return description;
        },
      },
    });
    assertCancelled(output.analysis);
    assert.equal(downloads, 1);
    assert.equal(descriptions, 1);
    assert.equal(output.items, 2);
    assert.ok(catalog.getStickerCatalog().entries.every(entry => !entry.indexed && !entry.analysisAttempts));
    assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /SYNTHETIC_STICKER/);
  });
}

for (const analyze of [true, false]) {
  test("pre-cancelled sync preserves favorite merge semantics with analysis " + (analyze ? "enabled" : "disabled"), async () => {
    const controller = new globalThis.AbortController();
    controller.abort();
    let favorites = 0;
    let downloads = 0;
    const output = await syncStickerFavorites({ signal: controller.signal, analyze,
      fetchFavorites: async () => { favorites++; return { ok: true, items: ["https://example.com/sync.png"] }; },
      analyzerOptions: { download: async () => { downloads++; return image; } },
    });
    assert.equal(favorites, 1);
    assert.equal(downloads, 0);
    assert.equal(catalog.getStickerCatalog().entries.length, 1);
    assert.equal(output.items, 1);
    if (analyze) assertCancelled(output.analysis, 1);
    else assert.equal(output.ok, true);
  });
}
