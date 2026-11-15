-- Additive restore boundary. Do not rewrite accepted inventory history.
BEGIN;
CREATE TABLE IF NOT EXISTS inventory_streams (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 posting_enabled boolean NOT NULL DEFAULT true
);
INSERT INTO inventory_streams(organization_id) SELECT id FROM organizations ON CONFLICT DO NOTHING;
COMMIT;
