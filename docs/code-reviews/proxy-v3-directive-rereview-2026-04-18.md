# Review: Proxy v3 Directive Re-Review

Date: 2026-04-18
Reviewed: docs/proxy-v3-directive.md
Label applied: reviewed-by-codex-agent

## What Is Correct
- The remaining transport blocker is resolved. The directive now explicitly forces `accept-encoding: identity` on the upstream request and explains why that is necessary for line-oriented SSE parsing.
- The prior major design concerns are now covered: header handling is explicit, telemetry capture includes both `message_start` and `message_delta`, and the readiness contract consistently uses `/health`.
- The transport model remains sound: no full-response buffering, explicit backpressure, correct retry boundary at first byte, loopback-only inbound transport, outbound TLS, and clear abort propagation.
- The security baseline is appropriate for plan approval: scoped `ANTHROPIC_BASE_URL`, no body logging, and no authorization logging.

## Blockers
None

## What Needs Attention
- `docs/proxy-v3-directive.md:118` still describes `stop_reason` as part of the `message_delta` usage object. That wording should be corrected before implementation so the parser reads the right event field.
- `docs/proxy-v3-directive.md:111`, `docs/proxy-v3-directive.md:116` through `docs/proxy-v3-directive.md:120`, and `docs/proxy-v3-directive.md:128` through `docs/proxy-v3-directive.md:130` still blur the Phase 1 versus Phase 4 boundary. The current text says Phase 1 excludes response capture/logging while the proposed parser already assembles a telemetry record.
- `docs/proxy-v3-directive.md:81` still names only `anthropic-ratelimit-*` response headers in the preserve list, while the surrounding text implies a broader transparent-proxy policy. That language could be widened for clarity before implementation starts.

## Recommendations
- Correct the `message_delta` schema wording so implementation does not key off the wrong JSON path.
- Clarify whether Phase 1 only exposes telemetry extraction hooks or whether first-pass telemetry capture formally begins in Phase 1 and persistence lands in Phase 4.
- Widen the response-header wording to reflect the actual end-to-end preservation rule, with hop-by-hop stripping as the exception.

## Bottom Line
Plan approved. The directive now covers the core transport and lifecycle decisions well enough to start implementation. The remaining issues are spec-clarity cleanups, not design blockers.
