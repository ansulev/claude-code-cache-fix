import { test } from "node:test";
import assert from "node:assert/strict";
import { sortSkillsBlock } from "../preload.mjs";

const HEADER = "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n";
const FOOTER = "\n</system-reminder>\n";

function build(entries) {
  return HEADER + entries.join("\n") + FOOTER;
}

test("sortSkillsBlock: sorts entries alphabetically", () => {
  const input = build([
    "- update-config: Use this skill to configure the harness.",
    "- agent-browser: Browser automation.",
    "- keybindings-help: Customize keyboard shortcuts.",
  ]);
  const result = sortSkillsBlock(input);
  const expected = build([
    "- agent-browser: Browser automation.",
    "- keybindings-help: Customize keyboard shortcuts.",
    "- update-config: Use this skill to configure the harness.",
  ]);
  assert.equal(result, expected);
});

test("sortSkillsBlock: idempotent on already-sorted input", () => {
  const sorted = build([
    "- a-skill: First.",
    "- b-skill: Second.",
    "- c-skill: Third.",
  ]);
  assert.equal(sortSkillsBlock(sorted), sorted);
});

test("sortSkillsBlock: handles single entry", () => {
  const input = build(["- only-skill: The only one."]);
  assert.equal(sortSkillsBlock(input), input);
});

test("sortSkillsBlock: returns text unchanged when regex does not match", () => {
  const noMatch = "this is not a skills block";
  assert.equal(sortSkillsBlock(noMatch), noMatch);
});

test("sortSkillsBlock: returns text unchanged when missing closing tag", () => {
  const broken = HEADER + "- skill-a: Description.\n- skill-b: Description.";
  assert.equal(sortSkillsBlock(broken), broken);
});

test("sortSkillsBlock: preserves multi-line skill descriptions", () => {
  const input = build([
    "- z-skill: Line one.\n  Line two of description.\n  Line three.",
    "- a-skill: Single line.",
  ]);
  const result = sortSkillsBlock(input);
  // a-skill should sort before z-skill, multi-line content preserved intact
  assert.ok(result.indexOf("- a-skill") < result.indexOf("- z-skill"));
  assert.ok(result.includes("Line two of description."));
  assert.ok(result.includes("Line three."));
});

test("sortSkillsBlock: stable across calls (sort is deterministic)", () => {
  const input = build([
    "- charlie: Third.",
    "- alpha: First.",
    "- bravo: Second.",
  ]);
  const first = sortSkillsBlock(input);
  const second = sortSkillsBlock(first);
  const third = sortSkillsBlock(second);
  assert.equal(first, second);
  assert.equal(second, third);
});

test("sortSkillsBlock: preserves footer whitespace exactly", () => {
  const input = build(["- a: x.", "- b: y."]);
  const result = sortSkillsBlock(input);
  assert.ok(result.endsWith(FOOTER));
});
