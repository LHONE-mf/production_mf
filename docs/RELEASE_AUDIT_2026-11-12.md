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

## P0/P1 legacy transfer boundary correction

A valid shared HMAC no longer grants account, catalog, process-parameter or
forced-write authority. All `user`, `forced-push`, forced-flag, standalone
component/recipe/sorting-spec and roll-spec-with-calender-parameters packets are
rejected on both import and export with an explicit explanation. Their old
shape-dispatch/account replacement branches were removed. Local authorized
editors remain available; existing signed archives still decode for a readable
blocked-state response. A roll-only handover can insert or acknowledge an exact
snapshot, but cannot replace an existing different specification.

Ordinary typed, nonforced manufacturing observations retain source/history,
idempotency and transactional guards. Declared actors/roles remain **unverified
attribution**, not proven technologist/supervisor identity, QA approval, stock or
server authority. This limited offline channel has no separately verified
individual entitlement. Server-owned and queued tasks still require protected
server synchronization; the task/revision/outbox check and local write remain
in one transaction. Ordinary local tasks/results remain available.

Task/result imports validate known statuses, priority, IDs, essential text,
arrays, nested comment/attachment fields and finite dates before writing. Dates
from signed JSON are normalized only after signature verification. Unknown
existing update timestamps block replacement rather than becoming zero.
The unchanged LIP/LIPM format now limits decoded JSON to 1 MiB, encoded payload
to 1.5M characters, parts to 2048 characters, frame count to 1200, incomplete
assemblies to 16 / 3M characters and age to five minutes. Expiry runs on every
frame. Invalid indices/totals, conflicting duplicate frames and mismatched
assembly totals are rejected; old assemblies are evicted at capacity.

Evidence: regression tests first reproduced real signed account/forced
replacement, malformed task writes and permissive decoding. The correction
retains positive nonforced storage/coating/walzing/task observations and negative
source-stripping tests. New tests cover master/chief spoofing with actual HMAC,
no account/password/task overwrite, Unicode/out-of-order QR, malformed payloads,
size/count limits, conflicting frames, expiry, flooding and aggregate memory.
Frontend typecheck, **500 tests / 72 files** and PWA build passed. Native BLE,
camera and actual WebView behavior still require physical acceptance.

## Exact pushed-commit evidence

| Commit | GitHub checks | APK artifact |
| --- | --- | --- |
| `60ac88f046cca2a426dc06584bf943e0c39f4a74` | [web/server CI](https://github.com/LHONE-mf/production_mf/actions/runs/43205196446) and [tests](https://github.com/LHONE-mf/production_mf/actions/runs/43205196435) succeeded | [APK run](https://github.com/LHONE-mf/production_mf/actions/runs/43205188594), artifact `13937746221`, `app-release-signed`, exists and is unexpired |

The downloaded APK archive's `release-provenance.txt` matches that source SHA,
reports `signing_mode=public-development`, and records successful v1/v2 signature
verification. Actual APK SHA-256:
`a9ce0ea48b94e41316301826b027dff5a8a585df13b7119863e016c86f32df18`;
certificate SHA-256:
`637331c73bee1ac9f07444a207b9cfd5d8bd9535641e24ad3471082c9d62f51b`.
This public development key provides no production distribution trust.
Transfer commit `277aa9bb8fe050edb6c99d9bace3f9243ec4d674` passed
[push web/server CI](https://github.com/LHONE-mf/production_mf/actions/runs/43207794448)
and [standalone tests](https://github.com/LHONE-mf/production_mf/actions/runs/43207801890),
but its [PR CI](https://github.com/LHONE-mf/production_mf/actions/runs/43207801833)
failed: the session test asserted the *second* loading phase before database
readiness/live-query delivery had completed. It saw the earlier safe database
loading screen, not protected content. Server tests passed. Work paused to fix
this timing assumption before KPI implementation. The test now waits with the
identity lookup still pending and records every protected-screen render, so it
also detects a transient flash. Runtime authorization was not relaxed. Local
500-test suite, typecheck/build passed after correction; exact follow-up SHA
checks must still be inspected. Its predecessor's
[APK run](https://github.com/LHONE-mf/production_mf/actions/runs/43207794387)
succeeded; artifact `13940626122` exists, source SHA and public-development
signature provenance verified. Actual APK SHA-256:
`5d9a3df0cdce7b0795a5b3116d0255fb8bd10f3732b61a2cda070aaadf5fb357`.
This APK does not make the failed PR CI green. Subsequent source/APK evidence is
on draft PR #3.

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
