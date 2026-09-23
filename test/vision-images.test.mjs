import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import test from "node:test";
import sharp from "sharp";
import { prepareVisionImages, VISION_IMAGE_LIMITS as LIMITS } from "../bridge/vision/images.mjs";

const { AbortController, Response, ReadableStream } = globalThis;
const URL_A = "https://images.example/a";
const URL_B = "https://images.example/b";
const URL_C = "https://images.example/c";
const URL_D = "https://images.example/d";

function fixture(width = 32, height = 16, background = "red") {
  return sharp({ create: { width, height, channels: 4, background } });
}

function loader(buffer, mimeType = "image/png") {
  return async () => ({ buffer, mimeType });
}

function jpegBytes(image) {
  assert.equal(image.content.type, "image_url");
  assert.match(image.content.image_url.url, /^data:image\/jpeg;base64,/);
  return Buffer.from(image.content.image_url.url.split(",")[1], "base64");
}

function counts(result, requested, failed, omitted) {
  assert.equal(result.requested, requested);
  assert.equal(result.failed, failed);
  assert.equal(result.omitted, omitted);
  assert.equal(result.images.length + failed + omitted, requested);
}

test("fixed, immutable limits match the vision contract", () => {
  assert.deepEqual(LIMITS, {
    maxImages: 3, maxUrlLength: 8192, maxSourceBytes: 10 * 1024 * 1024,
    maxInputPixels: 40_000_000, maxDimension: 2048, jpegQuality: 85,
    maxNormalizedBytes: 1.5 * 1024 * 1024, maxTotalNormalizedBytes: 4.5 * 1024 * 1024,
    timeoutMs: 10000,
  });
  assert.ok(Object.isFrozen(LIMITS));
  assert.throws(() => { LIMITS.maxImages = 100; }, TypeError);
});

test("empty and non-array inputs cannot create requests", async () => {
  for (const input of [undefined, null, URL_A, {}, [], [null, {}, 1, "", "   "]]) {
    const result = await prepareVisionImages(input, { fetchBuffer: () => assert.fail("unexpected fetch") });
    assert.deepEqual(result, { images: [], requested: 0, failed: 0, omitted: 0 });
  }
});

test("only first three unique nonempty strings are selected, without failure backfill", async () => {
  const buffer = await fixture().png().toBuffer();
  const seen = [];
  const result = await prepareVisionImages([null, ` ${URL_A} `, URL_A, "", URL_B, URL_C, URL_D, URL_D], {
    fetchBuffer: async url => {
      seen.push(url);
      if (url === URL_A) throw new Error("fixture download failure");
      if (url === URL_B) return null;
      return { buffer };
    },
  });
  assert.deepEqual(seen, [URL_A, URL_B, URL_C]);
  counts(result, 4, 2, 1);
  assert.deepEqual(result.images.map(image => image.index), [6]);
});

test("duplicate URLs keep first-occurrence original indices and current/quote/recent metadata order", async () => {
  const sources = [
    { url: URL_A, origin: "current" }, { url: URL_A, origin: "quote" },
    { url: URL_B, origin: "quote" }, { url: URL_C, origin: "recent" },
    { url: URL_B, origin: "recent" }, { url: URL_D, origin: "recent" },
  ];
  const fixtures = new Map();
  for (const [position, url] of [URL_A, URL_B, URL_C].entries()) {
    fixtures.set(url, await fixture(16 + position, 8 + position).png().toBuffer());
  }
  const seen = [];
  const result = await prepareVisionImages(sources.map(source => source.url), {
    fetchBuffer: async url => { seen.push(url); return { buffer: fixtures.get(url) }; },
  });
  counts(result, 4, 0, 1);
  assert.deepEqual(seen, [URL_A, URL_B, URL_C]);
  assert.deepEqual(result.images.map(image => image.index), [1, 3, 4]);
  assert.deepEqual(result.images.map(image => sources[image.index - 1].origin), ["current", "quote", "recent"]);
  assert.deepEqual(result.images.map(image => [image.width, image.height]), [[16, 8], [17, 9], [18, 10]]);
  for (const image of result.images) {
    const buffer = fixtures.get(sources[image.index - 1].url);
    assert.equal(image.digest, createHash("sha256").update(buffer).digest("hex"));
  }
});

