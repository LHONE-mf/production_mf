# Actual Calendaring use of received coated rolls — 2026-11-16

Engineering candidate on `feat/calendaring-roll-consumption`, stacked on unchanged
[draft #13](https://github.com/LHONE-mf/production_mf/pull/13)
(`f57d74d71f42ad04636df62bc3d8dfaa6e6b171d`), then #12/#11/#10/#9/#8.
Latest main checked at `df1c7735f14f8ef268e382b4217f6a31dd2f33bc`.
No production database access, merge or deployment.

## Operator behavior and accounting basis

**Calendaring → Фактический расход рулонов** loads explicitly received, physically
identified coated rolls. The operator selects a production batch, Calendaring
step and SKU, records an independent actual processed-length observation, then
allocates it partially across one or more received rolls of that same SKU.
Explicit allocations must sum exactly to the separate actual length. Each roll
retains its original receipt, physical label, genealogy, consumed length,
remaining length and revision. Different SKUs require separate measurement events.

Length uses canonical **mm**, entered as **m**, with exact within-dimension
conversion and no rounding. Capacity comes directly from the independently
measured Coating roll length preserved in the original acknowledged receipt
snapshot: `capacityBasis: coating_measured_roll_length`. The previous physical
receipt confirms one whole roll and its identity; it may explicitly record that
length was not remeasured. One roll is never treated as one metre. This accounting
basis is visible in the form and source details. No nominal/supplier roll length,
mass/length ratio, density, machine speed or calculated pass length is invented.
The actual processed length remains a separate operator measurement.

An initial 400 mm roll and actual 250 mm use leaves **150 mm unprocessed length**.
That remainder remains attributed to the original physically received roll; it is
not a new output roll, warehouse package or independently verified remnant. No
fractional roll-count custody is created. Physical splitting/reidentification,
transfers of remnants to other batches, returns/scrap and compensating corrections
require later explicit workflows. The current whole-roll transfer reservation
cannot be bypassed by allocating length. Multiple pass/rework accounting is not
inferred: this command attributes use of the original input length once, and does
not allow repeated processing to spend the same original length again.

Recorded use creates **no warehouse debit**, QA disposition, output quantity,
accepted yield, calendered-roll declaration, Cutting custody or legacy CalenderRun.
Existing local calculators and journals remain available. Observed output, trim,
rejects, unknown loss and material reconciliation remain separate work. Tape and
foil issue/consumption policies are unchanged.

## Persistence, authority and offline behavior

Additive PostgreSQL **040** adds immutable measurement headers and allocation
rows referencing existing received room-handoff events. Existing populated rows,
original ACKs, catalogue units and all earlier migrations are retained. There is
no mutable duplicate room balance: source length/revision are reconstructed from
the original immutable receipt measurement and actual allocation events.

Current organization/device proof, production batch/approved Calendaring route,
current workshop membership and assigned receiver or room Master (or Chief) are
required. Sources must belong to the same batch, destination step and explicit
SKU. Current active catalogue, original QA/expiry ancestry, exact capacity and
revision are checked. Chief-only warehouse QA and existing issue approvals remain.
An original retry returns its original ACK under current authorization even after
a later source hold; new use stays blocked by that hold.

The organization inventory lock serializes competing devices. SQL guards enforce
paired immutable header/allocations, exact totals/source-before/ACK snapshots,
current source authority/eligibility, history/posting and globally disjoint
operation IDs. A multi-row SQL INSERT cannot overspend an input. Integer length
precision, not fractional physical roll counts, controls allocation capacity.

Durable scoped forms and proposals use existing Dexie receiving drafts. Main
Dexie **24**, outbox **v7**, dependencies, lockfiles and old queues/journals remain
unchanged. Loading requires connectivity; prepared forms can be edited and saved
offline. Sending is a separate action. Original body/IDs, source snapshots,
actor/role/device/scope/epoch survive reopen and unknown/lost replies. Exact ACK
validation precedes archival, pending overlap holds prevent a second local
proposal against the same source, and a late reply cannot replace newer local
conflict state. Scope changes retain existing forms and history changes prevent
posting an old proposal automatically.

API: `GET /inventory/room-materials/calendaring/rolls`, and
`GET/POST /inventory/room-materials/calendaring/consumptions`.
Read pages are bounded and validate scope/cursors. Commands carry `materialId`,
`actualLengthMm`, observed time, operation reference, reason/evidence and explicit
receipt allocations with original operation IDs and expected source revisions.

## Verification and next work

Targeted real-PostgreSQL tests cover partial/multiple rolls, source remainders,
SKU/route/proof/epoch/revision/quantity failures, two enrolled competing devices,
original retry after a parent QA hold, immutable paired SQL history, forged ACKs,
operation namespaces and single-statement multi-row overuse. Populated **039→040**
compares every old row, verifies no invented historical use, then records actual
new consumption. Client tests cover exact units and measured capacity, durable
original offline/reopen/lost-ACK retries, overlap holds, changed history, forged
replies and late responses.

The actual Chromium screen saves a 250 mm observation offline from a 400 mm roll,
reopens, loses a committed reply, retries the identical body, verifies one event
and 150 mm remaining, unchanged warehouse stock, and layouts at **390/412/1365 px**.
The real **61-table pg_dump/two-fresh-restores** drill preserves old history and
new use, reconstructs 250 mm used/50 mm remaining from its separately measured
300 mm source, exact original ACKs, immutable guards and epoch fences. Its fixture
is distinct from the browser's 400 mm source.

Full local counts and exact-source hosted checks/artifact links are recorded in
the draft PR. Browser reopening does not establish signed native Android
process-death or installed-upgrade proof. OnePlus 15/ColorOS 17, physical measured
capacity/consumption acceptance and factory reconciliation remain release gates.

Next: independently measured calendered-roll output tied to actual use and direct
Calendaring→Cutting offers/assigned receipt; then actual Cutting→Sorting flow.
Material incorporation/loss reconciliation, remnant splitting/corrections and
factory foil/tape measurement policy remain open alongside subsequent room flows,
pairing/pouch and physical finished-cell acceptance.
