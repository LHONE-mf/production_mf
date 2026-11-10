-- M2 batch lifecycle: additive audit and optional quantity fields.
-- Existing batch rows remain valid; no status or quantity is backfilled.
BEGIN;

ALTER TABLE production_batches
  ADD COLUMN IF NOT EXISTS planned_quantity numeric(18,6) CHECK (planned_quantity > 0);
ALTER TABLE production_batches
  ADD COLUMN IF NOT EXISTS quantity_unit text CHECK (
    quantity_unit IN ('cells', 'pieces', 'kg', 'm', 'm2'));
DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='production_batches'::regclass
      AND conname='production_batches_quantity_pair') THEN
    ALTER TABLE production_batches
      ADD CONSTRAINT production_batches_quantity_pair CHECK (
        (planned_quantity IS NULL) = (quantity_unit IS NULL));
  END IF;
END
$;

CREATE TABLE IF NOT EXISTS production_batch_events (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  event_number integer NOT NULL CHECK (event_number > 0),
  from_status text CHECK (from_status IN ('created', 'in_progress', 'hold', 'completed', 'scrapped')),
  to_status text NOT NULL CHECK (to_status IN ('created', 'in_progress', 'hold', 'completed', 'scrapped')),
  actor_id uuid NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, batch_id, event_number),
  FOREIGN KEY (organization_id, batch_id)
    REFERENCES production_batches(organization_id, id),
  FOREIGN KEY (organization_id, actor_id)
    REFERENCES users(organization_id, id),
  CHECK (to_status NOT IN ('hold', 'scrapped') OR length(trim(coalesce(reason, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS production_batch_events_history_idx
  ON production_batch_events(organization_id, batch_id, event_number);

CREATE OR REPLACE FUNCTION block_batch_event_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production batch event history is append-only';
END
$$;

DROP TRIGGER IF EXISTS production_batch_events_immutable ON production_batch_events;
CREATE TRIGGER production_batch_events_immutable
BEFORE UPDATE OR DELETE ON production_batch_events
FOR EACH ROW EXECUTE FUNCTION block_batch_event_rewrite();

COMMIT;
