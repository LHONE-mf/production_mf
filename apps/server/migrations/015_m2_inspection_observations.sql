-- M2 inspection observations foundation. An observation is a chief-attested
-- statement, never an inspection plan decision, QA disposition, batch
-- release, material accounting, or validated equipment measurement.
BEGIN;
CREATE TABLE IF NOT EXISTS production_inspection_observations (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  route_id uuid NOT NULL,
  route_version integer NOT NULL,
  step_number integer NOT NULL CHECK (step_number > 0),
  workshop_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('measurement','visual')),
  characteristic text NOT NULL CHECK (length(trim(characteristic)) BETWEEN 1 AND 120),
  observed_value numeric(18,6),
  observed_unit text CHECK (observed_unit IN
    ('um','mm','g','mg','mOhm','V','mAh','pct','C')),
  attention_required boolean NOT NULL,
  note text CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,order_id,batch_id)
    REFERENCES production_batches(organization_id,order_id,id),
  FOREIGN KEY (organization_id,order_id,route_id,route_version)
    REFERENCES production_orders(organization_id,id,route_id,route_version),
  FOREIGN KEY (organization_id,route_id,route_version,step_number,workshop_id)
    REFERENCES process_route_steps(organization_id,route_id,route_version,step_number,workshop_id),
  FOREIGN KEY (organization_id,recorded_by)
    REFERENCES users(organization_id,id),
  CHECK (
    (kind='measurement' AND observed_value IS NOT NULL AND observed_unit IS NOT NULL)
    OR (kind='visual' AND observed_value IS NULL AND observed_unit IS NULL)
  ),
  CHECK (kind <> 'visual' OR note IS NOT NULL),
  CHECK (attention_required = false OR note IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS production_inspection_history_idx
  ON production_inspection_observations(organization_id,batch_id,step_number,recorded_at);

CREATE OR REPLACE FUNCTION forbid_inspection_observation_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'production inspection observations are append-only';
END
$$;
DROP TRIGGER IF EXISTS production_inspection_observations_immutable ON production_inspection_observations;
CREATE TRIGGER production_inspection_observations_immutable
  BEFORE UPDATE OR DELETE ON production_inspection_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_inspection_observation_rewrite();
COMMIT;
