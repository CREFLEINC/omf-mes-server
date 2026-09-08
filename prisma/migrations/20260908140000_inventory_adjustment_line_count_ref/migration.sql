-- I-14 선행 커밋 · 추가 1 · 완화 0 · 삭제 0 — forward-only 이고 두 릴리스 규칙 미해당. 백필 0.
--
-- 사전 대조(마이그 «전» 개발 DB 실측 · 읽기만):
--   SELECT count(*) FROM inventory.inventory_adjustment_line;      -- → 0
--   SELECT count(*) FROM inventory.inventory_count_line;           -- → 0
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='inventory' AND table_name='inventory_adjustment_line'
--      AND column_name = 'inventory_count_line_id';                -- → 0행
--
-- 계약 `InventoryAdjustmentLine.inventoryCountLineId`(응답)와
-- `InventoryAdjustmentLineUpsert.inventoryCountLineId`(요청)가 둘 다 이 칸을 정의했는데
-- 담을 자리가 없다. ⛔ 버리지 않는다 — ⓐ 계약이 «읽기»에도 두어 화면이 되읽기를 기대하고
--    ⓑ I-15 실사 `:close` 의 「차이가 전부 조정됐나」 판정이 라인 대응을 요구한다.
--    헤더 축(`inventory_adjustment.inventory_count_id`)만으로는 「6건 중 4건만 조정」을 못 가른다.
-- ⛔ FK 제약 이름을 적지 않는다 — Prisma 기본형
--    `inventory_adjustment_line_inventory_count_line_id_fkey` 여야 `migrate diff` 가
--    드리프트를 내지 않는다(형제 FK 여섯이 전부 그 형태다).
ALTER TABLE inventory.inventory_adjustment_line
    ADD COLUMN inventory_count_line_id bigint
        REFERENCES inventory.inventory_count_line(inventory_count_line_id);

-- I-15 의 `:close` 가 「이 실사 라인이 조정됐나」를 이 축으로 돈다.
CREATE INDEX ix_inventory_adjustment_line_count_line
    ON inventory.inventory_adjustment_line(inventory_count_line_id);

COMMENT ON COLUMN inventory.inventory_adjustment_line.inventory_count_line_id IS
    '실사 차이에서 불러온 경우의 원천 라인. 계약 InventoryAdjustmentLine.inventoryCountLineId.';
