-- Incoming IQC is one request per LOT; reinspection remains rounds/results on that request.
CREATE UNIQUE INDEX uq_iqc_inspection_request_lot
  ON quality.inspection_request (lot_id)
  WHERE inspection_type_code = 'IQC' AND lot_id IS NOT NULL;
