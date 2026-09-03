-- 품목의 LOT 관리 축을 코드형에서 boolean 으로 접는다 — 계약 `Item.lotControlled`
-- (설계 결정 2026-09-02 · 사본 6d03a44). 「관리 여부」 한 축뿐이고 «방식»을 가르는 값이
-- 계약·스펙·시드 어디에도 없었다 — 시드 LOT_CONTROL_TYPE 도 NONE·LOT 둘뿐이다.
--
-- 하위 호환으로 두 릴리스에 나눈다. 이 릴리스는 새 칸을 세우고 옛 칸 쓰기를 멈춘다 —
-- 서버가 더 이상 채우지 않으므로 NOT NULL 을 풀어야 저장이 된다. 삭제는 다음 릴리스.

ALTER TABLE mdm.item
    ADD COLUMN lot_controlled boolean NOT NULL DEFAULT false;

UPDATE mdm.item
   SET lot_controlled = (lot_control_type_code = 'LOT');

ALTER TABLE mdm.item
    ALTER COLUMN lot_control_type_code DROP NOT NULL;

COMMENT ON COLUMN mdm.item.lot_controlled IS
  'LOT 단위로 재고를 관리하는 품목인가. 계약 Item.lotControlled — lot_control_type_code 를 boolean 으로 접었다(설계 결정 2026-09-02).';
COMMENT ON COLUMN mdm.item.lot_control_type_code IS
  '⛔ 쓰지 않는다 — lot_controlled 로 접혔다. 다음 릴리스에서 삭제한다.';
