# Storage backup, restore and reconciliation

Engineering runbook for feat/storage-inventory-foundation. No production database was accessed by the automated checks. A successful disposable drill does not approve factory cutover or production backup infrastructure.

## Compatibility and deployment

Apply additive `021_inventory_restore_fence.sql` and `022_inventory_recovery_approvals.sql` after 001–020 using the established migration runner and deployment credentials. Historical migrations are not all repeatable; never blindly rerun them on an existing database. Migrations 021–022 are transactional and reapplicable without changing the current epoch, stock or ledger.

Deploy the server before the compatible client. Receipt/stock writes now require `x-inventory-epoch`; clients lacking it receive HTTP 428 and must retain pending operations. `/inventory/stream` and feed pages return the organization history UUID and posting status. Every client upload checks that proofed state first. The server checks the UUID under the same organization lock as stock posting, before even idempotent replay. Changed history or suspended posting cannot become a business conflict or a new stock mutation.

InventoryOutbox v6 preserves existing forms/queues/history/cursor. Pending operations created before history binding are marked `requiresStreamReview`; their original ID, payload, state and evidence remain intact. They are held for administrator review, not silently assigned to a possibly restored stream. Previous cached-view grants without history binding require a fresh authenticated refresh. New accepted acknowledgements and their exact frozen requests remain in a separate local store after the pending row is removed.

InventoryOutbox v7 adds recovery archives without rewriting v6 queues or bindings. The guided review preserves the complete original stock cache, feed history/cursor, acknowledgements, drafts and queued requests before adopting a reviewed server history. Approval never enables server posting or confirms an uncertain operation.

## Guided Chief review

1. On the original authenticated device, open “Данные для сверки после восстановления” and prepare/download the package. Its SHA-256 digest binds all original evidence except the export timestamp. Any local change requires a new package and review.
2. Chief may review that package on the same device or open its JSON (up to 2 MiB) on a separate proven Chief device in the same organization/server. Compare exact intent, accepted acknowledgements, restored ledger and physical records. Enter the review result and document reference, then explicitly confirm the history review. The server records an immutable approval for the exact digest, original actor/device and current history UUID; retries retain the approval ID. Manager/operator cannot approve.
3. On the original device, apply the confirmed review. The server must still return a matching approval for the current history. The device archives its complete previous state atomically, retains original request IDs/payloads, marks uncertain pending requests “Требуется сверка истории”, and resets only that scope's stock/history read cache and cursor. Changes during the approval lookup abort the reset. Other scopes are untouched.
4. Refresh after the administrator has separately reopened posting under the operational reconciliation procedure. Held receipts never replay automatically, and remain visible for investigation. Held stock proposals may receive a documented local review before a separately confirmed new intent; that local review is not evidence of a movement. Preserve the server approval and downloaded device evidence. “Открыть последний архив сверки” downloads the retained original package again after rebuilding the cache.

A further server restore invalidates old approvals. If the server rotates between approval lookup and local adoption, the next normal read/write fence holds work again. Keep posting paused until all physical and operational checks finish; do not clear flags or delete browser data.

## Backup preparation

Record app/server versions, database migration level, all organization history identifiers, and unresolved queues on every enrolled device. Preserve a verified PostgreSQL backup and the original device data. Use the Storage “Данные для сверки после восстановления” panel to export original intents and locally retained acknowledgements under a fresh proofed session. It is read-only evidence, never an inventory-import or posting authority.

Freeze physical receiving, movement and counting for the affected scope and name the responsible supervisor. Drain known work or explicitly record unknown outcomes before the backup/cutover. Do not infer physical stock from legacy observations or a successful software test.

## Restore before reopening service

