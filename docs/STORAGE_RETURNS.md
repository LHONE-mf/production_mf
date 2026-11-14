# Received-material returns and scrap (S5)

Migration 027 is additive. It preserves prior stocks, reservations, receiving/QA/handoff events and all local queues. Roll back application code before considering schema rollback; never delete outcome evidence or synthesize compensating stock. The sole warehouse balances remain `inventory_stocks` and immutable `inventory_operations`.

## Physical rules

An actual **received** S4 issue is the only source for a production return. Immutable `inventory_issue_outcomes` retain the issue, original package, production batch, accountable actor/device, condition, exact base-unit quantity, reason and witness evidence. Outstanding ownership equals issued minus accepted returns, authorized issued-material scrap and actual consumption. S5 records no consumption; its consumed quantity is explicitly zero. Settlement revision and aggregate caps are checked under the organization inventory lock, including concurrent devices.

A traceable untouched unused return creates a **new physical package UUID**, with inherited material/manufacturer lot/unit, manufacture date and the earliest original/current source expiry. It becomes released/available immediately without another Chief QA release. It never pools into the original package. Current source/ancestor hold, block, rejection or expiry prevents normal return and later reservation/dispatch of descendants. A child release cannot override an ancestor hold. Unsafe conditions are rejected without stock; the frozen original request and rejection remain inspectable. Physically isolate damaged/contaminated/altered/unknown material and obtain Chief disposition rather than retrying it as untouched.

Chief or an explicitly granted Warehouse Manager may scrap **issued material**, settling outstanding ownership without another warehouse debit. Separate **warehouse scrap** debits only the unreserved quantity of a warehouse package and requires witness evidence; it preserves QA, expiry, location and existing reservations. It may dispose held/expired stock. Neither path is disguised as a count correction. Generic production Master and warehouse Operator cannot authorize scrap.

## APIs and usable screens

- `GET /inventory/returns?deviceId&after&limit` supplies warehouse-only paginated received-issue choices, current source eligibility and settlement. Human material/batch/recipient labels accompany stable identities.
- `POST /inventory/issues/:issueId/outcomes` requires fresh actor/device proof and the original `x-inventory-epoch`. Common fields are `operationId,deviceId,issueId,productionBatchId,sourceStockId,expectedSettlementRevision,quantity,reason,evidence,kind`.
- `kind=return` additionally requires `expectedSourceRevision,stockId,locationId,condition`. Only `condition=untouched_unused` may post. Its new-stock event and immutable outcome commit atomically. `kind=scrap` has no stock effect and requires Chief/Manager.
- `GET /inventory/issues/:issueId/outcomes?deviceId&after&limit` returns immutable scoped outcome history and settlement. Production requesters/recipients retain current workshop-scoped visibility without receiving warehouse balances.
- `POST /inventory/stocks/:id/operations` accepts separate `kind=scrap`, exact revision/quantity, reason and `evidence`; only Chief/Manager. The existing global stock queue performs explicit confirmation/send.

`InventoryReturns` provides source selection, exact quantities, condition and location, offline normal-return freezing, privileged issued-scrap preparation, explicit per-intent sending, history and original request/reply inspection. `StockChangeForm` supplies the separate warehouse-scrap control and witness. An exact accepted retry replays its original ACK, even after the returned child changes; changed ID reuse conflicts. Tenant, current grants, proof/device revocation, history rotation and suspended posting are checked before new writes and retries.

## Offline and verification

InventoryOutbox remains **v7**. Outcome intents use a distinct original-profile/scope namespace in the existing draft table. No secrets are persisted. Only validated recognized ACK fields enter durable storage; stock/ACK/accepted proposal commit atomically. Offline freezing does not mutate confirmed stock. Privileged preparation is online-only and compares the original screen epoch. Unknown/conflicting/rejected/old-history intent stays retained; no reconnect posting, silent rebase or automatic history rebinding occurs. New warehouse stock proposals retain their original epoch; warehouse scrap requires one.

Actual PostgreSQL tests cover partial/concurrent caps, provenance, roles/tenant scope, current ancestor holds/expiry, direct DB pairing/immutability, reservation protection, grant revocation while waiting for locks, history changes, populated upgrades and both scrap paths. Real two-profile browser tests cover unsafe denial, offline return/reload, lost committed ACK/exact retry, competing returns, normal direct availability without QA, and both scrap screens with visible witness history. The actual custom dump/two restores compare 40 tables and reconstruct 11 stock events, three stocks, one remaining generic reservation, one received issue, five handoff events and two outcomes.

Route A is extended with real WebView/native proof, return/lost ACK, unsafe return/operator scrap denial, Chief warehouse scrap and independent PostgreSQL assertions. S5 commit 1b9fd42 passed Route A 43623064716 with independent PostgreSQL verification and all web/server/browser/restore checks; artifacts and digests are in STORAGE_FEATURE_MATRIX.md. Physical ColorOS handling, signed upgrades, production backup/TLS and factory reconciliation remain pilot gates. S6–S10 are still required.
