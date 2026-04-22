# Review: Proxy v3 Implementation Re-Review

Date: 2026-04-20
Reviewed: package.json, proxy/upstream.mjs, proxy/server.mjs, bin/claude-via-proxy.mjs, test/proxy-*.test.mjs
Label applied: changes-requested

## What Is Correct
- The previously reported implementation blockers are addressed in `9e498aa`: the package artifact now includes `bin/` and `proxy/`, the wrapper has a published `bin` entry, `forwardRequest()` selects `http` versus `https` transport by upstream protocol, and `server.mjs` now captures `requestedModel` from the request body before streaming begins.
- The wrapper tests now exercise `bin/claude-via-proxy.mjs` itself rather than only forking the proxy server. Local verification confirmed the missing-`claude` path, `ANTHROPIC_BASE_URL` scoping, and child exit-code propagation.
- `npm pack --dry-run` now includes the proxy runtime files and wrapper entrypoint, so the package-shipping blocker from the previous review is resolved.

## Blockers
- `test/proxy-upstream.test.mjs:1` still does not terminate cleanly under Node's test runner. `timeout 20s node --test test/proxy-upstream.test.mjs` prints both assertions as passed, but the process never exits on its own and ends with the file cancelled: `'Promise resolution is still pending but the event loop has already resolved'`. The same issue prevents `npm test` from completing cleanly in local verification. Until the suite exits successfully without an external timeout, the implementation is not ready for approval.

## What Needs Attention
- `test/proxy-upstream.test.mjs:7-43` still does not actually verify the new `http://` upstream path or header forwarding against a live local upstream. The code fix itself looks correct, but the test coverage remains weaker than the change it is meant to protect.
- `proxy/server.mjs:24-30` and `:54-55` now populate `requestedModel`, but there is still no explicit test proving requested-versus-served model capture works through a proxied request.
- `test/proxy-wrapper.test.mjs:92-145` uses 15-second watchdog timers that are not cleared after successful exits. They eventually drain, but they also stretch wrapper-test runtime to roughly 18 seconds in local runs.

## Recommendations
- Fix `test/proxy-upstream.test.mjs` so `node --test` exits without external timeouts, then re-run the full suite and report the clean result.
- Replace the current upstream smoke test with a real local `http://127.0.0.1:<port>` forwarding assertion so the protocol-selection fix is covered by execution, not just inspection.
- Add a focused test for `requestedModel` telemetry capture and clear the wrapper watchdog timers once each child process exits.

## Bottom Line
The main code blockers from the prior review are resolved, but I still would not approve this implementation yet because the local verification bar is not met: `npm test` does not finish cleanly, and the isolated failure points back to `test/proxy-upstream.test.mjs`. Fix the hanging test path, then this should be close to approval.
