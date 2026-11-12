# One-day release gate — Production MF engineering candidate

Date: 2026-11-12. Target branch: `feat/hybrid-server-foundation`.
Goal: **installable, limited-scope offline trial**, not a factory-authoritative MES,
inventory, QA system, or approved commercial release. Do not merge to `main`,
tag a production release, migrate live PostgreSQL, or enable automatic sync just
to meet the one-day deadline.

## Scope freeze

In scope: clean onboarding with no hidden demo records, local accounts/tasks,
offline room data capture, explicit saved-source handovers, first-run restore,
read-only local backup export, signed APK build, upgrade and recovery check on
a real Android device.

Out of scope: approval of instrument settings, material consumption, cathode/
anode pairing, physical stock balances, QA disposition, automatic local-to-server
manufacturing sync, M1 two-device acceptance, M2–M5 rollout, or inferred yield.

## Automated gates: exact candidate commit

- [ ] Frontend typecheck, all frontend tests, web build (CI workflow + Run Tests).
- [ ] Server typecheck, PostgreSQL integration tests, server build (CI workflow).
- [ ] Signed APK workflow succeeds at the **same exact commit SHA**, artifact
  `app-release-signed` exists and downloads to a nonempty APK.
- [ ] Inspect signing provenance: the fallback repository development signing key
  is **public and unsuitable for production distribution**. For external
  release, provide and retain private signing secrets; confirm installer and
  update certificates match.
- [ ] Review `npm audit`/server dependency findings and triage any reachable
  high/critical issue. Do not auto-force dependency upgrades during this sprint.
- [ ] No unreviewed migration, background sync, secrets, or data wipe.

A green workflow is automated engineering evidence only.

## Phone acceptance gates (required before trial with valuable records)

1. **Installed upgrade / no silent deletion**: If an earlier installation holds
   data, verify the signing certificate matches before installing over it.
   Save an external backup first. Install the new APK *over* the old one.
   Do not uninstall, clear storage, or use the local reset as an upgrade step.
   If Android refuses the update, stop and investigate the signature; do not
   erase the old app to make installation succeed.
2. **Clean test installation**: On an isolated fresh profile/device, create an
   operator-selected local chief (no default password or demo work). Create a
   local worker and a task, record one labelled test material receipt, slurry
   weighing and coating observation; inspect saved journals and source versions.
   All test identifiers must be clearly marked `TEST-` and confined to the
   isolated test installation, not production records.
3. **Offline/restart**: Disconnect from all networks. Confirm room records,
   local tasks and unfinished drafts persist across room tabs, app closure and
   Android force-stop. Exact resubmit must not duplicate a saved operation;
   invalid/blank measured values must remain unknown instead of becoming zeros.
4. **Backup file actually leaves the app**: As local chief open
   **Сотрудники → Создать резервную копию**. Select the share target or download
   destination. Confirm the JSON file exists, has nonzero size and is held
   somewhere protected **outside** the application's storage. The archive is
   **not separately encrypted** and contains sensitive local user and work data.
   A generated share sheet or click is not proof of a saved file.
5. **Restore without risking original data**: On a **separate empty test
   installation** of the same schema version, use
   **Первый запуск → Восстановить локальные данные из файла**.
   Confirm login with the original local password, exact records, dates,
   draft values and attachments. A corrupted archive and a second restore over
   nonempty tables must be rejected without partial writes. The local restore
   intentionally refuses archives containing hybrid server-sync state: those
   need a separately approved migration/ownership procedure.
6. **Minimal usable UI**: Inspect portrait 390-ish px layout on the actual phone.
   Open Tasks, Storage, Slurry, Coating, Calendaring, Cutting, Sorting, Assembly,
   both Filling rooms, Walzing, and Formation; verify navigation and ordinary
   action controls are responsive. Run the source-bound route only with
   explicitly created `TEST-` input data. No measurements/inventory/
   releases can be assumed from a screen merely opening.
7. **Recovery**: Keep the previously working, identically signed APK and a
   verified external backup. If the new build regresses, record a reproducible
   bug and stop real-data entry. Downgrading Android apps is not guaranteed and
   must not be simulated by uninstalling the data-bearing installation.

## Go / no-go

- **Internal empty-data demo**: automated gates green; no real records or
  manufacturing decisions. A development-signed APK may be used for this.
- **Limited local-data trial**: automated gates green, installed upgrade, real
  OnePlus file-export and isolated restore/force-stop checks above completed.
  Freeze the candidate commit and keep the local archive.
- **Factory production or multi-phone/server release: NO-GO** until M0 physical
  upgrade/restore, M1 separately enrolled TLS two-device checks, M2 workshop
  acceptance, and M3–M5 authority/inventory/QA requirements are actually met.

Record real-device evidence (device/build, old/new APK hashes and certificate,
test accounts, saved file, restart/restore observations and defects) against the
exact commit. Neither GitHub CI nor this checklist constitutes a passed
physical acceptance test.
