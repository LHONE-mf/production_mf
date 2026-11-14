# Storage inventory API — first server slice (not a production release)

This branch provides a separate authoritative foundation. It deliberately does
**not** reinterpret previous `journal.params.storageEvent` entries, imported
QR packets or Slurry/Assembly observations as confirmed physical stock.

## Schema and permissions

Apply additive migration `apps/server/migrations/020_storage_inventory.sql` **after**
001–019, against a tested backup. The GitHub CI job applies 020 in a disposable
`production_mf_ci` PostgreSQL database. Migration of historical local receipts
into accepted stock is **not automatic**.

- **Materials:** explicit UUID, code, name, category (raw material, component,
  electrode, cell), base unit `mg` / `ul` / `mm` / `pieces`.
- **Locations:** explicit hierarchy (warehouse → rack/cabinet → shelf →
  container area). Each stock entry points to one location.
- **Stock:** internal receipt/container UUID, manufacturer lot, quantity and
  reserved quantity in integer base units, revision, and quality status.
  Manufacturer lot codes can legitimately repeat across multiple containers.
- **Permission:** Chief has implicit warehouse access. Others need an explicit
  active `inventory_access` grant of `operator` or `manager`.
  The generic `master` role does not automatically grant warehouse authority.
  The chief controls access using `POST /inventory/access`; access changes have
  immutable audit events. Only manager/chief can create catalogue entries.
- **Quality:** every new stock receipt begins in **quarantine**. No release
  path is implemented: this is intentional until an approved QA disposition
  workflow exists. The current server has no stock issue/return, QA-release
  endpoints or automatic production-room deduction. Reservations are available
  only for stock whose release was recorded through a future approved QA
  workflow; no existing receipt is automatically released.

## Server routes

All routes require a valid bearer session, and each route needs a matching
`deviceId` and short-lived `x-device-proof` token issued through the existing
Ed25519 challenge flow. Requests from another organization, revoked accounts,
ungranted users or devices must not access inventory.

- `POST /inventory/access`: chief-only grant/revoke of operator/manager access.
  Body: `{changeId,deviceId,userId,level,action}` where action is `grant` or
  `revoke`. Exact same change ID and intent is acknowledged as duplicate.
- `POST /inventory/materials`: manager/chief creates catalogue entries with
  `{deviceId,id,code,name,category,baseUnit}`.
- `POST /inventory/locations`: manager/chief creates a hierarchical location with
  `{deviceId,id,parentId,label,kind}`.
- `GET /inventory/materials?deviceId=...&after=...&limit=50`: authorized,
  device-proven organization-specific material catalogue; maximum 100 per page,
  stable UUID-keyset pagination.
- `GET /inventory/locations?deviceId=...&after=...&limit=50`: similarly
  scoped location hierarchy; includes inactive locations for historical
  provenance; maximum 100 per page.
- `GET /inventory/access/me?deviceId=...`: effective Warehouse access
  (`chief`, `manager`, or `operator`) and capability flags, checked
  against current server grants. No generic Master elevation.
- `POST /inventory/receipts`: authorized operator/manager/chief receives
  quarantined stock with
  `{operationId,deviceId,stockId,materialId,locationId,manufacturerLot,
  quantity,expectedRevision:0,reason,supplier?,receiptReference?}`.
  The response reports `status: confirmed` only after the database commits
  both the stock and its immutable operation entry. Exact retries return
  `status: duplicate` and the original frozen stock snapshot.
  Changed-intent reuse or a competing stock ID returns HTTP 409.
- `GET /inventory/stocks?deviceId=...&after=...&limit=50`: confirmed stock
  snapshot, UUID-keyset pagination, bounded to 100 records per request.
- `GET /inventory/changes?deviceId=...&cursor=0&limit=50`: confirmed immutable
  change records in ascending server sequence, each with the corresponding
  original stock snapshot; bounded to 100 records. The server returns
  `nextCursor` and `hasMore`; a future cursor is rejected.

### Controlled stock transactions (M1.2 server slice)

