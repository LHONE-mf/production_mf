# Storage development status — 2026-11-14

Working branch: feat/storage-inventory-foundation. PR: https://github.com/LHONE-mf/production_mf/pull/5
Base inspected: 94be7af. The separate authoritative-inventory branch is preserved and has not been merged.

M0: reproduced the failing stock-push concurrency test and unhandled rejection locally and confirmed the same failure in CI run 43538331520. The production lock was already acquired synchronously. Fixed test sequencing with an explicit mocked-fetch entry signal, immediate rejection handler, and finally resolving/awaiting the pending operation before global fetch cleanup. Protection remains enabled; no tests skipped.

Verified locally: focused suite 8/8, frontend typecheck, full frontend suite 83 files / 566 tests passed. Existing React act warnings remain. Build and current-head CI verification pending at this checkpoint. Server typecheck/build run separately; real integration verification requires the current branch's own migration 020_storage_inventory.sql, incompatible with the previous branch's disposable schema. A fresh container attempt failed due disk space; do not reuse incompatible tables or modify production. Temporary Android/Gradle caches cleared to recover space.

Audit: server catalogues, proof-authenticated inventory receipt/read/feed and stock-operation APIs exist; separate durable receipt/stock queues and exact snapshot validation exist. StorageModule still mounts only StorageRegister (local observation journal). Real authenticated inventory UI is the next missing vertical slice. No QA release, physical issue/return, partial transfer or automatic consumption is approved.

Roadmap: finish M0 push and verify both Run Tests and CI web/server at the pushed SHA before features. M1: add authenticated Storage panel beside legacy journal, using serverConnection.ts, inventoryCatalogClient.ts, inventoryClient.ts, and scope-isolated cache; test missing/expired proof, account switches, explicit read refresh and mobile layout. M2: real catalogue receiving form, exact unit conversion, durable scoped draft and frozen receipt before manual send. M3: whole unreserved transfer and permission-gated corrections, retained conflict inspection. M4: shared sync serialization and two-session/restart/lost-ACK tests. M5: full suites, browser/Android critical path and two-device pilot checklist. M6: document owner decisions for QA/issue/returns/split/cutover/room contracts; keep those workflows gated.

Android testing today: only the existing local journal is wired; it must never be interpreted as confirmed stock. Authoritative UI and factory acceptance remain incomplete.
