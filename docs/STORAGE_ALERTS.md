# Storage S8 — confirmed stock health report (first increment)

## Scope and authority

The Chief, an explicitly granted Warehouse Manager, and an explicitly granted
warehouse operator can read a one-off server-confirmed stock health report
using the normal login, native device proof and organization-scoped current
warehouse grant. Production-only workshop users cannot read warehouse stock.

The GET endpoint is `/inventory/reports/alerts`. It returns a bounded,
UUID-keyset-paginated snapshot from authoritative PostgreSQL inventory.
Reads are serialized with inventory writes via the existing shared
organization inventory-sequence lock, and the response contains the current
history epoch and UTC snapshot time. No offline journal or unaccepted draft
can become confirmed stock or enter the report.

Query parameters:
- `deviceId` (required, UUID).
- `after` (optional, stock UUID); `limit` (1–100, default 50).
- `expiryDays` (0–365, default 30), UTC days from the server's snapshot time.
- `materialId` (optional UUID), required for `lowAvailable > 0` to avoid
  comparing heterogeneous units.
- `lowAvailable` (nonnegative safe integer, default 0), one-off threshold in
  that material's **base units**: mg / ul / mm / pieces.
- `view` = `alerts` (default) or `all`. An alerts-only page can be empty
  yet still have a next cursor because paging is over physical stock IDs.

Alert meanings:
- `quarantine`, `blocked`: physical package disposition, not usable stock.
- `expired`: exclusive UTC expiry instant has passed.
- `expiring`: expiry falls within the explicitly selected warning interval.
- `restricted`: marked released but not currently eligible for use; the
  server's own package/ancestor eligibility guard is authoritative.
- `low`: released, eligible package available balance at or below the
  requested one-off base-unit threshold. Reservations are deducted.

The React Storage alert panel requests the report **only on explicit user
action**, displays the snapshot timestamp, provides manual page navigation,
and exports only the currently verified page as a CSV. Text fields are
formula-escaped and CSV-quoted; exports contain no tokens, signed labels or
pending drafts. The CSV is explicitly *not* a complete warehouse ledger
export. No export side effects or automatic stock changes occur.

## Tests and release limits

See `apps/server/src/inventory-alert-routes.postgres.test.ts` (actual
disposable PostgreSQL, permissions, no ledger mutations, paging and warnings)
and `src/core/sync/inventoryAlerts.test.ts` (CSV escaping).
Current-commit CI results must be checked after publication.

This is **not yet full S8**: thresholds are ad hoc rather than persistent
per-material policies; no scheduled notifications, low-stock item without
any package, full ledger-matched movement/consumption/genealogy report,
complete multi-page coherent export or actor/audit filters are implemented.
Do not label these pending features as completed. Extend Route A native/browser
automation for this panel, then implement the remaining reports as separately
tested slices. The existing S0–S7 workflows, outbox v7 and QA/issue rules are
unchanged; no new migration was required.
