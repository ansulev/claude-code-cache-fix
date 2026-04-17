import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findDeferredToolsBlockInBody,
  deferredToolsSnapshotPath,
  DEFERRED_TOOLS_AVAILABLE_MARKER,
  DEFERRED_TOOLS_UNAVAILABLE_MARKER,
} from "../preload.mjs";

function fullBlock(tools = ["Bash", "Edit", "Read", "mcp__server__tool1"]) {
  return (
    "<system-reminder>\n" +
    `${DEFERRED_TOOLS_AVAILABLE_MARKER}. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n` +
    tools.join("\n") + "\n" +
    "</system-reminder>"
  );
}

function reducedBlock() {
  return (
    "<system-reminder>\n" +
    `${DEFERRED_TOOLS_AVAILABLE_MARKER}. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n` +
    "AskUserQuestion\nEnterPlanMode\nExitPlanMode\nPushNotification\n" +
    `${DEFERRED_TOOLS_UNAVAILABLE_MARKER} (their MCP server disconnected). Do not search for them — ToolSearch will return no match:\n` +
    "</system-reminder>"
  );
}

test("findDeferredToolsBlockInBody: locates block at msg[0].content[0]", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: fullBlock() }] },
    ],
  };
  const found = findDeferredToolsBlockInBody(body);
  assert.ok(found);
  assert.equal(found.msgIdx, 0);
  assert.equal(found.blockIdx, 0);
  assert.ok(found.text.includes(DEFERRED_TOOLS_AVAILABLE_MARKER));
});

test("findDeferredToolsBlockInBody: finds block at msg[N].content[M] (post-compaction shape)", () => {
  // After compaction, msg[0] is often a bare tool-echo string and the
  // attachment bundle — including the deferred-tools block — lands at
  // msg[1].content[N] where N > 0.
  const body = {
    messages: [
      { role: "user", content: "<system-reminder>\nCalled the Read tool...\n</system-reminder>" },
      {
        role: "user",
        content: [
          { type: "text", text: "preamble A" },
          { type: "text", text: "preamble B" },
          { type: "text", text: fullBlock() },
        ],
      },
    ],
  };
  const found = findDeferredToolsBlockInBody(body);
  assert.ok(found);
  assert.equal(found.msgIdx, 1);
  assert.equal(found.blockIdx, 2);
});

test("findDeferredToolsBlockInBody: returns null when block is absent", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "just a user prompt" }] },
    ],
  };
  assert.equal(findDeferredToolsBlockInBody(body), null);
});

test("findDeferredToolsBlockInBody: skips assistant messages (false-positive guard)", () => {
  // If the agent discusses the deferred-tools mechanism in its own output,
  // its text MUST NOT be misidentified as a real user-side attachment block.
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "text", text: fullBlock() }] },
      { role: "user", content: [{ type: "text", text: "plain user prompt" }] },
    ],
  };
  assert.equal(findDeferredToolsBlockInBody(body), null);
});

test("findDeferredToolsBlockInBody: null / empty body returns null without throwing", () => {
  assert.equal(findDeferredToolsBlockInBody(null), null);
  assert.equal(findDeferredToolsBlockInBody(undefined), null);
  assert.equal(findDeferredToolsBlockInBody({}), null);
  assert.equal(findDeferredToolsBlockInBody({ messages: [] }), null);
  assert.equal(findDeferredToolsBlockInBody({ messages: null }), null);
});

test("findDeferredToolsBlockInBody: user messages with string content are skipped (no content array to scan)", () => {
  const body = {
    messages: [
      { role: "user", content: "bare string content" },
      { role: "user", content: [{ type: "text", text: fullBlock() }] },
    ],
  };
  const found = findDeferredToolsBlockInBody(body);
  assert.ok(found);
  assert.equal(found.msgIdx, 1);
});

test("findDeferredToolsBlockInBody: reduced block with UNAVAILABLE marker is still detected", () => {
  // The reduced/shrunk form carries the AVAILABLE marker at the top and
  // the UNAVAILABLE marker at the bottom. We locate by AVAILABLE; the
  // UNAVAILABLE check happens in the caller to decide restore-vs-snapshot.
  const body = {
    messages: [{ role: "user", content: [{ type: "text", text: reducedBlock() }] }],
  };
  const found = findDeferredToolsBlockInBody(body);
  assert.ok(found);
  assert.ok(found.text.includes(DEFERRED_TOOLS_AVAILABLE_MARKER));
  assert.ok(found.text.includes(DEFERRED_TOOLS_UNAVAILABLE_MARKER));
});

test("findDeferredToolsBlockInBody: returns first match when multiple user messages contain the marker", () => {
  // Shouldn't happen in practice — CC emits the attachment once — but
  // make the behavior explicit: first user-side occurrence wins.
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: fullBlock(["Bash"]) }] },
      { role: "user", content: [{ type: "text", text: fullBlock(["Edit"]) }] },
    ],
  };
  const found = findDeferredToolsBlockInBody(body);
  assert.ok(found);
  assert.equal(found.msgIdx, 0);
});

test("deferredToolsSnapshotPath: deterministic — same key yields same path", () => {
  const a = deferredToolsSnapshotPath("/home/test/project");
  const b = deferredToolsSnapshotPath("/home/test/project");
  assert.equal(a, b);
});

test("deferredToolsSnapshotPath: different keys yield different paths", () => {
  const a = deferredToolsSnapshotPath("/home/test/project-a");
  const b = deferredToolsSnapshotPath("/home/test/project-b");
  assert.notEqual(a, b);
});

test("deferredToolsSnapshotPath: path contains the fixed prefix/suffix", () => {
  const p = deferredToolsSnapshotPath("whatever");
  assert.ok(p.includes("cache-fix-state"));
  assert.ok(p.includes("deferred-tools-"));
  assert.ok(p.endsWith(".txt"));
});
