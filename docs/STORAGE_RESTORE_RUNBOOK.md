# Storage backup, restore and reconciliation

Engineering runbook for feat/storage-inventory-foundation. No production database was accessed by the automated checks. A successful disposable drill does not approve factory cutover or production backup infrastructure.

## Compatibility and deployment

Apply additive `021_inventory_restore_fence.sql` after 001–020 using the established migration runner and deployment credentials. Historical migrations are not all repeatable; never blindly rerun them on an existing database. Migration 021 is transactional and reapplicable without changing the current epoch, stock or ledger.

Deploy the server before the compatible client. Receipt/stock writes now require `x-inventory-epoch`; clients lacking it receive HTTP 428 and must retain pending operations. `/inventory/stream` and feed pages return the organization history UUID and posting status. Every client upload checks that proofed state first. The server checks the UUID under the same organization lock as stock posting, before even idempotent replay. Changed history or suspended posting cannot become a business conflict or a new stock mutation.

InventoryOutbox v6 preserves existing forms/queues/history/cursor. Pending operations created before history binding are marked `requiresStreamReview`; their original ID, payload, state and evidence remain intact. They are held for administrator review, not silently assigned to a possibly restored stream. Previous cached-view grants without history binding require a fresh authenticated refresh. New accepted acknowledgements and their exact frozen requests remain in a separate local store after the pending row is removed.

There is no automatic epoch-reset/replay button. The initial guard milestone deliberately holds unresolved pre-upgrade work; a guided, audited recovery approval is the next implementation slice. Until that process is available and verified, keep affected posting paused rather than clearing flags or deleting browser data.

## Backup preparation

Record app/server versions, database migration level, all organization history identifiers, and unresolved queues on every enrolled device. Preserve a verified PostgreSQL backup and the original device data. Use the Storage “Данные для сверки после восстановления” panel to export original intents and locally retained acknowledgements under a fresh proofed session. It is read-only evidence, never an inventory-import or posting authority.

Freeze physical receiving, movement and counting for the affected scope and name the responsible supervisor. Drain known work or explicitly record unknown outcomes before the backup/cutover. Do not infer physical stock from legacy observations or a successful software test.

## Restore before reopening service

1. Restore into an isolated database first. Stop inventory writers and keep clients disconnected from the restored service.
2. Apply only missing migrations. If restoring a pre-021 backup, install 021 while the service remains closed; do not serve its initial default history as if continuity had been verified.
3. In an administrator transaction, acquire the organization `inventory-sequence` advisory locks in a consistent order, rotate every affected `inventory_streams.epoch` to a fresh UUID and set `posting_enabled=false`. Never restore the previous UUID to silence a client mismatch.
4. Revoke restored sessions/proof grants and consume outstanding device challenges before serving authentication again. Preserve device enrollment identities and existing revocations; never copy private keys or bearer credentials between devices.
5. Verify row counts, immutable ledger triggers, exact quantities, separate receipt/container provenance, scoped permissions and restored revocations. Reconstruct latest stock projections from accepted `result_stock` records in sequence and reservations from reserve/release intents. Unknown kinds, missing provenance or unexplained records require investigation; do not delete them to make totals agree.
6. Compare every device acknowledgement/unknown intent against the restored immutable ledger using operation ID, organization, actor, device and exact intent. An acknowledgement missing after backup is not permission to create a second receipt. Resolve lost physical movements/counts and document any compensating events under existing Chief/manager authority.
7. Reopen posting only after the supervisor/administrator has recorded reconciliation. Fresh original-device authentication, explicit reviewed client history adoption, and manual confirmation remain required. Pending/accepted evidence must survive this process.

A generic cache wipe, last-write-wins merge, queue deletion or silent new operation ID is not recovery. Production restore remains blocked until the actual deployment and physical reconciliation procedure pass their staging drill.

## Executed disposable drill

After building apps/server, `scripts/storage-recovery-drill.mjs` runs with POSTGRES_TEST_URL selecting localhost production_mf_ci and the existing local storage-postgres-test Docker container. It creates three fresh UUID-named databases and removes only those databases on completion/failure.

Actual results: custom pg_dump archive restored into two fresh databases; all 34 public tables compared exactly; six accepted events reconstructed into two stock containers and one remaining reservation; same-lot receipt documents remained distinct; immutable history and revoked device behavior survived restore. Deliberately damaged stock/reservation quantities were actually repaired from ledger projections under stopped posting/locks and compared with the original backup. A committed-after-backup receipt was absent after rollback; old credentials, old-epoch retries and suspended new-epoch posting were denied without changing restored data. Temporary databases were removed.

This drill uses test-only sessions/device grants and an explicitly labelled approved-QA fixture to exercise reservation arithmetic. It does not implement or approve a production QA-release workflow, general production repair CLI, signed Android upgrade or physical warehouse count.
