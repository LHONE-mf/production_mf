# Measured coated rolls and Calendaring custody — 2026-11-16

Engineering candidate on `feat/coating-roll-custody`, stacked on unchanged
[draft #12](https://github.com/LHONE-mf/production_mf/pull/12)
(`b5a601f6bec73f537cd69c7a48d405323cf733c0`), then #11/#10/#9/#8.
Main checked at `df1c7735f14f8ef268e382b4217f6a31dd2f33bc`.
No merge, deployment or production database connection.

## Operator behavior

**Coating → Выпуск и передача рулонов** explicitly selects actual acknowledged
Slurry and collector-foil consumption events for the same batch and Coating step.
Each entire measurement is attributed once to one output declaration. A declaration
may contain several physical rolls; its parent totals belong to that declaration
and are not duplicated as incorporated quantities on each child roll.

Each physical roll has a separate ID, operator-entered physical label, explicitly
selected active electrode SKU issued in rolls, independently measured length,
optional independently measured mass and explicit ready/held disposition.
Unknown mass and scrap stay **null**, distinct from explicitly measured zero
scrap. Length is canonical mm (entry m); mass is mg (entry g), with exact conversion
within each dimension only. There is no calculated mass/length conversion or
inferred yield. The accounting note and specification/operation references are
required. Local CoatRuns, pump calculations and packet handovers are not promoted
to measured events.

Tape requires either an explicit not-applicable explanation or **unmeasured**
references to received Coating-support tape issues. These preserve the original
SKU's application, width, thickness and whole-roll issue identity. Referencing
tape does not consume it or invent partial-roll use/remainder. Tape remains a
separate material, never a Slurry ingredient.

A ready physical roll can be offered once, whole, to an explicitly selected active
member of the **next applicable approved route step**, which must be Calendaring.
An offer reserves one roll; it does not establish receiver custody. The assigned
receiver separately enters actual count and physical label. An optional independent
length observation, when supplied for receipt, must match the declared length;
blank means not remeasured. A measurement note explains what was checked.
**Calendaring → Подтверждённая приёмка рулонов** records either an exact receipt or
a separate discrepancy. A discrepancy creates no custody, does not release the
reservation and can precede a later exact receipt. No further events follow receipt.
Partial roll splitting, cancellation/reassignment and corrections are future work.

All declarations remain `qualityStatus: unreviewed`,
`materialAccountingStatus: unreconciled`, `genealogyScope: declaration`.
Ready is a transfer disposition, not QA approval. None of these commands creates
warehouse stock, warehouse acceptance, consumed Calendaring material, a legacy
CalenderRun or accepted yield. Actual Calendaring use/output is the next milestone.

## Persistence and authority

Additive PostgreSQL **038–039** adds immutable output headers and exclusive parent
claims, extends existing room output lots with a nullable origin link, and reuses
existing handoff/event tables for direct Coating→Calendaring custody. Slurry mg
lots and their old snapshots/ACKs retain their original behavior. Populated upgrades
retain every old row; they never synthesize output or receiver custody.

Database guards require paired claims/lots and exact source/ACK snapshots, current
source ancestry QA/expiry, current route and batch, device/organization authority,
source author or Coating Master with current workshop membership (or Chief), and
the assigned current receiver. Source holds block new transfer/receipt; exact
original replay remains idempotent under current authorization. Organization locks
and exclusive claims serialize competing devices. Global operation-ID ownership,
immutable event history, current proof and inventory epoch remain enforced.
Chief-only warehouse QA and existing issue approval rules are unchanged.

Forms and frozen proposals use existing scoped Dexie receiving drafts; main
Dexie **24**, outbox **v7**, existing local journals, backups, queues and dependencies
remain unchanged. Saving and sending are separate actions. Original IDs, exact
body, source snapshots, actor/role/device/scope/epoch survive offline save, page
reopen and unknown/lost replies. Exact ACK validation precedes archival; a late
response cannot overwrite newer local state. A history change leaves original
evidence pending for review. Form preparation disables the previous form while
loading, preventing edits being attributed to a different asynchronously loaded scope.

## Verification and remaining gates

Targeted PostgreSQL tests exercise actual input claims, whole-roll reservations,
assigned identity, discrepancies, holds, two sender devices, immutable SQL guards,
namespace/proof/history checks and additive populated 037→039 upgrade. Client tests
cover units/nulls, durable offline original retries, mismatched ACKs, overlap holds
and late-response conflicts.

The actual UI browser uses isolated authenticated Coating/Calendaring profiles,
saves output/offer/receipt offline, reopens, loses committed output and receipt
replies and resends identical original bytes. It checks discrepancy creates no
custody, exact physical identity/count, unchanged warehouse stock, a delayed
form-switch regression and layouts at **390/412/1365 px**.

The real pg_dump/two-fresh-restores drill compares **59 tables**, preserves earlier
business history, two measured rolls (one held), shared actual input claims,
received typed unmeasured tape references, discrepancy/receipt, original ACKs,
immutable guards and epoch fences. It reconstructs one received coated roll
separately from earlier Slurry mg balances and repairs only disposable damaged
warehouse/issue projections while posting is stopped.

Full local counts and current-source hosted check/artifact links are recorded in
the draft PR. Browser reopen is engineering evidence; it does not establish signed
Android process-death, installed upgrade or OnePlus factory acceptance. Still open:
actual factory foil/tape measurement policy, measured incorporation/loss balance,
partial-roll use/splits/corrections, Calendaring→Cutting→Sorting→Assembly actual
flows, pairing/pouch/physical cell acceptance and factory reconciliation.
