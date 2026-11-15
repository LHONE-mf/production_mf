-- Durable, single-use Ed25519 device challenges and short-lived proof grants.
-- Additive only: preserves all existing production and sync records.
BEGIN;
CREATE TABLE IF NOT EXISTS device_challenges (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  session_token_hash text NOT NULL,
  challenge_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_challenges_lookup ON device_challenges
  (organization_id, user_id, device_id, session_token_hash, expires_at);
CREATE TABLE IF NOT EXISTS device_proof_grants (
  token_hash text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  session_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_proof_grants_scope ON device_proof_grants
  (organization_id, user_id, device_id, session_token_hash);
COMMIT;
