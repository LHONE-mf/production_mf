-- Returns and scrap settle actual received issue ownership; stock remains in the existing ledger.
BEGIN;
CREATE TABLE inventory_issue_outcomes (
 operation_id uuid PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 organization_id uuid NOT NULL, issue_id uuid NOT NULL, production_batch_id uuid NOT NULL, source_stock_id uuid NOT NULL,
 actor_id uuid NOT NULL, device_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('return','scrap')),
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740990),
 resulting_revision bigint NOT NULL CHECK(resulting_revision=expected_revision+1),
 epoch uuid NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000), condition text,
 return_stock_id uuid UNIQUE, stock_effect boolean GENERATED ALWAYS AS (kind='return') STORED,
 request_payload jsonb NOT NULL, result_payload jsonb NOT NULL, result_stock jsonb,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='return' AND return_stock_id IS NOT NULL AND condition='untouched_unused' AND result_stock IS NOT NULL) OR (kind='scrap' AND return_stock_id IS NULL AND condition IS NULL AND result_stock IS NULL)),
 CHECK(return_stock_id IS DISTINCT FROM source_stock_id),
 FOREIGN KEY(organization_id,issue_id) REFERENCES inventory_issues(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,source_stock_id) REFERENCES inventory_stocks(organization_id,id),
 FOREIGN KEY(organization_id,return_stock_id) REFERENCES inventory_stocks(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX inventory_issue_outcomes_history ON inventory_issue_outcomes(organization_id,issue_id,sequence);
CREATE TRIGGER inventory_issue_outcome_immutable BEFORE UPDATE OR DELETE ON inventory_issue_outcomes FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

-- A later source hold/expiry also prevents use of a returned descendant. No QA
-- projection is rewritten silently, and no cache/clock-based release is inferred.
CREATE FUNCTION inventory_package_released(org uuid,package uuid) RETURNS boolean LANGUAGE sql AS $$
 WITH RECURSIVE lineage(id,depth) AS (
  SELECT id,0 FROM inventory_stocks WHERE organization_id=org AND id=package
  UNION ALL SELECT o.source_stock_id,l.depth+1 FROM lineage l JOIN inventory_issue_outcomes o ON o.organization_id=org AND o.return_stock_id=l.id WHERE l.depth<100
 ) SELECT count(*)>0 AND COALESCE(bool_and(s.quality='released' AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())),false) AND COALESCE(max(l.depth),100)<100
 FROM lineage l JOIN inventory_stocks s ON s.organization_id=org AND s.id=l.id
$$;

CREATE FUNCTION enforce_inventory_issue_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issued inventory_issues%ROWTYPE; settled bigint; n bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND (u.role='chief' OR EXISTS(SELECT 1 FROM inventory_access a WHERE a.organization_id=u.organization_id AND a.user_id=u.id AND a.active AND (a.level='manager' OR NEW.kind='return' AND a.level='operator')))) THEN RAISE EXCEPTION 'outcome_warehouse_authority_required'; END IF;
 SELECT * INTO issued FROM inventory_issues WHERE organization_id=NEW.organization_id AND id=NEW.issue_id;
 IF NOT FOUND OR issued.state<>'received' OR issued.stock_id<>NEW.source_stock_id OR issued.production_batch_id<>NEW.production_batch_id THEN RAISE EXCEPTION 'accepted_issue_provenance_required'; END IF;
 SELECT count(*),COALESCE(sum(quantity),0) INTO n,settled FROM inventory_issue_outcomes WHERE organization_id=NEW.organization_id AND issue_id=NEW.issue_id;
 IF NEW.expected_revision<>n+1 OR NEW.quantity>issued.quantity-settled THEN RAISE EXCEPTION 'issue_outstanding_changed'; END IF;
 IF NEW.kind='return' AND (NOT inventory_package_released(NEW.organization_id,NEW.source_stock_id) OR (issued.source_snapshot->>'expiresAt')::timestamptz<=clock_timestamp()) THEN RAISE EXCEPTION 'return_source_ineligible'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_issue_outcome_guard BEFORE INSERT ON inventory_issue_outcomes FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_outcome();

-- Share one immutable intent namespace with stock and handoff operations.
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 FOR other IN
  SELECT 'inventory_operations' AS owner,organization_id,actor_id,device_id,request_payload,true AS stock_effect FROM inventory_operations WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_operations'
  UNION ALL SELECT 'inventory_issue_events',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_events'
  UNION ALL SELECT 'inventory_issue_outcomes',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_outcomes WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_outcomes'
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR NOT other.stock_effect OR (TG_TABLE_NAME<>'inventory_operations' AND (other.owner<>'inventory_operations' OR NOT CASE WHEN TG_TABLE_NAME='inventory_issue_outcomes' THEN NEW.kind='return' ELSE (to_jsonb(NEW)->>'stock_effect')::boolean END)) THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_outcome_intent_id BEFORE INSERT ON inventory_issue_outcomes FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();

