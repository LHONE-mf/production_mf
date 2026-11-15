# Storage S8 — scoped immutable movement report

This slice adds an actual PostgreSQL-backed, read-only movement report, separate
from the previously delivered ad hoc expiry/low-container-stock report.

- GET `/inventory/reports/movements` requires an authenticated currently enrolled
  actor, fresh device proof and explicit current warehouse grant. Generic production
  Master/recipient does not gain inventory-history access.
- Immutable inventory operation sequence is the authority; local draft outbox and
  unconfirmed observations are excluded. No new stock mutations, migrations,
  dependencies or operational notifications.
- Filters: stockId, materialId, productionBatchId, actorId, kind, inclusive
  UTC dates `from` and `through`; strict validation; limit 1–100.
- The first call freezes `throughSequence` to the current ledger head.
  Subsequent pages supply `after` and the same `until` so later
  stock writes cannot change the event population of this view.
  Every request rechecks current device/session/warehouse authority.
- Reports include quantity and unit, source stock identity, original event
  ID/type/time/actor/device/reason and existing production batch ID if recorded.
  No evidence files, auth secrets or arbitrary JSON request payloads are exported.
- CSV export is explicitly the **current verified page only**, formula-escaped,
  with no automatic cross-page crawl or silent claim of full export.
- Receipt, issue, QA, transfer, return, split and authorized adjustments remain
  distinct operations. Issue is NOT actual production consumption; no measured
  consumption exists yet.

Real PostgreSQL integration tests cover stable pagination and immutable frozen
upper cursor; current proof and tenant/warehouse access; errors and filters;
no stock changes. Frontend tests cover CSV formula and quoting safety.

S8 remains partial: persistent configurable low-stock policies, automatic
alerts, full all-pages exports and aggregate reports still need implementation.
S9 manufacturing handoff/Slurry actual consumption and S10 acceptance are
also pending. No factory data, Android device or production deployment is
changed by this reporting slice.

## S8 follow-up: bounded full-snapshot export

Operators may explicitly export a complete filtered movement snapshot of at most
10,000 events. The client re-requests all pages from `after=0` using the same
`until=throughSequence` captured in the first report, verifies each page
epoch/sequence, and fails without a partial file if a page errors, history
changes, a cursor stalls, or the result exceeds the cap. Every page requires
fresh authorization and device proof. CSV escaping is identical to the page
export. This is a one-off download, not a scheduled background export. For
larger history sets, narrow the filters; external streaming export is pending.

The number of exported events is not the same as a computed material-consumption
quantity. Production consumption remains unimplemented until Slurry links
actual issued stock to verified weighed usage.

## Historical location correctness

Each accepted ledger operation preserves a full `result_stock` snapshot.
The movement report now derives each event's location and manufacturer lot from
that immutable event snapshot rather than from the current `inventory_stocks`
projection. A later transfer must not change the reported receiving location
or any earlier quality-event location, even when an export is refreshed using
a frozen upper ledger cursor. Material display names are current catalogue
labels, not claims about historical names. The PostgreSQL integration
regression performs real receiving, Chief QA and transfer APIs and verifies
both the frozen and expanded reports.

The report and CSV also expose immutable `from_location_id` and
`to_location_id` for transfers (null when not applicable), alongside the
post-event location from `result_stock`. These fields are read-only and do
not affect physical inventory. The UI explicitly labels the location as
"after the event" to avoid confusing it with the current shelf.

## Export provenance and UTC date validation

Each data row in the movement CSV now includes the server-confirmed inventory
history ID and the frozen ledger upper sequence, so an exported row can be
traced back to the correct historical snapshot rather than confused with a
newer inventory history after a restore. This metadata is not an authorization
token, and exports still omit credentials and unconfirmed local observations.
The client rejects impossible UTC calendar dates (including invalid leap days)
before requesting a movement report; the existing backend validation remains.

## Auditable balance after each event

The verified movement report and CSV now show the accepted **on-hand** and
**reserved** balances immediately after the event, taken from that event's
immutable `result_stock` snapshot, not the current warehouse balance. This
is important because operation quantities are unsigned: a correction, transfer,
reservation or QA decision must not be misread as a positive stock receipt.
All rows remain proof-bound, organization-scoped and frozen to their report
history/cursor; no stock mutation, schema change or local-history import occurs.
Invalid or missing accepted balance snapshots reject the server response.

## Historical location filter

