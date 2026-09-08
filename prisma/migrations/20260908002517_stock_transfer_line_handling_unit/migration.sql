-- I-13 선행 커밋 · A4(plan.md §4 130행 · plan-api.md S05 149행) ·
-- forward-only 이고 두 릴리스 규칙(컬럼·테이블 삭제) 미해당 — 추가 1 · 완화 0 · 삭제 0 · 백필 0.
--
-- 사전 대조(마이그 «전» 개발 DB 실측 · 읽기만 · 2026-09-08):
--   SELECT count(*) FROM logistics.stock_transfer_line;                  -- → 0
--   SELECT count(*) FROM inventory.handling_unit;                        -- → 0
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='logistics' AND table_name='stock_transfer_line'
--      AND column_name='handling_unit_id';                               -- → 0행
--
-- 계약 `StockTransferLine.handlingUnitId`(「파렛트 단위로 옮긴 경우의 취급 단위」)와
-- `StockTransferLineUpsert.handlingUnitId` 가 이 칸을 요구하는데 물리에 없다.
-- ⭐ 화면 `M-01-10` §5-2 가 「파렛트 = 이동 그룹핑(재고 잠금 단위 아님)」을 ✓확정 QA #16
--    으로 못 박았고 원장 라인 `inventory_transaction_line.handling_unit_id` 는 이미 있다 —
--    문서 라인에만 그 축이 빠져 있었다.
-- ⛔ FK 제약 이름을 적지 않는다 — PostgreSQL 기본형
--    `stock_transfer_line_handling_unit_id_fkey` 가 Prisma 기본형이다.
--    `fk_*` 로 지으면 `migrate diff` 가 드리프트를 낸다.
-- ⚠ 참조 대상은 `inventory.handling_unit` 이다(`logistics` 아님).
-- ⚠ 원장 라인 쪽 `inventory_transaction_line.handling_unit_id` 에는 오늘도 FK 가 «없다»
--    (late FK 미적용). 그쪽은 이 슬라이스가 건드리지 않는다.
-- ⛔ 인덱스를 더하지 않는다 — 이 칸으로 «거르는» 질의가 계약 6건에 0건이고 표가 0행이다.
ALTER TABLE logistics.stock_transfer_line
    ADD COLUMN handling_unit_id bigint
        REFERENCES inventory.handling_unit(handling_unit_id);

COMMENT ON COLUMN logistics.stock_transfer_line.handling_unit_id IS
    '파렛트 단위로 옮긴 경우의 취급 단위. 계약 StockTransferLine.handlingUnitId. 파렛트는 «이동 그룹핑»이고 재고 잠금 단위가 아니다(M-01-10 §5-2 · ✓확정 QA #16) — 잔액은 inventory_balance 가 위치·LOT 축으로 진다.';
