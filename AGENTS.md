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

## Branch, review and evidence policy

`main` is the source integration baseline. The historical `feat/hybrid-server-foundation` branch is NOT a development base. Start each change from the verified latest `main` SHA on a fresh branch. Check existing PRs and the current code before reimplementing a feature; never remerge old stacked PRs or replay their database migrations. Reuse the authoritative `inventory_*` records, not a second warehouse ledger.

For each change, identify the behavior and affected files, record the exact commit and PR, and distinguish passing, failed, running and unperformed checks on that exact commit. Keep failures as merge blockers. Use unit, integration, disposable PostgreSQL, browser and Android installed-upgrade checks as relevant; browser CI is not equivalent to physical multi-device acceptance.

Only merge after explicit user approval and successful required CI. Merging source into `main` is NOT permission to release: `.github/workflows/deploy-web.yml` publishes PWA by manual `workflow_dispatch` only. Never deploy the production server, migrate the factory database, install APKs, or change release-signing identity without separate authorization and verification.

Protect existing offline journals, drafts, pending outboxes, attachments, local users and confirmed manufacturing history. Never uninstall or clear an Android app containing user data for testing. Use a disposable test database and emulator; require backup/restore and signature-compatible installed-upgrade evidence before replacing a data-bearing APK.

## Attribution

The vendored skill files under `.agents/skills/` come from https://github.com/addyosmani/agent-skills (MIT License). See `.agents/UPSTREAM.md`.
