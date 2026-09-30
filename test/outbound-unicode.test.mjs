import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOutboundText, splitLongText } from "../bridge/outbound-message.mjs";

const EMOJI = "\u{1F600}";
const ASTRAL_CJK = "\u{20000}";

function assertWellFormed(chunk) {
  for (let i = 0; i < chunk.length; i++) {
    const unit = chunk.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = chunk.charCodeAt(++i);
      assert.ok(next >= 0xDC00 && next <= 0xDFFF, "dangling high surrogate");
    } else {
      assert.ok(unit < 0xDC00 || unit > 0xDFFF, "dangling low surrogate");
    }
  }
}

function assertChunks(text, maxLen = 900, expected = normalizeOutboundText(text)) {
  const chunks = splitLongText(text, maxLen);
  const cap = Math.min(Math.max(1, Number(maxLen) || 900), 1200);
  assert.equal(chunks.join(""), expected, "content must be conserved except boundary trimming");
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, "no empty chunks");
    assert.equal(chunk, chunk.trim());
    assertWellFormed(chunk);
    assert.equal(chunk.includes("\uFFFD"), false, "no replacement characters");
    // A whole astral code point is the minimum semantic unit when maxLen is 1.
    assert.ok(chunk.length <= cap || (cap < 2 && chunk.length === 2 && [...chunk].length === 1));
  }
  return chunks;
}

describe("outbound Unicode splitting", () => {
  it("keeps the default 900-unit cap at 899 ASCII characters plus emoji", () => {
    const prefix = "a".repeat(899);
    assert.deepEqual(splitLongText(prefix + EMOJI), [prefix, EMOJI]);
    assert.deepEqual(assertChunks(prefix + EMOJI + "b".repeat(900)), [prefix, EMOJI + "b".repeat(898), "bb"]);
    assert.deepEqual(splitLongText("a".repeat(900)), ["a".repeat(900)]);
  });

  it("conserves mixed BMP CJK and astral code points", () => {
    const text = ("\u7532" + EMOJI + "\u4E59" + ASTRAL_CJK + "\u{1D11E}").repeat(400);
    for (const limit of [3, 7, 31, 899, 900]) assertChunks(text, limit);
  });

  for (const limit of [1, 2]) {
    it(`keeps adjacent emoji whole and makes progress at maxLen=${limit}`, () => {
      const text = EMOJI + "\u{1F680}" + ASTRAL_CJK + EMOJI;
      assert.deepEqual(assertChunks(text, limit), [...text]);
      assert.deepEqual(assertChunks(EMOJI, limit), [EMOJI]);
      assert.deepEqual(assertChunks("a" + EMOJI + "\u7532" + ASTRAL_CJK + "b", limit), ["a", EMOJI, "\u7532", ASTRAL_CJK, "b"]);
    });
  }

  it("keeps a complete surrogate pair that ends exactly at the cap", () => {
    const prefix = "a".repeat(898) + EMOJI;
    assert.deepEqual(assertChunks(prefix + "b"), [prefix, "b"]);
  });

  it("keeps punctuation just inside the cap with its preceding emoji", () => {
    const prefix = "a".repeat(897) + EMOJI + "\u3002";
    assert.deepEqual(assertChunks(prefix + "b".repeat(901)), [prefix, "b".repeat(900), "b"]);
  });

  it("does not include punctuation just outside the cap", () => {
    const prefix = "a".repeat(898) + EMOJI;
    assert.deepEqual(assertChunks(prefix + "\u3002tail"), [prefix, "\u3002tail"]);
    const splitPrefix = "a".repeat(899);
    assert.deepEqual(assertChunks(splitPrefix + EMOJI + "\u3002tail"), [splitPrefix, EMOJI + "\u3002tail"]);
  });

  it("preserves paragraph priority over later newline and sentence boundaries", () => {
    const prefix = "a".repeat(399);
    const suffix = "b".repeat(198) + "\n" + "c".repeat(198) + "!tail";
    assert.deepEqual(assertChunks(prefix + "\n\n" + suffix, 800, prefix + suffix), [prefix, suffix]);
  });

  it("preserves newline priority over later sentence boundaries", () => {
    const prefix = "a".repeat(399);
    const suffix = "b".repeat(398) + "!tail";
    assert.deepEqual(assertChunks(prefix + "\n" + suffix, 800, prefix + suffix), [prefix, suffix]);
  });

  it("preserves sentence priority over later comma boundaries", () => {
    const prefix = "a".repeat(399) + "\u3002";
    const suffix = "b".repeat(398) + ",tail";
    assert.deepEqual(assertChunks(prefix + suffix, 800), [prefix, suffix]);
  });

  it("preserves preferred delimiters and the existing 35 percent threshold", () => {
    for (const delimiter of ["\u3002", "\uFF1F", "\uFF01", "?", "!", "\uFF1B", ";", "\uFF0C", ",", " "]) {
      const prefix = "a".repeat(7) + delimiter;
      const suffix = "b".repeat(13);
      const expected = prefix.trim() + suffix;
      assert.deepEqual(assertChunks(prefix + suffix, 20, expected), [prefix.trim(), suffix]);
    }
    assert.deepEqual(assertChunks("a!" + "b".repeat(25), 20), ["a!" + "b".repeat(18), "b".repeat(7)]);
  });

  it("preserves earlier punctuation when the nominal cap bisects an emoji", () => {
    const prefix = "a".repeat(798) + "\u3002";
    const suffix = "b".repeat(100) + EMOJI + "tail";
    assert.deepEqual(assertChunks(prefix + suffix), [prefix, suffix]);
  });

  it("splits 3000 UTF-16 units without losing BMP or astral content", () => {
    const text = ("a\u4E2D" + EMOJI).repeat(750);
    assert.equal(text.length, 3000);
    assert.deepEqual(assertChunks(text).map(chunk => chunk.length), [900, 900, 900, 300]);
    assertChunks("\u7532\u3002".repeat(1500));
  });

  it("retains the 1200-unit hard cap for oversized configuration", () => {
    const prefix = "a".repeat(1199);
    const text = prefix + EMOJI + "b".repeat(1300);
    assert.deepEqual(assertChunks(text, 5000), [prefix, EMOJI + "b".repeat(1198), "b".repeat(102)]);
  });

  it("retains normalization and boundary trimming without empty chunks", () => {
    const text = " \r\n" + "a".repeat(6) + " \r\n\r\n " + EMOJI + "b".repeat(8) + " \r ";
    const expected = "a".repeat(6) + EMOJI + "b".repeat(8);
    assert.deepEqual(assertChunks(text, 8, expected), ["a".repeat(6), EMOJI + "b".repeat(6), "bb"]);
    for (const limit of [1, 2]) {
      assert.deepEqual(assertChunks(" \r\n" + EMOJI + " \r\n " + ASTRAL_CJK + " ", limit, EMOJI + ASTRAL_CJK), [EMOJI, ASTRAL_CJK]);
    }
    for (const empty of [null, undefined, "", " \r\n\t "]) assert.deepEqual(splitLongText(empty, 1), []);
  });

  it("conserves content and valid surrogates across a bounded cut-position matrix", () => {
    for (const limit of [1, 1.5, 2, 2.5, 3, 8, 31, 899, 900, 1200, 5000]) {
      for (const prefixLength of [0, 1, 2, 7, 30, 898, 899, 900, 1198, 1199, 1200]) {
        assertChunks("a".repeat(prefixLength) + EMOJI + ASTRAL_CJK + "\u4E2D" + EMOJI + "z".repeat(35), limit);
      }
    }
  });
});
