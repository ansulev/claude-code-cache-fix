# Changelog

## 1.0.0 (2026-04-06)

Initial release. Fixes three prompt cache bugs in Claude Code (tested through v2.1.92):

- **Partial block scatter on resume** — Relocates attachment blocks (skills, MCP, deferred tools, hooks) back to `messages[0]` when they drift to later messages during `--resume`
- **Fingerprint instability** — Stabilizes the `cc_version` fingerprint by computing it from real user text instead of meta/attachment blocks
- **Non-deterministic tool ordering** — Sorts tool definitions alphabetically for consistent cache keys across turns
