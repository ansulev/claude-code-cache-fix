// claude-code-cache-fix — Node.js fetch interceptor for Claude Code prompt cache bugs.
//
// Fixes three bugs that cause prompt cache misses in Claude Code, resulting in
// up to 20x cost increase on resumed sessions:
//
// Bug 1: Partial block scatter on resume
//   On --resume, attachment blocks (hooks, skills, deferred-tools, MCP) land in
//   later user messages instead of messages[0]. This breaks the prompt cache
//   prefix match. Fix: relocate them to messages[0] on every API call.
//   (github.com/anthropics/claude-code/issues/34629)
//
// Bug 2: Fingerprint instability
//   The cc_version fingerprint in the attribution header is computed from
//   messages[0] content INCLUDING meta/attachment blocks. When those blocks
//   change between turns, the fingerprint changes, busting cache within the
//   same session. Fix: stabilize the fingerprint from the real user message.
//   (github.com/anthropics/claude-code/issues/40524)
//
// Bug 3: Image carry-forward in conversation history
//   Images read via the Read tool persist as base64 in conversation history
//   and are sent on every subsequent API call. A single 500KB image costs
//   ~62,500 tokens per turn in carry-forward. Fix: strip base64 image blocks
//   from tool_result content older than N user turns.
//   Set CACHE_FIX_IMAGE_KEEP_LAST=N to enable (default: 0 = disabled).
//   (github.com/anthropics/claude-code/issues/40524)
//
// Monitoring:
//   - GrowthBook flag dump on first API call (CACHE_FIX_DEBUG=1)
//   - Microcompact / budget enforcement detection (logs cleared tool results)
//   - False rate limiter detection (model: "<synthetic>")
//   - Quota utilization tracking (writes ~/.claude/quota-status.json)
//   - Prefix snapshot diffing across process restarts (CACHE_FIX_PREFIXDIFF=1)
//
// Based on community fix by @VictorSun92 / @jmarianski (issue #34629),
// enhanced with fingerprint stabilization, image stripping, and monitoring.
// Bug research informed by @ArkNill's claude-code-hidden-problem-analysis.
//
// Load via: NODE_OPTIONS="--import $HOME/.claude/cache-fix-preload.mjs"

import { createHash } from "node:crypto";

// --------------------------------------------------------------------------
// Fingerprint stabilization (Bug 2)
// --------------------------------------------------------------------------

// Must match src/utils/fingerprint.ts exactly.
const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_INDICES = [4, 7, 20];

/**
 * Recompute the 3-char hex fingerprint the same way the source does:
 *   SHA256(SALT + msg[4] + msg[7] + msg[20] + version)[:3]
 * but using the REAL user message text, not the first (possibly meta) message.
 */
function computeFingerprint(messageText, version) {
  const chars = FINGERPRINT_INDICES.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Find the first REAL user message text (not a <system-reminder> meta block).
 * The original bug: extractFirstMessageText() grabs content from messages[0]
 * which may be a synthetic attachment message, not the actual user prompt.
 */
function extractRealUserMessageText(messages) {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) {
      if (typeof content === "string" && !content.startsWith("<system-reminder>")) {
        return content;
      }
      continue;
    }
    // Find first text block that isn't a system-reminder
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && !block.text.startsWith("<system-reminder>")) {
        return block.text;
      }
    }
  }
  return "";
}

/**
 * Extract current cc_version from system prompt blocks and recompute with
 * stable fingerprint. Returns { oldVersion, newVersion, stableFingerprint }.
 */
function stabilizeFingerprint(system, messages) {
  if (!Array.isArray(system)) return null;

  // Find the attribution header block
  const attrIdx = system.findIndex(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.includes("x-anthropic-billing-header:")
  );
  if (attrIdx === -1) return null;

  const attrBlock = system[attrIdx];
  const versionMatch = attrBlock.text.match(/cc_version=([^;]+)/);
  if (!versionMatch) return null;

  const fullVersion = versionMatch[1]; // e.g. "2.1.87.a3f"
  const dotParts = fullVersion.split(".");
  if (dotParts.length < 4) return null;

  const baseVersion = dotParts.slice(0, 3).join("."); // "2.1.87"
  const oldFingerprint = dotParts[3]; // "a3f"

  // Compute stable fingerprint from real user text
  const realText = extractRealUserMessageText(messages);
  const stableFingerprint = computeFingerprint(realText, baseVersion);

  if (stableFingerprint === oldFingerprint) return null; // already correct

  const newVersion = `${baseVersion}.${stableFingerprint}`;
  const newText = attrBlock.text.replace(
    `cc_version=${fullVersion}`,
    `cc_version=${newVersion}`
  );

  return { attrIdx, newText, oldFingerprint, stableFingerprint };
}

// --------------------------------------------------------------------------
// Resume message relocation (Bug 1)
// --------------------------------------------------------------------------

function isSystemReminder(text) {
  return typeof text === "string" && text.startsWith("<system-reminder>");
}
// FIX: Match block headers with startsWith to avoid false positives from
// quoted content (e.g. "Note:" file-change reminders embedding debug logs).
const SR = "<system-reminder>\n";
function isHooksBlock(text) {
  // Hooks block header varies; fall back to head-region check
  return isSystemReminder(text) && text.substring(0, 200).includes("hook success");
}
function isSkillsBlock(text) {
  return typeof text === "string" && text.startsWith(SR + "The following skills are available");
}
function isDeferredToolsBlock(text) {
  return typeof text === "string" && text.startsWith(SR + "The following deferred tools are now available");
}
function isMcpBlock(text) {
  return typeof text === "string" && text.startsWith(SR + "# MCP Server Instructions");
}
function isRelocatableBlock(text) {
  return (
    isHooksBlock(text) ||
    isSkillsBlock(text) ||
    isDeferredToolsBlock(text) ||
    isMcpBlock(text)
  );
}

