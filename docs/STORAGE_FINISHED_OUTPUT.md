# Finished electrode output: device workflow and server contract

2026-11-15: electrode integration is implemented and locally verified; exact hosted/native evidence is in the [checkpoint](STORAGE_RESUMPTION_CHECKPOINT.md). Finished cells/serials, measured Slurry use and physical/deployment acceptance remain unfinished.

This increment implements D7 for an authenticated API caller: production explicitly attests completed manual sorting output; Storage explicitly accepts a counted grade into a new quarantined package; Chief QA remains a separate action. Submission, completion and acceptance are different records. Planned targets and journal text never create output or stock.

## Submission

`POST /inventory/outputs/electrodes` requires bearer authentication, current actor/device proof, `x-inventory-epoch`, and an active Chief or Master. A Master must have current membership in the workshop of the immutable approved route step. Warehouse access does not grant production submission authority.

The strict request contains `operationId`, `deviceId`, `productionBatchId`, `stepNumber`, `completionId`, `source`, `outputs`, `reason`, `evidence`.

- `completionId` identifies an actual server `completed` step event for this batch and step. It must be final Sorting on a cathode/anode route, with no later applicable electrode/common step. Batch/order must allow output: `in_progress` or `completed` batch, `released`/`in_progress`/`completed` order. Hold, scrap and cancellation block new submission/acceptance.
- `source` preserves explicit `runId`, `cutRunId`, `specId`, mode, incoming good count, specification categories/bounds and all three manual station decisions. Decisions retain original local worker identities/timestamps, input/passed/rejected counts, optional rejection reasons and explicit Mass grades. These local identities are source attribution; the authenticated submitting server actor is separately recorded.
- Visual → Thickness → Mass is mandatory. Each station conserves its actual input; rejected electrodes cannot reach the next station. Only Mass may grade, only in `grading` mode. All specification grades must be represented exactly. In `pass-fail` mode, output is explicitly `PASS`, without an inferred mass grade. Empty grade buckets are preserved in the source but do not create output lines.
- `outputs` explicitly maps **every positive final bucket** to an active `electrode` material in `pieces`, with its exact grade quantity. The sum must equal the server completion quantity in `pieces`. No partial source submission, recalculated yield, new reading or electrodes-per-cell rule is introduced.
- One immutable submission claims the complete completion event, sorting run and cutting source. Database uniqueness prevents submitting the source again under a new operation ID or another batch. Conflicting history remains untouched. No stock or stock-ledger event is created.

The source is a deliberate authenticated attestation of manual station counts, not equipment verification or a verified import from the device database. The device selects an existing finalized three-station `SortRun`, runs the existing source/partition validation, freezes its original snapshot and requires explicit matching to the correct server batch/step/completion. It never offers planned quantities, free-text journal parsing, legacy one-step summaries or automatic relinking as equivalent sources.

The confirmed response contains `status`, `operationId`, `submission`; the latter preserves the accepted source, outputs, revision `1`, actor, device, timestamp and evidence. Exact retries return the original response with `status: duplicate`.

## Physical acceptance

`POST /inventory/outputs/accept` requires the same current proof/history boundary and explicit Storage authority: Chief or an active Warehouse Manager/Operator grant. Master alone has no warehouse rights. It is a separate physical action; being the production submitter does not authorize it.

The strict request contains `operationId`, `deviceId`, `submissionId`, `grade`, `expectedRevision: 1`, new `stockId`, active `locationId`, actual counted `quantity`, `reason`, `evidence`, and optional explicit `manufacturedOn`/`expiresOn` calendar dates. Physical quantity must equal the entire offered grade. A discrepancy is retained outside posting for investigation; this increment has no partial acceptance, shortage override or invented serial allocation.

Acceptance atomically creates exactly one new package, one `receive` ledger event and one immutable acceptance record. Material and quantity come from the frozen offered grade. The lot identity is `production:<submissionId>:<grade>`; receipt reference is the submission ID. Stock starts at revision `1`, quarantine, zero reservations. Warehouse availability follows the existing quantity convention; issue eligibility still requires separate Chief release. New acceptance cannot bypass inactive catalogs/locations, held batches or the posting fence.

The ledger event retains `production_batch_id`, source submission/grade in its original request, physical receiving actor/device, reason/evidence and exact stock result. Deferred database checks pair the acceptance with its receipt, enforce quantity/material/quarantine and prevent orphan receipts. Accepted history and grade mappings are append-only. Chief quality release is never automatic.

Each offered grade can be accepted only once, including concurrent receivers. A new stock ID or operation ID cannot accept it again. An exact retry by the original actor/device returns the original accepted stock snapshot even after later QA or movement. Revoked access/device, expired proof, restored epoch and suspended posting are checked before replay; a retry cannot revive old authority.

## Reading and recovery

`GET /inventory/outputs?deviceId=…&after=…&limit=…&productionBatchId=…` provides explicit UUID-cursor pages, up to 100 submissions. Response includes organization, actor, device, current epoch/posting state, original accepted source and grade lines with nullable accepted stock/operation IDs. Chief/warehouse readers see their tenant; a Master sees only current workshop submissions. Reads are history discovery, not an export snapshot or permission to post. No credentials enter the response or source evidence.

## Device ownership and recovery

Sorting's **Выход на склад** requires a current local production profile and fresh Chief/current-workshop Master server proof. Explicit discovery uses `GET /inventory/outputs/steps` and `/inventory/outputs/materials`: only actual completed final electrode Sorting and active pieces materials, with scoped UUID pagination. Server proof/session is rechecked after database lock waits and before commit. Free-form coating text does not infer chemical polarity, pairing rules or cell serials.

A whole finalized source, full original local SortRun and immutable request/scope/actor/device/epoch freeze atomically in main manufacturing Dexie **22**, against current Assembly allocations. Known claims are excluded from Assembly selection and rejected inside local/incoming Assembly transactions, including conservatively matched legacy provenance. Failed transactions claim nothing. Submission ACK is archived in that same main database; it creates no warehouse stock. No cross-database atomicity is claimed.

Storage independently enters the physical whole-grade count (initially blank), location, evidence and optional explicit dates, freezes a proposal in existing inventory outbox **v7**, and sends manually. Exact ACK validation commits the retained original proposal/ACK and confirmed stock cache together. Cache at a later revision is preserved. A wrong count never posts; concurrent accepted grades cannot receive twice. Lost replies leave the same request pending for an explicit retry. Conflicts, old epochs and rejected offers retain original intent and source ownership; no automatic cancellation, release, rebase or credential persistence.

Main source claims are device-local: they cannot coordinate an already offline second device or retroactively know an unknown old packet. Server uniqueness, explicit physical attestation and separate QA remain required. A future cancellation/reconciliation design must preserve unknown outcomes. Previous v21 local-only archives restore compatibly into v22; archives containing device-bound claims are preserved but cannot transfer authority through that local-only restore flow.

Migration `031_inventory_finished_electrodes.sql` adds three tables and extends the cross-endpoint operation namespace without rewriting prior rows. Frontend/client tests, a populated main upgrade, actual three-profile Chromium/Fastify/PostgreSQL workflow, 47-table/two-restore drill and expanded native harness cover original proposals, source exclusion, lost replies, competing receipts, quarantine and separate QA. See the checkpoint for exact source/checks and the distinction between real native and software-signer controls. Existing journals, offline workflows and approved business rules remain intact.
