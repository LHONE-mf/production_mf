# Storage — authoritative inventory foundation (implementation slice)

Status: **backend foundation implemented on `feat/storage-authoritative-ledger`**, not a factory-ready Storage room. This is an additive development branch. It is not merged into the active `feat/hybrid-server-foundation` branch.

## Approved manufacturing decisions

- Raw materials, components, finished electrodes and finished cells.
- Manufacturer lot code is the user-facing lot identifier. Lot UUID, receipt UUID and stock-unit UUID are separate immutable technical identities. Repeated deliveries of the same manufacturer lot are valid.
- Locations require warehouse, cabinet, shelf and container names.
- Offline transactions are **provisional** until the server commits. Client offline outbox/UI is not yet implemented; the server must never treat a local journal or signed QR/BLE history packet as confirmed stock.
- Chief and explicitly appointed Warehouse Manager may reconcile quantity. Manager authorization is stored per organization, not inferred from a Master role.
- Manual and future production-triggered material issues must not be double-posted. Actual production-room integration is not enabled in this slice.

## Current API — server schema 020

All /storage endpoints use authenticated bearer sessions and a valid short-lived `x-device-proof` token bound to the deviceId (provided in the request body or read query). See the existing M1 proof enrollment/refresh flow.

| Operation | Route | Authorization |
| --- | --- | --- |
| Create material | POST /storage/materials | Chief |
| Create precise location | POST /storage/locations | Chief |
| Grant/revoke scoped warehouse-manager permission | POST /storage/warehouse-managers | Chief |
| Record physical receipt in **quarantine** | POST /storage/receipts | Authenticated active user |
| Explicit recorded stock release | POST /storage/stock/:id/release | Chief only, reason required |
| Issue confirmed stock | POST /storage/stock/:id/issue | Chief or authorized Warehouse Manager |
| Split/move stock to another location | POST /storage/stock/:id/move | Chief or authorized Warehouse Manager |
| Reconcile stock to counted physical quantity | POST /storage/stock/:id/reconcile | Chief or authorized Warehouse Manager |
| Read actual server stock-unit balances | GET /storage/stock?deviceId=UUID&after=UUID | Proofed authenticated user |
| Read committed operation change feed | GET /storage/changes?deviceId=UUID&cursor=N&limit=N | Proofed authenticated user |

Each POST requires `operationId` and `deviceId` UUIDs, both stable across retries. Versioned stock mutations additionally require `expectedRevision`; conflicting concurrent mutations return HTTP 409, no overwrite. A byte-equivalent parsed intent submitted with the same operationId, actor and device returns `alreadyRecorded: true` and **does not create a second stock event**. Intent changes under a reused operationId are rejected. Every accepted write creates a DB-authenticated `storage_operations` record with server time. Quantity-affecting changes create immutable `storage_ledger_entries`, including two legs for a split move. The initial receipt creates a quarantined stock unit. Published stock is not sourced from local journal history.

### Example: physical receipt

```json
{
  "operationId": "<client-stable-uuid>",
  "deviceId": "<enrolled-device-uuid>",
  "receiptId": "<new-receipt-uuid>",
  "stockUnitId": "<new-stock-unit-uuid>",
  "materialId": "<existing-material-uuid>",
  "lotId": "<manufacturer-lot-uuid>",
  "manufacturerLotCode": "LOT-A",
  "manufacturer": "Producer A",
  "locationId": "<existing-location-uuid>",
  "quantity": "2.125",
  "supplier": "Supplier X",
  "documentReference": "Invoice 17",
  "evidence": "Measured upon arrival"
}
```

The material and location catalogue entries must already exist. A repeated receipt can use the same lotId when code/manufacturer/material match, or a different lotId with the same printed lot code. No quantity is aggregated across incompatible units. Countable units require integral quantities; all arithmetic uses PostgreSQL NUMERIC, never Javascript float addition.

