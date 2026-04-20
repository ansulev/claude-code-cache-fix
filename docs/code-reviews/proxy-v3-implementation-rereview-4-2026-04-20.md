# Review: Proxy v3 Implementation Re-Review 4

Date: 2026-04-20
Reviewed: ca83d3a
Label applied: changes-requested

## What Is Correct
- `ca83d3a` directly targets the two previously reported wrapper-test failure modes by removing deferred cleanup exit logic and changing the spawned `claude` child to use piped stdout/stderr relayed through the wrapper.
- The updated wrapper implementation in `bin/claude-via-proxy.mjs` matches the intent described in the PR comment.

## Blockers
- The fix does not pass local verification. The exact commands the PR comment cites as passing still fail here:
  - `node --test test/proxy-wrapper.test.mjs` failed at `test/proxy-wrapper.test.mjs:129-147` because the wrapper exited `0` instead of propagating fake-claude exit code `42`.
  - `node --test test/proxy-wrapper.test.mjs test/proxy-server.test.mjs test/proxy-upstream.test.mjs test/proxy-stream.test.mjs` failed at both `test/proxy-wrapper.test.mjs:100-126` (empty `BASE_URL=...` output) and `:129-147` (exit code `1` instead of `42`).
  - `npm test` failed with the same two wrapper assertions.
- Because the reported fix is not reproducible under local verification, the branch still does not have a dependable clean test run and cannot be approved.

## What Needs Attention
- The continued variance strongly suggests the wrapper test harness is still interacting badly with shared state or process timing. The repo-local `.test-bin/claude` shim remains shared across multiple tests in the same file, and the assertions still depend on shell-script behavior plus inherited process lifecycle.
- This is no longer an “unverified concern”; the failing commands were rerun after the fix and still fail.

## Recommendations
- Reproduce locally with the exact commands above and inspect the wrapper-test harness first, especially shared fake-binary state and child-process exit timing.
- Do not treat the wrapper reliability issue as resolved until those commands pass cleanly and repeatably on the branch under review.

## Bottom Line
I re-reviewed the latest claimed wrapper reliability fix in `ca83d3a`. The implementation change is present, but the verification result is unchanged: wrapper tests still fail locally under the exact commands cited in the PR, so `changes-requested` remains.
