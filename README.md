# Production MF — Li-ion manufacturing workspace

Production MF is a work-in-progress manufacturing execution app for Li-ion
production. It uses React/TypeScript, Vite, Dexie/IndexedDB, a Capacitor Android
client and a separate Fastify/PostgreSQL backend.

**Current state:** Engineering features are under development. Web, server and
APK CI do not replace real workshop acceptance. Do not treat the app as a
validated inventory, MES, QA or equipment-control system yet.

## First start: no demo data

New installations begin with **no sample production records and no default
logins/passwords**. The app asks you to create the first *local* administrator
(name, login and a password of at least 10 characters). The password is
stored as a salted PBKDF2 hash in the device's local database.

Upgrades preserve all local records, including installations that still use
legacy demo account IDs. Those IDs cannot establish whether measurements,
attachments or pending offline changes are examples. Nothing is automatically
erased; deliberate cleanup requires the confirmed reset below.

To intentionally start over: sign out, choose **Начать заново на этом
устройстве** on the login screen, and type **УДАЛИТЬ** to confirm.
**This permanently deletes all local users, journals, recipes, material
records, tasks and unsynchronized changes on that device.** Remote PostgreSQL
records are not deleted, and each other device retains its own local copy.
The first-run setup will then appear.

The local user list is now backed by actual IndexedDB records; chiefs can
create and manage local accounts. **Local accounts are not server accounts.**


## Emergency local backup / clean-install restore (engineering candidate)

A local **chief** can select **Сотрудники → Создать резервную копию** to
prepare a read-only JSON archive of all IndexedDB tables. The Android share
sheet may appear, or the browser may offer a download. **Confirm the file
actually exists outside the app before relying on it.** The archive includes
local password hashes, employees, work and potentially sensitive records; it
is not encrypted. Do not share it publicly.

On the **first-run screen only**, choose **Восстановить локальные данные из
файла** on a separate, fully empty installation of the **same database schema
version**. The archive checksum is checked, unknown formats are rejected, and
tables restore atomically (all-or-nothing); any existing record blocks restore.
Sign in using a local password from the saved archive. To avoid reviving
device/session permissions or bypassing conflicts, restoring archives that
contain hybrid server synchronization state is deliberately refused.
Backups are neither automatic nor a substitute for live-server backups.

After saving a file, a local chief can use **Сотрудники → Проверить сохранённый файл резервной копии**
to select that file from the Android picker and verify its checksum, schema,
contents and user count without importing anything or changing local records.
A successful file check **does not** replace a real restore drill on an isolated
empty installation, establish who created the archive, or prove a backup exists
in durable external storage. An archive containing hybrid server-sync state
will be refused as unsafe to restore.

The same-device real Android file save, in-place upgrade and independent
restore drill have **not** been validated. Do not reset or uninstall an
installation containing important data merely to test restoration.
For the current limited trial release gate, see
[One-day release gate](docs/ONE_DAY_RELEASE_GATE.md).

## Running and testing

- Development: `npm ci && npm run dev`
- Type check: `npm run typecheck`
- Tests: `npm test`
- Web build: `npm run build`
- Android APK: Actions → **Build Android APK (Capacitor)** → signed artifact,
  when that workflow succeeds.

Never uninstall an APK with data that you still need until you have verified
a backup and upgrade process. Startup does not remove existing records; use only the confirmed reset
when every local record can be discarded.

## Current architecture and boundaries

- **Local rooms:** slurry, coating, calendaring, cutting, sorting, assembly,
  two electrolyte filling rooms, rolling and formation. These currently
  write operational forms to **local IndexedDB**. Several calculators and
  production form validations still need engineering review.
- **M1 task sync:** shared tasks are transferred to a server only through
  the explicit device-proven sync flow with scoped authorization. This is
  not background synchronization; the physical two-device acceptance gate
  remains open.
- **M2 planning:** server-side orders, batches, route steps, workshop transfer
  evidence, inspection records and read-only quantity comparisons require a
  configured backend and authorized **server** login. They are separate from
  legacy local room data; automatic local→server manufacturing sync is not
  implemented.
- **Inventory:** no verified real stock posting; quantity differences are
  comparisons of declarations, not proof of material loss or accepted yield.

For requirements and current acceptance gates consult
[Product Specification](docs/PRODUCT_SPECIFICATION.md),
[M1 Release Checklist](docs/M1_RELEASE_CHECKLIST.md) and
[Android Build Instructions](docs/ANDROID_BUILD.md).
The older `docs/DEVELOPMENT_PLAN.md` and
`docs/ARCHITECTURE_PRINCIPLES.md` document superseded architectures.
