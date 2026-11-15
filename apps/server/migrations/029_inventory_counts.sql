BEGIN;
-- Immutable evidence stream. No new balance projection or automatic count adjustment.
CREATE TABLE inventory_count_events (
 operation_id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 organization_id uuid NOT NULL,count_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('open','observe','close','correct')),
 actor_id uuid NOT NULL,device_id uuid NOT NULL,epoch uuid NOT NULL,
 stock_id uuid,observation_id uuid,quantity bigint CHECK(quantity BETWEEN 0 AND 9007199254740991),expected_revision integer CHECK(expected_revision BETWEEN 1 AND 2147483646),
 observed_stock jsonb,result_stock jsonb,request_payload jsonb NOT NULL,result_payload jsonb NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
 stock_effect boolean GENERATED ALWAYS AS (kind='correct') STORED,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,operation_id),
 CHECK((kind IN ('open','close') AND stock_id IS NULL AND observation_id IS NULL AND quantity IS NULL AND expected_revision IS NULL AND observed_stock IS NULL AND result_stock IS NULL)
  OR (kind='observe' AND stock_id IS NOT NULL AND observation_id IS NULL AND quantity IS NOT NULL AND expected_revision IS NOT NULL AND observed_stock IS NOT NULL AND result_stock IS NULL)
  OR (kind='correct' AND stock_id IS NOT NULL AND observation_id IS NOT NULL AND quantity IS NOT NULL AND expected_revision IS NOT NULL AND observed_stock IS NOT NULL AND result_stock IS NOT NULL)),
 FOREIGN KEY(organization_id,stock_id) REFERENCES inventory_stocks(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,observation_id) REFERENCES inventory_count_events(organization_id,operation_id)
);
CREATE UNIQUE INDEX inventory_count_identity ON inventory_count_events(count_id) WHERE kind='open';
CREATE UNIQUE INDEX inventory_count_closed_once ON inventory_count_events(count_id) WHERE kind='close';
CREATE UNIQUE INDEX inventory_count_corrected_once ON inventory_count_events(observation_id) WHERE kind='correct';
CREATE INDEX inventory_count_history ON inventory_count_events(organization_id,count_id,sequence);
CREATE INDEX inventory_count_list ON inventory_count_events(organization_id,count_id) WHERE kind='open';
CREATE TRIGGER inventory_count_immutable BEFORE UPDATE OR DELETE ON inventory_count_events FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
ALTER TABLE inventory_operations DROP CONSTRAINT inventory_operations_kind_check;
ALTER TABLE inventory_operations ADD CONSTRAINT inventory_operations_kind_check CHECK(kind IN ('receive','reserve','release_reservation','issue','return','transfer','adjust','quality_change','scrap','split_out','split_in','count_adjustment'));
CREATE FUNCTION enforce_inventory_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opened inventory_count_events%ROWTYPE;observation inventory_count_events%ROWTYPE;is_manager boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':inventory-sequence',0));
 SELECT u.role='chief' OR COALESCE(a.level='manager',false) INTO is_manager FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL LEFT JOIN inventory_access a ON a.organization_id=u.organization_id AND a.user_id=u.id AND a.active WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active AND (u.role='chief' OR a.level IN ('manager','operator'));
 IF NOT FOUND OR NEW.kind='correct' AND NOT is_manager THEN RAISE EXCEPTION 'count_authority_required'; END IF;
 IF NEW.kind<>'open' THEN
  SELECT * INTO opened FROM inventory_count_events WHERE organization_id=NEW.organization_id AND count_id=NEW.count_id AND kind='open';
  IF NOT FOUND THEN RAISE EXCEPTION 'count_not_found'; END IF;
  IF NEW.kind='close' AND NOT is_manager AND opened.actor_id<>NEW.actor_id THEN RAISE EXCEPTION 'count_authority_required'; END IF;
  IF NEW.kind IN ('observe','close') AND EXISTS(SELECT 1 FROM inventory_count_events WHERE count_id=NEW.count_id AND kind='close') THEN RAISE EXCEPTION 'count_closed'; END IF;
 END IF;
 IF NEW.kind='observe' AND NOT EXISTS(SELECT 1 FROM inventory_operations WHERE organization_id=NEW.organization_id AND stock_id=NEW.stock_id AND resulting_revision=NEW.expected_revision AND result_stock=NEW.observed_stock) THEN RAISE EXCEPTION 'count_snapshot_unverified'; END IF;
 IF NEW.kind='correct' THEN
  SELECT * INTO observation FROM inventory_count_events WHERE organization_id=NEW.organization_id AND count_id=NEW.count_id AND operation_id=NEW.observation_id AND kind='observe';
  IF NOT FOUND OR observation.stock_id<>NEW.stock_id OR observation.quantity<>NEW.quantity OR observation.expected_revision<>NEW.expected_revision OR observation.observed_stock<>NEW.observed_stock THEN RAISE EXCEPTION 'count_observation_mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_count_guard BEFORE INSERT ON inventory_count_events FOR EACH ROW EXECUTE FUNCTION enforce_inventory_count();
