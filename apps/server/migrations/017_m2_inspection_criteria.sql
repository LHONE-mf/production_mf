-- Immutable reference limits for approved route versions, not QA release.
BEGIN;
CREATE TABLE production_inspection_criteria (
 organization_id uuid NOT NULL,
 id uuid NOT NULL,
 route_id uuid NOT NULL,
 route_version integer NOT NULL CHECK(route_version>0),
 step_number integer NOT NULL CHECK(step_number>0),
 characteristic text NOT NULL CHECK(length(trim(characteristic)) BETWEEN 1 AND 120 AND characteristic=trim(characteristic)),
 unit text NOT NULL CHECK(unit IN ('um','mm','g','mg','mOhm','V','mAh','pct','C')),
 lower_limit numeric(18,6),
 upper_limit numeric(18,6),
 note text CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,route_id,route_version,step_number)
  REFERENCES process_route_steps(organization_id,route_id,route_version,step_number),
 FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id),
 CHECK(lower_limit IS NOT NULL OR upper_limit IS NOT NULL),
 CHECK(lower_limit IS NULL OR upper_limit IS NULL OR lower_limit<=upper_limit)
);
CREATE UNIQUE INDEX production_inspection_criterion_name
 ON production_inspection_criteria(organization_id,route_id,route_version,step_number,lower(characteristic));
CREATE INDEX production_inspection_criterion_route_idx
 ON production_inspection_criteria(organization_id,route_id,route_version,step_number);
CREATE FUNCTION forbid_inspection_criterion_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'inspection criteria are append-only';
END
$$;
CREATE TRIGGER inspection_criterion_immutable
 BEFORE UPDATE OR DELETE ON production_inspection_criteria
 FOR EACH ROW EXECUTE FUNCTION forbid_inspection_criterion_rewrite();
COMMIT;
