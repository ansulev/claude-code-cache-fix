# Changelog

## 1.7.2 (2026-04-12)

- **Status line for real-time quota/TTL warnings** — Ships `tools/quota-statusline.sh`, a Claude Code status line script that displays live Q5h%, Q7d%, burn rates, TTL tier, cache hit rate, peak-hour flag, and overage status. When the server downgrades to 5m TTL at Q5h ≥ 100% (Layer 2 quota-aware downgrade), the status line shows `TTL:5m` in red — a visible "stop and wait" signal that prevents users from power-driving through overage and compounding the drain. Setup: copy the script to `~/.claude/hooks/` and add `"statusLine": { "command": "~/.claude/hooks/quota-statusline.sh" }` to `~/.claude/settings.json`.
- **README: "Status line — quota warnings in real time"** — New section with feature list, setup instructions, and explanation of why TTL visibility matters for Layer 2 behavior.

## 1.7.1 (2026-04-12)

- **Windows support** — Added `claude-fixed.bat` wrapper for Windows users where `NODE_OPTIONS="--import ..."` doesn't work. Dynamically resolves npm global root, constructs `file:///` URL with forward-slash conversion, launches Claude Code with the interceptor active. Credit: [@TomTheMenace](https://github.com/anthropics/claude-code/issues/38335).
- **README: Windows setup guide** — Step-by-step instructions for Windows users alongside the existing Linux/macOS wrapper, alias, and direct-invocation options.
- **Contributors: @TomTheMenace** — First Windows platform validation: 7.5-hour, 536-call Opus 4.6 session with 98.4% cache hit rate. 81% of calls had fingerprint instability corrected by the interceptor. Contributed the `.bat` wrapper.

## 1.7.0 (2026-04-11)

Investigation release — cross-version regression analysis, interop with @fgrosswig's claude-usage-dashboard, and diagnostic tooling for per-version tool-schema drift.

- **`CACHE_FIX_DUMP_TOOLS` diagnostic hook** — Env-gated dump of the outgoing `tools` array to a JSON file, recording per-tool name, description, schema size, and total serialized size. Used during the 2026-04-11 cross-version regression investigation to identify that Claude Code v2.1.101's +7,207 character tool-schema growth is 92% attributable to two new tools (`Monitor` and `ScheduleWakeup`) shipped in that release. Inert unless `CACHE_FIX_DUMP_TOOLS=<path>` is set.
- **Full `anthropic-*` response header capture** — Widened the response header capture in `preload.mjs` from specific unified-ratelimit headers to the entire `anthropic-*` namespace plus `request-id`/`cf-ray`. Saved to `~/.claude/quota-status.json` under a new `all_headers` key. Future-proofs against Anthropic adding new headers without requiring code changes. Pattern borrowed from @fgrosswig's claude-usage-dashboard proxy.
- **`cost-factor` metric in `cost-report.mjs`** — Adds an overhead-ratio metric: `(input + output + cache_read + cache_creation) / output`. Single-number indicator of how much context is being paid per useful output token; rising values over long sessions signal cache-efficiency degradation. Surfaced in text, JSON, and Markdown output modes. Credit: @fgrosswig (methodology from claude-usage-dashboard).
- **`tools/sim-cost-reconcile.sh`** — One-liner wrapper around `cost-report.mjs` for running simulation logs against the Anthropic admin API. Auto-loads the admin key from `~/.config/anthropic/admin-key` or `ANTHROPIC_ADMIN_KEY`, resolves a sim directory to its simulation.log, and passes through extra args.
- **`tools/usage-to-dashboard-ndjson.mjs`** — New translator tool that reads `~/.claude/usage.jsonl` and emits NDJSON records in the schema expected by @fgrosswig's claude-usage-dashboard. Writes to `~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson` (the path his dashboard auto-discovers). Supports one-shot, follow, and stdout modes. Interceptor-specific fields (`ttl_tier`, `ephemeral_1h_input_tokens`, `peak_hour`, quota state) pass through his dashboard's tolerant schema unchanged. No coordination with fgrosswig required — the integration is fully one-way.
- **README: "Works with @fgrosswig's dashboard" section** — Documents the interop pattern with a quick-setup example, explains the complementary architecture (our per-call capture + his visualization), and adds @fgrosswig to Related research and Contributors.
- **docs/march-23-regression-investigation.md** — Full methodology and measurements from the 2026-04-11 cross-version analysis of Claude Code v2.1.81, v2.1.83, v2.1.90, and v2.1.101. Documents the release-timing argument (regression starts mid-release-cycle → server-side change), per-version prefix sizes, per-section breakdown, per-tool drift table, and the `ScheduleWakeup` tool description quote confirming the 5-minute TTL baseline from Anthropic's own product code.

## 1.5.0 → 1.6.4 (2026-04-08 to 2026-04-10) — backfilled

The CHANGELOG was not kept in sync during this release window. The major shipped features across these versions:

- **1.6.4** — `quota-analysis` tool for Q5h counting investigation; test infrastructure hardening; Crunchloop DAP / @bilby91 production-validation credit.
- **1.6.3** — Unit tests + CI workflow; `tengu_onyx_plover` GrowthBook flag tracking for `autoDream` visibility.
- **1.6.2** — Fresh-session sort/pin fix for @bilby91's #44045 case (removed the `messages.length < 2` early return); opt-in identity normalization for Agent SDK `system[1]` cache parity via `CACHE_FIX_NORMALIZE_IDENTITY=1` (@labzink #44724); opt-in output-efficiency system-prompt rewrite via `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` (@VictorSun92 PR).
- **1.6.1** — Quota utilization (`q5h_pct`, `q7d_pct`) logged per-call to `usage.jsonl` for drain-rate analysis.
- **1.6.0** — Enforce 1-hour cache TTL on accounts blocked by client-side gating. Interceptor injects `ttl: "1h"` into every outgoing `cache_control` block unconditionally.
- **1.5.1** — Fix MCP registration jitter cache busts (deferred-tools block sort, @bilby91 #44045).
- **1.5.0** — Add usage telemetry logging to `~/.claude/usage.jsonl`; `cost-report.mjs` CLI tool with pricing from `rates.json`, admin API cross-reference, and per-call breakdown.

For full per-commit detail on any of these releases, see `git log` in the repository.

## 1.4.1 (2026-04-08)

- **Peak hour detection** — Detects Anthropic's weekday peak hours (13:00–19:00 UTC, Mon–Fri) when quota drains at an elevated rate. Writes `peak_hour: true/false` to `quota-status.json` and logs `PEAK HOUR` when `CACHE_FIX_DEBUG=1`. Enables status line and data analysis to separate peak vs off-peak burn rates.

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