test("unsafe or overlong selected strings consume slots without reaching the fixture hook", async () => {
  const rejected = [
    "data:image/png;base64,AAAA", "file:///tmp/image.png", "/tmp/image.png", "C:\\image.png",
    "http://localhost/a", "http://127.0.0.1/a", "http://10.0.0.1/a", "http://[::1]/a",
    "http://169.254.169.254/a", "http://[::ffff:127.0.0.1]/a", "https://user:secret@images.example/a",
    "ftp://images.example/a", "not-a-url", URL_A + "x".repeat(LIMITS.maxUrlLength),
  ];
  const buffer = await fixture().png().toBuffer();
  for (const url of rejected) {
    const seen = [];
    const result = await prepareVisionImages([url, URL_B, URL_C, URL_D], {
      fetchBuffer: async value => { seen.push(value); return { buffer }; },
    });
    counts(result, 4, 1, 1);
    assert.deepEqual(seen, [URL_B, URL_C]);
    assert.deepEqual(result.images.map(image => image.index), [2, 3]);
  }
});

test("URL length boundary is accepted and arbitrary options cannot widen fetch capabilities", async () => {
  const buffer = await fixture().png().toBuffer();
  const controller = new AbortController();
  const url = URL_A + "x".repeat(LIMITS.maxUrlLength - URL_A.length);
  const result = await prepareVisionImages([url], {
    signal: controller.signal,
    maxBytes: Infinity, maxImages: 99, limitInputPixels: false, timeoutMs: Infinity,
    headers: { authorization: "not-forwarded" }, lookup: () => assert.fail("unexpected lookup hook"),
    requestImpl: () => assert.fail("unexpected transport hook"),
    fetchBuffer: async (value, options) => {
      assert.equal(value, url);
      assert.deepEqual(options, { signal: controller.signal, timeoutMs: 10000, maxBytes: 10 * 1024 * 1024 });
      return { buffer };
    },
  });
  counts(result, 1, 0, 0);
});

for (const format of ["jpeg", "png", "webp", "gif", "avif", "tiff"]) {
  test(`${format} is decoded from bytes despite a false MIME and becomes a static JPEG`, async () => {
    const buffer = await fixture().toFormat(format).toBuffer();
    const result = await prepareVisionImages([URL_A], { fetchBuffer: loader(buffer, "text/html") });
    counts(result, 1, 0, 0);
    const image = result.images[0];
    assert.deepEqual(Object.keys(image).sort(), ["animated", "content", "digest", "height", "index", "width"]);
    assert.equal(image.digest, createHash("sha256").update(buffer).digest("hex"));
    assert.equal(image.width, 32);
    assert.equal(image.height, 16);
    assert.equal(image.animated, false);
    assert.equal(image.index, 1);
    const output = await sharp(jpegBytes(image)).metadata();
    assert.equal(output.format, "jpeg");
    assert.equal(output.pages || 1, 1);
    assert.equal(output.hasAlpha, false);
    assert.equal(output.exif, undefined);
  });
}

test("raw-byte digest distinguishes visually identical encodings and does not deduplicate different URLs", async () => {
  const a = await fixture().png({ compressionLevel: 0 }).toBuffer();
  const b = await fixture().png({ compressionLevel: 9 }).toBuffer();
  assert.notDeepEqual(a, b);
  const result = await prepareVisionImages([URL_A, URL_B, URL_C], {
    fetchBuffer: async url => ({ buffer: url === URL_B ? b : a }),
  });
  counts(result, 3, 0, 0);
  assert.notEqual(result.images[0].digest, result.images[1].digest);
  assert.equal(result.images[0].digest, result.images[2].digest);
  assert.equal(result.images[0].content.image_url.url, result.images[1].content.image_url.url);
});

