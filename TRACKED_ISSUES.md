# Tracked GitHub Issues — Claude Code Cache & Context Bugs

Issues we are actively monitoring, have commented on, or are directly relevant to our interceptor work.

Last updated: 2026-04-08

## Legend

- **Engaged** — We have posted comments with data/fixes
- **Monitoring** — Relevant to our work, watching for developments
- **New** — Recently discovered, not yet engaged

---

## Engaged Issues (we've posted on these)

| # | Title | State | Our involvement |
|---|-------|-------|-----------------|
| [#34629](https://github.com/anthropics/claude-code/issues/34629) | Prompt cache regression in --resume (~20x cost) | Closed | Root cause analysis, interceptor fix. Original bug that started this work. |
| [#40524](https://github.com/anthropics/claude-code/issues/40524) | Conversation history invalidated on subsequent turns | Closed | Image persistence discovery, fingerprint analysis, Renvect collaboration. Multiple posts. |
| [#42052](https://github.com/anthropics/claude-code/issues/42052) | Max 20x plan: 100% usage after 2 hours | Open | Bidirectional TTL data, overage mechanism analysis. TigerKay1926 has contradicting data (stuck 5m TTL). |
| [#42260](https://github.com/anthropics/claude-code/issues/42260) | Resume loads disproportionate tokens from thinking signatures | Open | Posted analysis of opaque thinking token overhead. |
| [#27048](https://github.com/anthropics/claude-code/issues/27048) | Prompt cache invalidation on resume: plugin state changes | Open | Posted interceptor as solution, replied to thoeltig re: plugin registration logic (2026-04-08). |

## Monitoring — Directly relevant

| # | Title | State | Why it matters | Fresh activity |
|---|-------|-------|---------------|----------------|
| [#44045](https://github.com/anthropics/claude-code/issues/44045) | Prompt cache partial miss on every --resume turn | Open | Exact bug our interceptor fixes (skill_listing block missing from messages[0]). SDK-level repro with token measurements. | 2026-04-08 |
| [#44724](https://github.com/anthropics/claude-code/issues/44724) | Subagent cache miss on first SendMessage resume | Open | Same root cause but for subagents/SendMessage. May need interceptor extension. | 2026-04-08 |
| [#42542](https://github.com/anthropics/claude-code/issues/42542) | Silent context degradation — microcompact, cached microcompact, session memory compact | Open | Documents 3 context clearing mechanisms. Aligns with our microcompact monitoring. 20 comments, active thread. | 2026-04-08 |
| [#45188](https://github.com/anthropics/claude-code/issues/45188) | System prompt grew ~70K tokens between v2.1.89 and v2.1.96 | Open | System prompt bloat directly impacts cache cost. May explain rising quota burn rates. | 2026-04-08 |
| [#43044](https://github.com/anthropics/claude-code/issues/43044) | --resume loads 0% context on v2.1.91 | Open | Three regressions in session loading pipeline, source-code verified. Listed in our README. | 2026-04-04 |
| [#43657](https://github.com/anthropics/claude-code/issues/43657) | Resume/continue cache invalidation | Open | Confirms resume cache invalidation on v2.1.92. Listed in our README. | 2026-04-04 |

## Monitoring — Related (quota/cost/context)

| # | Title | State | Why it matters |
|---|-------|-------|---------------|
| [#38335](https://github.com/anthropics/claude-code/issues/38335) | Max plan limits exhausted abnormally fast since March 23 | Open | 466 comments. Mega-thread on quota drain. Cache bugs are a contributing factor. |
| [#38239](https://github.com/anthropics/claude-code/issues/38239) | Extremely rapid token consumption | Open | 62 comments. Parallel thread to #38335. |
| [#41930](https://github.com/anthropics/claude-code/issues/41930) | Critical: Widespread abnormal usage drain — multiple root causes | Open | 39 comments. Best-organized analysis of the multi-cause problem. |
| [#16157](https://github.com/anthropics/claude-code/issues/16157) | Instantly hitting usage limits with Max subscription | Open | 1,440 comments. The original mega-thread. |
| [#6457](https://github.com/anthropics/claude-code/issues/6457) | 5-hour limit reached in less than 1h30 | Open | 119 comments. Long-running thread. |
| [#40851](https://github.com/anthropics/claude-code/issues/40851) | Opus 4.6 (Max $100) — Quota reaches 93% after minimal prompting | Open | 16 comments. Single-session quota drain. |
| [#41617](https://github.com/anthropics/claude-code/issues/41617) | Excessive token consumption after recent updates | Open | 16 comments. Post-update cost spike. |
| [#41583](https://github.com/anthropics/claude-code/issues/41583) | Rate limit errors on Pro Plan at 26% usage | Open | Rate limit stuck per-session, contradicts docs. |
| [#33949](https://github.com/anthropics/claude-code/issues/33949) | SSE streaming hangs indefinitely | Open | Root cause analysis with fix proposals. Affects session stability. |
| [#34556](https://github.com/anthropics/claude-code/issues/34556) | Persistent memory across context compactions | Open | 59 compactions documented. Related to our memory/CLAUDE.md approach. |

## Community Research

| Resource | Author | Relevance |
|----------|--------|-----------|
| [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) | @ArkNill | 7 bugs: microcompact, budget caps, false rate limiter, JSONL duplication, extended thinking quota |
| [X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor) | @Renvect | HTTPS proxy with dashboard, system prompt diffing, per-tool stripping thresholds |

## Key People

| User | Contribution |
|------|-------------|
| @TigerKay1926 | Detailed TTL tracking data showing stuck 5m TTL even at 0% quota. Contradicts our bidirectional findings — may indicate second mechanism. |
| @thoeltig | Plugin registration logic analysis (#27048). Raised architectural concern about CC rewriting conversation start without intermediate messages. |
| @Renvect | Image duplication discovery, cross-project contamination, X-Ray proxy. Active collaborator on #40524. |
| @jmarianski | MITM proxy + Ghidra reverse engineering of standalone binary. Multi-mode cache test script. |
| @VictorSun92 | Original monkey-patch fix for v2.1.88, partial scatter detection on v2.1.90. |
| @ArkNill | Systematic proxy-based analysis of 7 hidden bugs. Microcompact/budget/false-rate-limiter documentation. |
| @bilby91 | SDK-level reproduction of skill_listing block missing from messages[0] (#44045). Clean minimal repro. |
| @Sn3th | Comprehensive microcompact/context degradation documentation (#42542). Three clearing mechanisms identified. |
| @kolkov | Source-code verified analysis of 3 regressions in session loading pipeline (#43044). |
| @labzink | Subagent/SendMessage cache miss discovery (#44724). |

---

## Issues needing our attention

### Should comment on (have relevant data):
- **#44045** — Our interceptor directly fixes the skill_listing bug they describe. Should post.
- **#44724** — Subagent variant of the same bug. Worth investigating if our interceptor helps.
- **#42542** — Our microcompact monitoring detects exactly what they document. Could share findings.

### Should investigate:
- **#45188** — System prompt grew 70K tokens? If true, this directly impacts our cache costs. Need to verify against our own system prompt data.
