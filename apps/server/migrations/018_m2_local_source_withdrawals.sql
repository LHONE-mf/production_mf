-- Correct an attested reference without rewriting it or any manufacturing data.
BEGIN;
CREATE TABLE IF NOT EXISTS production_local_journal_withdrawals (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  link_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  withdrawn_by uuid NOT NULL,
  withdrawn_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,link_id),
  FOREIGN KEY (organization_id,link_id) REFERENCES production_local_journal_links(organization_id,id),
  FOREIGN KEY (organization_id,withdrawn_by) REFERENCES users(organization_id,id)
);
DROP TRIGGER IF EXISTS local_journal_withdrawals_immutable ON production_local_journal_withdrawals;
CREATE TRIGGER local_journal_withdrawals_immutable
  BEFORE UPDATE OR DELETE ON production_local_journal_withdrawals
  FOR EACH ROW EXECUTE FUNCTION forbid_local_journal_link_rewrite();
COMMIT;
