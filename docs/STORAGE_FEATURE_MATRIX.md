# Storage implementation and evidence

Authoritative plan: owner handoff dated 2026-11-14, milestones S0–S10.
Working branch `feat/storage-inventory-foundation`; draft [PR #5](https://github.com/LHONE-mf/production_mf/pull/5), based on `feat/hybrid-server-foundation`. Never merge or touch production data as part of this work.

## S0 audit (2026-11-14)

Live remote and local HEAD are `116434b8388f488cd7f4eae567d07676562fc9dd`.
Both baseline checks were VERIFIED IN CI ON SHA:
[Run Tests](https://github.com/LHONE-mf/production_mf/actions/runs/43571674909),
[web/server/browser/restore](https://github.com/LHONE-mf/production_mf/actions/runs/43571674859).
These links are historical baseline evidence, not verification of subsequent commits.
Graphify reports index `050530703cd582e71e5ba558493a88f99445be8f` (main): stale for Storage. Storage findings below come from live branch files, not that graph.

| Milestone / owner decision | UI | API / DB | Offline | Tests / gaps / next files |
| --- | --- | --- | --- | --- |
| S0 reconcile | Existing screens audited | 001–022 retained | InventoryOutbox v7 retained | IMPLEMENTED audit; no source rewrites |
| S1 Route A | Existing startup, Back, conflict-archive instrumentation | Emulator migrates only 001–010; no running Storage HTTP backend | Native archive test only; browser covers frozen inventory intent | NOT IMPLEMENTED native Storage; first: workflow, isolated fixture, debug-only bundled harness, instrumentation |
| S2 catalog/admin | No material/location/grant administration screen | Proven scoped lists; material/location create, Chief-only grant events exist | Catalog cached with bounded original-login lease | Partial: `inventory-catalog-routes.postgres.test.ts`; create/edit/grants UI and transactional admin hardening needed |
| Receiving / D1 | Durable receiving with preview/manual send and history | Quarantine, distinct stock UUID vs repeated manufacturer lot, supplier/document; exact mg/ul/mm/pieces | Immutable receiving intent, retained ACK, unknown-outcome retry | IMPLEMENTED baseline: `inventory-routes.postgres.test.ts`, `inventoryReceiving.test.ts`, operator smoke; dates/detail labels missing |
| S3 QA / D1 | No disposition/release screen | No authenticated QA transition; all new receipts quarantined | Quality cached; no release queue | NOT IMPLEMENTED; Chief-only documented disposition with transaction, fence, evidence, expiry and tests |
| S4 issue / D2 | No reservation/physical handoff screen | Reservation API exists; physical issue route deliberately unavailable | No issue proposals | NOT IMPLEMENTED vertical workflow; generic Master must never imply manager |
| S5 returns / D3 | None | No accepted-source issue/eligible return contract | None | NOT IMPLEMENTED; normal eligible return directly available; unsafe return held/denied |
| S6 split / D4 | Whole-container move/correction only | No split/genealogy; whole unreserved transfer and privileged correction exist | Frozen move/correction queues | NOT IMPLEMENTED split; conservation, authorisation, stable IDs and concurrency required |
| S7 count / D5 | Correction form, no sessions/count observations | Privileged correction exists; no count evidence/session model | Correction frozen; no count proposal | NOT IMPLEMENTED count workflow; counting anytime never changes stock itself |
| S8 identification / D6 | No authoritative Storage scanner/labels | IDs exist, no typed lookup/export contract | Catalog lookup exists without scanner | NOT IMPLEMENTED package/location/batch QR, manual fallback and wrong-scope denial |
| S8 reporting / D8 | Simple stock text search, last 200 received events | Scoped cursor feed; no full reporting/alerts/expiry | Explicitly stale bounded stock view | NOT IMPLEMENTED reports/export/thresholds; CSV injection and ledger reconciliation tests required |
| S9 finished goods / D7 | No Storage acceptance screen | Existing manufacturing identities/handoffs; no warehouse accept contract | No warehouse handoff intent | NOT IMPLEMENTED; completion must not create stock |
| S9 Slurry | Existing local calculators preserved | No approved-issue/actual-consumption link | Existing local production remains independent | NOT IMPLEMENTED inventory integration; preserve batch identity/measurements |
| S10 recovery/hardening | Chief review/export/apply, explicit held intents | Epoch fencing, immutable recovery approvals, full restore drill | v1–v7 upgrades, held requests/ACK/archive preservation | Baseline IMPLEMENTED recovery; `inventory-recovery.postgres.test.ts`, outbox upgrade tests, actual browser and restore scripts; extend per slice |
| Physical / deployment pilot | No factory device available | No production host/DB accessed | Signed upgrade and physical reconciliation outstanding | REQUIRES PHYSICAL/DEPLOYMENT PILOT; automated engineering is not certification |

## Approved policy (supersedes historical “pending owner decision” notes)

D1 Chief alone releases quarantine with reason/evidence. D2 every physical issue needs Chief or explicit Warehouse Manager approval. D3 eligible unused returns reference accepted issue/package/batch and return directly available exactly once, bounded by outstanding quantity; expired/blocked/damaged/untraceable/altered material stays held or fails closed. D4 Chief/Manager authorises conserved splits with new child IDs and genealogy. D5 counts anytime; only Chief/Manager approves a balance correction. D6 QR identifies package/location/batch; lookup confers no permission. D7 production submits; warehouse explicitly accepts into quarantine; no automatic inventory on completion. D8 confirmed/pending/quarantine/blocked/reserved/issued/returned states remain distinguishable in reports.

Chief owns warehouse grants under the existing policy. Generic production Master has no warehouse manager authority. Privileged online-only operations are acceptable when explicit and documented; disconnected drafts never become confirmed balances. Never migrate observational journals into stock.

## Acceptance tracking

| Items | Current executable evidence | Remaining acceptance |
| --- | --- | --- |
| A1–A3 | Existing correction/permission tests only | QA, approved issue, split/count workflow absent |
| A4 | Inventory route/stock/recovery PostgreSQL tests; epoch/revocation lock races | Extend every new mutation/read/export |
| A5 | `inventoryOfflineView.test.ts`, existing browser identity/reopen checks | Native account switch/cache concealment |
| Q1–Q3 | `inventoryReceiving.test.ts`, domain/stock PostgreSQL tests; smoke same-lot receipts | Split conservation and fractional-pieces/overflow on new paths |
| Q4–Q8 | Existing quarantine/reservation guards | Issue vs consumption, eligible returns, counts, finished acceptance |
| R1–R5 | Outbox/client/upgrade/recovery tests; browser lost ACK/conflict; actual dump/restore | Native inventory process death and each new intent type |
| U1–U2 | Browser 390x844 / 1365x900; basic emulator launch/Back | Full native Storage lifecycle/keyboard/safe areas and 412x915 |
| U3–U5 | None for scanner/alerts/exports | Implement and test S8 |
| U6 | `StorageModule.tsx` labels legacy observation register separately | Preserve throughout roadmap |

## Per-slice implementation / rollback rules

S1 adds test tooling and debug assets only; no runtime production auth relaxation or DB/outbox migration. Restrict loopback cleartext to Android debug manifest and exact localhost; release manifest remains unchanged. Apply the complete sorted migration directory once to an empty isolated CI database, never rerun non-idempotent historical migrations on existing data. Rollback removes test-only additions; existing browser/restore and native proof tests stay intact.

Next acceptance: actual Android WebView logs in, enrolls/proves its AndroidKeyStore key against Fastify/PostgreSQL, displays stock, freezes receipt, survives relaunch with same ID, explicitly sends and retries after lost ACK, verifies one quarantined receipt and operator denial. Add later QA/issue/split/count scenarios as those features are implemented; do not pretend absent APIs passed.

### S1a — complete disposable migration setup

IMPLEMENTED: both ordinary CI and emulator setup discover the same complete sorted migration directory (001–022 today; additive future files included). The runner rejects non-loopback/non-CI URLs/users, query-string host overrides, and populated public schemas before any historical migration. No production migration changed. Local checks: two Node tests passed; all 22 migrations applied successfully to the empty disposable `production_mf_emulator_ci`. Populated reapplication must fail. Frontend baseline: 602 tests, typecheck/build passed; server typecheck/build passed. Native backend-connected evidence still pending S1b.