/**
 * Sort skill listing entries for deterministic ordering (prevents cache bust
 * from non-deterministic iteration order).
 */
function sortSkillsBlock(text) {
  const match = text.match(
    /^([\s\S]*?\n\n)(- [\s\S]+?)(\n<\/system-reminder>\s*)$/
  );
  if (!match) {
    debugLog("SKILLS SORT: regex did NOT match — block passed through unsorted",
      `(length=${text.length}, starts=${JSON.stringify(text.slice(0, 80))})`);
    return text;
  }
  const [, header, entriesText, footer] = match;
  const entries = entriesText.split(/\n(?=- )/);
  const preSort = entries.map(e => (e.match(/^- ([^:]+)/) || [])[1] || "?");
  entries.sort();
  const postSort = entries.map(e => (e.match(/^- ([^:]+)/) || [])[1] || "?");
  const orderChanged = preSort.some((name, i) => name !== postSort[i]);
  debugLog(`SKILLS SORT: ${entries.length} entries, order ${orderChanged ? "CHANGED" : "unchanged"}`,
    `footer=${JSON.stringify(footer)}`);
  return header + entries.join("\n") + footer;
}

/**
 * Sort deferred tools listing for deterministic ordering. The block format is:
 *   <system-reminder>
 *   The following deferred tools are now available via ToolSearch:
 *   ToolName1
 *   ToolName2
 *   ...
 *   </system-reminder>
 *
 * When MCP tools register asynchronously, new tools can appear between API
 * calls, changing the block content and busting cache. Sorting ensures that
 * once a tool appears, its position is deterministic.
 */
function sortDeferredToolsBlock(text) {
  const match = text.match(
    /^(<system-reminder>\nThe following deferred tools are now available[^\n]*\n)([\s\S]+?)(\n<\/system-reminder>\s*)$/
  );
  if (!match) return text;
  const [, header, toolsList, footer] = match;
  const tools = toolsList.split("\n").map(t => t.trim()).filter(Boolean);
  tools.sort();
  return header + tools.join("\n") + footer;
}

// --------------------------------------------------------------------------
// Content pinning for MCP registration jitter (Bug 4)
// --------------------------------------------------------------------------
//
// When MCP tools register asynchronously, the skills and deferred tools blocks
// can change between consecutive API calls as new tools finish registering.
// This causes repeated cache busts even though the final tool set is stable.
//
// Fix: track the content hash of each block type. When content changes, accept
// one cache miss (the new tool needs to be visible), then pin the new content.
// If the SAME content appears on consecutive calls, use the pinned version
// with normalized whitespace to prevent trivial diffs.
//
// Reported by @bilby91 on #44045 (Agent SDK with MCP tools).
// --------------------------------------------------------------------------

const _pinnedBlocks = new Map(); // blockType → { hash, text }

/**
 * Normalize a block's trailing whitespace and pin its content. Returns the
 * normalized text. On first call for a block type, pins the content. On
 * subsequent calls, if the content hash matches the pin, returns the pinned
 * version (byte-identical). If content changed, updates the pin and returns
 * the new content (accepts one cache bust).
 */
function pinBlockContent(blockType, text) {
  // Normalize: trim trailing whitespace inside the </system-reminder> tag
  const normalized = text.replace(/\s+(<\/system-reminder>)\s*$/, "\n$1");

  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const pinned = _pinnedBlocks.get(blockType);

  if (pinned && pinned.hash === hash) {
    // Content matches pin — return pinned version (byte-identical)
    return pinned.text;
  }

  // Content changed or first call — update pin
  if (pinned && pinned.hash !== hash) {
    debugLog(`CONTENT PIN: ${blockType} changed (${pinned.hash} → ${hash}) — accepting one cache bust`);
  }
  _pinnedBlocks.set(blockType, { hash, text: normalized });
  return normalized;
}

/**
 * Strip session_knowledge from hooks blocks — ephemeral content that differs
 * between sessions and would bust cache.
 */
function stripSessionKnowledge(text) {
  return text.replace(
    /\n<session_knowledge[^>]*>[\s\S]*?<\/session_knowledge>/g,
    ""
  );
}

/**
 * Core fix: on EVERY call, scan the entire message array for the LATEST
 * relocatable blocks (skills, MCP, deferred tools, hooks) and ensure they
 * are in messages[0]. This matches fresh session behavior where attachments
 * are always prepended to messages[0] on every API call.
 *
 * The original community fix only checked the last user message, which
 * broke on subsequent turns because:
 *   - Call 1: skills in last msg → relocated to messages[0] (3 blocks)
 *   - Call 2: in-memory state unchanged, skills now in a middle msg,
 *     last msg has no relocatable blocks → messages[0] back to 2 blocks
 *   - Prefix changed → cache bust
 *
 * This version scans backwards to find the latest instance of each
 * relocatable block type, removes them from wherever they are, and
 * prepends them to messages[0]. Idempotent across calls.
 */
function normalizeResumeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  // NOTE: We used to return early here for messages.length < 2 (fresh sessions)
  // because there's nothing to relocate. But this left the first call's blocks
  // in CC's raw, non-deterministic order. On call 2+, sorting/pinning would run
  // and produce DIFFERENT bytes — busting cache on the first resume turn.
  // Fix: always run sort+pin, even on single-message calls, so the first call
  // establishes a deterministic baseline. (@bilby91 #44045)

  let firstUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      firstUserIdx = i;
      break;
    }
  }
  if (firstUserIdx === -1) return messages;

  const firstMsg = messages[firstUserIdx];
  if (!Array.isArray(firstMsg?.content)) return messages;

  // FIX: Check if ANY relocatable blocks are scattered outside first user msg.
  // The old check (firstAlreadyHas → skip) missed partial scatter where some
  // blocks stay in messages[0] but others drift to later messages (v2.1.89+).
  let hasScatteredBlocks = false;
  for (let i = firstUserIdx + 1; i < messages.length && !hasScatteredBlocks; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isRelocatableBlock(block.text || "")) {
        hasScatteredBlocks = true;
        break;
      }
    }
  }

  // Even when blocks aren't scattered, apply sorting and content pinning to
  // blocks in messages[0]. This handles MCP registration jitter where block
  // CONTENT changes between calls (new tool registers) without scattering.
  // (Reported by @bilby91 — Agent SDK with async MCP tools, #44045)
  if (!hasScatteredBlocks) {
    let contentModified = false;
    const newContent = firstMsg.content.map((block) => {
      const text = block.text || "";
      if (!isRelocatableBlock(text)) return block;

      let fixedText = text;
      if (isSkillsBlock(text)) fixedText = sortSkillsBlock(text);
      else if (isDeferredToolsBlock(text)) fixedText = sortDeferredToolsBlock(text);
      else if (isHooksBlock(text)) fixedText = stripSessionKnowledge(text);

      // Determine block type for pinning
      let blockType;
      if (isSkillsBlock(text)) blockType = "skills";
      else if (isDeferredToolsBlock(text)) blockType = "deferred";
      else if (isMcpBlock(text)) blockType = "mcp";
      else if (isHooksBlock(text)) blockType = "hooks";

      if (blockType) fixedText = pinBlockContent(blockType, fixedText);

      if (fixedText !== text) {
        contentModified = true;
        const { cache_control, ...rest } = block;
        return { ...rest, text: fixedText };
      }
      return block;
    });

    if (contentModified) {
      return messages.map((msg, idx) =>
        idx === firstUserIdx ? { ...msg, content: newContent } : msg
      );
    }
    return messages;
  }

  // Scan ALL user messages (including first) in reverse to collect the LATEST
  // version of each block type. This handles both full and partial scatter.
  const found = new Map();

  for (let i = messages.length - 1; i >= firstUserIdx; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      const text = block.text || "";
      if (!isRelocatableBlock(text)) continue;

      // Determine block type for dedup
      let blockType;
      if (isSkillsBlock(text)) blockType = "skills";
      else if (isMcpBlock(text)) blockType = "mcp";
      else if (isDeferredToolsBlock(text)) blockType = "deferred";
      else if (isHooksBlock(text)) blockType = "hooks";
      else continue;

      // Keep only the LATEST (first found scanning backwards)
      if (!found.has(blockType)) {
        let fixedText = text;
        if (blockType === "hooks") fixedText = stripSessionKnowledge(text);
        if (blockType === "skills") fixedText = sortSkillsBlock(text);
        if (blockType === "deferred") fixedText = sortDeferredToolsBlock(text);

        // Pin content to prevent jitter from late MCP tool registration
        fixedText = pinBlockContent(blockType, fixedText);

        const { cache_control, ...rest } = block;
        found.set(blockType, { ...rest, text: fixedText });
      }
    }
  }

  if (found.size === 0) return messages;

  // Remove ALL relocatable blocks from ALL user messages (both first and later)
  const result = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter((b) => !isRelocatableBlock(b.text || ""));
    if (filtered.length === msg.content.length) return msg;
    return { ...msg, content: filtered };
  });

  // FIX: Order must match fresh session layout: deferred → mcp → skills → hooks
  const ORDER = ["deferred", "mcp", "skills", "hooks"];
  const toRelocate = ORDER.filter((t) => found.has(t)).map((t) => found.get(t));

  result[firstUserIdx] = {
    ...result[firstUserIdx],
    content: [...toRelocate, ...result[firstUserIdx].content],
  };

  return result;
}

// --------------------------------------------------------------------------
// Image stripping from old tool results (cost optimization)
// --------------------------------------------------------------------------

// CACHE_FIX_IMAGE_KEEP_LAST=N  — keep images only in the last N user messages.
// Unset or 0 = disabled (all images preserved, backward compatible).
// Images in tool_result blocks older than N user messages from the end are
// replaced with a text placeholder. User-pasted images (direct image blocks
// in user messages, not inside tool_result) are left alone.
const IMAGE_KEEP_LAST = parseInt(process.env.CACHE_FIX_IMAGE_KEEP_LAST || "0", 10);

/**
 * Strip base64 image blocks from tool_result content in older messages.
 * Returns { messages, stats } where stats has stripping metrics.
 */
function stripOldToolResultImages(messages, keepLast) {
  if (!keepLast || keepLast <= 0 || !Array.isArray(messages)) {
    return { messages, stats: null };
  }

  // Find user message indices (turns) so we can count from the end
  const userMsgIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userMsgIndices.push(i);
  }

  if (userMsgIndices.length <= keepLast) {
    return { messages, stats: null }; // not enough turns to strip anything
  }

  // Messages at or after this index are "recent" — keep their images
  const cutoffIdx = userMsgIndices[userMsgIndices.length - keepLast];

  let strippedCount = 0;
  let strippedBytes = 0;

  const result = messages.map((msg, msgIdx) => {
    // Only process user messages before the cutoff (tool_result is in user msgs)
    if (msg.role !== "user" || msgIdx >= cutoffIdx || !Array.isArray(msg.content)) {
      return msg;
    }

    let msgModified = false;
    const newContent = msg.content.map((block) => {
      // Only strip images inside tool_result blocks, not user-pasted images
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        let toolModified = false;
        const newToolContent = block.content.map((item) => {
          if (item.type === "image") {
            strippedCount++;
            if (item.source?.data) {
              strippedBytes += item.source.data.length;
            }
            toolModified = true;
            return {
              type: "text",
              text: "[image stripped from history — file may still be on disk]",
            };
          }
          return item;
        });
        if (toolModified) {
          msgModified = true;
          return { ...block, content: newToolContent };
        }
      }
      return block;
    });

    if (msgModified) {
      return { ...msg, content: newContent };
    }
    return msg;
  });

  const stats = strippedCount > 0
    ? { strippedCount, strippedBytes, estimatedTokens: Math.ceil(strippedBytes * 0.125) }
    : null;

  return { messages: strippedCount > 0 ? result : messages, stats };
}

