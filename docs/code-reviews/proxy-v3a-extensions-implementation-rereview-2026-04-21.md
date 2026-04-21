# Review: proxy v3a extension pipeline implementation

Date: 2026-04-21
Reviewed: PR #45 implementation on commit 5a0311b
Label applied: changes-requested

## What Is Correct
- `proxy/stream.mjs` now threads `responseHeaders` into the stream hook context, so the earlier streaming metadata contract gap is resolved.
- The missing `fresh-session-sort` extension is now present and registered in `proxy/extensions.json`.
- Local verification passed for `node --test test/proxy-pipeline.test.mjs test/proxy-integration.test.mjs`, `npm test`, and `npm pack --dry-run`.

## Blockers
- `proxy/server.mjs:78-99` still does not implement the approved non-streaming response contract. `runOnResponse()` is only invoked inside the `statusCode >= 400` branch, which means successful non-streaming JSON responses still bypass the `onResponse` hook entirely. The approved directive said non-streaming responses are buffered, parsed, and passed through `onResponse` hooks; the current branch still only does that for error responses.

## What Needs Attention
- Because `clientRes.writeHead(statusCode, responseHeaders)` happens before the `runOnResponse()` branch (`proxy/server.mjs:76`), any future `onResponse` extension that mutates response headers would not affect what the client actually receives. That is not a blocker for the current extension set, but it is inconsistent with the advertised mutable-header hook surface.
- `proxy/extensions/cache-telemetry.mjs` still does not implement the directive’s stated behavior of extracting from response headers and writing `~/.claude/quota-status.json`; it only records transient values in `ctx.meta.cacheStats`.

## Recommendations
- Generalize the non-streaming path so successful JSON responses also buffer, parse, invoke `runOnResponse()`, and only then write headers/body to the client.
- If `onResponse` is meant to allow header mutation, delay `writeHead()` until after `runOnResponse()` completes for non-streaming responses.

## Bottom Line
The branch is much closer now, but I still cannot approve it yet. The implementation still falls short of the approved contract on the non-streaming success path, even though the previous streaming-metadata and missing-extension blockers are fixed.
