ALTER TABLE logistics.material_issue_request
  ALTER COLUMN destination_location_id DROP NOT NULL,
  ADD CHECK (destination_location_id IS NOT NULL OR
    (request_type_code = 'WORK_ORDER' AND work_order_id IS NOT NULL));

ALTER TABLE production.work_order
  ADD COLUMN direct_material_issue boolean NOT NULL DEFAULT false;
