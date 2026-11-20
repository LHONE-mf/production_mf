# Production MF — integration checkpoint (20 November 2026)

This document records the approved **source-code merge** scope, not authorization to deploy the PWA, server or production Android APK or to modify factory data.

## Consolidated source chain

- #40 task synchronization correctness and offline-safe data handling;
- #46 shared manufacturing-room navigation;
- #48 approved five-task integration: sync, Android UI, warehouse, Cutting→Sorting, APK tests;
- #49 Android room layout;
- #50 and #51 optional per-electrode measurement foundations (operator UI now deliberately collapses them);
- #53 aggregate tap counters and manual Mass grades/under/over rejection;
- #54 focused warehouse three-section workflow, Chief-authorized KD creation before Cutting receipt, and workshop-key setup during explicit offline packet handoff.

These are nested **ancestor commits** of the integration branch; do not cherry-pick stacked PRs a second time.
The separately proposed roadmap #47 remains an unapproved planning document and is not a product feature. Older overlapping draft PRs require comparison; do not merge unreviewed alternatives merely because they are open.

## Release controls and residual work

- PWA deployment is **manual-only** via GitHub Actions workflow_dispatch, even on main. Source merge is not factory release approval.
- Web build, Android artifact builds, and disposable CI PostgreSQL tests may run automatically. They do not ship an APK to devices or migrate a production DB.
- The Android key may be public development signing; production signing and signature compatibility require independent verification.
- Never clear/uninstall an installation carrying local offline manufacturing journals, drafts, pending outboxes or attachments.
- Per-electrode mass acquisition is future optional work, not required for operators with analog thickness gauges.
- Incoming inspection number → stock → issuance → actual Slurry consumption → downstream immutable genealogy still needs verified server-bound source evidence.
- Finished-cell acceptance from Formation, including QA and physical release, is unfinished. Electrode outputs should follow room custody, not be treated as warehouse finished goods.
- Multi-device physical receipt with verified IDs, independent roles, live TLS server, staging data recovery, and live OnePlus acceptance are **not proven** by source CI.

## Merge gate

Require one exact integration commit on a PR targeted to main with successful web/Android frontend checks, full server + disposable PostgreSQL/browser/restore CI, and a no-deploy review. If any relevant test fails, leave the integration PR unmerged until fixed. Do not squash or rewrite source identity casually.
