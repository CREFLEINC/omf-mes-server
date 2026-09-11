ALTER TABLE logistics.inbound_receipt_line
  ADD COLUMN supplier_lot_label_attached boolean;

UPDATE logistics.inbound_receipt_line
   SET supplier_lot_label_attached = NOT supplier_lot_missing
 WHERE supplier_lot_label_attached IS NULL;

ALTER TABLE logistics.inbound_receipt_line
  ALTER COLUMN supplier_lot_label_attached SET NOT NULL;

ALTER TABLE logistics.inbound_receipt_line
  ADD CONSTRAINT ck_inbound_supplier_lot_label_attached
  CHECK (NOT supplier_lot_missing OR NOT supplier_lot_label_attached);