// --------------------------------------------------------------------------
// Tool schema stabilization (Bug 2 secondary cause)
// --------------------------------------------------------------------------

/**
 * Sort tool definitions by name for deterministic ordering. Tool schema bytes
 * changing mid-session was acknowledged as a bug in the v2.1.88 changelog.
 */
function stabilizeToolOrder(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return [...tools].sort((a, b) => {
    const nameA = a.name || "";
    const nameB = b.name || "";
    return nameA.localeCompare(nameB);
  });
}

// --------------------------------------------------------------------------
// System prompt rewrite (optional)
// --------------------------------------------------------------------------

const OUTPUT_EFFICIENCY_SECTION_HEADER = "# Output efficiency";
const OUTPUT_EFFICIENCY_REPLACEMENT_RAW =
  process.env.CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT || "";
const OUTPUT_EFFICIENCY_SECTION_REPLACEMENT =
  normalizeOutputEfficiencyReplacement(OUTPUT_EFFICIENCY_REPLACEMENT_RAW);

function normalizeOutputEfficiencyReplacement(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "";
  return trimmed.startsWith(OUTPUT_EFFICIENCY_SECTION_HEADER)
    ? trimmed
    : `${OUTPUT_EFFICIENCY_SECTION_HEADER}\n\n${trimmed}`;
}

/**
 * Replace Claude Code's entire output-efficiency section in-place while
 * preserving the existing system block structure and cache_control fields.
 */
function rewriteOutputEfficiencyInstruction(system) {
  if (!Array.isArray(system) || !OUTPUT_EFFICIENCY_SECTION_REPLACEMENT) {
    return null;
  }

  let changed = false;
  const rewritten = system.map((block) => {
    if (
      block?.type !== "text" ||
      typeof block.text !== "string" ||
      !block.text.includes(OUTPUT_EFFICIENCY_SECTION_HEADER)
    ) {
      return block;
    }

    const nextText = replaceOutputEfficiencySection(block.text);
    if (!nextText || nextText === block.text) {
      return block;
    }

    changed = true;
    return { ...block, text: nextText };
  });

  return changed ? rewritten : null;
}

function replaceOutputEfficiencySection(text) {
  const start = text.indexOf(OUTPUT_EFFICIENCY_SECTION_HEADER);
  if (start === -1) return null;

  const afterHeader = start + OUTPUT_EFFICIENCY_SECTION_HEADER.length;
  const remainder = text.slice(afterHeader);
  const nextHeadingMatch = remainder.match(/\n# [^\n]+/);

  if (!nextHeadingMatch || nextHeadingMatch.index == null) {
    return text.slice(0, start) + OUTPUT_EFFICIENCY_SECTION_REPLACEMENT;
  }

  const nextHeadingStart = afterHeader + nextHeadingMatch.index + 1;
  return (
    text.slice(0, start) +
    OUTPUT_EFFICIENCY_SECTION_REPLACEMENT +
    "\n\n" +
    text.slice(nextHeadingStart)
  );
}

// --------------------------------------------------------------------------
// Fetch interceptor
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Debug logging (writes to ~/.claude/cache-fix-debug.log)
// Set CACHE_FIX_DEBUG=1 to enable
// --------------------------------------------------------------------------

import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEBUG = process.env.CACHE_FIX_DEBUG === "1";
const PREFIXDIFF = process.env.CACHE_FIX_PREFIXDIFF === "1";
const NORMALIZE_IDENTITY = process.env.CACHE_FIX_NORMALIZE_IDENTITY === "1";
const LOG_PATH = join(homedir(), ".claude", "cache-fix-debug.log");
const SNAPSHOT_DIR = join(homedir(), ".claude", "cache-fix-snapshots");
const USAGE_JSONL = process.env.CACHE_FIX_USAGE_LOG || join(homedir(), ".claude", "usage.jsonl");

function debugLog(...args) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
}

// --------------------------------------------------------------------------
// Prefix snapshot — captures message prefix for cross-process diff.
// Set CACHE_FIX_PREFIXDIFF=1 to enable.
//
// On each API call: saves JSON of first 5 messages + system + tools hash
// to ~/.claude/cache-fix-snapshots/<session-hash>-last.json
//
// On first call after startup: compares against saved snapshot and writes
// a diff report to ~/.claude/cache-fix-snapshots/<session-hash>-diff.json
// --------------------------------------------------------------------------

let _prefixDiffFirstCall = true;

// --------------------------------------------------------------------------
// GrowthBook flag dump (runs once on first API call)
// --------------------------------------------------------------------------

let _growthBookDumped = false;

function dumpGrowthBookFlags() {
  if (_growthBookDumped || !DEBUG) return;
  _growthBookDumped = true;
  try {
    const claudeJson = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const features = claudeJson.cachedGrowthBookFeatures;
    if (!features) { debugLog("GROWTHBOOK: no cachedGrowthBookFeatures found"); return; }

    // Log the flags that matter for cost/cache/context behavior
    const interesting = {
      hawthorn_window: features.tengu_hawthorn_window,
      pewter_kestrel: features.tengu_pewter_kestrel,
      summarize_tool_results: features.tengu_summarize_tool_results,
      slate_heron: features.tengu_slate_heron,
      session_memory: features.tengu_session_memory,
      sm_compact: features.tengu_sm_compact,
      sm_compact_config: features.tengu_sm_compact_config,
      sm_config: features.tengu_sm_config,
      cache_plum_violet: features.tengu_cache_plum_violet,
      prompt_cache_1h_config: features.tengu_prompt_cache_1h_config,
      crystal_beam: features.tengu_crystal_beam,
      cold_compact: features.tengu_cold_compact,
      system_prompt_global_cache: features.tengu_system_prompt_global_cache,
      compact_cache_prefix: features.tengu_compact_cache_prefix,
      onyx_plover: features.tengu_onyx_plover,
    };
    debugLog("GROWTHBOOK FLAGS:", JSON.stringify(interesting, null, 2));
  } catch (e) {
    debugLog("GROWTHBOOK: failed to read ~/.claude.json:", e?.message);
  }
}

