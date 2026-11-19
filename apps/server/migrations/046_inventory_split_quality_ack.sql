-- Preserve the existing inventory_splits ledger; add explicit quarantine approval evidence.
-- Existing accepted split rows keep their original snapshots and default to no special approval.
BEGIN;
ALTER TABLE inventory_splits
  ADD COLUMN quarantine_acknowledged boolean NOT NULL DEFAULT false;

CREATE FUNCTION enforce_inventory_split_quality_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_quality text;
BEGIN
  SELECT quality INTO current_quality
  FROM inventory_stocks
  WHERE organization_id = NEW.organization_id AND id = NEW.parent_stock_id;
  IF current_quality = 'blocked' THEN
    RAISE EXCEPTION 'inventory_split_quality_blocked';
  END IF;
  IF current_quality = 'quarantine' AND NOT NEW.quarantine_acknowledged THEN
    RAISE EXCEPTION 'inventory_split_quarantine_ack_required';
  END IF;
  IF NEW.quarantine_acknowledged IS DISTINCT FROM
     COALESCE(NEW.request_payload->>'quarantineAcknowledged' = 'true', false) THEN
    RAISE EXCEPTION 'inventory_split_ack_mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inventory_split_quality_policy_guard
  BEFORE INSERT ON inventory_splits
  FOR EACH ROW EXECUTE FUNCTION enforce_inventory_split_quality_policy();
COMMIT;
