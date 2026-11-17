# Current Cutting→Sorting increment — 2026-11-17

Actual Cutting input length, independently counted unsorted electrode output and
partial direct Sorting custody are implemented on `feat/cutting-sorting-flow`,
stacked on unchanged draft #15. Explicit same-SKU partial/multiple source use retains
received-roll remainder; input claims belong once to a declaration. Piece counts
are independent observations, unknown rejects/trim stay null, and explicit partial
offers/assigned receiver count and source-label confirmation establish custody.
Discrepancy does not grant custody. No inferred yield/QA or warehouse stock/debit.
PostgreSQL 043–045 preserves earlier rows/snapshots; Dexie 24/outbox v7, archives,
queues, journals and dependencies remain unchanged. [Contract](CUTTING_SORTING_FLOW.md).

Full frontend regression (136 files), 387 real-PostgreSQL server tests, locked
installs, builds/types, migration and Android harness checks, all nine browsers
and populated 042→043→045 upgrade pass. Two new actual
browsers cover original offline/reopen/lost-reply retry, independent measurements,
partial count receipt and no automatically created Sorting workflow at
390/412/1365. Real 67-table/two-restores retain 150 mm used/50 mm remaining,
independent 9 ready plus 3 held pieces, 4 received/5 ready available, original ACKs
and immutable history without warehouse effect. Exact-source full regression and
hosted evidence are recorded in the draft PR. Binding manual Visual→Thickness→Mass
inspections/approved mode to custody, Sorting output, Assembly pairing,
reconciliation/remnants/corrections, factory tape measurement and native/physical
acceptance remain open. No merge or deployment. Earlier entries are historical.

# Current calendered-output and Cutting-custody increment — 2026-11-17

Measured calendered-roll output and direct whole-roll Calendaring→Cutting custody
are implemented on `feat/calendaring-cutting-custody`, stacked on unchanged draft
#14. Actual input measurements are claimed once per declaration; multiple rolls
retain shared genealogy and independent physical output measurements. Offers
reserve source, assigned receiver count/label confirmation establishes custody,
and discrepancy does not. Quality remains unreviewed, accounting unreconciled;
no warehouse stock/debit, accepted yield, Cutting use or legacy journal is created.
PostgreSQL 041–042 preserves earlier snapshots and guards, Dexie 24/outbox v7 and
all old data/queues/dependencies. [Contract](CALENDERED_ROLL_CUSTODY.md).

Local **763 frontend / 376 server tests**, builds/types, migration/Android harness
checks, all seven actual room browsers, populated 040→042 preservation and real
**63-table/two-restores** pass. New browser covers offline/reopen/original lost-reply
retry in two profiles, async form-switch protection, separate discrepancy and
physical receipt at 390/412/1365. Exact-source hosted checks and downloadable
screenshots/JSON/logs are recorded in the draft PR. Actual Cutting→Sorting,
reconciliation, remnants/corrections, factory foil/tape measurement, later rooms
and native/OnePlus/physical acceptance remain open. No merge or deployment.
Earlier entries below describe their historical sources.

# Current Calendaring material-use increment — 2026-11-16

Actual independently measured Calendaring input length is implemented on
`feat/calendaring-roll-consumption`, stacked on unchanged draft #13. Explicit
partial/multiple receipt allocations retain each same-SKU roll's remaining length
and genealogy. Capacity uses the immutable measured Coating length acknowledged
with the received physical roll; no nominal roll conversion, repeated warehouse
debit, automatic output/QA or legacy CalenderRun is created. PostgreSQL 040 adds
immutable use/allocation records; Dexie 24/outbox v7 and all old data/queues remain.
[Contract and next gates](CALENDARING_ROLL_CONSUMPTION.md).

Local **758 frontend / 370 server** tests, builds/types, Android harness types,
migration guards, populated 039→040 preservation and actual **61-table/two-restores**
pass. The new real browser verifies offline/reopen/lost-ACK original retry and
150 mm remaining from 400 mm after 250 mm measured use at 390/412/1365. Exact-source
hosted and all-browser evidence are recorded in the draft PR. Calendered output→
Cutting, physical remnant splitting/corrections, reconciliation, factory foil/tape
measurement, later room flows and native/OnePlus/physical acceptance remain open.
Earlier entries describe their historical sources. No merge or deployment.

# Current material-flow increment — 2026-11-16

Measured coated-roll output and direct whole-roll Coating→Calendaring custody are
implemented on `feat/coating-roll-custody`, stacked on draft #12. Actual Slurry/foil
measurement claims belong once to a declaration; multiple physical rolls retain
shared genealogy, independent measured length and optional mass. Assigned receiver
count/identity confirmation establishes custody; discrepancy does not. Output stays
unreviewed/unreconciled and creates no warehouse stock. Typed tape references retain
whole-roll issue specifications without inventing consumption. PostgreSQL 038–039,
main Dexie 24/outbox v7, existing journals/queues/dependencies preserved.
[Contract, tests and remaining gates](COATING_ROLL_CUSTODY.md).

