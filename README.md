# claude-code-cache-fix

Fixes prompt cache regressions in [Claude Code](https://github.com/anthropics/claude-code) that cause **up to 20x cost increase** on resumed sessions, plus monitoring for silent context degradation. Confirmed through v2.1.92.

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
- `MICROCOMPACT: N/M tool results cleared` — microcompact degradation detected
- `BUDGET WARNING: tool result chars at N / 200,000 threshold` — approaching budget cap
- `FALSE RATE LIMIT: synthetic model detected` — client-side false rate limit
- `GROWTHBOOK FLAGS: {...}` — server-controlled feature flags on first call
- `SKIPPED: resume relocation (not a resume or already correct)` — no fix needed

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

## Limitations

- **npm installation only** — The standalone Claude Code binary has Zig-level attestation that bypasses Node.js. This fix only works with the npm package (`npm install -g @anthropic-ai/claude-code`).
- **Overage TTL downgrade** — Exceeding 100% of the 5-hour quota triggers a server-enforced TTL downgrade from 1h to 5m. This is a server-side decision and cannot be fixed client-side. The interceptor prevents the cache instability that can push you into overage in the first place.
- **Microcompact is not preventable** — The monitoring features detect context degradation but cannot prevent it. The microcompact and budget enforcement mechanisms are server-controlled via GrowthBook flags with no client-side disable option.
- **Version coupling** — The fingerprint salt and block detection heuristics are derived from Claude Code internals. A major refactor could require an update to this package.

## Tracked issues

- [#34629](https://github.com/anthropics/claude-code/issues/34629) — Original resume cache regression report
- [#40524](https://github.com/anthropics/claude-code/issues/40524) — Within-session fingerprint invalidation, image persistence
- [#42052](https://github.com/anthropics/claude-code/issues/42052) — Community interceptor development, TTL downgrade discovery
- [#43044](https://github.com/anthropics/claude-code/issues/43044) — Resume loads 0% context on v2.1.91
- [#43657](https://github.com/anthropics/claude-code/issues/43657) — Resume cache invalidation confirmed on v2.1.92
- [#44045](https://github.com/anthropics/claude-code/issues/44045) — SDK-level reproduction with token measurements

## Related research

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — Systematic proxy-based analysis of 7 bugs including microcompact, budget enforcement, false rate limiter, and extended thinking quota impact. The monitoring features in v1.1.0 are informed by this research.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — Diagnostic HTTPS proxy with real-time dashboard, system prompt section diffing, per-tool stripping thresholds, and multi-stream JSONL logging. Works with any Claude client that supports `ANTHROPIC_BASE_URL` (CLI, VS Code extension, desktop app), complementing this package's CLI-only `NODE_OPTIONS` approach.

## Contributors

- **[@VictorSun92](https://github.com/VictorSun92)** — Original monkey-patch fix for v2.1.88, identified partial scatter on v2.1.90, contributed forward-scan detection, correct block ordering, and tighter block matchers
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
