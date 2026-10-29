-- 외자 발주(PO_TYPE_CD = PO) 라인의 통관번호·순번 — ERP 함수 ufn_M_CC_DTL_GetCC 로 받아 구매입고 CC_NO·CC_SEQ_NO 에 싣는다.
-- 사용자 결정(2026-10-28): 한 발주 라인은 나눠 통관되지 않는다 — 한 번 받은 값을 그 라인의 입고마다 쓴다.
ALTER TABLE logistics.purchase_order_line
  ADD COLUMN erp_customs_clearance_no varchar(18),
  ADD COLUMN erp_customs_clearance_seq integer,
  ADD COLUMN erp_customs_clearance_fetched_at timestamptz;