Local **755 frontend / 364 server** regression tests and populated 037→039 upgrade
pass. Real pg_dump/two-fresh-restores compare **59 tables**, original acknowledgements
and measured roll/earlier Slurry custody separately. Current-source full verification
and hosted artifacts are recorded in the draft PR. Native/OnePlus/physical factory
acceptance, measured incorporation/loss reconciliation, partial-roll use/corrections,
Calendaring output and subsequent room flows, physical cell acceptance and deployment
remain open. Earlier entries below describe their historical sources.

# Cell proposal/client/UI implemented — 2026-11-15

Formation now saves durable original cell proposals offline, explicitly sends only the frozen request and atomically archives its exact ACK. Original identity/source/actor/role/device/scope/epoch/ID/body survive reopen, unknown replies and conflicts; no stock, physical receipt or QA is created. Main Dexie **24** adds cell claims and preserves all 37 previous main tables. Outbox **v7** / PostgreSQL **032** and old queues remain unchanged. Local-only v21/v22/v23 backups remain compatible; cell claims retain device-bound restore restrictions. [Cell contract](STORAGE_CELL_OUTPUT.md).

Full local **716 frontend / 319 PostgreSQL tests**, builds/typechecks, real two-device cell/previous operator/electrode/serial browser workflows, active packaged PWA and **49-table/two-restores** pass. Current native harness now uses the real product cell proposal UI/client before and after force-stop; its software-signer diagnostic control passes, with independent ledger verification. Exact current-source hosted/native evidence is pending until recorded in the [checkpoint](STORAGE_RESUMPTION_CHECKPOINT.md). Earlier source results are historical.

**S9 remains PARTIAL:** separate physically counted serialized cell acceptance/quarantine/Chief QA and actual measured Slurry consumption remain unfinished. S10/physical/deployment gates remain open. No merge, production mutation, deployment or dependency/lockfile changes.

# Current cell submission API (2026-11-15)

**IMPLEMENTED / LOCAL TESTED:** authenticated cell source submission, completed-final-step/material discovery and scoped immutable history. Actual explicit processed serials and ended Formation counts match a real final applicable cell-route completion; whole serial domains/source IDs are exclusive across submitting devices. Exact original retries, current role/workshop/proof/epoch checks, immutable paired serial rows and zero stock on submission. PostgreSQL **032**, main Dexie **23**, inventory outbox **v7**. [Cell contract](STORAGE_CELL_OUTPUT.md).

Local **700 frontend / 319 actual PostgreSQL tests**, builds/typechecks and **49-table/two-restores**, including populated 001–031 electrode history, pass. Expanded native API/lost-reply checks and exact hosted results are recorded in the [checkpoint](STORAGE_RESUMPTION_CHECKPOINT.md).

**S9 remains PARTIAL:** durable server cell proposals/production submission screen and separately counted physical cell acceptance/quarantine/QA integration are unfinished; Slurry consumption remains NOT RECORDED. Earlier electrode and local serial-identity behavior is preserved. S10/physical/deployment gates remain open. No production mutation, merge, deployment or dependency reset.

# Current cell serial identity (2026-11-15)

**IMPLEMENTED / LOCAL TESTED:** Formation now separately records the complete explicit processed serial subset without rewriting its full input range, observation, scrap or unknown counts. Immutable source/actor/role/evidence, atomic identity/journal, durable offline draft/frozen retry, exact packets and duplicate Assembly-output/serial recovery guards are included. Main Dexie **23**, inventory outbox **v7**, PostgreSQL **031**. [Contract](FORMATION_PROCESSED_SERIALS.md).

**697 frontend / 300 actual PostgreSQL tests**, builds/typechecks, real Chromium at 390/412/1365, populated v22 upgrade, v21/v22 local archive compatibility, current archive restore, 300 PostgreSQL tests, 47-table/two-restores, electrode regression and packaged PWA pass. Full frontend/current hosted/native results appear in the [checkpoint](STORAGE_RESUMPTION_CHECKPOINT.md). The expanded native harness awaits exact-source hosted evidence; its software-signer control is not hardware verification.

**S9 remains PARTIAL:** cell serial attribution is a local prerequisite; authenticated finished-cell submission and physically counted cell acceptance into quarantine, plus measured Slurry consumption, remain unfinished. Electrode integration remains implemented. S10 and physical/deployment gates remain open. No production mutation, merge, deployment or dependency reset. Earlier entries are historical.

# Current S9A electrode device integration (2026-11-15)

**Electrode workflow IMPLEMENTED / LOCAL TESTED:** real finalized Sorting source → durable whole-source claim → explicit completed server step/material mapping → submission without stock → separately counted Storage acceptance → quarantine → separate Chief QA. Original IDs/bodies/scope/epoch survive reload, unknown replies and conflicts. Main Dexie **22**, inventory outbox **v7**, PostgreSQL **031**; existing data and business rules preserved. Claim/source ACK share the main database; acceptance/cache/archive share the outbox database. No transaction spans the two databases. Device-local source ownership does not provide global offline coordination.

