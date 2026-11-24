-- 피처 014 자재 관리 LOT P/O 미리 생성(omf-all-around#349) — 몫 기록 표·묶음 만든 방식·품목 패키징 기본값. 기존 행은 바꾸지 않는다.

-- ① 자동 LOT 의 P/O 라인 몫 — 자동 생성 LOT 하나에 한 행. 받기·해제·분할이 LOT 원천 칸을 바꿔도 이 행은 그대로 남는다(R-1).
--    수량 칸은 두지 않는다 — 몫 수량은 늘 lot.initial_qty 다(출력 전 수정이 바꾸면 따라간다). 지우지 않는다(계산이 상태로 거른다).
CREATE TABLE trace.material_lot_po_plan (
    lot_id                  bigint      PRIMARY KEY REFERENCES trace.lot(lot_id),
    purchase_order_line_id  bigint      NOT NULL REFERENCES logistics.purchase_order_line(purchase_order_line_id),
    created_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE trace.material_lot_po_plan IS
  '자동 생성 자재 관리 LOT 의 P/O 라인 몫(피처 014 R-1) — 조회 때 P/O 남은 양만큼 만든 LOT 이 어느 라인 몫인지. 수동 LOT 은 행이 없다';
COMMENT ON COLUMN trace.material_lot_po_plan.purchase_order_line_id IS '만들 때 채운 P/O 라인 — 입하 마감 배정과는 따로다(배정은 발주일 순 그대로)';
CREATE INDEX ix_material_lot_po_plan_line ON trace.material_lot_po_plan (purchase_order_line_id);

-- ② 발행 묶음을 사람이 만들었나([만들기]) 조회가 만들었나(P/O 몫 자동 생성).
ALTER TABLE trace.material_lot_batch
    ADD COLUMN creation_mode_code varchar(10) NOT NULL DEFAULT 'MANUAL',
    ADD CONSTRAINT ck_material_lot_batch_creation_mode CHECK (creation_mode_code IN ('MANUAL', 'AUTO'));
COMMENT ON COLUMN trace.material_lot_batch.creation_mode_code IS 'MANUAL = 사람이 [만들기] · AUTO = 조회 때 P/O 몫만큼 자동 생성(라인마다 묶음, 나머지 LOT 은 따로 묶음)';

-- ③ 품목 패키징 기본값 — 자동 생성 LOT 에 복사한다(만든 뒤 바뀌어도 LOT 은 그대로).
--    「LOT 기본크기를 패키징 수량으로 나머지 없이 나눈다」는 서버 저장 검사다(기본크기가 보관 단위 값이라 DB 가 판정하지 않는다).
ALTER TABLE mdm.item
    ADD COLUMN default_package_uom_id bigint REFERENCES mdm.uom(uom_id),
    ADD COLUMN default_package_count integer,
    ADD CONSTRAINT ck_item_default_package CHECK (
        (default_package_uom_id IS NULL AND default_package_count IS NULL)
        OR (default_package_uom_id IS NOT NULL AND default_package_count IS NOT NULL AND default_package_count >= 1));
COMMENT ON COLUMN mdm.item.default_package_uom_id IS '자재 관리 LOT 패키징 단위 기본값(W-06-05) — default_package_count 와 함께 있거나 함께 비어야 한다';
COMMENT ON COLUMN mdm.item.default_package_count IS 'LOT 당 패키징 수량 기본값 — LOT 하나에 든 패키징 개수(정수 ≥ 1). 패키징당 수량 = LOT 수량 ÷ 이 값';
