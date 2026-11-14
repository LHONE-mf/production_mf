-- No historical dates, authorship or stock are invented by this additive upgrade.
BEGIN;
ALTER TABLE inventory_materials ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE inventory_materials ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE inventory_materials ADD COLUMN IF NOT EXISTS supplier_reference text CHECK(supplier_reference IS NULL OR length(trim(supplier_reference)) BETWEEN 1 AND 200);
ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE inventory_catalog_events ADD COLUMN IF NOT EXISTS before_payload jsonb;
COMMIT;
