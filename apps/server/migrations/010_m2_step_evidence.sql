-- M2/M3 bridge: server-issued, append-only evidence for a single documented
-- route step. This is not equipment control, inventory posting, yield accounting
-- or migration of legacy stage journals.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS production_orders_route_identity
  ON production_orders(organization_id,id,route_id,route_version);
CREATE UNIQUE INDEX IF NOT EXISTS process_route_steps_workshop_identity
  ON process_route_steps(organization_id,route_id,route_version,step_number,workshop_id);

CREATE TABLE IF NOT EXISTS production_step_evidence (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  route_id uuid NOT NULL,
  route_version integer NOT NULL,
  step_number integer NOT NULL CHECK (step_number > 0),
  workshop_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('started','completed','deviation')),
  actor_id uuid NOT NULL,
  quantity numeric(18,6) CHECK (quantity > 0),
  quantity_unit text CHECK (quantity_unit IN ('cells','pieces','kg','m','m2')),
  equipment_code text CHECK (equipment_code IS NULL OR
    (length(trim(equipment_code)) BETWEEN 1 AND 120)),
  note text CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,order_id,batch_id)
    REFERENCES production_batches(organization_id,order_id,id),
  FOREIGN KEY (organization_id,order_id,route_id,route_version)
    REFERENCES production_orders(organization_id,id,route_id,route_version),
  FOREIGN KEY (organization_id,route_id,route_version,step_number,workshop_id)
    REFERENCES process_route_steps(organization_id,route_id,route_version,step_number,workshop_id),
  FOREIGN KEY (organization_id,actor_id)
    REFERENCES users(organization_id,id),
  CHECK (
    (kind='completed' AND quantity IS NOT NULL AND quantity_unit IS NOT NULL)
    OR (kind<>'completed' AND quantity IS NULL AND quantity_unit IS NULL)
  ),
  CHECK (kind<>'deviation' OR length(trim(coalesce(note,''))) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS production_step_one_start
  ON production_step_evidence(organization_id,batch_id,step_number)
  WHERE kind='started';
CREATE UNIQUE INDEX IF NOT EXISTS production_step_one_completion
  ON production_step_evidence(organization_id,batch_id,step_number)
  WHERE kind='completed';
CREATE INDEX IF NOT EXISTS production_step_evidence_history
  ON production_step_evidence(organization_id,batch_id,step_number,recorded_at);

CREATE OR REPLACE FUNCTION forbid_step_evidence_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production step evidence is append-only';
END
$$;
DROP TRIGGER IF EXISTS production_step_evidence_immutable ON production_step_evidence;
CREATE TRIGGER production_step_evidence_immutable
  BEFORE UPDATE OR DELETE ON production_step_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_step_evidence_rewrite();

COMMIT;
