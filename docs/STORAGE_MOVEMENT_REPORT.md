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
