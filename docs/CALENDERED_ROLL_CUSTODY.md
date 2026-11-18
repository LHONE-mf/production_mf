# Measured calendered rolls and direct Cutting custody — 2026-11-17

Engineering candidate on `feat/calendaring-cutting-custody`, stacked on unchanged
[draft #14](https://github.com/LHONE-mf/production_mf/pull/14)
(`c0d454ccd368cbdcfbe795ae9216508699d40338`), then #13/#12/#11/#10/#9/#8.
Latest main checked at `df1c7735f14f8ef268e382b4217f6a31dd2f33bc`.
No production database access, merge or deployment.

## Operator behavior

**Calendaring → Выпуск и передача в нарезку** selects actual acknowledged
Calendaring input-use measurements from the same batch, step and input SKU.
Each entire measurement is claimed once per output declaration. A declaration
can contain multiple physically identified output rolls; its actual parent totals
remain shared declaration genealogy and are not duplicated as quantities
incorporated in every child.

For each physical roll, select an explicit output SKU and enter its actual label,
independently measured length, optional independently measured mass and explicit
ready/held transfer disposition. Length is canonical **mm** (form entry m), mass
is **mg** (entry g), with exact conversion only within each dimension. No gap,
thickness, pressure, speed, throughput, mass/length ratio or yield calculation
becomes an actual output measurement. Existing CalenderRuns and calculators are
preserved; saving them never silently declares output or physical custody.

Trim length and scrap mass are separate optional measured observations. Blank is
**unknown**, distinct from explicitly measured zero. A note explains unreconciled
quantities, with explicit operation/specification references, reason and evidence.
Output remains `qualityStatus: unreviewed`, `materialAccountingStatus: unreconciled`
and `genealogyScope: declaration`. Ready means available to offer, not QA approval.
Input use and output are separate observations: this slice does not certify their
physical incorporation, loss balance, elongation or technology-card compatibility.
The operator explicitly chooses the output SKU/specification; no chemistry or
polarity is inferred from its name.

A ready whole roll is offered directly to an explicitly selected active member
of the **next applicable approved route step**, which must be Cutting. The offer
reserves one physical roll without granting receiver custody. **Cutting →
Подтверждённая приёмка рулонов** lets only the assigned current receiver separately
confirm actual count and the physical label. An optional independent length, if
provided for receipt, must match the declared measured length; blank explicitly
means not remeasured. A note records the physical check.

A discrepancy records observed mismatch without custody or freeing the source
reservation; a later exact receipt remains possible. No further events follow
final receipt. Partial physical roll transfers, cancellation/reassignment,
remnant splitting/reidentification and corrections remain separate work.
Unprocessed input length stays with its original received roll; it is never
silently declared as a new calendered output. Cutting receipt does not record
actual Cutting use, cut pieces, rejects, Sorting custody, warehouse acceptance
or any QA release. Tape policies and existing warehouse approvals are unchanged.

## Persistence and authority

Additive PostgreSQL **041–042** adds immutable output headers and exclusive actual
input claims, extends existing room output lots with a nullable Calendaring origin,
and reuses the existing handoff/event tables. Slurry mg lots, coated-roll lots,
earlier consumption and original ACKs retain their prior meaning. Every populated
old row is preserved; no migration invents output or receiver custody.

Current organization/device proof, actor and workshop membership, approved route,
active batch and eligible ancestry remain required. Output attribution is limited
to its actual input author or the current room Master/Chief. Source events must
share the same batch/step/input SKU. New transfer and receipt check current
upstream QA/expiry and active output catalogue. Only the assigned current receiver
can acknowledge physical receipt. Exact original retry returns the original ACK
under current authorization after a later hold, while new custody stays blocked.

Database guards enforce current history/posting on the new commands, exact
source/ACK snapshots, paired claims/lots and unique operation ownership. The
organization lock and exclusive input claims prevent duplicate declaration or
double reservation across devices. Existing Chief-only warehouse QA and issue
approval policies are unchanged. All new events have **zero warehouse effect**.

The existing Calendaring length-balance helper now explicitly restricts its source
to Coating→Calendaring receipts, preserving its old snapshot shape. A newly received
Cutting roll cannot become another Calendaring source merely because both receipts
count physical rolls. Shared custody reconstruction keeps the two room flows and
their units separate.

## Offline behavior and verification

Scoped forms, captured source/catalogue options and frozen proposals use the
existing receiving-draft store. Main Dexie **24**, outbox **v7**, existing data,
archives, queues, journals, dependencies and lockfiles are unchanged. Prepared
forms can be edited/saved offline. Sending is separate and preserves original
body/IDs, source snapshots, actor/role/device/scope/epoch. Unknown or lost replies
retry the same original body. Exact ACK validation precedes archival; a late reply
cannot overwrite a newer local conflict. Current history changes preserve the old
proposal for review. While preparing another form asynchronously, editing of the
previous form is disabled so its data cannot be attributed to another source scope.

Targeted tests cover actual-input claims, independent outputs/null unknowns,
wrong SKU/unit/measurements, held sources, route bypass, proof/history, assigned
physical identity, discrepancy then receipt, exact replay, competing enrolled
senders, later QA holds, immutable SQL pairing and global operation IDs.
Populated **040→042** compares every old row and then completes new output,
offer and assigned Cutting receipt.

The actual two-profile browser saves output/offer/receipt offline, reopens, loses
committed output and receipt replies and retries identical bytes. It verifies
separate discrepancy without custody, exact count/physical label, the async
form-switch regression, unchanged warehouse rows and layouts at **390/412/1365 px**.

The actual **63-table pg_dump/two-fresh-restores** drill preserves all earlier
history, two independently measured calendered rolls (one held), a single shared
actual-input claim, separate Cutting discrepancy/receipt and original ACKs.
Reconstruction retains original Calendaring input remainders and counts the new
Cutting receipt separately; immutable guards and history fences survive restore.
Full local counts and exact-source hosted checks/artifacts belong to the draft PR.

Next: actual Cutting input-length use, measured cut pieces/rejects/remnants and
direct Cutting→Sorting custody with explicit units. Incorporation/loss balance,
physical remnant splitting/corrections, factory foil/tape measurement policy and
later room flows/pairing/pouch/physical cell acceptance remain open. Browser
reopening is engineering evidence, not signed Android process-death or installed
upgrade proof. Native OnePlus 15/ColorOS 17 and physical factory acceptance remain
gates. No merge or deployment.
