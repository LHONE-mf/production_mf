# Autonomous Storage resumption checkpoint — 2026-11-14

The full owner roadmap is **not complete**. S0–S3 have real implementation and exact-commit automated evidence; S4–S10 remain open. Resume on `feat/storage-inventory-foundation`, draft PR #5, parent `feat/hybrid-server-foundation`. Do not merge, touch production data, import local observational journals into stock, or use the diverged ledger branch.

Verified runtime commit: `a8a638575b47afe7e4c37110c5c32105d6bfe7dd` (tree `e17840998543b846d18badab026512d6b2cb0720`). Full current matrix/evidence: STORAGE_FEATURE_MATRIX.md. Both required checks, push browser/restore CI and native run 43591587440 passed. Local: 612 frontend / 219 real-PostgreSQL tests. Additive migrations now 001–025; InventoryOutbox remains v7, with preserved scoped admin/QA proposals and retained acknowledgements. Final documentation may advance the branch; inspect live HEAD/PR/checks before editing.

## Published slices

- `f0a01f0`: S0 audit and approved-decision gap matrix.
- `de35f7b`, `a966d58`, `dc5a8ea`, `e51d2ab`: complete isolated migrations, debug native harness/disposable backend, native process-death receiving, fixed missing Android INTERNET permission; earlier failing attempts retained honestly.
- `83938e3`: actual material/location creation, Chief employee/grant UI, immutable audit and durable manual administrative proposals.
- `ddbb5d3`: versioned metadata/location editing, occupied/historical hierarchy guards, actual Chief native editor scenario and populated upgrade tests.
- `a8a6385`: genuine Chief QA release/hold/block/reject, immutable paired zero-movement events, UTC expiry, durable QA intent/ACK, operator denial, actual browser/native QA and restore drill without a QA fixture bypass.

GitHub CLI/Git transport credentials expired during S3. The connected GitHub app still reads/writes. S3 was published through Git data tools with identical tested tree and original published parent. API metadata yields SHA a8a6385; the original unpublished local 138ebcc is retained by local tag `storage-local-quality-138ebcc`. The published raw commit was verified/imported and the local branch synchronized; no published history was rewritten. Prefer restored ordinary Git transport if available; otherwise use create_tree/create_commit/update_ref with an expected-head lease and verify exact tree/parent. Never overwrite a concurrent advance. No credential was requested from the owner or committed.

## Start S4 here

1. Re-read AGENTS.md, the six vendored engineering skills, matrix and live current code/checks. Owner D1–D8 remain approved. S4 acceptance: real UI + authenticated transaction + immutable audit + retained intent + two-role/native verification, not endpoints alone.
2. Read `apps/server/src/inventory-stock-operations.ts`, `inventoryDomain.ts`, `inventory-stream.ts`, `inventory-snapshot.ts`, migration 020 and 025. Reuse the existing reservation/quantity/stock ledger; do not create a second source of stock truth. New additive schema starts at 026.
3. Inspect real production batch/workshop scope in `batch-routes.ts` (workshop-batches), `step-evidence-routes.ts` and `stage-handoff-routes.ts`, and production route/order/batch schema. Generic Master has no Manager power. An assigned production recipient/requester must not need a broad warehouse grant merely to receive its own batch handoff. Reuse/factor the current proof/session checks carefully; currentInventoryWriter currently requires warehouse access and cannot simply be reused to grant unrestricted production reads.
4. Define explicit request/reserve/approval/dispatch/receipt states and exact package/material/lot/location/batch/recipient provenance. Every final issued-stock debit needs current Chief or explicit Warehouse Manager approval and controlled physical handoff. Request/reservation/approval alone are not consumption. Received production stock is not automatically consumed. Use stable operation IDs/revisions, current proof/history and one transaction for balances, workflow state, immutable events and ACK.
5. Provide real scoped batch discovery/selection and request/approval/handoff screens; deny wrong org/workshop/recipient, generic Master privilege inheritance, stale/revoked approval, held/expired material, changed intent, and competing overdraw. Preserve unknown/conflicting intent until explicitly reviewed. Do not silently rebind old epochs or automatically post after reconnect.
6. Add failing actual PostgreSQL tests first: operator cannot approve/debit; Chief/Manager can; exact lost-ACK retries once; changed-ID reuse fails; competing dispatch cannot overdraw; recipient acknowledgement has assigned scope and no second debit; expiry/hold/revocation/history races fail; reservations and consumption remain distinct. Then implement the smallest complete vertical slice and browser/native UI tests.
7. Reuse `inventoryQuality.ts` / `inventoryAdministration.ts` scoped frozen-intent patterns where appropriate. If a new indexed table needs a Dexie version, add v8 and populated preservation tests; never reset or replace v7 rows, ACKs, QA/admin proposals, cursors or archives. A privileged deliberate online-only action is acceptable when clearly documented, with original intent retained.
8. Extend `scripts/storage-operator-smoke.mjs`, `tests/android-storage/harness.tsx`, `scripts/verify-android-storage.mjs` with genuine S4 actions. The manual/path-filtered Android workflow starts real Fastify/PostgreSQL and checks its independent ledger. Preserve existing native proof/archive/Back, browser QA/recovery, and actual dump/restore checks. Do not substitute fixture QA release or mocks for the real API.
9. Test, review security/tenant/quantity/idempotency/migrations/UI, commit, publish with expected current head, update PR/matrix, verify exact SHA, then proceed S5–S10. No routine owner confirmations.

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
