# Actual Coating consumption of received Slurry — 2026-11-16

Engineering candidate on `feat/coating-slurry-consumption`, stacked on the
unchanged [Slurry→Coating custody PR #9](https://github.com/LHONE-mf/production_mf/pull/9)
(`3f66812ff9c4ae50bdfd060e3ccd337c085985b9`). PR #9 depends on draft #8.
Latest main checked before publication: `df1c7735f14f8ef268e382b4217f6a31dd2f33bc`.
No merge, deployment, production connection or production data mutation.

Implementation/test/CI source: **5cc21220c9b20641f2bd5c9c8d130d2e74982b8b**.
Backend increment **5ea7a91**; offline proposals/controls **3bed72c**. A
subsequent documentation-only commit records those checks. Hosted results must
identify their actual head in the draft PR; earlier PR #9 checks do not certify
this new consumption implementation.

## Operator behavior

**Coating → Фактический расход Slurry** lists Slurry that an assigned receiver
has explicitly accepted through the authoritative direct-room flow. Offered,
discrepant, local QR or calculated sources cannot supply this balance.
For each receipt it shows received, actually consumed, remaining, revision,
current eligibility and original genealogy. The physical-receipt screen now
labels its accepted mass as the historical amount received for that transfer;
the consumption screen shows the current remainder.

Prepare a measurement for its actual server batch and Coating step. Enter:

- Independently observed actual Slurry mass, in grams with exact mg precision.
- Observation time and an operation-card or journal reference.
- Explicit partial allocations to one or more confirmed receipts.
- Reason and evidence of actual mass measurement.

Allocation totals must exactly equal the independently entered actual mass.
Blank/unknown mass is never coerced to zero. A positive consumption event cannot
be generated from pump-delivery estimates, setup geometry, planned mass, coated
length, dry-solids fraction or a guessed yield. Repeated measured increments for
one operation are separate original events, each bounded by source remainder.

The reference is attribution, not a server verification of a local journal or
chemical recipe/specification. Existing Coating calculations, snapshots, journals,
local roll handover and source claims stay intact. This separate measurement
avoids assigning several actual sources implicitly to one legacy mix snapshot.
No old journal is automatically synchronized, rewritten or made into stock.

Saving freezes an offline proposal without posting. A separate send preserves
the original operation/child IDs, complete body, source balances/ACKs, epoch,
server/tenant/actor/device and local author/role. Closing and reopening retains
that proposal. A lost committed reply retries the same body and receives the
original stored acknowledgement. Unknown/denied replies stay pending; rejection
and conflict retain the original evidence. Late ACKs and failed ACK storage cannot
overwrite a newer conflict or discard an unresolved original.

Local preparation conservatively blocks overlapping pending uses of the same
receipt on that device. Other devices are governed by authoritative transaction
locks and revisions. Refresh never silently changes a saved source or proposal.
Changing history or suspending posting holds the original; it does not rebase it.
Existing inventory recovery evidence includes these scoped drafts and ACKs.
Dexie remains **24**, inventory outbox remains **v7**.

## Server and database contract

| API | Meaning |
| --- | --- |
| `GET /inventory/room-materials/coating/slurry` | Current scoped received sources and derived use/remainder/revision |
| `POST /inventory/room-materials/coating/consumptions` | Atomic measured use with explicit per-receipt partial allocations |
| `GET /inventory/room-materials/coating/consumptions` | Immutable measured-use history for its author, current Coating Master or Chief |

Pages default to 50, capped at 100 on the server. The client validates the 50-item
page contract, current context, ordered UUID cursor, exact quantities, source
relationships and allowlisted fields before rendering or retaining data.

A strict command has original `operationId`, `deviceId`, `productionBatchId`,
Coating `stepNumber`, independent `actualMg`, positive finite `observedAt`,
`reference`, `reason`, `evidence` and `allocations`. Each allocation has its own
original `operationId`, actual `receiptId`, exact mg `quantity` and original
`expectedRevision`. IDs and receipts cannot repeat inside one command.

The existing inventory transaction checks current authentication, enrollment and
device proof, tenant, epoch and posting fence, current approved batch route,
workshop authority, parent QA/expiry, active output material, received state,
expected revision and available remainder. Current proof is checked again after
lock waits before commit. An assigned recipient may use their received source;
a current destination Master or Chief can supervise under the same scope.
A warehouse Manager grant alone does not grant production authority.

Every allocation succeeds together or none does. Two devices cannot spend the
same received remainder. The exact same actor/device/body can recover its stored
ACK after source holds or later use; current authorization and history are still
required. A changed-body or changed-owner replay conflicts. No warehouse stock,
reservation, receipt, output or QA release is written by this command.

Additive PostgreSQL **035_coating_slurry_consumption.sql** adds immutable
`inventory_coating_consumptions` and child `inventory_coating_allocations`.
It extends the shared operation-ID namespace with their zero-stock IDs and adds
a composite receipt identity index. It updates no populated historical rows.
Remaining = received − committed allocations; revision = allocation count + 1.
There is no competing mutable room balance or second warehouse ledger.

Database guards independently enforce actual positive integer mass, complete
parent/child pairing, original source-before snapshots and ACK envelope, current
source scope and holds, capped quantities, expected revision and immutable
history. The balance function is deliberately VOLATILE so a multi-row INSERT
cannot use a stale snapshot for its second allocation. Both header and child IDs
are disjoint from other inventory intents, including receipt/stock IDs.

Apply only missing migrations in order after approved rollout and verified
backup. The empty disposable-CI migration runner must never target populated
production databases. No dependency, lockfile, APK identity or local schema change.

## Verification

Local full regression: **742 frontend tests / 342 server tests** against owned
disposable PostgreSQL, frontend/server typechecks and builds. Android Storage
harness typecheck and disposable migration discovery/safety checks also passed.
The two opt-in real-browser cases are run separately from the server suite.
Existing React act and bundle-size warnings are not hidden.

- Real approved issue → measured Slurry input/output → partial offer → explicit
  Coating receipt → measured use. From a 400 mg receipt, 300 mg use leaves 100 mg;
  warehouse on-hand and revision stay unchanged.
- Multiple independently received lots retain their own partial quantities,
  remainders and complete original genealogy. No recipe/grade is inferred.
- Two separately enrolled/authenticated test devices, the assigned receiver and
  a current Coating Master, compete: one commits and one conflicts.
- Missing proof, wrong room/recipient, stale epoch, current holds and offered or
  discrepant sources fail closed. Original held-source retries remain exact.
- Direct SQL refuses missing children, forged ACKs, immutable rewrites and a
  single multi-row statement attempting to overconsume one receipt.
- Populated **034→035** compares every prior row after actual output/receipt;
  no historical use is fabricated, original receipt ACK survives. Earlier
  032→033 and 033→034 upgrade checks still pass.
- Actual `pg_dump` and two fresh `pg_restore` databases compare **56 public
  tables**, reconstruct 40 g received / 25 g consumed / 15 g remaining,
  reproduce the exact original use ACK and retain history fencing.
- Real Chromium product controls at **390/412/1365** save actual Coating use
  offline, close/reopen, lose its committed reply and retry identical bytes;
  one use/child allocation is posted and current remainder/history refresh.
  The earlier Slurry/receiver flows and existing Storage regressions remain.

Session evidence: `/tmp/coating-frontend-full.log`, `/tmp/coating-server-full.log`,
`/tmp/coating-browsers-final.log`, `/tmp/coating-two-device-final.log`,
`/tmp/production-mf-coating-restore/`, `/tmp/production-mf-custody-browser/`.
CI uploads screenshots, JSON and logs; see the actual run/expiry in the draft PR.
Browser reopen is not Android force-stop or native installed-upgrade evidence.

## Remaining work

This increment records **Slurry use only** within each receipt's original batch
and Coating step. It does not imply complete incorporation into a roll. Separate
scrap, process loss, recoverable remnant, correction/reversal and source reassignment
still need explicit immutable event designs; rejected/unknown intents stay held.

Next: issued collector-foil and polyimide actual use, measured coated-roll output
and explicit Calendaring receipt, then Calendaring→Cutting→Sorting custody.
Polyimide is **issued by roll**, with different width/thickness specifications
for Coating support, Assembly tab insulation and winding. Operational roll units,
real catalogue dimensions and actual use/recoverable remainder remain unfinished;
never invent roll length, alias rolls to pieces or put tape into Slurry formula.

Broader operation/batch allocation, approved Assembly pairing, additive operational
pouch capabilities, Assembly/Formation WIP, both Filling routes and independent
serialized-cell physical quarantine acceptance/Chief QA remain open. Native
OnePlus 15/ColorOS 17, installed upgrade, two physical factory devices and physical
material reconciliation are acceptance gates. Keep draft; no merge or deployment
without the owner's explicit approval.
