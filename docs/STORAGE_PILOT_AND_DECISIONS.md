# Storage pilot and later workflow decisions

2026-11-14. Engineering checklist for the Storage foundation branch. This is not factory approval. Use an isolated staging server with intentionally created test materials and packages; never adjust real production stock as a software exercise.

## Two-device operator pilot

Use two independently enrolled Android devices with separate server users: an inventory operator and Chief or an explicitly granted inventory manager. A manufacturing Master role alone does not authorize correction. Keep original local journals and backups. Test a signed upgrade over the actual installed app before relying on recovery claims; browser reload is not native process termination.

1. Log in through Sync and prove each enrolled device. Open Storage; explicit refresh must show real catalogue/access or an actionable connection/proof error. Switching accounts must hide the prior scope immediately.
2. On the first device, receive a labelled test package of 2.125 kg to an exact cabinet/shelf/container. Review the 2,125,000 mg quantity and quarantine preview. Block the staging network, save only a proposal, kill/reopen the installed app, reauthenticate and refresh. The original frozen operation/container ID and evidence must remain. No second device may see provisional stock as confirmed.
3. Explicitly confirm submission. Interrupt the response after the staging server commits, then retry the same ID. Verify one ledger event and one receipt, with the second device converging after refresh. Do not create another physical package to retry an unknown response.
4. Receive a genuinely different test package with the same manufacturer lot and a different document. Verify separate container and operation IDs; no duplicate-lot rejection or pooled provenance.
5. An operator proposes a whole unreserved container transfer. Review source/version/destination and confirm physical checking. Queueing must not move confirmed stock. After explicit submission and refresh, both devices must agree on location and quantity. Partial movement and a reserved container must be rejected.
6. The manager/Chief records a documented counted variance. A worker/Master without manager access must not see correction controls; tampering must be denied by the server. Verify new revision and immutable actor/device/reason history. The original ledger event remains.
7. Have both devices prepare changes against the same stock revision; submit both. One may commit; the other must remain an explicit conflict. Inspect original quantity/revision/reason, refresh actual stock, record local review, and explicitly prepare any replacement under a new ID. Review alone must never change stock or confirm a rejected operation.
8. Expire device proof and revoke inventory/device access. Reads/writes must fail closed; drafts and pending requests remain recoverable under the original identity. Reconnect must not send operations automatically.
9. Check Android status/navigation bars, keyboard, Back, rotation, screen reopening, and low-storage/error behavior. Verify all critical controls can be reached at the phone's actual font scale. Preserve unsaved forms unless explicit replacement is confirmed.
10. Compare confirmed stock, reservations, ledger history and queued proposals on both devices. Test backups, restore/reconciliation and device replacement on staging before deployment. Preserve pending/unknown operations; copying credentials or blindly replaying acknowledged operations into a restored database is not an acceptable recovery method.

Record app/server versions, device/OS, tester, date, exact case, expected/observed result and linked evidence. A supervisor must approve physical count/handover procedures separately from software test success.

## Decisions needed before later mutations

| Workflow | Owner must decide | Current behavior |
| --- | --- | --- |
| QA release | Named authority; required certificate/inspection evidence; expiry/hold/rejection rules; independent review if required | Receipts stay quarantine; no UI release toggle or production-use shortcut |
| Physical issue | Who may request, approve, dispatch and independently acknowledge; posting point; scales/tolerances; outage hold procedure | No physical issue API/UI or automatic debit added |
| Consumption | Saved authenticated batch reference; actual vs reserved/issued quantities; correction and double-post prevention | Future room must reference one accepted issue/operation, never silently deduct from a journal |
| Return/scrap/damage | Original issue/provenance; remaining quantity limits; condition inspection; quarantine/release authority | No ad hoc positive or negative adjustment presented as an issue/return workflow |
| Container split/merge | Child identities, packing evidence, location/disposition rules, receipt genealogy and exact conservation | Whole unreserved moves only; no partial move or pooling |
| Initial physical opening | Freeze scope, pending queue reconciliation, signed independent count, cutover reference, reopening authority | Legacy observations remain unverified and are never converted automatically |
| Finished electrodes/cells | Exact existing batch/serial identity, independent receipt, source operation and QA evidence | Sorting/Assembly journals do not manufacture stock or release it |
| Slurry integration | Approved batch reservation, controlled issue, actual weighed use and signed confirmations | Slurry calculations and existing room workflows unchanged |

Future integrations must use authenticated server IDs, frozen intent/operation IDs, expected revisions, exact base-unit quantities and explicit human confirmation. Manufacturing completion, physical transfer, inventory receiving and QA release are separate events. Do not invent serial numbers, batch links or QA evidence.

## Release gates still open

Physical Android/ColorOS acceptance, signed installed-version upgrade, native process-kill/storage-failure campaign, production backup/restore and lost-history reconciliation, operational ownership/count controls, and deployed TLS two-device pilot require recorded results. Current browser and disposable PostgreSQL evidence does not establish these gates. Restore must remain a deployment blocker until its stream/cursor and acknowledged-operation reconciliation procedure is tested for this implementation.
