# Production MF — Chat Handoff (2026-11-08)

> **Start here in a new ChatGPT conversation.** This is a continuity document, not evidence that unfinished features work. Inspect repository HEAD and GitHub Actions before editing.

## Repository and working rules

- GitHub repository: https://github.com/LHONE-mf/production_mf
- Active development branch: `feat/hybrid-server-foundation`. **Do not work on default branch without explicit instruction.**
- Another repository, `LHONE-mf/kanban-android`, is separate. Never mix changes.
- The user often says **"Go"**, meaning **make the next concrete, scoped code change**, commit it to the branch, check CI, and report facts. Avoid substituting more plans or docs for requested implementation.
- Use the GitHub connector to fetch actual files, update/create files, inspect Actions and job logs. Never claim tests passed, APK built, or a feature works unless verified.
- Keep `docs/PROGRESS.md` updated for meaningful milestones, but avoid unnecessary commits that repeatedly cancel CI.
- Prefer small secure changes with tests; don't wipe existing local manufacturing data or alter the Android application ID/signing without explicit authorization.

## Product context

Production MF is a lithium-ion battery manufacturing management app. Current stack: React/TypeScript, Capacitor Android, Dexie/IndexedDB for offline data, Fastify + PostgreSQL backend for authoritative multi-device synchronization. Chosen **Architecture B: hybrid offline-first + server**. Roles: worker, technologist, master, chief. The product covers tasks, manufacturing orders and batches, stage journals/operation runs, quality, inventory, equipment, reporting.

**Canonical product/architecture documents**:
- `docs/PRODUCT_SPECIFICATION.md` — product, roles, screen map, database model, prioritized M0–M5 backlog.
- `docs/ARCHITECTURE_PRINCIPLES.md` and `docs/DEVELOPMENT_PLAN.md` are marked historical/superseded; don't use them as the source of truth.
- `docs/M1_TASK_SYNC_AUDIT.md` — initial sync findings and regression requirements.
- `docs/PROGRESS.md` — chronological implementation record.

## Current milestone: M1 task synchronization

Goal: trustworthy two-device task synchronization, including offline edits, conflict handling and authorization, without losing data.

**Implemented so far**
1. Atomic task/outbox persistence via `src/core/sync/atomicTasks.ts`; atomic acknowledgment and pull cursor in `src/core/sync/atomicClient.ts`; Dexie schema v16 in `src/core/db/index.ts`.
2. `src/core/sync/atomicTasks.test.ts`: tests for atomic write, prevention of second pending edit, and invalid device ID.
3. `apps/server/src/task-authorization.ts` and `apps/server/src/sync-routes.ts`: reject spoofed task creator on creation, immutable creator/createdAt on update, forged new comment authors, mutation/deletion of existing comments, duplicate comment IDs, mutation/deletion of existing attachments, duplicate attachment IDs. Unit tests in `apps/server/src/task-authorization.test.ts`.
4. Authenticated `GET /devices/mine` in `apps/server/src/auth-routes.ts`, scoped by authenticated organization and user and excluding revoked devices; tests in `apps/server/src/auth-routes.test.ts`. `src/modules/sync/SyncModule.tsx` displays registered IDs.
5. `apps/server/src/device-proof.ts`: **verification primitive only** for domain-separated Ed25519 signatures over a 32-byte base64url challenge; tests in `apps/server/src/device-proof.test.ts`. It is NOT wired into enrollment, server-issued challenges, sessions, or sync authorization.

**Explicitly NOT implemented / not proven**
- No server-issued single-use challenge with TTL and replay prevention.
- No verified proof-of-possession session or binding to a specific authenticated device.
- No secure persistent client private-key handling, automatic enrolled-device identity, or authenticated offline task-edit UI.
- `src/modules/tasks/TasksModule.tsx` intentionally disables edits to server-managed tasks; local-only tasks remain editable. Do not enable edits by generating arbitrary device IDs.
- Existing `src/core/sync/hybridClient.ts` + `src/core/sync/hybridOutbox.ts` is a separate legacy sync path, distinct from the atomic Dexie path; audit imports and migrate safely before removal.
- Server currently allows chief/master broad organization-level task access, without workshop/team scoping. Workers cannot pull all tasks. Role authorization needs further design.
- Conflict resolution is read-only comparison, not a working merge/retry UI.
- The current `/devices` endpoint allows a chief to submit a public key; no cryptographic possession proof occurs at enrollment.
- No end-to-end two-device validation yet.

