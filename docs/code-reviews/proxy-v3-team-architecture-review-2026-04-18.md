# Review: Proxy v3 Team Architecture

Date: 2026-04-18
Reviewed: docs/proxy-v3-team-architecture.md
Label applied: changes-requested

## What Is Correct
- The split between pre-first-byte and post-first-byte failure handling is the right boundary for an SSE client. Retrying after any streamed `message_start` data would risk duplicate state in Claude Code.
- Requiring streaming passthrough with backpressure is correct. A proxy that buffers the full response would change Claude Code behavior and mask streaming bugs instead of preserving them.
- Scoping `ANTHROPIC_BASE_URL` to the launched Claude child process is the right wrapper design. It avoids contaminating unrelated local processes.
- Keeping the proxy loopback-only and TLS on the outbound leg is the right security baseline for v3.

## Blockers
- `docs/proxy-v3-team-architecture.md:78` says to "Forward all request headers" and "Forward all response headers" unchanged. That is not correct for an HTTP proxy. Hop-by-hop and connection-specific headers such as `host`, `connection`, `keep-alive`, `transfer-encoding`, `content-length`, and similar headers cannot be forwarded blindly without risking malformed requests, broken streaming, or protocol bugs. The design needs an explicit header policy: which headers are preserved, which are recomputed, and which are stripped.
- `docs/proxy-v3-team-architecture.md:101`, `docs/proxy-v3-team-architecture.md:106`, and `docs/proxy-v3-team-architecture.md:117` under-specify response telemetry relative to the current repo behavior. `preload.mjs` extracts quota headers immediately and parses both `message_start` usage and `message_delta` usage from the SSE stream to derive cache TTL, cache hit data, and final output tokens. The proposed plan only mentions parsing `message_delta`, which is insufficient to preserve existing monitoring behavior and conflicts with the stated context that detection/monitoring is core value going forward.
- `docs/proxy-v3-team-architecture.md:95` says all non-`/v1/messages` paths return `404`, while `docs/proxy-v3-team-architecture.md:138` and `docs/proxy-v3-team-architecture.md:163` propose an HTTP health check on `/health`. The server contract and wrapper contract disagree. This needs to be resolved in the design before implementation starts.

## What Needs Attention
- `docs/proxy-v3-team-architecture.md:123` through `docs/proxy-v3-team-architecture.md:128` asks to verify proxy logs, but the design only forbids logging API keys. That is too narrow for a component handling full prompts, tool payloads, and response bodies. The spec should explicitly forbid request/response body logging by default and require redaction for any header or metadata logging.
- `docs/proxy-v3-team-architecture.md:79` and `docs/proxy-v3-team-architecture.md:113` cover timeout duration but not cancellation behavior. The design should specify how client disconnects, upstream aborts, and wrapper shutdown propagate `AbortSignal` or socket teardown in both directions to avoid hanging streams and orphaned upstream requests.
- `docs/proxy-v3-team-architecture.md:56` places tests after all phases. For this project, SSE framing, header filtering, and shutdown semantics are critical-path behavior and should have phase-local tests as each subsystem lands, not only at the end.
- `docs/proxy-v3-team-architecture.md:52` says Phase 3 will "load 16 extensions, run in-process," but this architecture draft does not yet define ordering, state ownership, or kill-switch behavior for those extensions. That omission is acceptable for a first proxy transport draft, but it will become a design gap before implementation of the extension pipeline begins.

## Recommendations
- Replace the "forward all headers" rule with an explicit transparent-proxy header policy. Preserve end-to-end Anthropic and SDK headers, but strip or recompute hop-by-hop headers on both request and response paths.
- Split response telemetry into two defined mechanisms: immediate response-header capture, and bounded SSE event parsing that extracts `message_start` and `message_delta` usage without full-response buffering.
- Decide now whether readiness is a TCP-connect check or an HTTP `/health` endpoint. Either is fine, but the server and wrapper specs need to agree.
- Add a logging section to the design: default-off request logging, no body logging, no authorization logging, and explicit redaction rules for any future debug mode.
- Add early tests for stream framing, upstream mid-stream failure propagation, client disconnect handling, and header normalization before Phase 3 work starts.

## Bottom Line
Revise before implementation. The transport direction is sound, and the retry/streaming model is mostly correct, but the current draft is still too loose in three places that will materially affect correctness: HTTP header handling, telemetry parity with the existing preload behavior, and the server/wrapper readiness contract. Once those are tightened, this is a reasonable foundation for v3.
