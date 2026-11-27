ALTER TABLE logistics.shopfloor_receipt
  ALTER COLUMN destination_location_id DROP NOT NULL,
  ADD CONSTRAINT ck_shopfloor_receipt_location_or_work_order
    CHECK (destination_location_id IS NOT NULL OR work_order_id IS NOT NULL);

ALTER TABLE production.work_order
  DROP COLUMN direct_material_issue;
