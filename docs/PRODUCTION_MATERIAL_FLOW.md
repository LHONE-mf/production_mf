# Production MF — material flow contract (advisory Slice 1)

Current implementation: [received room custody and measured Slurry use](ROOM_MATERIAL_CUSTODY.md)
adds the first authoritative use transaction and operator screen (PostgreSQL 033).
The broader direct/WIP/output mapping below remains advisory where not implemented.

Status: **approved physical handling defaults + proposed integration architecture**.
This document describes the user's decisions and the real existing room list. It does
**not** certify physical production procedures, introduce new room types, release QA,
post stock or authorize any warehouse operation. The executable, deliberately
read-only planning map is in src/core/manufacturing/materialFlowBlueprint.ts.
The tests make the difference between DIRECT and ROOM WIP explicit.

## Owner-approved rules

1. Slurry batches, coated rolls, calendered rolls, cut unsorted electrodes,
   sorted/graded electrodes and filled/walzed cells move **directly** to the
   next applicable production room by default. This means a traceable physical
   handover, **not** an automatic warehouse receipt, issue or consumption.
2. Lithium electrodes, electrode stacks, wound electrode blocks and assembled
   dry cells remain in **Assembly room WIP buffers** until explicitly handed over.
   Formed cells remain in **Formation room WIP** pending later disposition.
3. Actual factory formats are **cylindrical, prismatic and pouch**. The current
   Assembly CellType only recognizes cylindrical/prismatic. Pouch is a
   **planned integration**, not yet supported by that current type. Never
   re-label pouch as prismatic, invent a serial or create a new route without
   the corresponding specification and migration.
4. **Partial quantities and multiple source lots per downstream operation are
   approved.** No rule limits a batch to one parent lot. A source remainder
   belongs to the original source identity. One resulting product may have
   multiple parent source IDs with explicit quantities and units. The current
   source-protection code may still require whole-source selection until a
   safe allocation ledger is implemented; the approval does NOT magically
   change those current guards.
5. **Polyimide tape** is an inventory material used in (a) Coating for
   temporary lip-sealing support between coatings, (b) electrode-tab
   insulation in Assembly, (c) jelly-roll taping in Assembly winding.
   Do not treat tape as an ingredient of slurry or infer that every coating
   tape piece becomes part of the finished cell. Actual size/spec/SKU and
   consumed or returned quantity must be declared.
   The owner additionally confirmed: **issued by roll**, with a **different width
   and thickness specification for each application**. Roll ledger/consumption
   support remains a later implementation; do not assume a roll length or alias it to pieces.
6. Warehouse approval policy remains: **Chief-only QA release**;
   **Chief/Manager approval for every material issue**; eligible unused
   returns directly available with retained source/condition evidence;
   **Chief/Manager authorizes container splits and count corrections**;
   counts can be performed at any time; label containers and locations.
   Permission must be verified by the server, not inferred from a local role,
   a QR packet or a UI toggle.
7. Storage can serve **all rooms**, not only Slurry. Production inventory
   custody (WIP) is distinct from server-confirmed warehouse stock.
8. Physical environment/hold duration requirements are not a current
   design priority. Basic quarantine, quality holds and traceability remain
   required; do not invent additional storage policy.

## Room-by-room input/output and custody

These are material **classes/candidates**, not automatically approved catalogue
SKUs. Exact polarity, chemistry, grade, format, supplier lot and approved
recipe/tech-card version must be supplied explicitly.

