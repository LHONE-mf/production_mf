-- Storage inventory foundation (not activated by an API in this increment).
-- Existing local Storage journal entries are NOT migrated into confirmed stock.
-- All writes must be performed by a future authenticated, organization-scoped
-- server transaction with row locks, idempotency and revision validation.
BEGIN;

-- Existing identity tables use single-column PKs; add composite keys for
-- tenant-bound foreign keys without modifying existing rows.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_users_org_id ON users(organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_devices_org_id ON devices(organization_id,id);

CREATE TABLE IF NOT EXISTS inventory_materials (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  material_code text NOT NULL,
  display_name text NOT NULL,
  category text NOT NULL CHECK (category IN ('raw_material','component','electrode','cell')),
  base_unit text NOT NULL CHECK (base_unit IN ('mg','ul','mm','pieces')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,material_code)
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  parent_id uuid,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('warehouse','cabinet','rack','shelf','container_area')),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,parent_id) REFERENCES inventory_locations(organization_id,id)
);

CREATE TABLE IF NOT EXISTS inventory_stocks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  material_id uuid NOT NULL,
  manufacturer_lot text NOT NULL CHECK (length(trim(manufacturer_lot))>0),
  supplier text,
  receipt_reference text,
  location_id uuid NOT NULL,
  quality text NOT NULL CHECK (quality IN ('quarantine','released','blocked')),
  on_hand bigint NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,material_id) REFERENCES inventory_materials(organization_id,id),
  FOREIGN KEY (organization_id,location_id) REFERENCES inventory_locations(organization_id,id)
);
CREATE INDEX IF NOT EXISTS inventory_stocks_by_material
  ON inventory_stocks(organization_id,material_id,manufacturer_lot);

-- Reservations belong to an explicit production batch. The batch must be
-- validated against organization scope and production planning at API level.
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  stock_id uuid NOT NULL,
  production_batch_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,stock_id) REFERENCES inventory_stocks(organization_id,id)
);
CREATE INDEX IF NOT EXISTS inventory_reservations_by_stock
  ON inventory_reservations(organization_id,stock_id);

-- Append-only operation ledger for idempotent server-confirmed receipts.
-- The service must commit ledger + balances + acknowledgement in one
-- PostgreSQL transaction. operation_id must never be reused for a new intent.
CREATE TABLE IF NOT EXISTS inventory_operations (
  operation_id uuid PRIMARY KEY,
  -- Server commit-ordered feed for later offline client reconciliation.
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  stock_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  device_id uuid,
  kind text NOT NULL CHECK (kind IN
    ('receive','reserve','release_reservation','issue','return','transfer','adjust','quality_change')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  resulting_revision integer NOT NULL CHECK (resulting_revision > 0),
  reason text NOT NULL CHECK (length(trim(reason))>0),
  production_batch_id uuid,
  -- Canonical JSONB intent and immutable response snapshot for exact retries.
  request_payload jsonb NOT NULL,
  result_stock jsonb NOT NULL,
  from_location_id uuid,
  to_location_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,stock_id) REFERENCES inventory_stocks(organization_id,id),
  FOREIGN KEY (organization_id,actor_id) REFERENCES users(organization_id,id),
  FOREIGN KEY (organization_id,device_id) REFERENCES devices(organization_id,id)
);
-- Explicit access without widening the existing user role hierarchy.
-- Until the chief assigns access, only the chief can use inventory endpoints.
CREATE TABLE IF NOT EXISTS inventory_access (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('operator','manager')),
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (organization_id,user_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES users(organization_id,id),
  FOREIGN KEY (organization_id,granted_by) REFERENCES users(organization_id,id)
);
CREATE TABLE IF NOT EXISTS inventory_access_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('operator','manager')),
  action text NOT NULL CHECK (action IN ('grant','revoke')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,user_id) REFERENCES users(organization_id,id),
  FOREIGN KEY (organization_id,actor_id) REFERENCES users(organization_id,id)
);
CREATE INDEX IF NOT EXISTS inventory_operations_by_sequence
  ON inventory_operations(organization_id,sequence);
CREATE INDEX IF NOT EXISTS inventory_operations_by_stock
  ON inventory_operations(organization_id,stock_id,recorded_at,operation_id);

-- Never alter accepted operation history. Correct stock through new events.
CREATE OR REPLACE FUNCTION forbid_inventory_operation_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $inventory_fn$ BEGIN
  RAISE EXCEPTION 'inventory operation history is immutable';
END $inventory_fn$;
DROP TRIGGER IF EXISTS inventory_operation_immutable ON inventory_operations;
CREATE TRIGGER inventory_operation_immutable BEFORE UPDATE OR DELETE
  ON inventory_operations FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();
DROP TRIGGER IF EXISTS inventory_access_event_immutable ON inventory_access_events;
CREATE TRIGGER inventory_access_event_immutable BEFORE UPDATE OR DELETE
  ON inventory_access_events FOR EACH ROW EXECUTE FUNCTION forbid_inventory_operation_rewrite();

COMMIT;
