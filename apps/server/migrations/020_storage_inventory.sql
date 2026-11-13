-- Storage v1: authoritative, tenant-scoped stock with immutable postings.
-- Apply AFTER 001–019, before enabling /storage routes. Never backfill from local journals.
BEGIN;
CREATE TABLE IF NOT EXISTS storage_materials (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  category text NOT NULL CHECK(category IN ('raw','component','electrode','cell')),
  unit text NOT NULL CHECK(unit IN ('kg','g','l','m','pieces','cells')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id)
);
CREATE TABLE IF NOT EXISTS storage_locations (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  warehouse text NOT NULL CHECK(length(trim(warehouse)) BETWEEN 1 AND 120),
  cabinet text NOT NULL CHECK(length(trim(cabinet)) BETWEEN 1 AND 120),
  shelf text NOT NULL CHECK(length(trim(shelf)) BETWEEN 1 AND 120),
  container text NOT NULL CHECK(length(trim(container)) BETWEEN 1 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id)
);
CREATE TABLE IF NOT EXISTS storage_lots (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  material_id uuid NOT NULL,
  manufacturer_lot_code text NOT NULL CHECK(length(trim(manufacturer_lot_code)) BETWEEN 1 AND 200),
  manufacturer text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  UNIQUE(organization_id,id,material_id),
  FOREIGN KEY(organization_id,material_id) REFERENCES storage_materials(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id),
  CHECK(manufacturer IS NULL OR length(trim(manufacturer)) BETWEEN 1 AND 200)
);
-- A manufacturer lot is not globally unique: multiple deliveries of it are legitimate.
CREATE INDEX IF NOT EXISTS storage_lots_lookup
  ON storage_lots(organization_id,material_id,manufacturer_lot_code);

CREATE TABLE IF NOT EXISTS storage_receipts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  material_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity numeric(24,6) NOT NULL CHECK(quantity > 0),
  supplier text,
  document_reference text,
  evidence text NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  UNIQUE(organization_id,id,material_id,lot_id),
  FOREIGN KEY(organization_id,material_id) REFERENCES storage_materials(organization_id,id),
  FOREIGN KEY(organization_id,lot_id,material_id)
    REFERENCES storage_lots(organization_id,id,material_id),
  FOREIGN KEY(organization_id,location_id) REFERENCES storage_locations(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES users(organization_id,id),
  CHECK(supplier IS NULL OR length(trim(supplier)) BETWEEN 1 AND 200),
  CHECK(document_reference IS NULL OR length(trim(document_reference)) BETWEEN 1 AND 200)
);
CREATE TABLE IF NOT EXISTS storage_stock_units (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  material_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  location_id uuid NOT NULL,
  disposition text NOT NULL DEFAULT 'quarantine'
    CHECK(disposition IN ('quarantine','released','blocked')),
  on_hand numeric(24,6) NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
  reserved numeric(24,6) NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= on_hand),
  revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,receipt_id,material_id,lot_id)
    REFERENCES storage_receipts(organization_id,id,material_id,lot_id),
  FOREIGN KEY(organization_id,location_id) REFERENCES storage_locations(organization_id,id)
);
CREATE INDEX IF NOT EXISTS storage_stock_location_idx
  ON storage_stock_units(organization_id,location_id,id);

CREATE TABLE IF NOT EXISTS storage_warehouse_managers (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  granted_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES users(organization_id,id),
  FOREIGN KEY(organization_id,granted_by) REFERENCES users(organization_id,id)
);
CREATE TABLE IF NOT EXISTS storage_operations (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  actor_id uuid NOT NULL,
  device_id uuid NOT NULL,
  kind text NOT NULL,
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  UNIQUE(organization_id,sequence),
  FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
  FOREIGN KEY(device_id) REFERENCES devices(id)
);
CREATE INDEX IF NOT EXISTS storage_operation_stream_idx
  ON storage_operations(organization_id,sequence);
CREATE TABLE IF NOT EXISTS storage_ledger_entries (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  operation_id uuid NOT NULL,
  stock_unit_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('receive','release','issue','move_in','move_out','reconcile')),
  quantity_delta numeric(24,6) NOT NULL,
  balance_after numeric(24,6) NOT NULL CHECK(balance_after >= 0),
  actor_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,operation_id) REFERENCES storage_operations(organization_id,id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(organization_id,stock_unit_id) REFERENCES storage_stock_units(organization_id,id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES users(organization_id,id),
  CHECK(kind IN ('release') OR quantity_delta <> 0 OR kind = 'reconcile')
);
CREATE INDEX IF NOT EXISTS storage_ledger_stock_idx
  ON storage_ledger_entries(organization_id,stock_unit_id,recorded_at,id);
CREATE OR REPLACE FUNCTION forbid_storage_history_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'storage history is append-only';
END $$;
DROP TRIGGER IF EXISTS storage_receipts_immutable ON storage_receipts;
CREATE TRIGGER storage_receipts_immutable BEFORE UPDATE OR DELETE ON storage_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_storage_history_rewrite();
DROP TRIGGER IF EXISTS storage_lots_immutable ON storage_lots;
CREATE TRIGGER storage_lots_immutable BEFORE UPDATE OR DELETE ON storage_lots
  FOR EACH ROW EXECUTE FUNCTION forbid_storage_history_rewrite();
DROP TRIGGER IF EXISTS storage_operations_immutable ON storage_operations;
CREATE TRIGGER storage_operations_immutable BEFORE UPDATE OR DELETE ON storage_operations
  FOR EACH ROW EXECUTE FUNCTION forbid_storage_history_rewrite();
DROP TRIGGER IF EXISTS storage_ledger_immutable ON storage_ledger_entries;
CREATE TRIGGER storage_ledger_immutable BEFORE UPDATE OR DELETE ON storage_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_storage_history_rewrite();
COMMIT;
