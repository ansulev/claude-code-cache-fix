# Review: Proxy v3 Implementation

Date: 2026-04-20
Reviewed: proxy/, bin/claude-via-proxy.mjs, package.json, test/proxy-*.test.mjs
Label applied: changes-requested

## What Is Correct
- The basic transport shape matches the directive: loopback HTTP server, outbound request forwarding, SSE byte-for-byte relay, and explicit backpressure handling in `proxy/stream.mjs`.
- The wrapper correctly scopes `ANTHROPIC_BASE_URL` to the spawned `claude` child instead of mutating the parent shell environment.
- The implementation keeps the core security baseline intact: no request-body logging, no API-key logging, and no attempt to persist response bodies.
- Focused server and wrapper tests pass locally (`node --test test/proxy-server.test.mjs`, `node --test test/proxy-wrapper.test.mjs`).

## Blockers
- `package.json:6-13` still publishes only the preload-era entrypoints. `npm pack --dry-run` confirms the tarball omits both `bin/claude-via-proxy.mjs` and `proxy/*`, so the new proxy path cannot ship to users from the package artifact at all.
- `proxy/upstream.mjs:1-2` and `proxy/upstream.mjs:48-69` hard-code `https.request()` even though `CACHE_FIX_PROXY_UPSTREAM` / `--proxy-upstream` are configurable. Any `http://...` upstream for local simulation or integration testing will fail before the first request is forwarded, which undercuts the review workflow's required sim validation path.
- `proxy/stream.mjs:1-10` defines `requestedModel`, but no code ever populates it from the request body. That misses the directive's requested-vs-served model capture needed for spoofing detection and regresses the telemetry value that Phase 1 was supposed to preserve.

## What Needs Attention
- `test/proxy-wrapper.test.mjs:8-64` never executes `bin/claude-via-proxy.mjs`; it only forks `proxy/server.mjs`. That leaves the actual wrapper lifecycle, arg parsing, readiness polling, `claude` spawn path, and failure handling untested.
- `test/proxy-upstream.test.mjs:17-43` explicitly avoids asserting real header forwarding and would still pass even if the configurable upstream transport is broken. The current tests therefore do not protect the most failure-prone part of `forwardRequest()`.
- `package.json:3` is still versioned as `2.0.3` while the PR is framed as `v3.0.0`. If release semantics matter for downstream install and communication, that metadata should be updated in the implementation PR rather than later.

## Recommendations
- Update package metadata so the publish artifact includes the new runtime files and exposes the wrapper entrypoint that users are meant to run.
- Select the outbound transport from `new URL(config.upstream).protocol` and add an integration test that successfully forwards through a local `http://127.0.0.1:<port>` fake upstream.
- Parse the collected request body once in `server.mjs`, set `telemetry.requestedModel`, and add a test that verifies requested-versus-served model capture across a proxied SSE response.
- Replace the current wrapper smoke test with one that runs `bin/claude-via-proxy.mjs` against stubbed `claude` and proxy children so the wrapper contract is actually exercised.

## Bottom Line
Revise before approval. The basic proxy skeleton is in place, but this PR is not yet shippable as `v3.0.0`: the published package would not contain the new runtime, configurable non-TLS upstreams are broken despite being part of the interface, and requested-versus-served model telemetry is still missing.
