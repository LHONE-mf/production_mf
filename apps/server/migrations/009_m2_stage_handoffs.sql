-- M2 stage handover ledger. Server-mediated send/receipt declarations only:
-- no stock decrement, yield posting, stage journal migration or task sync.
-- Existing planning, batch and genealogy records remain unchanged.
BEGIN;

CREATE TABLE IF NOT EXISTS production_stage_handoffs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  from_step integer NOT NULL CHECK (from_step > 0),
  to_step integer NOT NULL CHECK (to_step > from_step),
  from_workshop_id text NOT NULL,
  to_workshop_id text NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  quantity_unit text NOT NULL CHECK (quantity_unit IN ('cells','pieces','kg','m','m2')),
  sent_by uuid NOT NULL,
  note text CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,batch_id,from_step),
  UNIQUE (organization_id,batch_id,to_step),
  FOREIGN KEY (organization_id,batch_id) REFERENCES production_batches(organization_id,id),
  FOREIGN KEY (organization_id,from_workshop_id) REFERENCES workshops(organization_id,id),
  FOREIGN KEY (organization_id,to_workshop_id) REFERENCES workshops(organization_id,id),
  FOREIGN KEY (organization_id,sent_by) REFERENCES users(organization_id,id)
);

CREATE TABLE IF NOT EXISTS production_stage_receipts (
  organization_id uuid NOT NULL,
  handoff_id uuid NOT NULL,
  received_by uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  PRIMARY KEY (organization_id,handoff_id),
  FOREIGN KEY (organization_id,handoff_id) REFERENCES production_stage_handoffs(organization_id,id),
  FOREIGN KEY (organization_id,received_by) REFERENCES users(organization_id,id)
);

CREATE INDEX IF NOT EXISTS production_stage_handoffs_batch_idx
  ON production_stage_handoffs(organization_id,batch_id,from_step);
CREATE INDEX IF NOT EXISTS production_stage_handoffs_destination_idx
  ON production_stage_handoffs(organization_id,to_workshop_id,sent_at);

CREATE OR REPLACE FUNCTION forbid_stage_handover_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stage handovers and receipts are append-only';
END
$$;
DROP TRIGGER IF EXISTS stage_handoff_immutable ON production_stage_handoffs;
CREATE TRIGGER stage_handoff_immutable
  BEFORE UPDATE OR DELETE ON production_stage_handoffs
  FOR EACH ROW EXECUTE FUNCTION forbid_stage_handover_rewrite();
DROP TRIGGER IF EXISTS stage_receipt_immutable ON production_stage_receipts;
CREATE TRIGGER stage_receipt_immutable
  BEFORE UPDATE OR DELETE ON production_stage_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_stage_handover_rewrite();

COMMIT;
