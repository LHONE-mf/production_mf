# Storage feature matrix

Current verified runtime checkpoint: `a8a638575b47afe7e4c37110c5c32105d6bfe7dd`.
Branch: `feat/storage-inventory-foundation`; draft [PR #5](https://github.com/LHONE-mf/production_mf/pull/5), based on `feat/hybrid-server-foundation`.
S0–S3 are implemented and verified as described below. **S4–S10 remain incomplete.** No merge, production data change, permanent server, legacy-journal import or factory certification.

## Exact-commit evidence

- [Android Route A](https://github.com/LHONE-mf/production_mf/actions/runs/43591587440): real Capacitor WebView/native AndroidKeyStore, disposable Fastify/PostgreSQL, both Storage instrumentations `OK (1 test)`, actual force-stop/relaunch, Chief catalogue creation/edit, receiving, lost ACK/exact retry, distinct same-lot packages, operator correction/QA denial, genuine Chief QA release and independent DB verification. [Native screenshots/reports](https://github.com/LHONE-mf/production_mf/actions/runs/43591587440/artifacts/14111919956), seven-day retention.
- [Push CI: web/server/browser/restore](https://github.com/LHONE-mf/production_mf/actions/runs/43591587467), [engineering artifacts](https://github.com/LHONE-mf/production_mf/actions/runs/43591587467/artifacts/14112776950): artifact explicitly names a8a6385. [Required PR CI](https://github.com/LHONE-mf/production_mf/actions/runs/43591593385) and [Run Tests](https://github.com/LHONE-mf/production_mf/actions/runs/43591593411) also passed. PR workflows test GitHub's generated merge commit; the push/native evidence above identifies the branch SHA directly.
- Local: **612 frontend tests / 219 actual PostgreSQL server tests**, all typechecks/builds, debug harness build, actual two-profile Chromium, custom dump/two restores, quantity/reservation/metadata reconstruction and disposable projection repair passed. Existing React act / build chunk warnings remain visible.
- Native digest: `a0429f39ce539dc9bed9382f44550100f09e57953a5b2fc88503f98d9912aacf`; push engineering digest: `15d523aaa241902e42cdd860810e8a662f9c62feafa2759da4eaa69ba479eea8`.

The final checkpoint documentation may advance the branch beyond this runtime commit. Check PR current-head checks before using a later SHA; never attribute old results to changed code.

## Current functionality and approved owner rules

| Milestone / decision | UI | API / DB | Offline / retained intent | Verification / remaining work |
| --- | --- | --- | --- | --- |
| S0 audit | Live branch/PR/spec/skills reconciled | Baseline 116434b; parent branch preserved | Existing journals/queues retained | COMPLETE; Graphify remains on main 0505307, so live files are authoritative |
| S1 Route A | Real native Storage and Chief catalogue/QA screens | Complete sorted migrations 001–025; guarded empty disposable setup; actual Fastify server | Original frozen receipt survives real process death; manual send/lost ACK | VERIFIED above; extend to issue/return/split/count when implemented; broader keyboard/rotation/upgrade coverage remains S10 |
| S2 catalog/admin | Material/location browser/create/edit; supplier reference; active flag; hierarchy parent selection; Chief paginated employee/effective-grant controls | 023 immutable creation/access context; 024 versioned edits and before/after audit; current proof/history/role rechecked under lock | Privileged preparation online-only; original scoped requests/replies persist in v7 draft namespace; explicit send/retry | IMPLEMENTED/VERIFIED; immutable codes/category/units; historical/occupied paths, active children and cycles guarded. Full audit/report browsing and richer navigation remain S8/S10 |
| Receiving | Distinct package UUID; lot, exact quantity/unit, supplier/document, optional manufacture/expiry, review/manual send | Quarantine only; stable ID and exact ACK; repeated maker lot allowed | Durable original-profile draft/intent/ACK; no optimistic stock | VERIFIED; no observational journal becomes stock |
| S3 QA / D1 | Chief-only release/hold/block/terminal reject, required reason/evidence; read-only scoped quality history; expiry visibility | 025 paired immutable stock/QA events, zero moved quantity, DB Chief/ledger/expiry guards, revision/history fencing | Online-only Chief review; durable intent/conflicts/ACK; quantity unchanged; old-epoch replay denied after recovery | IMPLEMENTED/VERIFIED; expired/rejected material cannot release; Manager/operator/Master denied |
| S4 request/reservation/physical issue / D2 | No usable request/approval/dispatch/recipient workflow yet | Reservation API exists; physical issue deliberately unavailable | No issue workflow queue yet | NOT IMPLEMENTED; every final debit needs current Chief/explicit Manager approval; reservation is not issue or consumption |
| S5 return / D3, scrap | None | Accepted-issue return provenance/outstanding quantity contract absent | None | NOT IMPLEMENTED; eligible unused returns go directly available, unsafe returns held/denied |
| S6 split/repack / D4 | Whole-container transfer/correction exists; split absent | No child genealogy/conservation transaction | Frozen whole-move/correction queues exist | NOT IMPLEMENTED split; Chief/Manager authorisation, new child IDs, conservation and races required |
| S7 count / D5 | No sessions/observations/recount workflow | Privileged correction exists; no count evidence/session model | Frozen correction only | NOT IMPLEMENTED; count anytime, count alone never changes balance; Chief/Manager correction approval |
| S8 identification / D6 | IDs visible; no authoritative QR/camera/manual lookup/printing workflow | Typed package/location/batch lookup absent | No scanner lookup cache yet | NOT IMPLEMENTED; a scan grants no permission; no secrets in labels |
| S8 expiry/alerts/reports / D8 | Expiry capture/display and simple code/name/lot/location search exist | Release/reserve expiry guards exist; full thresholds/reports/CSV absent | Explicitly stale scoped stock cache | PARTIAL; full balances/movements/consumption/genealogy/filter/export/low-stock policies remain open |
| S9 finished goods / D7 | No production->Storage accept screen | Existing production identities/handoffs preserved; warehouse acceptance absent | None | NOT IMPLEMENTED; completion must never create confirmed warehouse stock |
| S9 Slurry | Existing local calculators unchanged | No authenticated approved-issue/actual-consumption linkage | Existing local room operation preserved | NOT IMPLEMENTED inventory integration; keep real batch identity and measurements |
| S10 hardening/release | Existing Chief recovery, readable mobile forms and legacy separation | Restore fences, immutable approval, full actual restore drill extended to QA | v1–v7 upgrades, scoped leases, unknown intent/ACK/history archives retained | PARTIAL; larger datasets, full a11y/keyboard/rotate/font/upgrade, full multi-role regression and deployment acceptance remain |
| Physical/deployment pilot | No factory device available | No deployed TLS or production DB accessed | Signed upgrade/physical reconciliation outstanding | REQUIRES PHYSICAL/DEPLOYMENT PILOT; emulator engineering is not factory certification |

Chief owns grants; a generic production Master has no implicit warehouse manager power. D1–D8 from the owner handoff are approved and supersede historical “await owner decision” sections. No new policy approval is needed to implement those decisions.

## Acceptance coverage

| Items | Executable evidence now | Missing acceptance |
| --- | --- | --- |
| A1 | `inventory-quality.postgres.test.ts`, quality client/UI tests, actual browser/native Chief release | Later cross-feature integration |
| A2–A3 | Existing correction authorisation and explicit Manager vs Master tests | Approved physical issue, split/count workflow |
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

Next is **S4**, with detailed resumption steps in [STORAGE_RESUMPTION_CHECKPOINT.md](STORAGE_RESUMPTION_CHECKPOINT.md). Implement request -> reserve -> Chief/Manager approve -> controlled dispatch -> authenticated assigned recipient receipt, exact package/batch provenance and no inferred consumption. Then continue S5–S10 in the owner's dependency order.