**685 frontend / 300 actual PostgreSQL tests**, builds/typechecks, populated upgrade, multi-profile browser, existing operator regression, packaged PWA and 47-table/two-restore drill pass. Expanded real Android source/process-death/lost-reply/receipt coverage awaits exact-head hosted evidence in the [checkpoint](STORAGE_RESUMPTION_CHECKPOINT.md). [Contract](STORAGE_FINISHED_OUTPUT.md).

S9 remains PARTIAL: finished-cell/explicit processed serial integration and S9B measured Slurry consumption are unfinished; S10 and physical/deployment acceptance remain open. No merge, production mutation or deployment. Historical entries below describe their named earlier source.

# Current S9A server/API increment (2026-11-15)

**S9A PARTIAL:** authenticated finished-electrode submission, scoped offered-grade history and separate physical Storage acceptance into quarantine now exist as real Fastify/PostgreSQL APIs. Actual three-station output/explicit Mass grades must match the final server completion. Source/cutting/completion IDs are unique, grade quantities conserved, original retries immutable, receiving separate from Chief QA. Migration **031** preserves populated prior history and extends receipt pairing/operation-ID guards. [Contract](STORAGE_FINISHED_OUTPUT.md).

Local: **666 frontend / 295 PostgreSQL checks** (281 prior + 14 new), builds/typechecks, active-PWA and 47-table/actual two-restore drill. Existing two-profile Chromium regression passes. Hosted/native current-head evidence is pending until recorded in [checkpoint](STORAGE_RESUMPTION_CHECKPOINT.md). No product dependency, outbox v7 reset, journal/queue reset, production change, merge or deployment. New S9 screens/durable original device proposals, authentic local source selection/allocation checks, cell serial integration and measured Slurry use remain **NOT IMPLEMENTED**; S10 and physical/deployment acceptance remain open. Historical entries below describe earlier commits.

# Earlier UI correction — export failures beside controls (2026-11-15)

The real large-report screenshot exposed distant error feedback; movement and reconciliation export failures now appear beside the download controls. Both regressions pass, and the reviewed real 10,000/10,001-event API/browser run passes exact quantities/balances with no partial file. Current totals: **666 frontend / 281 PostgreSQL tests**, builds/typechecks and packaged-PWA/harness checks. The final correction's own hosted verification is pending until recorded in the checkpoint. No stock mutation, schema/outbox/dependency change or production action.

# Current acceptance — real 10,000-row export boundary (2026-11-15)

The actual API/browser scale driver now verifies exactly 10,000 accepted events export completely, while 10,001 aborts without a partial file; the existing CI server job runs it and retains artifacts. See [movement contract](STORAGE_MOVEMENT_REPORT.md). This closes the browser/export-bound gap; physical Android memory/lifecycle and factory/deployment acceptance remain pending. S8's implemented reporting is not a production-release certificate. S9 finished-output acceptance and measured Slurry use remain NOT IMPLEMENTED.