1. Restore into an isolated database first. Stop inventory writers and keep clients disconnected from the restored service.
2. Apply only missing migrations. If restoring a pre-021 backup, install 021–022 while the service remains closed; do not serve its initial default history as if continuity had been verified.
3. In an administrator transaction, acquire the organization `inventory-sequence` advisory locks in a consistent order, rotate every affected `inventory_streams.epoch` to a fresh UUID and set `posting_enabled=false`. Never restore the previous UUID to silence a client mismatch.
4. Revoke restored sessions/proof grants and consume outstanding device challenges before serving authentication again. Preserve device enrollment identities and existing revocations; never copy private keys or bearer credentials between devices.
5. Verify row counts, immutable ledger triggers, exact quantities, separate receipt/container provenance, scoped permissions and restored revocations. Reconstruct latest stock projections from accepted `result_stock` records in sequence and reservations from reserve/release intents. Unknown kinds, missing provenance or unexplained records require investigation; do not delete them to make totals agree.
6. Compare every device acknowledgement/unknown intent against the restored immutable ledger using operation ID, organization, actor, device and exact intent. An acknowledgement missing after backup is not permission to create a second receipt. Resolve lost physical movements/counts and document any compensating events under existing Chief/manager authority.
7. Reopen posting only after the supervisor/administrator has recorded reconciliation. Fresh original-device authentication, explicit reviewed client history adoption, and manual confirmation remain required. Pending/accepted evidence must survive this process.

A generic cache wipe, last-write-wins merge, queue deletion or silent new operation ID is not recovery. Production restore remains blocked until the actual deployment and physical reconciliation procedure pass their staging drill.

## Executed disposable drill

After building apps/server, `scripts/storage-recovery-drill.mjs` runs with POSTGRES_TEST_URL selecting localhost production_mf_ci and the existing local storage-postgres-test Docker container. It creates three fresh UUID-named databases and removes only those databases on completion/failure.

Actual results: custom pg_dump archive restored into two fresh databases; all 35 public tables compared exactly; six accepted events reconstructed into two stock containers and one remaining reservation; same-lot receipt documents remained distinct; immutable history and revoked device behavior survived restore. Deliberately damaged stock/reservation quantities were actually repaired from ledger projections under stopped posting/locks and compared with the original backup. A committed-after-backup receipt was absent after rollback; old credentials, old-epoch retries and suspended new-epoch posting were denied without changing restored data. Chief approval was recorded and read while posting remained suspended, its immutable trigger held, and stock/reservation projections stayed unchanged. Temporary databases were removed.

This drill uses test-only sessions/device grants and an explicitly labelled approved-QA fixture to exercise reservation arithmetic. It does not implement or approve a production QA-release workflow, general production repair CLI, signed Android upgrade or physical warehouse count.


## Automated engineering evidence in CI

The `CI — web and server` Fastify job now also executes the actual two-profile Storage browser and the pg_dump/pg_restore drill after its PostgreSQL tests/build. It uses only that job's disposable localhost `production_mf_ci` service. The restore script accepts `STORAGE_POSTGRES_CONTAINER` for the runner-assigned local Docker container ID; its default remains `storage-postgres-test`. It still creates/drops only UUID-named run-owned databases.

Open the Actions run linked from PR #5 and download `storage-engineering-<tested SHA>` under Artifacts. It contains `operator-result.json`, `restore-result.json`, two viewport screenshots, the credential-free recovery package, and execution logs. Upload runs even after a failed smoke step, retaining whatever evidence exists for 14 days. A missing result file means that drill did not finish successfully, even if earlier screenshots exist. A failed drill fails CI; artifact upload never converts it to success.

Browser tooling is pinned to Playwright 1.65.0 outside application dependencies, with its bundled Chromium installed on the ephemeral runner. Local runs may set `CHROMIUM_PATH=/usr/bin/chromium` and `STORAGE_PLAYWRIGHT_MODULE` to an already-installed matching Playwright module. `STORAGE_ARTIFACT_DIR` selects the evidence folder. No Android signing keys, production database credentials or deployment permissions are needed. These artifacts demonstrate disposable browser/database engineering behavior; the physical Android/staff/deployment release gates still require separate results.

Administration migration 023 adds an immutable catalogue audit table. Include it in full backups/restores and comparisons; never discard its IDs to resolve a retry. Administrative proposals retain their original body/ID/epoch in scoped outbox draft rows and are included in existing original-profile recovery evidence. Even after Chief cache reconciliation they cannot replay against another epoch; stale proposals remain inspectable for independent review. Administrative writes require a fresh proof/current history and remain blocked while posting is suspended. Apply additive migrations in order; do not run the empty-CI setup runner on populated or production databases.
