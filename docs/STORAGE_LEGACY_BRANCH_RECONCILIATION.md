# Legacy Storage ledger branch reconciliation (2026-11-18)

## Decision
Do **not** merge `feat/storage-authoritative-ledger` or its original migration `020_storage_inventory.sql` into current `main`.

## Verified conflicts
- Current `main` already contains `apps/server/migrations/020_storage_inventory.sql` defining `inventory_*` tables with integer base units, organization-bound foreign keys, immutable operations and explicit inventory access. The historical branch defines an unrelated `storage_*` schema under the **same migration filename**. Replacing the applied migration would be unsafe and could split the source of truth.
- Current `main` already registers inventory catalog, administration, quality, stock operations, issue, output, movement, reconciliation, count, split and custody routes. The historical `storage-routes.ts` would introduce a parallel authoritative stock API.
- Current `main` has `src/core/sync/inventoryOutbox.ts` with an opt-in offline inventory queue; the historical `storageOutbox.ts` uses a second Dexie database and separate transaction model.
- The historical branch is diverged from `main`; direct merging would not be a safe additive operation.

## Required follow-up
1. Keep existing `inventory_*` ledger as the only authoritative stock source.
2. Review the historical branch's tests and specifications for **missing behavior only**, comparing against current inventory test coverage, without copying the old schema or routes.
3. Implement any genuinely missing behavior as a narrowly scoped PR on a fresh branch from `main`, using a **new** migration number only when necessary; never edit applied migrations.
4. Run web/server and unit tests and verify no implicit promotion of local Storage journal entries into confirmed inventory.
5. After coverage verification, close the historical draft PR and delete the superseded branch using repository branch management.

No production database or local offline data has been changed by this audit.

## Historical test and API comparison (source inspection)

Historical `storage-inventory.postgres.test.ts` covers device-proof/tenant separation, repeated manufacturer-lot receipts, quarantine, idempotent retry, competing device issues, stocktake authority, split/move conservation, immutable history, and a committed change feed. Its SQL queries explicitly target the old `storage_*` tables and **cannot be copied directly** to the current `inventory_*` schema.

Current `main` exposes `/inventory/receipts`, `/inventory/stocks`, `/inventory/stream`, `/inventory/changes`, `/inventory/access`, stock-operation, issue, count, split, reconciliation and reporting routes. Its `inventoryOutbox.ts` is already an independent offline inventory queue. These overlap the historical feature set; duplicating them would create competing ledgers.

### Verification required before retirement

| Historical behavior | Current implementation identified | Test parity to verify |
| --- | --- | --- |
| Proofed, tenant-isolated reads/writes | `inventory-routes.ts` and auth/proof modules | Cross-tenant denial on reads, writes and device mismatch |
| Receipt remains quarantined | `/inventory/receipts` and quality routes | No premature available stock; repeated manufacturer lot |
| Idempotent operation retry | `inventory_operations`, stock routes | Same intent returns original result; changed intent rejected |
| Two-device competing issue | Stock operations and issue routes | One winner, revision conflict, no negative stock |
| Authorized count adjustment | Count and reconciliation routes | Chief/manager authority and revocation |
| Partial move/split | Inventory split and stock routes | Conserved quantities and tenant scope |
| Append-only history | Migration 020 and inventory stream | UPDATE/DELETE blocked; cursor progression safe |
| Offline provisional intents | `inventoryOutbox.ts` | No journal backfill; no cross-actor replay; recovery after timeout |

**Coverage status:** API/module overlap confirmed; behavioral parity **not yet proven** by executing the full PostgreSQL and Android test suites. Do not claim all legacy tests have been superseded until each row is covered by tests on current `main`.

## Verified test inventory (2026-11-18)

The current `apps/server/src/inventory-routes.postgres.test.ts` explicitly tests device authorization, quarantined receipt and exact retry, two-device committed-feed cursors, idempotent restore-fence migration, restore races, authorization revocation while blocked on a lock, invalid quantities, and competing device receipts. `apps/server/src/inventory-stock-operations.postgres.test.ts` explicitly tests concurrent stock changes, reservation protection, insufficient stock, exact retries, and append-only operation history.

**Still not established by this inspection:** exact parity of historical fractional quantities (current inventory uses integral base units), same-manufacturer-lot separate receipts, split/move conservation under competing devices, count correction approval, and end-to-end Android recovery after intermittent connectivity. These are validation tasks, not permission to revive the historical `storage_*` ledger. The server CI Storage browser/recovery drill was still in progress when this was recorded.