Latest application/native code `657b2da2a20b6f6cc5071ea7c94f82ffc4bf82b7` passed [Tests](https://github.com/LHONE-mf/production_mf/actions/runs/43685672631), [push CI](https://github.com/LHONE-mf/production_mf/actions/runs/43685668761), [PR CI](https://github.com/LHONE-mf/production_mf/actions/runs/43685672645), [Route A](https://github.com/LHONE-mf/production_mf/actions/runs/43685668770). Local current totals are 664 frontend / 281 real PostgreSQL tests, real browser/native harness and 44-table/two-restore checks. The new scale-test commit needs its own hosted verification, recorded in the checkpoint after push. No product/schema/outbox/dependency change from this acceptance driver.

# Current follow-up — complete count-session exports (2026-11-15)

The Counts screen now exports the complete frozen selected session, including observations awaiting approval, separate corrections and closure. Count history pages and the closed flag share one immutable upper sequence; another device's later approval cannot alter the displayed/exported snapshot. Explicit refresh selects newer evidence. Actual PostgreSQL, two-profile CSV comparison and dump/two-restores cover this behavior. See [count contract](STORAGE_COUNTS.md).

LOCAL TESTED: 664 frontend / 281 actual PostgreSQL server tests, all typechecks/builds, browser/native harness and real restore regressions. Current follow-up CI/native verification is PENDING until recorded in the checkpoint. Previous audit-detail code `b9e0f4ff3e7c884fb3a1616747afcb9f07e4bd4d` passed [Tests](https://github.com/LHONE-mf/production_mf/actions/runs/43684637157), [push CI](https://github.com/LHONE-mf/production_mf/actions/runs/43684633515), [PR CI](https://github.com/LHONE-mf/production_mf/actions/runs/43684637100), [Route A](https://github.com/LHONE-mf/production_mf/actions/runs/43684633427). Those certify the named previous source.

S8 remains PARTIAL for full 10,000-row/resource/performance and remaining acceptance. S9 finished-output acceptance and measured Slurry use remain NOT IMPLEMENTED; S10 and physical/deployment pilot remain pending. Existing data, D1–D8, schema 030/outbox v7 and dependencies are preserved.

# Current increment — immutable audit details (2026-11-15)

Starting HEAD `83f32101e95bdfec6b86b5ad6e6286b8d604dfce` still matched live draft PR #5; no concurrent work was present. S8 movement rows now show original Chief QA evidence, original count observation and separate correction approval, conserved split parent/child relationships and received-issue return provenance. UI and safe page/full frozen CSV use the same validated evidence. Count observations themselves remain separate from stock movements. See [movement contract](STORAGE_MOVEMENT_REPORT.md).

Status: IMPLEMENTED / LOCAL TESTED. 661 frontend / 280 actual PostgreSQL server checks, builds/typechecks, two-profile Chromium, real 207-event/three-page frozen population and actual dump/two restores (44 tables). Current-commit CI / native verification is PENDING until recorded in [resumption checkpoint](STORAGE_RESUMPTION_CHECKPOINT.md). No dependency/schema/outbox change. S8 remains PARTIAL; independent unapproved-count export and 10,000-row/resource acceptance remain. S9 and S10 and physical pilot remain open.

Earlier exact-SHA evidence below certifies its named source only.

# Current continuation — received-material reconciliation (2026-11-14)

Latest implementation details and remaining acceptance: [STORAGE_RECONCILIATION_REPORT.md](STORAGE_RECONCILIATION_REPORT.md).
Live audit found PR #5 still draft at `d1acf0ba85e08175a3c31030cc68e5698a47f52d`, with no review threads or newer changes. All four baseline Actions runs were independently read as successful; these certify the baseline only. Migration level is **030**; InventoryOutbox stays **v7**.

The S8 reconciliation increment is IMPLEMENTED / LOCAL TESTED: actual authenticated Fastify/PostgreSQL APIs, 6 new database checks, 7 client/UI checks, two-profile Chromium at 390x844/desktop, safe page/full-snapshot CSV and immutable history bounds. Full local regression: **657 frontend / 277 server tests** (271 baseline + 6 new). Actual dump/two restores compare **44** tables and preserve 14 stock events/four stocks, one issue/five handoff events/two outcomes, one split/four count events. Current-head CI and native results are PENDING until recorded in the resumption checkpoint. S8 remains partial; S9 and S10 remain unfinished. Physical/deployment pilot stays PENDING.

The follow-up adds an immutable post-event location filter to movements, including page/full exports and actual PostgreSQL/browser/native harness checks. Reconciliation source `feaaedde9e1e917dca3c3e4760144d71ffae28a0` passed [push CI](https://github.com/LHONE-mf/production_mf/actions/runs/43645860642), [PR CI](https://github.com/LHONE-mf/production_mf/actions/runs/43645865248) and [Tests](https://github.com/LHONE-mf/production_mf/actions/runs/43645865177); [Route A](https://github.com/LHONE-mf/production_mf/actions/runs/43645860635) is still pending at this checkpoint. These links certify that reconciliation source, not changed follow-up code.

Historical entries below describe their original checkpoints; use this section and the current feature rows for present scope.

# Current Slurry increment — 2026-11-16

[Room custody / actual-use contract](ROOM_MATERIAL_CUSTODY.md): received source
remainder now accounts for measured Slurry use, returns and scrap; UI proposals
remain durable and separate from posting. PostgreSQL 033; Dexie 24/outbox v7 unchanged.
This supersedes older Slurry “NOT IMPLEMENTED” rows for this specific mass-use slice only.

# Current Coating Slurry-use increment — 2026-11-16

[Actual Coating Slurry use](COATING_SLURRY_CONSUMPTION.md) adds independent
measured consumption, partial/multiple received-source allocations, current
remainder and immutable history. PostgreSQL 035; Dexie 24/outbox v7 unchanged.
This supersedes the earlier missing-Coating-consumption note for Slurry only.
Foil/tape use, roll units/output, other rooms and native/physical acceptance remain.

# Current Slurry output / Coating custody increment — 2026-11-16

[Measured output and direct custody](SLURRY_COATING_CUSTODY.md) adds complete measured
Slurry output, partial reserved offers and separately acknowledged Coating receipt
or discrepancy without warehouse effect. PostgreSQL 034; Dexie 24/outbox v7 unchanged.
This covers Slurry→Coating only; Coating consumption/roll output, roll-unit tape,
other room handoffs and native/physical acceptance remain unfinished.

# Storage feature matrix

Latest fully verified runtime: `4b310659307b60666cbbfbe84d5b2c7f8d749700` (S7). S8 identification first increment is implemented locally; exact-head hosted checks are tracked in PR #5. Exact current-head checks are maintained in PR #5.
Branch: `feat/storage-inventory-foundation`; draft [PR #5](https://github.com/LHONE-mf/production_mf/pull/5), based on `feat/hybrid-server-foundation`.
S0–S7 are implemented as described below. **S8–S10 remain incomplete; S8 identification native verification is pending.** No merge, production data change, permanent server, legacy-journal import or factory certification.

## Exact-commit evidence

- **S4, 13eb559**: [Android Route A 43598436254](https://github.com/LHONE-mf/production_mf/actions/runs/43598436254) passed both Storage instrumentations and independent PostgreSQL verification. Native issue request survived actual force-stop alongside receipt; Chief separately reserved/approved/dispatched, a committed dispatch ACK was lost and retried once, assigned operator received without another debit or consumption. [Native artifact 14114364859](https://github.com/LHONE-mf/production_mf/actions/runs/43598436254/artifacts/14114364859), digest `b404b6da168663e4899aaac963b87d96fd8340874849d514a6258190120dd633` (expires 2026-11-21).
- **S4 push engineering**: [43598436249](https://github.com/LHONE-mf/production_mf/actions/runs/43598436249), [artifact 14114964878](https://github.com/LHONE-mf/production_mf/actions/runs/43598436249/artifacts/14114964878), digest `942eee117468df3d7dfeabcb59520a57668f555e9c128a1ed719d83266fbdbd4` (expires 2026-11-28). [PR CI 43598440858](https://github.com/LHONE-mf/production_mf/actions/runs/43598440858) and [Run Tests 43598440869](https://github.com/LHONE-mf/production_mf/actions/runs/43598440869) passed. 619 frontend / 228 actual-PostgreSQL tests; actual Chief/operator plus production-only-recipient browser; complete dump/two restores with handoff reconstruction. PR workflows use GitHub's merge tree; push/native artifacts identify the branch SHA directly.
- The follow-up review adds strict timestamp-type rejection and a positive two-batch/one-package reservation-ownership test (229 server tests). Consult current PR-head checks for this follow-up; the immutable S4 evidence above remains attributed to 13eb559.

Previous **S3** evidence:

- [Android Route A](https://github.com/LHONE-mf/production_mf/actions/runs/43591587440): real Capacitor WebView/native AndroidKeyStore, disposable Fastify/PostgreSQL, both Storage instrumentations `OK (1 test)`, actual force-stop/relaunch, Chief catalogue creation/edit, receiving, lost ACK/exact retry, distinct same-lot packages, operator correction/QA denial, genuine Chief QA release and independent DB verification. [Native screenshots/reports](https://github.com/LHONE-mf/production_mf/actions/runs/43591587440/artifacts/14111919956), seven-day retention.
- [Push CI: web/server/browser/restore](https://github.com/LHONE-mf/production_mf/actions/runs/43591587467), [engineering artifacts](https://github.com/LHONE-mf/production_mf/actions/runs/43591587467/artifacts/14112776950): artifact explicitly names a8a6385. [Required PR CI](https://github.com/LHONE-mf/production_mf/actions/runs/43591593385) and [Run Tests](https://github.com/LHONE-mf/production_mf/actions/runs/43591593411) also passed. PR workflows test GitHub's generated merge commit; the push/native evidence above identifies the branch SHA directly.
- Local: **612 frontend tests / 219 actual PostgreSQL server tests**, all typechecks/builds, debug harness build, actual two-profile Chromium, custom dump/two restores, quantity/reservation/metadata reconstruction and disposable projection repair passed. Existing React act / build chunk warnings remain visible.
- Native digest: `a0429f39ce539dc9bed9382f44550100f09e57953a5b2fc88503f98d9912aacf`; push engineering digest: `15d523aaa241902e42cdd860810e8a662f9c62feafa2759da4eaa69ba479eea8`.

The final checkpoint documentation may advance the branch beyond this runtime commit. Check PR current-head checks before using a later SHA; never attribute old results to changed code.

## Current functionality and approved owner rules

| Milestone / decision | UI | API / DB | Offline / retained intent | Verification / remaining work |
| --- | --- | --- | --- | --- |
| S0 audit | Live branch/PR/spec/skills reconciled | Baseline 116434b; parent branch preserved | Existing journals/queues retained | COMPLETE; Graphify remains on main 0505307, so live files are authoritative |
| S1 Route A | Real native Storage and Chief catalogue/QA screens | Complete sorted migrations 001–026; guarded empty disposable setup; actual Fastify server | Original frozen receipt survives real process death; manual send/lost ACK | VERIFIED above; extend to issue/return/split/count when implemented; broader keyboard/rotation/upgrade coverage remains S10 |
| S2 catalog/admin | Material/location browser/create/edit; supplier reference; active flag; hierarchy parent selection; Chief paginated employee/effective-grant controls | 023 immutable creation/access context; 024 versioned edits and before/after audit; current proof/history/role rechecked under lock | Privileged preparation online-only; original scoped requests/replies persist in v7 draft namespace; explicit send/retry | IMPLEMENTED/VERIFIED; immutable codes/category/units; historical/occupied paths, active children and cycles guarded. Full audit/report browsing and richer navigation remain S8/S10 |
| Receiving | Distinct package UUID; lot, exact quantity/unit, supplier/document, optional manufacture/expiry, review/manual send | Quarantine only; stable ID and exact ACK; repeated maker lot allowed | Durable original-profile draft/intent/ACK; no optimistic stock | VERIFIED; no observational journal becomes stock |
| S3 QA / D1 | Chief-only release/hold/block/terminal reject, required reason/evidence; read-only scoped quality history; expiry visibility | 025 paired immutable stock/QA events, zero moved quantity, DB Chief/ledger/expiry guards, revision/history fencing | Online-only Chief review; durable intent/conflicts/ACK; quantity unchanged; old-epoch replay denied after recovery | IMPLEMENTED/VERIFIED; expired/rejected material cannot release; Manager/operator/Master denied |
| S4 request/reservation/physical issue / D2 | Real scoped batch/material/recipient request, Manager/Chief reserve/approve/dispatch, assigned receipt/cancel/history | 026 additive owned reservations and immutable paired stock/handoff events; current proof/epoch/approval/recipient/revision checks | Original v7 scoped issue namespace; offline request/recipient freeze; privileged preparation online-only; explicit send/lost ACK/conflicts retained; atomic exact stock ACK | IMPLEMENTED; local actual PostgreSQL + Chief/operator/production-only browser + real dump/two restores pass. VERIFIED at 13eb559 in Route A 43598436254; follow-up current-head checks in PR #5. See STORAGE_ISSUES.md. Issue is not consumption |
| S5 return / D3, scrap | Actual received-issue selection, condition/evidence, normal return, issued scrap and separate warehouse scrap/history | 027 immutable capped outcomes and paired new-package return; source/ancestor QA/expiry guards; Manager-only scrap | Original v7 outcome intent/ACK, offline return freezing, manual send, history/actor fencing; stock scrap also binds original epoch | IMPLEMENTED; 240 server tests, actual two-profile browser and two restored DBs pass. VERIFIED at 1b9fd42 in Route A 43623064716. See STORAGE_RETURNS.md |
| S6 split/repack / D4 | Chief/Manager physical confirmation, durable form, parent/child history and QR/manual labels | 028 paired conserved stock debit/credit and immutable genealogy; reserved parent ownership intact; inherited QA/dates/ancestor guards | Original v7 split namespace; two stock ACKs/cache/proposal atomic; no history rebind | IMPLEMENTED; real PG/browser/restore pass; VERIFIED at 0af1e85 in Route A 43624097037. See STORAGE_SPLITS.md |
| S7 count / D5 | Any-time sessions, operator zero/count/recount, discrepancy/history, explicit Manager/Chief correction and closure | 029 immutable evidence stream; only paired count_adjustment changes existing stock; stale snapshots require new observation; reservations/QA retained | Original v7 count/count-form namespaces; offline observation and exact manual retries, atomic correction ACK | IMPLEMENTED; 633 frontend / 253 actual PG tests, real browser and dump/two-restores pass; VERIFIED at 4b31065 in Route A 43625766702. See STORAGE_COUNTS.md |
| S8 identification / D6 | Actual typed/manual/camera package/location/batch lookup and label HTML/native printing; stock/location navigation | Current warehouse or own-workshop batch lookup; tenant/proof/type/epoch validation; no mutations | Existing original-profile lease gates offline package/location and bounded previous-batch lookup; no secrets | FIRST INCREMENT IMPLEMENTED; real browser QR-video decoding, PDF/HTML labels, wrong-scope and offline checks pass; native extension pending. See STORAGE_IDENTIFICATION.md |
| S8 expiry/alerts/reports / D8 | Saved per-material policies, aggregate balances, refreshed expiry/stock alerts, historical location-filtered movements and frozen bounded CSV; received-issue reconciliation by batch/recipient/material/source | Proofed tenant/grant checks under inventory lock; immutable event snapshots; distinct issue/outcome bounds; actual consumption explicitly NOT RECORDED | Reports require explicit online reads; v7 queues/ACKs and legacy journals unchanged | PARTIAL; new reconciliation LOCAL TESTED in actual PostgreSQL and two-profile browser; current-head CI/native pending. Original count/QA/genealogy detail is now implemented; independent unapproved-count export and large-data acceptance remain |
| S9 finished goods / D7 | Sorting source offer and separate Storage count/acceptance screens; original durable source and receipt proposals | Actual completed-step/material discovery, whole-source Assembly exclusion, immutable exact retries, separately counted quarantined grade packages | 685 frontend / 300 PostgreSQL tests; populated v21→22 upgrade, three-profile browser, 47-table/two-restores; exact hosted/native evidence in checkpoint | Electrode integration and local explicit processed serial identity implemented; S9 PARTIAL for cell device proposal/UI, physical cell acceptance and pilot; submission creates no stock |
| S9 Slurry | Existing local calculators unchanged | No authenticated approved-issue/actual-consumption linkage | Existing local room operation preserved | NOT IMPLEMENTED inventory integration; keep real batch identity and measurements |
| S10 hardening/release | Existing Chief recovery, readable mobile forms and legacy separation | Restore fences, immutable approval, full actual restore drill extended to QA | v1–v7 upgrades, scoped leases, unknown intent/ACK/history archives retained | PARTIAL; larger datasets, full a11y/keyboard/rotate/font/upgrade, full multi-role regression and deployment acceptance remain |
| Physical/deployment pilot | No factory device available | No deployed TLS or production DB accessed | Signed upgrade/physical reconciliation outstanding | REQUIRES PHYSICAL/DEPLOYMENT PILOT; emulator engineering is not factory certification |

Chief owns grants; a generic production Master has no implicit warehouse manager power. D1–D8 from the owner handoff are approved and supersede historical “await owner decision” sections. No new policy approval is needed to implement those decisions.

## Acceptance coverage

| Items | Executable evidence now | Missing acceptance |
| --- | --- | --- |
| A1 | `inventory-quality.postgres.test.ts`, quality client/UI tests, actual browser/native Chief release | Later cross-feature integration |
| A2–A3 | Existing correction plus S4 actual Manager/Chief vs operator/Master issue tests; separate approval/dispatch/recipient receipt, native candidate | Split/count workflow; full split/count native evidence |
| A4 | Current proof/tenant/history/revocation tests; real lock-wait races for receiving, catalog/grants and QA | Apply to every S4–S9 contract/read/export |
| A5 | Offline lease/identity tests, browser reopen; native logout conceals cache while retaining ACK | Broader native account/device switch and upgrade matrix |
| Q1–Q2 | Exact 2.125 kg conversion, separate same-lot containers in server/browser/native | Preserve on new paths |
| Q3 | Integer/unit/overflow/balance/reservation guards | Split conservation and new mutation races |
| Q4–Q8 | Receiving quarantine, genuine zero-movement QA, reservation distinction | Issue/consumption, direct eligible return, counts, finished acceptance |
| R1–R5 | Client/outbox/recovery tests, actual receiving process death, browser lost ACK/conflict, actual restore/QA reconstruction | Native QA-proposal process death and new issue/split/count intent types; full upgrade matrix |
| U1–U2 | Native launch/Back/archive/proof, mobile browser 390x844 and desktop, actual 412x915 emulator | Storage keyboard/rotation/font/modal/safe-area edge cases and physical ColorOS |
| U3–U5 | Expiry rule/eligibility tests only | Scanner, alerts, ledger-matched reports and safe export |
| U6 | Legacy journal explicitly separate in StorageModule; all local room regressions preserved | Preserve through remaining roadmap |

## Data/rollback and next step

Migrations 023–025 are additive; no date, stock or historical Chief decision is invented. Material metadata versions are independent of stock revisions. Expiry date is inclusive in UTC and converts to the following midnight; supported input is 0001-01-01 through 9999-12-30. Existing undated records remain undated. QA events move zero quantity. Rejection is terminal. Hold/block do not silently remove reservations. All stock serializers preserve optional QA/date metadata.

InventoryOutbox remains v7. Administrative/QA proposals use separate original-profile namespaces in the existing draft table and are included in recovery evidence. Keep frozen requests, rejected/conflicting outcomes and ACKs. Never reset local DBs, discard audit, silently rebase a proposal, or treat cache reconciliation as QA/stock permission. Roll back application code before additive schema; retain all evidence.

Next is **S8**, complete identification/scanning, expiry/alerts and ledger-matched reports/exports. Verify S7 exact-head Route A, then continue S8–S10 in the approved dependency order.

## S4 implementation increment

See [controlled handoff contract](STORAGE_ISSUES.md). Local browser report includes actual offline/cold-reload request, Chief physical dispatch lost-ACK retry, and an assigned production-only recipient denied broad warehouse reads. The actual dump/two restores compare 39 public tables and reconstruct 9 stock events, 1 generic remaining reservation, 1 received issue and 5 immutable handoff events. Native harness passed a frozen request across force-stop, separate Chief approval/dispatch, lost issue ACK and assigned receipt in Route A 43598436254 at 13eb559. No dependency, Dexie version/reset, production mutation or merge.

### Retained Route A regression

Review commit 7d45e5f passed web/server/browser/restore (619/229) but [native 43599817877](https://github.com/LHONE-mf/production_mf/actions/runs/43599817877) failed at debug-harness startup, before Storage API traffic. The failure is retained, not relabeled. A real packaged-PWA browser reproduction showed the active service worker serving the production SPA at the harness URL. The narrow debug-path navigation exclusion and initial Capacitor-document barrier now pass the browser regression without clearing worker/cache/IndexedDB or losing offline production-shell support. Repair HEAD 8463d96 passed native 43601214813, push CI 43601214815, PR CI 43601221503 and Run Tests 43601221028. Native artifact 14116572018, digest `973c895a6923a2b0a2b82b044d23799ccb2a7e1bc21a661771b5b8f059f46c76`; engineering artifact 14116581431, digest `40d638d448436fc2df3e4d0faf311242502f3752c8113356b85fee6cc439a768`. These successes certify 8463d96, not changed S5 code.

## S5 exact-head verification and S6 local increment

S5 **1b9fd42** passed native [43623064716](https://github.com/LHONE-mf/production_mf/actions/runs/43623064716), push CI 43623064721, PR CI 43623069482 and Run Tests 43623069447. Native artifact 14125540327, digest `ffd145a43835ab8ad20ba5934a472e97cf9cd92eef3f8c8cf657eb33308a699b` (Nov 21); engineering 14124718680, digest `a65e6b3c68831c095e64eb18b5d752a9f5e12daac8c863e2b4ced6441fc34428` (Nov 28). Initial 97c7803 native 43622294864 failed because the test asserted before the stock form restored its durable draft; it now waits for the real control. Initial CI selector matched a collapsed original-request panel before visible history; the repaired selector targets the immutable history row. Failures remain retained, without cache/evidence clearing or masked retries.

S6 has 247 actual PostgreSQL tests, 630 frontend tests, typechecks/builds and real browser/two-restores verification. Restore now compares 41 tables and reconstructs 13 events/four stocks plus one conserved split. Extended Route A tests split authorization, operator denial, lost ACK, child identity/genealogy and independent DB totals; hosted S6 result is pending. No dependency or Dexie version/reset changes.

## S6 exact-head verification and S7 local increment

S6 **0af1e850659c2c47fa9b1f72d41be477e0a77a84** passed native [43624097037](https://github.com/LHONE-mf/production_mf/actions/runs/43624097037), push CI 43624096972, PR CI 43624102397 and Run Tests 43624102417. Native artifact 14125936343, digest `aa7c7339019e5c873becf0cc936ea498979de0eb4ce0aeb285fb5c61fbaacb30` (Nov 21); engineering artifact 14125850932, digest `0ec6b957be00038ee8ffbd5791b75b4d3593fe718d61bb5c78f93170159ae0e6` (Nov 28). Both actual Storage instrumentations, split lost ACK/child genealogy and independent DB verification passed. These results certify S6, not changed S7 code.

S7 local final verification passed 633 frontend / 253 actual PostgreSQL tests, all frontend/server/debug-harness typechecks/builds, packaged PWA regression, actual two-profile count/correction UI and real dump/two restores. The latter compares 42 tables and reconstructs 14 stock events, four stocks, one reservation/issue/split, five handoff events, two outcomes and four count events. S7 native extension is pending exact-head publication/checks. No dependencies or Dexie version/reset changes; S8–S10 remain unfinished.

## S7 exact-head verification and S8 identification increment

S7 **4b310659307b60666cbbfbe84d5b2c7f8d749700** passed native [43625766702](https://github.com/LHONE-mf/production_mf/actions/runs/43625766702), push CI 43625766710, PR CI 43625771989 and Run Tests 43625771969. Native artifact 14126770238, digest `b7ef01b35575a037753435bbc00018715cec0895f996212be25272b325051550` (Nov 21); engineering 14126445235, digest `4738f2f04d70efe32b3c288942adb66ccaf4557f975d134d098b375cfb02a4ab` (Nov 28). Actual Operator count, no observation balance effect, Chief correction/both lost ACKs and independent DB verification passed.

S8 identification adds no stock schema or product dependency. It reuses the camera decoder, fixes pending-start cleanup and adds explicit optional Android camera access plus an inert native label printer. Actual QR-video decoding/track cleanup, package/location/batch API/manual/offline lookup and HTML/PDF label artifacts pass locally. Expanded native tests still need current-SHA hosted verification. S8 alerts/reports/exports remain next.


## S8 stock health first increment — 2026-11-14

A read-only proof-bound PostgreSQL stock report and an explicitly refreshed mobile alert page with scoped CSV page export have been implemented. See [STORAGE_ALERTS.md](STORAGE_ALERTS.md). This covers ad hoc expiry and per-material available-quantity warnings only. Persistent thresholds, automated alerts, full ledger/audit reporting, all-pages export and S9/S10 remain pending. Verify exact-head CI before claiming acceptance.

# Current tape specification / whole-roll issue increment — 2026-11-16

[Polyimide tape](TAPE_ROLL_SPECIFICATIONS.md) adds whole-roll receiving and the
existing approved issue path with immutable application/dimensions and explicit
operation attribution. PostgreSQL 036; Dexie 24/outbox v7 unchanged. This
supersedes earlier missing-roll-unit notes for catalogue/receiving/issues only.
Actual tape use/partial-roll remainder, foil use, Coating output and other
room/native/physical acceptance remain open. Historical entries retain their
original source-specific scope.

# Current Coating foil-use increment — 2026-11-16

[Actual collector-foil use](COATING_FOIL_CONSUMPTION.md) adds independently
measured single-SKU mass/length use, partial/multiple received lots and shared
consume/return/scrap settlement. PostgreSQL 037; Dexie 24/outbox v7 unchanged.
This covers issued mass/length only. Factory foil issue/use measurement, roll
conversions, tape use/remainder, measured Coating output and Calendaring custody
remain open; current evidence belongs to the candidate SHA recorded in the PR.