// --------------------------------------------------------------------------
// Microcompact / budget monitoring
// --------------------------------------------------------------------------

/**
 * Scan outgoing messages for signs of microcompact clearing and budget
 * enforcement. Counts tool results that have been gutted and reports stats.
 */
function monitorContextDegradation(messages) {
  if (!Array.isArray(messages)) return null;

  let clearedToolResults = 0;
  let totalToolResultChars = 0;
  let totalToolResults = 0;

  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        totalToolResults++;
        const content = block.content;
        if (typeof content === "string") {
          if (content === "[Old tool result content cleared]") {
            clearedToolResults++;
          } else {
            totalToolResultChars += content.length;
          }
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "text") {
              if (item.text === "[Old tool result content cleared]") {
                clearedToolResults++;
              } else {
                totalToolResultChars += item.text.length;
              }
            }
          }
        }
      }
    }
  }

  if (totalToolResults === 0) return null;

  const stats = { totalToolResults, clearedToolResults, totalToolResultChars };

  if (clearedToolResults > 0) {
    debugLog(`MICROCOMPACT: ${clearedToolResults}/${totalToolResults} tool results cleared`);
  }

  // Warn when approaching the 200K budget threshold
  if (totalToolResultChars > 150000) {
    debugLog(`BUDGET WARNING: tool result chars at ${totalToolResultChars.toLocaleString()} / 200,000 threshold`);
  }

  return stats;
}

function snapshotPrefix(payload) {
  if (!PREFIXDIFF) return;
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });

    // Session key: use system prompt hash — stable across restarts for the same project.
    // Different projects get different snapshots, same project matches across resume.
    const sessionKey = payload.system
      ? createHash("sha256").update(JSON.stringify(payload.system).slice(0, 2000)).digest("hex").slice(0, 12)
      : "default";

    const snapshotFile = join(SNAPSHOT_DIR, `${sessionKey}-last.json`);
    const diffFile = join(SNAPSHOT_DIR, `${sessionKey}-diff.json`);

    // Build prefix snapshot: first 5 messages, stripped of cache_control
    const prefixMsgs = (payload.messages || []).slice(0, 5).map(msg => {
      const content = Array.isArray(msg.content)
        ? msg.content.map(b => {
            const { cache_control, ...rest } = b;
            // Truncate long text blocks for diffing
            if (rest.text && rest.text.length > 500) {
              rest.text = rest.text.slice(0, 500) + `...[${rest.text.length} chars]`;
            }
            return rest;
          })
        : msg.content;
      return { role: msg.role, content };
    });

    const toolsHash = payload.tools
      ? createHash("sha256").update(JSON.stringify(payload.tools.map(t => t.name))).digest("hex").slice(0, 16)
      : "none";

    const systemHash = payload.system
      ? createHash("sha256").update(JSON.stringify(payload.system)).digest("hex").slice(0, 16)
      : "none";

    const snapshot = {
      timestamp: new Date().toISOString(),
      messageCount: payload.messages?.length || 0,
      toolsHash,
      systemHash,
      prefixMessages: prefixMsgs,
    };

    // On first call: compare against saved
    if (_prefixDiffFirstCall) {
      _prefixDiffFirstCall = false;
      try {
        const prev = JSON.parse(readFileSync(snapshotFile, "utf8"));
        const diff = {
          timestamp: snapshot.timestamp,
          prevTimestamp: prev.timestamp,
          toolsMatch: prev.toolsHash === snapshot.toolsHash,
          systemMatch: prev.systemHash === snapshot.systemHash,
          messageCountPrev: prev.messageCount,
          messageCountNow: snapshot.messageCount,
          prefixDiffs: [],
        };

        const maxIdx = Math.max(prev.prefixMessages.length, snapshot.prefixMessages.length);
        for (let i = 0; i < maxIdx; i++) {
          const prevMsg = JSON.stringify(prev.prefixMessages[i] || null);
          const nowMsg = JSON.stringify(snapshot.prefixMessages[i] || null);
          if (prevMsg !== nowMsg) {
            diff.prefixDiffs.push({
              index: i,
              prev: prev.prefixMessages[i] || null,
              now: snapshot.prefixMessages[i] || null,
            });
          }
        }

        writeFileSync(diffFile, JSON.stringify(diff, null, 2));
        debugLog(`PREFIX DIFF: ${diff.prefixDiffs.length} differences in first 5 messages. tools=${diff.toolsMatch ? "match" : "DIFFER"} system=${diff.systemMatch ? "match" : "DIFFER"}`);
      } catch {
        // No previous snapshot — first run
      }
    }

    // Save current snapshot
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    debugLog("PREFIX SNAPSHOT ERROR:", e?.message);
  }
}

// --------------------------------------------------------------------------
// Fetch interceptor
// --------------------------------------------------------------------------

const _origFetch = globalThis.fetch;