test("normalization rotates EXIF, fits inside 2048, never enlarges, strips metadata, and flattens white", async () => {
  const oriented = await fixture(3000, 1500).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const transparent = await fixture(17, 9, { r: 255, g: 0, b: 0, alpha: 0 }).png().toBuffer();
  const result = await prepareVisionImages([URL_A, URL_B], {
    fetchBuffer: async url => ({ buffer: url === URL_A ? oriented : transparent }),
  });
  counts(result, 2, 0, 0);
  assert.deepEqual(result.images.map(({ width, height }) => [width, height]), [[1024, 2048], [17, 9]]);
  const meta = await sharp(jpegBytes(result.images[0])).metadata();
  assert.equal(meta.orientation, undefined);
  assert.equal(meta.exif, undefined);
  assert.equal(meta.icc, undefined);
  const { data, info } = await sharp(jpegBytes(result.images[1])).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  assert.ok(data.every(value => value >= 254));
});

for (const format of ["gif", "webp", "tiff"]) {
  test(`${format} multiple pages set animated but only frame zero is encoded`, async () => {
    const pixels = Buffer.concat([Buffer.alloc(32 * 16 * 3, 25), Buffer.alloc(32 * 16 * 3, 220)]);
    const buffer = await sharp(pixels, { raw: { width: 32, height: 32, channels: 3, pageHeight: 16 } })
      .toFormat(format, { delay: [100, 200], loop: 0 }).toBuffer();
    assert.equal((await sharp(buffer).metadata()).pages, 2);
    const result = await prepareVisionImages([URL_A], { fetchBuffer: loader(buffer) });
    counts(result, 1, 0, 0);
    assert.equal(result.images[0].animated, true);
    assert.equal(result.images[0].height, 16);
    const decoded = await sharp(jpegBytes(result.images[0])).raw().toBuffer();
    assert.ok(decoded.every(value => Math.abs(value - 25) <= 2));
  });
}

test("empty, malformed, truncated, and false image MIME data fail individually", async () => {
  const png = await fixture().png().toBuffer();
  const invalid = [null, {}, { buffer: "a filename.png" }, { buffer: new Uint8Array(png) },
    { buffer: Buffer.alloc(0) }, { buffer: Buffer.from("not an image"), mimeType: "image/jpeg" },
    { buffer: png.subarray(0, 40), mimeType: "image/png" },
    { buffer: Buffer.from("ffd8ffe000", "hex"), mimeType: "image/jpeg" }];
  for (const source of invalid) {
    const result = await prepareVisionImages([URL_A, URL_B], {
      fetchBuffer: async url => url === URL_A ? source : { buffer: png },
    });
    counts(result, 2, 1, 0);
    assert.equal(result.images[0].index, 2);
  }
});

test("SVG and PDF are rejected before invoking even sharp metadata", async t => {
  const metadata = t.mock.method(sharp.prototype, "metadata", () => assert.fail("vector decoder invoked"));
  const sources = [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'),
    Buffer.from("%PDF-1.7\nsynthetic fixture"),
  ];
  for (const buffer of sources) {
    const result = await prepareVisionImages([URL_A], { fetchBuffer: loader(buffer, "image/png") });
    counts(result, 1, 1, 0);
  }
  assert.equal(metadata.mock.callCount(), 0);
});

test("a raster signature cannot bypass the detected-format and dimension allowlist", async t => {
  const buffer = await fixture().png().toBuffer();
  let metadata;
  t.mock.method(sharp.prototype, "metadata", async () => metadata);
  const encode = t.mock.method(sharp.prototype, "toBuffer", () => assert.fail("untrusted metadata encoded"));
  for (const value of [
    { format: "svg", width: 32, height: 16 }, { format: "pdf", width: 32, height: 16 },
    { format: "jp2", width: 32, height: 16 }, { format: "raw", width: 32, height: 16 },
    { format: "png", width: 0, height: 16 }, { format: "png", width: 32, height: -1 },
    { format: "png", width: 1.5, height: 16 }, { format: "png", width: Infinity, height: 16 },
    { format: "png", width: 8000, height: 5001 },
  ]) {
    metadata = value;
    const result = await prepareVisionImages([URL_A], { fetchBuffer: loader(buffer) });
    counts(result, 1, 1, 0);
  }
  assert.equal(encode.mock.callCount(), 0);
});

