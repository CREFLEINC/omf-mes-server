-- 장부 P-120 보강. 추가·완화만이라 옛 코드와 함께 산다.

-- ① 정정에 한해 다섯 수량이 모두 0 이어도 된다 — 잘못 넣은 실적을 지우거나 다른 LOT 으로 옮기려면 원 실적을 0 으로
--    정정하고 새 실적을 등록한다. 원 실적(정정이 아닌 행)은 여전히 0 을 받지 않는다.
ALTER TABLE production.production_result DROP CONSTRAINT ck_production_result_nonzero;
ALTER TABLE production.production_result ADD CONSTRAINT ck_production_result_nonzero CHECK (
    corrects_production_result_id IS NOT NULL
    OR good_qty + defect_qty + hold_qty + scrap_qty + rework_qty > 0
);

-- ② 옛 정정본(LOT 배분 없이 만든 정정)에 배분을 채운다. LOT 수량을 잎(정정 안 된 실적)만 세면서 원본 몫이 빠지기
--    때문이다. 런타임 정정(`correction-lots.ts` 의 `originalShare`·`correctionAllocations`)과 같은 식이다:
--    기준 = 거슬러 올라가 처음 만나는 «배분 있는» 조상(id 순으로 돌아 앞 정정이 먼저 채워진다) ·
--    양품 0 이면 배분 없음 · 양품이 기준과 같으면 기준 배분 그대로 · 기준 LOT 이 하나면 그 LOT 에 기준 배분 + 양품 차이 ·
--    그 밖(여러 LOT 인데 양품이 바뀜, 차이로 음수가 됨)은 채우지 않고 건수만 NOTICE 로 남긴다.
DO $$
DECLARE
    c record;
    base_id bigint;
    base_good numeric;
    lots integer;
    qty numeric;
    skipped integer := 0;
    filled integer := 0;
BEGIN
    FOR c IN
        SELECT r.production_result_id, r.corrects_production_result_id, r.good_qty
          FROM production.production_result r
         WHERE r.corrects_production_result_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM production.production_result_lot_allocation a
                            WHERE a.production_result_id = r.production_result_id)
         ORDER BY r.production_result_id
    LOOP
        base_id := c.corrects_production_result_id;
        LOOP
            EXIT WHEN base_id IS NULL;
            SELECT COUNT(*) INTO lots FROM production.production_result_lot_allocation WHERE production_result_id = base_id;
            EXIT WHEN lots > 0;
            SELECT corrects_production_result_id INTO base_id FROM production.production_result WHERE production_result_id = base_id;
        END LOOP;
        CONTINUE WHEN base_id IS NULL OR c.good_qty = 0;
        SELECT good_qty INTO base_good FROM production.production_result WHERE production_result_id = base_id;
        IF c.good_qty = base_good THEN
            INSERT INTO production.production_result_lot_allocation (production_result_id, lot_id, allocated_qty, uom_id)
            SELECT c.production_result_id, a.lot_id, a.allocated_qty, a.uom_id
              FROM production.production_result_lot_allocation a WHERE a.production_result_id = base_id;
            filled := filled + 1;
        ELSIF lots = 1 THEN
            SELECT allocated_qty + c.good_qty - base_good INTO qty
              FROM production.production_result_lot_allocation WHERE production_result_id = base_id;
            IF qty < 0 THEN
                skipped := skipped + 1;
                CONTINUE;
            END IF;
            IF qty > 0 THEN
                INSERT INTO production.production_result_lot_allocation (production_result_id, lot_id, allocated_qty, uom_id)
                SELECT c.production_result_id, a.lot_id, qty, a.uom_id
                  FROM production.production_result_lot_allocation a WHERE a.production_result_id = base_id;
            END IF;
            filled := filled + 1;
        ELSE
            skipped := skipped + 1;
        END IF;
    END LOOP;
    RAISE NOTICE '옛 정정 배분 보정: 채움 % 건 · 채우지 못함(여러 LOT·양품 변경 또는 음수) % 건 — 장부 P-120 의 확인 SQL 로 그 LOT 을 확인한다', filled, skipped;
END $$;
