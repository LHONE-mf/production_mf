# Autonomous Storage resumption checkpoint — 2026-11-14

**The complete S0–S10 roadmap is not finished. S0–S5 are implemented; S5 native verification and S6–S10 remain open.** Continue on `feat/storage-inventory-foundation`, draft PR #5, parent `feat/hybrid-server-foundation`. Never merge/main, touch production data, import observational journals as stock, or use the diverged ledger branch. Owner decisions D1–D8 remain approved; no routine confirmation is needed.

## Verified code and live state

S4 runtime commit **13eb55937287cc486ce56fbd87f5bc90da745119** passed push CI 43598436249, PR CI 43598440858, Run Tests 43598440869 and Android Route A 43598436254, job 132457824079. Native artifact 14114364859 and engineering artifact 14114964878 identify the exact branch SHA; links/digests/expiry are in STORAGE_FEATURE_MATRIX.md. Native force-stop preserved both receipt and issue-request IDs; actual Chief reserve/approval/dispatch, lost dispatch ACK/exact retry, assigned receipt and independent DB verification passed. Browser additionally proves a production-only recipient can receive but is denied warehouse stock reads.

At 13eb559: 619 frontend / 228 real-PostgreSQL server tests, builds/typechecks, native harness types/build, actual multi-profile Chromium and actual dump/two restores passed. Restore compares 39 public tables and reconstructs 9 stock events, one remaining generic reservation, one received issue and five immutable handoff events. Follow-up in this checkpoint fixes numeric timestamp acceptance and adds a positive two-batch/one-source ownership/reapproval test (229 server tests). Inspect live HEAD/PR/checks before editing; do not attribute old evidence to changed code. Exact latest-head CI links are kept in PR #5.

Git/gh transport now works. Ordinary fast-forward push is preferred after checking the live remote head. `gh pr edit` fails on deprecated classic-project GraphQL metadata; use the connected GitHub app's structured update_pull_request tool for PR metadata (or properly structured REST). Earlier S3 was published via the GitHub app with identical tested tree and original published parent when Git transport expired; original local commits remain tagged `storage-local-quality-138ebcc` and `storage-local-checkpoint-c0336c7`. Never rewrite a concurrent published head. Direct artifact ZIP download received HTTP 403 at the redirected artifact host; authenticated artifact metadata/job logs remain readable. No credentials are needed from the owner.

## Implemented S4 boundaries

Read AGENTS.md, the six `.agents/skills` engineering skills, STORAGE_FEATURE_MATRIX.md and STORAGE_ISSUES.md before significant work.

- Migration 026 adds `inventory_issues`, immutable `inventory_issue_events`, and nullable `issue_id` ownership on existing reservations. Stock remains exclusively in existing stocks/operations. Paired reserve/issue/release events, cross-endpoint ID guards and DB approval/handoff guards preserve the single ledger. Existing populated rows survive.
- `inventory-stream.ts` factors `currentInventoryActor` from currentInventoryWriter. Issue transaction/proof/history/warehouse/member helpers live in `inventory-issue-scope.ts`; read routes in `inventory-issue-reads.ts`, writes in `inventory-issue-routes.ts`. No circular route imports. Every mutation rechecks proof/current role under the inventory lock; production scope is derived from the batch's immutable approved route step.
- Requests select material/batch/step/exact recipient/quantity. Chief or explicit Manager reserves one source container, approves its current revision and separately confirms physical dispatch. The original approver must remain authorized with a nonrevoked device. Operator/generic Master cannot debit. Source revision changes require explicit reapproval. Multiple requests can reserve a package for different batches without consuming each other's reservation.
- Assigned recipient/current workshop membership acknowledges delivery without a second debit, including after a later batch hold. Request, reservation, approval, dispatch, receipt and consumption are distinct. No actual consumption is recorded by S4.
- `inventoryIssueTypes/Client/Issues.ts` validate scoped responses and exact ACKs, retain frozen intent/epoch/base versions in a v7 `issue` draft namespace, and atomically accept stock cache/ACK/draft. No Dexie version/reset. Requests/recipient intent can freeze offline from loaded scope; privileged preparation is online-only and compares the original screen epoch. No auto-send/rebase/rebind. Unknown/conflicting and old-epoch requests remain held/inspectable. Production recipients do not need warehouse grants or unrestricted stock/cache recovery access.
- `InventoryIssues.tsx` is separate from ConfirmedStorage in StorageModule so production users can use own handoffs. Human names/codes accompany stable IDs. Existing local journals and offline tasks remain independent.

## S5 implementation and next step

Read [STORAGE_RETURNS.md](STORAGE_RETURNS.md). Migration 027 adds immutable issue outcomes, capped settlement and return genealogy in the existing stock ledger. Eligible unused received-issue returns create distinct available packages without routine Chief QA; source holds/expiry propagate eligibility to descendants. Unsafe returns stay rejected/inspectable without stock. Manager/Chief issued scrap settles ownership without another warehouse debit; separate warehouse scrap debits only unreserved stock with witness evidence. No consumption is inferred.