## Immediate next implementation task

**Build secure challenge-response device proof with PostgreSQL persistence**, rather than another standalone helper or generic roadmap.

Recommended safe incremental sequence:
1. Check current branch HEAD and CI status. Read `apps/server/migrations`, `apps/server/src/auth-routes.ts`, `apps/server/src/auth.ts`, `apps/server/src/device-proof.ts`, and existing tests. Respect existing migration numbering.
2. Add a migration for a single-use, expiring device challenge record tied to organization, user, device and (ideally) authenticated session. Generate challenge server-side with `randomBytes(32)`. Avoid exposing private keys.
3. Add authenticated challenge issuance and proof submission endpoints. On proof submission, verify Ed25519 against the **enrolled device's** stored public key and consume the challenge **atomically** so replay and concurrent reuse fail. Enforce expiry, revoked-device checks, authenticated actor and tenant scoping, input bounds, and rate limits. Consider storing only a challenge hash, not the raw nonce. Return a bounded proof grant bound to actor/device/session, not merely a boolean.
4. Add negative tests for wrong actor/org/device, expired/replayed challenge, wrong key/signature, revoked device, malformed input, concurrent consumption. Use realistic database mocks or integration tests; do not claim PostgreSQL transactional behavior is proven by pure unit tests.
5. Integrate proof with sync push authorization; preserve existing idempotency/revision semantics. Client key generation/secure storage and offline task editing should be subsequent separately verified steps.
6. Inspect GitHub Actions and logs after changes, fix failures, update `docs/PROGRESS.md`.

## Important implementation details

- Server files: `apps/server/src/auth-routes.ts`, `auth.ts`, `sync-routes.ts`, `task-schema.ts`, `task-authorization.ts`, `device-proof.ts`.
- DB migration `apps/server/migrations/001_foundation.sql` creates organizations, users, devices (public_key, revoked_at), sync_operations; inspect all later migrations.
- Server tests use **Vitest** (`apps/server/package.json`).
- Server auth `authenticate(pool, authorization)` returns principal `{id, organization_id, role}`; tokens currently live in `sessions` table.
- Sync push checks device `id`, `organization_id`, `user_id`, `revoked_at` but **does not verify possession**.
- `src/core/sync/tenantGuard.ts` binds local installation to one server/organization and rejects ambiguous legacy data.
- `src/core/sync/taskDto.ts` encodes task payloads; local demo IDs may not be UUIDs.
- `src/core/sync/atomicTasks.ts` rejects a second outstanding edit per task; this needs a safe offline multiple-edit policy before general UI enablement.
- Stage IDs include two electrolyte locations (`electrolyte`, `electrolyte-705`), not necessarily sequential process steps.

## Recent commits (chronological)

- `03382fb` M1 task sync audit.
- `370b42f`, `417dbb1`, `c5ba961`: creator policy, server integration, tests.
- `2ea068a`: progress record, CI/tests/APK passed.
- `a7db497`: atomic offline task tests; `18d94b6` progress record, CI/tests passed.
- `8989388`, `e0014f4`, `e5484a8`: comment integrity and tests; CI/tests/APK passed.
- `6cbde15`, `f47b691`, `3430835`: authenticated device discovery, tests, UI; `c3b1664` progress record.
- `5ac99e6`, `0352ceb`, `4f80684`: attachment integrity and tests; `1766aad` progress record.
- `79ad421`, `bfe6720`: Ed25519 proof primitive and tests; `62034ab` progress record.

**Last CI check:** on commit `62034ab`, `Run Tests` and one `CI — web and server` run passed; Android APK was in progress and another CI run pending. Check again; this snapshot may be stale.

## Instructions to the next assistant

Read this handoff, canonical product specification, M1 audit, and latest progress. Verify branch and CI. Continue with **actual server-side single-use device challenge implementation and tests**, then report commits and verified results. Preserve security boundaries and don't claim the whole device enrollment/offline workflow works until it truly does. When the user says "Go", proceed without asking to repeat already documented decisions.
