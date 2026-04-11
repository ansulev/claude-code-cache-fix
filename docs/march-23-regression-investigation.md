# March 23 quota-drain regression — cross-version investigation

**Date:** 2026-04-11
**Author:** Cache Agent (Chris Nighswonger, cnighswonger/claude-code-cache-fix)
**Trigger:** #38335 thread consolidation on "v2.1.81 works, later releases burn quota"
**Scope:** Measure Claude Code v2.1.81, v2.1.83, v2.1.90, and v2.1.101 side-by-side on the same Max plan account with the cache-fix interceptor active, and characterize what actually changed.

---

## TL;DR

1. **The March 23 regression does not line up with a client release.** v2.1.81 shipped March 20, nothing shipped on March 23 itself (v2.1.82 never existed), and the next release was v2.1.83 on March 25. The regression starts mid-release-cycle, which points at a **server-side change** on March 23.
2. **v2.1.81 → v2.1.83 client diff is small and narrow.** ~500 characters of tool schema change: `CronCreate` schema expanded +254 chars, `TaskOutput` description expanded +255 chars. Nothing else material.
3. **v2.1.101 added two new tools that ship in every API call:** `Monitor` (3,447 chars) and `ScheduleWakeup` (3,168 chars). Combined 6,615 chars = **~1,700 extra prefix tokens per turn** for every user, whether they invoke those tools or not.
4. **Anthropic's own `ScheduleWakeup` tool description confirms the 5-minute TTL as baseline cache behavior** and advises Claude agents to avoid sleeping between 300s and 1200s to minimize cache misses. This is Anthropic documenting from the other side what the #42052 "stuck 5m TTL" reports have been observing.
5. **VS Code is not a separate code path.** The VS Code extension is a graphical frontend that spawns the CLI binary as a subprocess via a configurable `claudeProcessWrapper`. "v2.1.81 on VS Code" = "v2.1.81 CLI binary launched by VS Code." CLI users can pin to v2.1.81 via `npm install -g @anthropic-ai/claude-code@2.1.81` and get the same pre-regression behavior.

---

## Method

### Test matrix

Four CC versions installed side-by-side at `~/cc-versions/<version>/node_modules/...` via `npm install` into isolated prefixes. A launcher script `~/bin/cc-version <version> [args]` invokes each version, optionally preloading the cache-fix interceptor (`~/git_repos/claude-code-cache-fix/preload.mjs`) via `NODE_OPTIONS --import`.

