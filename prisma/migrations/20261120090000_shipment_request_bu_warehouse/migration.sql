-- 피처 012 출하 지시서 사업부 단위·출고 창고 지정(omf-all-around#338) — 지시서에 사업부, 지시서 줄에 출고 창고(D-1·D-2).
-- 둘 다 NULL 허용이다 — 배포 전 지시서(공장 단위·창고 미지정 줄)가 공장 규칙으로 이어져야 한다(FR-026·027).
-- 새 지시서는 서비스가 사업부·줄 창고를 필수로 막고 fulfillment_plant_id 는 비운다(research R-1).

-- ① 지시서 사업부
ALTER TABLE logistics.shipment_request
  ADD COLUMN business_unit_id bigint REFERENCES mdm.business_unit (business_unit_id);
COMMENT ON COLUMN logistics.shipment_request.business_unit_id IS
  '지시서 사업부. 새 지시서는 필수(서비스). 배포 전 지시서는 이행 공장의 사업부로 채움, 공장에 사업부가 없으면 NULL(omf-all-around#338)';

-- ② 지시서 줄 출고 창고
ALTER TABLE logistics.shipment_request_line
  ADD COLUMN warehouse_id bigint REFERENCES mdm.warehouse (warehouse_id);
COMMENT ON COLUMN logistics.shipment_request_line.warehouse_id IS
  '출고 창고 — 피킹은 이 창고 잔액에서만. 새 줄은 필수(서비스). NULL = 배포 전 줄(창고 미지정, 지시서 공장 규칙)(omf-all-around#338)';

-- ③ 색인 — 사업부 범위 목록(W-04-02·POP)과 단말 줄 범위(PDA)
CREATE INDEX ix_shipment_request_business_unit_status ON logistics.shipment_request (business_unit_id, status_code);
CREATE INDEX ix_shipment_request_line_warehouse ON logistics.shipment_request_line (warehouse_id);

-- ④ 기존 지시서 채우기 — prisma/sql/shipment-request-bu-backfill.sql 과 같은 문장이다.
UPDATE logistics.shipment_request r
   SET business_unit_id = p.business_unit_id
  FROM mdm.plant p
 WHERE p.plant_id = r.fulfillment_plant_id AND r.business_unit_id IS NULL AND p.business_unit_id IS NOT NULL;
