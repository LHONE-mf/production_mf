# Autonomous Storage resumption checkpoint — 2026-11-14

The full owner roadmap is **not complete**. S0–S3 have exact-commit automated evidence. S4 is implemented and locally tested; current-head native CI is pending. S5–S10 remain open. Resume on `feat/storage-inventory-foundation`, draft PR #5, parent `feat/hybrid-server-foundation`. Do not merge, touch production data, import local observational journals into stock, or use the diverged ledger branch.

Verified runtime commit: `a8a638575b47afe7e4c37110c5c32105d6bfe7dd` (tree `e17840998543b846d18badab026512d6b2cb0720`). Full current matrix/evidence: STORAGE_FEATURE_MATRIX.md. Both required checks, push browser/restore CI and native run 43591587440 passed. Local: 612 frontend / 219 real-PostgreSQL tests. The verified S3 checkpoint used migrations 001–025; the current S4 tree adds 026; InventoryOutbox remains v7, with preserved scoped admin/QA proposals and retained acknowledgements. Final documentation may advance the branch; inspect live HEAD/PR/checks before editing.

## Published slices

- `f0a01f0`: S0 audit and approved-decision gap matrix.
- `de35f7b`, `a966d58`, `dc5a8ea`, `e51d2ab`: complete isolated migrations, debug native harness/disposable backend, native process-death receiving, fixed missing Android INTERNET permission; earlier failing attempts retained honestly.
- `83938e3`: actual material/location creation, Chief employee/grant UI, immutable audit and durable manual administrative proposals.
- `ddbb5d3`: versioned metadata/location editing, occupied/historical hierarchy guards, actual Chief native editor scenario and populated upgrade tests.
- `a8a6385`: genuine Chief QA release/hold/block/reject, immutable paired zero-movement events, UTC expiry, durable QA intent/ACK, operator denial, actual browser/native QA and restore drill without a QA fixture bypass.

GitHub CLI/Git transport credentials expired during S3. The connected GitHub app still reads/writes. S3 was published through Git data tools with identical tested tree and original published parent. API metadata yields SHA a8a6385; the original unpublished local 138ebcc is retained by local tag `storage-local-quality-138ebcc`. The published raw commit was verified/imported and the local branch synchronized; no published history was rewritten. Prefer restored ordinary Git transport if available; otherwise use create_tree/create_commit/update_ref with an expected-head lease and verify exact tree/parent. Never overwrite a concurrent advance. No credential was requested from the owner or committed.

## Current S4 implementation / next S5

S4 now implements real request/reserve/approve/dispatch/assigned-receipt/cancel UI and API. Read STORAGE_ISSUES.md and the S4 matrix entry. Additive migration 026 keeps existing stock ledger/reservations and introduces owned handoffs and immutable paired events. Current actor proof factoring is in inventory-stream.ts; issue-specific transactions/scoping in inventory-issue-scope.ts. Generic Master/operator cannot approve/debit. Production users can request/receive in their actual batch workshop without broad warehouse grants. No handoff step records consumption.

Local current checks: 619 frontend tests, 228 server tests with real isolated PostgreSQL, typechecks/builds/native harness types/build, actual three-profile Chromium (Chief/operator plus production-only recipient), and actual pg_dump/two restores passed. The restore drill compares 39 public tables and reconstructs 9 stock events, one remaining generic reservation, one received issue and five immutable handoff events. Original frozen request survives cold browser reload; committed dispatch lost ACK retries once. Native harness now freezes both receipt and issue request across force-stop, drives real Chief issue/receipt screens and independently verifies DB state; current published SHA's Route A result must still be checked before declaring S4 verified. No local Android emulator/adb is installed; hosted Route A is the authorized verification environment.

Git/gh transport is restored in this session. Prefer ordinary fast-forward commit/push after inspecting live branch/PR head. PR #5 must remain draft, based on feat/hybrid-server-foundation. Never merge/main/production data. Preserve every previous queue and artifact. The earlier GitHub-app fallback notes remain relevant only if transport expires again.

Next steps:

