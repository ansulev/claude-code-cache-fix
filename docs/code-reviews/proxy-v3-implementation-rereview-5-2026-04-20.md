# Review: Proxy v3 Implementation Re-Review 5

Date: 2026-04-20
Reviewed: 0dcadab
Label applied: changes-requested

## What Is Correct
- `0dcadab` again targets the right wrapper failure modes: it replaces `pipe()` with explicit `data` handlers and switches the child lifecycle handler from `"exit"` to `"close"`.
- The committed wrapper code matches the PR explanation for this latest attempted fix.

## Blockers
- The branch still does not pass local verification under the exact commands named in the PR:
  - `node --test test/proxy-wrapper.test.mjs` still fails at `test/proxy-wrapper.test.mjs:129-147`, with the wrapper exiting `0` instead of propagating fake-claude exit code `42`.
  - `node --test test/proxy-wrapper.test.mjs test/proxy-server.test.mjs test/proxy-upstream.test.mjs test/proxy-stream.test.mjs` still fails at `test/proxy-wrapper.test.mjs:100-126` because expected child stdout (`BASE_URL=...`) is empty, and also fails the exit-code assertion (`1` instead of `42`).
  - `npm test` still fails on the same wrapper stdout assertion.
- Because these failures still reproduce after the latest fix, the wrapper reliability issue remains unresolved and approval is still blocked.

## What Needs Attention
- The latest code change did not eliminate the underlying wrapper-test instability in this environment.
- The stdout-path and exit-code-path assertions are still sensitive to the wrapper test harness and/or process model in a way that is not yet under control.

## Recommendations
- Reproduce locally with the exact three commands above and debug the wrapper tests with that exact invocation order.
- Do not clear review state until those commands pass cleanly and repeatably on the PR branch itself.

## Bottom Line
I re-reviewed the latest wrapper-race fix in `0dcadab`. The intended changes are present, but the verification outcome is still not clean, so `changes-requested` remains.
