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
**M0 clean-start checkpoint (2026-11-11, development branch only):**
The application no longer creates built-in demo users, sample tasks,
recipes, batches, material runs, defect criteria or imaginary work records
when an IndexedDB table is empty. Startup preserves all existing local data,
even when only legacy demo account IDs remain: those identities do not prove
that measurements or pending changes are still examples. A typed-confirmation
reset at local login is the only destructive cleanup path. First run now creates a user-selected local chief with a salted PBKDF2
password; the local directory supports actual create/edit/activation and the
role dashboards/reports read local data instead of static sample statistics.
No server-side PostgreSQL records are affected, and no offline MES auto-sync
has been added. The reset is intentionally destructive to local data and
requires installed-APK upgrade acceptance before a production rollout.

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
The batch-status endpoint now blocks `completed` until **every step of
the batch's own route branch** has completion evidence and any sent handovers
have independent receipts. A batch whose branch has no route steps is also
blocked from completion. This is a record-presence gate, **not** validation
of measured yields, equipment, inspection results, physical movement, or
legacy local journals. No production equipment was
connected and this is not an accepted real-world route.

**M2 quantity-flow checkpoint (2026-11-10):**
The chief-only, online, read-only `GET /planning/batches/:id/quantity-flow`
endpoint reports per-step completion output, the recorded outgoing handover,
its independent receipt state, and an exact PostgreSQL NUMERIC output-minus-
handover difference when units match. Missing handovers and the last route
step return a null difference. This is an **audit comparison**, not inferred
waste, mass balance, inventory movement, or a physical verification. Isolated
PostgreSQL tests cover permission isolation, exact six-decimal subtraction,
and sent-versus-received states. The Planning batch detail now offers a
separate read-only quantity-flow panel with refresh and explicit warnings
against treating the difference as verified waste. No migration or existing
journals changed.

**M2 manual local journal reference checkpoint (2026-11-10):**
The additive `011_m2_local_journal_links.sql` migration adds a chief-attested,
append-only server reference to an existing generic `db.journal` record.
Explicit UI selection transfers only a source UUID, stage, original timestamp,
summary and optional defect note; it does not migrate, edit, auto-sync or
delete the local record. The server validates the approved route branch/step
and stage, scopes all reads/writes to an authenticated organization and actor,
enforces unique source IDs per organization, and supports exact idempotent
retries. Demo-style non-UUID identifiers are rejected. These pointers are
**claims by an authorized supervisor**, not authenticated operator logs,
equipment measurements, verified yield, or valid completion evidence.
Other legacy manufacturing-run tables are not yet integrated.

**M2 typed local manufacturing runs checkpoint (2026-11-10):**
An additive migration `012_m2_local_run_sources.sql` expands the existing
append-only manual reference ledger to distinguish source stores by
`(organization,source_kind,source_entry_id)`, keeping existing generic
journal links. The supervisor can now intentionally attach a local slurry
`mixBatches` record or coating `coatRuns` record through the same Planning
batch panel. Selected records may carry explicitly labelled values for reported
dry solids mass (kg) or side-A coating length (m), respectively. They never
autofill step-completion evidence or the authoritative quantity-flow audit.
No automatic upload, local Dexie rewrite, inventory posting, or equipment
controls are introduced. The API validates source kind/stage and metric
compatibility; PostgreSQL and UI tests cover these boundaries. Full stage-run
coverage, quality checks, and physical pilot validation remain future work.

**M2 calendering/cutting references checkpoint (2026-11-10):**
The additive `013_m2_calender_cut_sources.sql` migration extends the
chief-attested manual source ledger to support local calendering and cutting
run records, with operator-reported calendered length (m) and whole good-cut
electrode count (pieces). Source type, approved route stage, and metric kind
are validated at API and database boundaries; the mobile Planning selector
shows these only for the matching step. A non-integer count is never silently
rounded. Existing local records and already linked records are unchanged;
nothing is auto-uploaded or promoted to verified batch yield, QA approval or
inventory. Isolated PostgreSQL and UI tests exercise the new source types.

