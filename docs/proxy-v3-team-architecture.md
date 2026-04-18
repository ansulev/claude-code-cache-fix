# Proxy v3.0.0 — Team Architecture & Design

Date: 2026-04-18
Status: Draft — pending Codex review
Related: https://github.com/cnighswonger/claude-code-cache-fix/issues/40

## Team Structure

### Manager Session (Project Lead)
- **Location:** `~/git_repos/claude` 
- **Model:** Opus 4.6
- **Role:** Strategic decisions, PR review, community coordination, requirements
- Feeds design constraints and requirements to the Proxy Builder
- Relays deafsquad/fgrosswig/wadabum feedback
- Sends implementation plans to Codex Review Agent
- Deep context on the CC community, issues, collaborators, blog series
- Does NOT write proxy code

### Proxy Builder (CC Teammate)
- **Location:** `~/git_repos/claude-code-cache-fix` on `feature/proxy-v3` branch
- **Model:** Opus 4.6
- **Role:** Implementation — proxy server, extension pipeline, launch wrapper, tests
- Works from #40 spec + design refinements from Codex review
- Submits plans for review before implementing
- Follows the `directive-stage → plan-approved → implementation-stage → ready-for-merge` workflow

### Codex Review Agent (External — OpenAI Codex CLI)
- **Location:** `~/git_repos/claude-code-cache-fix_codex`
- **Role:** Independent code review per AGENTS.md
- Reviews plans and implementations via markdown files in `docs/code-reviews/`
- Feedback relayed through Manager or directly consumed by Proxy Builder
- Applies review labels on GitHub

### Proxy Test Agent (New — Dedicated Integration Testing)
- **Location:** TBD (lightweight test repo or `~/git_repos/claude-code-cache-fix` itself)
- **Model:** Opus 4.6 (match production use case)
- **Role:** Dedicated integration test agent for the proxy
- Routes all traffic through our proxy on `127.0.0.1:9801`
- Exercises real CC workloads — tool calls, file reads, edits, subagents
- Validates extension pipeline, cache behavior, detection layer
- Reports issues back to Manager session
- NOT the Kanfei Sim Agent — that agent has its own project and context

---

## Implementation Order

