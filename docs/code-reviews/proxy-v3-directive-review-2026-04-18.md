# Review: Proxy v3 Directive

Date: 2026-04-18
Reviewed: docs/proxy-v3-directive.md
Label applied: changes-requested

## What Is Correct
- The prior three blockers are materially addressed. The directive now has an explicit hop-by-hop header policy, captures both `message_start` and `message_delta` usage for telemetry parity, and aligns the proxy and wrapper on a `/health` readiness check.
- The streaming model is still the right one: no full-response buffering, explicit backpressure, and a clear pre-first-byte vs post-first-byte failure boundary are all correct for Claude Code's SSE behavior.
- The security posture is improved. Loopback-only inbound transport, outbound TLS, scoped `ANTHROPIC_BASE_URL`, no body logging, and explicit abort propagation are the right defaults for a proxy that handles prompts and API credentials.
- Per-phase test expectations are now placed on the critical path instead of being deferred to the end, which is the right change for transport work.

## Blockers
- `docs/proxy-v3-directive.md:80` through `docs/proxy-v3-directive.md:84` and `docs/proxy-v3-directive.md:107` through `docs/proxy-v3-directive.md:119` still do not define a `content-encoding` policy. The proxy plans to parse SSE `data:` lines in `stream.mjs`, but it does not say whether it forbids compressed upstream responses by stripping/overriding `accept-encoding`, or whether it will decompress and then rewrite `content-encoding` and related headers before forwarding. That gap is transport-critical: a compressed SSE body is not parseable as line-delimited text, and silently assuming plaintext would make the design incorrect if the upstream ever enables compression.

## What Needs Attention
- `docs/proxy-v3-directive.md:117` says `message_delta` carries `stop_reason` inside the final usage object. That is not the Anthropic event shape. `message_delta` carries output-token usage plus a separate delta payload for stop reason. The directive should name those fields correctly so the implementation does not key off the wrong JSON path.
- `docs/proxy-v3-directive.md:110`, `docs/proxy-v3-directive.md:115` through `docs/proxy-v3-directive.md:119`, and `docs/proxy-v3-directive.md:127` through `docs/proxy-v3-directive.md:130` blur the Phase 1 vs Phase 4 boundary. The file says Phase 1 does not include response capture/logging, but the proposed Phase 1 stream/parser already assembles the telemetry record. That should be tightened: either Phase 1 only exposes parser hooks and Phase 4 persists telemetry, or the phase table should be updated to reflect that telemetry capture starts in Phase 1.
- `docs/proxy-v3-directive.md:81` is still narrower than the existing `preload.mjs` behavior on response metadata. `preload.mjs` captures all `anthropic-*` headers plus identifiers such as `request-id` and `cf-ray`, not just rate-limit headers. The directive should make clear that end-to-end response headers are preserved broadly, with hop-by-hop stripping as the exception.

## Recommendations
- Add one explicit rule for transfer codings and content codings. Either force identity encoding upstream for streamed SSE inspection, or specify a decompression/recompression path and the exact header normalization that goes with it.
- Correct the SSE event schema language so `message_delta` parsing refers to `event.usage.output_tokens` and the separate stop-reason field in the delta payload.
- Tighten the phase contract around telemetry so the implementation team knows whether Phase 1 is only transport plus parser hooks or transport plus first-pass capture.
- Widen the response-header language from `anthropic-ratelimit-*` to the actual transparent-proxy rule: preserve end-to-end response headers needed by clients and monitoring, strip only hop-by-hop headers.

## Bottom Line
Revise once more before adding `plan-approved`. The directive is much stronger than the earlier draft and most of the important review feedback landed cleanly, but the missing content-encoding decision is still a real transport-design gap for an SSE-parsing proxy. After that is specified, this is close to a sound implementation directive.
