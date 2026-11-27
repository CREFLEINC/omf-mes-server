-- Retain historical values without keeping an obsolete configuration dependency on locations.
ALTER TABLE mdm.production_line
  DROP CONSTRAINT production_line_default_wip_location_id_fkey,
  ADD CONSTRAINT production_line_default_wip_location_id_fkey
    FOREIGN KEY (default_wip_location_id) REFERENCES mdm.location(location_id) ON DELETE SET NULL;

ALTER TABLE production.work_order
  DROP CONSTRAINT work_order_default_wip_location_id_fkey,
  ADD CONSTRAINT work_order_default_wip_location_id_fkey
    FOREIGN KEY (default_wip_location_id) REFERENCES mdm.location(location_id) ON DELETE SET NULL;

COMMENT ON COLUMN mdm.production_line.default_wip_location_id IS 'Historical default WIP location. Retired from application configuration.';
COMMENT ON COLUMN production.work_order.default_wip_location_id IS 'Historical default WIP location. Retired from work order assignment.';
