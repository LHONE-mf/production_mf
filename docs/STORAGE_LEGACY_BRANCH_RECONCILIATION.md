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
