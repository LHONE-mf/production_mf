# Direct Sorting → Assembly custody — v1 intent contract

Status: **engineering contract only; no server reservations, receipts or Assembly posting are implemented by this document.**

## Source and offering unit

An offer starts from a **completed, immutable three-station Sorting result** whose
physical source is a confirmed Cutting → Sorting receipt. The source snapshot includes
`runId`, `cutRunId=received:<receipt-id>`, `cuttingReceiptId`, specification,
inspection mode, independent Visual → Thickness → Mass results, grade totals and
per-station rejects. Locally fabricated CutRun output is not an authoritative source.

**One offer = one actual physical lot, one Sorting grade, one counted quantity in pieces.**
Different grades must never be silently blended. A partial offer is allowed only within
the selected grade's currently available accepted count, subject to live server
reservations. An empty, rejected or unknown grade is not available. The observed
physical lot label is explicit; no name/shape-based assumption supplies polarity.

## Request fields

`SortingAssemblyOfferRequest` in
`src/core/sync/sortingAssemblyHandoff.ts` validates:
- original `operationId`, `deviceId`, `productionBatchId` (UUIDs)
- complete bounded Sorting source snapshot, including the original Cutting receipt
- `sourceStepNumber`, later `destinationStepNumber`, `expectedSourceRevision`
- `recipientId`, `outputLotLabel`, `grade`, `materialId`, positive integer `quantity`
- nonempty `reason` and `evidence`

The client validator rejects invented grades, over-counting the one source grade,
unconfirmed Cutting sources, invalid quantities/identities and malformed route
ordering; it **cannot** prove actual physical stock or current server capacity.

## Required next steps (not implemented yet)

1. Server validates current organization, signed device proof, assigned operator,
   workshop membership, approved live route, current version, hold/expiry and source
   custody against PostgreSQL — never just client-provided snapshots.
2. Server atomically reserves the exact *per-grade* quantity; competing offers,
   warehouse output claims and an existing Assembly intake cannot spend the same
   source twice. Idempotency key is the original `operationId`; replay either
   returns the exact original ACK or an explicit conflict.
3. Assigned Assembly recipient physically counts and checks label **and grade**.
   A matching separately signed receive event grants custody. Any discrepancy
   records evidence and **does not** create custody, stock or a valid Assembly intake.
4. Receipt history must retain offer, source version, actor/device, timestamps,
   observed count and label, and original ACK across offline reopen/lost reply.
   After confirmed receipt, Assembly creates a grade-specific source link; it must
   not automatically claim cathode/anode pairing, cell count, QA release or inventory.
5. Build targeted PostgreSQL race/idempotency/revocation/route tests and two-profile
   client offline/restart tests before connecting production UI.

No existing Dexie tables, migrations, local records or warehouse balances are
changed by the current B1 code. No real-device/factory acceptance is asserted.
