-- Additive chief-attested triage of flagged inspection observations.
-- A review is not independent QA disposition or product release. Completion
-- may be withheld until a reviewer documents non-blocking triage.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS production_inspection_obs_batch_identity
  ON production_inspection_observations(organization_id,batch_id,id);

CREATE TABLE IF NOT EXISTS production_inspection_reviews (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  review_number integer NOT NULL CHECK (review_number > 0),
  outcome text NOT NULL CHECK(outcome IN ('follow_up_required','reviewed_no_block')),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  UNIQUE(organization_id,batch_id,observation_id,review_number),
  FOREIGN KEY(organization_id,batch_id,observation_id)
    REFERENCES production_inspection_observations(organization_id,batch_id,id),
  FOREIGN KEY(organization_id,reviewed_by)
    REFERENCES users(organization_id,id)
);
CREATE INDEX IF NOT EXISTS inspection_reviews_recent
  ON production_inspection_reviews
  (organization_id,batch_id,observation_id,review_number DESC);

CREATE OR REPLACE FUNCTION forbid_inspection_review_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inspection reviews are append-only';
END
$$;
DROP TRIGGER IF EXISTS production_inspection_reviews_immutable ON production_inspection_reviews;
CREATE TRIGGER production_inspection_reviews_immutable
  BEFORE UPDATE OR DELETE ON production_inspection_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_inspection_review_rewrite();
COMMIT;
