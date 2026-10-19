-- ERP BOM 구성품의 순번(CHILD_ITEM_SEQ)을 온 그대로 담는다 — ERP 가 구성품 하나를 고쳐 보낼 때
-- 어느 구성품인지 찾는 열쇠다. ERP 순번에는 0 이 있어(30개 BOM) 1 이상인 sequence_no 와 따로 둔다.
ALTER TABLE planning.bom_component ADD COLUMN erp_child_item_seq integer;

-- ERP BOM 에 소요량 0 인 구성품이 720행(모품목 421개) 있다. ERP 가 정본이라 그대로 받는다.
-- 수량 도메인(app.qty_t)이 이미 0 이상을 막으므로 «0 초과» 제약만 뗀다. 완화라 옛 코드에 영향이 없다.
ALTER TABLE planning.bom_component DROP CONSTRAINT bom_component_required_qty_check;
