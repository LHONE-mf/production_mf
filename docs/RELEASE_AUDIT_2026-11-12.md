# Release audit follow-up — 2026-11-12

Scope: limited offline engineering candidate on `feat/hybrid-server-foundation`;
PR #3 remains draft. No factory, inventory/QA or multi-device acceptance.

## Slurry continuation: recipe replacement and pending saves

Recipe selection previously installed a fresh empty form over the current draft
without a replacement check. New tests reproduced silent loss of raw weights/basis on selection,
replacement while a production write was pending, and
loss of uncheckpointed in-memory values after a draft persistence failure.

An empty form still accepts a recipe directly. A nonempty draft now requires
native confirmation before replacement. Cancellation leaves the raw form and
stored checkpoint unchanged. Production save/check and known checkpoint errors
block selection; finish or repair that operation and explicitly select again.
The original pending save retains its frozen recipe, weights and ID. No
manufacturing record or source catalog is changed by accepting a new draft.

Local 512 frontend tests / 75 files, typecheck/build and phone/desktop Chromium
passed. Browser evidence includes real checkpoint failure/retry, native
confirmation Cancel/accept, draft reopening and a subsequent offline save of the
chosen new source. A controlled paused-save regression proves the original
batch/journal commits once without its draft being replaced. No physical
OnePlus/Capacitor dialog or installed-upgrade acceptance is inferred. Exact
commit/CI/APK evidence is recorded on draft PR #3 after push.

## Phone follow-up: slurry save error

A provided recipe and all actual weights can still trigger the old all-in-one
error when `measurementNote` is blank. The screenshot's basis field is blank;
this does not establish which other values were entered above the visible area.
A reproducing test with otherwise valid recipe/material/author/time data isolates
the misleading message. Required batch code/name/basis fields now receive
specific errors and focus; required labels and source-reference help make the
existing contract visible. The supplied plan, source versions and weights stay
in the draft. A source reference can point to information already provided;
actual measurements/evidence are never generated to bypass validation.

Local 509 frontend tests, typecheck/build and phone/desktop Chromium passed the
correction, saved-draft reopening and subsequent offline manual/recipe saves.
Unmeasured density, viscosity and fineness remain optional/unknown. All existing
atomic saves, exact retries, source/actor checks and legacy records remain
unchanged. This is browser evidence, not physical Android acceptance. Exact
commit/workflow/APK details are recorded on draft PR #3 after push.

## Confirmed versus unverified at the audit head

- Confirmed: at audit start remote HEAD was `141cfd87f317b3ccbba8e39f3e401ebc74fd8030`;
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

## P1 truthful live KPI and reports

The chain-yield card is now unavailable until a verified matching lot genealogy
exists. It never divides independent assembly/formation totals. Stage quantities
remain separate **declared local observations**, not accepted stock or QA output.
Removed QA-sounding per-stage yield percentages as well; counts remain visible.

One numeric subtotal helper distinguishes no valid observation (`—`), an explicit
recorded zero (`0`), and known values alongside unknowns (`N + ?`). Blank strings,
null, missing/invalid values and unsafe counts are not coerced into zero. Partial
cards show known/missing counts. Invalid totals fail unavailable rather than
showing overflow. Legacy fields remain readable as declared values and are never
rewritten. New assembly intake/station records without a separate cell-output
declaration contribute unknown output, not their placeholder historical counters;
station scrap units are not converted into cell scrap.

KPI observes Dexie while open. Rolling windows exclude invalid/future dates with
a visible count, use the cell-output declaration time for assembly, and use
record creation time for other observations. A just-saved record uses the fresh
read time rather than the dashboard's old mount time. Focus/minute/lease-expiry
checks re-evaluate dates and the existing protected `listVisibleTasks` view.
Reports show the same unknown/partial rules for all-time saved formation fields;
its wording no longer claims those entries are completed processes. Worker
quantities stay in separate units, sorted by name; the old invented cells×50
ranking is removed. No lot matching, conversion, physical yield or stock is inferred.

Evidence: five UI regressions reproduced unrelated-lot yield, false zero, stale
open-screen values, wrong output date windows and report coercion; an additional
regression caught just-saved records being excluded by a stale clock snapshot.
**506 frontend tests / 74 files**, typecheck and PWA build passed. Chromium
390×844 / 1365×900 passed missing values, independent unrelated lots, unavailable
yield, immediate open-screen insertion, partial legacy totals, reports and
offline navigation without overflow/runtime errors. Screens inspected at phone
width. No data migration, seeded app records or physical acceptance implied.

### Final quantity-label correction

