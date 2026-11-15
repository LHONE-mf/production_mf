# Anytime physical counts and approved corrections (S7)

Any current warehouse Operator, explicit Manager or Chief may start a count at any time and record/recount a package, including quarantine/held stock and a zero physical quantity. Starting, observing and closing **never change stock**. A count records the original verified stock snapshot/version, exact base-unit physical quantity, accountable actor/device, session, timestamp and reason/witness. Observations may arrive after their original revision becomes stale; they remain historical evidence, not a live balance.

Chief or explicit Warehouse Manager separately reviews one observation and confirms its correction. The current stock must still equal the original counted snapshot/version; changed stock requires a new physical observation/reconciliation. A correction cannot undercut an owned reservation, fabricate QA release or alter material/lot/location/dates. Its immutable `count_adjustment` in the existing stock ledger records the absolute movement and before/after snapshots. Count alone, journal completion, cached balances and generic production Master confer no correction authority. No-discrepancy observations need no stock event.

Migration **029** adds one append-only `inventory_count_events` evidence stream (`open`, `observe`, `correct`, `close`), not another balance. Deferred DB guards require each correction to pair exactly with its stock event. A session closes once; observations stop after closure, while explicitly reconciled corrections may follow closure if the counted version remains current. Creator/current Manager/Chief may close; evidence and prior observations are never overwritten. Count IDs, observation/correction IDs, current authority, proof, tenant scope and original history are enforced under the existing inventory lock. Original exact retries replay the same ACK; changed/colliding IDs or duplicate correction conflict. Existing receiving/issue/return/split identities share the immutable namespace.

## Routes and screen

- `POST /inventory/counts/operations` requires original `x-inventory-epoch` and fresh proof. Common fields: `operationId,countId,deviceId,kind,reason,evidence`.
- `kind=open` creates a session; `kind=close` closes it without stock movement.
- `kind=observe` adds `stock` (the exact historical confirmed snapshot) and `quantity` (zero or safe positive base units). The historical stock ledger must verify its snapshot.
- `kind=correct` adds `observationId,expectedRevision`. Target quantity comes from that immutable observation, never another free-form correction quantity.
- `GET /inventory/counts?deviceId&after&limit` and `GET /inventory/counts/:countId/events?deviceId&after&limit` are proofed, warehouse-only, tenant scoped and paginated. They expose session state, original count/current correction evidence and discrepancies without promoting local proposals.

`InventoryCounts` provides explicit session creation/send, session selection/history, offline observation freezing, recounts, original-version visibility, Manager/Chief correction preparation and separate physical confirmation/send, closure and retained original request/reply inspection. Typed fields persist in the original-profile `count-form` namespace. Selecting a package freezes its version; refresh does not silently replace it. Explicitly choose the current version for a new observation. Stale-history forms require a separately confirmed new draft; saved requests/ACKs remain retained. The history displays recorded and physical quantities, variance and stale-version warnings. Broader reporting/export is S8.

InventoryOutbox stays **v7**. Frozen actions use its existing scoped `count` draft namespace and stable operation IDs. Offline observations do not change confirmed cache. Unknown/conflicting/old-history proposals remain inspectable, without background send/rebase/rebind. Only an exact validated correction ACK may atomically change stock, retain its acknowledgement and accept its proposal. Non-stock action ACKs retain evidence without inventing a stock update. Network extras/secrets are not saved. Existing queues, archives, task DB and observational journals are preserved.

## Verification and rollout

Real PostgreSQL tests cover arbitrary-time Operator opening, zero/recounts, no stock movement from observations, explicit manager correction, exact retry, stale and reserved stock, competing approvals, generic Master/current-grant denial, tenant/history boundaries, closure, immutable/deferred pairing and cross-endpoint ID ownership. Client tests cover offline/reopen/lost ACK, exact counted snapshots, no optimistic balance, atomic correction ACK and history/conflict retention. The real two-profile browser loses both observation/correction ACKs and verifies one physical adjustment plus closure. The native harness is extended with these controls and independent ledger assertions; S7 exact SHA 4b31065 passed Route A 43625766702 with both actual Storage instrumentations and independent PostgreSQL verification.

Populated upgrades preserve prior stock/reservations/events and create no fabricated counts. Actual dump/two restores compare **42 tables** and reconstruct **14 stock events, four stocks, one reservation, one issue, five handoff events, two outcomes, one split and four count events**. Original correction retry after restore leaves every table unchanged. Application rollback must retain the new stock kind and evidence table; never erase count history or generate a fictitious compensation. Engineering evidence does not certify physical counting procedures, signed factory devices, deployed TLS or production restoration.

## Complete frozen count-history export (S8, 2026-11-15)

After explicitly loading a selected session's history, “Скачать полный срез
пересчёта CSV” downloads every accepted event in that snapshot, including open,
zero/recount/unapproved observations, separately approved corrections and closure
if already recorded. It restarts at the beginning rather than exporting only the
visible page. Each row contains the history ID, immutable upper count sequence,
closed-as-of-snapshot flag, original event/observation/container/material/lot/
location identity, original stock/revision/quality/unit, exact recorded/reserved/
physically counted quantities, signed discrepancy and accountable actor/device/
UTC/reason/evidence. No raw request or credentials are exported. Formula escaping
also protects evidence, manufacturer lots and signed quantities.

GET `/inventory/counts/:countId/events` now accepts optional `until` and returns
`throughSequence`. First read freezes that count session's immutable sequence
head. Continuations preserve it; `closed` is computed within the same bound.
Later approval or closure does not change an existing view/download. Explicitly
reload history to select newer evidence. Future bounds, invalid ranges and wrong
scope/proof/grants fail closed under the existing inventory read lock.

The client validates each page's epoch/count/bound/order and original stock
snapshots, reauthorizes every request, and creates no partial file on error,
history/closure change, stalled cursor or more than 10,000 events. Selection is
locked during history/export work; changed history/profile/unmount cancels old
results. Loading/exporting never conducts a stock correction, rewrites an
observation or changes an offline proposal. Existing draft/ACK recovery remains
v7; no migration/dependency is added. Deploy the matching server before client;
missing snapshot metadata produces a visible error without losing local data.

Actual PostgreSQL tests freeze an unapproved observation, then separately approve
and close the session; old pages remain unapproved/open while a fresh snapshot
shows all distinct events. Real two-profile browser downloads prove the same CSV
remains byte-identical across another device approval, then an explicit refresh
includes correction and closure. The real dump/two-restores drill compares the
original frozen count history after both restores, including a new explicit epoch
under suspended posting. Native checks exercise the real frozen-history read and
export control; actual CSV downloads are verified by Chromium. Full 10,000-event
resource acceptance and physical pilot remain separate pending gates.
