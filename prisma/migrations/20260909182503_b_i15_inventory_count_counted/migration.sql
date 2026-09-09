-- I-15 · 계약 `InventoryCountLine.required` 의 `counted`를 물리에 보존한다.
-- `counted_qty = 0`은 실제 계수 0과 미실사를 구분하지 못하고 `counted_by`도 nullable이라
-- 기존 칸에서 도출할 수 없다. 추가만 · 완화 0 · 삭제 0 · 임의 백필 0. 결정 — 통보 273.
--
-- 사전 대조(적용 전 · 읽기만):
--   SELECT count(*) FROM inventory.inventory_count_line;
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='inventory' AND table_name='inventory_count_line'
--      AND column_name='counted'; -- 0

ALTER TABLE inventory.inventory_count_line
  ADD COLUMN counted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN inventory.inventory_count_line.counted IS
  '실제 계수 완료 여부. false면 counted_qty/counted_at/variance_qty는 의미 없는 자리다.';
