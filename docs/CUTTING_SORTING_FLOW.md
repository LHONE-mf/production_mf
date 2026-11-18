# Actual Cutting use, counted output and partial Sorting custody — 2026-11-17

Engineering candidate on `feat/cutting-sorting-flow`, stacked on unchanged
[draft #15](https://github.com/LHONE-mf/production_mf/pull/15)
(`e86f0101024c6148d592739e4889d2e88f9d4c88`), then #14–#8. Main was checked at
`df1c7735f14f8ef268e382b4217f6a31dd2f33bc`. No production database access,
merge or deployment. Earlier material-flow checkpoints describe their own sources.

## Operator behavior

**Cutting → Материалы** records independently measured actual input length.
Select explicit received calendered rolls from the same batch, route step and
input SKU; allocate a partial length from one or several receipts. Each receipt
retains its own original measured length, consumed length, remainder and revision.
Canonical length is **mm**; form entry in m converts exactly within that dimension.
Capacity comes from the independently measured calendered roll acknowledged with
physical receipt, never from nominal roll dimensions or a fresh warehouse debit.

**Cutting → Выпуск и передача в сортировку** selects acknowledged actual Cutting
use. Each complete input measurement is claimed once per output declaration.
One declaration can contain several separately labelled output lots, each with
an explicit active electrode SKU whose base unit is **pieces**, an independently
observed whole piece count, and ready/held transfer disposition. Parent length
observations remain shared declaration genealogy; they are never duplicated as
length incorporated in each child. No mm→pieces, mass→length, yield, polarity,
grade or technology-card compatibility is inferred.

Rejected pieces, trim length and scrap mass are separate optional observations.
Blank is **unknown**, distinct from measured zero. The operator supplies a note
explaining unreconciled quantities, specification/operation references, reason
and evidence. Output stays `qualityStatus: unreviewed`,
`materialAccountingStatus: unreconciled`, `genealogyScope: declaration` and
`warehouseEffect: none`. Ready permits an offer; it is not a QA release.
Existing Cutting journals/calculators remain independent and never silently
record actual material use, output or custody.

A ready lot can be offered in explicit partial counts to an assigned active
member of the next applicable approved route step, which must be **Sorting**.
Offers reserve the selected piece quantity. Multiple offers cannot exceed the
source count; for example, 4 then 5 from a 9-piece lot is allowed, 4 then 6 is not.
The recipient is selected explicitly; no intermediate Storage receipt is added.

**Sorting → Приёмка электродов** lets the assigned current receiver enter an
independent actual count, original source-lot label and physical-check note.
Receipt must match the offered subset, not the entire source lot. A discrepancy
records a mismatch with no custody and leaves the offer reserved; a later exact
receipt is possible. Final receipt closes that offer to further events.

Sorting custody does **not** create a Sorting inspection workflow, grade,
accepted electrode output or warehouse stock. Existing manual
**Visual → Thickness → Mass**, approved per-batch grading/pass-fail mode and
immediate station failures remain unchanged. Binding those actual inspections
to received piece custody is the next milestone.

## Persistence and authority

Additive PostgreSQL **043–045** adds immutable Cutting use/allocation tables,
immutable counted output/exclusive input claims, and a nullable Cutting origin
on existing output lots. The shared handoff/event tables carry partial piece
transfers. Earlier Slurry mg and physical roll records retain their units,
original snapshots and ACKs. Populated migrations invent no use, output or custody.
The three room capacity helpers explicitly reject Sorting piece receipts, so
piece counts cannot become an apparent mass or roll-length capacity.

Current organization, active actor/device, device proof, workshop membership,
approved route, live batch, catalogue, upstream QA/expiry and history/posting
checks apply on the server and relevant database guards. Output attribution is
restricted to its actual input author or current room Master/Chief; only the
assigned current Sorting receiver can establish custody. Source measurements
must share batch, step and input SKU. Original exact retries retain their ACKs
under current authorization after a later hold; new use/custody stays blocked.

The existing organization transaction lock serializes source revisions and
prevents overuse/double reservation across devices. Deferred pairing guards
require exact source/header/children and declaration/claims/lots; immutable
events and operation ownership preserve replay. No new event debits or creates
warehouse stock. Chief warehouse approval/release rules and application-specific
polyimide tape width/thickness and whole-roll issues remain unchanged. Actual
tape consumption still needs a factory measurement policy; no conversion or
Slurry tape ingredient is invented.

## Offline behavior and verification

Prepared scoped forms retain captured source/catalogue options and save edits
offline. Freezing and sending are separate. Existing receiving-draft persistence
preserves original IDs/body, ancestry, actor/role/device/scope/epoch across reopen
and lost replies. Exact ACK validation precedes archival; a late response cannot
overwrite a newer local conflict. Old-history proposals remain available for
review. Async source preparation disables the previous form until the new scope
is ready. Main Dexie **24**, outbox **v7**, existing data, archives, queues,
dependencies and lockfiles are unchanged.

Targeted tests cover partial/multiple length allocations, source revisions,
competing enrolled actors, one-statement overuse, exclusive parent claims,
independent piece counts/null unknowns, source holds, route bypass, wrong units,
proof/history, assigned receiver identity, discrepancies, partial offers and
immutable exact SQL pairs. Client tests exercise original-byte offline/reopen/
lost-ACK retry, pending overlap, forged ACKs and late-ACK conflict protection.

Two new real-browser tests exercise the actual product UI. Cutting use records
150 mm from a received 240 mm roll, leaving 90 mm. Two profiles declare 9 counted
pieces, offer/receive 4, and leave 5 available. Both cover offline saves, reopen
and committed-but-lost replies; the second checks that no local Sorting workflow
was created. Filled and final states fit 390/412/1365 px widths.

The populated **042→043→045** integration test compares all pre-existing rows.
The actual pg_dump and two fresh pg_restore databases compare **67 tables**,
reconstruct 150 mm Cutting use/50 mm remainder, one parent claim for two counted
lots (9 ready plus 3 held), separate Sorting discrepancy and 4-piece receipt,
5 available ready pieces, original ACKs, immutable guards, history fencing and
warehouse projection repair. Full frontend regression (136 files), 387 real-PostgreSQL server tests, all nine
material-flow browsers, clean locked installs, web/server types/builds, migration
guards and Android harness types pass locally. Exact candidate totals, hosted CI links and
expiring downloadable evidence are recorded in the draft PR.

## Remaining work

1. Bind server-authoritative Sorting inspections to received custody while
   preserving Visual→Thickness→Mass, approved grading/pass-fail mode and failures.
2. Add Sorting output/actual rejects and direct Assembly custody, then approved
   cathode/anode pairing and later room material accounting.
3. Explicit physical remnant splitting/reidentification, cancelled/reassigned
   offers, returns, scrap and correction workflows; scientific incorporation,
   loss and process-card reconciliation remain separate from observations.
4. Factory actual tape/foil measurement policy, physical serialized cell
   acceptance/quarantine/QA, signed Android installed-upgrade/process-death and
   two-device/OnePlus physical acceptance remain release gates. Browser reopen
   is not proof of Android process death or installed-app upgrade.
