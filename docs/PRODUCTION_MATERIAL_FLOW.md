# Production material flow — 2026-11-15

## Scope and authority

**Implemented:** a shared, typed, nonposting blueprint in
`src/core/manufacturing/materialFlowBlueprint.ts`. It covers all eleven existing
`StageId` rooms; it does not create rooms, catalogue entries, receipts, balances,
QA decisions or routing permissions. Current production UI/validators remain authoritative.

**Approved** below means the owner's physical handling decision, not factory
acceptance of software. **Proposed/unconfirmed** means a candidate requiring an
actual versioned product specification or factory decision. **Not yet implemented**
means no shared operational transaction exists, even where local observations do.
Material names are semantic candidates, never approved catalogue IDs or recipes.

Reconciliation: starting blueprint `b18897f` includes the formerly RED test from
`2d89e77`. Latest inspected Storage head is `69209c77589aac501c076d2a32f7908beb548377`
(draft PR #5). Both histories are preserved on `feat/material-flow-foundation`.
The original test required dry cells to be direct output while also asserting
Assembly WIP. It now checks initial WIP and its separate explicit release to one
Filling room. No test was skipped and no approved physical rule was relaxed.

## As-is versus proposed room matrix

All issue candidates require explicit catalogue/spec/lot selection. All direct
successors require preparation and acknowledged physical receipt; network delivery
alone is not acceptance. Optional Storage routing requires justification, separate
physical count/acceptance into quarantine and separate Chief QA.

| Existing room | Warehouse issue candidates | Upstream input → declared physical output | Approved default custody / successor | Code today → gap / proposed suboperations |
| --- | --- | --- | --- | --- |
| Storage | External material receipts, approved internal product candidates | Independent receiving → packages with immutable source and movement history | Storage only after physical acceptance; quarantine until Chief QA | Authoritative receiving/QA/issues/returns/splits/counts/reporting and sorted-electrode acceptance exist. Cell proposal exists; physical serialized cell acceptance and general WIP receipt are **not yet implemented**. No observational journal import. |
| Slurry | Actual recipe powders, conductive material, binder, solvent/water, additives | Explicit weighed component lots → versioned cathode/anode slurry batch, measured yield/loss/unknown | **Direct → Coating** | `slurryBatch.ts`, `GrammageCalculator.tsx` preserve recipe/component snapshots, actual versus plan, unknown and durable handover. Received warehouse issue/actual consumption linkage and general custody ACK are **not yet implemented**. Preparation/weighing belongs here; pretreatment only if actually used, with no invented drying requirement. |
| Coating | Slurry if routed via Storage, Al/Cu foil, polyimide lip-sealing tape, actual auxiliaries | Specific slurry + foil → coated/dried electrode roll, measured residual foil/scrap/unknown | **Direct → electrode Calendaring**; Cutting only with approved bypass | `CoatingSetup.tsx`, `coatingJournal.ts`, six-oven model and saved roll handover exist. Line preparation, between-coatings tape use, drying, winding and roll inspection fit here. Stock-linked foil/tape/consumption, physical roll length and measured remnants need explicit records. Side A+B coverage is **not** physical roll length. |
| Electrode Calendaring | Eligible coated rolls, actually consumed approved auxiliaries | Specific coated roll(s) → calendered roll(s), measured edge waste/remnants | **Direct → Cutting** | `CalendaringRoom.tsx`, `calenderRuns` preserve source and thickness basis. Explicit slitting/edge trimming placement in Calendaring versus Cutting is **proposed/unconfirmed**. General partial roll custody and measured waste are **not yet implemented**. This operation is unrelated to cell Walzing. |
| Cutting | Eligible coated/calendered rolls, actual cutting consumables | Specific rolls → cut unsorted electrodes, counted defects, usable roll remnants | **Direct → Sorting** | `CuttingRoom.tsx` records actual counts separately from geometry estimates. Multi-run roll allocations/remnants and shared ACK custody are **not yet implemented**. Slitting must be distinguished from final plate/strip cutting. |
| Sorting | Eligible cut electrodes | Specific CutRun(s) + controlled spec → explicit PASS or actual mass grades, rejects/unknown | **Direct → Assembly**; optional independently counted Storage route | `sortingWorkflow.ts` enforces **Visual → Thickness → Mass**, grading/pass-fail mode and removal of rejects. `assemblyIntake.ts` currently claims a whole source; finished-electrode API enforces its exclusion. Partial/multi-lot allocation is approved overall but **not yet implemented** here. Packaging/transport ACK can fit existing Sorting/Assembly. |
| Assembly | Sorted electrodes, lithium feedstock/subcomponents, separator, tabs, polyimide tape, cases/cans/covers/gaskets/seals/insulators; pouch film/tab-seal materials only per actual spec | Explicit polarity/lot inputs → prepared lithium electrodes, stacks, wound blocks, insulated tabs and separately counted dry assembled cells | **Room WIP under Assembly custody**; dry output later released explicitly to one Filling room | Six substations are `li-electrodes`, `z-stacking`, `winding`, `crimp-cyl`, `us-prismatic`, `laser-prismatic`. `assemblyOperations.ts` records observations; `assemblyCellOutput.ts` declares whole dry output separately. Atomic polarity pairing, material picking/consumption and partial WIP balances are **not yet implemented**. Format-dependent tab welding/insertion/closing and pouch operations are **proposed/unconfirmed**, inside Assembly. No station automatically becomes a stocked product. |
| Filling, dry room (`electrolyte`) | Dry cells if independently Storage-routed, electrolyte lot, actual seals/consumables | Explicit complete declared Assembly output + measured electrolyte → filled/unformed cells, scrap/unknown | **Direct → Formation**, where existing source guards permit | `fillingHandover.ts` separates assignment from different-account physical receipt; `fillingResults.ts` partitions the full source. Electrolyte source lot and actual stock consumption are **not yet implemented**. Filling and optional wetting/rest/soak should be separate operations if actually performed; no dosing/pressure/time defaults. |
| Filling 705 (`electrolyte-705`) | Dry cells if independently Storage-routed, electrolyte lot, actual consumables | Explicit complete declared Assembly output + measured electrolyte → filled/unformed cells | **Direct → cell Walzing**, applicable cylindrical full-known output only | Same explicit intake/result controls as dry room. `walzingResults.ts` refuses non-cylindrical, partial, scrap or unknown source outputs. No automatic dry-room↔705 routing. Non-cylindrical 705 successor is **unconfirmed** and is not enabled by the blueprint. |
| Cell Walzing | Eligible filled cylindrical cells; actual consumables only | Full known filled 705 source → processed/unformed cells, defects/unknown | **Direct → Formation**, full known processed output only | `walzingResults.ts` preserves exact source/range and observations; instruction delivery is not a physical receipt. Shared receipt/custody and partial exact-subset path are **not yet implemented**. Never substitute electrode Calendaring. |
| Formation | Eligible filled/walzed cells; fixtures/consumables only if actually tracked | Exact preceding cell identities → processed formed cells, explicit serial subset, scrap/unknown and measured observations | **Room WIP under Formation/finishing custody**, pending QA/downstream | `formationResults.ts`, `formationSerialIdentity.ts` preserve actual source and serial evidence; `inventoryCellOutputs.ts` submits an explicit proposal with no stock. Optional aging/rest, OCV/IR/impedance/capacity review, electrical testing/grading, packaging/labels/shipment are **proposed/unconfirmed**. Formed does not mean finished/released. |

Scrap, rework, hold and QC disposition belong to each existing room, preserving
the original good-output declaration and measured losses. Unknown is distinct
from scrap and from zero. Basic traceability/QA holds remain required; environmental
WIP regulation engines are deferred.

## Polyimide and format-specific operations

**Approved:** polyimide has three separate usage destinations: Coating temporary
lip sealing **between coatings**, Assembly tab insulation, Assembly winding
jelly-roll/block taping. Coating tape is support material, never a slurry ingredient
or assumed final-cell constituent. Partial consumption and leftovers need the
original received lot. Unit (length/roll/piece), widths and shared versus separate
SKUs remain unconfirmed; no conversion is inferred.

**Approved:** cylindrical, prismatic **and pouch** products exist; partial use and
multi-lot parents are permitted. **Not yet implemented:** legacy `CellType` and
validators/UI still admit only cylindrical/prismatic. This increment includes
pouch as an advisory target without coercing it to prismatic or enabling existing
routes for it. A subsequent additive format/capability change must cover every
declaration, packet, route, serial and server validator before operational use.

Proposed pouch operations within Assembly: electrode stack/tab joining, tab
insulation, film pocket preparation, insertion, pre-sealing/final sealing. Ni/Al
tabs, laminate and hot-melt/tab tape are possible per-product materials, not
universal requirements. Dry-cell declaration station, actual steps and Filling
capabilities require confirmation; no setpoints or recipes are fabricated.

## Compact format sequences

Shared approved physical chain: recipe weighing/Slurry → Coating/drying → electrode
Calendaring (approved bypass only) → Cutting → Visual → Thickness → Mass → Assembly.
Any optional electrode vacuum drying is **proposed/unconfirmed** preparation within
Assembly, never an inserted mandatory room. Pairing requires explicit sourced
polarity/specification; `electrodeType` means shape, not cathode/anode. There is no
assumed electrodes-per-cell multiplier or inferred cell output.

| Format | Assembly and onward sequence |
| --- | --- |
| Cylindrical | Actual winding/block and tab/closing operations as specified → counted dry cells in Assembly WIP → explicit one-room Filling receipt → dry-room full known output → Formation **or** 705 full known filled output → cell Walzing → full known processed output → Formation WIP. Exact station sequence and optional operations remain per-spec. |
| Prismatic | Actual Z-stack/tab joining/US or laser closure as specified → counted dry cells in Assembly WIP → selected Filling room; current guarded direct Formation path is dry room. 705 non-cylindrical successor is **unconfirmed**. No cell Walzing assumption. |
| Pouch | **Proposed/unconfirmed:** specified stack/tab joining/insulation → film pocket/insertion/pre-sealing → actual dry declaration station → explicitly capable Filling/wetting/final-sealing route → Formation WIP. Operational format and route support is **not yet implemented**; do not reuse prismatic station IDs. |

After Formation, optional rest/aging → final tests/grading/QA → packaging and
shipment is **proposed/unconfirmed**; location in Formation/finishing or an actual
separate room requires factory input. Nothing auto-posts warehouse stock.

## Shared contract and storage boundaries

Next shared contract is an additive identity/allocation vocabulary, not another
stock ledger. Retain original issue receipt/production operation IDs and revisions,
tenant/workshop/room, batch/task/order, catalogue/spec/variant/lot, custody/location,
actual quantity/base unit, exact serial subsets, actor/device/time and evidence.
Material semantics (raw/component/WIP, stage, polarity, format) must be explicit
alongside existing four catalogue categories and base units, not guessed from names.
Container genealogy and process-parent allocations are separate relationships.

Warehouse requested → approved/reserved → dispatched → room received already
exists. Warehouse decreases **once at dispatch**. Room consumption, output,
handoff and WIP allocation must never debit it again. Actual room allocations,
consumption/loss/leftovers, prepared→received handoff, WIP buffering/release and
return source history must conserve each source in its own dimension; input mg
does not imply output mm/pieces or a theoretical yield.

Use the main manufacturing Dexie database for future atomic local WIP observation,
source claim and frozen intent, extending existing outbox/proof conventions for
authoritative sync. Reuse the existing PostgreSQL inventory lock/operation-ID and
QA mechanisms for warehouse effects; do not create competing warehouse balances.
Cross-device exclusivity needs a server transaction; offline claims may conflict
and must retain both originals. A group HMAC packet is not individual authorization.
Stable original ID/body and exact ACK must survive restart, unknown outcome,
account switch and lost reply, with no silent epoch/source rebase.

The operational schema/transactions/UI and populated DB migration/outbox tests
for those new events are **not yet implemented**. Existing whole-source claims
remain in force until a verified replacement supports exact partial serials.
Existing issue/return/split/count/Chief-only QA controls remain unchanged.

## Validation and continuation

No DB version/migration, journal, queue, API, UI, APK identity, dependency or
production data change is introduced. Existing main Dexie stays **24**, inventory
outbox **v7**, PostgreSQL **032**. No migration/backfill/backup conversion is needed
for these unpersisted contracts; actual upgrade/restore testing is required before
introducing persistent WIP. Rollback is code-only; retain all existing user data.

Next three concrete tasks:

1. Add and test pure exact identity/partial allocation contracts, including explicit
   catalogue/spec/polarity, safe base units, multiple parents and exact serial subsets.
2. Add one Slurry received-issue/measured-use path with atomic frozen local evidence,
   server authority/concurrency and no second warehouse debit, then direct Coating ACK.
3. Extend Coating foil/polyimide use and measured roll custody; separately coordinate
   physical serialized cell quarantine acceptance with Storage PR #5.

Factory choices still needed before dependent operational work: when a receiver
ACKs (handover or next-operation start), actual pouch stations/dry declaration,
serial subset/count evidence, actual post-Formation operations/location, and tape
issue units/SKUs. These do not block the nonposting foundation.
