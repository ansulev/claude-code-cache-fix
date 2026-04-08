# Changelog

## 1.4.0 (2026-04-08)

- **TTL tier detection** — Clones the API response and drains the SSE stream to extract `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` from the usage object. Determines which cache TTL tier the server applied (1h vs 5m) and writes it to `~/.claude/quota-status.json` alongside quota data. Logs per-call cache hit rate and TTL tier when `CACHE_FIX_DEBUG=1`. Useful for diagnosing stuck TTL issues (#42052).
- **Quota file merge** — Header-based quota writes now merge with existing `quota-status.json` instead of replacing it, preserving the async TTL/cache data across writes.

## 1.3.0 (2026-04-08)

- **Prompt size measurement** — When `CACHE_FIX_DEBUG=1`, every API call now logs character counts for the system prompt, tool schemas, and per-type injected blocks (skills listing, MCP instructions, deferred tools, hooks). Helps users with large plugin/skill setups quantify the per-turn token cost of their configuration.
- **Removed prefix lock feature** — The prefix lock (`CACHE_FIX_PREFIX_LOCK`) has been removed. Testing revealed that the system prompt includes dynamic content (gitStatus, session-specific data) that changes on every resume, making the lock unable to match in practice. The `CACHE_FIX_PREFIX_LOCK` env var is now ignored.
- **Confirmed on v2.1.96** — Tested and verified against Claude Code v2.1.96.

## 1.2.1 (2026-04-08)

- **Removed prefix lock feature** — The prefix lock (`CACHE_FIX_PREFIX_LOCK`) has been removed. Testing revealed that the system prompt includes dynamic content (gitStatus, session-specific data) that changes on every resume, making the lock unable to match in practice. The feature never successfully fired in real cross-session usage. The `CACHE_FIX_PREFIX_LOCK` env var is now ignored.

## 1.2.0 (2026-04-07)

- **Prefix lock content hash guard** — Additional safety guard hashes all non-system-reminder user content in messages[0]. Prevents prefix lock from firing if substantive context changed between sessions, even if the first 200 chars match.

## 1.1.0 (2026-04-07)

New features:

- **Image stripping from old tool results** — Base64 images from Read tool persist in conversation history and are sent on every subsequent API call (~62,500 tokens per 500KB image per turn). Set `CACHE_FIX_IMAGE_KEEP_LAST=N` to strip images from tool results older than N user turns. Only targets tool_result images; user-pasted images are preserved. (Default: 0 = disabled)
- **Prefix lock for resume cache hit** — Saves messages[0] content after all fixes are applied; replays it on resume to produce a byte-identical prefix and avoid a full cache rebuild. Five safety guards prevent stale or incorrect prefix replay. Set `CACHE_FIX_PREFIX_LOCK=1` to enable. (Default: 0 = disabled)
- **GrowthBook flag dump** — Logs cost/cache-relevant server-controlled flags (tengu_hawthorn_window, pewter_kestrel, slate_heron, etc.) from `~/.claude.json` on first API call when `CACHE_FIX_DEBUG=1`
- **Microcompact monitoring** — Detects `[Old tool result content cleared]` markers in outgoing messages and logs count. Warns when total tool result chars approach the 200K budget threshold
- **False rate limiter detection** — Logs when the client generates synthetic rate limit errors (`model: "<synthetic>"`) without making a real API call
- **Prefix snapshot diffing** — Set `CACHE_FIX_PREFIXDIFF=1` to capture and diff message prefix across process restarts for cache bust diagnosis

## 1.0.0 (2026-04-06)

Initial release. Fixes three prompt cache bugs in Claude Code (tested through v2.1.92):

- **Partial block scatter on resume** — Relocates attachment blocks (skills, MCP, deferred tools, hooks) back to `messages[0]` when they drift to later messages during `--resume`
- **Fingerprint instability** — Stabilizes the `cc_version` fingerprint by computing it from real user text instead of meta/attachment blocks
- **Non-deterministic tool ordering** — Sorts tool definitions alphabetically for consistent cache keys across turns
