# M1 hybrid task synchronization — engineering verification and pilot gate

Checkpoint: 2026-11-10. Working branch: `feat/hybrid-server-foundation`.

This document distinguishes a CI-tested engineering slice from a physically
validated manufacturing deployment. **Do not enable background sync, apply
migrations to production PostgreSQL, or call M1 production-ready yet.**

## Verified engineering capabilities

- Chief/master: enroll distinct Android Ed25519 public keys for specific server
  users, perform a challenge-signature proof, manually push/pull tasks.
- Worker: see current assigned task snapshots and upload only valid progress
  statuses; server verifies current assignment, workshop membership and device
  scope. Real PostgreSQL tests exercise a worker, master, chief and their
  separately enrolled devices, idempotency, and device revocation.
- Offline tasks: explicit shared creation/assignment (server UUIDs), edits before
  initial upload, sequential edits, crash/restart persistence, immutable
  queued operations, revision-checked acknowledgements, and non-destructive
  conflict/rejection recovery.
- Pull: every task checkpoint and durable deferred inbox are transacted together.
  An unrelated task can sync despite an outstanding edit on another task.
  Old server updates are replayed after a conflict is explicitly archived.
- UI: navigation retains login/proof only in volatile application RAM, without
  storing bearer tokens/private keys on disk. Verified short-lived network proof
  (5 minutes) is separate from an explicitly server-provisioned shift-long
  offline edit permission (maximum 8 hours). The local demo identity cannot
  view previously synchronized tasks without a valid grant.
- Migration: v18 offline grant and v19 deferred inbox stores are additive; a
  focused fake-IndexedDB test upgrades a representative v17 manufacturing
  database while retaining task, journal, cursor, outbox and conflict archive.

### Evidence

- Targeted Android emulator smoke run (passed): [42776980369](https://github.com/LHONE-mf/production_mf/actions/runs/42776980369).
  Exercises AndroidKeyStore and Capacitor proof, Fastify/PostgreSQL challenge,
  launcher, and WebView conflict-archive restart behavior on its pinned commit.
- Combined frontend/PostgreSQL CI and Run Tests: use the latest successful
  run on the feature branch before distributing an APK.
- Signed development APK: use the latest successful **Build Android APK
  (Capacitor)** action for the target commit. A development-key APK is **not**
  a production release.
- Android emulator workflows returned to manual-only after the targeted run.

## Known boundaries / blockers

1. **Two physical devices and deployed TLS server**: verify separately enrolled
   Android clients under distinct real users, including offline simultaneous
   edits, success/conflict, explicit archive, restart, revoke and reconnect.
   Emulator and PostgreSQL simulations do not substitute for this acceptance.
2. **Authorization after scope changes**: offline revocation cannot be immediate
   by design. Further field validation is required to ensure previously cached
   workshop/assignment records are hidden or reconciled when the server removes
   access, without losing production audit evidence.
3. **Existing actor-unbound sync data**: the new user-binding guard intentionally
   refuses to claim unknown older shared data. Provide backup and safe
   ownership migration before upgrading installations with legacy sync data.
4. **Live backend provisioning**: organizations, users, workshops, memberships,
   HTTPS deployment and audited backups are not supplied by CI test fixtures.
5. **Broader M0**: backup/restore drills, installed APK upgrade from the real
   previous signing key, and end-user navigation/recovery checks remain open.
6. **Legacy paths**: historical separate sync mechanisms should not be
   re-enabled as background tasks; the active hybrid task UI uses the
   transactional `LiIonProductionDB` outbox. Automatic sync remains disabled.

## Final pilot acceptance checklist

- [ ] Two independently enrolled phones can authenticate and see only tasks
  authorized for their server actors.
- [ ] Supervisor creates and assigns a shared task; worker receives it and
  records a permitted transition offline across app restart.
- [ ] Reconnect uploads one durable operation per edit. Exact retry creates no
  duplicate revision.
- [ ] Two offline edits to the same task produce a visible conflict; archived
  local history survives restart; unaffected tasks continue pulling.
- [ ] Revoking a worker device denies new device proof and sync reads/writes.
- [ ] Reassigning/removing workshop access cannot expose stale records on a
  reauthenticated client.
- [ ] v17→v19 application upgrade, installed signed APK upgrade and backup/
  restore preserve existing production records and local edits.
- [ ] All CI gates green for the exact APK build commit.

M1 release status remains **engineering implementation under validation**, not
a production acceptance pass. M2–M5 should not displace these M1 gates.
