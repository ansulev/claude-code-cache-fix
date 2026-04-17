import { test } from "node:test";
import assert from "node:assert/strict";
import { isContinueTrailerBlock, CONTINUE_TRAILER_TEXT } from "../preload.mjs";

test("CONTINUE_TRAILER_TEXT is the exact phrase CC appends on --continue", () => {
  assert.equal(CONTINUE_TRAILER_TEXT, "Continue from where you left off.");
});

test("isContinueTrailerBlock: exact-match trailer text block returns true", () => {
  assert.equal(
    isContinueTrailerBlock({ type: "text", text: CONTINUE_TRAILER_TEXT }),
    true
  );
});

test("isContinueTrailerBlock: same phrase with cache_control marker attached still matches", () => {
  assert.equal(
    isContinueTrailerBlock({
      type: "text",
      text: CONTINUE_TRAILER_TEXT,
      cache_control: { type: "ephemeral", ttl: "1h" },
    }),
    true
  );
});

test("isContinueTrailerBlock: phrase inside a longer sentence is NOT a match", () => {
  assert.equal(
    isContinueTrailerBlock({
      type: "text",
      text: "Please say 'Continue from where you left off.' at the end of your report.",
    }),
    false
  );
});

test("isContinueTrailerBlock: trailing/leading whitespace is NOT a match", () => {
  assert.equal(
    isContinueTrailerBlock({ type: "text", text: "Continue from where you left off. " }),
    false
  );
  assert.equal(
    isContinueTrailerBlock({ type: "text", text: " Continue from where you left off." }),
    false
  );
});

test("isContinueTrailerBlock: tool_result blocks are NOT matched (type mismatch)", () => {
  assert.equal(
    isContinueTrailerBlock({ type: "tool_result", content: CONTINUE_TRAILER_TEXT, tool_use_id: "t" }),
    false
  );
});

test("isContinueTrailerBlock: tool_use blocks are NOT matched", () => {
  assert.equal(isContinueTrailerBlock({ type: "tool_use", id: "t", name: "Read", input: {} }), false);
});

test("isContinueTrailerBlock: thinking blocks are NOT matched", () => {
  assert.equal(
    isContinueTrailerBlock({ type: "thinking", thinking: CONTINUE_TRAILER_TEXT }),
    false
  );
});

test("isContinueTrailerBlock: null / undefined / non-object returns false", () => {
  assert.equal(isContinueTrailerBlock(null), false);
  assert.equal(isContinueTrailerBlock(undefined), false);
  assert.equal(isContinueTrailerBlock("string"), false);
  assert.equal(isContinueTrailerBlock(42), false);
  assert.equal(isContinueTrailerBlock([]), false);
});

test("isContinueTrailerBlock: empty object / missing type returns false", () => {
  assert.equal(isContinueTrailerBlock({}), false);
  assert.equal(isContinueTrailerBlock({ text: CONTINUE_TRAILER_TEXT }), false);
});

test("isContinueTrailerBlock: type text but different phrasing returns false", () => {
  const variants = [
    "Continue",
    "continue from where you left off.",
    "CONTINUE FROM WHERE YOU LEFT OFF.",
    "Continue from where you left off",
    "Pick up where you left off.",
    "",
  ];
  for (const text of variants) {
    assert.equal(isContinueTrailerBlock({ type: "text", text }), false, `text=${JSON.stringify(text)}`);
  }
});
