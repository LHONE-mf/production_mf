# Sorting — individual measured mass entries (engineering increment)

Branch: `feat/sorting-measured-mass-20261120`. Stacked on the reviewed mobile UI branch, which in turn stacks on the five approved integration tasks. No merge/deployment/data wipe.

## Operator flow

After the existing Visual and Thickness **aggregate** observations, the Mass station offers a separate, **optional** textarea for individual electrode masses in grams, one positive decimal per incoming electrode (decimal point or comma). The entered order is **station position**, not a claimed serial number or immutable electrode identity. Drafts are stored in the existing local form-draft store and survive ordinary app navigation/reopen.

The operator explicitly presses **"Рассчитать количество и сорта по массам"**. The classifier applies the *frozen* specification's mass intervals to each entered value. In grading mode it refuses a value that lands in two overlapping intervals rather than guessing the grade. Out-of-range values are counted as Mass rejects. In pass/fail mode any matching mass interval passes. The calculated pass/reject/grade totals populate the existing controls, but no station record is saved until a separate explicit save.

When individual readings are present, the immutable Mass station decision must contain exactly one positive finite reading per incoming piece (limit 10,000 per station). The canonical validator cross-checks the passed/rejected and grade totals against the readings inside the same Dexie transaction. A changed result with inconsistent totals is rejected with no partial station write. Saved readings are visible in a collapsed station summary and kept in the local final Sorting workflow. Existing summary-only records and packets remain readable and continue using the original aggregate behavior.

## Scope and release gates

This is **not** an individual three-station QA release: Visual defects and Thickness measurements are still aggregate, the station-position index does not establish a durable electrode ID, and server finished-electrode proposals currently carry **aggregate** source counts only. Individual mass readings stay in the locally frozen Sorting run and optional local packet, and are **not** silently presented as independently server-verified measurements. Large reading arrays may exceed the QR payload capacity. Source receipt, stock/QA acceptance and release remain separate operations. Do not interpret this feature as permission to merge, install over existing production data, or deploy.