1. Verify the newly published S4 commit's web/server/browser/restore and Route A runs. Fix genuine native failures rather than claiming success from compilation. Update exact-SHA evidence in matrix/PR.
2. Begin S5 eligible unused returns using actual **received** inventory_issues provenance (source package/material/manufacturer lot, production batch, recipient, exact issued quantity). Return must be capped by outstanding issued quantity, including future actual consumption/scrap. Keep inventory_operations the stock authority and retain the source handoff/audit.
3. D3 normal untouched/traceable/unexpired/released return goes directly AVAILABLE once, without routine re-quarantine or another Chief release. Wrong source/batch/package, damaged/altered/contaminated, blocked/rejected or expired return must fail closed or held with explicit reason. Do not let a return override a subsequent QA hold/reject.
4. Provide real warehouse operator return acceptance screen with accountable receiver, source issue, exact quantity, condition evidence and explicit send. Privileged scrap is separate, never arbitrary disguised adjustment. Retain unknown/conflict intent, original ID/epoch/versions and atomic ACK/cache evidence. S4's namespace pattern reuses v7; do not reset DB or manufacture journal links.
5. Test real PostgreSQL caps/races/idempotency/current membership/QA/expiry/history, populated upgrades and client ACK/provenance first; extend actual multi-profile browser and native verifier. Test, commit, push, document and verify each milestone. Continue S6–S10 under the approved owner decisions below.

Dependency audit on 2026-11-14: server zero findings, frontend zero high/critical, six moderate/two low in existing lockfile. uuid advisory concerns v3/v5/v6 buffer APIs; repository uses v4. glob/minimatch/deepmerge findings are existing trusted build/config transitive paths through PWA tooling, not inventory request handlers. No dependency changed or force remediation applied. Revisit during S10 / by 2026-11-21 with isolated upgrades and build/native regression.

## Remaining approved roadmap

- S5: eligible unused return references accepted issue/package/batch and exact outstanding quantity; directly AVAILABLE once, no routine re-quarantine. Expired/blocked/damaged/untraceable/contaminated/altered stock held or denied; scrap privileged and audited.
- S6: Chief/Manager-authorised split/repack, new child package IDs, parent provenance, exact conservation, inherited QA/expiry, race and retry protection; no arbitrary merge.
- S7: any-time physical counts, operator observations, discrepancies/recounts, Chief/Manager correction approval; count alone never changes stock.
- S8: scoped package/location/batch QR/barcode, Android camera/manual fallback, labels/lookup (never authorisation), alerts/thresholds/expiry, reconciled scoped reports/genealogy/consumption and CSV formula escaping.
- S9: real production electrode/cell handoff -> explicit warehouse acceptance -> quarantined stock; authentic batch/serial/evidence links, no completion-created stock. Slurry selects approved issued stock and records actual exact weighed/consumed evidence, without fabricating measurements or importing journals.
- S10: full multi-role/concurrency/restore/queue/upgrade regression; mobile sizes, enlarged fonts/a11y, keyboard/rotation/Back/safe-area/modal persistence, performance, report/scan tests, exact-HEAD native CI. Keep physical ColorOS, real staff handling, deployed TLS, signed upgrade and production restore/pilot gates honest and separate.

## Reproducible checks

Frontend: `npm ci`, `npm run typecheck`, `npm test -- --reporter=default`, `npm run build`; native harness: `npx tsc --noEmit -p tests/android-storage/tsconfig.json`, `node scripts/build-android-storage-harness.mjs`.
Server: `npm ci`, `npm run typecheck`, `npm test -- --reporter=default`, `npm run build` in apps/server with isolated `POSTGRES_TEST_URL` for real integration tests. Empty CI setup: `node scripts/migrate-disposable-postgres.mjs`; it refuses production/non-loopback/populated schemas. Never use it as a general production migration runner.
Actual browser/restore tooling is already in `.github/workflows/ci.yml`; Route A in `android-emulator-smoke.yml`, `scripts/android-storage-emulator.sh` and server/native verifier. State is temporary, synthetic and credential-free in artifacts. No owned permanent server or owner PC is required.