`POST /inventory/stocks/:stockId/operations` accepts a version-checked,
server-authenticated and fresh device-proofed operation. Every successful
transaction atomically updates stock, reservation ownership (when relevant),
and the immutable operation ledger. The exact same `operationId` + actor +
device + normalized intent returns the original committed snapshot; a reused ID
with a different intent returns HTTP 409. Stale stock revisions return 409.
Stock records always retain their manufacturer lot and receipt identity.

- **Transfer:** `{operationId,deviceId,kind:"transfer",expectedRevision,
  quantity,reason,toLocationId}`. Available to authorized warehouse operators.
  Only the entire **unreserved** container can be moved to an existing active
  location; splitting, relabeling and partial transfers remain disabled.
- **Adjustment:** `{operationId,deviceId,kind:"adjust",expectedRevision,
  quantity,reason,adjustment:"increase"|"decrease"}`. Chief or explicitly
  granted warehouse manager only. Corrections are appended as immutable events;
  a decrease cannot take material reserved for production or create negative
  stock.
- **Reserve:** `{operationId,deviceId,kind:"reserve",expectedRevision,
  quantity,reason,reservationId,productionBatchId}`. Chief/warehouse manager
  only. The batch must exist in the same organization in an active production
  state under a released/in-progress order. Material must already be marked
  `released` under the separate QA policy; this API never releases it.
- **Release reservation:** `{operationId,deviceId,
  kind:"release_reservation",expectedRevision,quantity,reason,
  reservationId,productionBatchId}`. Chief/warehouse manager only.
  Verifies ownership of the exact reservation and batch, and supports
  returning some or all of the reserved quantity to availability.
- **Not implemented:** physical issue to production, return-from-production,
  stock splitting, quality release/hold, and automated consumption. They must
  not be advertised or faked by Android screens.

Changes of these four kinds are now represented in the immutable confirmed
change feed and validated by the inventory client's explicit pull function.
A new **independent Dexie v2 stock-operation outbox** preserves provisional
transfers, corrections, reservations and reservation releases across application
restarts. It never changes the confirmed stock projection locally. Changes
must start from a previously synchronized stock snapshot; stale revisions,
overcommit, partial moves and a second provisional operation for the same
stock in the same user/device scope are rejected locally. The server remains
authoritative for access rights, production-batch references, reservation
ownership, available quantities and the final result. Pending offline changes
are proposals only and do not grant physical stock authority.

Use `queueInventoryStockChange(session,scope,draft)` to persist a request and
`pushPendingInventoryStockChanges(session,scope)` with a **fresh device proof**
after reconnection. Exactly the originally queued operation ID and request
are sent on every retry. HTTP 409 creates an explicit conflict record; HTTP
400/404 creates a rejected record; unknown network responses and expired
authentication preserve the pending operation unchanged. Conflicts are not
automatically rebased or erased. A successful acknowledgment must match the
frozen base snapshot and expected next revision, and is written atomically
with removal of the pending request. Newer confirmed snapshots never regress.
`inventoryStockQueueForScope` allows an eventual UI to display and review
provisional operations; the current Storage operator UI is still NOT
connected to these functions and no automatic stock synchronization is
activated. A trusted warehouse interface and manual conflict-resolution
workflow are required before factory use.
The PostgreSQL reservation integration fixture explicitly synthesizes a
released state in its disposable database to verify server arithmetic; it is
not a manufacturing QA authorization mechanism.

### Synchronization contract

The operation ID is assigned by the sending device and **must be persisted
before the first network attempt**. Never mint a replacement operation ID
when retrying a failed, unknown or timed-out request. The server compares the
full normalized request, actor, device and stock ID for idempotency.

Only server-confirmed operations are visible in stock queries and the change
feed. Local provisional receipts or stock operations never increase or decrease
the confirmed/available balance.
After a feed response, a client must apply the events and checkpoint its
cursor atomically; it must not advance its cursor before local persistence.

