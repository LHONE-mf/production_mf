# Release audit follow-up — 2026-11-12

Scope: limited offline engineering candidate on `feat/hybrid-server-foundation`;
PR #3 remains draft. No factory, inventory/QA or multi-device acceptance.

## Confirmed versus unverified at the audit head

- Confirmed: remote HEAD is `141cfd87f317b3ccbba8e39f3e401ebc74fd8030`;
  the older checkout was fast-forwarded, preserving the new backup/checker work.
  Exact-head [CI](https://github.com/LHONE-mf/production_mf/actions/runs/43193658555)
  and [tests](https://github.com/LHONE-mf/production_mf/actions/runs/43193658656)
  passed. The signed APK baseline is run `43193646903`; later commits require
  their own checks/artifact, not that predecessor's result.
- Confirmed in source: auth persistence copied full users/password hashes,
  permissions and authenticated flags; startup accepted the flag without current
  profile/expiry checks. Legacy shared-key transfers trust self-claimed role and
  can replace local accounts. KPI chain yield divides unrelated stage totals.
- Confirmed: archive validation/atomic empty-DB restore and read-only checking
  exist. Archives are plaintext and include password hashes. SHA-256 is an
  integrity checksum, not encryption or proof of the archive's author.
- Unverified: physical OnePlus installed update/force-stop/file-share/picker/
  restore, M1 two separately enrolled phones/TLS, factory source/equipment/QC
  acceptance. Neither adb nor an emulator executable is installed in this
  executor; actual Capacitor WebView file delivery was not exercised here.

## P0 local session correction

The cache now persists only local profile ID, role-at-login and bounded session
issue/expiry times. Legacy cache migration removes full user, hash, permissions
and token copies. Cached flags never authorize rendering. Startup rechecks the
current IndexedDB profile before showing protected screens. Expiry, disabled/
deleted profiles or changed role require fresh offline password login; the old
24-hour expiry is never extended by reload. Non-authority profile changes do
not silently grant a role. This is local device convenience state, not server
identity proof or protection from hostile same-origin/OS access.

Live profile observation, focus and expiry checks invalidate stale authority.
Invalidation clears volatile server credentials and the offline access lease,
while preserving tasks, outbox, journals and accounts. Database errors fail
closed with a retry action. Employee edit/create and backup actions recheck the
active chief in their data transactions, closing the stale-screen race. Password
hashing/verification and archive wire/restore semantics are unchanged. Low-level
backup encoding remains reusable by trusted recovery/test code; the UI export
passes the current actor and enforces chief access in the read snapshot.

Evidence: **491 frontend tests / 71 files**, typecheck/build passed. Regressions
cover historical rehydration, no stored password copy, no protected-screen flash,
expired/disabled/deleted/changed-role profiles, server-credential/lease removal,
retained pending work and denied stale-chief exports/employee edits. Chromium
390×844 and 1365×900 exercised TEST receipt, offline reload, legacy cache scrub,
role loss/fresh worker login, expiry/deactivation, actual browser file download,
read-only file selection and separate empty-browser-profile restore with the
original password. No overflow/runtime errors. Browser evidence is not native
file-share or physical installed-upgrade acceptance.

## Dependency audit — lockfiles unchanged

`npm audit --json` at this head: root **8 findings** (2 low, 6 moderate), server
**0**; no high/critical. These are package findings, not eight unique advisories.

| Packages / installed versions | Severity | Reachability evidence |
| --- | --- | --- |
| `deepmerge` 4.3.1, `@rollup/plugin-node-resolve` 16.0.3 | low | Dev/build chain, GHSA-gcqx-w48m-w2h4 prototype poisoning; not imported by app runtime. |
| `glob` 13.0.6 and 11.1.0, `minimatch` 10.2.6, `rimraf` 6.1.3, `workbox-build` 7.4.1, `vite-plugin-pwa` 2.0.0 | moderate | Dev/build chain. GHSA-3g3m-2fjr-6pw4 cancellation traversal and GHSA-g3hv-75wg-m249 glob amplification. PWA plugin is imported in `vite.config.js`; Node filesystem/build tooling is not the generated service-worker runtime. No untrusted build globs were identified; future build inputs still need review. |
| `uuid` 9.0.1 | moderate | Runtime dependency, GHSA-w5hq-g745-h8pq concerns v3/v5/v6 with supplied buffers. All application imports use v4, without buffer arguments; affected API calls were not found. This is scoped reachability evidence, not a blanket absence-of-risk claim. |

The suggested fixes include major upgrades or a PWA-plugin downgrade. No force
fix or broad version change was applied. Re-audit future lockfile changes; review
any newly reachable high/critical advisory before a candidate is distributed.

## Remaining ordered work

- P0/P1: reject unverified legacy account/forced authority, validate task/status
  input and bound QR assembly. Keep protected ordinary observations usable.
- P1: replace cross-stage aggregate yield with unavailable lineage-dependent
  yield and truthful independent observation totals; refresh while open.
- P1 physical gate: run the [phone smoke procedure](ONE_DAY_RELEASE_GATE.md),
  including an external saved file and a separate empty-install restore. Public
  development signing is unsuitable for production distribution.
- P2 / M0–M5: calibration/source evidence, approved pairing policy, physical
  workshop pilot and authoritative operations/inventory/QA. No ratios, stock
  postings or process parameters are inferred by this audit.

Exact pushed-head checks and APK provenance are recorded on draft PR #3 after
inspection. No merge, production tag/deploy, migration, signing change, dependency
upgrade, data wipe or automatic synchronization is authorized by these results.
