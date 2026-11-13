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
There is **no automatic or offline Android outbox for non-receipt mutations**.
Do not issue new movement requests from an offline phone yet; use controlled
online operations after an authorized client interface has been added.
The PostgreSQL reservation integration fixture explicitly synthesizes a
released state in its disposable database to verify server arithmetic; it is
not a manufacturing QA authorization mechanism.

### Synchronization contract

The operation ID is assigned by the sending device and **must be persisted
before the first network attempt**. Never mint a replacement operation ID
when retrying a failed, unknown or timed-out request. The server compares the
full normalized request, actor, device and stock ID for idempotency.

Server-confirmed receipts alone are visible in stock queries and the change
feed. A future client outbox may show locally saved operations as
**provisional**, but must never add them to confirmed/available stock.
After a feed response, a client must apply the events and checkpoint its
cursor atomically; it must not advance its cursor before local persistence.

Inventory transactions use a per-organization advisory lock to serialize
their commit order. This is an intentionally simple first implementation
that may require a scalable transactional-outbox design at high volume.
There is no automatic Android inventory synchronization or local stock
projection in this slice.

## Test expectations and next phases

Run `npm ci && npm run typecheck && npm test && npm run build` under
`apps/server`; real PostgreSQL integration tests require a local disposable
`POSTGRES_TEST_URL` with database name `production_mf_ci`.
The CI migration step validates 020 before integration tests.

**Next:** authenticated server reservation/issue/return with real batch
ownership and no negative balances; explicitly approved release/quarantine
policy; Android provisional transaction outbox with deduplication, conflict
resolution and durable read-cursor updates; warehouse operator screens and
offline/restart tests; factory physical inventory reconciliation.

Until those steps and real two-device tests pass, this is a
**development-only server foundation**, not an accepted manufacturing stock
system. Do not enable it against live production data without deployment,
backup/restore, QA, and warehouse acceptance.
