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
  workflow exists. The current server has no stock issue/return/reservation
  endpoints or automatic production-room deduction.

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
