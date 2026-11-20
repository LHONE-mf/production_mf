# Operator workflow correction — 20 November 2026

## Warehouse: three operator-facing sections
1. **Поступление**: server-side provisional receipt and cached offline option. New catalog choices are restricted in the Android client to raw materials, components and finished cells/batteries. An incoming control/document reference is required; lot, supplier, quantity, receiving place, manufacture/expiry dates are already modeled in the receiving request. After server receipt stock is **quarantined**, not automatically released. A manual cell receipt does not establish Formation source provenance.
2. **Расход**: controlled issue/request to a **named production batch and step** and a named recipient, then warehouse manager/Chief reserves, approves and dispatches an exact physical manufacturer lot. Dispatch records the operator-entered incoming-control number and date as a **dispatch witness**, plus the issue actor/time and confirmed issue source lot and expiry. Do not interpret dispatch or receiving as actual consumption. Existing Slurry Materials UI attributes actual saved mix weighings to exact received warehouse issue IDs; its server posting is a separate operation and does not decrement the warehouse twice.
3. **Остатки**: confirmed server snapshots (material, manufacturer lot, stockId, location, QA status, quantity, reserve and expiry). Administration, inventory counting, returns and other controls are nested under advanced details. Cached offline snapshots and their unconfirmed proposals are clearly distinguished from live server stock.

The historical local storage journal and old electrode-related records are **preserved**, not deleted. New operator-facing stock intake no longer offers electrodes and the Sorting "send to warehouse" entry was removed. Accepted/graded electrodes move onward to production via the Sorting report, not through inventory receipt. Legacy server output endpoints were not removed, to avoid damaging historical records: back-end deprecation requires a separate review.

## KD before Cutting
Local Chief/Master/Technologist may enter the exact future batch/order code, grade limits and notes without the Cutting receipt. This saves a local **unbound KD template** only. When the physical Cutting source appears on the same phone with the **same batch code and electrode shape**, the authorized user explicitly creates a **new bound copy** for that exact source ID. Original templates remain intact; inspection must use the bound copy and explicit correct source. No fake Cutting input is created. Administrative KD transfer over a common shared-key packet remains blocked.

## Phone-to-phone stage handoff
Original signed LIP packet formats are unchanged. If the sender has not set the workshop HMAC key, the outgoing modal offers a password field to set it **on that phone** and re-encode the pending packet. Receiving phone must have the same shared key in its local transfer settings. QR/text/Bluetooth share the signed representation; the key checks integrity, not identity or process authority. Both operators still explicitly verify that the physical batch matches the received record. This does not enable server-only warehouse transfers without server connection.

## Known gaps (tracked in Issue #55)
- Structure incoming control number and date across all server stock snapshots and issue/consumption proofs instead of storing them only in human-readable receipt reference/dispatch evidence.
- Source-aware finished-cell acceptance from Formation; the current manual cell receipt is quarantined and not proof of Formation origin.
- Real multi-phone/stage verification, including Android source APK signatures and offline data migration.

No remote stock ledger, production output, QA release, global synchronization, server deployment or automatic merge was performed by this PR.
