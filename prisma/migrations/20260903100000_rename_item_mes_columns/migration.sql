-- 품목의 MES 확장 컬럼 셋을 계약이 지정한 이름으로 되맞춘다.
--
-- 계약이 `x-source-column` 으로 «저장 컬럼 이름»을 직접 적는다. 셋이 어긋나 있다.
--
--   계약                          물리(지금)
--   mes_category_code             recycle_type_code
--   default_lot_storage_uom_id    lot_storage_uom_id
--   default_production_lot_size   default_lot_size
--
-- 옛 이름은 계약에 0회, 소스에 0회 나온다(실측 2026-09-03) — 읽는 주체가 없다.
--
-- ⛔ DROP + ADD 가 아니라 RENAME 이다. 데이터가 그대로 남으므로 하위 호환 규칙
-- (CLAUDE.md 「컬럼 삭제는 두 릴리스로 분리」)이 막으려는 사고 — 배포된 코드가 없는
-- 컬럼을 읽는 일 — 가 일어나지 않는다. 지금 이름을 맞춰 두지 않으면 「계약이 적은
-- 컬럼과 실제 컬럼이 다르다」가 영구 부채로 남는다.
--
-- mes_category_code 는 신재와 재생재를 가르는 MES 안쪽 구분이다(DR-006 확정).
-- 기간계로 보내지 않는다 — 기간계에는 신재와 똑같이 처리한다.

ALTER TABLE mdm.item RENAME COLUMN recycle_type_code  TO mes_category_code;
ALTER TABLE mdm.item RENAME COLUMN lot_storage_uom_id TO default_lot_storage_uom_id;
ALTER TABLE mdm.item RENAME COLUMN default_lot_size   TO default_production_lot_size;

ALTER TABLE mdm.item RENAME CONSTRAINT item_lot_storage_uom_id_fkey
    TO item_default_lot_storage_uom_id_fkey;
ALTER TABLE mdm.item RENAME CONSTRAINT ck_item_default_lot_size
    TO ck_item_default_production_lot_size;

COMMENT ON COLUMN mdm.item.mes_category_code IS
  '신재와 재생재를 가르는 MES 안쪽 구분. 기간계로 보내지 않는다 (DR-006).';
COMMENT ON COLUMN mdm.item.default_lot_storage_uom_id IS
  '자재 LOT 보관 단위 기본값. 특이 시 LOT 별로 개별 설정한다 (확정 QA #14).';
COMMENT ON COLUMN mdm.item.default_production_lot_size IS
  '생산 LOT 기본크기. 화면이 이 값을 채우고 사용자가 고칠 수 있다 (REQ-PR-0008 · E26).';