Final review traced `MixBatch.batchKg` to the planned dry-solids target (the
slurry journal already distinguishes this from actual weighed mass). KPI no
longer labels that target as prepared paste: the card says **Цель сухой массы**
and explicitly marks it as a plan. Coverage is **Покрытие A+B**, retaining its
separate coverage-versus-roll-length explanation. These two totals no longer
round small recorded quantities to displayed zero: e.g. `0.025 kg` target and
`0.125 m` coverage remain visible. No measured paste mass or material balance is
inferred from the target. The regression failed before correction; final local
**507 frontend tests / 74 files**, typecheck/build and phone/desktop Chromium
passed. Source observations remain unchanged.

## Recovery delivery assessment

The existing export uses Web Share files when `navigator.canShare` supports them,
otherwise a Blob/download anchor. The read-only checker uses a file input and
`File.text()`. Browser file download, picker/check and separate empty-profile
restore were exercised with isolated TEST data. The UI reports a prepared file
and asks the operator to verify durable external saving; a successful API call
is not evidence that a file is recoverable outside the app. Actual Capacitor
WebView share availability, Blob delivery, Android picker and installed upgrade/
force-stop remain **not performed** here. There is no native-device/emulator
access in this executor. This gap is a release blocker, not proof of data loss
or a reason to clear a data-bearing app. Follow the phone procedure below.

## Exact pushed-commit evidence

| Commit | GitHub checks | APK artifact |
| --- | --- | --- |
| `60ac88f046cca2a426dc06584bf943e0c39f4a74` | [web/server CI](https://github.com/LHONE-mf/production_mf/actions/runs/43205196446) and [tests](https://github.com/LHONE-mf/production_mf/actions/runs/43205196435) succeeded | [APK run](https://github.com/LHONE-mf/production_mf/actions/runs/43205188594), artifact `13937746221`, `app-release-signed`, exists and is unexpired |
| `ef604db21030f4d1c6f9b13f97251bb07ae488bb` | [PR web/server CI](https://github.com/LHONE-mf/production_mf/actions/runs/43208335261), [push CI](https://github.com/LHONE-mf/production_mf/actions/runs/43208327176) and [tests](https://github.com/LHONE-mf/production_mf/actions/runs/43208335235) succeeded | [APK run](https://github.com/LHONE-mf/production_mf/actions/runs/43208327091), artifact `13940871721`, exists/unexpired; source SHA, APK digest and public-development signature provenance verified |
| `3eff4e021ec43741194dbd44af0d86ff5d45ec89` | [PR web/server CI](https://github.com/LHONE-mf/production_mf/actions/runs/43209867248), [push CI](https://github.com/LHONE-mf/production_mf/actions/runs/43209857320) and [tests](https://github.com/LHONE-mf/production_mf/actions/runs/43209867147) succeeded | [APK run](https://github.com/LHONE-mf/production_mf/actions/runs/43209857313), artifact `13939743979`, exists/unexpired; source SHA, APK digest and public-development signature provenance verified |

The downloaded session-fix APK archive's `release-provenance.txt` matches
`60ac88f046cca2a426dc06584bf943e0c39f4a74`,
reports `signing_mode=public-development`, and records successful v1/v2 signature
verification. Actual APK SHA-256:
`a9ce0ea48b94e41316301826b027dff5a8a585df13b7119863e016c86f32df18`;
certificate SHA-256:
`637331c73bee1ac9f07444a207b9cfd5d8bd9535641e24ad3471082c9d62f51b`.
This public development key provides no production distribution trust.
The CI-recovery APK digest at `ef604db` is
`d34fb4499cda1a654289283f1b197431cb9327c6328b2027f30fa0d67e6b92e4`;
its recorded certificate is the same public development certificate above.
The first KPI APK at `3eff4e0` has actual SHA-256
`52815e87be0c8ece0e46b29c4b4ae1bf1d1f2ad8038a1f1f451a83e9d6c05ad2`,
with matching source and the same public development certificate.
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
500-test suite, typecheck/build passed after correction. Follow-up `ef604db`
passed PR/push CI, standalone tests and APK checks as recorded above. The transfer
commit's
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

- P1 physical gate (next): run the [phone smoke procedure](ONE_DAY_RELEASE_GATE.md),
  including an external saved file and a separate empty-install restore. Public
  development signing is unsuitable for production distribution.
- P2 / M0–M5: calibration/source evidence, approved pairing policy, physical
  workshop pilot and authoritative operations/inventory/QA. No ratios, stock
  postings or process parameters are inferred by this audit.

Exact pushed-head checks and APK provenance are recorded on draft PR #3 after
inspection. No merge, production tag/deploy, migration, signing change, dependency
upgrade, data wipe or automatic synchronization is authorized by these results.