globalThis.fetch = async function (url, options) {
  const urlStr = typeof url === "string" ? url : url?.url || String(url);

  const isMessagesEndpoint =
    urlStr.includes("/v1/messages") &&
    !urlStr.includes("batches") &&
    !urlStr.includes("count_tokens");

  if (isMessagesEndpoint && options?.body && typeof options.body === "string") {
    try {
      const payload = JSON.parse(options.body);
      let modified = false;

      // One-time GrowthBook flag dump on first API call
      dumpGrowthBookFlags();

      debugLog("--- API call to", urlStr);
      debugLog("message count:", payload.messages?.length);

      // Detect synthetic model (false rate limiter, B3)
      if (payload.model === "<synthetic>") {
        debugLog("FALSE RATE LIMIT: synthetic model detected — client-side rate limit, no real API call");
      }

      // Bug 1: Relocate resume attachment blocks
      if (payload.messages) {
        // Log message structure for debugging
        if (DEBUG) {
          let firstUserIdx = -1, lastUserIdx = -1;
          for (let i = 0; i < payload.messages.length; i++) {
            if (payload.messages[i].role === "user") {
              if (firstUserIdx === -1) firstUserIdx = i;
              lastUserIdx = i;
            }
          }
          if (firstUserIdx !== -1) {
            const firstContent = payload.messages[firstUserIdx].content;
            const lastContent = payload.messages[lastUserIdx].content;
            debugLog("firstUserIdx:", firstUserIdx, "lastUserIdx:", lastUserIdx);
            debugLog("first user msg blocks:", Array.isArray(firstContent) ? firstContent.length : "string");
            if (Array.isArray(firstContent)) {
              for (const b of firstContent) {
                const t = (b.text || "").substring(0, 80);
                debugLog("  first[block]:", isRelocatableBlock(b.text) ? "RELOCATABLE" : "keep", JSON.stringify(t));
              }
            }
            if (firstUserIdx !== lastUserIdx) {
              debugLog("last user msg blocks:", Array.isArray(lastContent) ? lastContent.length : "string");
              if (Array.isArray(lastContent)) {
                for (const b of lastContent) {
                  const t = (b.text || "").substring(0, 80);
                  debugLog("  last[block]:", isRelocatableBlock(b.text) ? "RELOCATABLE" : "keep", JSON.stringify(t));
                }
              }
            } else {
              debugLog("single user message (fresh session)");
            }
          }
        }

        const normalized = normalizeResumeMessages(payload.messages);
        if (normalized !== payload.messages) {
          payload.messages = normalized;
          modified = true;
          debugLog("APPLIED: resume message relocation");
        } else {
          debugLog("SKIPPED: resume relocation (not a resume or already correct)");
        }
      }

      // Image stripping: remove old tool_result images to reduce token waste
      if (payload.messages && IMAGE_KEEP_LAST > 0) {
        const { messages: imgStripped, stats: imgStats } = stripOldToolResultImages(
          payload.messages, IMAGE_KEEP_LAST
        );
        if (imgStats) {
          payload.messages = imgStripped;
          modified = true;
          debugLog(
            `APPLIED: stripped ${imgStats.strippedCount} images from old tool results`,
            `(~${imgStats.strippedBytes} base64 bytes, ~${imgStats.estimatedTokens} tokens saved)`
          );
        } else if (IMAGE_KEEP_LAST > 0) {
          debugLog("SKIPPED: image stripping (no old images found or not enough turns)");
        }
      }

      // Bug 2a: Stabilize tool ordering
      if (payload.tools) {
        const sorted = stabilizeToolOrder(payload.tools);
        const changed = sorted.some(
          (t, i) => t.name !== payload.tools[i]?.name
        );
        if (changed) {
          payload.tools = sorted;
          modified = true;
          debugLog("APPLIED: tool order stabilization");
        }
      }

      // Bug 2b: Stabilize fingerprint in attribution header
      if (payload.system && payload.messages) {
        const fix = stabilizeFingerprint(payload.system, payload.messages);
        if (fix) {
          payload.system = [...payload.system];
          payload.system[fix.attrIdx] = {
            ...payload.system[fix.attrIdx],
            text: fix.newText,
          };
          modified = true;
          debugLog("APPLIED: fingerprint stabilized from", fix.oldFingerprint, "to", fix.stableFingerprint);
        }
      }

      // Bug 6: Identity string normalization for Agent()/SendMessage() cache parity
      // The CC orchestrator emits a different identity string in system[1] depending
      // on whether the call originated from Agent() vs SendMessage() (subagent resume):
      //   Agent():       "You are Claude Code, Anthropic's official CLI for Claude."
      //   SendMessage(): "You are a Claude agent, built on Anthropic's Claude Agent SDK."
      // Both blocks carry cache_control: ephemeral. The ~50-char identity swap is enough
      // to invalidate the entire cache prefix, producing cache_read=0 on first SendMessage
      // turn even though system[2] (the actual instructions) is byte-identical.
      // Confirmed by @labzink via mitmproxy on #44724.
      // Opt-in because it's a model-perceivable behavior change (subagent thinks it's CC).
      if (NORMALIZE_IDENTITY && payload.system && Array.isArray(payload.system)) {
        const CANONICAL = "You are Claude Code, Anthropic's official CLI for Claude.";
        const AGENT_SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
        let normalized = 0;
        payload.system = payload.system.map((block) => {
          if (
            block?.type === "text" &&
            typeof block.text === "string" &&
            block.text.startsWith(AGENT_SDK)
          ) {
            normalized++;
            return { ...block, text: CANONICAL + block.text.slice(AGENT_SDK.length) };
          }
          return block;
        });
        if (normalized > 0) {
          modified = true;
          debugLog(`APPLIED: identity normalized on ${normalized} system block(s) (Agent SDK → Claude Code)`);
        }
      }

      // Optional: rewrite Claude Code's default output-efficiency section
      if (payload.system && OUTPUT_EFFICIENCY_SECTION_REPLACEMENT) {
        const rewritten = rewriteOutputEfficiencyInstruction(payload.system);
        if (rewritten) {
          payload.system = rewritten;
          modified = true;
          debugLog("APPLIED: output efficiency section rewritten");
        } else {
          debugLog("SKIPPED: output efficiency rewrite (section not found)");
        }
      }

      // Bug 5: 1h TTL enforcement
      // The client gates 1h cache TTL behind a GrowthBook allowlist that checks
      // querySource against patterns like "repl_main_thread*", "sdk", "auto_mode".
      // Interactive CLI sessions may not match any pattern, causing the client to
      // send cache_control without ttl (defaulting to 5m server-side).
      // The server honors whatever TTL the client requests — so we inject it.
      // Discovered by @TigerKay1926 on #42052 using our GrowthBook flag dump.
      if (payload.system) {
        let ttlInjected = 0;
        payload.system = payload.system.map((block) => {
          if (block.cache_control?.type === "ephemeral" && !block.cache_control.ttl) {
            ttlInjected++;
            return { ...block, cache_control: { ...block.cache_control, ttl: "1h" } };
          }
          return block;
        });
        // Also check messages for cache_control blocks (conversation history breakpoints)
        if (payload.messages) {
          for (const msg of payload.messages) {
            if (!Array.isArray(msg.content)) continue;
            for (let i = 0; i < msg.content.length; i++) {
              const b = msg.content[i];
              if (b.cache_control?.type === "ephemeral" && !b.cache_control.ttl) {
                msg.content[i] = { ...b, cache_control: { ...b.cache_control, ttl: "1h" } };
                ttlInjected++;
              }
            }
          }
        }
        if (ttlInjected > 0) {
          modified = true;
          debugLog(`APPLIED: 1h TTL injected on ${ttlInjected} cache_control block(s)`);
        }
      }

      if (modified) {
        options = { ...options, body: JSON.stringify(payload) };
        debugLog("Request body rewritten");
      }

      // Monitor for microcompact / budget enforcement degradation
      if (payload.messages) {
        monitorContextDegradation(payload.messages);
      }

      // Diagnostic: dump full tools array (names, descriptions, schemas, sizes) to a file
      // when CACHE_FIX_DUMP_TOOLS=<path> is set. Useful for per-version tool-schema drift
      // analysis and for understanding which tools contribute prefix bloat. First used
      // during the 2026-04-11 cross-version regression investigation.
      if (process.env.CACHE_FIX_DUMP_TOOLS && payload.tools) {
        try {
          const dumpPath = process.env.CACHE_FIX_DUMP_TOOLS;
          const dump = {
            timestamp: new Date().toISOString(),
            tool_count: payload.tools.length,
            tools: payload.tools.map(t => ({
              name: t.name,
              description: t.description || "",
              desc_chars: (t.description || "").length,
              schema_chars: JSON.stringify(t.input_schema || {}).length,
              total_chars: JSON.stringify(t).length,
            })),
            system_chars: JSON.stringify(payload.system || "").length,
            total_tools_chars: JSON.stringify(payload.tools).length,
          };
          writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
        } catch (e) { debugLog("DUMP ERROR:", e?.message); }
      }

      // Prompt size measurement — log system prompt, tools, and injected block sizes
      if (DEBUG && payload.system && payload.tools && payload.messages) {
        const sysChars = JSON.stringify(payload.system).length;
        const toolsChars = JSON.stringify(payload.tools).length;
        const firstUserIdx = payload.messages.findIndex(m => m.role === "user");
        if (firstUserIdx !== -1) {
          const msg0 = payload.messages[firstUserIdx];
          if (Array.isArray(msg0.content)) {
            let skillsChars = 0;
            let mcpChars = 0;
            let deferredChars = 0;
            let hooksChars = 0;
            for (const block of msg0.content) {
              const text = block.text || "";
              if (isSkillsBlock(text)) skillsChars += text.length;
              else if (isMcpBlock(text)) mcpChars += text.length;
              else if (isDeferredToolsBlock(text)) deferredChars += text.length;
              else if (isHooksBlock(text)) hooksChars += text.length;
            }
            const injectedTotal = skillsChars + mcpChars + deferredChars + hooksChars;
            if (injectedTotal > 0) {
              debugLog(
                `PROMPT SIZE: system=${sysChars} tools=${toolsChars}`,
                `injected=${injectedTotal} (skills=${skillsChars} mcp=${mcpChars}`,
                `deferred=${deferredChars} hooks=${hooksChars})`
              );
            }
          }
        }
      }

      // Capture prefix snapshot for cross-process diff analysis
      snapshotPrefix(payload);

    } catch (e) {
      debugLog("ERROR in interceptor:", e?.message);
      // Parse failure — pass through unmodified
    }
  }

  const response = await _origFetch.apply(this, [url, options]);

  // Extract quota utilization from response headers and save for hooks/MCP
  if (isMessagesEndpoint) {
    try {
      const h5 = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
      const h7d = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
      const reset5h = response.headers.get("anthropic-ratelimit-unified-5h-reset");
      const reset7d = response.headers.get("anthropic-ratelimit-unified-7d-reset");
      const status = response.headers.get("anthropic-ratelimit-unified-status");
      const overage = response.headers.get("anthropic-ratelimit-unified-overage-status");

      if (h5 || h7d) {
        const quotaFile = join(homedir(), ".claude", "quota-status.json");
        let quota = {};
        try { quota = JSON.parse(readFileSync(quotaFile, "utf8")); } catch {}
        quota.timestamp = new Date().toISOString();
        quota.five_hour = h5 ? { utilization: parseFloat(h5), pct: Math.round(parseFloat(h5) * 100), resets_at: reset5h ? parseInt(reset5h) : null } : quota.five_hour;
        quota.seven_day = h7d ? { utilization: parseFloat(h7d), pct: Math.round(parseFloat(h7d) * 100), resets_at: reset7d ? parseInt(reset7d) : null } : quota.seven_day;
        quota.status = status || null;
        quota.overage_status = overage || null;

        // Peak hour detection — Anthropic applies higher quota drain rate during
        // weekday peak hours: 13:00–19:00 UTC (Mon–Fri).
        // Source: Thariq (Anthropic) via X, 2026-03-26; confirmed by The Register,
        // PCWorld, Piunikaweb. No specific multiplier disclosed.
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat
        const isPeak = utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 19;
        quota.peak_hour = isPeak;

        writeFileSync(quotaFile, JSON.stringify(quota, null, 2));

        if (DEBUG && isPeak) {
          debugLog("PEAK HOUR: weekday 13:00-19:00 UTC — quota drains at elevated rate");
        }
      }
    } catch {
      // Non-critical — don't break the response
    }

    // Clone response to extract TTL tier and usage telemetry from SSE stream.
    // Pass the model and quota headers so we can log a complete usage record.
    try {
      let reqModel = "unknown";
      try { reqModel = JSON.parse(options?.body)?.model || "unknown"; } catch {}
      const quotaHeaders = {
        q5h: parseFloat(response.headers.get("anthropic-ratelimit-unified-5h-utilization") || "0"),
        q7d: parseFloat(response.headers.get("anthropic-ratelimit-unified-7d-utilization") || "0"),
        status: response.headers.get("anthropic-ratelimit-unified-status") || null,
        overage: response.headers.get("anthropic-ratelimit-unified-overage-status") || null,
      };
      const clone = response.clone();
      drainTTLFromClone(clone, reqModel, quotaHeaders).catch(() => {});
    } catch {
      // clone() failure is non-fatal
    }
  }

  return response;
};

