# Directive: Proxy v3.0.0 — Phase 3a (Extension Pipeline)

**Author:** Manager Agent
**Date:** 2026-04-20
**Status:** Draft — pending Codex review
**Branch:** `feature/proxy-v3/extensions` (off `feature/proxy-v3`)
**Ref:** #40

---

## Goal

Add a hot-reloadable extension pipeline to the proxy server. Extensions
transform requests before forwarding and/or responses before returning to
Claude Code. Port the existing preload.mjs fixes into this pipeline as
individual, independently-toggleable extensions.

---

## 1. Extension Pipeline Architecture

### 1.1 Extension Interface

Each extension is an ES module exporting a defined shape:

```javascript
export default {
  name: 'fingerprint-strip',
  description: 'Remove cc_version fingerprint from system prompt',
  enabled: true,
  order: 100,  // lower runs first

  // Called before request is forwarded upstream
  async onRequest(ctx) {
    // ctx.body — parsed JSON request body (mutable)
    // ctx.headers — outbound headers (mutable)
    // ctx.meta — shared metadata bag for cross-extension communication
    // Return: undefined (mutate in place) or { skip: true } to abort forwarding
  },

  // Called after full response is received (non-streaming path)
  async onResponse(ctx) {
    // ctx.status — HTTP status code
    // ctx.headers — response headers (mutable before send)
    // ctx.body — parsed JSON response body (mutable)
    // ctx.meta — same bag from onRequest
  },

  // Called on each SSE event during streaming (optional)
  async onStreamEvent(ctx) {
    // ctx.event — parsed SSE event object
    // ctx.meta — same bag
    // ctx.telemetry — accumulating telemetry record
  },
}
```

### 1.2 Pipeline Execution

Request path:
1. Parse incoming request body
2. Run `onRequest` hooks in `order` ascending for all enabled extensions
3. Forward modified request to upstream

Response/stream path:
1. For streaming: each SSE `data:` line is parsed and passed through `onStreamEvent` hooks
2. For non-streaming: full response is parsed and passed through `onResponse` hooks
3. Modified response/stream is forwarded back to client

### 1.3 Hot Reload

Extensions live in `proxy/extensions/` directory. The pipeline:
- Loads all `.mjs` files from that directory on startup
- Watches the directory for changes (add/remove/modify)
- On change: re-imports the modified module, updates the pipeline registry
- Active requests in-flight are NOT affected (they keep the extension set they started with)
- New requests use the updated pipeline

Config file `proxy/extensions.json` controls enabled/disabled state and order overrides:
```json
{
  "fingerprint-strip": { "enabled": true, "order": 100 },
  "ttl-management": { "enabled": true, "order": 200 },
  "sort-stabilization": { "enabled": true, "order": 300 }
}
```

If an extension is not listed in the config, its module-level `enabled` and `order` defaults apply.

### 1.4 Error Isolation

A failing extension must not crash the proxy or corrupt the request/response:
- Each hook invocation is wrapped in try/catch
- On error: log the error, skip the extension, continue pipeline
- The proxy degrades to transparent forwarding if all extensions fail

---

## 2. Extensions to Port from preload.mjs

Port these existing fixes as individual extensions. Each should be a single
file in `proxy/extensions/`. Preserve the fix logic; adapt the interface from
preload's monkey-patching style to the clean request/response hook model.

### 2.1 Core Cache Fixes (must-have)

| # | Extension | Source in preload.mjs | Purpose |
|---|-----------|----------------------|---------|
| 1 | `fingerprint-strip` | `stabilizeFingerprint()` | Remove cc_version char-index fingerprint from system prompt |
| 2 | `sort-stabilization` | `stabilizeToolOrder()`, `stabilizeMcpOrder()` | Deterministic ordering of tools and MCP definitions |
| 3 | `ttl-management` | `detectTtlTier()`, `injectCacheControl()` | Detect server TTL tier, inject correct cache_control markers |
| 4 | `identity-normalization` | `normalizeIdentity()` | Normalize message identity fields for prefix stability |
| 5 | `fresh-session-sort` | `freshSessionSortFix()` | Fix non-deterministic ordering on first turn |

