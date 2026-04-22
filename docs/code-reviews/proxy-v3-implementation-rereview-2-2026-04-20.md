# Review: Proxy v3 Implementation Re-Review 2

Date: 2026-04-20
Reviewed: test/proxy-upstream.test.mjs, test/proxy-stream.test.mjs, test/proxy-wrapper.test.mjs
Label applied: changes-requested

## What Is Correct
- The prior upstream-test blocker is resolved. `test/proxy-upstream.test.mjs` now uses a local HTTP fake upstream instead of the real Anthropic endpoint, and it verifies real `http://` forwarding, request-header stripping, response-header stripping, `accept-encoding: identity`, and abort behavior.
- The requested-vs-served telemetry follow-up is partially addressed. `test/proxy-stream.test.mjs` now asserts that `requestedModel` survives streaming once set upstream.
- The package artifact remains correct. `npm pack --dry-run` still includes `bin/claude-via-proxy.mjs` and `proxy/*`.

## Blockers
- The test suite is still not reliable enough for approval. Both `node --test test/proxy-wrapper.test.mjs test/proxy-server.test.mjs test/proxy-upstream.test.mjs test/proxy-stream.test.mjs` and the full `npm test` failed locally, but with different wrapper-test failures on different runs:
  - `test/proxy-wrapper.test.mjs:129-147` failed once because the wrapper exited `0` instead of propagating the fake claude exit code `42`.
  - `test/proxy-wrapper.test.mjs:100-126` failed on subsequent runs because expected child stdout (`BASE_URL=...`) was empty during the full suite, even though the same file passed in isolation.
  This is now a flaky verification path rather than the old upstream hang, but it is still blocking because the PR does not have a stable passing test run under the normal suite command.

## What Needs Attention
- `test/proxy-wrapper.test.mjs:100-147` relies on a shared repo-local `.test-bin/claude` shim and watchdog timers that are never cleared. That setup is a plausible source of the non-deterministic behavior seen under suite execution.
- `test/proxy-wrapper.test.mjs:102-104` shells out to `curl` inside the fake `claude` script, which adds another external dependency to a test that is already sensitive to process/stdout timing.
- The implementation itself may be correct here; the failure evidence points more strongly to test harness instability than to a confirmed runtime defect. But until the harness is stable, approval should stay blocked.

## Recommendations
- Make the wrapper tests hermetic: avoid shared mutable shim paths where possible, clear watchdog timers after successful exits, and remove unnecessary external process dependencies such as `curl`.
- Re-run `node --test test/proxy-wrapper.test.mjs test/proxy-server.test.mjs test/proxy-upstream.test.mjs test/proxy-stream.test.mjs` and `npm test` until they pass cleanly and repeatably without variance between runs.
- If the wrapper logic is correct and only stdout capture is flaky, tighten the assertion method so it validates `ANTHROPIC_BASE_URL` without depending on inherited stdio timing.

## Bottom Line
The original upstream hang is fixed, and the new upstream tests are substantially better. I still cannot approve because the wrapper verification became flaky under real suite execution, which means the branch still does not have a dependable clean test run.