CREATE FUNCTION require_inventory_count_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e inventory_count_events%ROWTYPE;o inventory_operations%ROWTYPE;s inventory_stocks%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='inventory_operations' THEN
  IF NEW.kind<>'count_adjustment' THEN RETURN NEW; END IF;
  SELECT * INTO e FROM inventory_count_events WHERE operation_id=NEW.operation_id AND kind='correct';o:=NEW;
 ELSE
  IF NEW.kind<>'correct' THEN RETURN NEW; END IF;
  e:=NEW;SELECT * INTO o FROM inventory_operations WHERE operation_id=NEW.operation_id AND kind='count_adjustment';
 END IF;
 SELECT * INTO s FROM inventory_stocks WHERE organization_id=e.organization_id AND id=e.stock_id;
 IF e.operation_id IS NULL OR o.operation_id IS NULL OR e.organization_id<>o.organization_id OR e.stock_id<>o.stock_id OR e.actor_id<>o.actor_id OR e.device_id IS DISTINCT FROM o.device_id OR e.request_payload<>o.request_payload OR e.result_stock<>o.result_stock
  OR o.expected_revision<>e.expected_revision OR o.resulting_revision<>e.expected_revision+1 OR s.revision<>o.resulting_revision
  OR s.on_hand<>e.quantity OR s.reserved IS DISTINCT FROM (e.observed_stock->>'reserved')::bigint OR s.on_hand<s.reserved
  OR o.quantity<>abs(e.quantity-(e.observed_stock->>'onHand')::bigint) OR o.quantity=0
  OR (e.observed_stock-ARRAY['onHand','available','revision'])<>(e.result_stock-ARRAY['onHand','available','revision'])
  OR (e.result_stock->>'onHand')::bigint IS DISTINCT FROM e.quantity OR (e.result_stock->>'reserved')::bigint IS DISTINCT FROM s.reserved OR (e.result_stock->>'available')::bigint IS DISTINCT FROM s.on_hand-s.reserved OR (e.result_stock->>'revision')::integer IS DISTINCT FROM s.revision
  OR NOT EXISTS(SELECT 1 FROM inventory_operations WHERE organization_id=e.organization_id AND stock_id=e.stock_id AND resulting_revision=e.expected_revision AND result_stock=e.observed_stock)
 THEN RAISE EXCEPTION 'inventory_count_pair_required'; END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_count_stock_pair AFTER INSERT ON inventory_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_count_pair();
CREATE CONSTRAINT TRIGGER inventory_count_event_pair AFTER INSERT ON inventory_count_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_inventory_count_pair();
-- Extend the existing cross-endpoint immutable operation namespace.
CREATE OR REPLACE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;incoming_effect boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 incoming_effect:=CASE WHEN TG_TABLE_NAME='inventory_operations' THEN true WHEN TG_TABLE_NAME='inventory_issue_outcomes' THEN NEW.kind='return' WHEN TG_TABLE_NAME='inventory_count_events' THEN NEW.kind='correct' ELSE (to_jsonb(NEW)->>'stock_effect')::boolean END;
 FOR other IN
  SELECT 'inventory_operations' AS owner,organization_id,actor_id,device_id,request_payload,true AS stock_effect FROM inventory_operations WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_operations'
  UNION ALL SELECT 'inventory_issue_events',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_events'
  UNION ALL SELECT 'inventory_issue_outcomes',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_issue_outcomes WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_issue_outcomes'
  UNION ALL SELECT 'inventory_count_events',organization_id,actor_id,device_id,request_payload,stock_effect FROM inventory_count_events WHERE operation_id=NEW.operation_id AND TG_TABLE_NAME<>'inventory_count_events'
 LOOP
  IF other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR NOT other.stock_effect OR NOT incoming_effect OR TG_TABLE_NAME<>'inventory_operations' AND other.owner<>'inventory_operations' THEN RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505'; END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER inventory_count_intent_id BEFORE INSERT ON inventory_count_events FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
COMMIT;
