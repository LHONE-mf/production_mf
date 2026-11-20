# Cutting authenticated receipt → local three-station Sorting input (engineering slice)

**Integration branch:** `integration/approved-five-20261119`. This is **not** production-grade QA/output/Assembly authorization.

The actual Cutting server already records independently counted output, partial offers and a recipient-confirmed exact receipt. Sorting previously displayed receipt custody and local manual Visual→Thickness→Mass as separate unconnected views.

This slice adds an **explicit, operator-triggered bridge** on the authenticated Sorting custody page:
1. Require a server-read handoff with validated accepted `receive`, exact physical count/lot label, authorized matching server recipient and current eligible source. A discrepancy or held/unfinished offer cannot create the bridge.
2. The local worker selects electrode shape **manually**; it cannot be inferred from a material ID. The original receipt snapshot, actor/device/organization scope, quantity and physical label are frozen under `received:<original-receipt-operation-id>`.
3. Store the local Sorting input in the existing `cuttingRuns` IndexedDB table with a typed `receivedCustody` discriminator. **This is a Sorting-input projection, not a new Cutting run.** Cutting's own journal/export filters it out. `defectCount:null` explicitly means upstream Cutting defects are unknown; there is no fabricated zero.
4. Existing three-stage Sorting now uses the exact received count, unchanged specification and immutable source snapshots. Station writes refuse changed/deleted source. Original receipts cannot be changed into new geometry or silently replaced; exact retry returns the original saved record. Only the importing local profile can initiate the local workflow.
5. Once all three stations are frozen, a Chief/Manager can prepare a **separate** finished-electrode proposal against a matching completed final Sorting step. The original immutable request carries `cuttingReceiptId`; the server validates the actual tenant-owned receipt, Cutting→Sorting route/workshop, exact received count, current eligible lot and independent completed-step quantity. The existing unique `source_cut_id` prevents offering the same receipt twice. Storage receipt remains a separate count/acceptance, initially quarantined, and Chief QA remains independent. Direct local Assembly intake stays blocked to avoid double allocation.

Offline-after-import observation is allowed with the original frozen identity. Previously observed `eligible` is historical, **not** proof of current server authorization. Reconnect and verify current source/QA before any future authoritative submission. Receipt-bound finished electrode submissions reuse the server's existing unique source, immutable grade lines, independent warehouse acceptance and QA gates. Physical measurement verification and device-side factory acceptance remain separate release gates.

No database table migration, destructive upgrade, new dependency, auto-sync or production write. Existing local Cutting and Sorting records are retained.
