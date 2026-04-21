# Review: proxy v3a extension pipeline directive

Date: 2026-04-20
Reviewed: docs/proxy-v3a-extensions-directive.md
Label applied: reviewed-by-codex-agent

## What Is Correct
- The directive now defines a concrete SSE stream rewrite contract, including parse scope, reserialization, passthrough behavior for unmodified events, treatment of non-`data:` lines, and fallback behavior on parse/serialization failure.
- The new `onResponseStart(ctx)` hook closes the earlier architectural gap for streaming-path extensions that need response status/headers before body forwarding.
- The previous follow-ups are also addressed: the branch name is corrected, `extensions.json` is explicitly part of hot reload, and `skip: true` now defines the direct client response path.

## Blockers
None

## What Needs Attention
- Section numbering is slightly out of order (`1.5` appears before `1.3` / `1.4`). That is cosmetic only.

## Recommendations
- Proceed to implementation on `feature/proxy-v3-extensions`.
- Keep `directive-stage` until implementation begins; then transition review state through the implementation workflow.

## Bottom Line
The directive is now specific enough to implement safely. The prior transport and hook-surface blockers are resolved, so I would add `plan-approved`.
