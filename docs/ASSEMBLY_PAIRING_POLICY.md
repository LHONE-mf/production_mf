# Cathode/anode pairing — required manufacturing decisions

Reviewed 2026-11-12. No physical pairing policy is approved by the current code
or specification. Do not infer it from electrode names, material names, coating
names, dimensions or the separate declared cell-output count.

## Existing engineering boundary

- `src/core/manufacturing/assemblyIntake.ts` freezes one complete sorting result
  and its specification as an intake, with an explicit counted electrode input.
  `assemblyIntakeValidation.ts` intentionally leaves cell format unassigned and
  rejects an assumed electrodes-per-cell conversion. The existing `electrodeType`
  is a descriptive shape/type string, not a validated cathode/anode identity.
- Assembly station observations preserve separately entered input/output/scrap
  quantities and units. A separately attributed cell-output declaration records
  counted output. Neither proves physical pairing or reconciled consumption.
- `apps/server/src/batch-genealogy-routes.ts` already provides authenticated,
  chief-only, organization/order-scoped, append-only provenance links. `assembly`
  links require a completed cathode/anode source and an available cell target;
  route/status, request identity and graph cycles are checked. Two independently
  recorded links are not an approved atomic physical pairing. Source and target
  quantities/units remain declarations, not inferred conversion or stock moves.

## Decisions needed before implementing physical pairing

1. Which approved, versioned manufacturing specification supplies explicit
   cathode/anode identity from source through sorting and assembly? Which actual
   source types apply to each format (plates, strips, lithium-electrode station,
   wound blocks), and how are older ambiguous sources reviewed?
2. For each format, may one pairing select multiple lots per polarity? Are partial
   allocations permitted, or only complete accepted sources? How are remaining
   source identities retained when quantities are split?
3. Which counts/units must an operator actually enter for each polarity and for
   accepted sets/blocks/cells? Which specification and recorded observation, if
   any, permits comparison between those units? No fixed conversion is assumed.
4. Which workshop role may declare/accept a pairing, at which station/route step,
   and under which version/quality hold? What correction event is permitted
   after a mistake without replacing the original declaration?
5. Which source claims must be exclusive locally and on the server, and what
   should happen when offline devices claim the same source concurrently?
   Server rejection must preserve both the original observation and the conflict.

The next pairing implementation should first add explicit, sourced polarity and
an approved pairing contract; then an atomic declaration of the selected source
IDs, versions, counts/units, specification, actor/time and evidence. Idempotent
retry, duplicate claims, branch/order/organization validation and immutable
correction history must be tested before changing cell-output eligibility.
M2 workshop pilot, M3 authoritative operation integration and M4 inventory/QA
acceptance remain open. This document is a design question, not approval of a
manufacturing rule.