**M2 sorting and assembly run checkpoint (2026-11-10):**
Migration `014_m2_sort_assembly_sources.sql` extends the append-only
supervisor-attested source references to local sorting (`sortRuns`) and
cell assembly (`assemblyRuns`) journals. A sorting record may include the
original **incoming good electrode count** from the cutting stage—not
sorting's outgoing accepted quantity. Assembly may include the record's
declared cells-out count. Both metrics are positive whole-piece counts and
are always labelled as unverified local claims. The server restricts sorting
references to sorting route steps on electrode batches and assembly references
to assembly steps on cell batches; a source link is never route completion,
inventory movement, QA release or equipment control. The Planning panel
reads the existing Dexie stores on demand and transmits only selected
metadata, summary, limited defect notes and optional count after explicit
confirmation; it does not auto-upload or alter local manufacturing records.
CI includes PostgreSQL isolation tests, source validation and frontend
interaction tests. Final manufacturing QA and two-device physical pilot remain
outstanding.

**M2 inspection observation checkpoint (2026-11-10):**
The additive `015_m2_inspection_observations.sql` migration adds immutable,
chief-attested measurement and visual observation records keyed to a batch's
approved route version and its electrode/cell branch. Observations can be
added while a batch is in progress or held; identical UUID retries are safe,
but changing an old observation is forbidden. The online Planning detail
shows the history and offers explicit measurement/visual entry with an
optional attention flag, requiring a note when attention is requested.
Measurements preserve exact six-place decimals and named units.
**No inspection plans, automatic specification comparisons, independent
inspector approvals, acceptance disposition, batch release/hold automation,
production quantity mutations or inventory postings are implemented.**
Flagged observations alone do not block completion; supervisors must
separately place affected batches on hold pending a future QA workflow.
CI PostgreSQL tests assert actor and tenant isolation, route integrity,
immutability, idempotency, and that inspection notes do not become route
completion evidence. M4 formal quality release remains outstanding.

**M2 flagged-inspection review gate (2026-11-10):**
The additive `016_m2_inspection_reviews.sql` migration adds chief-attested
append-only review events for flagged inspection observations. Latest review
outcomes are `follow_up_required` or `reviewed_no_block` and each requires
a written rationale. They are sequenced under a locked batch row with
idempotent UUID retries and cannot be overwritten. The completion endpoint
now returns `inspection_review_pending` while any flagged observation lacks
a latest `reviewed_no_block` triage; a later follow-up record reopens this
guard. Unflagged observations require no triage. The Planning panel shows the
latest result, lets the chief document a review, and explains the block.
This is **not** independent QA disposition, inspection-plan validation,
specification compliance, product release, or automatic batch hold. Chief
triage does not certify fitness-for-use, and a formal QA release workflow
remains planned for M4.

**M2 inspection review audit visibility (2026-11-10):**
The batch inspection history now includes **all** append-only chief triage
reviews for each observation, in chronological review-number order, alongside
the existing latest-review summary. The Planning screen offers an expandable
per-observation review history showing outcome, rationale and timestamp.
This avoids hiding earlier follow-up decisions when a later review changes the
technical completion guard. It does not grant formal QA acceptance authority.

**M2 route-bound reference inspection limits checkpoint (2026-11-10):**
The additive `017_m2_inspection_criteria.sql` migration adds immutable
inspection reference criteria for steps in an **approved** versioned route.
A chief may enter a named characteristic, recognized unit, lower and/or
upper exact-decimal limit, and an optional note. New criteria are blocked
as soon as the route version is used by any production order. Existing
records remain available for audit and safe idempotent retries, with no
retroactive threshold changes for existing batches. Read-only access for
technologists is available through the route API, while batch-specific
queries expose only the relevant cathode, anode, or cell route branch.
These are planning references, **not validated test methods or automatic
product conformance**, and the app never calculates a QA pass, grants release
or automatically changes manufacturing status. Formal inspection-plan
approval by an independent quality authority remains future work.
Isolated PostgreSQL authorization, immutability, numeric and branch tests
cover the new reference registry.