Original scoped requests and sanitized exact ACKs use the existing v7 outcome namespace. No local DB reset, auto-send/rebase or old-history adoption. New warehouse stock proposals bind their original epoch; warehouse scrap requires it. Actual browser tests cover offline/reload, lost ACK, concurrent return caps, unsafe return, both scrap paths and visible immutable witness. Actual dump/two restores compare 40 tables and reconstruct 11 stock events, three stocks, one generic reservation, one received issue, five handoff events and two issue outcomes. The native harness now tests normal return/lost ACK, unsafe denial and Chief warehouse scrap against independent PostgreSQL verification; hosted S5 run must still pass at its exact SHA.

Finish exact-head S5 checks/publication, then implement S6 authorized split/repack. Preserve reservations on parent, exact conservation, new child identity/genealogy and QA/date inheritance. Reuse existing stock/outbox transactions and labels; test role/tenant/collision/race/retry and child scans. Then continue S7–S10. No routine owner approval is needed.

## Remaining approved roadmap

- S6: Chief/Manager-authorized split/repack, new child IDs, parent genealogy, exact conservation, inherited QA/expiry, race/retry protection; no arbitrary merge.
- S7: counts anytime, operator observations/recounts/discrepancies, explicit Chief/Manager correction approval; count alone never changes stock.
- S8: scoped package/location/batch QR/barcode, Android camera/manual fallback, labels/lookup never authorization; thresholds/expiry alerts and reconciled reports/genealogy/consumption/CSV formula escaping.
- S9: real electrode/cell handoff then explicit warehouse acceptance into quarantine; preserve batch/serial/evidence and never create stock on completion. Slurry selects approved received issues and records actual exact weighed/consumed evidence without inventing measurements or importing journals.
- S10: full role/race/restore/queue/upgrade/large-data regression; mobile font/a11y/keyboard/rotation/Back/safe areas/modal persistence, scan/report tests and exact-HEAD native CI. Physical ColorOS, staff handling, deployed TLS, signed upgrade and production restore/pilot gates remain separate.

## Reproducible tools

Frontend: `npm run typecheck`, `npm test -- --reporter=default`, `npm run build`; native harness: `npx tsc --noEmit -p tests/android-storage/tsconfig.json`, `node scripts/build-android-storage-harness.mjs`.
Server: same typecheck/test/build scripts in apps/server, with isolated `POSTGRES_TEST_URL` for actual PG tests. Fresh CI setup is `node scripts/migrate-disposable-postgres.mjs`; it refuses production/non-loopback/populated schemas. Never use it as a general production migration runner.

Actual Chromium: scripts/storage-operator-smoke.mjs with STORAGE_PLAYWRIGHT_MODULE=/tmp/storage-browser-tools/node_modules/playwright/index.mjs. Actual dump/two restores: scripts/storage-recovery-drill.mjs with the owned local test container. Route A: android-emulator-smoke.yml, scripts/android-storage-emulator.sh, real Fastify/Postgres, native AndroidKeyStore and independent verifier. No local adb/emulator is installed; hosted Route A is the native verification environment. No permanent server or owner PC is required.

Dependency audit 2026-11-14: server zero findings; existing frontend lockfile zero high/critical, six moderate/two low. uuid findings concern unused v3/v5/v6 buffer APIs (repo uses v4); others are existing trusted build/config PWA transitive paths. No dependency or forced remediation changed. Revisit in S10/by 2026-11-21 with isolated upgrades and build/native regression.

## Native startup repair after 7d45e5f

Do not overlook this later event: 7d45e5f's web/server/browser/restore passed (619/229), but Route A 43599817877 failed before backend calls at `Debug Storage harness unavailable`. A real packaged-browser regression proved the production PWA worker's SPA fallback intercepted `/tests/android-storage/index.html`. Repair excludes that debug-only path in vite.config.js, waits for the initial Capacitor document before native navigation, and adds scripts/android-storage-harness-smoke.mjs to hosted browser verification. The real worker remains active and the production shell still works offline; no cache/IndexedDB/outbox reset occurs. Native at the repair HEAD must pass before declaring the latest branch verified. Check live PR #5 evidence.

For artifact bytes use GitHub's download_workflow_artifact tool, which returns a reusable file-service download URL. The connector successfully fetched failed artifact 14115668448 despite direct CLI redirect HTTP 403. Read that returned URL with a properly quoted download command; download_file is for Sediment uploads, not these file-service IDs. Artifact is synthetic CI evidence; do not commit temporary signed URLs or credentials.

S4 PWA/native repair 8463d96 passed all exact-head workflows: native 43601214813, push 43601214815, PR CI 43601221503 and Run Tests 43601221028. Connector artifact download works via its returned file URL; direct GitHub redirected ZIP returned 403. No owner credentials required.
