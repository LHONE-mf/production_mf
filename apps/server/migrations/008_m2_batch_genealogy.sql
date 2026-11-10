-- M2 provenance foundation. These links are auditable declarations of batch
-- material relationships; they are NOT inventory movements or yield posting.
-- Existing batches and production journals are not rewritten.
BEGIN;

-- Composite references ensure that source and target belong to the same
-- organization AND the same production order, not merely to known UUIDs.
CREATE UNIQUE INDEX IF NOT EXISTS production_batches_org_order_identity
  ON production_batches(organization_id, order_id, id);

CREATE TABLE IF NOT EXISTS production_batch_links (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  source_batch_id uuid NOT NULL,
  target_batch_id uuid NOT NULL,
  link_kind text NOT NULL CHECK (link_kind IN ('assembly', 'split', 'merge', 'consumption')),
  source_quantity numeric(18,6) NOT NULL CHECK (source_quantity > 0),
  source_unit text NOT NULL CHECK (source_unit IN ('cells', 'pieces', 'kg', 'm', 'm2')),
  target_quantity numeric(18,6) NOT NULL CHECK (target_quantity > 0),
  target_unit text NOT NULL CHECK (target_unit IN ('cells', 'pieces', 'kg', 'm', 'm2')),
  actor_id uuid NOT NULL,
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  CHECK (source_batch_id <> target_batch_id),
  FOREIGN KEY (organization_id,order_id,source_batch_id)
    REFERENCES production_batches(organization_id,order_id,id),
  FOREIGN KEY (organization_id,order_id,target_batch_id)
    REFERENCES production_batches(organization_id,order_id,id),
  FOREIGN KEY (organization_id,actor_id) REFERENCES users(organization_id,id)
);
CREATE INDEX IF NOT EXISTS production_batch_links_source_idx
  ON production_batch_links(organization_id,order_id,source_batch_id,occurred_at);
CREATE INDEX IF NOT EXISTS production_batch_links_target_idx
  ON production_batch_links(organization_id,order_id,target_batch_id,occurred_at);

CREATE OR REPLACE FUNCTION block_batch_link_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production batch genealogy is append-only';
END
$$;
DROP TRIGGER IF EXISTS production_batch_links_immutable ON production_batch_links;
CREATE TRIGGER production_batch_links_immutable
BEFORE UPDATE OR DELETE ON production_batch_links
FOR EACH ROW EXECUTE FUNCTION block_batch_link_rewrite();

COMMIT;
