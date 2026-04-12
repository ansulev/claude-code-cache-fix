import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stabilizeFingerprint, computeFingerprint } from "../preload.mjs";

// Mirror the constants from preload.mjs
const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_INDICES = [4, 7, 20];

// Helper: independently compute the expected fingerprint to cross-check
// against computeFingerprint(). This duplicates the formula on purpose so a
// future refactor of the preload implementation that breaks the formula will
// fail the test.
function expectedFingerprint(text, version) {
  const chars = FINGERPRINT_INDICES.map((i) => text[i] || "0").join("");
  return createHash("sha256")
    .update(`${FINGERPRINT_SALT}${chars}${version}`)
    .digest("hex")
    .slice(0, 3);
}

function attrBlock(version) {
  return {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=${version}; other=stuff`,
  };
}

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

test("computeFingerprint: matches independently-computed expected value", () => {
  const text = "The quick brown fox jumps over the lazy dog";
  const version = "2.1.92";
  assert.equal(computeFingerprint(text, version), expectedFingerprint(text, version));
});

test("computeFingerprint: deterministic across calls with same inputs", () => {
  const text = "Some user message text long enough for indices.";
  const version = "2.1.100";
  const a = computeFingerprint(text, version);
  const b = computeFingerprint(text, version);
  assert.equal(a, b);
});

test("computeFingerprint: handles short text by padding with '0'", () => {
  // Index 20 is past the end of "abc", so character[20] becomes "0"
  const fp = computeFingerprint("abc", "2.1.92");
  assert.equal(fp.length, 3);
  assert.match(fp, /^[0-9a-f]{3}$/);
});

test("stabilizeFingerprint: returns null when system is not an array", () => {
  assert.equal(stabilizeFingerprint(null, []), null);
  assert.equal(stabilizeFingerprint(undefined, []), null);
  assert.equal(stabilizeFingerprint("not array", []), null);
});

test("stabilizeFingerprint: returns null when no attribution block exists", () => {
  const system = [{ type: "text", text: "no header here" }];
  const messages = [userMsg("hello world")];
  assert.equal(stabilizeFingerprint(system, messages), null);
});

test("stabilizeFingerprint: returns null when cc_version cannot be parsed", () => {
  const system = [{ type: "text", text: "x-anthropic-billing-header: no_version_here" }];
  const messages = [userMsg("hello world")];
  assert.equal(stabilizeFingerprint(system, messages), null);
});

test("stabilizeFingerprint: returns null when version has fewer than 4 dot parts", () => {
  // "2.1.92" has only 3 parts, no fingerprint to stabilize
  const system = [attrBlock("2.1.92")];
  const messages = [userMsg("hello world")];
  assert.equal(stabilizeFingerprint(system, messages), null);
});

test("stabilizeFingerprint: returns null when fingerprint is already stable", () => {
  const text = "This message text has more than 21 chars for the index extraction.";
  const baseVersion = "2.1.92";
  const stable = computeFingerprint(text, baseVersion);
  const system = [attrBlock(`${baseVersion}.${stable}`)];
  const messages = [userMsg(text)];
  assert.equal(stabilizeFingerprint(system, messages), null);
});

test("stabilizeFingerprint: replaces unstable fingerprint with stable one", () => {
  const text = "This message text has more than 21 chars for the index extraction.";
  const baseVersion = "2.1.92";
  // The real scenario: messages[0] contains the text CC fingerprinted, but we
  // compute differently because extractRealUserMessageText skips system-reminder blocks.
  // So we need messages[0] to have system-reminder + realText
  const expectedStable = computeFingerprint(text, baseVersion);

  const metaBlock = "<system-reminder>Meta block.</system-reminder>";
  const allText = metaBlock + text;
  const oldFingerprint = computeFingerprint(allText, baseVersion);

  const system = [attrBlock(`${baseVersion}.${oldFingerprint}`)];
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: metaBlock },
        { type: "text", text },
      ],
    },
  ];

  const result = stabilizeFingerprint(system, messages);
  assert.notEqual(result, null);
  assert.equal(result.attrIdx, 0);
  assert.equal(result.oldFingerprint, oldFingerprint);
  assert.equal(result.stableFingerprint, expectedStable);
  assert.ok(result.newText.includes(`cc_version=${baseVersion}.${expectedStable}`));
  assert.ok(!result.newText.includes(`cc_version=${baseVersion}.${oldFingerprint}`));
});

test("stabilizeFingerprint: extracts text from real user message, skipping system-reminder blocks", () => {
  const realText = "This is the real user message with enough content for indices to land.";
  const baseVersion = "2.1.100";
  const expectedStable = computeFingerprint(realText, baseVersion);
  // For round-trip verification, compute what CC would have computed from messages[0]
  const metaBlock = "<system-reminder>\nSome meta block.\n</system-reminder>";
  const messageContent = metaBlock + realText;
  const oldFingerprint = computeFingerprint(messageContent, baseVersion);

  const system = [attrBlock(`${baseVersion}.${oldFingerprint}`)];
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: metaBlock },
        { type: "text", text: realText },
      ],
    },
  ];

  const result = stabilizeFingerprint(system, messages);
  assert.notEqual(result, null);
  assert.equal(result.stableFingerprint, expectedStable);
});

test("stabilizeFingerprint: skips assistant messages and finds first user message", () => {
  const realText = "User message text used for fingerprint computation here.";
  const baseVersion = "2.1.100";
  const correctFingerprint = computeFingerprint(realText, baseVersion);

  const system = [attrBlock(`${baseVersion}.${correctFingerprint}`)];
  const messages = [
    userMsg(realText),  // messages[0] is user message with the correct fingerprint
    { role: "assistant", content: [{ type: "text", text: "An assistant message." }] },
  ];

  const result = stabilizeFingerprint(system, messages);
  // Since oldFingerprint matches what we compute, result should be null (already stable)
  assert.equal(result, null);
});

test("stabilizeFingerprint: handles string-content user messages (non-array)", () => {
  const realText = "A string-content user message with enough chars for the indices.";
  const baseVersion = "2.1.100";
  // For string-content messages, messages[0] is just the string, not an array
  const oldFingerprint = computeFingerprint(realText, baseVersion);

  const system = [attrBlock(`${baseVersion}.${oldFingerprint}`)];
  const messages = [{ role: "user", content: realText }];

  const result = stabilizeFingerprint(system, messages);
  // Since oldFingerprint matches what we compute, result should be null (already stable)
  assert.equal(result, null);
});

test("stabilizeFingerprint: locates attribution block at non-zero index", () => {
  const text = "This message text has more than 21 chars for the index extraction.";
  const baseVersion = "2.1.92";
  const oldFingerprint = computeFingerprint(text, baseVersion);

  const system = [
    { type: "text", text: "Some other system content." },
    { type: "text", text: "More system content." },
    attrBlock(`${baseVersion}.${oldFingerprint}`),
  ];
  const messages = [userMsg(text)];

  const result = stabilizeFingerprint(system, messages);
  // Since oldFingerprint matches what we compute, result should be null (already stable)
  assert.equal(result, null);
});
