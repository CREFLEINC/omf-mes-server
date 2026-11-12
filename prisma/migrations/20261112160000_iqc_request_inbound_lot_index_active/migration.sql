-- 입하 LOT 당 «살아 있는» IQC 요청 하나(피처 005 · omf-all-around#254 · 총괄 결정 2026-11-12).
-- 입하 마감 취소가 요청을 CANCELLED 로 남기고(입하 LOT 칸 유지) 다시 마감하면 새 요청을 만든다 — 취소된 요청은 유일 대상에서 뺀다.
DROP INDEX quality.uq_iqc_inspection_request_inbound_lot;
CREATE UNIQUE INDEX uq_iqc_inspection_request_inbound_lot ON quality.inspection_request (inbound_lot_id)
    WHERE inspection_type_code = 'IQC' AND inbound_lot_id IS NOT NULL AND status_code <> 'CANCELLED';