| Existing room | Inputs from warehouse issues or prior room | Possible traceable production output | Normal disposition |
| --- | --- | --- | --- |
| Slurry | Active powder, conductive additive, binder, solvent, recipe additives | Explicit weighed slurry batch | DIRECT to Coating |
| Coating | Slurry, Al/Cu current-collector foil, polyimide lip-seal support | Coated and dried electrode roll; residual foil/scrap separately | DIRECT to Calendaring |
| Calendaring (electrode) | Coated electrode roll | Calendered roll, separately observed trim/loss | DIRECT to Cutting |
| Cutting | Calendered or otherwise explicitly approved coated roll | Cut unsorted electrodes, separately counted rejects and roll remnants | DIRECT to Sorting |
| Sorting | Specific cut output and approved sort specification | Visual -> Thickness -> Mass confirmed pass/fail or mass grades | DIRECT to Assembly |
| Assembly | Specified anode/cathode electrodes, separator, lithium electrode inputs as applicable, tabs, tape, casings, lids, insulating/sealing components and pouch film where applicable | Lithium electrodes, stacks, wound blocks, assembled dry cells | ROOM WIP |
| Filling: dry room | Explicit assembled cell output, electrolyte | Filled cells and separate rejected/unknown counts | DIRECT to Formation when valid |
| Filling: 7th floor room 5 | Explicit assembled cell output, electrolyte | Filled cylindrical cells and separate rejected/unknown counts | DIRECT to cell Walzing for applicable route |
| Walzing (cell mechanical) | Filled cylindrical cells from room 705 | Mechanically processed cells, rejected/unknown separately | DIRECT to Formation |
| Formation | Valid filled or walzed source, explicit processed serials | Formed cell observations and source identity | ROOM WIP awaiting QA/finishing |
| Storage | Authorized physical receipt, count or return from eligible sources | Server-confirmed inventory only (not manufacturing output) | QUARANTINE first, separate Chief QA release |

**Not all products require a central warehouse visit.** Normal direct-room
handover and room WIP should be independently recorded. Optional intermediate
Storage remains an exception and must have separately counted physical
acceptance, quarantine and Chief QA when applicable.

The Coating -> Cutting path without Calendaring is **not approved as a default**
merely because the current Cutting model can technically accept some uncalendered
incoming rolls. Require a versioned route/step decision before using a bypass.

## Existing Assembly substations (current app)

| Current station | Material candidates | Candidate output |
| --- | --- | --- |
| Lithium electrodes | Applicable lithium electrode source material and components | Prepared lithium electrodes (ROOM WIP) |
| Z-stacking | Correctly specified anode + cathode electrode lots, separator | Electrode stack (ROOM WIP) |
| Winding | Correctly specified anode + cathode strips, separator, polyimide jelly-roll tape | Wound electrode block (ROOM WIP) |
| Cylindrical crimping / welding | Wound block, tabs, can, lid, insulation and joining components | Declared assembled cylindrical cell (ROOM WIP) |
| Prismatic ultrasonic welding | Stack, tab/closure hardware and relevant prismatic parts | Specified welded subassembly (ROOM WIP) |
| Prismatic laser welding | Prismatic stack/assembled subassembly and closure parts | Declared assembled prismatic cell (ROOM WIP) |

Separate tab insulation is a **proposed** explicit suboperation even though
polyimide tape already has a known real usage. The app must not infer cathode/
anode polarity or cell construction from free-form descriptions. Physical
anode/cathode pairing remains an unsolved specification requirement; the
existing protected full-source Assembly intake must not be weakened before
partial allocation is authoritative.

### Three formats and branch separation

- Cylindrical: winding + applicable can/crimp/welding operations; dry-room
  Filling or the separately selected 705 -> Walzing route where allowed.
- Prismatic: stacking and applicable tab/ultrasonic/laser operations; specific
  filling route defined by approved production step.
- Pouch: real factory output, but the current CellType and station set lack
  pouch-specific assembly/sealing controls. Implement additively behind a
  versioned route, input specifications and regression tests. Pouch-film,
  tab-sealing adhesive and associated materials must be tracked as explicit
  inputs, not implicit cell metadata.

## Additional operations to propose, not automatically enable

