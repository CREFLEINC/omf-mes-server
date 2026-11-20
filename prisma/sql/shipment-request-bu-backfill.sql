UPDATE logistics.shipment_request r
   SET business_unit_id = p.business_unit_id
  FROM mdm.plant p
 WHERE p.plant_id = r.fulfillment_plant_id AND r.business_unit_id IS NULL AND p.business_unit_id IS NOT NULL;
