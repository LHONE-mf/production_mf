# Android hybrid synchronization adapter (incremental)

The first Android-side building blocks live in `src/core/sync/hybridOutbox.ts` and `hybridClient.ts`.

- A **separate** Dexie database `ProductionMfHybridOutbox` holds pending operations and the pull cursor, leaving existing LiIonProductionDB migrations unchanged.
- `queueTaskOperation` stores a task mutation before any network request.
- `pushPendingTasks` sends at most 50 queued operations and removes only acknowledged operations; conflicts remain visible for manual resolution.
- `pullTaskChanges` calls an injected consumer before advancing the persisted cursor. A consumer must apply changes durably and idempotently.
- The adapter requires an explicit HTTPS server URL and an in-memory bearer token. It does **not** persist credentials.

## Important: not yet connected

These are intentionally isolated primitives, **not** a functioning Android sync feature. No UI or existing task store invokes them yet. Do not enable automatic synchronization or treat existing local demo task IDs as server UUIDs. The server currently accepts only UUID task and user IDs and only the simplified task payload/status model. The existing app's task status enum and richer task fields require a versioned mapping before integration. Existing demo data must not be uploaded.

## Next integration requirements

1. Decide server URL provisioning and secure Android token storage, with a trusted-device challenge/response.
2. Implement a versioned task DTO mapping with stable UUID identities and a safe import strategy.
3. Persist local task edits and the outbox operation in **one Dexie transaction** (move outbox into the main DB or introduce a transactionally safe bridge); the separate DB currently does not guarantee atomic task + outbox writes.
4. Apply remote tasks and cursor atomically, or use an idempotent consumer and recoverable cursor progression.
5. Implement conflict resolution UI and background retries with backoff and connectivity checks.
6. Add integration tests for restart, airplane mode, duplicate delivery, revocation, concurrent edits, and crash recovery.

No production data is migrated or transmitted by this change.

## Atomic opt-in task path (Dexie v16)

New `src/core/sync/atomicTasks.ts` and `atomicClient.ts` use three new tables in the existing `LiIonProductionDB` (schema v16): `hybridTaskOutbox`, `hybridTaskRevisions`, and `hybridSyncMetadata`.

- `saveServerManagedTask(task, deviceId)` writes a task and its pending operation **in one IndexedDB transaction**. It refuses non-UUID legacy/demo task and device identifiers and refuses a second unacknowledged edit to the same task.
- `pushAtomicTasks(session)` atomically records acknowledged revisions and deletes acknowledged operations; conflicts remain available for manual handling.
- `pullAtomicTasks(session)` applies changes and advances the cursor **in one IndexedDB transaction**. It refuses overwriting unmanaged local tasks, pending local edits, or revision gaps.
- No app UI currently calls these opt-in functions. Existing local operations, including the Zustand task store, continue unchanged; the separate prototype outbox is **not migrated** automatically.

**Caution:** The server's simplified task DTO is not sufficient to reconstruct the full production Task model (description, priority, creator, history, attachments, status distinctions). The current pull path inserts placeholder values for new server tasks and must not be used on production records until a versioned full-fidelity DTO and migration are implemented. No automatic background sync has been enabled.

## Task wire format v1

The new `src/core/sync/taskDto.ts` and `apps/server/src/task-schema.ts` define a versioned full task payload: title, description, six statuses, priority, assignment, creator, timestamps, stage, technical-card reference, comments and attachments. The server validates the payload and tenant user references. `atomicTasks.ts` now queues the full DTO; `atomicClient.ts` reconstructs complete tasks on pull.

**Migration warning:** previously queued prototype operations use the old three-field payload and will be rejected by the updated server. Do not delete existing queues automatically; introduce a deliberate migration or conflict recovery path before enabling sync. Attachments are currently JSON-embedded and limited to 1 MB each and 30 per task; large files need a separate authenticated blob transport. UI integration remains disabled.


## Synchronization failures and conflict handling

Outbox entries have three distinct states:
- `pending`: queued for server delivery.
- `conflict`: the server has a different revision. Inspect the two versions before deciding what to retain.
- `rejected`: the server refused the operation (for example, invalid assignment or unenrolled device). The server's rejection reason is saved for diagnosis.

Both conflict and rejection entries remain stored locally and are **not automatically retried** or discarded. The synchronization screen displays each affected task and supports read-only comparison against the server's current task. A safe write-side conflict resolution workflow is not implemented yet; do not manually delete outbox records to make an error disappear. Earlier installations may contain rejected operations recorded as `conflict`; these legacy entries are not reclassified automatically.


## Single-organization device binding (temporary safety restriction)

Because the existing Dexie task and revision tables are not tenant-partitioned, a device is bound to one server origin and one organization on first verified server login. A subsequent login for a different organization/server is blocked. Login checks the server-returned organization ID against the requested organization before establishing the binding. This is intentionally **not** multi-tenant support.

If a device already contains synchronization revisions, queued operations, or a legacy task cursor without a tenant binding, login refuses synchronization. Preserve and back up the database; a deliberate migration is required. Do not delete the cursor or outbox manually to bypass this check. Local-only task data is not deleted by this guard.
