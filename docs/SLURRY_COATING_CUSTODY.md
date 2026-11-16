# Measured Slurry output and direct Coating custody — 2026-11-16

Implementation candidate on `feat/slurry-coating-custody`, stacked on draft
[PR #8](https://github.com/LHONE-mf/production_mf/pull/8). Latest main remains
`df1c7735f14f8ef268e382b4217f6a31dd2f33bc` (merged PRs #3/#5/#7).
The dependency branch is unchanged; this increment does not duplicate or replace
its received-material consumption work. Nothing is merged or deployed.

Committed implementation/test/CI source: **630abb84669092a965661fa782acdb209714c7c3**.
Backend increment **67a7b07**; offline client/UI **aaa0d32**; form-transition
regression **5fd929e**. A documentation-only closeout records verification.

## Actual behavior

**Slurry → Выпуск и передача** starts from an actual server-confirmed Slurry
consumption. A local journal, recipe plan or QR packet alone cannot declare output.
The operator explicitly selects existing mass-based product materials and enters:

- Independently weighed output container/lot quantities, including multiple lots.
- Explicit scrap, measured loss and unaccounted mass, including explicit zero.
- Actual weighing time, approved specification reference, reason and evidence.

The whole consumed source is declared once: outputs + scrap + measured loss +
unaccounted mass must equal its actual weighed inputs in exact integer mg. This is
only the Slurry mass boundary, not a conversion to roll length, area or cell count.
An empty input is not zero. Unaccounted mass remains unresolved and cannot be
handed off as good product. No output quantity is inferred from the input or plan.
The catalogue/specification choice is an explicit operator assertion; chemical
recipe/product compatibility has not been independently validated.

A sender selects one measured output lot, a partial actual quantity and an active
recipient in the next **actual approved Coating step** on the same batch line.
Offering reserves the quantity; it cannot be offered again by another device.
Available = measured lot − all committed offers. In transit = offered − received.
Coating-held quantity comes only from a separate explicit receipt event.

**Coating → Подтверждённая приёмка** shows offered mass, current holds, retained
source genealogy and assigned recipient. The receiver independently records:

- Exact observed offered quantity: physical receipt, once.
- A different observed quantity, zero or explicitly not measured: discrepancy,
  with no accepted quantity and no release of the sender's reservation.

After investigation/recount, a new exact receipt can settle a discrepancy. Original
discrepancies remain immutable. No new event follows an accepted receipt; its
original exact retry is still recoverable. The assigned person needs current
membership and proof for the separate receiving command. This does not invent a
universal rule requiring two different humans if one person genuinely has both
memberships. Sending, a QR scan or one device's local ACK never implies receipt.

Every event has zero warehouse effect. Output remains `unreviewed`; neither
manufacturing declaration nor physical receipt grants warehouse QA release.
Current source/ancestor QA and expiry, material activity, batch and order status
are rechecked before new output, offer or receipt. Holds remain visible after
receipt. Discrepancies can still document a held/inactive operation, while new
physical acceptance is blocked. Existing Chief QA and Storage controls remain.

## Original offline intent and scope

Discovery and posting require a current authenticated server session and enrolled
device proof. After discovery, forms and proposals can be saved offline. Separate
send buttons submit the complete original body and operation ID. Each proposal
retains its local author/role, server/tenant/actor/device, epoch and original source
snapshot. Existing local Slurry/Coating journals, calculators and packet handover
remain independent and offline; server receipts do not rewrite those old records.

Unknown replies remain pending. Exact retry recovers the original stored ACK;
changed-body or changed-owner reuse conflicts. Stale history, suspended posting,
revoked authority, changed roles, source holds and overspending never silently
rebase a proposal. Late ACKs use compare-and-save and cannot replace a newer
conflict. An ACK storage failure leaves the pending original intact. Only
allowlisted, validated network fields are retained; no tokens/proofs enter drafts.
Preparing a new form disables editing of the previous form during the transition.

The local guard conservatively permits one unresolved offer per lot per device
profile and one complete declaration/receive claim for its source. Server locks,
not local claims, control all devices. Pending/conflicted originals are preserved;
cancellation, reassignment and immutable correction/reversal are not implemented.

## API, migration and accounting

PostgreSQL **034_room_output_handoffs.sql** adds four immutable tables:
`inventory_room_outputs`, child `inventory_room_output_lots`,
`inventory_room_handoffs` and `inventory_room_handoff_events`.
No historical row is backfilled, renamed or deleted. No existing local database,
queue, catalogue, dependency, lockfile or APK identity is changed.
Dexie stays **24**, inventory outbox stays **v7**; scoped form/proposal namespaces
reuse the existing draft store and existing recovery export.

Commands are strict, current-proof/epoch-bound inventory transactions:

| Command | Purpose |
| --- | --- |
| `POST /inventory/room-outputs/slurry` | Complete measured output/loss declaration rooted in confirmed consumption |
| `POST /inventory/room-handoffs` | Partial offer against the original remaining quantity/revision |
| `POST /inventory/room-handoffs/acknowledgements` | Assigned receiver's exact receipt or explicit discrepancy |

Reads under the same current scope:

| Read | Purpose |
| --- | --- |
| `/inventory/room-outputs/slurry/sources` | Confirmed consumed sources and existing declaration identity |
| `/inventory/room-outputs/slurry/materials?consumptionId=…` | Explicit existing active mg material choices |
| `/inventory/room-outputs/slurry` | Measured lots, available/in-transit/received totals and current holds |
| `/inventory/room-handoffs/options?outputLotId=…` | Actual next Coating step/workshop and eligible recipients |
| `/inventory/room-handoffs/:room` | Scoped offers, state and ten recent receiver observations |
| `/inventory/room-handoffs/:room/:handoffId/events` | Full immutable observation history in bounded UUID pages |

Pages default to 50, capped at 100 on the server; the product requests 50. They echo
tenant/actor/device/epoch/posting state and validate ordered cursors on the client.
A received observation is always retained in the bounded preview. Sender scope is
Chief, the consumed-source actor or a current source-workshop Master. Destination
history is visible to its assigned member, current destination Master or Chief;
only the assigned active destination member may post receiving observations.

The existing organization inventory lock serializes quantity allocation. Database
guards independently enforce active actor/device/workshop/route, source/lot pair,
exact mass, nonnegative losses, complete output children, one declaration per
consumption, capped offers, immutable original snapshots/ACKs and one receipt.
The shared operation-ID namespace includes these zero-stock events and refuses
pairing them with warehouse writes. No second warehouse or mutable competing
room balance ledger is introduced. Apply only missing migrations in order after
approved rollout/backup; never use the empty-CI setup runner on populated data.

## Evidence and limits

Local verification: **737 frontend tests**, root typecheck and Vite/PWA build;
**335 server tests** (two opt-in browsers run separately), server typecheck/build;
Android Storage harness typecheck and disposable migration guard check passed.
The final committed-source server rerun and hosted checks are tracked in the PR;
no hosted pass is claimed until the actual run completes.

The populated **033→034** schema test snapshots every prior table after an actual
received issue and confirmed consumption; every original row is unchanged and no
output or handoff is manufactured by migration. Existing 032→033 upgrade checks
still run. Real `pg_dump` and two new `pg_restore` databases compare **54 public
tables**, reconstruct exact output/offer/receipt quantities and preserve original
ACKs, discrepancies, warehouse projections and history fencing.

The real two-profile Chromium test uses product controls and actual APIs, saves
offline, closes/reopens, deliberately loses committed replies for output, offer
and receipt, retries identical bodies and checks one receipt/no warehouse change.
A receiver discrepancy stays visible before explicit recount. Screens are checked
at **390, 412 and 1365** pixels. A delayed-form regression protects prior drafts. Deliberately removing its
fieldset guard made that check fail; the guard was restored and the flow passed.
Both room browser fixtures disable the app's fixed HMR socket and allow Vite
to choose a free port. A parallel local run with port 5173 deliberately occupied
passed both suites; this corrects the initial hosted port-collision failure.
Screenshots/JSON are collected even when another browser fails.
CI runs this browser with the earlier actual-use browser and existing Storage
regressions, and uploads phone-readable screenshots/JSON/logs. Hosted results
must identify their actual SHA; earlier PR #8 checks do not certify this increment.

This is engineering verification, not Android process-death, installed-upgrade,
physical OnePlus 15/ColorOS 17, two-factory-device or physical-material acceptance.
No signed APK/native/factory acceptance is claimed. No production data or service
was accessed. Migration, merge and deployment still require owner approval.

## Next increments

1. Actual **Coating consumption** of received Slurry, issued collector foil and
   application-specific polyimide tape; measured roll output and explicit
   Calendaring receipt. Coating custody presently has no consumption command.
2. Tape is **issued by roll**, with a distinct thickness/width specification per
   Coating lip-support, Assembly tab-insulation and winding application. Operational
   roll units, actual use/recoverable remainder and explicit catalogue dimensions
   need implementation; never invent roll length, pieces or conversion to mass.
3. Calendaring → Cutting → Sorting measured outputs/partial allocations, broader
   operation/batch allocation and explicit correction/reversal. Retain Sorting's
   Visual → Thickness → Mass sequence and approved mode/specification.
4. Approved cathode/anode/spec pairing, additive operational pouch stations,
   Assembly WIP and selected Filling routes, Formation WIP and independent
   serialized cell physical quarantine acceptance with Chief-only QA.
