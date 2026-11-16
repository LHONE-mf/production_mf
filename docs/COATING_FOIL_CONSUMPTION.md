# Actual Coating collector-foil use — 2026-11-16

Engineering candidate on `feat/coating-foil-consumption`, stacked on unchanged
[draft #11](https://github.com/LHONE-mf/production_mf/pull/11)
(`b7c5635e90b6706a56d479757e27b2ea0cbb4d89`), then #10/#9/#8.
Main rechecked at `df1c7735f14f8ef268e382b4217f6a31dd2f33bc`.
No merge, deployment or production connection.

## Operator behavior and limits

**Coating → Фактический расход фольги** records independently measured collector
foil use from **physically received, approved warehouse issues**. Choose the
actual material, production batch and Coating step, then explicitly allocate
partial quantities from one or more received lots of that same SKU and unit.
Enter observation time, operation-card reference, an explicit foil specification
reference, total actual use, reason and measurement evidence. Allocation totals
must equal the separately entered actual total.

The first implementation supports material issued and measured by length
(canonical **mm**, form entry **m**) or mass (**mg**, entry **g**), with exact
within-dimension conversion and no rounding. This is a capability boundary,
**not a decision that the factory issues its foil in either of those units**.
Actual factory issue/use measurement remains to be confirmed. Roll-issued foil
cannot supply these balances: no roll length, density, area or conversion is
inferred. Typed tape is excluded and remains under its own specification and
remainder workstream. No default foil metal, dimensions or polarity are created.

The source list contains scoped received materials in these supported units.
The operator explicitly attributes the selected material as collector foil by
its specification reference; this is not automatic chemical identification or
server certification of a technology card. Different SKUs need separate measured
events. An Al/Cu pairing rule, recipe compatibility and complete incorporation
into a coated output are not implied.

Saving a form/proposal works offline after loading the sources. Sending is a
separate explicit action under current device proof and server scope. The
original scoped body, operation IDs, local author role, source snapshots and
epoch survive page reopen and unknown/lost replies. Exact retry returns the
original ACK even after a later hold. Changed-body replay, source/revision or
history changes are retained as conflicts/rejections. A late response cannot
replace newer local state. No local journal, CoatRun or calculated web length
is promoted to measured consumption.

## Accounting and authorization

Migration **037** adds one immutable measurement header table
`inventory_coating_foil_consumptions` and a nullable `foil_consumption_id` on
`inventory_issue_outcomes`. Every allocation is an existing **consume** outcome,
sharing the same settlement revision and remainder with returns, scrap and
Slurry's existing settlement mechanism. There is no second quantity ledger.
Only approved warehouse dispatch debits warehouse stock. Foil use has no
warehouse effect and cannot replenish stock.

The command requires a current active production batch/approved Coating route,
current tenant/device proof, assigned source receiver or Coating Master/current
membership (or Chief), active selected catalogue material, exact SKU/unit,
received issue, current source/ancestor QA eligibility and expiry, remaining
quantity and settlement revision. Current authorization is also rechecked after
work that can wait on locks. Warehouse Manager authority alone does not grant
room consumption. No approval policy is weakened.

The organization inventory lock and issue locks serialize API competitors.
Database guards pair every header/allocation, enforce current source quantities,
original receipt ACK and settlement snapshots, exact totals/ACKs and immutable
history. Global operation-ID ownership includes the new zero-stock header.
A single multi-row SQL allocation statement cannot overspend a source.

The additive migration keeps every existing row and original ACK. It extends
only the consumption-parent constraint/guard and operation namespace; return,
scrap, Slurry mass consumption, tape specifications and warehouse ledgers retain
their existing contracts. Dexie **24**, outbox **v7**, dependencies and lockfiles
are unchanged. Pending forms/proposals reuse existing scoped durable storage.
Do not drop this history when rolling back a candidate; retain additive schema
and use a compatible application release after foil events exist.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /inventory/room-materials/coating/foil` | Scoped received candidate lots, current shared settlement and eligibility |
| `POST /inventory/room-materials/coating/foil-consumptions` | Exact measured single-SKU use with explicit partial/multiple lots |
| `GET /inventory/room-materials/coating/foil-consumptions` | Immutable original measurements under current history scope |

The command contains `operationId`, `deviceId`, `productionBatchId`, `stepNumber`,
`materialId`, `unit`, `observedAt`, `reference`, `specificationReference`,
`actualQuantity`, `reason`, `evidence`, and allocations with independent
`operationId`, `issueId`, `quantity`, `expectedSettlementRevision`.
The ACK retains that request plus actual actor/server time, zero warehouse
effect and original received-issue/settlement snapshots in allocation order.
Both read endpoints use bounded UUID pagination and current organization,
actor/device and epoch context. Closed batches retain readable history.

## Verification and next work

Tests cover exact mass/length use, partial/multiple lots, shared return balance,
unreceived/wrong source or unit, scope/proof/epoch/QA failures, two separately
enrolled/authenticated devices competing, immutable original replay after hold,
global ID reuse, missing allocation pair, forged source ACK and single-statement
SQL overuse. Client tests cover exact request/source validation, durable reopen,
lost/forged replies, overlapping local proposals, role/epoch change and late ACK.

A real Chromium workflow saves 500 mm measured use offline from an 800 mm
received issue, reopens, loses the committed reply, retries identical bytes and
shows 300 mm remaining. Warehouse stock stays unchanged. Screenshots cover
390/412/1365. This proves browser behavior, not native Android process death.

Populated **036→037** compares every old row (new nullable link excluded) and
creates no historical consumption. The actual backup/two-fresh-restores drill
compares **57 tables**, reconstructs original foil source/settlement snapshots,
500 mm used/300 mm remaining, original ACK, restored immutability and history
fence. Exact committed-source counts and hosted runs are recorded in the PR.

Remaining: roll-issued foil measurement/conversion policy, actual tape use and
recoverable partial-roll remainder, measured Coating output/roll identity and
Calendaring custody, then other room flows, corrections, pairing/pouch and
physical cell acceptance. Factory/native OnePlus 15/ColorOS 17, installed upgrade
and physical reconciliation are separate release gates. Keep draft; do not merge
or deploy without the owner's explicit approval.
