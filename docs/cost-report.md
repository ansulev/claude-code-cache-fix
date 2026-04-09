# Cost Report

Calculate Claude API costs from usage telemetry. Works standalone or with the interceptor.

## Quick Start

If you're using the interceptor, it automatically logs usage to `~/.claude/usage.jsonl`. Just run:

```bash
npx claude-code-cache-fix-cost-report
# or directly:
node /path/to/claude-code-cache-fix/tools/cost-report.mjs
```

That's it — you get a per-call breakdown with costs.

## How It Works

The interceptor writes one JSON line per API call to `~/.claude/usage.jsonl` as it drains the SSE response stream. Each line contains the standard Anthropic usage fields:

```json
{
  "timestamp": "2026-04-09T01:23:45Z",
  "model": "claude-sonnet-4-5-20250929",
  "input_tokens": 50000,
  "output_tokens": 1200,
  "cache_read_input_tokens": 13000,
  "cache_creation_input_tokens": 0,
  "ephemeral_1h_input_tokens": 0,
  "ephemeral_5m_input_tokens": 0,
  "ttl_tier": "1h"
}
```

The cost report reads these records, applies current pricing, and produces a detailed breakdown.

## Usage

```bash
# Default — reads ~/.claude/usage.jsonl
node cost-report.mjs

# Filter to a specific date
node cost-report.mjs --date 2026-04-08

# Filter to last N hours/minutes/days
node cost-report.mjs --since 2h
node cost-report.mjs --since 30m
node cost-report.mjs --since 1d

# From any JSONL file
node cost-report.mjs --file /path/to/telemetry.jsonl

# From a simulation log (extracts "Token telemetry: {...}" lines)
node cost-report.mjs --sim-log /path/to/simulation.log

# Pipe from stdin
cat my-usage.jsonl | node cost-report.mjs

# Cross-reference with Anthropic Admin API for actual billed usage
node cost-report.mjs --admin-key sk-ant-admin01-...

# Refresh bundled pricing from Anthropic docs
node cost-report.mjs --update-rates
```

## Pricing Sources

The tool uses three pricing sources, in priority order:

### 1. Admin API (most accurate)

Pass `--admin-key <key>` or set `ANTHROPIC_ADMIN_KEY` in your environment. The tool queries the Anthropic Admin API (`/v1/organizations/usage_report/messages`) for your actual billed usage during the time window of your telemetry data. This is the authoritative source — no rate calculation needed.

Admin API keys start with `sk-ant-admin01-` and are separate from regular API keys. Get one at [console.anthropic.com](https://console.anthropic.com).

### 2. Live rates from Anthropic docs

Pass `--live-rates` to fetch current pricing from the [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and calculate costs from your telemetry. This gives accurate results without an admin key.

### 3. Bundled rates (default)

Falls back to `tools/rates.json` shipped with this package. The tool warns if rates are older than 30 days. Run `--update-rates` to refresh:

```bash
node cost-report.mjs --update-rates
```

## Output

The report includes:

- **Per-call breakdown** — timestamp, model, input/output/cache tokens, cost, degradation steps
- **Summary** — total calls, token totals by type, total cost, average cost per call
- **Cache savings** — what cache reads saved vs full input pricing
- **Degradation analysis** — if your telemetry includes degradation data (e.g. from a context budget manager)
- **Admin API comparison** — side-by-side telemetry vs actual billed usage (with `--admin-key`)

## Input Format

Each JSON line needs at minimum:

| Field | Required | Description |
|-------|----------|-------------|
| `model` | Yes | Claude model ID (e.g. `claude-sonnet-4-5-20250929`) |
| `input_tokens` | Yes | Input tokens (also accepts `actual_input_tokens`) |
| `output_tokens` | Yes | Output tokens (also accepts `actual_output_tokens`) |
| `timestamp` | No | ISO 8601 timestamp (needed for `--date`/`--since` and Admin API) |
| `cache_read_input_tokens` | No | Tokens read from prompt cache |
| `cache_creation_input_tokens` | No | Tokens written to prompt cache |
| `ephemeral_1h_input_tokens` | No | Cache write tokens at 1h TTL tier |
| `ephemeral_5m_input_tokens` | No | Cache write tokens at 5m TTL tier |

Extended fields (from context budget managers, etc.):

| Field | Description |
|-------|-------------|
| `preflight_input_tokens` | Pre-degradation token estimate |
| `degradation_steps` | Array of degradation actions applied |
| `would_have_exceeded` | Whether the budget would have been exceeded |

## For SDK Users

If you're using the Anthropic SDK directly (not through Claude Code), log usage after each API call:

```javascript
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync } from 'fs';

const anthropic = new Anthropic();

const msg = await anthropic.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});

// Log usage for cost reporting
appendFileSync('usage.jsonl', JSON.stringify({
  timestamp: new Date().toISOString(),
  model: msg.model,
  ...msg.usage,
}) + '\n');
```

Then run: `node cost-report.mjs --file usage.jsonl`

## For Proxy Users

If you're using an intercepting proxy (e.g. [X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)), extract the `usage` object from API responses and write it as JSONL in the format above. The tool accepts any JSONL with the standard Anthropic usage fields.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_ADMIN_KEY` | Admin API key (alternative to `--admin-key`) |
| `CACHE_FIX_USAGE_LOG` | Override the default usage log path (`~/.claude/usage.jsonl`) |

## Pricing Reference

Current rates are in `tools/rates.json`. Run `--update-rates` to refresh from the [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing).

Cache pricing uses multipliers on base input rates:
- **5-minute cache write**: 1.25x base input
- **1-hour cache write**: 2x base input
- **Cache read (hit)**: 0.1x base input
