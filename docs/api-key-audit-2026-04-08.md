# API Key Audit — 2026-04-08

Internal reference. Prompted by Alpha2Zulu1872's report on #41930 of 864K tokens
billed to a manually disabled key at 3 AM with no user activity.

## Our Account

Admin API key used to query all keys via `/v1/organizations/usage_report/messages`.

### Keys

| Key | Name | Status | Usage Period | Notes |
|-----|------|--------|-------------|-------|
| apikey_01Biv694 | prompt_dev | Active | Zero API usage | All CC work is Max subscription, not API-billed |
| apikey_018AXruo | kanfei | Active | Mar 13-14 | Legitimate kanfei nowcast analyst calls |
| apikey_015Z64gE | igraph-prod | Active | Zero | Never used |
| apikey_01X7sMwS | igraph | Archived | Zero — ever | Legacy key, never had usage |
| apikey_018CaVvK | davis-wx-app | Inactive | Mar 1-7 | Kanfei analyst. Stopped clean when deactivated |

### davis-wx-app Detail (the only key with significant usage)

| Date | Uncached Input | Cache Create 5m | Cache Read | Output |
|------|---------------|-----------------|------------|--------|
| Mar 1 | — | — | — | 243,109 |
| Mar 2 | — | — | — | 153,070 |
| Mar 3 | — | — | — | 300,359 |
| Mar 4 | 10,051,250 | 93,550 | 802,877 | 779,606 |
| Mar 5 | — | — | — | 687,376 |
| Mar 6 | — | — | — | 412,841 |
| Mar 7 | — | — | — | 269,453 |

Totals: 44M uncached input, 3.1M cache create (ALL 5m TTL, zero 1h), 3M cache read, 2.8M output.

Note: Daily breakdown only shows full fields for Mar 4 (the day we queried individually).
The summary endpoint reports input_tokens=0 because the field is named `uncached_input_tokens`.

### Findings

- **No phantom usage on disabled/archived keys** — davis-wx-app stopped cleanly when deactivated
- **No anomalous input:output ratios** — all usage is consistent with kanfei analyst workload
- **No usage during inactive hours** — no 3 AM spikes, no usage when key was disabled
- **Zero 1h TTL on API key** — davis-wx-app was always on 5m TTL (standard API, not Max subscription)

### Conclusion

Alpha2Zulu1872's issue is not present on our account. Their scenario (864K tokens on a disabled key at 3 AM, 100% cache rate, 482:1 ratio) suggests either:
1. A leaked/compromised key being used by an unauthorized party
2. A server-side billing attribution bug in Anthropic's infrastructure
3. An automated process (CI/CD, cron, background agent) they forgot about

We have no data to distinguish between these possibilities.

## Data Source

Admin API: `https://api.anthropic.com/v1/organizations/usage_report/messages`
Queried: 2026-04-08 ~18:30 UTC
