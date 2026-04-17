# CLAUDE.md — claude-code-cache-fix

## Release Safety Rules

Production systems depend on this package. These rules are non-negotiable.

1. **Contributors rebase against current main before requesting review.** No manual cherry-picks or conflict resolution in the fix pipeline. Clean fast-forward merges only. If a PR has conflicts, ask the contributor to rebase — do not resolve conflicts yourself.

2. **Never tag or publish without running the full test suite on the exact commit being released.** No shortcuts under time pressure. Tests must pass at the tagged commit, not "they passed a few commits ago."

3. **Review what ships to npm.** Run `npm pack --dry-run` before `npm publish` and verify the tarball contents. Tests passing is necessary but not sufficient — confirm the packaged artifact is what you expect.

4. **Merge one PR at a time, sequentially.** Merge, test, push. Then the next PR rebases on that. No batching multiple merges before testing. Slower but dramatically safer when the core artifact is a single 2000+ line file.
