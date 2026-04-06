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
//   (github.com/anthropics/claude-code/issues/43657)
//   (github.com/anthropics/claude-code/issues/44045)
//
// Bug 2: Fingerprint instability
//   The cc_version fingerprint in the attribution header is computed from
//   messages[0] content INCLUDING meta/attachment blocks. When those blocks
//   change between turns, the fingerprint changes -> system prompt bytes
//   change -> cache bust. Fix: recompute fingerprint from real user text.
//   (github.com/anthropics/claude-code/issues/40524)
//
// Bug 3: Non-deterministic tool schema ordering
//   Tool definitions can arrive in different orders between turns, changing
//   request bytes and busting cache. Fix: sort tools alphabetically by name.
//
// Based on community work by @VictorSun92 (original monkey-patch + partial
// scatter fixes) and @jmarianski (MITM proxy root cause analysis).
//
// Usage: NODE_OPTIONS="--import claude-code-cache-fix" claude

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Debug logging (writes to ~/.claude/cache-fix-debug.log)
// Set CACHE_FIX_DEBUG=1 to enable
// ---------------------------------------------------------------------------

const DEBUG = process.env.CACHE_FIX_DEBUG === "1";
const LOG_PATH = join(homedir(), ".claude", "cache-fix-debug.log");

function debugLog(...args) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {}
}

// ---------------------------------------------------------------------------
// Fingerprint stabilization (Bug 2)
// ---------------------------------------------------------------------------

// Must match Claude Code src/utils/fingerprint.ts exactly.
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
      if (
        typeof content === "string" &&
        !content.startsWith("<system-reminder>")
      ) {
        return content;
      }
      continue;
    }
    for (const block of content) {
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        !block.text.startsWith("<system-reminder>")
      ) {
        return block.text;
      }
    }
  }
  return "";
}

/**
 * Extract current cc_version from system prompt blocks and recompute with
 * stable fingerprint. Returns { attrIdx, newText, oldFingerprint, stableFingerprint }
 * or null if no fix needed.
 */
function stabilizeFingerprint(system, messages) {
  if (!Array.isArray(system)) return null;

  const attrIdx = system.findIndex(
    (b) =>
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.includes("x-anthropic-billing-header:")
  );
  if (attrIdx === -1) return null;

  const attrBlock = system[attrIdx];
  const versionMatch = attrBlock.text.match(/cc_version=([^;]+)/);
  if (!versionMatch) return null;

  const fullVersion = versionMatch[1]; // e.g. "2.1.92.a3f"
  const dotParts = fullVersion.split(".");
  if (dotParts.length < 4) return null;

  const baseVersion = dotParts.slice(0, 3).join("."); // "2.1.92"
  const oldFingerprint = dotParts[3]; // "a3f"

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

// ---------------------------------------------------------------------------
// Resume message relocation (Bug 1)
// ---------------------------------------------------------------------------

function isSystemReminder(text) {
  return typeof text === "string" && text.startsWith("<system-reminder>");
}

const SR = "<system-reminder>\n";

function isHooksBlock(text) {
  return (
    isSystemReminder(text) && text.substring(0, 200).includes("hook success")
  );
}
function isSkillsBlock(text) {
  return (
    typeof text === "string" &&
    text.startsWith(SR + "The following skills are available")
  );
}
function isDeferredToolsBlock(text) {
  return (
    typeof text === "string" &&
    text.startsWith(SR + "The following deferred tools are now available")
  );
}
function isMcpBlock(text) {
  return (
    typeof text === "string" &&
    text.startsWith(SR + "# MCP Server Instructions")
  );
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
  if (!match) return text;
  const [, header, entriesText, footer] = match;
  const entries = entriesText.split(/\n(?=- )/);
  entries.sort();
  return header + entries.join("\n") + footer;
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
 * Core fix: on EVERY API call, scan the entire message array for the LATEST
 * relocatable blocks (skills, MCP, deferred tools, hooks) and ensure they
 * are in messages[0]. This matches fresh session behavior where attachments
 * are always prepended to messages[0].
 *
 * The v2.1.90 native fix has a remaining detection gap: it bails early if
 * it sees *some* relocatable blocks in messages[0], missing the case where
 * others have scattered elsewhere (partial scatter).
 *
 * This version scans backwards to find the latest instance of each
 * relocatable block type, removes them from wherever they are, and
 * prepends them to messages[0] in fresh-session order. Idempotent.
 */
function normalizeResumeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;

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

  // Check if ANY relocatable blocks are scattered outside first user msg.
  let hasScatteredBlocks = false;
  for (
    let i = firstUserIdx + 1;
    i < messages.length && !hasScatteredBlocks;
    i++
  ) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isRelocatableBlock(block.text || "")) {
        hasScatteredBlocks = true;
        break;
      }
    }
  }
  if (!hasScatteredBlocks) return messages;

  // Scan ALL user messages in reverse to collect the LATEST version of each
  // block type. This handles both full and partial scatter.
  const found = new Map();

  for (let i = messages.length - 1; i >= firstUserIdx; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      const text = block.text || "";
      if (!isRelocatableBlock(text)) continue;

      let blockType;
      if (isSkillsBlock(text)) blockType = "skills";
      else if (isMcpBlock(text)) blockType = "mcp";
      else if (isDeferredToolsBlock(text)) blockType = "deferred";
      else if (isHooksBlock(text)) blockType = "hooks";
      else continue;

      if (!found.has(blockType)) {
        let fixedText = text;
        if (blockType === "hooks") fixedText = stripSessionKnowledge(text);
        if (blockType === "skills") fixedText = sortSkillsBlock(text);

        const { cache_control, ...rest } = block;
        found.set(blockType, { ...rest, text: fixedText });
      }
    }
  }

  if (found.size === 0) return messages;

  // Remove ALL relocatable blocks from ALL user messages
  const result = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter(
      (b) => !isRelocatableBlock(b.text || "")
    );
    if (filtered.length === msg.content.length) return msg;
    return { ...msg, content: filtered };
  });

  // Order must match fresh session layout: deferred -> mcp -> skills -> hooks
  const ORDER = ["deferred", "mcp", "skills", "hooks"];
  const toRelocate = ORDER.filter((t) => found.has(t)).map((t) => found.get(t));

  result[firstUserIdx] = {
    ...result[firstUserIdx],
    content: [...toRelocate, ...result[firstUserIdx].content],
  };

  return result;
}

