# Current follow-up — complete count-session export (2026-11-15)

Complete frozen count history is implemented and LOCAL TESTED: the selected session exports open/unapproved/zero/recount observations, separate corrections and closure in one bounded, formula-safe CSV. The API's `throughSequence`/`until` freezes event population and closure together; another device's approval does not alter old exports. The browser verifies byte-identical before-approval CSV after another profile correction, then a refreshed complete history. Native harness verifies the old unapproved snapshot after approval/closure and the actual export control.

Local verification: **664 frontend / 281 actual PostgreSQL server tests**, all frontend/server/native-harness typechecks/builds, real two-profile browser/downloads, active-PWA navigation and actual dump/two-restores comparing 44 tables. Both restored DBs reproduce the original frozen count evidence; changed restore epoch is explicit. Mutation removing the snapshot-closure guard fails its regression; restored code passes. No data/schema/outbox/dependency change, merge or deployment. New-SHA hosted checks are pending publication and will be recorded below.

Audit-detail source `b9e0f4ff3e7c884fb3a1616747afcb9f07e4bd4d` is fully VERIFIED: [Tests 43684637157](https://github.com/LHONE-mf/production_mf/actions/runs/43684637157), [push CI 43684633515](https://github.com/LHONE-mf/production_mf/actions/runs/43684633515), [PR CI 43684637100](https://github.com/LHONE-mf/production_mf/actions/runs/43684637100), [Route A 43684633427](https://github.com/LHONE-mf/production_mf/actions/runs/43684633427). Those links certify that earlier source, not the unpushed count follow-up. Skills/tools/security audit remain as recorded below; all six repo skills and Ponytail FULL/simplification/review used, Graphify stale main confirmed, no agents or new dependencies.

Next: S8 10,000-row/resource/performance acceptance; S9A actual output submit and separate Storage quarantine acceptance; S9B real measured Slurry use, then S10. No claim of finished S9, physical OnePlus/ColorOS handling/QA/count, signed installed upgrade, physical camera/printer, deployed TLS or production backup acceptance.

# Current increment — immutable report evidence (2026-11-15)

Starting branch/PR HEAD `83f32101e95bdfec6b86b5ad6e6286b8d604dfce` remained current and clean; PR #5 stays draft against `feat/hybrid-server-foundation`. Added immutable QA/count/return/split audit detail to the actual movement API, strict client, mobile UI and both formula-safe frozen CSV paths. See [movement contract](STORAGE_MOVEMENT_REPORT.md). No schema/outbox/dependency change; original data and approved D1–D8 rules remain intact.

LOCAL TESTED: **661 frontend / 280 actual PostgreSQL server tests**, frontend/server/native-harness typechecks/builds, real two-profile Chromium and CSV/viewport checks, active-PWA/harness regression, real custom dump/two restores comparing 44 tables. A real 207-event snapshot crosses three PostgreSQL pages, remains frozen against later receiving and exactly matches its ledger population. Removing the count-variance guard makes its regression fail; restored code passes. New-SHA CI/native verification is pending publication and will be recorded here after checking live results.

All six vendored skills and Ponytail FULL plus auxiliary simplification/review remain applied. GitHub live PR/check/branch evidence used; Graphify still indexes old main `0505307`, so current source controls implementation. No agents spawned. Fresh dependency audits retain 0 server advisories and frontend 2 low/6 moderate, no high/critical; the dated reachability review remains applicable. Synthetic fixtures only; no production data, merge or deployment.

Next: independent unapproved count-observation report/export and full 10,000-row/resource acceptance; S9A real output submit/separate Storage quarantine acceptance; S9B measured Slurry use followed by S10 hardening. Physical OnePlus/ColorOS, signed upgrades, factory handling/count/QA, printer/camera, TLS and production restore remain PENDING. The earlier verified sources below certify their named commits only.

# Verified continuation — 2026-11-14

Branch `feat/storage-inventory-foundation`; draft PR https://github.com/LHONE-mf/production_mf/pull/5 against `feat/hybrid-server-foundation`. Starting SHA `d1acf0ba85e08175a3c31030cc68e5698a47f52d`; no newer work/review threads were present. Latest **code** SHA: **ae63127dd0deb6c251470efd6c9b23bc7955927c**. A subsequent documentation-only commit records this result without changing the verified application/native code.

## Exact code-SHA checks — all PASSED

- [Tests 43646282933](https://github.com/LHONE-mf/production_mf/actions/runs/43646282933).
- [Push CI 43646277713](https://github.com/LHONE-mf/production_mf/actions/runs/43646277713): frontend/server, actual PostgreSQL, real two-profile browser/downloads, backup/two restores.
- [PR CI 43646282972](https://github.com/LHONE-mf/production_mf/actions/runs/43646282972).
- [Android Route A 43646277695](https://github.com/LHONE-mf/production_mf/actions/runs/43646277695): actual WebView/native proof, reconciliation and historical-location controls, retained process-death/lost-ACK/QA/issue/return/split/count/identification/print checks and independent PostgreSQL verifier. The actual job log contains “native WebView Storage and disposable PostgreSQL ledger agree.”

Native artifact **14134402693**, SHA-256 `96f7f054beee0000190ea463dc5b5ae4c9b3aad1907a0ef770a852a97fec54fc`, expires 2026-11-21. Earlier reconciliation source `feaaedde9e1e917dca3c3e4760144d71ffae28a0` also passed all four workflows, including [Route A 43645860635](https://github.com/LHONE-mf/production_mf/actions/runs/43645860635).

## Delivered and locally verified

- `36e47f2`: actual received-issue reconciliation API from immutable issue/outcome snapshots, independent frozen cursor bounds, batch/recipient/material/source filters and no stock mutation or invented consumption.
- `feaaedd`: operator screen, strict client/history/conservation validation, formula-safe page/full exports capped at 10,000 issues, obsolete-response/identity protection and browser/native verification. See [report contract](STORAGE_RECONCILIATION_REPORT.md).
- `ae63127`: movement filtering by exact immutable **post-event** location, preserving receiving/QA history after a later transfer and preserving filters through frozen exports. See [movement contract](STORAGE_MOVEMENT_REPORT.md).
- **657 frontend / 277 actual PostgreSQL server tests**, all frontend/server/native-harness typechecks/builds, real two-profile Chromium (390x844/desktop and retained 412x915 camera checks), active-PWA/harness navigation, and actual custom pg_dump/two restores passed. The restore compares **44 tables**, reconstructing 14 stock events/four stocks, one reservation/issue, five handoff events/two outcomes, one split/four count events.
- No new application dependency, server/Dexie migration, production mutation, merge or deployment. Migration level **030**, InventoryOutbox **v7**, all original journals/queues/ACKs preserved. The verified session-owned synthetic PostgreSQL container was removed; local evidence remains in `/tmp/production-mf-evidence` and `/tmp/production-mf-location-evidence`.

## Skills/tools and review

All six vendored skills applied: incremental slices; TDD RED/GREEN; root-cause diagnosis of an initial test type error/stale compiled browser server; current authorization/tenant/proof/export checks; additive read contracts; correctness/security/performance review. Upstream Definition of Done/security checklists were consulted because the selective vendored copy omits them. Ponytail FULL and its auxiliary code-simplification/complexity review found no necessary broad refactor or dependency. A deliberate removal of the null-consumption guard failed its regression; the guard was restored and tests passed.

GitHub plugin supplied live PR/review threads, branch/checks, job logs/artifact metadata and PR metadata updates. Graphify graph statistics showed stale main `0505307`; actual branch source was used as authority. Git/CLI, Vitest, PostgreSQL16, Playwright/Chromium, Android Actions and pg_dump/pg_restore supplied real execution evidence. No agents were spawned. Unrelated site/pet/document/visualization tools were not invoked; no applicable engineering connector was unavailable.

[Dependency review](STORAGE_DEPENDENCY_REVIEW_2026-11-14.md): server 0 advisories; frontend 2 low / 6 moderate, 0 high/critical. Current v4 UUID use avoids the reported v3/v5/v6 buffer path; build-tool findings are reviewed separately. Review by 2026-11-21/before release; no force-upgrade or lockfile change.

## Next three coding tasks

1. **Finish S8 count/QA/genealogy report detail and large-data acceptance.** Extend `apps/server/src/inventory-movement-report-routes.ts`, `src/core/sync/inventoryMovements.ts` and `src/stages/storage/InventoryMovementsPanel.tsx` with authoritative immutable detail, including observation/approved discrepancy, QA disposition and parent/child/source identity. Preserve bounds/tenant/grants/exact quantities and explicit absent consumption. Do not treat count observations as stock movements.
2. **S9A actual finished-output submission and separate Storage acceptance into quarantine.** Trace `apps/server/src/step-evidence-routes.ts`, `batch-routes.ts`, `stage-handoff-routes.ts`, and `src/core/manufacturing/sortingWorkflow.ts`, `assemblyCellOutput.ts`, `formationResults.ts`. Existing completion evidence declares output; it does not receive goods. Preserve real grade, serial/source evidence and completed step/batch identity. Server-backed measured-source linkage, duplicate output/serial checks, durable production submit, separate authorized warehouse ACCEPT and Chief QA remain NOT IMPLEMENTED. Never infer output from planned target or journal text, or invent cathode/anode pairing rules.
3. **S9B actual Slurry use from received issue, then S10 hardening.** Use `src/stages/slurry/*`, `src/core/manufacturing/slurryBatch.ts`, existing issue/outcome clients/routes. Preserve calculators/recipes/local journal. Link a real received issue/batch/step, require deliberately recorded real measured quantity and evidence, settle ownership without a second warehouse debit, retain exact IDs/offline intent, and test races/revocation/restore in PostgreSQL/browser/native.

S8 remains PARTIAL. S9 finished goods/actual Slurry integration remain NOT IMPLEMENTED; S10 remains PARTIAL. Physical OnePlus/ColorOS handling, factory QA/count, signed installed-version upgrade, physical camera/printer, deployed TLS and production backup/reconciliation remain **PHYSICAL/DEPLOYMENT PILOT PENDING**. No unattended work after this session is claimed.

---

Historical checkpoint follows; its statuses/environment/next-work statements are superseded by the verified continuation above.

# Autonomous Storage checkpoint — 2026-11-14

**S0–S7 are implemented; S8–S10 remain open; S8 identification first increment is implemented and awaiting exact-head native verification.** Continue on `feat/storage-inventory-foundation`, draft PR #5 based on `feat/hybrid-server-foundation`. No merge/main, production data, observational-journal import, arbitrary package merge or fabricated measurements. Owner D1–D8 remain approved; no routine confirmations. Use AGENTS.md and all six relevant vendored engineering skills plus simplification discipline. No subagents unless expressly authorized.

## Verified runtime and current work

Latest fully verified S6: **0af1e850659c2c47fa9b1f72d41be477e0a77a84**. All exact-head workflows passed: Route A 43624097037 (job 132536019438), push CI 43624096972, PR CI 43624102397 and Run Tests 43624102417. Native artifact 14125936343, digest `aa7c7339019e5c873becf0cc936ea498979de0eb4ce0aeb285fb5c61fbaacb30`; engineering 14125850932, digest `0ec6b957be00038ee8ffbd5791b75b4d3593fe718d61bb5c78f93170159ae0e6`. Native proves real AndroidKeyStore proof, receipt + issue intent across force-stop, Chief QA/issue, direct return, warehouse scrap and conserved authorized split/child label/genealogy, with independent disposable PostgreSQL verification. S6 had 630 frontend / 247 server tests.

S7 adds migration **029** and real count/correction UI/API/client/native coverage. Local final checks: **633 frontend / 253 actual PostgreSQL tests**, all typechecks/builds, debug harness, active PWA packaged regression, actual two-profile browser and actual dump/two restores passed. Restore compares 42 tables and reconstructs 14 stock events/four stocks, one reservation/issue/split, five handoff events, two issue outcomes and four count events. **Do not call S7 native green until its exact published SHA passes.** Inspect current HEAD/PR/checks; no results from older code certify changes.

Contracts: STORAGE_ISSUES.md (026), STORAGE_RETURNS.md (027), STORAGE_SPLITS.md (028), STORAGE_COUNTS.md (029). Existing stock balances remain in stocks/operations. New immutable evidence streams are not alternate balances. Current proofs/warehouse grants/history and exact revisions are checked after the org inventory lock. Generic Master has no warehouse-manager powers. Chief alone releases QA. Return/split descendants retain current ancestor eligibility. Reservations remain parent-owned through split; dispatch remains distinct from receipt and actual consumption.

S7 counts can start anytime, record zero/count/recount without stock change, preserve stale historical observations, and close without correction. Chief/explicit Manager separately corrects only the original current stock snapshot; reservations/QA/dates are preserved. Correction can follow count closure if the original version is still current. count_adjustment is paired by deferred DB guard and shares operation-ID ownership with prior ledgers. Exact retries replay immutable ACKs.

InventoryOutbox stays **v7**. Each new workflow uses the existing original-profile draft namespaces and sanitized exact ACKs; all drafts/unknown/conflicts/accepted evidence survive recovery. S7 uses count/count-form. Offline count observations never change stock; only accepted corrections atomically update cache/ACK/proposal. Never reset, auto-post/rebase/rebind or delete original evidence. Existing local room tools and observational journals remain separate.

## Next work

1. Publish/document S7 and verify every exact-head workflow, including extended actual Route A count/correction controls, lost ACK and independent DB verifier. Diagnose failures from real logs/artifacts rather than retrying around them.
2. S8: finish typed package/location/batch QR/barcode lookup, Android camera/manual fallback, printable labels and offline scoped navigation. S6 supplies strict identification codec + package QR/manual label; camera, lookup routes and full location/batch/print flows are still absent. A scan is lookup only.
3. S8: configurable low-stock/expiry policies, alerts without mutation, ledger-matched balances/movements/issue-return-consumption/genealogy/count reports, bounded filters/pagination and safe CSV exports. Formula-escape spreadsheet text and never export secrets or another tenant. No actual consumption exists yet; show zero honestly.
4. S9: production electrode/cell submission then explicit warehouse acceptance into quarantined stock, preserving actual production batch/serial/evidence and preventing duplicate acceptance. Completion must not auto-receive. Slurry must select actual approved received issues, record actual weighed use and reconcile planned/issued/actual/returned/scrapped; do not invent scales, measurements or import journals.
5. S10: multi-role/tenant/race/revocation/restore/queue/upgrade and larger-data regressions; 390x844/412x915/desktop, labels/camera/manual/exports, native keyboard/rotation/Back/font/safe-area and persisted modals, exact-HEAD CI, final code review and scoped deployment/pilot handoff. Physical ColorOS, signed installed-version upgrade, deployed TLS, production backups/reconciliation and staff handling remain separate release gates.

## Reproducible environment and tools

Root and apps/server have installed dependencies. Frontend `npm run typecheck`, `npm test -- --reporter=default`, `npm run build`; same scripts in apps/server with disposable POSTGRES_TEST_URL. Harness: `npx tsc --noEmit -p tests/android-storage/tsconfig.json`, `node scripts/build-android-storage-harness.mjs`.

Owned local Docker PostgreSQL16: production-mf-storage-codex-test, ID 7fd9f503acf032d69741a48d8519beabc912324db35536a7a1369679865b59b8, loopback5432, disposable production_mf_ci DB/user, intentional CI password ci_test_password_only. 001–029 applied. Apply only new additive migrations on populated synthetic data; never replay all historical migrations. Fresh guard script migrate-disposable-postgres.mjs refuses populated/non-loopback/non-test schemas. Remove only the owned container when finished. No local adb/emulator; hosted Route A provides real native verification.

Actual Chromium scripts/storage-operator-smoke.mjs uses STORAGE_PLAYWRIGHT_MODULE=/tmp/storage-browser-tools/node_modules/playwright/index.mjs. Packaged PWA regression scripts/android-storage-harness-smoke.mjs requires root build + debug harness. Actual dump/two restores scripts/storage-recovery-drill.mjs uses STORAGE_POSTGRES_CONTAINER=production-mf-storage-codex-test and creates/drops only run-owned DBs. Tests use synthetic fixtures and actual public mutation APIs; no permanent server.

Git/gh transport works: ordinary fast-forward push to authorized Storage branch. gh pr edit fails on deprecated classic-project GraphQL metadata; use connected GitHub app structured update_pull_request. Read GitHub check-runs for push/native IDs (fetch_commit_workflow_runs lists PR runs only). Connector artifact download returns File Service metadata/download_url: download the authenticated file URL, not download_file (Sediment only). Direct GitHub artifact redirected ZIP returned403. Inspect exact ZIP members safely; do not bulk-extract arbitrary paths. Authenticated logs/metadata are available without owner credentials.

Historical failures remain documented in feature matrix: PWA navigation interception at 7d45e5f fixed in 8463d96 without clearing caches; S5 initial native 97c7803 immediate draft-readiness assertion fixed in 1b9fd42, and collapsed original-request browser selector narrowed to visible history. S5 1b9fd42 passed all exact-head checks. Keep failures attributed honestly and preserve artifacts. No automatic-approval rejection occurred.

## S8 identification increment in progress

S7 is green at 4b31065: native 43625766702, push 43625766710, PR CI 43625771989 and Run Tests 43625771969. S8 identification code uses no new stock schema/product dependency; see STORAGE_IDENTIFICATION.md. Actual QR video decoding, read-only package/location/batch lookup, bounded original-lease offline cache, inert HTML/PDF labels and camera pending-start cleanup pass locally. Android adds optional CAMERA, a network/script/file-disabled InventoryLabelPrinter plugin and instrumentation for camera stream release + actual print-spooler dialog. Build/publish/verify this vertical increment before continuing S8 alert policies and ledger-matched reports/CSV. Never call S8 complete while alerts/reports/exports remain absent. Local test camera fixture needs ffmpeg (installed; CI ensures it). Native emulator camera-back is emulated; physical factory scan/printing remains separate.
