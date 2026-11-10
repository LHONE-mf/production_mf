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

**M1 checkpoint (2026-11-10):** Engineering implementation now covers
shared task creation, assigned-worker offline progress, short-lived Android
network proof plus server-provisioned 8-hour offline authorization, durable
conflict deferral, user-bound local sync caches, device-proven current task
visibility snapshots, and explicit non-destructive conflict recovery.
PostgreSQL integration, fake-IndexedDB restart/migration and Android emulator
tests support those flows. **M1 has not passed its release gate**: two physical
devices with real server provisioning, scope-change behavior, installation
upgrade/restore and production deployment still need acceptance. See
[`docs/M1_RELEASE_CHECKLIST.md`](M1_RELEASE_CHECKLIST.md).
Automatic background synchronization remains disabled.

### M2 — Production orders and batches (P1)
- [ ] Order/route/versioned route-step contracts and migrations.
- [ ] Batch identity and lifecycle; cathode/anode lineage; route variants.
- [ ] Input/output transfer records and batch detail/history UI.
Gate: one pilot batch completes a documented route with traceable handovers.

**M2 checkpoint (2026-11-10): planning and batch API implemented; M2 remains open.**
The additive `006_m2_planning.sql` migration establishes organization-scoped
production orders, route identity and versioned ordered steps, immutable approved
route versions, cathode/anode/common route lines and per-organization batch codes.
The `007_m2_batch_lifecycle.sql` migration adds optional positive batch
quantities and immutable creation/status event history. Existing shop-floor
records are not migrated or modified.

Server API now supports: chief/technologist route drafts, new draft versions
copied from the latest approved version, transactional replacement of draft
steps, chief approval, chief-only order creation and release, chief-only batch
creation against released orders, and chief-only batch state transitions
(created → in_progress/hold/scrapped; in_progress → hold/completed/scrapped;
hold → in_progress/scrapped). Completed and scrapped are terminal. Every API
batch state transition and creation is committed with an append-only event.
Stale `expectedStatus` changes are rejected, and hold/scrap require a reason.
Real PostgreSQL integration tests cover actor and tenant boundaries, rollback,
immutable route steps, conflict detection, event ordering and terminal status.
All automated checks passed on commit `6fcb588` (CI `42813936459`).

**M2 UI checkpoint (2026-11-10): web/Android planning workspace implemented, M2 still open.**
The `Планирование` tab now uses the *verified server login* through
`src/core/sync/serverConnection.ts`, never the local demo user's token.
The online-only workspace allows authorized planners to create workshops,
draft/approve/fork routes, select workshops for ordered steps, and inspect
versions. Server chiefs can create/release production orders, create
cathode/anode/cell batches, transition their states and review append-only
status history. It shows API errors and warns that M2 changes have **no offline
queue**. Local logout clears the volatile server session and offline task
access grant. The Fastify server has exact-origin CORS for the Android Capacitor
WebView and local development; separately hosted web origins must be explicitly
added via `CORS_ALLOWED_ORIGINS` (comma-separated full HTTPS origins).
Automated backend, API-client and rendered UI role-gating tests have passed
on commit `8410646` (CI `42818123387`); Android APK packaging is
tracked separately.

**M2 access and provenance checkpoint (2026-11-10):**
A master now sees only approved route summaries whose entire ordered step
list is within the master's current workshop memberships. Revocation is
covered by PostgreSQL tests (commit `e0ce32b`, CI `42820531741`).
The additive `008_m2_batch_genealogy.sql` migration and authenticated,
chief-only batch-link API provide append-only, tenant/order-scoped batch
provenance declarations: source and target identities, separate quantities
and units, link kind, actor, note and server timestamp. The API restricts
links to completed sources and available targets, disallows invalid branch
pairings and prevents graph cycles under a per-order advisory lock.
PostgreSQL tests verify immutable history, cross-tenant/order protection
and cycle rejection (commit `bf20694`, CI `42821484472`).
These declarations **do not** move inventory, guarantee mass balance,
automatically update batch statuses or constitute a validated physical
handover. No real manufacturing records are modified.

**M2 handover checkpoint (2026-11-10): online send/receipt flow built, M2 remains open.**
Additive migration `009_m2_stage_handoffs.sql` stores immutable sent
handoffs and separate immutable destination receipts. The authenticated
server checks the order's approved route, consecutive steps in the
batch's cathode/anode/cell line, quantity and unit, active batch state,
previous receipt and tenant ownership. Chiefs can send; chiefs or masters
with current destination workshop membership may receive, but the sender
cannot confirm their own transfer. Masters see only their authorized
pending inbox. A batch with unacknowledged handoffs cannot be marked
completed. The Planning screen shows stage transfer history, supports
sending the next eligible step and provides an incoming-transfer inbox.
This is **online only**, not M1 task sync or a verified physical movement,
inventory posting or production-yield calculation. Automated client,
UI and PostgreSQL integration checks cover routing and permissions.

**M2 genealogy and integrated API pilot checkpoint (2026-11-10):**
The online Planning page now shows direct, actor-attributed genealogy links
between batches from one production order; chief users can declare links
using completed source batches, explicit source/target quantities and units,
and optional reference notes. Declarations remain provenance only, not
physical consumption or inventory transactions. A client-generated stable
declaration UUID allows safe retries after an uncertain HTTP response;
the PostgreSQL API returns the original result for an identical retry and
rejects different data under the same ID.

An isolated full-stack PostgreSQL test completes a *simulated* pilot flow:
approved route -> released order -> cathode/anode/cell batches -> cathode
coating-to-cutting handover -> independent master receipt -> completed
electrode batches -> two source-to-cell provenance links -> completed cell
batch and audit-history verification. No deployed service or factory
equipment participated. CI `42843086813` passed 130 server tests and
frontend checks on commit `87532ef`. This demonstrates integration
consistency, **not** M2's real workshop acceptance gate.

**M2 route-step evidence checkpoint (2026-11-10):**
The additive `010_m2_step_evidence.sql` migration and authenticated
`/planning/batches/:id/steps` API provide append-only, organization-scoped
records of a specific approved route step being started, completed (with
a reported quantity and unit), or flagged with a deviation note. Step
records retain the actor, server timestamp, optional equipment reference,
original route version and workshop. Recording a later step's start
requires completion evidence for the preceding branch step **and** its
independently confirmed handover. Stable client event UUIDs allow
idempotent retries. The online Planning screen includes a separate
route-step evidence panel; existing local stage journals remain untouched.
PostgreSQL tests cover identity and branch FKs, activity and sequence
rules, independent receipt, immutable history and exact retries.
**This does not yet enforce full completion of a batch against all its
route steps**, reconcile measured yields, validate equipment, or link
local legacy journals to server events. No production equipment was
connected and this is not an accepted real-world route.

**Remaining for M2:** integration of actual stage journals and inspection
results, closing the batch-status gate against complete route evidence,
broader workshop-scoped sender/operator permissions, traversable multi-level
genealogy UI, reconciled input/output material quantities, true split/merge
execution, a physical end-to-end pilot and deployed-server acceptance.
M1 shared synchronization still applies to tasks only; its physical
two-device acceptance is deferred, **not** passed.

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
