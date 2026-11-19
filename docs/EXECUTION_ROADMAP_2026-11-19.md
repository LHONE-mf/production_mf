# Production MF — execution roadmap (19 Nov 2026 → Jan 2027)

> **Status:** proposed execution plan, not a release authorization, factory acceptance, or claim that pending work is implemented. Baseline checked against GitHub on 2026-11-19.
>
> **Source baseline:** \`main\` = \`f4d0c7626991cb74719338611ded43d16aa0729d\` (migrations through 045). Preserve existing local records, pending outboxes, manufacturing journals, inventory ledgers, and immutable provenance. This document supplements \`PRODUCT_SPECIFICATION.md\`; the historical \`DEVELOPMENT_PLAN.md\` is superseded.

## Outcomes, dates and confidence

| Gate | Target | Definition | Confidence / prerequisite |
| --- | --- | --- | --- |
| G0: known-good integration candidate | 2026-11-22 | One reviewed candidate combining applicable sync fixes + room UX; fresh full web/server/PostgreSQL/Android smoke checks on same commit | Conditional on CI and diff review |
| G1: safe limited offline engineering APK | 2026-11-29 | Explicit local data, signed install-over-old, offline restart, external backup/check, isolated restore drill, no hidden data removal | Conditional on actual device + signing |
| G2: constrained workshop engineering pilot | 2026-12-10 | Tasks, Storage and source-bound Slurry→Sorting exercised on staging, in separate test identities; no authoritative cell release | Conditional on G0/G1 + staging accounts |
| G3: integrated end-to-end release candidate | 2026-12-24 | Explicit physical source trace from stock issue to formed-cell WIP and separate QA controls in staging, test results attached to exact SHA; unresolved unsupported flows disabled | Aggressive target, not guaranteed |
| G4: factory production-readiness decision | 2027-01-22 | Two enrolled real devices, TLS server, cutover/recovery, physical counts, QA witnesses, signing/camera/printing and rollback evidence | External operator/factory acceptance required |

**Scheduling assumption:** at least two parallel development tracks (AI-assisted implementation with human review), one person empowered to decide product policies, a separate disposable PostgreSQL environment and two test Android devices by G2/G4. If these are not available, shift G2–G4; do not weaken exit criteria. Dates are targets, never substitutes for passing gates. Christmas/New Year is treated as buffer for physical acceptance.

## Actual source snapshot and work to integrate

- \`main\` contains React/TypeScript/Vite/Capacitor, local Dexie journals, Fastify/PostgreSQL, M1 manual task sync, M2 planning, Stock/QA/issues/splits/counts, room custody and direct measured Slurry→Coating→Calendaring→Cutting→Sorting operations through migration 045. This is an engineering implementation, not a qualified factory system.
- [PR #40](https://github.com/LHONE-mf/production_mf/pull/40): integrated seven sync safety fixes; exact \`ed56f022...\` Run Tests and Android installed-upgrade workflow succeeded, full web/server CI was **cancelled** on that head. Rerun full CI before merging. It is a **draft**.
- [PR #46](https://github.com/LHONE-mf/production_mf/pull/46): 11 shared room navigation/header surfaces, at \`dc446d82...\` 862 frontend tests passed. It targets #40 branch; review then rebase/retarget in order, not independent cherry-pick blind. It is a **draft**.
- [PR #44](https://github.com/LHONE-mf/production_mf/pull/44): signed APK job succeeded at \`abc3ed41...\`, an **earlier** sync-source version. Do not treat that APK as proof for #40 or #46.
- [PRs #25–29](https://github.com/LHONE-mf/production_mf/pulls): overlapping Storage split policies/tests/fixes on branches from \`main\`; reconcile with the currently merged split implementation and server tests before selecting any change. Do not assume each still needs merging.
- [PRs #31 and #33](https://github.com/LHONE-mf/production_mf/pulls): stale Sorting source and output contract preflight; compare with main/current source, then integrate valid regression tests and fixes.
- The latest physical OnePlus/ColorOS, signed in-place upgrade of a data-bearing installation, independent restore and live TLS two-device pilot are **not evidenced** in reviewed materials.

## Visual dependencies

\`\`\`mermaid
flowchart TD
    A["Freeze exact SHA + audit open PR diffs"] --> B["Sync #40 full CI + conflict review"]
    B --> C["Room UI #46 review / rebase / CI"]
    C --> D["Signed exact-SHA APK + in-place upgrade / backup / restore"]
    D --> E["G1: limited offline APK"]
    B --> F["Storage split and Sorting regression consolidation"]
    F --> G["Cutting receipt → 3-station Sorting → authoritative output"]
    G --> H["Approved grade/count → Assembly lots + pairing"]
    H --> I["Cylindrical / prismatic / pouch + dry-cell WIP"]
    I --> J["Filling → Walzing where needed → Formation WIP"]
    J --> K["Physical serialized cell receipt + independent Chief QA"]
    E --> L["TLS staging + 2 device role/conflict drills"]
    G --> M["G2: narrow engineering pilot"]
    L --> M
    K --> N["G3: integrated release candidate"]
    M --> N
    N --> O["Physical count, restore, signing, QA and operator gate"]
    O --> P["G4: factory readiness decision"]
\`\`\`

## Calendar and parallel tracks

\`\`\`mermaid
gantt
    title Proposed execution (no task is marked done by this plan)
    dateFormat YYYY-MM-DD
    axisFormat %d %b
    section Integration and M0
    Review PRs / exact SHA integration      :a1, 2026-11-19, 4d
    Auth backup upgrade & Android pilot     :a2, 2026-11-23, 7d
    section Manufacturing contracts
    Storage & Sorting safeguards            :b1, 2026-11-23, 10d
    Sorting receipt-to-output               :b2, 2026-11-30, 11d
    Assembly lots pairing and pouch         :b3, 2026-12-07, 13d
    Filling / Formation / cell QA           :b4, 2026-12-14, 11d
    section UX operations and release
    Staging 2-device drills / UI            :c1, 2026-11-30, 11d
    Manufacturing E2E regression/reporting  :c2, 2026-12-14, 10d
    Exact-SHA RC freeze                     :milestone, c3, 2026-12-24, 0d
    Physical acceptance / recovery          :c4, 2027-01-04, 15d
    Factory decision gate                   :milestone, c5, 2027-01-22, 0d
\`\`\`

## Work packages: prioritized, file-targeted, testable

### P0-A — Baseline/integration (19–22 Nov, 2–3 engineer-days)

1. Compare current \`main\` with #40; rerun full \`.github/workflows/ci.yml\` at **#40 exact HEAD**, including PostgreSQL integration, web typecheck/build, task identity and outbox tests. Keep cancelled results labelled cancelled.
2. Review #46 after #40, confirm 11 screens, 390/412 px widths, 44 px targets, no hidden form remount/reset. Verify 862 tests on its exact head and rerun full CI on final combined SHA.
3. Deduplicate stale/stacked Storage/Sorting PRs by exact diff, tests and migration history; record which changes are already present. Use small reviewed PRs, do not bulk merge branch chains.
4. Produce a baseline matrix of exact SHA, tests, Android APK, schema, signing key, pending outbox and failure/recovery runs. Existing \`docs/ONE_DAY_RELEASE_GATE.md\`, \`docs/M1_RELEASE_CHECKLIST.md\` and \`docs/STORAGE_RESUMPTION_CHECKPOINT.md\` remain source records.
5. Inspect \`src/core/store/authStore.ts\`, \`src/core/sync/atomicTasks.ts\`, \`src/core/sync/taskDto.ts\`, \`src/core/db/index.ts\`, and \`apps/server/src/sync-routes.ts\` for current release gate behavior. **Do not reintroduce persistent bearer secrets or auto-sync.**

**Exit:** one exact source SHA with reproducible frontend/server/PostgreSQL tests, current PR diffs mapped, and no conflated old APK proof.

### P0-B — Data safety, security and deployment foundation (23–29 Nov, 4–6 engineer-days)

1. Native Android installed upgrade over same-signature engineering installation with synthetic pre-existing task revision, conflicts, inventory proposals, Slurry draft, production journal and offline queue; verify force-stop/reopen and preserving \`Date\` objects. Software/emulator result is not substitute for the real phone.
2. Run \`src/core/db/localBackup.ts\` backup and external file validation; on separate disposable empty installation of compatible schema, perform full restore with negative test. Do not erase or uninstall a phone with valuable data. Hybrid sync archive restore remains intentionally restricted until a conflict-safe recovery/cutover procedure is approved.
3. Server staging: real TLS, per-person user roles/workshop membership, independently enrolled Ed25519 devices, PostgreSQL backup schedule and a **restored** separate database rehearsal, expiry/revocation, monitoring and immutable audit.
4. Verify stale authentication/session exclusion, forbidden writes and no plaintext credentials; all role authorization is server checked. Confirm no sample accounts/work automatically appear.
5. Release signing: inspect certificate fingerprint and update compatibility. A publicly available development signing key is not acceptable as a production release key.
6. Upgrade-critical source: \`android/\`, \`src/core/db/\`, \`src/core/store/authStore.ts\`, \`src/core/sync/\`, \`apps/server/src/auth.ts\`, and \`infra/\`. Run actual GitHub Actions, not a local-only green assertion.

**Exit:** G1 only after tested phone restore/upgrade and external backup; otherwise limited disposable installation only.

### P0-C — Warehouse controls and inventory conservation (23 Nov–6 Dec, 4–6 engineer-days, parallel)

1. Audit split genealogy/ancestor holds, reservations, QA and all same-manufacturer-lot independent receipts against \`src/stages/storage/InventorySplitPanel.tsx\`, \`src/core/sync/inventorySplits.ts\`, \`apps/server/src/inventory-split-routes.ts\`, \`apps/server/src/inventory-stock-operations.ts\`, and migration \`028\`. Incorporate only demonstrably missing #25–29 fixes.
2. Preserve immutable ledger and exact unit quantities; parent+child inventory must conserve quantity exactly. On simultaneous device submissions, only one current revision commits, the other retains its frozen conflict without hidden replacement.
3. Chief alone authorizes QA release. Chief or explicitly granted warehouse Manager approves/dispatches issues and authorizes splits/corrections. Production Master does not implicitly inherit Manager authority.
4. Physical warehouse receipt and stock movement must never be inferred from a local room journal; no duplicate debit for measured consumption after issue.
5. Add backend PostgreSQL + UI regression for same manufacturer lot with two distinct physical receipt IDs; quarantine/holds, expiry, lost ACK/retry, offline provisional status and complete history.
6. Do not invent conversion from physical polyimide roll to length/pieces. Keep per-use width/thickness/spec and observed actual consumption separate.

**Exit:** staged two-user inventory pilot reconciles exact independent lot/package balances and immutable history; no unresolved stale/unauthorized posting.

### P1-D — Cutting→Sorting authenticated flow (30 Nov–10 Dec, 5–7 engineer-days)

1. Bind actual **received Cutting piece lot and quantity**, not arbitrary legacy \`cuttingRuns.goodCount\`, as the capacity for the **Visual → Thickness → Mass** three-station sequence. Preserve source and recipient identity, accepted count, held/rejected pieces, and original physical lot label.
2. Preserve **pass/fail** and **mass-graded** modes. Thickness is pass/fail; mass determines grade only in graded mode. Every physical electrode is inspected independently. Record immutable station decisions, reject reasons, operator and criterion version. Rejection at any station excludes the piece from downstream passes.
3. Add authoritative source compatibility/ownership guard and local preflight before immutable final save; include #31/#33 regression scenarios without permitting stale source or server-incompatible category labels.
4. Commit approved graded output as a separately frozen/authenticated proposal; separate warehouse receipt and Chief QA. The direct Assembly handoff must not auto-post warehouse stock or QA release.
5. Modify/extend \`src/stages/sorting/SortingWorkflowTab.tsx\`, \`src/core/manufacturing/sortingWorkflow.ts\`, \`src/core/manufacturing/sortingWorkflowValidation.ts\`, \`src/core/sync/cuttingOutputs.ts\`, \`src/stages/sorting/FinishedElectrodeOffers.tsx\`, and backend \`apps/server/src/cutting-output-custody-routes.ts\`, \`inventory-output-contract.ts\`, \`inventory-output-routes.ts\`. Use **additive migrations only if necessary**, starting after 045.
6. Test two receivers, partial receipts, independent lots, all-fail, each station rejection, old cut-run stale snapshot, offline freeze/retry/lost ACK, two device conflict, grade balance, and readback genealogy.

**Exit:** exact sum(received)=rejected+approved+held (as physically evidenced), explicit grade totals, no fabricated yield.

### P1-E — Assembly materials, pairing and all cell formats (7–19 Dec, 6–8 engineer-days)

1. Add allocation-based sources for **multiple partial lots** of cathodes/anodes and other materials, preserving each parent remainder. Legacy assembly currently allows only a full source and has no pairing contract: see \`src/core/manufacturing/assemblySource.ts\` and \`src/core/manufacturing/assemblyIntake.ts\`.
2. Define one cell-build/assembly record with actual cathode+anode source quantities and compatible chemistry/polarity, separator, tabs and packaging evidence. Do not invent a fixed electrochemical pairing ratio or convert electrode counts across units automatically.
3. Represent lithium electrodes, stacks, wound blocks and assembled dry cells as Assembly **room WIP**, not available warehouse stock. Explicit handoff/receipt at next room.
4. Extend explicitly to **cylindrical, prismatic, pouch**; current \`CellType\` only covers two. Introduce controlled schema/types and migrations without relabeling old records.
5. Existing modules: \`src/stages/assembly/AssemblyRoom.tsx\`, \`AssemblyCellOutputForm.tsx\`, \`src/core/types/domains/assembly.ts\`, \`src/core/manufacturing/assemblyOperations.ts\`, \`src/core/manufacturing/assemblySource.ts\`; add server authoritative allocation only after full contract is tested.
6. Gate conflicts, duplicates, scrapped input and unpaired records. Test multiple same-SKU lots, cross-batch requirements, partial reuse, revoked source, wrong polarity/material, pouch identity and WIP persistence across restart.

**Exit:** one traceable dry-cell identity with complete, explicitly measured genealogy and defensible remainder calculations.

### P1-F — Filling, Walzing, Formation, serialized cell QA (14–24 Dec, 6–9 engineer-days)

1. Keep separate routes: dry-room Filling→Formation; room 705 cylindrical Filling→Walzing→Formation, as approved by actual process. Do not turn Walzing into an obligatory step for other formats.
2. Require source-bound received dry-cell WIP, actual electrolyte use/remaining, explicit observed processed/rejected/unknown counts and device/operator evidence. Nothing automatically releases a cell.
3. Formed cells remain **Formation WIP** pending QA; physical serialized-cell warehouse receipt is a separate counted event. Do not manufacture serials from merely planned quantities.
4. Extend \`src/stages/electrolyte/FillRoom.tsx\`, \`src/stages/walzing/WalzingRoom.tsx\`, \`src/stages/formation/FormationRoom.tsx\`, \`src/stages/formation/FinishedCellOffers.tsx\`, \`src/core/manufacturing/fillingResults.ts\`, \`formationResults.ts\`, \`src/core/sync/inventoryCellOutputs.ts\`, \`apps/server/src/inventory-cell-output-routes.ts\`.
5. QA receipt: quarantine initially; independently checked physical serials/counts; Chief-only QA release with immutable evidence and separate rejections. No false capacity, CE or ageing results.
6. Test three formats, serial uniqueness, missing records, partial/unknown result, two-device identical replay, rollback, orphan conflicts, full reverse genealogy, independent receipt and QA.

**Exit:** authenticated staging thread from actual material issue → traceable physical cell → Formation WIP → independently received/quarantined/authorized output.

### P1-G — Integrated UX / analytics / acceptance (30 Nov–24 Dec, 4–6 engineer-days, parallel)

1. Use shared room navigation from #46; ensure keyboard/back, status-bar safe areas, 390px/412px screens, large fonts, switching tabs while drafts pending, and truthful local/server status.
2. Add operator-facing source genealogy and quantity truth table: **issued / received / used / remnant / rejected / quarantined / available**, with unit, source and evidence. Never total unlike units and never infer missing values as zero.
3. In \`src/kpi/KpiDashboard.tsx\`, treat unrelated stage totals as distinct; suppress unsupported cross-stage yield. Expose observed scrap/rework only when exact physical population is linked.
4. Log runtime errors with reproducible identifier; avoid secrets, password hashes, raw sensitive archive dumps. Define per-device diagnostics (APK commit, schema, scope, last manual sync, queued/conflict count).
5. Add broad E2E tests across independent browser profiles and Android emulator. Include zero demo data, loss of server connection, stale tokens, process death, old schema, untouched journals, raw Android sharing, QR/manual lookup and print.
6. If a flow is not backed by authoritative receipt/QA, label it **local observation** or **unverified staging** visibly instead of showing green production-ready status.

**Exit:** G3 exact commit and evidence index for every module; unsupported flows are explicitly disabled or marked provisional.

### P0-H — Factory deployment gate (4–22 Jan 2027, operator-dependent)

1. On two real separately enrolled Android devices, verify signed upgrade **over the existing installation**, airplane mode/restart, conflict reconciliation, role revocation, manual task sync, warehouse receipt/QA/reconciliation and source handoffs on a TLS staging server.
2. Test physical scales/gauges/measurement records, warehouse labels, ColorOS camera/QR printing, and actual operator traversal of every room at realistic throughput.
3. On isolated staging, perform PostgreSQL dump→restore, second independently validated restore, interrupted migration rehearsal, exact stock/ledger/genealogy reconciliation, pending outbox/cursor reconciliation, and app rollback procedure. A new APK with incompatible signature must not be installed to overwrite data.
4. Require named independent acceptance by production owner, warehouse authority and QA owner; unresolved P0 = **NO GO**. Report open P1 limitations and scope exclusions explicitly.
5. No automatic synchronization, hidden data deletion, migration of production DB or inferred factory QA to accelerate the date.

## Quantified exit checklist

| Gate | Non-negotiable automated / observed criteria |
| --- | --- |
| Code | Zero failing typecheck, full frontend/server/PostgreSQL regression, web build, signed artifact matched to **exact SHA**; cancelled checks count as not passed |
| Data | Zero silent deletion/override on tested install upgrade; rollback + backup/restore reproduces records, revisions, queued identities and native Dates |
| Security | Server denies out-of-scope user/device/tenant, stale/disabled actor, false QA role; no persistent bearer secret or magic fallback account |
| Inventory | Every accepted stock-affecting intent leaves exactly one authoritative paired ledger event; conservation holds by exact immutable unit |
| Manufacturing | Every consumed quantity links to verified received source; no negative remainder, oversubscription or unapproved auto-pairing |
| QA | Quarantine initially; Chief-only release after separate physical evidence; no locally inferred PASS or capacity |
| Devices | Manual sync and explicit conflict resolution after offline/restart/revocation; physical Android sign/print/camera/upgrade evidence separately attached |

## Daily delivery discipline

- Keep separate small changes for backend, migration, client, UI; perform one additive behavior slice per PR with reproduction test, acceptance scenario and explicit rollback/migration notes.
- Every weekday: note exact SHA, tests that truly passed, open PR dependencies, top blocker, next change and a truthful percent *of defined exit criteria*, not "code amount".
- On days 2, 5 and each week boundary: reevaluate the critical path and reschedule missed gates without watering down the tests.
- Track expected implementation effort, not wall-clock promises. **No branch auto-merge. No main merge without explicit owner approval.**
- Preserve existing \`src/core/db\` tables, local data and caches; do not seed test/demo records into a real production profile.

## First actionable queue

1. **NOW:** bring #40 exact latest head through complete CI; review integration diff and UI #46 atop the verified head.
2. **NEXT:** consolidate #25–29 and #31/#33 into a deduplicated tested backlog rather than serially merging old branches.
3. **NEXT:** exact-SHA signed APK from combined candidate, preserve-data installation test, external backup + separate restore.
4. **THEN:** build Sorting received-piece quantity binding and server-compatible grade contract before Assembly pairing.
5. **IN PARALLEL:** stage a TLS server with individual human/device identities and a witnessed warehouse pilot.

**Definition of progress:** proof that the next real production operation can be recorded, recovered, and traced without inventing measurements, stock or quality.
