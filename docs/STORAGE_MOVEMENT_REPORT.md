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