Inventory transactions use a per-organization advisory lock to serialize
their commit order. This is an intentionally simple first implementation
that may require a scalable transactional-outbox design at high volume.
There is no automatic Android inventory synchronization. Confirmed
per-scope snapshots are stored only after explicit, validated server
acknowledgments or atomic change-feed application.

## Test expectations and next phases

Run `npm ci && npm run typecheck && npm test && npm run build` under
`apps/server`; real PostgreSQL integration tests require a local disposable
`POSTGRES_TEST_URL` with database name `production_mf_ci`.
The CI migration step validates 020 before integration tests.

**Next:** real operator screens for review/confirmation and manual conflict
handling; approved quality-release policy; physical issuing/returns with
provenance; end-to-end two-device tests and factory stock reconciliation.
No automatic inventory sync or live deployment is approved.

Until those steps and real two-device tests pass, this is a
**development-only server foundation**, not an accepted manufacturing stock
system. Do not enable it against live production data without deployment,
backup/restore, QA, and warehouse acceptance.


### Reviewed recovery (migrations 021–022)

`POST /inventory/recovery-approvals` requires current Chief authority, original proven approver device, and `{approvalId, deviceId, targetActorId, targetDeviceId, epoch, evidenceDigest, reason, evidence}`. The digest is lowercase SHA-256 hex of the canonical device package excluding top-level generatedAt/evidenceDigest. Approval binds the current organization history and exact target; posting may remain suspended. Exact same-ID retries return 200 (new approval 201); altered reuse conflicts. Rows are immutable. No stock ledger mutation or posting-enable operation occurs.

`GET /inventory/recovery-approvals?deviceId=UUID&evidenceDigest=HEX` requires the target's current session, proof and warehouse access. It returns `{organizationId, actorId, deviceId, epoch, postingEnabled, approval}`; approval is null unless target, digest and current epoch all match. Approvals grant cache/history reconciliation only. The full source evidence stays on the original device/export; the server stores its digest, approver/target identities, review reason and document reference.

## Administration creation and effective grants (migration 023)

`POST /inventory/materials`, `POST /inventory/locations` and `POST /inventory/access` now require the current `x-inventory-epoch` as well as a fresh actor/device/session-bound proof. Preflight `/inventory/stream` before freezing an administrative proposal; retry the original body, ID and epoch only. Missing history returns 428; changed/suspended history returns 409. Catalogue creation and grants recheck current authorization after the organization inventory lock. Generic production Master has no implied manager powers. Chief alone grants/revokes warehouse access.

Material/location IDs are stable creation idempotency keys. Exact retry returns the same stored result (200 instead of initial 201); changed intent or another actor/device's reuse returns 409. `inventory_catalog_events` commits the original request, result, actor/device and UTC timestamp atomically with creation and is append-only. Existing catalogue records are preserved without fabricated historical authorship. Historical records without a matching new creation event cannot be adopted by a new request. Access events gain nullable device/epoch columns to preserve pre-023 history; new events populate both.

`GET /inventory/access/users?deviceId=...&after=...&limit=...` is Chief-only, proofed, organization scoped and UUID-cursor paginated (1–100). It returns login, current production role, active flag and effective warehouse level; no password/session/device key. Managers cannot list or change warehouse grants.

The administration UI provides explicit create/review/send operations and scoped grant discovery. Administrative preparation is deliberately online-only. Frozen proposals and accepted replies are retained in the existing v7 outbox draft table under a separate original-profile/scope key. No token is persisted, no automatic posting occurs, unknown/rejected replies retain the original request, and restore/history changes block replay. This does not change existing receiving/stock queues or observational journals. Material/location editing and metadata remain the next S2 slice.

## Versioned catalogue edits (migration 024)