| Operation | Candidate existing room / placement | Reason / decision still required |
| --- | --- | --- |
| Slurry filtering or deaeration | Slurry | Confirm actual equipment and sequence; might be part of mixing |
| Coating oven drying / inspection | Coating | Existing oven settings exist; confirm evidence and separate QC needs |
| Electrode drying / moisture conditioning | Assembly or upstream preparation | Determine actual pre-assembly position and measurements |
| Tab insulation | Assembly | Link polyimide tape issue and actual use to operation |
| Jelly-roll taping | Assembly winding | Separate tape issue/consumption from winding output |
| Pouch electrode-pack insertion and primary sealing | Assembly | Pouch process and specific components absent from current room UI |
| Electrolyte wetting / rest | Both Filling rooms or pre-Formation | Only if a real tracked step; do not invent durations or QA |
| Post-Formation rest / aging | Formation or dedicated future room | Define process end and separate acceptance |
| Pouch degassing and final sealing | Assembly/finishing after appropriate formation/wetting stage | Determine route/order, do not infer from cylindrical flow |
| Final electrical testing and grading | Formation or dedicated testing room | Capacity, resistance, OCV and selected specification; not automatic Chief QA |
| Final visual/dimensional inspection, packing and labels | Finishing/Storage | Actual received finished goods require physical count and separate QA |

No new StageId is created in Slice 1. These are proposals for the next
workshop-level workflow discussion, not confirmed required steps or validated
equipment procedures. Cell Walzing is **not** electrode Calendaring.

## Proposed authoritative event boundaries (not yet implemented)

A future shared material-flow service should distinguish:

- **warehouse_issue**: authorized and actually dispatched from released
  warehouse package, once; Chief/Manager approval, stock ledger debit.
- **room_receive**: operator explicitly acknowledges actual material arrival
  under room custody, bound to the same issue or upstream handover.
- **room_use**: actual measured consumption from received room inventory; no
  second warehouse debit. Unused remainder still has a source identity.
- **manufacturing_output**: observed product source and exact actual amount
  with parents and losses. A journal, estimate or completed route alone is
  not authoritative warehouse stock.
- **room_handover / room_handover_accept**: explicit direct custody change
  with source, destination, actual counted amount, operator/time and
  protected original intent. Never equal a warehouse receipt.
- **storage_accept**: independently counted physical acceptance of eligible
  output into a new quarantine package; followed by separate Chief QA.
- **room_return / room_scrap / warehouse_scrap**: distinct from consumption;
  preserve original provenance, evidence and permissions.

Every future stock-affecting event must preserve tenant/workshop/batch identity,
immutable operation ID and original request body, actor/device proof, unit,
source/lot/package allocation, expected revision and exact response history.
Offline drafts remain pending; a lost reply may be retried only with identical
original intent. Never spend a stock source twice across devices. Network
receipts or generic QR/HMAC signatures are not server grants.

For partial/multi-lot operations record separately each parent source ID, its
material ID, lot and unit, allocated quantity, remaining quantity and its
source's original revision. Prevent over-allocation under current transactional
locks; retain conflicts and incomplete/unknown measurements. A conversion
from powder mass to coated-roll length or electrode pieces to cells **cannot**
be inferred from the quantities alone. Serialized cells require explicit,
source-bound serial subsets, not guessed contiguous prefixes.

## Implementation gates / status at this change

- **Slice 1:** the typed readonly production-flow blueprint and regression
  tests are implemented, with no database, UI, API, Android or migration changes.
- **Not implemented by Slice 1:** WIP stock ownership, partial/multi-lot
  authoritative allocation, room receive/use/handover service, automatic
  component genealogy, pouch format migration, new station UI, final physical
  serialized cell acceptance, measured Slurry consumption and factory release.
- **Existing useful systems:** room-specific immutable observations/handover
  models; offline Dexie; protected Sorting 3-station process; Storage stock
  authorization and issue/return/count/QA; electrode Storage acceptance; durable
  Formation source-submission proposals. Do not duplicate or bypass these.
- **Next safe vertical slices:** (1) authenticated received-issue -> actual
  Slurry consumed quantities with no double debit; (2) Coating foil/polyimide
  issues + direct slurry/roll handover with explicit measured custody;
  (3) partial source allocation contract/reconciliation, then Assembly
  pairing/pouch and later filling/finishing.
- **Production release is blocked** until physical OnePlus/ColorOS/Android,
  multi-device, backup/restore and reconciliation gates are accepted. Merge
  approval does not imply deployment approval.
