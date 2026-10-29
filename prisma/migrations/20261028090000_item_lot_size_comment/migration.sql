-- 사용자 결정(2026-10-28): 한 칸을 품목유형별로 함께 쓴다. API 이름은 defaultLotSize(장부 P-139).
-- 물리 이름은 계약 x-source-column 그대로 둔다 — RENAME 은 블루-그린 전환 중 옛 코드가 읽지 못한다.
COMMENT ON COLUMN mdm.item.default_production_lot_size IS
  '품목유형별 LOT 기본크기 — 반제품·제품은 생산 LOT, 원자재·부자재는 자재 LOT. 상품은 쓰지 않는다.';
