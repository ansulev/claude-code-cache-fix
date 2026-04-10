# claude-code-cache-fix

English | [中文](./README.zh.md)

Fixes prompt cache regressions in [Claude Code](https://github.com/anthropics/claude-code) that cause **up to 20x cost increase** on resumed sessions, plus monitoring for silent context degradation. Confirmed through v2.1.97.

## The problem

When you use `--resume` or `/resume` in Claude Code, the prompt cache breaks silently. Instead of reading cached tokens (cheap), the API rebuilds them from scratch on every turn (expensive). A session that should cost ~$0.50/hour can burn through $5–10/hour with no visible indication anything is wrong.

Three bugs cause this:

1. **Partial block scatter** — Attachment blocks (skills listing, MCP servers, deferred tools, hooks) are supposed to live in `messages[0]`. On resume, some or all of them drift to later messages, changing the cache prefix.

2. **Fingerprint instability** — The `cc_version` fingerprint (e.g. `2.1.92.a3f`) is computed from `messages[0]` content including meta/attachment blocks. When those blocks shift, the fingerprint changes, the system prompt changes, and cache busts.

3. **Non-deterministic tool ordering** — Tool definitions can arrive in different orders between turns, changing request bytes and invalidating the cache key.

Additionally, images read via the Read tool persist as base64 in conversation history and are sent on every subsequent API call, compounding token costs silently.

## Installation

Requires Node.js >= 18 and Claude Code installed via npm (not the standalone binary).

```bash
npm install -g claude-code-cache-fix
```

## Usage

The fix works as a Node.js preload module that intercepts API requests before they leave your machine.

### Option A: Wrapper script (recommended)

Create a wrapper script (e.g. `~/bin/claude-fixed`):

```bash
#!/bin/bash
CLAUDE_NPM_CLI="$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"

if [ ! -f "$CLAUDE_NPM_CLI" ]; then
  echo "Error: Claude Code npm package not found at $CLAUDE_NPM_CLI" >&2
  echo "Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

exec env NODE_OPTIONS="--import claude-code-cache-fix" node "$CLAUDE_NPM_CLI" "$@"
```

```bash
chmod +x ~/bin/claude-fixed
```

Adjust `CLAUDE_NPM_CLI` if your npm global prefix differs. Find it with:
```bash
npm root -g
```

### Option B: Shell alias

```bash
alias claude='NODE_OPTIONS="--import claude-code-cache-fix" node "$(npm root -g)/@anthropic-ai/claude-code/cli.js"'
```

### Option C: Direct invocation

```bash
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **Note**: This only works if `claude` points to the npm/Node installation. The standalone binary uses a different execution path that bypasses Node.js preloads.

## How it works

The module intercepts `globalThis.fetch` before Claude Code makes API calls to `/v1/messages`. On each call it:

1. **Scans all user messages** for relocated attachment blocks (skills, MCP, deferred tools, hooks) and moves the latest version of each back to `messages[0]`, matching fresh session layout
2. **Sorts tool definitions** alphabetically by name for deterministic ordering
3. **Recomputes the cc_version fingerprint** from the real user message text instead of meta/attachment content

All fixes are idempotent — if nothing needs fixing, the request passes through unmodified. The interceptor is read-only with respect to your conversation; it only normalizes the request structure before it hits the API.

## Image stripping

Images read via the Read tool are encoded as base64 and stored in `tool_result` blocks in conversation history. They ride along on **every subsequent API call** until compaction. A single 500KB image costs ~62,500 tokens per turn in carry-forward.

Enable image stripping to remove old images from tool results:

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

This keeps images in the last 3 user messages and replaces older ones with a text placeholder. Only targets images inside `tool_result` blocks (Read tool output) — user-pasted images are never touched. Files remain on disk for re-reading if needed.

Set to `0` (default) to disable.

## System prompt rewrite (optional)

The interceptor can also rewrite Claude Code's `# Output efficiency` system-prompt section before the request is sent.

This feature is **optional** and **disabled by default**. If `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` is unset, nothing is changed.

Enable it by setting a replacement text:

```bash
export CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT=$'# Output efficiency\n\n...'
```

The rewrite is intentionally narrow:

- Only Claude Code's `# Output efficiency` section is replaced
- Other system prompt sections are preserved
- Existing system block structure and fields such as `cache_control` are preserved

This may be useful for users who want to stay on current Claude Code versions but experiment with a different `Output efficiency` instruction set instead of downgrading to an earlier release.

### Prompt variants

<details>
<summary>Anthropic internal / <code>USER_TYPE=ant</code> version</summary>

```text
# Output efficiency

When sending user-facing text, you're writing for a person, not logging to a console. Assume users can't see most tool calls or thinking - only your text output. Before your first tool call, briefly state what you're about to do. While working, give short updates at key moments: when you find something load-bearing (a bug, a root cause), when changing direction, when you've made progress without an update.

When you give updates, assume the recipient may have stepped away and lost the thread. They do not know your internal shorthand, codenames, or half-formed plan. Write in complete, grammatical sentences that can be understood cold. Spell out technical terms when helpful. If unsure, err on the side of a bit more explanation. Adapt to the user's expertise: experts can handle denser updates, but don't make novice users reconstruct context on their own.

User-facing text should read like natural prose. Avoid clipped sentence fragments, excessive dashes, symbolic shorthand, or formatting that reads like console output. Use tables only when they genuinely improve scanability, such as compact facts (files, lines, pass/fail) or quantitative comparisons. Keep explanatory reasoning in prose around the table, not inside it. Avoid semantic backtracking: structure sentences so the user can follow them linearly without having to reinterpret earlier clauses after reading later ones.

Optimize for fast human comprehension, not minimal surface area. If the user has to reread your summary or ask a follow-up just to understand what happened, you saved the wrong tokens. Match the level of structure to the task: for a simple question, answer in plain prose without unnecessary headings or numbered lists. While staying clear and direct, also be concise and avoid fluff. Skip filler, obvious restatements, and throat-clearing. Get to the point. Don't over-focus on low-signal details from your process. When it helps, use an inverted pyramid structure with the conclusion first and details later.

These user-facing text instructions do not apply to code or tool calls.
```

</details>

<details>
<summary>Public / default Claude Code version</summary>

```text
# Output efficiency

IMPORTANT: Go straight to the point. Try the simplest approach first without going in circles. Do not overdo it. Be extra concise.

Your text output is brief, direct, and to the point. Lead with the answer or action, not the reasoning. Omit filler, preamble, and unnecessary transitions. Do not restate the user's request; move directly to the work. When explanation is needed, include only what helps the user understand the outcome.

Prioritize user-facing text for:
- decisions that require user input
- high-signal progress updates at natural milestones
- errors or blockers that change the plan

If a sentence can do the job, do not turn it into three. Favor short, direct constructions over long explanatory prose. These instructions do not apply to code or tool calls.
```

</details>

<details>
<summary>Example custom replacement(A middle-ground version combining the two versions above)</summary>

```text
# Output efficiency

When sending user-facing text, write for a person, not a log file. Assume the user cannot see most tool calls or hidden reasoning - only your text output.

Keep user-facing text clear, direct, and reasonably concise. Lead with the answer or action. Skip filler, repetition, and unnecessary preamble.

Explain enough for the user to understand the reasoning, tradeoffs, or root cause when that would help them learn or make a decision, but do not turn simple answers into long writeups.

These instructions apply to user-facing text only. They do not apply to investigation, code reading, tool use, or verification.

Before making changes, read the relevant code and understand the surrounding context. Check types, signatures, call sites, and error causes before editing. Do not confuse brevity with rushing, and do not replace understanding with trial and error.

While working, give short updates at meaningful moments: when you find the root cause, when the plan changes, when you hit a blocker, or when a meaningful milestone is complete. Do not narrate every step.

When reporting results, be accurate and concrete. If you did not verify something, say so plainly. If a check failed, say that plainly too.
```

</details>

## Monitoring

The interceptor includes monitoring for several additional issues identified by the community:

### Microcompact / budget enforcement

Claude Code silently replaces old tool results with `[Old tool result content cleared]` via server-controlled mechanisms (GrowthBook flags). A 200,000-character aggregate cap and per-tool caps (Bash: 30K, Grep: 20K) truncate older results without notification. There is no `DISABLE_MICROCOMPACT` environment variable.

The interceptor detects cleared tool results and logs counts. When total tool result characters approach the 200K threshold, a warning is logged.

### False rate limiter

The client can generate synthetic "Rate limit reached" errors without making an API call, identifiable by `"model": "<synthetic>"`. The interceptor logs these events.

### GrowthBook flag dump

On the first API call, the interceptor reads `~/.claude.json` and logs the current state of cost/cache-relevant server-controlled flags (hawthorn_window, pewter_kestrel, slate_heron, session_memory, etc.).

### Quota tracking

Response headers are parsed for `anthropic-ratelimit-unified-5h-utilization` and `7d-utilization`, saved to `~/.claude/quota-status.json` for consumption by status line hooks or other tools.

### Peak hour detection

Anthropic applies elevated quota drain rates during weekday peak hours (13:00–19:00 UTC, Mon–Fri). The interceptor detects peak windows and writes `peak_hour: true/false` to `quota-status.json`. See `docs/peak-hours-reference.md` for sources and details.

### Usage telemetry and cost reporting

The interceptor logs per-call usage data to `~/.claude/usage.jsonl` — one JSON line per API call with model, token counts, and cache breakdown. Use the bundled cost report tool to analyze costs:

```bash
node tools/cost-report.mjs                    # today's costs from interceptor log
node tools/cost-report.mjs --date 2026-04-08  # specific date
node tools/cost-report.mjs --since 2h         # last 2 hours
node tools/cost-report.mjs --admin-key <key>  # cross-reference with Admin API
```

Also works with any JSONL containing Anthropic usage fields (`--file`, stdin) — useful for SDK users and proxy setups. See `docs/cost-report.md` for full documentation.

## Debug mode

Enable debug logging to verify the fix is working:

```bash
CACHE_FIX_DEBUG=1 claude-fixed
```

Logs are written to `~/.claude/cache-fix-debug.log`. Look for:
- `APPLIED: resume message relocation` — block scatter was detected and fixed
- `APPLIED: tool order stabilization` — tools were reordered
- `APPLIED: fingerprint stabilized from XXX to YYY` — fingerprint was corrected
- `APPLIED: stripped N images from old tool results` — images were stripped
- `APPLIED: output efficiency section rewritten` — output-efficiency section was replaced
- `MICROCOMPACT: N/M tool results cleared` — microcompact degradation detected
- `BUDGET WARNING: tool result chars at N / 200,000 threshold` — approaching budget cap
- `FALSE RATE LIMIT: synthetic model detected` — client-side false rate limit
- `GROWTHBOOK FLAGS: {...}` — server-controlled feature flags on first call
- `PROMPT SIZE: system=N tools=N injected=N (skills=N mcp=N ...)` — per-call prompt size breakdown
- `CACHE TTL: tier=1h create=N read=N hit=N% (1h=N 5m=N)` — TTL tier and cache hit rate per call
- `PEAK HOUR: weekday 13:00-19:00 UTC` — Anthropic peak hour throttling active
- `SKIPPED: resume relocation (not a resume or already correct)` — no fix needed
- `SKIPPED: output efficiency rewrite (section not found)` — no matching output-efficiency section found

### Prefix diff mode

Enable cross-process prefix snapshot diffing to diagnose cache busts on restart:

```bash
CACHE_FIX_PREFIXDIFF=1 claude-fixed
```

Snapshots are saved to `~/.claude/cache-fix-snapshots/` and diff reports are generated on the first API call after a restart.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_FIX_DEBUG` | `0` | Enable debug logging to `~/.claude/cache-fix-debug.log` |
| `CACHE_FIX_PREFIXDIFF` | `0` | Enable prefix snapshot diffing |
| `CACHE_FIX_IMAGE_KEEP_LAST` | `0` | Keep images in last N user messages (0 = disabled) |
| `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` | unset | Replace Claude Code's `# Output efficiency` system-prompt section before the request is sent |
| `CACHE_FIX_USAGE_LOG` | `~/.claude/usage.jsonl` | Path for per-call usage telemetry log |

## Limitations

- **npm installation only** — The standalone Claude Code binary has Zig-level attestation that bypasses Node.js. This fix only works with the npm package (`npm install -g @anthropic-ai/claude-code`).
- **Overage TTL downgrade** — Exceeding 100% of the 5-hour quota triggers a server-enforced TTL downgrade from 1h to 5m. This is a server-side decision and cannot be fixed client-side. The interceptor prevents the cache instability that can push you into overage in the first place.
- **Microcompact is not preventable** — The monitoring features detect context degradation but cannot prevent it. The microcompact and budget enforcement mechanisms are server-controlled via GrowthBook flags with no client-side disable option.
- **System prompt rewrite is experimental** — This hook only rewrites one system-prompt section and is opt-in, but there are still unknowns: it is not proven that this prompt text is responsible for the behavior differences discussed in community reports, and it is not known whether future server-side validation could react to modified system prompts. Use at your own risk.
- **Version coupling** — The fingerprint salt and block detection heuristics are derived from Claude Code internals. A major refactor could require an update to this package.

## Tracked issues

- [#34629](https://github.com/anthropics/claude-code/issues/34629) — Original resume cache regression report
- [#40524](https://github.com/anthropics/claude-code/issues/40524) — Within-session fingerprint invalidation, image persistence
- [#42052](https://github.com/anthropics/claude-code/issues/42052) — Community interceptor development, TTL downgrade discovery
- [#43044](https://github.com/anthropics/claude-code/issues/43044) — Resume loads 0% context on v2.1.91
- [#43657](https://github.com/anthropics/claude-code/issues/43657) — Resume cache invalidation confirmed on v2.1.92
- [#44045](https://github.com/anthropics/claude-code/issues/44045) — SDK-level reproduction with token measurements
- [#32508](https://github.com/anthropics/claude-code/issues/32508) — Community discussion around the `Output efficiency` system-prompt change and its possible effect on model behavior

## Related research

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — Systematic proxy-based analysis of 7 bugs including microcompact, budget enforcement, false rate limiter, and extended thinking quota impact. The monitoring features in v1.1.0 are informed by this research.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — Diagnostic HTTPS proxy with real-time dashboard, system prompt section diffing, per-tool stripping thresholds, and multi-stream JSONL logging. Works with any Claude client that supports `ANTHROPIC_BASE_URL` (CLI, VS Code extension, desktop app), complementing this package's CLI-only `NODE_OPTIONS` approach.

## Used in production

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP development environment. First production team to merge the interceptor to trunk for team-wide deployment (2026-04-10). Identified two distinct cache regression patterns through real-world testing — tool ordering jitter and the fresh-session sort gap — and contributed debug traces that drove the v1.5.1 and v1.6.2 fixes.

## Contributors

- **[@VictorSun92](https://github.com/VictorSun92)** — Original monkey-patch fix for v2.1.88, identified partial scatter on v2.1.90, contributed forward-scan detection, correct block ordering, tighter block matchers, and the optional output-efficiency rewrite hook
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Agent SDK / DAP production environment validation, 1h cache TTL confirmation, tool ordering jitter discovery via debug trace (fixed in v1.5.1), fresh-session sort bug discovery via SKILLS SORT diagnostic (fixed in v1.6.2). First production team to roll the interceptor to trunk.
- **[@jmarianski](https://github.com/jmarianski)** — Root cause analysis via MITM proxy capture and Ghidra reverse engineering, multi-mode cache test script
- **[@cnighswonger](https://github.com/cnighswonger)** — Fingerprint stabilization, tool ordering fix, image stripping, monitoring features, overage TTL downgrade discovery, package maintainer
- **[@ArkNill](https://github.com/ArkNill)** — Microcompact mechanism analysis, GrowthBook flag documentation, false rate limiter identification
- **[@Renvect](https://github.com/Renvect)** — Image duplication discovery, cross-project directory contamination analysis

If you contributed to the community effort on these issues and aren't listed here, please open an issue or PR — we want to credit everyone properly.

## Support

If this tool saved you money, consider buying me a coffee:

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## License

[MIT](LICENSE)
