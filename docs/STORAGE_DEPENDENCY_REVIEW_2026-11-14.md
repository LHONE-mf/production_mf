# Dependency audit — Storage continuation, 2026-11-14

Audited the existing committed root and independent server lockfiles with npm's
native audit after locked installs. No dependency or lockfile changed.

| Installation | Critical | High | Moderate | Low |
| --- | --- | --- | --- | --- |
| Frontend/build tools | 0 | 0 | 6 | 2 |
| Fastify server | 0 | 0 | 0 | 0 |

Frontend findings and current reachability:

- `uuid`: the reported buffer-bound advisory covers v3/v5/v6 with a supplied
  output buffer. Every project import found by source search uses `v4`; the
  affected APIs/buffer path are not used. Review a supported-version upgrade
  separately with all persisted-identity/retry regressions; no UUIDs are rewritten.
- `glob`, `minimatch`, `rimraf`: findings cover cancellation/path traversal and
  pattern amplification. These transitive packages are in the build/service-worker
  toolchain, not imported into manufacturing request handlers. Current build
  patterns come from tracked configuration, not operator-entered patterns.
- `deepmerge` through `@rollup/plugin-node-resolve`: reported prototype poisoning
  concerns the build resolver's merging path. No runtime operator/network payload
  is passed into that build configuration.
- `workbox-build` and `vite-plugin-pwa` inherit the build-tool findings above.
  Retain the active-worker/offline-shell/native-harness regression when reviewing
  their upgrade; do not clear application data to work around compatibility.

These are deferred dependency-maintenance items, not proof that a package is
universally safe. Reassess by **2026-11-21**, before a production release, or when
adding externally supplied build patterns/configuration or a new uuid API use,
whichever comes first. Preview fixes and changelogs individually; no forced audit
fix, broad dependency upgrade or production deployment is authorized by this audit.

Rechecked 2026-11-15 during immutable report-detail development: same root/server
lockfiles and advisory totals, no high/critical findings and no dependency change.
The reachability notes and 2026-11-21 review deadline above remain applicable.