**M2 advisory measurement-to-criterion comparison (2026-11-10):**
The inspection history API now joins each exact-decimal measurement to a
frozen route-version reference criterion only when the step, normalized
characteristic name and unit all match. PostgreSQL computes inclusive
within/below/above-reference comparisons without JavaScript floating-point
rounding. Missing criteria, different units and visual findings produce
`no_reference`; all comparisons are informational. The Planning UI labels
the reference boundaries and clearly states that this is **not a formal QA
pass/fail, batch release, or automatic hold**. No production state or
inventory changes are made. Server and UI tests cover the behavior.

**M2 multi-level genealogy navigation checkpoint (2026-11-10):**
The online chief batch detail now supports following incoming and outgoing
declarations across multiple levels, including batches outside the currently
loaded order list. A visited path, back and return-to-start controls preserve
orientation; browsing never retargets the batch's operation forms. Exact
declared quantities, units, author, timestamp and notes remain visible.
The server now pages direct links with explicit `hasMore`/`nextAfter` metadata
and a batch/tenant-bound UUID cursor, preserving PostgreSQL microsecond
ordering. The UI exposes incomplete pages, retries failed reads without
discarding loaded declarations, rejects malformed/mismatched responses and
ignores late navigation responses. This remains read-only provenance, not
verified consumption, stock movement, yield or QA approval. Local automated
tests and Chromium phone/desktop checks against disposable PostgreSQL passed;
Android emulator/physical acceptance was not performed for this change.

**M2 local source quantity comparison checkpoint (2026-11-10):**
The read-only quantity-flow screen now compares a single linked calendered
length, good-cut count or assembled-cell count with declared step output in
the same engineering unit, using exact PostgreSQL decimal subtraction.
It shows the source summary/IDs and explains missing output, different units
or multiple measured references. Input dry-solids mass, partial side-A coating
length and incoming sorting counts remain informational; multiple records
are not summed because their physical scope may overlap. This is an advisory
declaration comparison, not a material balance, stock movement, verified yield
or QA decision. PostgreSQL, client-validation, UI and phone/desktop browser
checks passed; physical production acceptance remains open.

**M2 local-reference correction checkpoint (2026-11-11):**
Chiefs can withdraw an incorrect manual journal reference with a mandatory
reason. Additive migration `018` keeps the original reference and appends an
immutable actor/time/reason record. Exact retries are safe; concurrent attempts
cannot rewrite the decision. Withdrawn values are excluded from advisory output
comparisons and counted explicitly. The Android/web history retains the source
and reason, and refreshes comparisons after correction. This does not reopen a
completed batch or alter its evidence, quality decisions or inventory. Existing
source identities remain reserved; existing snapshots cannot be edited.
Automated PostgreSQL, rendered UI and phone/desktop browser checks passed;
physical acceptance remains outstanding.

**M2 controlled source replacement checkpoint (2026-11-11):**
Chiefs can explicitly replace a withdrawn reference with a different saved local
source of the same type and execution scope. Migration `019` appends immutable
predecessor/successor history with a mandatory reason, author and time. Original
references stay withdrawn and their identities stay reserved. Atomic insertion
and exact retries prevent partial or duplicate corrections. New replacements
require an active batch; historical retries cannot reopen or reactivate it.
The form retains both references and refreshes advisory quantity comparisons;
only saved metrics are used. Same-identity snapshot edits and cross-batch source
relocation are unsupported. PostgreSQL, UI and phone/desktop browser checks
passed; formal reconciliation, stock posting and physical acceptance remain open.

**Remaining for M2:** integration of actual stage journals and inspection
results, reconciling documented route-step quantities and units,
broader workshop-scoped sender/operator permissions,
reconciled input/output material quantities, true split/merge
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