| Phase | Component | Depends On |
|-------|-----------|-----------|
| 1 | Proxy HTTP server (listen, forward, stream SSE) | Nothing |
| 2 | Launch wrapper (`claude-via-proxy`) | Phase 1 |
| 3 | Extension pipeline (load 16 extensions, run in-process) | Phase 1 |
| 4 | Response capture (meter integration, headers, usage) | Phase 1 |
| 5 | Detection module (#39 — structural fingerprinting, drift) | Phase 3 |
| 6 | Remote telemetry (opt-in sanitized reporting) | Phase 5 |
| 7 | Tests (unit + integration) | All phases |
| 8 | Proxy Test Agent validation (live CC traffic) | Phase 2 |

---

## Phase 1: Proxy HTTP Server

### Requirements

A Node.js HTTP server on loopback that:
1. Listens on a configurable port (default: `127.0.0.1:9801`)
2. Accepts POST requests to `/v1/messages` (the only endpoint CC uses)
3. Forwards the request to `https://api.anthropic.com` (or configurable upstream)
4. Streams the SSE response back to the client with proper framing
5. Handles errors cleanly (upstream unreachable, timeout, malformed response)

### Design Constraints

- **No buffering of the full response.** SSE events must be forwarded as they arrive. Claude Code's streaming UI depends on timely chunk delivery — buffering the entire response before forwarding would break the UX.
- **Backpressure.** If the client stops reading (e.g. CC is processing), the proxy must not accumulate unbounded memory. Use `await drain()` or equivalent flow control.
- **Pre-first-byte vs post-first-byte errors.** Pre-first-byte failures (connection refused, DNS, timeout before any response) are retryable by the SDK. Post-first-byte failures (upstream drops connection mid-stream) must propagate to the client as-is — retrying would send duplicate `message_start` SSE events, breaking SDK state. This is the distinction deafsquad flagged from his HOE implementation.
- **TLS.** The proxy listens on plain HTTP (loopback only). The outbound connection to `api.anthropic.com` uses HTTPS. Node's `https` module or `fetch` handles this.
- **Header policy.** The proxy is transparent for end-to-end headers but must handle hop-by-hop headers correctly:
  - **Preserve (forward as-is):** `authorization`, `anthropic-version`, `anthropic-beta`, `anthropic-dangerous-direct-browser-access`, `content-type`, `accept`, `x-stainless-*`, `x-api-key`, all `anthropic-ratelimit-*` response headers
  - **Recompute:** `host` (set to upstream hostname), `content-length` (recalculate after extension pipeline modifies body in Phase 3)
  - **Strip on request:** `connection`, `keep-alive`, `transfer-encoding`, `proxy-*`, `te`, `upgrade`
  - **Strip on response:** `connection`, `keep-alive`, `transfer-encoding` (proxy manages its own chunked encoding to client)
- **Timeout.** CC sets `x-stainless-timeout: 600` (10 minutes). The proxy must not impose a shorter timeout.
- **No auth handling.** The proxy forwards the `Authorization` header as-is. It never reads, stores, or logs API keys.
- **No body logging.** Request and response bodies must never be logged by default. No prompt content, tool payloads, or response text in any log output. Debug mode (future) must use explicit redaction for any metadata logging. Authorization headers must never appear in logs under any mode.

### Proposed Implementation

```
proxy/
  server.mjs          — HTTP server, request handling, SSE forwarding
  upstream.mjs         — HTTPS client to api.anthropic.com
  stream.mjs           — SSE chunk parser and forwarder with backpressure
  config.mjs           — Port, upstream URL, env var overrides
```

**server.mjs:**
- `http.createServer()` on loopback
- Route POST `/v1/messages` → pipeline → upstream → stream back
- Route GET `/health` → 200 OK (used by launch wrapper readiness check)
- All other paths → 404
- Graceful shutdown on SIGTERM/SIGINT

**upstream.mjs:**
- `https.request()` to upstream with forwarded headers
- Returns a readable stream of the response
- Captures response headers for forwarding + response-side processing (Phase 4)

**stream.mjs:**
- Reads chunks from upstream response stream
- Writes to client response with backpressure (`res.write()` + drain events)
- Parses SSE `data:` lines for two event types:
  - `message_start` — captures initial usage object (cache_read, cache_creation, input_tokens) and model identifier (requested vs served for spoofing detection)
  - `message_delta` — captures final usage object (output_tokens, stop_reason) to complete the per-request telemetry record
- Both extractions are bounded reads from parsed JSON — no full-response buffering
- Telemetry record assembled from: response headers (quota, cache tier, rate limits) + `message_start` usage + `message_delta` usage — matching the existing `preload.mjs` capture behavior

**config.mjs:**
- `CACHE_FIX_PROXY_PORT` (default: 9801)
- `CACHE_FIX_PROXY_UPSTREAM` (default: `https://api.anthropic.com`)
- `CACHE_FIX_PROXY_BIND` (default: `127.0.0.1`)
- `CACHE_FIX_PROXY_TIMEOUT` (default: 600000ms)

### What This Phase Does NOT Include
- Extension pipeline (Phase 3)
- Response capture/logging (Phase 4)
- Any modification of request or response bodies
- The launch wrapper (Phase 2)

### Verification

1. Start proxy: `node proxy/server.mjs`
2. In another terminal: `ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude`
3. Verify CC works normally — responses stream, tools work, no errors
4. Verify proxy logs show requests forwarded and responses streamed
5. Kill upstream (or point to invalid host) — verify clean error propagation
6. Test with a long-running response (large file read) — verify no buffering lag

---

## Phase 2: Launch Wrapper

### Requirements

A shell script or Node.js entry point that:
1. Starts the proxy server (Phase 1)
2. Waits for the proxy to be ready (health check on the port)
3. Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:{port}` for the child process only
4. Launches `claude` (or the Bun binary) with all user-provided arguments forwarded
5. On CC exit: shuts down the proxy cleanly
6. On proxy crash: propagates error, does not leave orphaned processes

### Design Constraints

- **Env var scoping.** `ANTHROPIC_BASE_URL` must be set ONLY for the CC child process, not globally. Other processes on the machine (other agents, other tools) should not be affected.
- **Signal forwarding.** SIGINT/SIGTERM to the wrapper must propagate to both the proxy and CC.
- **Port conflicts.** If the default port is in use, either fail with a clear message or auto-select an available port.
- **No root required.** Everything runs as the current user.
- **Cross-platform.** Linux and macOS. Windows via WSL. Native Windows `.bat` is nice-to-have but not required for v3.0.0.

### Proposed Implementation

```
bin/
  claude-via-proxy.mjs  — Launch wrapper entry point
```

**claude-via-proxy.mjs:**
```
1. Parse args (--proxy-port, --proxy-upstream, passthrough args for claude)
2. Fork proxy/server.mjs as a child process
3. Wait for proxy health (HTTP GET to /health → 200 OK)
4. Spawn claude with ANTHROPIC_BASE_URL set, forwarding remaining args
5. On claude exit → kill proxy, exit with claude's exit code
6. On proxy exit → kill claude, exit with error
7. On SIGINT/SIGTERM → kill both, exit
```

**npm package integration:**
- `package.json` `bin` field: `{ "claude-via-proxy": "./bin/claude-via-proxy.mjs" }`
- After `npm install -g claude-code-cache-fix`, user runs `claude-via-proxy` instead of `claude`
- Alternatively: `claude-via-proxy` detects whether CC is Node or Bun and adjusts accordingly

### Verification

1. `claude-via-proxy` starts proxy, launches CC, both run
2. Use CC normally — verify everything works through the proxy
3. Exit CC normally — verify proxy shuts down, no orphans
4. Kill the wrapper (Ctrl+C) — verify both proxy and CC terminate
5. Start with port already in use — verify clear error message
6. Start with CC not installed — verify clear error message

---

## Review Request

This document is the first design submission for the proxy v3.0.0 work. Requesting Codex Review Agent review per the workflow defined in AGENTS.md.

Focus areas:
- Are the Phase 1 design constraints complete? Missing edge cases?
- Is the SSE streaming approach (chunk-by-chunk, no buffering) correct for Claude Code's expectations?
- Is the pre-first-byte vs post-first-byte error distinction correctly specified?
- Is the launch wrapper lifecycle management (fork, health check, signal forwarding) sound?
- Any security concerns with the transparent header forwarding?
