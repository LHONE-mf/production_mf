# Hybrid MES: server foundation

## M2 local source/output comparison (2026-11-10)

`GET /planning/batches/:id/quantity-flow` adds `sourceComparison` per route
step while preserving existing output/handover fields. Access remains online,
chief-only and organization-scoped. The object contains `status`, `sourceCount`,
`source` (single link UUID, source record UUID, summary and named measure, or
null) and `difference` (exact output-minus-reference decimal, or null).

Only `calendered_length_m` → `m`, `cut_good_pieces` → `pieces` and
`assembled_cells_out` → `cells` are output-compatible. With exactly one measured
reference and completion output in that unit, `status` is `compared` and
PostgreSQL NUMERIC computes the difference. Dry-solids mass, side-A coating
length and incoming sorting counts remain `reference_only`, even if units
match. Other statuses are `no_source`, `multiple_sources`, `output_missing`
and `unit_mismatch`. Generic narrative links do not count as measurements.
Multiple measured links are neither summed nor arbitrarily selected; their
records may overlap. No conversion, tolerance, pass/fail or reconciliation is
inferred. The frontend validates response structure and status consistency;
older servers show an explicit unavailable comparison message.

This compares supervisor-attested declarations. It never promotes local
records to verified production, inventory consumption, QA release or automatic
route completion. No schema or manufacturing records are changed by the read.

## Locked dependencies and validator compatibility (2026-11-10)

The independent server project now commits `package-lock.json`; use `npm ci`
for development, CI, the emulator bridge and both Docker install stages.
Frontend and server tests use Vitest 5.1.0; development/test hosts require
Node 22.12+ or Node 24 (CI uses Node 22 and Docker uses Node 22 Alpine).
The Zod runtime validator is upgraded to 4.6.7 to address oversized-collection
validation memory exhaustion (GHSA-mrhx-c7xc-m3w5). UUID fields use `z.guid()`
to retain the prior hexadecimal UUID spelling contract; this does not change
organization, actor, device or record-scope authorization. Oversized comment
arrays are rejected before expanding per-item issues, with regression coverage
for the unchanged 1,000-comment boundary and existing UUID spellings.

## M2 genealogy pagination (2026-11-10)

`GET /planning/batches/:id/links` remains chief-only and organization-scoped.
It accepts optional `limit` (1–500, default 500) and `after` (the last link UUID
from the previous page). The existing `batchId` and `links` fields are preserved;
`hasMore` and `nextAfter` explicitly expose further pages. `nextAfter` is null
on the final page. Cursors must belong to the requested batch and organization.
Ordering is by the exact PostgreSQL `(occurred_at, id)` pair; the cursor never
round-trips timestamps through JavaScript milliseconds. Invalid pagination
returns 400, unauthorized roles 403, and inaccessible batches 404. This is a
read-only view of provenance declarations, not inventory reconciliation.

The historical foundation notes below describe earlier increments; current
product and acceptance status is in `PRODUCT_SPECIFICATION.md` and
`M1_RELEASE_CHECKLIST.md`.

This branch adds a separate backend without changing the existing offline-first Android app.

## Local development

1. Copy `infra/.env.example` to `infra/.env` and set a strong unique password.
2. Start PostgreSQL: `docker compose --env-file infra/.env -f infra/docker-compose.yml up -d postgres`.
3. Apply migration: `docker compose --env-file infra/.env -f infra/docker-compose.yml exec -T postgres psql -U production_mf -d production_mf < apps/server/migrations/001_foundation.sql` (run from repository root).
4. `cd apps/server && npm ci && DATABASE_URL=postgres://production_mf:<password>@localhost:5432/production_mf npm run dev` (expose port 5432 locally if using this path), **or** start the server container with `docker compose --env-file infra/.env -f infra/docker-compose.yml up --build -d`.
5. Check `http://localhost:3001/health/live` and `/health/ready`.

The database port is intentionally not published by Compose. For migrations, use the exec command above. The application port is bound to localhost; use a properly configured TLS reverse proxy for remote access.

## Current scope and limitations

- Liveness and database readiness endpoints only. No unauthenticated business writes are exposed.
- Tables for organization, user, device identity and idempotent sync operation ledger are created, but authentication and sync API endpoints are **not implemented yet**.
- Migration is manual and should be automated in a later increment.
- Existing Dexie data is unchanged and is **not yet migrated**.
- Production deployment requires TLS, backup/restore tests, credential rotation, and monitoring.

## Next increment

Implement authenticated device enrollment and a transactional push/pull API with revision checking and cursor-based replication; then wire Dexie outbox on Android.

## Authentication increment

Apply `apps/server/migrations/002_sessions.sql` after the first migration. Run `npm run bootstrap -- 'Workshop' chief '<strong-password>'` from `apps/server` with DATABASE_URL set, on a new empty database only. Avoid putting real passwords into shell history; use an appropriately secured provisioning process before production.

Endpoints: POST `/auth/login` with organizationId, login, password; GET `/auth/me`; POST `/auth/logout`; POST `/devices` (chief only, publicKey and optional userId); POST `/devices/:id/revoke` (chief only). Bearer tokens are random, stored only as SHA-256 hashes in the database, and expire after 12 hours. Login has an in-process rate limit, not a distributed limiter.

**Not production-ready:** no refresh/offline session flow, audit logging, automated migrations, trusted device proof-of-possession, or distributed rate limiting. Device public keys are currently registration metadata only and do not authorize sync requests.

## Task synchronization prototype

Apply `apps/server/migrations/003_sync_entities.sql` after migrations 001 and 002.

- `POST /sync/push`: Bearer-authenticated chief/master only. Accepts `{operations:[{operationId,deviceId,entityType:"task",entityId,operationType:"upsert",expectedRevision:0,payload:{title,status,assigneeId?}}]}` (1–50 operations). A new entity uses expectedRevision 0; updates use the last acknowledged revision.
- `GET /sync/pull?cursor=0&limit=100`: Bearer-authenticated chief/master only. Returns ordered changes and nextCursor.
- A device must be enrolled to the current user and organization and not revoked.
- The first protocol slice intentionally rejects all non-task entity types. No arbitrary SQL or generic entity writes are exposed.
- Writes use a transaction and organization-scoped advisory lock to serialize commit order for the cursor stream. Repeated operation IDs are recognized and revision conflicts returned rather than overwritten.

**Not yet production-ready:** sync is not integrated with Android, no device private-key proof, worker-scoped sync or domain authorization on individual task assignments, and no database-backed integration tests. The sync endpoint is intentionally limited to managers until task-level access control is built. For large organizations, replace the organization-wide lock with a transactional outbox / commit-order mechanism.
