# Review: proxy v3a extension pipeline implementation

Date: 2026-04-21
Reviewed: PR #45 implementation on commit d73eacc
Label applied: changes-requested

## What Is Correct
- The branch introduces the expected extension-pipeline scaffolding (`proxy/pipeline.mjs`, `proxy/watcher.mjs`, extension modules, integration tests) and keeps the package artifact shipping the new proxy files.
- The request-path hook execution and snapshotting model are reasonable, and the new test coverage is materially better than the previous proxy phases.
- Local verification passed for `node --test test/proxy-pipeline.test.mjs test/proxy-integration.test.mjs`, `npm test`, and `npm pack --dry-run`.

## Blockers
- `proxy/server.mjs:71-76` and `proxy/stream.mjs:63-65` break the approved hook contract for streaming responses. `onResponseStart()` runs, but the streaming hook context is still created with `responseHeaders: null`, so streaming extensions never receive the response metadata the directive explicitly added this hook for. Any extension that needs headers during `onStreamEvent` still cannot work as specified.
- `proxy/pipeline.mjs:78-88` defines `runOnResponse()`, but `proxy/server.mjs:76-98` never buffers a non-streaming response or calls it. The implementation therefore exposes an `onResponse` API that is not actually wired into the server. That is a functional gap, not just missing polish: non-streaming response extensions cannot run at all.
- The approved directive’s success criteria require all five core cache fixes to be ported, including `fresh-session-sort` (`docs/proxy-v3a-extensions-directive.md:149`), but there is no corresponding extension module in `proxy/extensions/`. The current branch ships four core fixes plus extra helper/observability extensions, so the promised phase scope is still incomplete.

## What Needs Attention
- `proxy/extensions/cache-telemetry.mjs:1-24` does not implement the behavior described in the directive. It records transient values into `ctx.meta.cacheStats`, but it does not extract from response headers or write `~/.claude/quota-status.json` as specified.
- Current tests do not cover the missing `onResponse` path or the missing `responseHeaders` propagation into `onStreamEvent`, which is why these contract gaps are passing unnoticed.

## Recommendations
- Thread the `onResponseStart()` header snapshot into `streamResponse()` so `ctx.responseHeaders` is populated for stream hooks.
- Implement the documented non-streaming path by buffering/parsing non-SSE responses and invoking `runOnResponse()`, or narrow the public hook contract if non-streaming support is intentionally out of scope.
- Add the missing `fresh-session-sort` extension and tests, or explicitly revise the phase scope before approval.

## Bottom Line
The branch is close, but I cannot approve it yet. The server still does not honor the full hook contract it now advertises, and one of the five promised core fixes is not implemented on the branch.