`locationId` filters the exact **location after each event** from its immutable
`result_stock`, independently of the current stock projection. The screen labels
it “Место после события (UUID)”. This is an exact location, without subtree
expansion; a transfer appears under its recorded destination. Its source remains
visible in the separate source-location column. Earlier receiving/QA events stay
under their original location after a later transfer. The filter is carried into
all pages and both CSV exports using the same frozen ledger upper cursor.
Malformed UUIDs fail before the client request and at the server boundary.

The actual PostgreSQL receive/QA/transfer regression checks original/destination
and frozen pre-transfer views. Real mobile browser tests use the control for a
matching and an empty location and download both scoped exports; the native
WebView harness checks both states with a current device proof. No migration,
stock write or reinterpretation of old history is involved.

## Immutable audit detail — 2026-11-15

Every returned row now includes `audit`, either null for ordinary stock events or
one of four validated evidence shapes:

- `quality`: original Chief disposition (`release`, `hold`, `block`, `reject`) and
  its evidence reference. A later hold never rewrites a previous release row.
- `count`: count/session and original observation IDs; original recorded and
  physically counted base-unit quantities; counted stock revision; observer,
  device, UTC time and observation evidence; separate correction evidence. The
  movement row's actor/device/time/reason identify the approving Chief/Manager.
  Signed discrepancy is counted minus originally recorded stock. Observation
  alone remains absent from the stock-movement ledger and changes no balance.
- `split`: immutable parent/child package and paired operation IDs, parent
  on-hand before/after and recorded evidence. The child quantity is the operation's
  unsigned quantity; before = parent after + child. Both split ledger rows carry
  the same relationship. A subsequent parent hold/transfer never changes it.
- `return`: actual received-issue ID, original source package and condition
  evidence. The row's stock ID is the separate return package. This does not
  create another debit from warehouse stock or record measured consumption.

The server joins only tenant-scoped immutable evidence by accepted operation ID,
without per-row queries or current-package genealogy guesses. Missing required
paired evidence aborts the report. The client validates shape, identities,
quantities, split conservation and counted-minus-book discrepancy before display
or export. All new evidence/IDs appear in the mobile report and both CSV paths;
formula quoting applies to evidence and signed quantities too. No raw request
payload, device proof or session credential is exported.

Deploy the matching server response before the updated client: a report missing
`audit` fails closed with a visible error rather than manufacturing evidence.
Existing confirmed stock and all offline queues remain intact. There is no new
migration, dependency or mutation; inventory schema remains 030 and outbox v7.

Executed local coverage: actual API receive/QA/count/approval/split/return,
post-event changes, frozen detail pagination and two users; a 207-event snapshot
across three real PostgreSQL pages excludes later receiving activity and exactly
matches its ledger population. Client checks reject false discrepancies and
forged genealogy, preserve zero counts and check CSV column alignment/escaping.
Real two-profile Chromium compares details/downloads with independent PostgreSQL;
the native harness checks QA, original count/approval and both genealogy paths.
Current-SHA hosted verification is recorded in the resumption checkpoint.

S8 remains partial: independent unapproved count-observation report/export,
10,000-row/memory/performance acceptance, further report scopes and S9's actual
consumption/finished-acceptance activity remain separate work. Unapproved count
history remains readable in the existing Counts screen. Physical pilot gates
are unchanged.

## Full export-bound acceptance (2026-11-15)

`scripts/storage-report-scale-smoke.mjs` creates an independently labelled
SYNTHETIC organization in the guarded disposable `production_mf_ci` database,
enrolls/signs a real device challenge and posts 10,000 distinct quarantine receipts
through the actual authenticated Fastify API. Real Chromium at 390x844 drives the
actual movement panel and full-snapshot CSV download: all 10,000 IDs, exact
quantities/post-event balances and history/bound metadata must match. Adding a
10,001st actual receipt and explicitly refreshing the report must abort the next
full export with **zero partial files**. The driver neither rewrites ledger rows
nor modifies production data, and refuses to overwrite a pre-existing harness.

The existing CI server job now runs this acceptance after the two-profile smoke
and uploads `report-scale-result.json`, exact-bound CSV and the over-limit mobile
screenshot alongside its other engineering evidence. A failure fails CI. Local
first execution accepted 10,001 events, exported 10,000 rows / 4,668,878 bytes,
created no over-limit file and measured 53.9 seconds for synthetic API setup and
1.7 seconds for the export. Timings are observations, not a performance guarantee
or physical Android memory certification. Check exact-SHA hosted results in the
resumption checkpoint.

The former 10,000-row browser/export acceptance gap is covered. Physical
OnePlus/ColorOS memory/lifecycle, broader factory acceptance and deployment remain
S10/pilot gates; future actual-consumption/finished-acceptance reports depend on
S9's real operations.
