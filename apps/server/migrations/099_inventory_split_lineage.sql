-- Additive split lineage foundation. No existing stock rows are modified.
-- A future authenticated split API MUST create this row and both stock changes
-- in a single transaction. This table alone does not authorize inventory splits.
BEGIN;

CREATE TABLE IF NOT EXISTS inventory_split_lineage (
  operation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  parent_stock_id uuid NOT NULL,
  child_stock_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  device_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  parent_revision_before integer NOT NULL CHECK (parent_revision_before > 0),
  parent_revision_after integer NOT NULL
    CHECK (parent_revision_after = parent_revision_before + 1),
  child_revision integer NOT NULL DEFAULT 1 CHECK (child_revision = 1),
  quality_at_split text NOT NULL CHECK (quality_at_split IN ('released','quarantine')),
  quarantine_approval boolean NOT NULL DEFAULT false,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  request_payload jsonb NOT NULL,
  result_parent jsonb NOT NULL,
  result_child jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_stock_id <> child_stock_id),
  CHECK (quality_at_split <> 'quarantine' OR quarantine_approval = true),
  UNIQUE (organization_id,child_stock_id),
  FOREIGN KEY (organization_id,parent_stock_id) REFERENCES inventory_stocks(organization_id,id),
  FOREIGN KEY (organization_id,child_stock_id) REFERENCES inventory_stocks(organization_id,id),
  FOREIGN KEY (organization_id,actor_id) REFERENCES users(organization_id,id),
  FOREIGN KEY (organization_id,device_id) REFERENCES devices(organization_id,id)
);

CREATE INDEX IF NOT EXISTS inventory_split_lineage_parent
  ON inventory_split_lineage(organization_id,parent_stock_id,created_at);

CREATE TRIGGER inventory_split_lineage_immutable
  BEFORE UPDATE OR DELETE ON inventory_split_lineage
  FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

COMMIT;
