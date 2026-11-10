-- Additive M2 bridge: a chief can explicitly reference a local generic stage
-- journal entry. The source is client-asserted, NOT server-verified measurement.
-- No local Dexie data, inventory, task outbox, or step completion is modified.
BEGIN;

CREATE TABLE IF NOT EXISTS production_local_journal_links (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  route_id uuid NOT NULL,
  route_version integer NOT NULL,
  step_number integer NOT NULL CHECK (step_number > 0),
  workshop_id text NOT NULL,
  source_stage text NOT NULL,
  source_entry_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2000),
  defects text CHECK (defects IS NULL OR length(trim(defects)) BETWEEN 1 AND 2000),
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,source_entry_id),
  FOREIGN KEY (organization_id,order_id,batch_id)
    REFERENCES production_batches(organization_id,order_id,id),
  FOREIGN KEY (organization_id,order_id,route_id,route_version)
    REFERENCES production_orders(organization_id,id,route_id,route_version),
  FOREIGN KEY (organization_id,route_id,route_version,step_number,workshop_id)
    REFERENCES process_route_steps(organization_id,route_id,route_version,step_number,workshop_id),
  FOREIGN KEY (organization_id,linked_by) REFERENCES users(organization_id,id)
);

CREATE INDEX IF NOT EXISTS production_local_journal_links_batch_idx
  ON production_local_journal_links(organization_id,batch_id,step_number,linked_at);

CREATE OR REPLACE FUNCTION forbid_local_journal_link_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'local journal links are append-only';
END
$$;
DROP TRIGGER IF EXISTS local_journal_links_immutable ON production_local_journal_links;
CREATE TRIGGER local_journal_links_immutable
  BEFORE UPDATE OR DELETE ON production_local_journal_links
  FOR EACH ROW EXECUTE FUNCTION forbid_local_journal_link_rewrite();

COMMIT;
