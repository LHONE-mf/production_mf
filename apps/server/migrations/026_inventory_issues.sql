-- Additive accountable handoffs. Stock balances remain in the existing ledger.
BEGIN;
CREATE TABLE inventory_issues (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 material_id uuid NOT NULL, production_batch_id uuid NOT NULL, step_number integer NOT NULL CHECK(step_number>0),
 workshop_id text NOT NULL, recipient_id uuid NOT NULL, requested_by uuid NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 unit text NOT NULL CHECK(unit IN ('mg','ul','mm','pieces')),
 state text NOT NULL CHECK(state IN ('requested','reserved','approved','dispatched','received','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), stock_id uuid,
 source_snapshot jsonb, approved_operation_id uuid, approved_stock_revision integer,
 approved_by uuid, approved_device_id uuid, dispatch_operation_id uuid, receipt_operation_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,material_id) REFERENCES inventory_materials(organization_id,id),
 FOREIGN KEY(organization_id,production_batch_id) REFERENCES production_batches(organization_id,id),
 FOREIGN KEY(organization_id,workshop_id) REFERENCES workshops(organization_id,id),
 FOREIGN KEY(organization_id,recipient_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,requested_by) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,approved_by) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,approved_device_id) REFERENCES devices(organization_id,id),
 FOREIGN KEY(organization_id,stock_id) REFERENCES inventory_stocks(organization_id,id)
);
CREATE INDEX inventory_issues_by_batch ON inventory_issues(organization_id,production_batch_id,id);
CREATE INDEX inventory_issues_by_recipient ON inventory_issues(organization_id,recipient_id,id);
ALTER TABLE inventory_reservations ADD COLUMN issue_id uuid;
ALTER TABLE inventory_reservations ADD FOREIGN KEY(organization_id,issue_id) REFERENCES inventory_issues(organization_id,id);
CREATE UNIQUE INDEX inventory_reservations_issue ON inventory_reservations(issue_id) WHERE issue_id IS NOT NULL;
CREATE TABLE inventory_issue_events (
 operation_id uuid PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 organization_id uuid NOT NULL, issue_id uuid NOT NULL, actor_id uuid NOT NULL, device_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('request','reserve','approve','dispatch','receive','cancel')),
 expected_revision integer NOT NULL CHECK(expected_revision>=0), resulting_revision integer NOT NULL CHECK(resulting_revision=expected_revision+1),
 epoch uuid NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
 stock_effect boolean NOT NULL, request_payload jsonb NOT NULL, result_issue jsonb NOT NULL, result_stock jsonb,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,operation_id),
 CHECK(stock_effect=(result_stock IS NOT NULL)),
 FOREIGN KEY(organization_id,issue_id) REFERENCES inventory_issues(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,device_id) REFERENCES devices(organization_id,id)
);
CREATE INDEX inventory_issue_events_history ON inventory_issue_events(organization_id,issue_id,sequence);
CREATE TRIGGER inventory_issue_event_immutable BEFORE UPDATE OR DELETE ON inventory_issue_events
 FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
ALTER TABLE inventory_issues ADD FOREIGN KEY(organization_id,approved_operation_id) REFERENCES inventory_issue_events(organization_id,operation_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE inventory_issues ADD FOREIGN KEY(organization_id,dispatch_operation_id) REFERENCES inventory_issue_events(organization_id,operation_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE inventory_issues ADD FOREIGN KEY(organization_id,receipt_operation_id) REFERENCES inventory_issue_events(organization_id,operation_id) DEFERRABLE INITIALLY DEFERRED;
-- One intent ID across workflow and stock endpoints; a paired stock event is
-- allowed only for the exact same org, author, device and canonical request.
CREATE FUNCTION enforce_inventory_issue_intent_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_id::text,1));
 IF TG_TABLE_NAME='inventory_operations' THEN
  SELECT organization_id,actor_id,device_id,request_payload,stock_effect INTO other FROM inventory_issue_events WHERE operation_id=NEW.operation_id;
 ELSE
  SELECT organization_id,actor_id,device_id,request_payload,true AS stock_effect INTO other FROM inventory_operations WHERE operation_id=NEW.operation_id;
 END IF;
 IF FOUND AND (other.organization_id<>NEW.organization_id OR other.actor_id<>NEW.actor_id OR other.device_id IS DISTINCT FROM NEW.device_id OR other.request_payload<>NEW.request_payload OR NOT other.stock_effect OR (TG_TABLE_NAME='inventory_issue_events' AND NOT (to_jsonb(NEW)->>'stock_effect')::boolean)) THEN
  RAISE EXCEPTION 'operation_id_reused' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_stock_intent_id BEFORE INSERT ON inventory_operations FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