test("10 MiB source byte boundary is inclusive and oversized fixtures never reach sharp", async t => {
  const png = await fixture().png().toBuffer();
  const atLimit = Buffer.concat([png, Buffer.alloc(LIMITS.maxSourceBytes - png.length)]);
  const accepted = await prepareVisionImages([URL_A], { fetchBuffer: loader(atLimit) });
  counts(accepted, 1, 0, 0);
  assert.equal(accepted.images[0].digest, createHash("sha256").update(atLimit).digest("hex"));
  const metadata = t.mock.method(sharp.prototype, "metadata", () => assert.fail("oversized input decoded"));
  const rejected = await prepareVisionImages([URL_A], { fetchBuffer: loader(Buffer.concat([atLimit, Buffer.from([0])])) });
  counts(rejected, 1, 1, 0);
  assert.equal(metadata.mock.callCount(), 0);
});

test("a tiny compressed pixel bomb fails and does not replace the selected slot", async () => {
  const bomb = await fixture(8000, 5001).png().toBuffer();
  assert.ok(bomb.length < LIMITS.maxSourceBytes);
  const png = await fixture().png().toBuffer();
  const result = await prepareVisionImages([URL_A, URL_B, URL_C, URL_D], {
    fetchBuffer: async url => ({ buffer: url === URL_A ? bomb : png }),
  });
  counts(result, 4, 1, 1);
  assert.deepEqual(result.images.map(image => image.index), [2, 3]);
});

test("40 million input pixels are accepted and normalized within the dimension cap", async () => {
  const buffer = await fixture(8000, 5000).png().toBuffer();
  const result = await prepareVisionImages([URL_A], { fetchBuffer: loader(buffer) });
  counts(result, 1, 0, 0);
  assert.equal(result.images[0].width, 2048);
  assert.equal(result.images[0].height, 1280);
});

