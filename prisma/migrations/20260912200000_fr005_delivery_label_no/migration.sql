ALTER TABLE logistics.shipment_lot_allocation
  ADD COLUMN delivery_label_no varchar(50);

CREATE UNIQUE INDEX uq_shipment_lot_allocation_delivery_label_no
  ON logistics.shipment_lot_allocation (delivery_label_no);
