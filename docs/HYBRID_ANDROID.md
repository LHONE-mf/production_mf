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