test("high-entropy real JPEG exceeding 1.5 MiB after quality-85 normalization fails individually", async () => {
  const pixels = Buffer.alloc(2048 * 2048 * 3);
  let state = 123456789;
  for (let offset = 0; offset < pixels.length; offset += 3) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    pixels.fill(state & 255, offset, offset + 3);
  }
  const buffer = await sharp(pixels, { raw: { width: 2048, height: 2048, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  assert.ok(buffer.length <= LIMITS.maxSourceBytes);
  const expected = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
  assert.ok(expected.length > LIMITS.maxNormalizedBytes);
  const good = await fixture().png().toBuffer();
  const result = await prepareVisionImages([URL_A, URL_B], {
    fetchBuffer: async url => ({ buffer: url === URL_A ? buffer : good }),
  });
  counts(result, 2, 1, 0);
  assert.equal(result.images[0].index, 2);
});

test("normalized per-image and aggregate byte boundaries are inclusive", async t => {
  const buffer = await fixture().png().toBuffer();
  let size = LIMITS.maxNormalizedBytes;
  t.mock.method(sharp.prototype, "toBuffer", async () => ({ data: Buffer.alloc(size), info: { width: 32, height: 16 } }));
  const accepted = await prepareVisionImages([URL_A, URL_B, URL_C, URL_D], { fetchBuffer: loader(buffer) });
  counts(accepted, 4, 0, 1);
  assert.equal(accepted.images.reduce((sum, image) => sum + jpegBytes(image).length, 0), LIMITS.maxTotalNormalizedBytes);
  size++;
  const rejected = await prepareVisionImages([URL_A, URL_B, URL_C, URL_D], { fetchBuffer: loader(buffer) });
  counts(rejected, 4, 3, 1);
});

test("an ordinary re-encode failure preserves original indices and cannot fetch a replacement", async t => {
  const buffer = await fixture().png().toBuffer();
  const original = sharp.prototype.toBuffer;
  let encodes = 0;
  const seen = [];
  t.mock.method(sharp.prototype, "toBuffer", async function (...args) {
    if (++encodes === 1) throw new Error("synthetic re-encode failure");
    return original.apply(this, args);
  });
  const result = await prepareVisionImages([URL_A, URL_A, URL_B, URL_C, URL_D], {
    fetchBuffer: async url => { seen.push(url); return { buffer }; },
  });
  counts(result, 4, 1, 1);
  assert.deepEqual(seen, [URL_A, URL_B, URL_C]);
  assert.deepEqual(result.images.map(image => image.index), [3, 4]);
});

test("pre-aborted signals propagate their exact reason even with no images", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  controller.abort(reason);
  for (const urls of [[], [URL_A]]) {
    await assert.rejects(prepareVisionImages(urls, {
      signal: controller.signal, fetchBuffer: () => assert.fail("fetch after abort"),
    }), error => error === reason);
  }
});

test("abort during fetch propagates even when the loader returns null or throws another error", async () => {
  for (const fail of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("cancelled while fetching");
    let calls = 0;
    await assert.rejects(prepareVisionImages([URL_A, URL_B], {
      signal: controller.signal,
      fetchBuffer: async (_url, options) => {
        calls++;
        assert.equal(options.signal, controller.signal);
        controller.abort(reason);
        if (fail) throw new Error("ordinary download failure");
        return null;
      },
    }), error => error === reason);
    assert.equal(calls, 1);
  }
});

test("explicit chat cancellation errors are propagated without requiring an aborted signal", async () => {
  for (const properties of [{ code: "CHAT_CANCELLED" }, { code: "CHAT_TOOL_STOPPED" }]) {
    const reason = Object.assign(new Error("cancel fixture"), properties);
    await assert.rejects(prepareVisionImages([URL_A], { fetchBuffer: async () => { throw reason; } }), error => error === reason);
  }
});

test("one-shot assertCurrent exceptions propagate at every successful asynchronous boundary", async () => {
  const buffer = await fixture().png().toBuffer();
  let checks = 0;
  await prepareVisionImages([URL_A], { fetchBuffer: loader(buffer), assertCurrent: () => { checks++; } });
  assert.ok(checks >= 6);
  for (let stopAt = 1; stopAt <= checks; stopAt++) {
    let current = 0;
    const reason = new Error("one-shot session invalidation");
    await assert.rejects(prepareVisionImages([URL_A], {
      fetchBuffer: loader(buffer), assertCurrent: () => { if (++current === stopAt) throw reason; },
    }), error => error === reason);
  }
});

test("one-shot session invalidation also propagates after a failed fetch", async () => {
  const reason = new Error("session changed during failed fetch");
  let stale = false;
  await assert.rejects(prepareVisionImages([URL_A], {
    fetchBuffer: async () => { stale = true; throw new Error("ordinary fetch failure"); },
    assertCurrent: () => { if (stale) { stale = false; throw reason; } },
  }), error => error === reason);
});

for (const stage of ["metadata", "toBuffer"]) {
  for (const fail of [false, true]) {
    test(`abort and session invalidation during ${stage} ${fail ? "failure" : "success"} cannot be swallowed`, async t => {
      const buffer = await fixture().png().toBuffer();
      const original = sharp.prototype[stage];
      const reason = new Error("cancelled during CPU work");
      const controller = new AbortController();
      let stale = false;
      let fetches = 0;
      let checks = 0;
      let useSignal = true;
      t.mock.method(sharp.prototype, stage, async function (...args) {
        const before = checks;
        const result = await original.apply(this, args);
        assert.ok(before > 0);
        if (useSignal) controller.abort(reason);
        else stale = true;
        if (fail) throw new Error("synthetic decoder failure");
        return result;
      });
      for (useSignal of [true, false]) {
        stale = false;
        await assert.rejects(prepareVisionImages([URL_A, URL_B], {
          signal: useSignal ? controller.signal : undefined,
          fetchBuffer: async () => { fetches++; return { buffer }; },
          assertCurrent: () => { checks++; if (stale) { stale = false; throw reason; } },
        }), error => error === reason);
      }
      assert.equal(fetches, 2);
    });
  }
}

test("default safe-fetch still rejects redirects to private addresses with no network", async t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.png" } });
  });
  const result = await prepareVisionImages([URL_A]);
  counts(result, 1, 1, 0);
  assert.equal(fetch.mock.callCount(), 1);
});

test("default safe-fetch enforces the streaming source cap without trusting MIME", async t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "image/jpeg" } }));
  const result = await prepareVisionImages([URL_A]);
  counts(result, 1, 1, 0);
  assert.equal(pulls, 11);
  assert.equal(cancelled, true);
});
