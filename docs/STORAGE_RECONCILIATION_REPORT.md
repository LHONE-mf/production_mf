# Received-material reconciliation (S8 / D8)

Storage now has **Сверка выдач · возврат · списание · расход**. Explicitly
load the report, optionally filtering by actual production batch, recipient,
material or original warehouse container UUID. These are accepted server
identities, not material names or local journal links.

Only physically dispatched issues subsequently accepted by their assigned
recipient appear. Requests, reservations, approvals, dispatched-but-unreceived
issues, pending offline proposals and local observations are excluded.

Each row retains issue/source/material/batch/step/workshop/recipient identity,
original manufacturer lot/unit and dispatch/receipt operation IDs. Display names
are current catalogue labels. Quantities and relationships come from immutable
accepted records, never today's warehouse balance.

- Issued and received: original accepted issue quantity.
- Returned: accepted unused returns for that issue, including separate packages.
- Issued scrap: authorized disposal of issued ownership, without a second
  warehouse debit. Warehouse package scrap is a different event and is excluded.
- Actual consumption: **NOT RECORDED** (`consumed:null`), not zero measured use.
- Unsettled: issued minus returned minus issued scrap. This is unresolved
  accounting ownership, **not** proof that material is physically unused.

S9B must replace the explicit absence of consumption with authenticated measured
use and extend conservation accordingly. Never substitute planned recipe mass,
issue quantity or free-text journal observations for weighing evidence.

## Read contract and snapshot

`GET /inventory/reports/reconciliation` requires current bearer session,
actor-bound enrolled device proof and current explicit warehouse grant (or Chief).
Generic production Master and recipient membership confer no report permission.
Authority is rechecked after the organization inventory lock, including actual
lock-wait revocation. Queries and joins are tenant scoped and parameterized.

Query: `deviceId`; optional `productionBatchId`, `recipientId`, `materialId`,
`stockId`; UUID `after`; `limit` 1–100 (default 50); paired optional
`untilIssue` / `untilOutcome` safe nonnegative sequence integers. Partial/future
bounds and unknown fields fail closed. First read selects both immutable stream
heads under the same inventory read lock. Continuation preserves both bounds.
The latest accepted issue snapshot within the issue bound determines inclusion;
only outcomes within the outcome bound contribute. Later receipt/return/scrap
cannot enter a frozen view, even if it updates the current issue projection.

Response: `epoch`, `throughIssueSequence`, `throughOutcomeSequence`, `items`,
`hasMore`, `nextAfter` (last issue UUID when more rows exist; otherwise null).
History changes, malformed identities, unsafe units/quantities, broken exact
conservation and stale/nonadvancing cursors are rejected by the client.

CSV exports either the verified page or the complete selected snapshot up to
10,000 issues. Full export restarts at the beginning with both frozen bounds,
reauthorizes each page, and creates no partial file on failure/overflow/history
change. It quotes/escapes spreadsheet formulas and embeds history plus both
cursors, with no credentials or request payloads. Editing filters/account/history
invalidates the previous report and cancels obsolete reads/downloads.

No migration, new balance ledger, dependency, offline reset, automatic submission
or production mutation is introduced. Existing additive migration level is 030;
InventoryOutbox remains v7. Reports need an explicit authenticated online read.

## Evidence and remaining work

Six actual PostgreSQL tests cover arithmetic/provenance, filters, two-stream
freeze across concurrent later activity, unreceived exclusion, authorization,
tenant isolation, revocation and lock waits. Seven client/UI checks cover strict
response validation, exact accounting, CSV, full-export failure, explicit loading
and obsolete identity/filter replies. A deliberate guard mutation fails its test.
Real two-profile Chromium compares both screens and downloaded CSV with independent
PostgreSQL outcomes; the native WebView harness now checks the report as well.
See the resumption checkpoint for exact-SHA hosted verification.

S8 remains partial: location-scoped historical movements, count/QA/genealogy report
detail, full large-data acceptance and later actual-consumption/finished-acceptance
activity remain. Notification delivery is not claimed. S9A/S9B/S10 and all
physical/device/deployment pilot gates remain separate unfinished work.
