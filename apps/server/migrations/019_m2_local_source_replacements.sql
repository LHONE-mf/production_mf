-- Explicit correction lineage. Original links and withdrawals stay immutable.
BEGIN;
CREATE TABLE IF NOT EXISTS production_local_journal_replacements (
  organization_id uuid NOT NULL,
  original_link_id uuid NOT NULL,
  replacement_link_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,original_link_id),
  UNIQUE(organization_id,replacement_link_id),
  CHECK(original_link_id<>replacement_link_id),
  FOREIGN KEY(organization_id,original_link_id)
    REFERENCES production_local_journal_withdrawals(organization_id,link_id),
  FOREIGN KEY(organization_id,replacement_link_id)
    REFERENCES production_local_journal_links(organization_id,id),
  FOREIGN KEY(organization_id,recorded_by) REFERENCES users(organization_id,id)
);
CREATE OR REPLACE FUNCTION validate_local_source_replacement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original production_local_journal_links%ROWTYPE;
DECLARE replacement production_local_journal_links%ROWTYPE;
BEGIN
  SELECT * INTO original FROM production_local_journal_links
    WHERE organization_id=NEW.organization_id AND id=NEW.original_link_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'replacement original missing'; END IF;
  SELECT * INTO replacement FROM production_local_journal_links
    WHERE organization_id=NEW.organization_id AND id=NEW.replacement_link_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'replacement source missing'; END IF;
  IF (original.batch_id,original.order_id,original.route_id,original.route_version,
      original.step_number,original.workshop_id,original.source_stage,original.source_kind)
     IS DISTINCT FROM
     (replacement.batch_id,replacement.order_id,replacement.route_id,replacement.route_version,
      replacement.step_number,replacement.workshop_id,replacement.source_stage,replacement.source_kind)
     OR replacement.linked_by<>NEW.recorded_by THEN
    RAISE EXCEPTION 'replacement scope mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM production_local_journal_withdrawals
    WHERE organization_id=NEW.organization_id AND link_id=NEW.replacement_link_id) THEN
    RAISE EXCEPTION 'replacement source is withdrawn';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_source_replacement_valid ON production_local_journal_replacements;
CREATE TRIGGER local_source_replacement_valid BEFORE INSERT ON production_local_journal_replacements
  FOR EACH ROW EXECUTE FUNCTION validate_local_source_replacement();
DROP TRIGGER IF EXISTS local_source_replacement_immutable ON production_local_journal_replacements;
CREATE TRIGGER local_source_replacement_immutable BEFORE UPDATE OR DELETE ON production_local_journal_replacements
  FOR EACH ROW EXECUTE FUNCTION forbid_local_journal_link_rewrite();
COMMIT;