// --------------------------------------------------------------------------
// TTL tier extraction from SSE response stream
// --------------------------------------------------------------------------

/**
 * Drain a cloned SSE response to extract cache TTL tier from the usage object.
 * The message_start event contains usage.cache_creation with ephemeral_1h and
 * ephemeral_5m token counts, revealing which TTL tier the server applied.
 *
 * Writes TTL tier to ~/.claude/quota-status.json (merges with existing data)
 * and logs to debug log.
 */
async function drainTTLFromClone(clone, model, quotaHeaders) {
  if (!clone.body) return;

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulate usage across message_start (input/cache) and message_delta (output)
  let startUsage = null;
  let deltaUsage = null;
  let ttlTier = "unknown";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;

        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === "message_start" && event.message?.usage) {
            const u = event.message.usage;
            startUsage = u;
            const cc = u.cache_creation || {};
            const e1h = cc.ephemeral_1h_input_tokens ?? 0;
            const e5m = cc.ephemeral_5m_input_tokens ?? 0;
            const cacheCreate = u.cache_creation_input_tokens ?? 0;
            const cacheRead = u.cache_read_input_tokens ?? 0;

            // Determine TTL tier from which ephemeral bucket got tokens
            if (e1h > 0 && e5m === 0) ttlTier = "1h";
            else if (e5m > 0 && e1h === 0) ttlTier = "5m";
            else if (e1h === 0 && e5m === 0 && cacheCreate === 0) {
              // Fully cached — no creation to determine tier. Preserve previous.
              try {
                const prev = JSON.parse(readFileSync(join(homedir(), ".claude", "quota-status.json"), "utf8"));
                ttlTier = prev.cache?.ttl_tier || "1h";
              } catch { ttlTier = "1h"; }
            }
            else if (e1h > 0 && e5m > 0) ttlTier = "mixed";

            const hitRate = (cacheRead + cacheCreate) > 0
              ? (cacheRead / (cacheRead + cacheCreate) * 100).toFixed(1)
              : "N/A";

            debugLog(
              `CACHE TTL: tier=${ttlTier}`,
              `create=${cacheCreate} read=${cacheRead} hit=${hitRate}%`,
              `(1h=${e1h} 5m=${e5m})`
            );

            // Merge TTL data into quota-status.json
            try {
              const quotaFile = join(homedir(), ".claude", "quota-status.json");
              let quota = {};
              try { quota = JSON.parse(readFileSync(quotaFile, "utf8")); } catch {}
              quota.cache = {
                ttl_tier: ttlTier,
                cache_creation: cacheCreate,
                cache_read: cacheRead,
                ephemeral_1h: e1h,
                ephemeral_5m: e5m,
                hit_rate: hitRate,
                timestamp: new Date().toISOString(),
              };
              writeFileSync(quotaFile, JSON.stringify(quota, null, 2));
            } catch {}
          }

          // Capture final usage from message_delta (has output_tokens)
          if (event.type === "message_delta" && event.usage) {
            deltaUsage = event.usage;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // Write usage record to JSONL after stream completes
  if (startUsage) {
    try {
      const cc = startUsage.cache_creation || {};
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcDay = now.getUTCDay();
      const record = {
        timestamp: now.toISOString(),
        model: model || "unknown",
        input_tokens: startUsage.input_tokens ?? 0,
        output_tokens: deltaUsage?.output_tokens ?? 0,
        cache_read_input_tokens: startUsage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: startUsage.cache_creation_input_tokens ?? 0,
        ephemeral_1h_input_tokens: cc.ephemeral_1h_input_tokens ?? 0,
        ephemeral_5m_input_tokens: cc.ephemeral_5m_input_tokens ?? 0,
        ttl_tier: ttlTier,
        q5h_pct: quotaHeaders ? Math.round(quotaHeaders.q5h * 100) : null,
        q7d_pct: quotaHeaders ? Math.round(quotaHeaders.q7d * 100) : null,
        peak_hour: utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 19,
      };
      appendFileSync(USAGE_JSONL, JSON.stringify(record) + "\n");
    } catch {
      // Non-critical — don't break anything
    }
  }
}

// --------------------------------------------------------------------------
// Test exports
// --------------------------------------------------------------------------
//
// These exports exist for unit testing the pure functions in this file. They
// have no effect on the interceptor's runtime behavior — production callers
// load this module via NODE_OPTIONS=--import and never use named imports.
// Tests import from this file directly: `import { sortSkillsBlock } from
// '../preload.mjs'`. The fetch patching above runs at import time but is
// harmless in a test process since tests do not make fetch calls.

export {
  sortSkillsBlock,
  sortDeferredToolsBlock,
  pinBlockContent,
  stripSessionKnowledge,
  stabilizeFingerprint,
  computeFingerprint,
  isSkillsBlock,
  isDeferredToolsBlock,
  isHooksBlock,
  isMcpBlock,
  isRelocatableBlock,
  rewriteOutputEfficiencyInstruction,
  normalizeOutputEfficiencyReplacement,
  _pinnedBlocks,  // exported so tests can reset between runs
};
