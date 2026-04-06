# claude-code-cache-fix

Fixes a prompt cache regression in [Claude Code](https://github.com/anthropics/claude-code) that causes **up to 20x cost increase** on resumed sessions. Confirmed broken through v2.1.92.

## The problem

When you use `--resume` or `/resume` in Claude Code, the prompt cache breaks silently. Instead of reading cached tokens (cheap), the API rebuilds them from scratch on every turn (expensive). A session that should cost ~$0.50/hour can burn through $5–10/hour with no visible indication anything is wrong.

Three bugs cause this:

1. **Partial block scatter** — Attachment blocks (skills listing, MCP servers, deferred tools, hooks) are supposed to live in `messages[0]`. On resume, some or all of them drift to later messages, changing the cache prefix.

2. **Fingerprint instability** — The `cc_version` fingerprint (e.g. `2.1.92.a3f`) is computed from `messages[0]` content including meta/attachment blocks. When those blocks shift, the fingerprint changes, the system prompt changes, and cache busts.

3. **Non-deterministic tool ordering** — Tool definitions can arrive in different orders between turns, changing request bytes and invalidating the cache key.

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

## Debug mode

Enable debug logging to verify the fix is working:

```bash
CACHE_FIX_DEBUG=1 claude-fixed
```

Logs are written to `~/.claude/cache-fix-debug.log`. Look for:
- `APPLIED: resume message relocation` — block scatter was detected and fixed
- `APPLIED: tool order stabilization` — tools were reordered
- `APPLIED: fingerprint stabilized from XXX to YYY` — fingerprint was corrected
- `SKIPPED: resume relocation (not a resume or already correct)` — no fix needed (fresh session or already correct)

## Limitations

- **npm installation only** — The standalone Claude Code binary has Zig-level attestation that bypasses Node.js. This fix only works with the npm package (`npm install -g @anthropic-ai/claude-code`).
- **Overage TTL downgrade** — Exceeding 100% of the 5-hour quota triggers a server-enforced TTL downgrade from 1h to 5m. This is a server-side decision and cannot be fixed client-side. The interceptor prevents the cache instability that can push you into overage in the first place.
- **Version coupling** — The fingerprint salt and block detection heuristics are derived from Claude Code internals. A major refactor could require an update to this package.

## Tracked issues

- [#34629](https://github.com/anthropics/claude-code/issues/34629) — Original resume cache regression report
- [#40524](https://github.com/anthropics/claude-code/issues/40524) — Within-session fingerprint invalidation
- [#42052](https://github.com/anthropics/claude-code/issues/42052) — Community interceptor development and testing
- [#43044](https://github.com/anthropics/claude-code/issues/43044) — Resume loads 0% context on v2.1.91
- [#43657](https://github.com/anthropics/claude-code/issues/43657) — Resume cache invalidation confirmed on v2.1.92
- [#44045](https://github.com/anthropics/claude-code/issues/44045) — SDK-level reproduction with token measurements

## Contributors

- **[@VictorSun92](https://github.com/VictorSun92)** — Original monkey-patch fix for v2.1.88, identified partial scatter on v2.1.90, contributed forward-scan detection, correct block ordering, and tighter block matchers
- **[@jmarianski](https://github.com/jmarianski)** — Root cause analysis via MITM proxy capture and Ghidra reverse engineering, multi-mode cache test script
- **[@cnighswonger](https://github.com/cnighswonger)** — Fingerprint stabilization, tool ordering fix, debug logging, overage TTL downgrade discovery, package maintainer

If you contributed to the community effort on these issues and aren't listed here, please open an issue or PR — we want to credit everyone properly.

## License

[MIT](LICENSE)
