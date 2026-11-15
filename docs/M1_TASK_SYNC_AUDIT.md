# M1 Task Synchronization Audit — 2026-11-08

Status: code inspection, not a passing integration test. Scope: `src/core/sync/{atomicTasks,atomicClient,hybridClient,hybridOutbox}.ts`, `src/modules/{tasks,sync}`, `apps/server/src/sync-routes.ts`.

## Findings and order of remediation

### P0 — Inconsistent local task mutation paths
`src/modules/tasks/TasksModule.tsx` writes unmanaged task status directly to `db.tasks.update`, while server-managed tasks reject offline status changes. `saveServerManagedTask` provides an atomic entity+outbox write but requires an enrolled UUID device and currently refuses a second pending edit. This is inconsistent with the offline-first product requirement. **Next:** test and introduce one task-command path that validates status transitions and atomically writes to local entity/outbox for enrolled tasks; retain explicit legacy demo-only behavior until migration.

### P0 — Task authorization too coarse on server
`apps/server/src/sync-routes.ts` limits task push/pull to chief/master and scopes by organization, but does not enforce workshop/team/assignee visibility or permissible task state transitions. It verifies `createdBy` exists but does not prevent a caller from impersonating another creator or changing creator on update. **Next:** establish server-side task policy, immutable creator and controlled transitions; test cross-user, cross-workshop and role boundaries before worker sync is enabled.

### P0 — Multiple sync implementations
`hybridClient.ts` uses a separate `ProductionMfHybridOutbox` database and non-atomic acknowledgement handling, while active `SyncModule.tsx` uses `atomicClient.ts` and `LiIonProductionDB` tables. Calling the older client can leave divergent queues/cursors. **Next:** identify imports/usages, deprecate unused legacy path safely and add regression test for one authoritative sync queue.

### P1 — Pull conflict recovery
`pullAtomicTasks` correctly keeps cursor and task updates in a Dexie transaction, but blocks the entire pull when any incoming task has a pending local edit or revision gap. The user can inspect conflict versions but cannot resolve them in-app. **Next:** preserve conflict records and allow unaffected entities to progress with a defined durable cursor/replay strategy; never silently overwrite local changes.

### P1 — Device enrollment and offline authorization
Device public keys are accepted as metadata without proof of private-key possession; server checks enrolled, nonrevoked device on push, but the pull endpoint is role-based rather than bound to an enrolled device. Manual login/session and device ID are not yet a complete durable identity flow. **Next:** implement trusted device binding and scoped pull; document offline session expiry/revocation limitations.

### P1 — Retry and result validation
`atomicClient.ts` validates some response fields and preserves rejected operations, but needs tests for malformed acknowledgments, duplicated IDs, interrupted push/pull, stale revisions, and cursor gaps. The server handles up to 50 operations, one transaction per operation, so partial batches are possible by design. **Next:** integration tests using PostgreSQL and two isolated Dexie clients.

## Suggested first test cases
1. Save enrolled task offline: local row and outbox entry both persist after reload.
2. A failed outbox write rolls back task update.
3. Duplicate push returns stable revision without duplicate side effects.
4. Master cannot spoof `createdBy`, change immutable creator, or mutate tasks outside authorized workshop.
5. Worker cannot pull all organization tasks.
6. Two devices edit same task: conflict retained and visible; no data loss.
7. Pull fails midway: cursor does not advance.
8. Existing local-only tasks and old Dexie versions remain readable after upgrade.

## Release gate
No production pilot until authorization, task offline edits, durable outbox/cursor, and PostgreSQL-backed integration tests pass. Do not describe the current hybrid prototype as production-ready.