### Stock release is NOT a formal QA acceptance

Because the factory's QA-release authority is not yet specified, this slice only permits an authenticated Chief to record an explicit release with an evidence reason. **Do not interpret this as approved QA disposition.** Before operational deployment, the owner must confirm QA authority, the necessary inspection evidence, and whether release should require a separate signature or a second approver. Until then, keep this endpoint and the Storage room behind an experimental/server-not-deployed rollout gate.

### Audit and data preservation

Migration 020 leaves `src/core/db/index.ts`, `journal.params.storageEvent`, storage-history QR/BLE payloads and other room schemas intact. No backfill from old local records is performed. `storage_stock_units.on_hand` is a transactional server projection updated in the same PostgreSQL transaction as immutable events. To reconstruct it, aggregate each stock unit's `quantity_delta` ledger movements; compare with on_hand, and **never** use local Storage receipts as source of verified quantity. `storage_operations`, `storage_ledger_entries`, `storage_receipts` and `storage_lots` have UPDATE/DELETE protection triggers.

## Synchronization contract for the next slice

- Dedicate a new Dexie outbox to inventory commands; do not extend the existing task-only `/sync/push` payload to arbitrary stock data.
- An offline operator action is a **provisional intent**, persisted with a stable operationId, exact decimal string, actor, device, stock revision, material/lot/location and confirmation context. Display pending until a server response is persisted locally.
- On reconnect, a proofed client pushes the same command. HTTP 201 accepts and confirms a stock transaction; HTTP 200 with `alreadyRecorded:true` confirms a prior accepted retry; HTTP 409 is an actionable conflict, **never** silently overwritten. A timeout or connection loss retains the original command.
- Device sessions and proof expiry must pause writes and preserve pending operations; never silently use another actor's queue.
- GET /storage/stock provides a paginated authoritative snapshot. GET /storage/changes provides an ascending, committed, per-organization sequence of non-administrative operation results. Clients must durably persist events before advancing a pull cursor. A response from one device does not prove another device has seen the change.
- Treat mixed-unit totals, stale snapshots, multiple receipts of a manufacturer lot, changed stock locations and QA dispositions as separate conditions. Labels: **saved locally / awaiting server / server confirmed / rejected / conflict**.
- This is a **server protocol contract**, not a claim that the client sync loop is built yet. A consistent snapshot-plus-feed bootstrap protocol and exact recovery after partial pagination still need implementation and tests.

## Integration with future rooms

A future Slurry receipt/issue adapter must pass a server-authenticated production batch ID and one unique idempotency operation per physical consumption. A saved Slurry journal, QR export or plan cannot itself deduct stock. Similar constraints apply to Coating foil, electrode handover after Sorting, Assembly cell components, finished electrode and cell arrivals. Physical receipt, release, reservation, issue and production consumption remain distinct recorded actions.

## Open implementation work

1. Operator-first Russian Storage UI, material and location search, receive / stock / move / issue / stocktake flows with explicit confirmation and Android safe areas.
2. Additive Dexie inventory outbox and confirmed projections, correct two-phone reconciliation, cursor/pagination recovery and conflict UI.
3. Stock reservations and confirmed consumption linked to production batches, with double-issue prevention and status transitions.
4. Returns, blocked/expired disposition, QA authority policy, initial physical stocktake/cutover with approval, audit pagination and richer container genealogy.
5. Installed-app upgrade/backup/restore and actual shop-floor trial. CI/PostgreSQL tests do not substitute for physical stock verification.

## Deployment

Apply `apps/server/migrations/020_storage_inventory.sql` **after** 019 on the real server only after the schema and QA/role policies are reviewed. This migration is additive; it introduces new empty tables and does not delete old data. Do not expose the new endpoints against real materials until the release policy and operational UI are approved. A schema downgrade that deletes these tables would destroy inventory history and is **not** an acceptable rollback; roll back application binary only while retaining the schema and committed events.
