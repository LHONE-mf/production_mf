# Hybrid MES: server foundation

This branch adds a separate backend without changing the existing offline-first Android app.

## Local development

1. Copy `infra/.env.example` to `infra/.env` and set a strong unique password.
2. Start PostgreSQL: `docker compose --env-file infra/.env -f infra/docker-compose.yml up -d postgres`.
3. Apply migration: `docker compose --env-file infra/.env -f infra/docker-compose.yml exec -T postgres psql -U production_mf -d production_mf < apps/server/migrations/001_foundation.sql` (run from repository root).
4. `cd apps/server && npm install && DATABASE_URL=postgres://production_mf:<password>@localhost:5432/production_mf npm run dev` (expose port 5432 locally if using this path), **or** start the server container with `docker compose --env-file infra/.env -f infra/docker-compose.yml up --build -d`.
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
