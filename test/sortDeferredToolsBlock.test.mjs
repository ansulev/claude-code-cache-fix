import { test } from "node:test";
import assert from "node:assert/strict";
import { sortDeferredToolsBlock } from "../preload.mjs";

const HEADER = "<system-reminder>\nThe following deferred tools are now available via ToolSearch:\n";
const FOOTER = "\n</system-reminder>\n";

function build(tools) {
  return HEADER + tools.join("\n") + FOOTER;
}

test("sortDeferredToolsBlock: sorts tool names alphabetically", () => {
  const input = build(["WebFetch", "Bash", "Edit", "Read"]);
  const result = sortDeferredToolsBlock(input);
  const expected = build(["Bash", "Edit", "Read", "WebFetch"]);
  assert.equal(result, expected);
});

test("sortDeferredToolsBlock: idempotent on already-sorted input", () => {
  const sorted = build(["a_tool", "b_tool", "c_tool"]);
  assert.equal(sortDeferredToolsBlock(sorted), sorted);
});

test("sortDeferredToolsBlock: handles single tool", () => {
  const input = build(["OnlyTool"]);
  assert.equal(sortDeferredToolsBlock(input), input);
});

test("sortDeferredToolsBlock: trims whitespace from tool names", () => {
  const input = HEADER + "  Bash  \n  Edit  \n  Read  " + FOOTER;
  const result = sortDeferredToolsBlock(input);
  assert.equal(result, build(["Bash", "Edit", "Read"]));
});

test("sortDeferredToolsBlock: filters empty lines from tools list", () => {
  const input = HEADER + "Bash\n\nEdit\n\nRead" + FOOTER;
  const result = sortDeferredToolsBlock(input);
  assert.equal(result, build(["Bash", "Edit", "Read"]));
});

test("sortDeferredToolsBlock: returns text unchanged when regex does not match", () => {
  const noMatch = "this is not a deferred tools block";
  assert.equal(sortDeferredToolsBlock(noMatch), noMatch);
});

test("sortDeferredToolsBlock: handles MCP-prefixed tool names", () => {
  const input = build([
    "mcp__dap__create_issue",
    "mcp__dap__commit_changes",
    "Bash",
    "WebFetch",
  ]);
  const result = sortDeferredToolsBlock(input);
  // Bash sorts before mcp__ (uppercase B < lowercase m in ASCII)
  assert.ok(result.indexOf("Bash") < result.indexOf("mcp__"));
  // mcp__dap__commit_changes sorts before mcp__dap__create_issue
  assert.ok(result.indexOf("mcp__dap__commit_changes") < result.indexOf("mcp__dap__create_issue"));
});

test("sortDeferredToolsBlock: stable across calls", () => {
  const input = build(["zebra", "alpha", "mike"]);
  const first = sortDeferredToolsBlock(input);
  const second = sortDeferredToolsBlock(first);
  assert.equal(first, second);
});
