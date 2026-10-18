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
