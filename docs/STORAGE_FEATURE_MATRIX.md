# Storage implementation and evidence

Authoritative plan: owner handoff dated 2026-11-14, milestones S0–S10.
Working branch `feat/storage-inventory-foundation`; draft [PR #5](https://github.com/LHONE-mf/production_mf/pull/5), based on `feat/hybrid-server-foundation`. Never merge or touch production data as part of this work.

## Current checkpoint

S0 audit complete. S1 native/backend bridge and S2 catalogue/grant creation/editing are verified on ddbb5d3. S3 Chief QA is implemented with 612 frontend / 219 real-PostgreSQL tests passing locally; hosted verification is pending publication. S4–S10 remain open; the table preserves original audit findings and subsequent milestone sections identify delivered changes. No production data, merge or factory acceptance.

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

### S1b — native backend test implementation

IMPLEMENTED, native execution PENDING: debug-source-set-only bundled harness imports the real ConfirmedStorage screen, native DeviceProof plugin, login/proof client and inventory queues. A loopback-only disposable Fastify fixture creates synthetic users/catalogue but no stock or proof shortcuts. Two instrumentation invocations, separated by actual `adb force-stop`, verify frozen receiving intent, explicit sending, lost acknowledgement/idempotent retry, exact 2.125 kg, distinct same-lot quarantined packages, real operator POST denial and logout/cache concealment. PostgreSQL independently verifies two receipts, two events and no duplicated/privileged mutation. Debug cleartext is restricted to exact loopback domains; release source sets/assets are unchanged. No new dependency, DB migration or outbox version.

Local: debug harness typechecks and builds; Node/shell syntax checks pass; existing 205 real-PostgreSQL tests pass. Native QA/issue/count/split scenarios await those APIs (S3–S7); do not count them as passed. Existing launch/Back/archive/native proof and browser/restore checks are retained. Hosted manual run required before S1 acceptance; no local Android SDK/emulator is available in this workspace.

Harness diagnosis: an initial Chromium-only harness regression reproduced an edit before the new asynchronous receiving form became enabled. The helper now waits for enabled controls and durable field saves. Focused browser harness checks passed using disposable Fastify/PostgreSQL; its diagnostic signing stand-in is **not native evidence**. Hosted instrumentation still uses the real native plugin. The standalone launch-only emulator workflow explicitly selects its applicable suite; the backend test is mandatory in the Route A workflow with fixture setup. Node guards and harness types are checked by ordinary CI.

Native run a966d58 [43580840481](https://github.com/LHONE-mf/production_mf/actions/runs/43580840481) FAILED at first WebView fetch after all legacy native proof checks passed. Diagnosis found the app and Capacitor manifests declared no INTERNET permission. Added the normal Android network permission (needed for the existing HTTPS server client), a native permission assertion and restricted failure log capture. Cleartext remains debug-only loopback; no release transport/auth relaxation. Retest required.

### S1 hosted baseline verified

VERIFIED IN CI ON SHA `e51d2ab171d3ca6161ca2b05a8b30d42d8c9520c`: [Route A Android run 43581559367](https://github.com/LHONE-mf/production_mf/actions/runs/43581559367), [native evidence artifact](https://github.com/LHONE-mf/production_mf/actions/runs/43581559367/artifacts/14109265006). Both actual Storage instrumentations reported `OK (1 test)`; independent PostgreSQL verification reported agreement. Existing launcher/Back, conflict archive, AndroidKeyStore vectors and fresh Capacitor proof verification passed in the same job. [Web/server checks](https://github.com/LHONE-mf/production_mf/actions/runs/43581538045) and [frontend tests](https://github.com/LHONE-mf/production_mf/actions/runs/43581538046) also passed on this SHA. Earlier a966d58/dc5a8ea native attempts failed before the INTERNET permission fix; retained as diagnostic history.

This is verified baseline native receiving/retry/identity coverage, not completion of S1's later QA/issue/count/split scenarios or the entire S10 lifecycle/keyboard/rotation matrix. Those tests must be extended as their real features land. Artifact retention is seven days.

### S2a — catalogue creation and Chief grants

IMPLEMENTED: material/location browser and creation forms, hierarchy-aware parent selection, explicit administrative review/manual send, persisted original-profile requests and replies, Chief-only paginated employee/effective-grant screen, grant/revoke proposal controls. Operators see no administration; Managers can create catalogues but cannot list/change grants. No new dependencies or Dexie version. New additive migration 023 preserves prior records and adds immutable catalogue creation audit plus device/history context for future access events.

All catalogue and grant writes now require current history (`x-inventory-epoch`) and recheck current authority under the organization stock lock. Exact catalogue retry returns the original result; altered intent cannot reuse its ID. Existing internal fixture callers and the native harness obtain and send the actual history identifier. No runtime test bypass was introduced.

Local verification: frontend typecheck and focused UI/client tests; server 36 files / 211 tests passed against real disposable PostgreSQL, including explicit Manager vs generic Master, Chief-only scoped discovery, lost-ACK creation retry, actor/device audit immutability, suspension, actual lock-wait revocation for catalogue/grants, and populated additive migration reapplication. Actual two-profile browser now exercises catalogue/location/grant UI and catalogue lost-ACK retry alongside all previous Storage/recovery scenarios. A duplicate sibling React key reproduced accumulating receiving forms during browser refreshes; unique component keys fix it, and the browser checks one receiving form remains.

S2 remains PARTIAL: versioned material metadata/location editing, active/inactive controls and fuller navigation/detail need completion. S3–S10 feature gaps above remain open. The prior e51d2ab native success is baseline evidence, not verification of this subsequent administration slice. Current-SHA CI/native evidence must be checked after push. Rollback requires reverting application code first; keep additive audit data and original outbox rows, never drop/reset them to roll back UI.

### S2b planned acceptance and migration

Next slice: versioned material name/supplier-reference/active editing, immutable codes/units/category; versioned location label/parent/active editing with active-child, hierarchy/cycle and occupied/historical-subtree protection. Chief/explicit Manager only, same proof/history/lock/idempotency contract. Existing catalogue history has no fabricated backfill; record pre-edit snapshots in new events. Additive migration 024 must preserve populated stock, events and v7 queues. Inactive material cannot receive new stock. This is independent catalogue work while exact-SHA Route A for S2a runs; stock QA/issue semantics remain unchanged until S3/S4.

### S2b — versioned catalogue editing

IMPLEMENTED: material name/supplier item reference/active editor, immutable material code/category/unit; location label/parent/active editor with hierarchy/cycle, active-child and occupied/historical-subtree protection. Chief/explicit Manager only. Metadata revisions are independent of stock revisions; no metadata edit mutates stock. Migration 024 adds revision/default-active/reference fields and immutable before snapshots without inventing historical records. Existing cache/outbox versions stay unchanged; inactive material cannot receive new stock. Review/send still freezes the original version and history; refreshing never rebases the selected editor.

Local verification: 607 frontend tests, 214 real PostgreSQL server tests; typechecks and builds; actual browser creation/edit/grant and all previous inventory/recovery scenarios; populated 001–023 upgrade/reapplication in a unique disposable schema preserves existing stock/ledger and metadata identities. Current source also extends native preparation with actual Chief catalogue creation and supplier-reference editing; hosted verification is required after pushing. The prior S2a commit 83938e3 is VERIFIED IN CI: [web/server](https://github.com/LHONE-mf/production_mf/actions/runs/43582672978), [tests](https://github.com/LHONE-mf/production_mf/actions/runs/43582672910), [Android](https://github.com/LHONE-mf/production_mf/actions/runs/43582781912), [artifact](https://github.com/LHONE-mf/production_mf/actions/runs/43582781912/artifacts/14108858415). That native run predates the new Chief editor scenario.

S2 catalogue/grant operations are implemented; full report/history browsing, supplier/stock filtering, date/threshold policy, QR labels, tab navigation for future workflows and broader accessibility/native UX remain tracked in S8/S10. No absent QA/issue/count workflow has a placeholder tab. Next S3: genuine Chief-only QA release/hold/block/reject with documented evidence, current proof/history/expected stock revision, immutable stock feed event, expiry ineligibility, usable screen and browser/native tests. Receipts remain quarantined until S3 is implemented and verified.

### S3 planned acceptance

Implement Chief-only versioned release/hold/block/reject with immutable operation/disposition evidence, exact idempotency, current proof/history under stock lock, unchanged balances/reservations, explicit online-only prepare/send with retained intent/ACK. Rejected stock cannot be released. Add optional receipt manufacture/expiry dates (never backfill); date-only expiry means valid through that UTC date, expires at 00:00 UTC the following day. Expired stock cannot be released/reserved/issued. Existing undated/non-expiring records remain undated. Update stock serializers/validators/feed to preserve optional metadata on every operation. Test real Chief release vs Manager/operator/Master, stale/duplicate/expired/revoked/cross-org requests, quality feed/caches, zero-quantity QA audit (no movement), and migration preservation. Extend actual browser/native scenarios only after the real API exists.

### S3 — Chief quality disposition and exact expiry metadata

IMPLEMENTED locally: genuine Chief-only release/hold/block/terminal reject, explicit reason/evidence, current proof/history/revision/transaction lock, paired immutable quality/stock audit, zero moved quantity, read-scoped paginated quality history, retained original-profile online-only QA proposals/ACKs and usable Russian UI. QA never adjusts quantities/reservations. Optional receipt dates use inclusive UTC dates; expired material cannot be released/reserved/issued. New metadata survives all serializers/feed/cache/ack paths; old stock/drafts remain undated. Migration 025 preserves prior history and adds DB Chief/ledger/expiry guards with a deferred audit-pair constraint; no outbox version/reset.

Acceptance evidence: `inventory-quality.postgres.test.ts` covers real receipt->Chief release, Manager/operator/Master denial, missing evidence/wrong device, exact retry/changed intent/stale revision, hold/block/terminal reject, expiry/reservation prohibition, DB non-Chief denial, cross-org/history/proof rejection, invalid dates, and actual role change while waiting for the stock lock. `inventory-catalog-upgrade.postgres.test.ts` upgrades populated 001–023 through 024/025 without invented dates/QA or lost stock/ledger. Client/UI tests cover original frozen restart/lost ACK, no optimistic quantity change, retained conflict, malformed or conflicting ACK rejection, UTC leap-date parsing, role concealment, and explicit history loads. The actual two-profile browser passed Chief release/lost ACK/history and all earlier scenarios; the actual dump/two-restore drill now uses genuine QA API and preserves metadata/audit while repairing only disposable projections.

Local: all 219 server tests and all 612 frontend tests passed, including the conflicting-ACK regression. Exact hosted links must be recorded after publication. Typechecks and frontend/server/debug-harness builds pass. Current native preparation/finish adds actual Chief release, operator malicious QA POST rejection and PostgreSQL independent audit/stock checks; implementation is not native verification until that exact commit runs.

Prior S2b is VERIFIED IN CI ON SHA `ddbb5d32435b6758792e22fea53cda0a7e2996de`: [tests](https://github.com/LHONE-mf/production_mf/actions/runs/43588743135), [web/server/browser/restore](https://github.com/LHONE-mf/production_mf/actions/runs/43588743122), [Android Chief creation/edit and operator Storage](https://github.com/LHONE-mf/production_mf/actions/runs/43588788153), [artifact](https://github.com/LHONE-mf/production_mf/actions/runs/43588788153/artifacts/14112011100). S3 is not covered by those older runs.

Rollback: revert application/UI first and retain additive QA schema, immutable events and frozen requests/ACKs. Do not drop dates/dispositions, reset IndexedDB, reapply historical migrations to a populated DB, or reinterpret QA as physical movement. Remaining S4–S10 are open; next concrete contract is reservation/request -> Chief/Manager approval -> dispatch -> authenticated recipient receipt with exact issue provenance, concurrency/idempotency and no inferred consumption.