Materials add metadata revision (starting at 1), active flag (true for previously usable materials) and nullable supplier item reference. Locations add metadata revision. No stock revision/balance changes. `POST /inventory/materials/:id/changes` accepts `{id,changeId,deviceId,expectedRevision,name,supplierReference,active,reason}`; code, category and base unit cannot be edited. `POST /inventory/locations/:id/changes` accepts `{id,changeId,deviceId,expectedRevision,label,parentId,active,reason}`; location kind remains fixed. Both require current Manager/Chief, actor-bound proof and `x-inventory-epoch`, rechecked transactionally under the inventory lock. Each accepted edit increments metadata revision and appends before/request/after evidence to the immutable catalogue audit. Exact change-ID retry replays its original result; changed reuse/stale revisions fail 409; other-organization targets fail 404.

Location edits validate hierarchy, parent activity, ancestry/cycles, active children and all stock/historical movement references in the affected subtree. An occupied/historically used path cannot be renamed, moved or deactivated. Empty paths can be changed explicitly with reason; no delete/rewrite endpoint exists. Inactive material cannot receive new stock (404 through the existing material/location eligibility guard). Active is a catalogue receiving policy, not QA release or a substitute for quality disposition.

List APIs add optional metadata fields; prior clients/cached entries remain compatible. New clients validate them before use. Editors retain the selected original version across refresh; preparing a different proposal requires choosing the current version explicitly. Frozen edit requests/replies reuse the scoped v7 administrative proposal storage/manual-send path. No background send or automatic conflict rebase. Unknown/rejected proposals remain inspectable; Chief recovery cannot replay an old epoch.

## Chief-only QA and expiry (migration 025)

`POST /inventory/stocks/:stockId/quality-dispositions` accepts `{operationId,stockId,deviceId,expectedRevision,disposition,reason,evidence}`. Disposition is `release`, `hold`, `block` or `reject`. All four actions require the **current Chief**, current actor/device proof, current organization history, and exact stock revision. Generic Master and explicit Warehouse Manager cannot release or impersonate Chief. Authorization is rechecked after the inventory lock; restored/suspended history fences every new action and exact retry. Exact accepted retry returns the stored snapshot; altered ID reuse conflicts.

The transaction updates only quality/disposition/revision, preserving on-hand/reserved/location/material/lot/expiry. It appends a `quality_change` inventory event with **zero moved quantity**, plus immutable reason/evidence/actor/device/revision disposition evidence. A deferred DB constraint requires the paired disposition before commit. A DB trigger independently requires a current active Chief/device and matching ledger intent/result, and prevents expired or previously rejected material from release. Rejection is terminal in this version; no ordinary endpoint reverses it. Hold/block preserve reservations; they do not make material eligible for use or silently unreserve it.

`GET /inventory/stocks/:stockId/quality-history?deviceId=...&after=...&limit=...` is proofed, warehouse-read scoped, epoch bound, and sequence paginated (1–100). It returns immutable reason/evidence and attribution; wrong-organization targets return 404. Operators/Managers can inspect history but never see Chief decision controls. New clients accept zero quantity only for quality events and validate all optional stock metadata.

Receipts may optionally include `manufacturedOn` and `expiresOn` as valid `YYYY-MM-DD` dates. Manufacturing cannot be later than expiry. **Expiry is inclusive by UTC date**: `2099-12-31` becomes exclusive `2100-01-01T00:00:00.000Z`. Supported dates are 0001-01-01 through 9999-12-30, ensuring next-midnight conversion remains representable. Blank dates remain absent, including on existing stock. Expired receipt may be recorded in quarantine; it cannot be released/reserved/issued for production. Expiry never creates an unaudited stock movement or silently changes the stored quality field. All stock serializers and acknowledgements preserve dates/disposition across moves and corrections. Catalogue active is separate from QA.

Chief decision preparation is deliberately online-only. Review freezes the exact stock/evidence/version/epoch into the original profile's durable outbox draft namespace; explicit send/retry is separate. Unknown outcomes preserve ID; stale/rejected proposals stay inspectable and are never rebased/deleted/replayed automatically. Accepted response, confirmed cache and retained acknowledgement are committed locally together; conflicting prior acknowledgements cannot be overwritten. No Dexie reset/version change or legacy-journal import. Existing restoration evidence includes these proposals/ACKs and blocks old-epoch replay after Chief reconciliation.