// ---------------------------------------------------------------------------
// Tool schema stabilization (Bug 3)
// ---------------------------------------------------------------------------

/**
 * Sort tool definitions by name for deterministic ordering.
 */
function stabilizeToolOrder(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return [...tools].sort((a, b) => {
    const nameA = a.name || "";
    const nameB = b.name || "";
    return nameA.localeCompare(nameB);
  });
}

// ---------------------------------------------------------------------------
// Fetch interceptor
// ---------------------------------------------------------------------------

const _origFetch = globalThis.fetch;

globalThis.fetch = async function (url, options) {
  const urlStr = typeof url === "string" ? url : url?.url || String(url);

  const isMessagesEndpoint =
    urlStr.includes("/v1/messages") &&
    !urlStr.includes("batches") &&
    !urlStr.includes("count_tokens");

  if (
    isMessagesEndpoint &&
    options?.body &&
    typeof options.body === "string"
  ) {
    try {
      const payload = JSON.parse(options.body);
      let modified = false;

      debugLog("--- API call to", urlStr);
      debugLog("message count:", payload.messages?.length);

      // Bug 1: Relocate scattered attachment blocks
      if (payload.messages) {
        if (DEBUG) {
          let firstUserIdx = -1;
          let lastUserIdx = -1;
          for (let i = 0; i < payload.messages.length; i++) {
            if (payload.messages[i].role === "user") {
              if (firstUserIdx === -1) firstUserIdx = i;
              lastUserIdx = i;
            }
          }
          if (firstUserIdx !== -1) {
            const firstContent = payload.messages[firstUserIdx].content;
            const lastContent = payload.messages[lastUserIdx].content;
            debugLog(
              "firstUserIdx:",
              firstUserIdx,
              "lastUserIdx:",
              lastUserIdx
            );
            debugLog(
              "first user msg blocks:",
              Array.isArray(firstContent) ? firstContent.length : "string"
            );
            if (Array.isArray(firstContent)) {
              for (const b of firstContent) {
                const t = (b.text || "").substring(0, 80);
                debugLog(
                  "  first[block]:",
                  isRelocatableBlock(b.text) ? "RELOCATABLE" : "keep",
                  JSON.stringify(t)
                );
              }
            }
            if (firstUserIdx !== lastUserIdx) {
              debugLog(
                "last user msg blocks:",
                Array.isArray(lastContent) ? lastContent.length : "string"
              );
              if (Array.isArray(lastContent)) {
                for (const b of lastContent) {
                  const t = (b.text || "").substring(0, 80);
                  debugLog(
                    "  last[block]:",
                    isRelocatableBlock(b.text) ? "RELOCATABLE" : "keep",
                    JSON.stringify(t)
                  );
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
          debugLog(
            "SKIPPED: resume relocation (not a resume or already correct)"
          );
        }
      }

      // Bug 3: Stabilize tool ordering
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

      // Bug 2: Stabilize fingerprint in attribution header
      if (payload.system && payload.messages) {
        const fix = stabilizeFingerprint(payload.system, payload.messages);
        if (fix) {
          payload.system = [...payload.system];
          payload.system[fix.attrIdx] = {
            ...payload.system[fix.attrIdx],
            text: fix.newText,
          };
          modified = true;
          debugLog(
            "APPLIED: fingerprint stabilized from",
            fix.oldFingerprint,
            "to",
            fix.stableFingerprint
          );
        }
      }

      if (modified) {
        options = { ...options, body: JSON.stringify(payload) };
        debugLog("Request body rewritten");
      }
    } catch (e) {
      debugLog("ERROR in interceptor:", e?.message);
      // Parse failure — pass through unmodified
    }
  }

  return _origFetch.apply(this, [url, options]);
};