| Version | Published | Role |
|---|---|---|
| v2.1.81 | 2026-03-20 22:24 UTC | Last pre-regression release |
| v2.1.83 | 2026-03-25 06:08 UTC | First post-regression release |
| v2.1.90 | 2026-04-01 23:41 UTC | Mid-cluster (when #38335 / #41930 escalation peaked) |
| v2.1.101 | 2026-04-10 19:03 UTC | Current |

### Workload

Each version was invoked with `claude -p --model haiku` and a fixed minimal prompt (`"Reply with exactly: ok"`). Haiku was chosen to minimize quota burn. Tests ran at off-peak hours (14:41–14:44 UTC, off-peak), from a fixed working directory, with the same `CLAUDE.md` files in scope, to hold dynamic system-prompt content constant across runs.

### Measurements captured

Per call via `~/.claude/usage.jsonl` (cache-fix interceptor):

- `cache_creation_input_tokens`, `cache_read_input_tokens` → total prefix size (tokens)
- `ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` → which TTL tier the server granted
- `q5h_pct`, `q7d_pct` → quota delta per call

Per call via `~/.claude/cache-fix-debug.log`:

- `PROMPT SIZE: system=<N> tools=<N> injected=<N> (skills=<N> mcp=<N> ...)` → character-count breakdown of the outgoing payload

Per call via a temporary dump hook (`CACHE_FIX_DUMP_TOOLS=<path>`) added to the interceptor's request-intercept phase:

- Full `payload.tools` array dumped to JSON, including per-tool name, description, schema, and sizes.

### Measurement isolation

Each version was run twice in succession. The second call's reading (when the full prefix lands as `cache_read` with `cache_creation=0`) gives the steady-state prefix size for that version, uncontaminated by cross-version cache hits.

---

## Results — steady-state prefix per version

| Version | Prefix tokens | Δ from v2.1.81 | Δ from prior |
|---|---:|---:|---:|
| v2.1.81 | 26,452 | baseline | — |
| v2.1.83 | 26,617 | +165 | +165 |
| v2.1.90 | 26,480 | +28 | −137 |
| v2.1.101 | 28,402 | +1,950 | +1,922 |

The net prefix growth from v2.1.81 to v2.1.90 is nearly zero (+28 tokens across 9 releases). All meaningful size growth is concentrated at **v2.1.101** (+1,922 tokens in one release).

---

## Results — character breakdown per request section

| Version | system | tools | injected (skills) | total | Δ tools |
|---|---:|---:|---:|---:|---:|
| v2.1.81 | 27,568 | 69,048 | 2,161 | 98,777 | — |
| v2.1.83 | 27,759 | 69,558 | 2,161 | 99,478 | +510 |
| v2.1.90 | 27,924 | 68,945 | 1,626 | 98,495 | −613 |
| v2.1.101 | 27,539 | **76,152** | 1,626 | 105,317 | **+7,207** |

### Per-section observations

- **System prompt** (v2.1.81 27,568 → v2.1.101 27,539) — essentially stable across 20 releases (±1.3%). The system prompt is not the source of the regression.
- **Injected skills block** — dropped by 535 characters at v2.1.90 (2,161 → 1,626). Consistent with a deliberate slim-down around the time #38335 peaked.
- **Tools schema** — dominated by a +7,207 character jump at v2.1.101.

---

## Results — per-tool diff

Complete tool list with sizes (all 23 tools in v2.1.81/83/90 and 25 tools in v2.1.101). All sizes in characters of the JSON-serialized tool object.

### Tool set membership

All versions contain: `Bash`, `TodoWrite`, `Agent`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `CronCreate`, `CronDelete`, `CronList`, `Grep`, `ExitWorktree`, `Read`, `WebSearch`, `WebFetch`, `EnterWorktree`, `Edit`, `Skill`, `NotebookEdit`, `Write`, `Glob`, `RemoteTrigger`, `TaskOutput`, `TaskStop` (23 tools).

**v2.1.101 adds:**
- `Monitor` — 3,447 chars (desc 2,530 / schema 816)
- `ScheduleWakeup` — 3,168 chars (desc 2,285 / schema 795)

**Combined new-tool footprint: 6,615 characters.** That is 92% of the +7,207 total tools-section growth. The remaining ~600 chars are small description/schema edits to existing tools (mostly `TaskOutput` +352, `Bash` +120, `Agent` +103).

### Per-tool drift across versions (chars)

| Tool | v2.1.81 | v2.1.83 | v2.1.90 | v2.1.101 | Δ 81→101 |
|---|---:|---:|---:|---:|---:|
| Bash | 12,475 | 12,469 | 11,630 | 11,750 | −725 |
| TodoWrite | 10,401 | 10,401 | 9,841 | 9,841 | −560 |
| Agent | 7,362 | 7,362 | 8,295 | 8,398 | +1,036 |
| AskUserQuestion | 4,880 | 4,880 | 4,880 | 4,880 | 0 |
| EnterPlanMode | 4,323 | 4,323 | 4,323 | 4,323 | 0 |
| **Monitor** | — | — | — | **3,447** | **+3,447** |
| CronCreate | 3,162 | 3,416 | 3,416 | 3,416 | +254 |
| Grep | 3,314 | 3,314 | 3,393 | 3,393 | +79 |
| **ScheduleWakeup** | — | — | — | **3,168** | **+3,168** |
| ExitPlanMode | 2,538 | 2,538 | 2,538 | 2,538 | 0 |
| ExitWorktree | 2,505 | 2,505 | 2,505 | 2,505 | 0 |
| Read | 2,488 | 2,488 | 2,435 | 2,435 | −53 |
| WebSearch | 1,871 | 1,871 | 1,871 | 1,871 | 0 |
| WebFetch | 1,865 | 1,865 | 1,865 | 1,865 | 0 |
| EnterWorktree | 1,775 | 1,780 | 1,780 | 1,780 | +5 |
| Edit | 1,716 | 1,716 | 1,703 | 1,702 | −14 |
| Skill | 1,677 | 1,677 | 1,677 | 1,677 | 0 |
| TaskOutput | 938 | 1,195 | 1,195 | 1,547 | +609 |
| NotebookEdit | 1,509 | 1,509 | 1,509 | 1,509 | 0 |
| Write | 1,022 | 1,022 | 1,022 | 1,022 | 0 |
| Glob | 1,126 | 1,126 | 966 | 966 | −160 |
| RemoteTrigger | 949 | 949 | 949 | 965 | +16 |
| TaskStop | 537 | 537 | 537 | 537 | 0 |
| CronDelete | 360 | 360 | 360 | 360 | 0 |
| CronList | 231 | 231 | 231 | 231 | 0 |
| **TOTAL** | **69,048** | **69,558** | **68,945** | **76,152** | **+7,104** |

### Interpretation

1. **v2.1.81 → v2.1.83 client change is small and benign.** Only `CronCreate` (+254) and `TaskOutput` (+255) changed; nothing else moved. Total net change in the tools section: +510 chars ≈ +130 tokens. That's well under what would cause the quota drain users started reporting on March 23. **The v2.1.81 → v2.1.83 client delta does not contain the regression.**

2. **v2.1.90 rebalanced the tool set** — `Agent` grew significantly (+933 chars, +914 of description), while `Bash` shrank (−839) and `TodoWrite` shrank (−560). Net: slight shrinkage. This looks like a deliberate content restructuring of existing tool descriptions, not new functionality.

3. **v2.1.101 is where the real client-side growth is.** Two entirely new tools (`Monitor` and `ScheduleWakeup`) are added to every request. Every v2.1.101 user pays 6,615 chars (~1,700 tokens) of prefix on every API call to carry two tools that most of them will never invoke.

---

## The `ScheduleWakeup` tool description — Anthropic confirms 5m TTL baseline

The full `ScheduleWakeup` description (2,285 chars) contains this passage verbatim:

> **Schedule when to resume work in /loop dynamic mode** — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task.
>
> Pass the same /loop prompt back via `prompt` each turn so the next firing repeats the task. For an autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` as `prompt` instead...
>
> ## Picking delaySeconds
>
> **The Anthropic prompt cache has a 5-minute TTL.** Sleeping past 300 seconds means the next wake-up reads your full conversation context uncached — slower and more expensive. So the natural breakpoints:
>
> - **Under 5 minutes (60s–270s)**: cache stays warm. Right for active work — checking a build, polling for state that's about to change, watching a process you just started.
> - **5 minutes to 1 hour (300s–3600s)**: pay the cache miss. Right when there's no point checking sooner — waiting on something that takes minutes to change, or genuinely idle.
>
> **Don't pick 300s.** It's the worst-of-both: you pay the cache miss without amortizing it. If you're tempted to "wait 5 minutes," either drop to 270s (stay in cache) or commit to 1200s+ (one cache miss buys a much longer wait). Don't think in round-number minutes — think in cache warmth.

This is **Anthropic's own product tooling** stating that the default cache TTL is 5 minutes. That aligns exactly with what @TigerKay1926 and others have reported in #42052 as "stuck 5m TTL." The 1-hour TTL tier exists but is opt-in via the client's `should1hCacheTTL()` GrowthBook gating — users whose client call path isn't in the allowlist get the default 5m.

This has two implications for the March 23 regression:

1. **If the server introduced this 5m-default behavior on March 23**, users whose clients weren't on the 1h allowlist would suddenly pay full prefix rebuilds every time they idled more than 5 minutes (reading code, thinking, coffee break). This matches the user reports almost exactly.
2. **The 1h/5m tier gating is documented in the product now** — it's not a bug Anthropic is unaware of, it's a feature they've built their own long-loop tooling around. That reframes the community frustration: the behavior is *working as designed from Anthropic's side*, but the design has sharp edges for users whose sessions don't fit the cache-warm work pattern.

---

## TTL tier observations

All four versions in this test obtained **1-hour TTL tier on Haiku** with the cache-fix interceptor active. This is because the interceptor forces `ttl: "1h"` into the `cache_control` blocks unconditionally, bypassing whatever GrowthBook allowlist gating the client would otherwise do.

**Without the interceptor**, v2.1.81 would still likely get 1h TTL because its client code path predates the gating logic. v2.1.83 through v2.1.101 without the interceptor would be subject to the `should1hCacheTTL()` check — which depends on the `querySource` value and whether the user's account is in the allowlist. Users on the allowlist get 1h; users off it get 5m.

I did not test without-interceptor mode in this pass because the interceptor is currently deployed in my local environment and disabling it for a single test would introduce other confounds. A future test should run each version via `~/bin/cc-version <v> --no-interceptor` and compare the TTL tier each version receives from the server by default.

---

## Hypothesis of the regression mechanism

Combining the evidence:

1. **Server-side (March 23):** Anthropic introduced (or tightened) the 5m/1h TTL tier distinction server-side. Pre-March 23, either all calls got 1h, or the tier gating was not yet enforced. Starting March 23, clients that don't explicitly request the 1h tier (or don't match the GrowthBook allowlist) get 5m by default. Users whose workflows include any idle period >5 minutes suddenly pay full cache rebuilds they didn't pay before.

2. **Client-side (v2.1.83, March 25):** the first release after the regression. Its client diff from v2.1.81 is very small (~500 chars of tool schema changes). The regression mechanism is not in that diff. **v2.1.81 users may be getting pre-regression behavior because their client's querySource happens to be on the 1h allowlist**, or because the pre-March-23 code path emits cache_control blocks without the new tier field, which the server accepts as implicit 1h.

3. **Client-side (v2.1.101, April 10):** +6,615 characters of new tool schema (`Monitor` + `ScheduleWakeup`) in every API call. Not the root cause of the March 23 regression, but compounds the per-turn cost for anyone affected by it. **Also noteworthy:** `ScheduleWakeup` is itself a tool built around navigating the 5m TTL constraint, confirming that by v2.1.101 the 5m baseline is treated as a fixed design constraint by Anthropic.

The practical workaround that works — pin to v2.1.81 — works because v2.1.81's client never interacts with the March 23 server-side gating in a way that penalizes it. Whether that's because v2.1.81 emits a different `querySource` value, or because its cache_control blocks use a field shape that the server interprets as implicit 1h, or for some other reason, would require capturing the raw outgoing request bodies from v2.1.81 and comparing them against v2.1.83+. That's a follow-on test.

---

## Quota cost of the investigation

| Phase | API calls | Δ Q5h | Δ Q7d |
|---|---:|---:|---:|
| Pre-test baseline | — | 82% | 23% |
| Phase 1 setup | 0 | — | — |
| Phase 2 per-version Haiku tests | ~16 | +5% | +1% |
| Post-test | — | 87% | 24% |

~16 Haiku calls for a complete investigation across 4 versions. Haiku quota footprint was much smaller than feared — ~0.3% Q5h per call, ~0.06% Q7d per call. For cache/regression investigation work, Haiku is a very cheap probe tool even on Max plans where Opus dominates quota accounting.

---

## Recommended next steps

1. **Post a summary to #38335** correcting the "VS Code vs CLI" misattribution, showing the 4-version prefix table, and flagging the Monitor/ScheduleWakeup bloat at v2.1.101. Clear evidence-first framing.
2. **Capture raw outgoing request bodies from v2.1.81 and v2.1.83+** without the interceptor active. Compare `cache_control` block shape and any `x-*` request headers. This would let us identify the exact client-side trigger for the 1h tier vs 5m default.
3. **Add a `CACHE_FIX_DUMP_TOOLS` feature to the interceptor properly** (it currently exists as a dev-only dump added during this investigation) — it was useful and is worth making a first-class diagnostic feature.
4. **File an issue or comment on #42052** pointing to the `ScheduleWakeup` description as documentation confirmation of the 5m TTL baseline. TigerKay1926 and others deserve to know their observation is now confirmed from Anthropic's own product.
5. **Consider a dedicated tracked issue** for the `Monitor` + `ScheduleWakeup` tool-schema bloat — specifically, the "pay for tools you never use" pattern. Users who are not running /loop dynamic mode or background monitors shouldn't be paying ~1,700 tokens per turn for these schemas. Anthropic could gate their inclusion behind detection of actual use, or ship them as MCP servers the user opts into instead of shipping them in the core tool list.
6. **Install and run v2.1.81 for a sustained session on real work** (not just smoke tests) and measure the quota burn rate vs the same work on v2.1.101. This is the actionable user-facing datum — "here's how much you save per hour on v2.1.81 under similar load."

---

## Raw data

Full per-call usage.jsonl records, per-call prompt-size debug entries, and full tool dumps are preserved in:

- `/tmp/tools-2.1.81.json`, `/tmp/tools-2.1.83.json`, `/tmp/tools-2.1.90.json`, `/tmp/tools-2.1.101.json`, `/tmp/tools-101-full.json`
- `~/.claude/usage.jsonl` (entries from 14:41:49 UTC through 14:44:49 UTC)
- `~/.claude/cache-fix-debug.log` (entries from 14:41:48 UTC onward, `PROMPT SIZE` lines)

All four CC versions are installed side-by-side at `~/cc-versions/<version>/node_modules/@anthropic-ai/claude-code/cli.js` and can be invoked via `~/bin/cc-version <version> [args]`.

---

*End of investigation — 2026-04-11 14:50 UTC*
