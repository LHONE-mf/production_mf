# Cutting authenticated receipt → local three-station Sorting input (engineering slice)

**Integration branch:** `integration/approved-five-20261119`. This is **not** production-grade QA/output/Assembly authorization.

The actual Cutting server already records independently counted output, partial offers and a recipient-confirmed exact receipt. Sorting previously displayed receipt custody and local manual Visual→Thickness→Mass as separate unconnected views.

This slice adds an **explicit, operator-triggered bridge** on the authenticated Sorting custody page:
1. Require a server-read handoff with validated accepted `receive`, exact physical count/lot label, authorized matching server recipient and current eligible source. A discrepancy or held/unfinished offer cannot create the bridge.
2. The local worker selects electrode shape **manually**; it cannot be inferred from a material ID. The original receipt snapshot, actor/device/organization scope, quantity and physical label are frozen under `received:<original-receipt-operation-id>`.
3. Store the local Sorting input in the existing `cuttingRuns` IndexedDB table with a typed `receivedCustody` discriminator. **This is a Sorting-input projection, not a new Cutting run.** Cutting's own journal/export filters it out. `defectCount:null` explicitly means upstream Cutting defects are unknown; there is no fabricated zero.
4. Existing three-stage Sorting now uses the exact received count, unchanged specification and immutable source snapshots. Station writes refuse changed/deleted source. Original receipts cannot be changed into new geometry or silently replaced; exact retry returns the original saved record. Only the importing local profile can initiate the local workflow.
5. **Conservative limitation:** these local observed graded results are **blocked from finished electrode warehouse submission and Assembly intake**, because the current authenticated output contract does not yet verify the original server Cutting receipt or per-grade quantity allocation. No stock/QA/warehouse posting is inferred.

Offline-after-import observation is allowed with the original frozen identity. Previously observed `eligible` is historical, **not** proof of current server authorization. Reconnect and verify current source/QA before any future authoritative submission. Server source/receipt-bound final Sorting output (with exclusive per-receipt grade allocation, server authorization and audit) is still a separate implementation gate.

No database table migration, destructive upgrade, new dependency, auto-sync or production write. Existing local Cutting and Sorting records are retained.
