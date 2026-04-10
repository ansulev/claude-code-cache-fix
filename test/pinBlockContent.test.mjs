import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pinBlockContent, _pinnedBlocks } from "../preload.mjs";

// pinBlockContent normalizes trailing whitespace via:
//   text.replace(/\s+(<\/system-reminder>)\s*$/, "\n$1")
// This strips ALL trailing whitespace AFTER the closing tag and collapses
// any whitespace BEFORE the closing tag down to a single newline. The
// canonical "clean" form ends exactly with `</system-reminder>` (no
// trailing newline). Test inputs use this canonical form unless we
// explicitly want to test the normalization behavior.

const CLEAN_END = "</system-reminder>";

// Reset the module-scoped pin map before each test so tests are isolated.
beforeEach(() => {
  _pinnedBlocks.clear();
});

test("pinBlockContent: first call stores the pin and returns normalized content", () => {
  const text = `<system-reminder>\nThe content.\n${CLEAN_END}`;
  const result = pinBlockContent("test", text);
  assert.equal(result, text);
  assert.equal(_pinnedBlocks.size, 1);
  assert.ok(_pinnedBlocks.has("test"));
});

test("pinBlockContent: second call with identical content returns the pinned version", () => {
  const text = `<system-reminder>\nIdentical content.\n${CLEAN_END}`;
  const first = pinBlockContent("type-a", text);
  const second = pinBlockContent("type-a", text);
  assert.equal(second, first);
  assert.equal(_pinnedBlocks.get("type-a").text, text);
});

test("pinBlockContent: hash mismatch updates the pin and returns new content", () => {
  const v1 = `<system-reminder>\nVersion 1 content.\n${CLEAN_END}`;
  const v2 = `<system-reminder>\nVersion 2 content (different).\n${CLEAN_END}`;

  const first = pinBlockContent("type-b", v1);
  assert.equal(first, v1);
  const firstHash = _pinnedBlocks.get("type-b").hash;

  const second = pinBlockContent("type-b", v2);
  assert.equal(second, v2);
  const secondHash = _pinnedBlocks.get("type-b").hash;

  assert.notEqual(firstHash, secondHash);
  assert.equal(_pinnedBlocks.get("type-b").text, v2);
});

test("pinBlockContent: trailing whitespace before close tag normalized to single newline", () => {
  const messy = "<system-reminder>\nContent.\n\n\n</system-reminder>   \n";
  const expected = "<system-reminder>\nContent.\n</system-reminder>";
  const result = pinBlockContent("type-c", messy);
  assert.equal(result, expected);
});

test("pinBlockContent: messy and clean variants of same content collapse to same hash", () => {
  const messy = "<system-reminder>\nSame content.\n\n\n</system-reminder>   \n";
  const clean = "<system-reminder>\nSame content.\n</system-reminder>";

  pinBlockContent("type-d-messy", messy);
  const hashAfterMessy = _pinnedBlocks.get("type-d-messy").hash;

  pinBlockContent("type-d-clean", clean);
  const hashAfterClean = _pinnedBlocks.get("type-d-clean").hash;

  assert.equal(hashAfterMessy, hashAfterClean);
});

test("pinBlockContent: separate block types pinned independently", () => {
  const skillsText = `<system-reminder>\nSkills content.\n${CLEAN_END}`;
  const deferredText = `<system-reminder>\nDeferred tools content.\n${CLEAN_END}`;

  pinBlockContent("skills", skillsText);
  pinBlockContent("deferred", deferredText);

  assert.equal(_pinnedBlocks.size, 2);
  assert.equal(_pinnedBlocks.get("skills").text, skillsText);
  assert.equal(_pinnedBlocks.get("deferred").text, deferredText);
  assert.notEqual(_pinnedBlocks.get("skills").hash, _pinnedBlocks.get("deferred").hash);
});

test("pinBlockContent: returns SAME REFERENCE on cache hit (not just equal content)", () => {
  const text = `<system-reminder>\nReference equality test.\n${CLEAN_END}`;
  const first = pinBlockContent("type-e", text);
  const second = pinBlockContent("type-e", text);
  assert.equal(second, _pinnedBlocks.get("type-e").text);
  assert.equal(first, _pinnedBlocks.get("type-e").text);
});

test("pinBlockContent: third call after change returns the latest content (not the original)", () => {
  const v1 = `<system-reminder>\nV1.\n${CLEAN_END}`;
  const v2 = `<system-reminder>\nV2.\n${CLEAN_END}`;

  pinBlockContent("type-f", v1);
  pinBlockContent("type-f", v2);
  const third = pinBlockContent("type-f", v2);

  assert.equal(third, v2);
});
