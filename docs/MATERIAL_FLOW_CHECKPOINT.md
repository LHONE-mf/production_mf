# Material-flow foundation checkpoint — 2026-11-15

Verified code source: **628ade06aed3af7a09af2a968791e43df5aa786c**.
Branch: `feat/material-flow-foundation`, based on both the existing blueprint
`b18897f` and latest inspected Storage head
`69209c77589aac501c076d2a32f7908beb548377` (draft PR #5).
The original feature branches remain untouched. No main/PR merge or deployment.

## Completed increments

- **1109319:** fix the blueprint's direct-versus-WIP contradiction, distinguish
  Assembly buffer release, add conditional bypass/serial routes and optional
  independently counted Storage candidates, and document all eleven rooms.
- **628ade0:** add raw/component/WIP semantics, explicit source/catalogue/spec/
  variant/lot/polarity/format/custody identities and nonposting observation drafts;
  project multi-lot partial allocations with safe quantities and exact serial sets.
  Preserve original sources, unknown QA/polarity, separate same-lot packages and
  per-source dimensions. Reject duplicates, stale references, scope mismatches,
  holds, overuse and missing/invalid/already-selected serial subsets.

Files changed relative to Storage:

- `src/core/manufacturing/materialFlowBlueprint.ts`
- `src/core/manufacturing/materialFlowBlueprint.test.ts`
- `src/core/manufacturing/materialFlowAllocations.ts`
- `src/core/manufacturing/materialFlowAllocations.test.ts`
- `docs/PRODUCTION_MATERIAL_FLOW.md`
- `docs/MATERIAL_FLOW_CHECKPOINT.md` (this documentation-only closeout)

## Actual local verification

| Command / check | Result |
| --- | --- |
| Original `npm test -- src/core/manufacturing/materialFlowBlueprint.test.ts --reporter=default` | Reproduced inherited RED: 1 failed / 5 passed; dry-cell direct assertion contradicted approved Assembly WIP |
| Revised blueprint focused tests | 9 passed |
| Slice 1 `npm run typecheck`, `npm test -- --reporter=default`, `npm run build` | Passed; 725 tests in 123 files; Vite/PWA build passed |
| New allocation tests before implementation | RED: module missing |
| `npm test -- src/core/manufacturing/materialFlowAllocations.test.ts src/core/manufacturing/materialFlowBlueprint.test.ts --reporter=default` | 15 passed |
| Deliberate mutation `quantity > balance` → `<` | Caught: 3 allocation tests failed; original restored before final checks |
| Final `npm run typecheck` | Passed |
| Final `npm test -- --reporter=default` | **731 passed in 124 files**, 70.35 seconds |
| Final `npm run build` | Passed; Vite 5.03 seconds; PWA service worker/precache generated |
| `git diff --check` | Passed |

Final logs: `/tmp/production-mf-flow-final-typecheck.log`,
`/tmp/production-mf-flow-final-tests.log`, `/tmp/production-mf-flow-final-build.log`.
Mutation evidence: `/tmp/production-mf-flow-mutation.log`. Logs are session-local.
Existing React act warnings and >500 kB bundle warning remain visible. No new CI,
PostgreSQL, browser, Android, physical factory or deployment result is claimed.

The six vendored engineering skills and Ponytail were applied. Review checked
correctness/conservation, explicit unknown/hold handling, unit/serial identity,
scope boundaries, unchanged runtime call sites and absence of dependencies or
stock effects. No subagents were used.

## Data impact and operational limits

No migrations, catalogue creation/backfill, production mutations, dependency or
lockfile changes. Main Dexie **24**, inventory outbox **v7**, PostgreSQL **032**
remain unchanged. Existing journals, offline source claims, queues, ACKs and backup
formats are untouched. The full frontend suite includes the existing IndexedDB/
backup regressions; no new persistent WIP schema or new upgrade path is claimed.

This is a nonposting foundation. The pure allocation projection is neither a
reservation nor cross-device authorization; draft actor/device fields and packet
signatures do not authorize stock. Persistence, immutable snapshots/exact retries,
server locking/authority, physical receiver ACK and live consumption are still
required. Existing whole-source exclusions and serial guards remain in force.
Pouch is an explicit target in the new vocabulary; operational `CellType`, station
capabilities and legacy packet/route guards still need additive implementation.

Next three tasks and remaining factory decisions are in
[the room matrix and continuation](PRODUCTION_MATERIAL_FLOW.md#validation-and-continuation).
Immediate factory inputs: receipt ACK timing and tape issue unit/SKU. Pouch dry
declaration/stations, serialized subset evidence and post-Formation steps/location
remain decisions before their dependent operational slices.