CREATE TRIGGER inventory_issue_intent_id BEFORE INSERT ON inventory_issue_events FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_intent_id();
-- An issue debit cannot be committed without its matching immutable handoff.
CREATE FUNCTION enforce_inventory_issue_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='issue' AND NOT EXISTS (
  SELECT 1 FROM inventory_issue_events e JOIN inventory_issues i ON i.organization_id=e.organization_id AND i.id=e.issue_id
  JOIN inventory_issue_events a ON a.organization_id=i.organization_id AND a.operation_id=i.approved_operation_id AND a.issue_id=i.id AND a.kind='approve'
  JOIN users u ON u.organization_id=i.organization_id AND u.id=i.approved_by AND u.active
  JOIN devices d ON d.organization_id=i.organization_id AND d.id=i.approved_device_id AND d.user_id=u.id AND d.revoked_at IS NULL
  JOIN inventory_stocks s ON s.organization_id=i.organization_id AND s.id=i.stock_id AND s.quality='released' AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
  WHERE e.operation_id=NEW.operation_id AND e.organization_id=NEW.organization_id AND e.kind='dispatch' AND e.stock_effect
   AND i.dispatch_operation_id=NEW.operation_id AND i.stock_id=NEW.stock_id AND i.quantity=NEW.quantity AND i.production_batch_id=NEW.production_batch_id
   AND e.actor_id=NEW.actor_id AND e.device_id=NEW.device_id AND e.request_payload=NEW.request_payload AND e.result_stock=NEW.result_stock
   AND i.approved_stock_revision=NEW.expected_revision
   AND a.actor_id=u.id AND a.device_id=d.id
   AND (u.role='chief' OR EXISTS(SELECT 1 FROM inventory_access g WHERE g.organization_id=u.organization_id AND g.user_id=u.id AND g.active AND g.level='manager'))
 ) THEN RAISE EXCEPTION 'inventory_issue_handoff_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_issue_pair AFTER INSERT ON inventory_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_pair();
-- Restricted workflow events also enforce the explicit grant at the DB boundary.
CREATE FUNCTION enforce_inventory_issue_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.kind IN ('reserve','approve','dispatch') OR (NEW.kind='cancel' AND NEW.stock_effect)) AND NOT EXISTS (
  SELECT 1 FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id AND d.id=NEW.device_id AND d.revoked_at IS NULL
  WHERE u.organization_id=NEW.organization_id AND u.id=NEW.actor_id AND u.active
   AND (u.role='chief' OR EXISTS(SELECT 1 FROM inventory_access a WHERE a.organization_id=u.organization_id AND a.user_id=u.id AND a.active AND a.level='manager'))
 ) THEN RAISE EXCEPTION 'issue_manager_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_issue_authority BEFORE INSERT ON inventory_issue_events FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_authority();
CREATE FUNCTION enforce_inventory_issue_event_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.stock_effect AND NOT EXISTS (
  SELECT 1 FROM inventory_operations o WHERE o.operation_id=NEW.operation_id AND o.organization_id=NEW.organization_id
   AND o.actor_id=NEW.actor_id AND o.device_id=NEW.device_id AND o.request_payload=NEW.request_payload AND o.result_stock=NEW.result_stock
   AND o.kind=CASE NEW.kind WHEN 'reserve' THEN 'reserve' WHEN 'dispatch' THEN 'issue' WHEN 'cancel' THEN 'release_reservation' ELSE '' END
 ) THEN RAISE EXCEPTION 'inventory_issue_stock_pair_required'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_issue_event_pair AFTER INSERT ON inventory_issue_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_inventory_issue_event_pair();
COMMIT;
