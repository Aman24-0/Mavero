# docs/qa — untracked QA output directory

This directory is **intentionally untracked** as of cleanup Phase 2 (2026-10-19).

It previously stored 51 committed QA artifacts (manual verification screenshots,
per-viewport capture matrices, and 4 committed regression `.log` files — about
3.0 MB), which are still recoverable from git history:

```
git log --oneline --follow -- docs/qa        # commits that touched the artifacts
git show <commit>:"docs/qa/<file>" > <file>  # recover an individual artifact
```

The archived historical round reports under `docs/archive/round-reports/` and the
root `WORKLOG.md` reference these artifacts by name; the git history is the
authoritative record for them.

**Local QA runs may recreate this directory freely** — the one-off verification
scripts (e.g. `scripts/followup2_live_verification.mjs`) `mkdir -p` it themselves
(`fs.mkdirSync(..., { recursive: true })`), and nothing in the test chain, CI, or
build reads from it. Do not re-commit generated QA screenshots or logs.

## Recoverable verification screenshots (untracked 2026-10-20)

Two manual verification screenshots that used to live at `docs/` root —
`mavero-mobile-verification.png` (278 KB) and
`mavero-landscape-verification.png` (138 KB) — were untracked in the
post-roadmap comprehensive audit (2026-10-20) by the same policy as the
artifacts above: zero references anywhere in the repository (docs, source,
tests, CI, configs), binary weight off the tree, full recovery from git
history:

```
git log --oneline --all -- docs/mavero-mobile-verification.png docs/mavero-landscape-verification.png
git show <commit>:docs/mavero-mobile-verification.png > mavero-mobile-verification.png
```

Do not re-commit them; if a future document needs them, link the git-history
recovery instead.
