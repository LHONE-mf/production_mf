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

On upgrade, installations containing **only the six original built-in demo
accounts** are cleared automatically once, including sample material records
and pending offline task changes. Other local account installations are not
silently wiped.

To intentionally start over: sign out, choose **Начать заново на этом
устройстве** on the login screen, and type **УДАЛИТЬ** to confirm.
**This permanently deletes all local users, journals, recipes, material
records, tasks and unsynchronized changes on that device.** Remote PostgreSQL
records are not deleted, and each other device retains its own local copy.
The first-run setup will then appear.

The local user list is now backed by actual IndexedDB records; chiefs can
create and manage local accounts. **Local accounts are not server accounts.**

## Running and testing

- Development: `npm ci && npm run dev`
- Type check: `npm run typecheck`
- Tests: `npm test`
- Web build: `npm run build`
- Android APK: Actions → **Build Android APK (Capacitor)** → signed artifact,
  when that workflow succeeds.

Never uninstall an APK with data that you still need until you have verified
a backup and upgrade process. This clean-start release intentionally removes
the built-in demo installation state as described above.

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