CREATE FUNCTION require_inventory_return_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='inventory_operations' THEN
  IF NEW.kind='return' AND NOT EXISTS(SELECT 1 FROM inventory_issue_outcomes o WHERE o.operation_id=NEW.operation_id AND o.organization_id=NEW.organization_id AND o.kind='return' AND o.return_stock_id=NEW.stock_id AND o.quantity=NEW.quantity AND o.actor_id=NEW.actor_id AND o.device_id=NEW.device_id AND o.request_payload=NEW.request_payload AND o.result_stock=NEW.result_stock) THEN RAISE EXCEPTION 'inventory_return_pair_required'; END IF;
 ELSE
  IF NEW.kind='return' AND NOT EXISTS(
   SELECT 1 FROM inventory_operations o JOIN inventory_stocks s ON s.organization_id=o.organization_id AND s.id=o.stock_id
   JOIN inventory_stocks p ON p.organization_id=NEW.organization_id AND p.id=NEW.source_stock_id
   JOIN inventory_issues i ON i.organization_id=NEW.organization_id AND i.id=NEW.issue_id
   WHERE o.operation_id=NEW.operation_id AND o.organization_id=NEW.organization_id AND o.kind='return' AND o.stock_id=NEW.return_stock_id AND o.quantity=NEW.quantity AND o.production_batch_id=NEW.production_batch_id
    AND o.actor_id=NEW.actor_id AND o.device_id=NEW.device_id AND o.request_payload=NEW.request_payload AND o.result_stock=NEW.result_stock
    AND o.expected_revision=0 AND o.resulting_revision=1 AND s.revision=1 AND s.on_hand=NEW.quantity AND s.reserved=0 AND s.quality='released' AND s.disposition='release'
    AND s.material_id=p.material_id AND s.manufacturer_lot=p.manufacturer_lot AND s.expires_at IS NOT DISTINCT FROM LEAST(p.expires_at,(i.source_snapshot->>'expiresAt')::timestamptz)
    AND inventory_package_released(NEW.organization_id,NEW.source_stock_id) AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
  ) THEN RAISE EXCEPTION 'inventory_return_pair_required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_return_stock_pair AFTER INSERT ON inventory_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_return_pair();
CREATE CONSTRAINT TRIGGER inventory_return_outcome_pair AFTER INSERT ON inventory_issue_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_return_pair();
CREATE FUNCTION enforce_returned_package_quality() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.disposition='release' AND EXISTS(SELECT 1 FROM inventory_issue_outcomes o WHERE o.organization_id=NEW.organization_id AND o.return_stock_id=NEW.stock_id AND NOT inventory_package_released(NEW.organization_id,o.source_stock_id)) THEN RAISE EXCEPTION 'quality_release_ineligible'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_returned_package_quality BEFORE INSERT ON inventory_quality_dispositions FOR EACH ROW EXECUTE FUNCTION enforce_returned_package_quality();
-- Warehouse disposal is a distinct debit, never a count correction or another
-- debit of already-issued ownership. Reserved stock cannot be disposed here.
ALTER TABLE inventory_operations DROP CONSTRAINT inventory_operations_kind_check;
ALTER TABLE inventory_operations ADD CONSTRAINT inventory_operations_kind_check CHECK(kind IN ('receive','reserve','release_reservation','issue','return','transfer','adjust','quality_change','scrap'));
CREATE FUNCTION enforce_inventory_warehouse_scrap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb; current_stock inventory_stocks%ROWTYPE;
BEGIN
 IF NEW.kind<>'scrap' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND (u.role='chief' OR EXISTS(SELECT 1 FROM inventory_access a WHERE a.organization_id=u.organization_id AND a.user_id=u.id AND a.active AND a.level='manager'))) THEN RAISE EXCEPTION 'inventory_scrap_manager_required'; END IF;
 SELECT result_stock INTO previous FROM inventory_operations WHERE organization_id=NEW.organization_id AND stock_id=NEW.stock_id ORDER BY sequence DESC LIMIT 1;
 SELECT * INTO current_stock FROM inventory_stocks WHERE organization_id=NEW.organization_id AND id=NEW.stock_id;
 IF previous IS NULL OR NEW.resulting_revision<>NEW.expected_revision+1 OR (previous->>'revision')::integer IS DISTINCT FROM NEW.expected_revision
  OR (previous->>'onHand')::bigint-NEW.quantity IS DISTINCT FROM (NEW.result_stock->>'onHand')::bigint OR (NEW.result_stock->>'onHand')::bigint<(previous->>'reserved')::bigint
  OR (previous-ARRAY['onHand','available','revision'])<>(NEW.result_stock-ARRAY['onHand','available','revision'])
  OR current_stock.on_hand<>(NEW.result_stock->>'onHand')::bigint OR current_stock.reserved<>(NEW.result_stock->>'reserved')::bigint OR current_stock.revision<>NEW.resulting_revision
  OR (NEW.result_stock->>'available')::bigint IS DISTINCT FROM current_stock.on_hand-current_stock.reserved OR (NEW.result_stock->>'revision')::integer IS DISTINCT FROM NEW.resulting_revision OR (NEW.result_stock->>'stockId')::uuid IS DISTINCT FROM NEW.stock_id
  OR length(trim(COALESCE(NEW.request_payload->>'evidence',''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'inventory_scrap_ledger_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_warehouse_scrap BEFORE INSERT ON inventory_operations FOR EACH ROW EXECUTE FUNCTION enforce_inventory_warehouse_scrap();
COMMIT;
