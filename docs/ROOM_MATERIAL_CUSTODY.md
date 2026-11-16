# Received room material and measured Slurry use — 2026-11-16

Implemented engineering candidate on `feat/material-flow-authoritative-wip`, from
current merged `main` **df1c7735f14f8ef268e382b4217f6a31dd2f33bc**. PRs #3, #5 and
#7 are included. The older open blueprint PR #6 and its branch are untouched.
No production database access, merge or deployment.

Verified code/test/CI source: **59cc5bada89fb2cdad49d1fd459c99ecbea43b22**.
Backend increment: **046b58e**. A subsequent documentation-only closeout records
these results without changing the verified application/backend/test source.

## What works

1. Chief/Manager-approved Storage dispatch debits the existing warehouse ledger
   once. The assigned production recipient separately confirms physical receipt
   through the existing **Storage → issue** screen. An unreceived dispatch is not
   spendable room material.
2. `GET /inventory/room-materials/:room` lists those actual received issue sources
   by their immutable batch route step's room/workshop, original issue, package,
   manufacturer lot, base unit, quality eligibility and settlement revision.
   All existing manufacturing rooms are supported for this read. Chief, the
   assigned recipient and a current workshop Master have scoped visibility.
3. **Slurry → Остатки и расход** selects an existing saved measured batch and an
   actual server batch/Slurry step. Operators explicitly map received lots to each
   weighed component and enter actual partial quantities in grams. Multiple lots
   per component are supported; their sum must exactly equal its saved actual
   weighing, including explicit zero components. Planned masses are displayed
   separately and never used for consumption.
4. Saving freezes the source, source/catalogue mapping, revisions, original
   operation IDs/body, local author, server/tenant/actor/device scope and epoch.
   Saving is offline-capable after source discovery and never sends or posts.
   The separate send button submits the original request and archives its ACK.
   Pending, confirmed, rejected and conflict evidence remains inspectable.
5. The server atomically settles each selected received issue in the same
   quantity history as returns and issued scrap. Room remainder, eligible unused
   returns and reconciliation reports therefore include actual consumption.
   There is **no second warehouse debit**, product receipt or automatic QA.

The calculator, immutable MixBatch/journal records, existing local Slurry→Coating
handover, all other room workflows, Sorting, cell serial claims and warehouse
QA/approval/split/count rules remain intact and offline local work stays available.

## Contract and transaction

`POST /inventory/room-materials/slurry/consumptions` accepts a strict body:

- Original `operationId`, `deviceId`, actual `productionBatchId` and `stepNumber`.
- An explicit saved source projection: ID, batch code, original local author/role/
  time, recipe identity/version (null when absent), recipe name, measurement basis
  and component identities/versions with actual integer `actualMg`.
- Per-lot allocations: their own immutable operation IDs, original received
  `issueId`, explicitly selected `materialId`, component, exact mg quantity and
  original `expectedSettlementRevision`; plus reason and evidence.

Current server proof, enrollment, tenant, epoch/posting fence and route/workshop
scope are checked under the existing organization inventory transaction lock.
The assigned recipient or a current workshop Master may consume; Chief retains
supervisory authority. A warehouse grant alone is not production authority.
Current source/ancestor QA and expiry, exact material/mass unit, receipt state,
batch/step, available remainder and component allocation totals are rechecked.
Authorization/proof is checked again after waits before commit.

Every lot in one request succeeds together or none do. Stale/conflicting devices
cannot exceed a source's remainder. Original source IDs are unique per tenant;
the shared operation-ID namespace excludes stock/issue/count/electrode/cell IDs.
An exact original actor/device/body retry returns the original stored result,
including after a lost committed reply. A changed intent cannot adopt that ID.
JSONB key ordering does not change intent equality; actual request bytes retained
on the device are reused unchanged. Server timestamps confer no caller privileges.

## Data and upgrade

PostgreSQL migration **033_room_material_consumption.sql** adds one immutable
Slurry source/intent/ACK table and nullable source links on the existing issue
outcomes. The new `consume` outcome has no warehouse stock effect. Deferred
database checks require complete parent/child pairing and measured totals;
the existing issue/outcome guard caps total consumption + return + scrap.
No separate competing warehouse or room quantity ledger is created.

Room custody in this slice is derived from **existing explicit received issues**
and their approved immutable route; no old journal or free-text material name is
backfilled into stock or declared physically received. Custody of manufactured
intermediates, partial/mismatched receiving counts and room-to-room transfer
states still need separate implementation.

