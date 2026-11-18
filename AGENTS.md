# Production MF — AI Engineering Instructions

This repository is a hybrid production-management application: React/TypeScript/Vite/Capacitor Android frontend with Dexie offline storage, and a Fastify/PostgreSQL backend.

## Required engineering workflow

Use the vendored Addy Osmani skills in `.agents/skills/` when relevant:
- `incremental-implementation` for multi-file features and migration slices.
- `test-driven-development` for new behavior and bug fixes.
- `debugging-and-error-recovery` for failures and regressions.
- `security-and-hardening` for authentication, device enrollment, sync, and sensitive data.
- `api-and-interface-design` for sync contracts, versioning, and validation.
- `code-review-and-quality` before requesting a merge.

Read the applicable `SKILL.md` before making significant changes. Some upstream skills refer to additional shared checklists not included in this selective copy; consult the original upstream repository for those references.

## Project-specific safety rules

1. Preserve offline operation. Do not require a live server for existing local-only tasks.
2. Never sync demo users/tasks automatically. Existing demo identifiers may not be UUIDs.
3. Server-managed task edits MUST update the local task and sync outbox atomically; never bypass `saveServerManagedTask` with a direct `db.tasks.put`.
4. Do not silently overwrite conflicting local or server task changes. Make conflicts visible and require explicit resolution.
5. Keep server-side authorization, organization isolation, and device enrollment checks. Frontend-only permission checks are insufficient.
6. Treat incoming network data as untrusted. Validate payloads, revisions, and cursors.
7. Never store authentication secrets or device private keys in source code or plaintext application settings.
8. Do not present demo/simulated devices or placeholder progress as real production data.
9. Do not claim CI passed unless the current commit's checks actually passed.
10. Explain new programming terminology plainly in user-facing summaries.

## Verification

Frontend: `npm ci && npm run typecheck && npm test -- --reporter=default && npm run build`.
Server: from `apps/server`, `npm install && npm run typecheck && npm test -- --reporter=default && npm run build`.

## Branch and evidence policy

`main` is the current integration baseline. Start each new change on a **fresh branch from the verified latest `main` SHA**; do not use `feat/hybrid-server-foundation` as a development base (it was integrated and is now historical). Compare existing PRs and branches before reimplementing functionality. Reuse the single authoritative `inventory_*` ledger rather than introducing parallel stock systems.

Deliver one small, reviewable behavior change at a time. For **each iteration**, provide:
1. The specific defect or user-visible improvement and evidence that the old behavior was wrong/incomplete (prefer a failing regression test).
2. The changed files, commit SHA, and pull request link.
3. Test, typecheck, build and database-migration results **for that exact SHA**; label running, skipped, and unperformed checks explicitly.
4. Remaining limits and the next logically independent increment.

Keep unfinished work in draft PRs. Do not merge to `main`, deploy a backend, migrate real PostgreSQL, reset local data, or delete branches without explicit approval. A merge to `main` automatically deploys the GitHub Pages web PWA, so treat it as a release-affecting change. Browser/emulator checks do not replace real-device acceptance.

## Attribution

The vendored skill files under `.agents/skills/` come from https://github.com/addyosmani/agent-skills (MIT License). See `.agents/UPSTREAM.md`.
