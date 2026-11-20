# Sorting — individual measured mass entries (engineering increment)

Branch: `feat/sorting-measured-mass-20261120`. Stacked on the reviewed mobile UI branch, which in turn stacks on the five approved integration tasks. No merge/deployment/data wipe.

## Operator flow

After the existing Visual and Thickness **aggregate** observations, the Mass station offers a separate, **optional** textarea for individual electrode masses in grams, one positive decimal per incoming electrode (decimal point or comma). The entered order is **station position**, not a claimed serial number or immutable electrode identity. Drafts are stored in the existing local form-draft store and survive ordinary app navigation/reopen.

The operator explicitly presses **"Рассчитать количество и сорта по массам"**. The classifier applies the *frozen* specification's mass intervals to each entered value. In grading mode it refuses a value that lands in two overlapping intervals rather than guessing the grade. Out-of-range values are counted as Mass rejects. In pass/fail mode any matching mass interval passes. The calculated pass/reject/grade totals populate the existing controls, but no station record is saved until a separate explicit save.

When individual readings are present, the immutable Mass station decision must contain exactly one positive finite reading per incoming piece (limit 10,000 per station). The canonical validator cross-checks the passed/rejected and grade totals against the readings inside the same Dexie transaction. A changed result with inconsistent totals is rejected with no partial station write. Saved readings are visible in a collapsed station summary and kept in the local final Sorting workflow. Existing summary-only records and packets remain readable and continue using the original aggregate behavior.

## Scope and release gates

This is **not** an individual three-station QA release: Visual defects and Thickness measurements are still aggregate, the station-position index does not establish a durable electrode ID, and server finished-electrode proposals currently carry **aggregate** source counts only. Individual mass readings stay in the locally frozen Sorting run and optional local packet, and are **not** silently presented as independently server-verified measurements. Large reading arrays may exceed the QR payload capacity. Source receipt, stock/QA acceptance and release remain separate operations. Do not interpret this feature as permission to merge, install over existing production data, or deploy.


## Follow-on increment — individual Thickness readings (2026-11-20)

The **Thickness** station now has a separate optional, draft-preserved list of physical electrode thickness values in **µm** (dot/comma decimal, one per incoming piece). An explicit operator action derives only pass/reject counts using the union of allowed thickness ranges across frozen KD categories; it never assigns mass grades and does not assume a missing bound is an observed measurement. If the specification has no thickness tolerances, classification refuses to guess. The canonical station validator checks every measured value against the saved pass/reject counts in the same transaction, and displays saved readings in the collapsed historical station record.

This incremental feature still does **not** establish permanent electrode IDs, serial linkage across stations, independently recorded Visual decisions for each item, measured-vs-calibration instrument proof, or server-certified QA. Legacy records and operators' summary-count workflow remain supported; no server migrations, automatic QA release, reset, stock write, merge or deployment are part of it.


## Operator-first correction — tap counters instead of per-electrode typing

Operator feedback on 20 November 2026 makes the default workflow **aggregate**, not individual-electrode data entry.

- **Visual / Thickness:** the operator enters or taps the count that passes and the count that fails. Thickness uses an analog measuring head; no automatic thickness capture is expected.
- **Mass, grading:** each approved mass grade has its own large +/- counter; two additional counters distinguish electrodes **below the lower approved mass limit** from those **above the upper approved mass limit**. Together they set the Mass rejection total. In ordinary pass/fail mode the operator can also count pass/fail instead of grading.
- Every tap changes only the local *draft*. The original numeric inputs remain for manual correction, and save is an independent explicit action that enforces conservation against the input count. Increment is disabled once the known input has been fully allocated; decrement never goes below zero.
- The under/over breakdown is optional for legacy/manual totals, and is saved atomically only when its sum equals Mass rejection count. Changing the total manually clears the draft breakdown instead of inventing a matching split. Old station records without a breakdown are still valid.
- The previous **per-electrode Mass and Thickness inputs** are moved inside a collapsed future-technology section; they are not required in the normal operation. Existing unsaved drafts and frozen readings are retained unchanged. Scale-to-phone capture may be considered later, *not* claimed as implemented. No future analog thickness integration is assumed.
- No data migration, server-side QA determination, direct stock accounting, automatic sync or packet side effect is introduced. The frozen Mass reject breakdown remains local station history; existing server finished-output proposals still use aggregate approved-grade quantities.

No new factory release authorization is implied; always verify old vs new Android signatures and preserve offline data. Changes remain in a separate draft PR.
