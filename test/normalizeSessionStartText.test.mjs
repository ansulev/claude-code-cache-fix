import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionStartText } from "../preload.mjs";

test("normalizeSessionStartText: rewrites SessionStart:resume → :startup", () => {
  const input = "<system-reminder>\nSessionStart:resume hook success: [hook-reload] ok\n</system-reminder>";
  const [out, count] = normalizeSessionStartText(input);
  assert.ok(out.includes("SessionStart:startup hook success:"));
  assert.ok(!out.includes("SessionStart:resume"));
  assert.ok(count >= 1);
});

test("normalizeSessionStartText: startup text is unchanged (no mutation)", () => {
  const input = "<system-reminder>\nSessionStart:startup hook success: [hook-reload] ok\n</system-reminder>";
  const [out, count] = normalizeSessionStartText(input);
  assert.equal(out, input);
  assert.equal(count, 0);
});

test("normalizeSessionStartText: strips <session-id> tag and its preceding newline", () => {
  const input =
    "<system-reminder>\nSessionStart:startup hook success: ok\n<session-id>abc-123-def</session-id>\n[hook-reload] ok\n</system-reminder>";
  const [out] = normalizeSessionStartText(input);
  assert.ok(!out.includes("<session-id>"));
  assert.ok(!out.includes("abc-123-def"));
});

test("normalizeSessionStartText: strips Last active: timestamp line", () => {
  const input =
    "<system-reminder>\nSessionStart:startup hook success:\nLast active: 2026-04-16T23:59:00Z\n[hook-reload] ok\n</system-reminder>";
  const [out] = normalizeSessionStartText(input);
  assert.ok(!/Last active: \d{4}/.test(out));
});

test("normalizeSessionStartText: two different session-id / Last-active values produce identical output", () => {
  const t1 =
    "<system-reminder>\nSessionStart:startup hook success:\n<session-id>aaa-111</session-id>\nLast active: 2026-04-16T10:00:00Z\n[hook-reload] ok\n</system-reminder>";
  const t2 =
    "<system-reminder>\nSessionStart:startup hook success:\n<session-id>bbb-222</session-id>\nLast active: 2026-04-17T03:45:00Z\n[hook-reload] ok\n</system-reminder>";
  const [out1] = normalizeSessionStartText(t1);
  const [out2] = normalizeSessionStartText(t2);
  assert.equal(out1, out2);
});

test("normalizeSessionStartText: non-SessionStart reminders pass through unchanged", () => {
  const input =
    "<system-reminder>\nPostToolUse:Bash hook additional context: [thinking-enrichment] hint\n</system-reminder>";
  const [out, count] = normalizeSessionStartText(input);
  assert.equal(out, input);
  assert.equal(count, 0);
});

test("normalizeSessionStartText: non-string input returns unchanged", () => {
  const [out1, c1] = normalizeSessionStartText(null);
  assert.equal(out1, null);
  assert.equal(c1, 0);

  const [out2, c2] = normalizeSessionStartText(undefined);
  assert.equal(out2, undefined);
  assert.equal(c2, 0);

  const [out3, c3] = normalizeSessionStartText(42);
  assert.equal(out3, 42);
  assert.equal(c3, 0);
});

test("normalizeSessionStartText: handles resume marker combined with volatile session-id", () => {
  const input =
    "<system-reminder>\nSessionStart:resume hook success: [hook-reload] ok\n<session-id>xyz-999</session-id>\n[hook-reload] done\n</system-reminder>";
  const [out] = normalizeSessionStartText(input);
  assert.ok(out.includes("SessionStart:startup hook success:"));
  assert.ok(!out.includes("<session-id>"));
  assert.ok(!out.includes("xyz-999"));
});

test("normalizeSessionStartText: idempotent (running twice equals running once)", () => {
  const input =
    "<system-reminder>\nSessionStart:resume hook success:\nLast active: 2026-04-17T10:00:00Z\n[hook-reload] running\n</system-reminder>";
  const [once] = normalizeSessionStartText(input);
  const [twice] = normalizeSessionStartText(once);
  assert.equal(twice, once);
});

test("normalizeSessionStartText: applies to content that would have been smooshed into tool_result.content", () => {
  // When CC's smoosh fuses the reminder into tool_result.content, the text
  // still contains the SessionStart marker — this helper doesn't care about
  // wrapping, only the matching substrings.
  const input =
    "bash output line 1\nbash output line 2\n\n<system-reminder>\nSessionStart:resume hook success: [hook-reload] ok\n</system-reminder>";
  const [out] = normalizeSessionStartText(input);
  assert.ok(out.includes("SessionStart:startup hook success:"));
  assert.ok(!out.includes("SessionStart:resume"));
  assert.ok(out.startsWith("bash output line 1")); // pre-smoosh content untouched
});
