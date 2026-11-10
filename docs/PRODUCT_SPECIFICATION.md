# Production MF — Product Specification and Roadmap
Status: approved architecture direction (hybrid offline + server); proposed functional scope. Updated: 2026-11-08.
Source of truth for future product architecture. Existing implementation must be checked in code and CI; a planned feature is not an implemented feature.

## Mission and release boundaries
Production MF is an offline-capable manufacturing execution system (MES) for lithium-ion battery manufacturing. Android is the shop-floor client, web is the management client, and a central Fastify/PostgreSQL service coordinates shared state. Dexie/IndexedDB preserves local operation while offline. Not an ERP, SCADA, battery cycler controller, or validated LIMS.

Primary outcomes: task execution, production orders, material/batch traceability, quality decisions, inventory, equipment history, and management reporting.

## Architecture decision B (approved)
- Offline-first writes: commit local entity and durable outbox operation in **one Dexie transaction**.
- Server is authoritative for shared synchronized entities; organization-scoped authorization and revisions are mandatory.
- HTTPS push/pull uses stable operation IDs, idempotent processing, expected revisions, durable cursors, and explicit conflict outcomes.
- Local clients apply acknowledgments and pulled changes transactionally. Never silently overwrite conflicts.
- Offline permissions require provisioned, time-limited authorization; server enforces all access on reconnect. Revocation cannot be enforced immediately on a disconnected device.
- QR/BLE/text transfer, if retained, is an optional channel and cannot bypass authentication, scope checks, audit, or server reconciliation. No unconditional 'forced' writes.
- Never erase original production/quality records on correction; append revision/audit events.
- Maintain backwards-compatible Dexie migrations and test upgrades against existing databases.
- Deploy with TLS, backups/restores, credential management, audit, monitoring, and integration tests before real production use.

## Roles and primary screens
| Role | Home | Primary navigation and actions |
|---|---|---|
| worker | My shift, assigned work, pending sync | My Tasks; authorized Production stage; Record Measurements/Defects; My History; Sync/Profile |
| technologist | Process deviations, QC alerts | Specifications/Recipes; Production journals; Quality; Batch genealogy; Process reports |
| master | Shift WIP, blocked operations | Tasks/assignment/approval; Production handovers; Team workload; Quality escalation; Shift reports |
| chief | Orders, output, yield, bottlenecks | Planning; All Tasks/Teams; All Production; Quality/Inventory; Reports; Users/Devices/Settings |

Navigation should be role-aware, but hiding UI is **not** authorization. Enforce policy on server and local write layer. Android favors quick scanning/data entry; web favors dense tables and planning.

## Core user journeys
1. Supervisor creates a task and assigns an authorized worker; worker can start, submit, and resume offline; supervisor reviews; both devices converge after sync.
2. Manager creates production order and selects a versioned process route; batch moves through approved operations with recorded input/output quantity and handovers.
3. Operator scans batch, identifies equipment and approved specification version, records process parameters and material lots, submits an operation.
4. Inspector records inspection results; an authorized user can hold/release a batch; held batches cannot progress through controlled steps.
5. Manager traces a cell or batch back to electrode batches, slurry mixes, materials, electrolyte, operators, and QC/formation history.

## Production model
Existing stages in `src/stages/registry.ts`: storage, slurry, coating, calendaring, cutting, sorting, assembly, electrolyte (dry room), electrolyte-705, walzing, formation. Two filling rooms are locations/route variants, not automatically consecutive stages. Cathode and anode have separate material lineages that converge at assembly. Aging, final QC, finished goods, and format-specific branches are proposed future capabilities; do not claim they already exist.

## Proposed server data model (introduce incrementally)
Identity: organizations, users, devices, sessions, sites, workshops, shifts.
Planning: products, production_orders, process_routes, route_steps, specification_versions.
Execution: batches, operation_runs, operation_measurements, batch_transfers, batch_genealogy.
Materials: material_lots, batch_material_consumption, inventory_locations, inventory_transactions.
Quality: inspection_plans, inspections, measurement_results, nonconformances, quality_dispositions.
People/equipment: tasks, task_events, task_comments, equipment, downtime_events, calibrations.
Sync/audit: sync_operations, sync_entities, device_cursors, sync_conflicts, audit_events.

Key constraints: every record organization-scoped; immutable UUID identifiers; unique batch codes within organization; revision/version fields; foreign keys for lineage; quantity + unit; UTC event timestamps and actor IDs; approved specifications versioned; server-side authorization and valid state transitions. Batch genealogy must represent split, merge, scrap, and consumption. Track individual cell IDs only where necessary.