### 2.2 Observability (should-have)

| # | Extension | Purpose |
|---|-----------|---------|
| 6 | `cache-telemetry` | Extract cache_read/cache_creation from response headers, write to quota-status.json |
| 7 | `request-log` | Optional NDJSON request log (timing, model, token counts) |

### 2.3 Deferred (Phase 3b+)

| # | Extension | Reason for deferral |
|---|-----------|-------------------|
| — | `session-serializer` | Pending coordination with fgrosswig; scope TBD |
| — | `detection-layer` | Phase 4 — monitors for cache-busting patterns without intervening |
| — | `possibility-extractor` | Space Lead's domain — extracts deliberation at compaction time |

---

## 3. Integration with Existing Proxy

### 3.1 Where the Pipeline Hooks In

In `proxy/server.mjs`:
- After `collectBody()` and before `forwardRequest()`: run request pipeline
- In `proxy/stream.mjs` `forwardStream()`: wrap each SSE event through stream pipeline
- After response completes: run response pipeline

### 3.2 Backward Compatibility

- With zero extensions enabled, the proxy behaves identically to Phase 1-2 (transparent forwarding)
- The `proxy/extensions/` directory can be empty — the pipeline handles this gracefully
- Extensions do not affect the health endpoint or non-`/v1/messages` routes

### 3.3 Configuration

Environment variables (existing):
- `CACHE_FIX_PROXY_PORT`, `CACHE_FIX_PROXY_BIND`, `CACHE_FIX_PROXY_UPSTREAM` — unchanged

New:
- `CACHE_FIX_EXTENSIONS_DIR` — path to extensions directory (default: `./proxy/extensions/`)
- `CACHE_FIX_EXTENSIONS_CONFIG` — path to extensions.json (default: `./proxy/extensions.json`)
- `CACHE_FIX_DEBUG` — when truthy, extensions log verbose output to stderr

---

## 4. Testing Requirements

### 4.1 Pipeline Tests

- Extension loading (valid module, invalid module, empty directory)
- Execution order (verify lower `order` runs first)
- Error isolation (one extension throws, others still run, request succeeds)
- Hot reload (add file → pipeline updates; remove file → extension deregistered)
- Config override (extensions.json disabled flag honored)

### 4.2 Per-Extension Tests

Each ported extension needs:
- Unit test with a sample request/response pair showing the transformation
- Assertion that the fix matches preload.mjs behavior (same input → same output)
- Test with extension disabled (passthrough, no modification)

### 4.3 Integration Test

- Start proxy with all extensions enabled
- Send a realistic CC-shaped request (system prompt with fingerprint, unsorted tools, no cache_control)
- Verify the request that reaches upstream has: fingerprint stripped, tools sorted, cache_control injected
- Verify response headers are captured in telemetry

---

## 5. Deliverables

1. `proxy/pipeline.mjs` — extension pipeline loader, registry, executor
2. `proxy/extensions/` — directory with ported extensions (5-7 files)
3. `proxy/extensions.json` — default configuration
4. `proxy/watcher.mjs` — hot-reload file watcher
5. Updated `proxy/server.mjs` and `proxy/stream.mjs` — pipeline integration points
6. Tests — pipeline + per-extension + integration
7. Updated `package.json` — any new files in `files` array

---

## 6. Success Criteria

- [ ] All 5 core cache fixes ported and passing tests
- [ ] Hot reload works (add/remove extension without restart)
- [ ] Error in one extension does not affect others or crash proxy
- [ ] Proxy with all extensions enabled passes sim validation (real CC traffic)
- [ ] `npm pack --dry-run` includes all new files
- [ ] Zero regressions in existing 181 tests

---

## 7. Non-Goals (explicitly out of scope)

- Session serialization (Phase 3b, pending fgrosswig coordination)
- Detection/alerting layer (Phase 4)
- Possibility space extraction hooks (Space Lead's domain)
- Dashboard or visualization
- Remote deployment support
