# Storage completion — execution specification (2026-11-18)

## Approved decisions
- **Partial splitting:** Released and quarantined stock may be split. Quality status MUST be inherited unchanged by the child. Blocked stock cannot be split.
- **Extra approval for quarantined splitting:** Chief or Warehouse Manager must explicitly acknowledge quarantine and approve the split in the same authenticated transaction. This is **not** a quality release: neither parent nor child becomes available for production.
- **Execution:** Chief/Manager initiates, authorizes and executes a split immediately; no operator request queue for splitting.
- **No implicit approval:** A generic manager permission alone is insufficient to acknowledge quarantine; the request must carry a specific acknowledgement, recorded in immutable provenance.
- **Preservation:** Never promote legacy local journals to confirmed stock. Never delete or rewrite existing production stock, operations, or history.

## Delivery phases and merge gates
1. **Baseline:** Verify and merge PR #25 only when both CI workflows pass. Inventory current schema, auth, migration ordering, mobile Storage screens, replication and CI. Capture existing failing tests before changing code.
2. **Splitting:** Extend pure validation and unit tests for quarantined stock + explicit acknowledgement. Introduce additive schema for split provenance, immutable parent/child audit and server-side idempotency. Add authenticated server route with Chief/Manager permission, device proof, epoch fence, writer recheck under lock, source revision, destination authorization, active location, and exact conservation. Atomically create child stock and reduce parent stock in one transaction. Retry identical operation returns original result; conflicting intent fails. Include concurrency tests.
3. **Movements:** Preserve whole-stock transfer; use split for partial moves. Track both stock identities and locations. Ensure replication emits a complete authoritative result for both parent and child; never display partial commit.
4. **Stocktake:** Operator may record count without changing stock. Chief/Manager approves discrepancy and adjustment. Preserve count, approver, reason, revision and immutable correction trail; reject stale or conflicting approvals and reserved-quantity violations.
5. **Quality, issue and return:** Chief alone releases quality. Chief/Manager approves issue to an eligible production batch; ensure exact reservation and ledger consumption. Returns must reference original issue and not exceed net issued quantity. Quarantine and blocked stock cannot be issued.
6. **Operator UI:** Android-first receiving, locations, stock details, split, transfer, count, approval, issue, return and history. Clearly label pending offline intent versus server-confirmed stock; protect data on app restart and retry.
7. **Validation:** Unit and disposable PostgreSQL integration tests; concurrent devices, duplicate retries, stale revisions, revocation, offline replay, schema upgrade, rollback and browser/Android smoke tests. Merge each increment only after required CI passes.

## Split invariants
- Positive integer quantities in the material base unit; 0 < split quantity < unreserved parent on-hand.
- For the initial implementation, splitting a stock identity with any active reservation is rejected; do not silently move a reservation.
- Parent and child share organization, material, manufacturer lot, unit, original quality, supplier/receipt metadata, manufacture/expiry dates and disposition.
- Child has a new immutable stock ID and destination location. Parent stays at its original location.
- Parent post-split on-hand + child on-hand equals original parent on-hand exactly.
- No changes to aggregate stock or production reservations.
- Record source ID, child ID, actor, device, approval acknowledgement, reason, quantities, locations, expected and resulting revisions in an immutable linked operation.
- Never interpret a signed offline request as a confirmed operation until the server commits and returns an authoritative result.
- Any missing proof, permission, acknowledgement, lock, or constraint causes full rollback.

## Testing and operational boundaries
- PostgreSQL integration tests run only against the guarded disposable CI database.
- Add new migrations; never modify historical migrations that may already be deployed.
- CI success is necessary but not sufficient for release: operator acceptance on real Android and recovery drill are separate gates.
- Feature completion must be reported accurately. A pure validator or spec is **not** a working split API.