## Current repository baseline (2026-11-08)
- React/TypeScript/Vite/Capacitor Android; Dexie schema and production stage screens under `src/stages`.
- Four roles: worker, technologist, master, chief; `src/core/permissions.ts` is UI-side policy, not sufficient server authorization.
- `apps/server` has PostgreSQL migrations and Fastify authentication/task sync prototype; see `docs/HYBRID_SERVER.md` for limitations.
- `src/core/sync` contains hybrid task outbox/revision paths; `src/modules/tasks/TasksModule.tsx` still blocks certain offline edits to server-managed tasks.
- No claim of full end-to-end batch genealogy, inventory, QC, or production-ready multi-device sync.
- Existing historical `docs/ARCHITECTURE_PRINCIPLES.md` and `docs/DEVELOPMENT_PLAN.md` describe superseded fully-offline assumptions.

## Prioritized backlog and acceptance gates
### M0 — Architecture/reliability (P0)
- [ ] Canonical documentation and code inventory; flag historical documents.
- [ ] Validate Android upgrades, system insets, data retention, backup/restore.
- [ ] Test Dexie schema upgrades and critical navigation/workflows.
Gate: CI green, tested upgrade/restore, architecture docs consistent.

### M1 — Hybrid task sync (P0)
- [ ] Audit all task writes and enforce entity+outbox atomicity.
- [ ] Authenticate devices, enforce organization/role/task scopes on push and pull.
- [ ] Permit supported offline task status transitions, then synchronize.
- [ ] Handle conflict/retry/rejection explicitly in UI.
- [ ] PostgreSQL-backed multi-device tests: offline edits, duplicate push, stale revision, restart, revoked device.
Gate: two authorized devices converge without silent loss or unauthorized data exposure.

### M2 — Production orders and batches (P1)
- [ ] Order/route/versioned route-step contracts and migrations.
- [ ] Batch identity and lifecycle; cathode/anode lineage; route variants.
- [ ] Input/output transfer records and batch detail/history UI.
Gate: one pilot batch completes a documented route with traceable handovers.

### M3 — Stage operations (P1)
- [ ] Shared operation-run service and validation against specification versions.
- [ ] Integrate existing stage journals incrementally without losing records.
- [ ] Capture operator, equipment, quantities, measurements, material consumption.
Gate: stage records form an auditable batch history.

### M4 — Quality and inventory (P1)
- [ ] QC measurements, defects, hold/release enforcement.
- [ ] Material lots, stock movements, reconciliation, scrap/yield.
Gate: nonconforming material is blocked and traceable.

### M5 — Operational scale (P2)
- [ ] Shifts, equipment/downtime, dashboards, exports.
- [ ] Backup/restore drills, monitoring, security hardening, pilot rollout.
Gate: validated workshop pilot, not just a demo.

Effort estimates are provisional; implement in small PRs with automated tests and reviewed database migrations.

## M1 implementation checkpoint — 2026-11-10

This checkpoint records implementation evidence, not M1 release approval. The
original milestone checkboxes above remain open until the acceptance gate is
verified on two independently enrolled physical devices.

- Implemented and CI-tested: transactional Dexie task/outbox writes, sequential
  offline edits, acknowledgement validation, strict pull cursor/sequence
  validation, explicit local archive before accepting a server version, and
  rejection/conflict preservation across IndexedDB restart.
- Implemented and CI-tested: server-bound device proof for task reads/writes,
  PostgreSQL workshop-scoped authorization tests, and a simulated competing-edit
  scenario with two authenticated users, duplicate push, and convergence checks.
- Manual sync now drains up to 20 upload batches and 20 download pages per tap,
  with progress messages. Automatic background synchronization remains disabled.
- AndroidKeyStore and server proof exchanges have passed earlier emulator
  instrumentation, but emulator workflows are manual-only to avoid long runs
  for ordinary changes.
- **Remaining release gate:** validate two *separately enrolled physical Android
  devices* end to end, including offline edit conflicts, restart, device
  revocation, and recovery of archived edits. Validate Android upgrades and
  backup/restore without losing existing production records.
- **Not yet production-ready:** no verified live two-device pilot, and the
  broader M0 upgrade/restore gate is still open. M2–M5 remain future milestones.

## Next sprint: concrete work
1. Audit `TasksModule.tsx`, `atomicTasks.ts`, `hybridOutbox.ts`, and server sync handlers for inconsistent writes and permissions.
2. Add failing regression tests for offline edits of server-managed tasks and atomic outbox persistence.
3. Implement smallest safe fix; run tests, Android APK build, and emulator smoke; inspect artifacts.
4. Define initial batch/order/route types only after task-sync gate passes.

## Documentation governance
This file is the canonical **product** plan. `docs/HYBRID_SERVER.md` documents implemented server API limitations; `docs/TARGET_STRUCTURE.md` is a nonbinding code-layout target; `docs/PROGRESS.md` contains historical work logs. Do not interpret old fully-offline directives as current product requirements.
