# Roll-issued polyimide tape — 2026-11-16

Engineering candidate on `feat/tape-roll-specifications`, stacked on draft
[PR #10](https://github.com/LHONE-mf/production_mf/pull/10)
(`639702bcb8941f93b838ec077682ffb1c224b53a`). Its unmerged dependencies are
#9 and #8. Latest main checked: `df1c7735f14f8ef268e382b4217f6a31dd2f33bc`.
No merge, deployment or production data access.

## Implemented behavior

`rolls` is an inventory base unit for whole rolls, distinct from pieces, mass
and length. Receiving accepts exact positive integer roll counts; fractions and
cross-dimension conversions fail. Reserve, approved dispatch, recipient receipt,
stock reconciliation, movement readers and material summaries retain this unit.
The existing Chief/Manager approval, Chief-only QA, device proof, tenant/workshop
scope, stock revision, history fence and original-retry rules still apply.

Warehouse administration can explicitly create a polyimide tape SKU with:

- One application: `coating_support`, `assembly_tab_insulation` or
  `assembly_winding`.
- Positive declared width in **mm** and thickness in **µm**, preserved as decimal
  strings, including trailing zeros. Up to 12 integral and 12 fractional digits
  are accepted as a representation bound, without prescribing measurement accuracy.
- An explicit specification/drawing reference.
- Its own material code; category `component`, base unit `rolls`.

Each application/dimension specification belongs to a separate explicit SKU.
There are no default factory dimensions, length, mass, chemistry or QA decision.
The mobile form accepts a decimal comma, freezes the corresponding decimal point
string, then retains that original request. This records the user's declared
specification; it does not verify supplier documentation or process compatibility.
Generic roll materials can exist without a tape specification and remain generic.
Old untyped tape records are not automatically identified by their names.

Tape issue requests require the **exact selected SKU specification** and an
operation-card/journal reference. The approved batch route must place Coating
support tape in `coating`, and either Assembly application in `assembly`.
The reference attributes the particular use; there is no inferred station or
unverified link to a legacy journal entry. Metadata is shown on the request,
original offline proposal and confirmed issue card, and retained through every
reservation/approval/dispatch/receipt ACK and received-room material read.

Neither creation nor request changes stock. Dispatch debits the existing
warehouse ledger exactly once. Physical receiving into a room is separate from
actual consumption. Tape remains outside Slurry ingredient calculations.

## Contract and preservation

Existing material creation adds optional `tapeSpecification`:

```json
{
  "application": "coating_support",
  "widthMm": "12.50",
  "thicknessUm": "25.00",
  "reference": "SYNTHETIC EXAMPLE — supplier drawing R2"
}
```

Values above are synthetic test examples, never production presets.
Existing issue creation adds `tapeSpecification` and `operationReference` only
for a typed tape SKU. Both are required together, and forbidden for other SKUs.
A changed specification requires a new material identity. Catalogue display name,
supplier reference and active status remain editable through their existing
versioned audit workflow; the specification remains unchanged.

Migration **036** adds nullable material/issue specification and issue operation
reference columns, extends the two existing unit constraints, and adds database
validation/immutability/route/ACK guards. It neither rewrites historical rows nor
creates stock, issue events or consumption. Old ACK shapes omit absent metadata.
Legacy requests keep their old-column INSERT path, allowing populated earlier
schema upgrade fixtures to use the same application. PostgreSQL upgrade execution
is explicit; the application does not migrate production on request.

Dexie **24**, inventory outbox **v7**, dependencies and lockfiles are unchanged.
Original scoped catalogue/issue bodies, IDs, source history and exact expected
ACKs use existing durable proposal storage. Closing/reopening the browser or a
lost committed reply does not replace those bodies. A changed specification or
operation reference in an ACK cannot accept the pending proposal.

## Evidence and remaining work

Tests cover all three applications, exact dimensions, fractional/cross-dimension
rejection, room/specification/attribution mismatch, current proof, existing QA and
approval, whole-roll dispatch, original retry, direct-SQL bypass/forged ACK,
populated 035→036 row preservation, and old-schema upgrade compatibility.
A real Chromium test creates the SKU through administration, queues a whole-roll
receipt offline, reopens and sends it, then saves an attributed issue offline,
reopens, loses the committed reply and repeats the identical request. Screenshots
check 390/412/1365 widths. The recovery drill adds tape history to its actual
56-table pg_dump and two fresh pg_restore comparisons, replays original ACKs,
and verifies immutable specification triggers after restore.

Per-commit counts and hosted results are recorded in the draft PR and progress
log. Browser reopening is not Android process-death or installed-upgrade proof.

**Still open:** actual tape opening/use/exhaustion and recoverable partial-roll
measurement. The factory's remainder recording basis is not yet specified;
opening a roll must not manufacture a consumed quantity, measured length or
recoverable balance. Actual foil use, measured Coating output/roll genealogy,
Calendaring receipt, other room flows, immutable manufacturing corrections,
pairing/pouch and separate physical cell warehouse acceptance also remain.
The physical OnePlus 15/ColorOS 17, installed upgrade, factory reconciliation and
owner deployment approvals remain separate release gates.

Keep additive schema/data when rolling back a candidate. Do not drop tape columns
or coerce populated roll SKUs into old units; older clients that reject `rolls`
require a compatible coordinated release before roll records are enabled.
