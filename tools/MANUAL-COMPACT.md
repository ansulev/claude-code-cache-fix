# manual-compact.sh — Manual Compaction for 1M Context Hack Sessions

## Purpose

When using the 1M context window hack (`DISABLE_COMPACT=1` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`), the `/compact` command is disabled by CC. This tool provides a manual compaction alternative: extract the conversation, summarize it via Claude, and restore context after `/clear`.

**This tool is specifically for sessions running the 1M hack.** If you have `/compact` available, use that instead — it's built-in, integrated, and handles the full compaction lifecycle automatically.

## How It Works

1. Extracts conversation turns from the session JSONL transcript
2. Splits turns into three weighted segments:
   - **Foundational** (first 20%) — truncated to 200 chars each
   - **Working** (middle 40%) — truncated to 400 chars each
   - **Active** (last 40%) — preserved up to 2000 chars each
3. Sends the weighted extract to Claude Sonnet for summarization
4. Produces a structured summary optimized for agent handoff

The weighting ensures recent active work (the part you're most likely to need) gets full detail, while earlier completed work is compressed.

## Usage

```bash
# Basic — summarize a session
manual-compact.sh <session-jsonl>

# With user context — additional instructions to preserve
manual-compact.sh <session-jsonl> <user-context-file>
```

### Finding Your Session JSONL

```bash
# List recent sessions, sorted by modification time
ls -lt ~/.claude/projects/<project-path>/*.jsonl | head -5
```

The project path follows the pattern: `-home-<user>-git-repos-<repo-name>`.

### Example: Basic Compaction

```bash
./tools/manual-compact.sh \
  ~/.claude/projects/-home-manager-git-repos-myproject/abc123.jsonl
```

Output: `/tmp/abc123-compact-summary.txt`

### Example: With User Context

If there's specific context you know the summary might miss:

```bash
echo "The MR2 OOM debugging took 3 days. The PR #75 architectural recommendation
was max(dualpol_lr, hail_lr) for correlation grouping." > /tmp/context.txt

./tools/manual-compact.sh \
  ~/.claude/projects/-home-manager-git-repos-myproject/abc123.jsonl \
  /tmp/context.txt
```

The user context is injected into the summarization prompt, ensuring those details appear in the output.

### Restoring Context After /clear

In the CC session:

```
/clear
```

Then as your first message:

```
Read /tmp/<session-id>-compact-summary.txt for context on where we left off.
```

## Limitations

### This tool is a workaround, not a replacement for /compact

- `/compact` operates inside CC with full access to the internal message array, system prompt, tool schemas, and session state. This tool only sees the JSONL transcript, which is a subset.
- `/compact` preserves CC's internal state (tool registration, MCP connections, plugin state). This tool + `/clear` resets all of that. The agent must re-establish any stateful connections.
- `/compact` is atomic — one command, seamless continuation. This tool requires `/clear` + paste, which is a hard context boundary.

### Summary fidelity

Tested at ~95% fidelity for active work resumption, ~70% for broader project context. Gaps typically include:

- **Operational debugging history** — multi-day debugging sagas compress away
- **Timeline information** — the summary doesn't indicate when things happened or how long they took
- **Depth of architectural discussions** — detailed technical recommendations get compressed to one-liners
- **Background process context** — overnight watchers, cron monitoring, polling patterns

Use the user context file to fill known gaps.

### Token cost

The summarization call costs tokens against your Q5h quota. At ~50K extract tokens through Sonnet, expect ~1-2% Q5h per compaction. This is comparable to what `/compact` costs.

### Requires Claude Sonnet access

The tool uses `claude --print --model claude-sonnet-4-6` for summarization. Sonnet is used instead of Opus to minimize Q5h impact. If Sonnet is unavailable, change the model in the script.

## Why the 1M Hack Disables /compact

The 1M context hack works by setting `DISABLE_COMPACT=1`, which CC reads as "disable all compaction." CC's code uses a single env var to control both:
- The context window calculation (`ff()` returns 1M when `DISABLE_COMPACT=1`)
- The `/compact` command availability (`isEnabled: () => !DISABLE_COMPACT`)

These are coupled in CC's source — there is no way to get 1M context AND `/compact` simultaneously without CC code changes. The coupling is in the CC binary, not in our interceptor.

We attempted to toggle `DISABLE_COMPACT` via the interceptor (set during API calls, unset between turns), but CC registers available commands at startup before any API call, so the toggle cannot re-enable `/compact` after session start.

## Requirements

- Claude Code v2.1.112 (the last Node.js version — v2.1.113+ uses Bun)
- The cache-fix interceptor loaded via `NODE_OPTIONS=--import`
- `DISABLE_COMPACT=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` set
- `claude` CLI available in PATH (used for summarization)