Main Dexie remains **24**, inventory outbox remains **v7**. New form/proposal
namespaces use its existing scoped draft store and compare-and-save checks.
Original local batches are unchanged; proposals retain the original source data
and allowlisted network projection. Existing inventory recovery evidence includes
these scoped drafts. Local-only manufacturing backup is not a transfer of server
authority. No dependency/lockfile, APK identity, migration of local records,
clearing of queues or catalogue creation is included.

## Verified behavior

- Actual 10,000 g receipt → Chief release → approved 6,000 g dispatch/receipt →
  measured 4,700 g use → **1,300 g room remainder**, warehouse unchanged after
  dispatch. Original retries, changed-body/source conflicts and holds tested.
- One measured source consumes 1,500 g + 700 g from two explicit lots; independent
  remainders and original genealogy remain. A received source can also supply two
  separately declared measured operations with retained partial remainder.
- Two different enrolled/authenticated devices compete for the same source;
  only one stale-revision claim commits. Consumed material cannot also be
  returned/scrapped; an eligible unused remainder returns once as existing policy allows.
- Offline durable save, reopen, lost reply, exact original POST retry, JSONB ACK,
  ACK-store rollback, false ACK, old epoch, changed local source, account adoption
  and late ACK over a conflict have focused checks. A deliberate inversion of the
  measured-allocation guard failed the tests and was restored.
- Populated **032→033** test compares all prior rows, including an existing
  received issue and scrap history, with no invented consumption.
- Actual `pg_dump` plus two fresh `pg_restore` databases compare **50 public
  tables**, reconstruct issue/stock/outcome history including consumption, and
  verify the original consumed-source ACK after restore and history fencing.
- Real Chromium product controls at **390/412/1365**: offline save, page close/
  reopen, deliberately lost committed response, identical original POST bodies,
  one actual consumption, unchanged warehouse and no horizontal overflow.

Local commands: root `npm run typecheck`, `npm test -- --reporter=default`,
`npm run build`; same server commands with the owned disposable
`POSTGRES_TEST_URL`. Full local results: **730 frontend / 326 server tests**;
the optional real-browser test is separately run (not substituted by a mock).
CI now runs the self-contained real Slurry browser and expanded restore drill.
Hosted CI/native results are not claimed until their actual runs complete.

Session evidence: `/tmp/wip-frontend-final.log`, `/tmp/wip-server-final.log`,
`/tmp/wip-browser-final.log`, `/tmp/wip-restore-final.log`,
`/tmp/production-mf-wip-browser/` and `/tmp/production-mf-wip-restore-final/`.
Existing React act and bundle-size warnings remain visible. Browser fixture
selectors, SQL migration constraint naming and JSONB response ordering failures
were diagnosed; none were bypassed by clearing data or increasing timeouts.

## Limits and next increments

This is not factory acceptance. Android force-stop/native proof and physical
OnePlus 15/ColorOS 17, installed upgrade and physical material reconciliation for
this new screen remain unverified. Browser reopen is not Android process-death evidence.
Deploying 033 or publishing an APK/site still needs owner approval.

Consumption is currently mass-only (exact mg from saved actual g), within the
received issue's original batch/step; one allocation line per issue per request.
Multiple lots and repeated partial use across measured sources are supported.
Catalogue/component mapping is an explicit operator assertion; approved chemical
recipe/spec matching and equipment measurements are not independently verified.
There is no inferred polarity, grade, recipe ingredient, yield or QA decision.
Changed/unknown proposals remain held; cancellation, corrections and source
reassignment need an explicit immutable resolution, not silent rebasing.

The next three implementation tasks are:

1. Authoritative Slurry output declaration and **Slurry→Coating offer/receipt**,
   with explicitly measured output/remainders, original source/actor/destination
   and exact retry; keep the current local offline handover working.
2. Coating slurry/foil/tape actual use and measured roll output/receipt, then
   Calendaring→Cutting→Sorting. Tape is issued **by roll**, with different width/
   thickness specifications for each application; roll consumption and leftovers
   must not be guessed as pieces or a universal roll length.
3. Broader multi-operation/batch allocations and correction history, then explicit
   Assembly polarity/spec pairing, guarded pouch capabilities and WIP, both Filling
   routes and independent serialized cell quarantine acceptance/Chief QA.
