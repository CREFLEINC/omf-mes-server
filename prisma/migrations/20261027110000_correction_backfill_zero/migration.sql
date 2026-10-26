-- 장부 P-120 보강. 추가·완화만이라 옛 코드와 함께 산다.

-- ① 정정에 한해 다섯 수량이 모두 0 이어도 된다 — 잘못 넣은 실적을 지우거나 다른 LOT 으로 옮기려면 원 실적을 0 으로
--    정정하고 새 실적을 등록한다. 원 실적(정정이 아닌 행)은 여전히 0 을 받지 않는다.
ALTER TABLE production.production_result DROP CONSTRAINT ck_production_result_nonzero;
ALTER TABLE production.production_result ADD CONSTRAINT ck_production_result_nonzero CHECK (
    corrects_production_result_id IS NOT NULL
    OR good_qty + defect_qty + hold_qty + scrap_qty + rework_qty > 0
);

-- ② 옛 정정본(LOT 배분 없이 만든 정정)에 원본 배분을 옮긴다. LOT 수량을 잎(정정 안 된 실적)만 세면서 원본 몫이
--    빠지기 때문이다. 정정이 처음부터 배분을 가졌다면 남았을 값으로 채운다:
--    양품이 같으면 원본 배분 그대로 · 원본 LOT 이 하나면 그 LOT 에 정정 양품 · 그 밖(여러 LOT 인데 양품이 바뀜)은
--    옮기지 않고 건수만 NOTICE 로 남긴다. 체인(정정의 정정)은 id 순으로 돌아 앞 정정이 먼저 채워진다.
DO $$
DECLARE
    c record;
    lots integer;
    skipped integer := 0;
    filled integer := 0;
BEGIN
    FOR c IN
        SELECT r.production_result_id, r.corrects_production_result_id AS original_id, r.good_qty, o.good_qty AS original_good
          FROM production.production_result r
          JOIN production.production_result o ON o.production_result_id = r.corrects_production_result_id
         WHERE NOT EXISTS (SELECT 1 FROM production.production_result_lot_allocation a
                            WHERE a.production_result_id = r.production_result_id)
         ORDER BY r.production_result_id
    LOOP
        SELECT COUNT(*) INTO lots FROM production.production_result_lot_allocation WHERE production_result_id = c.original_id;
        IF lots = 0 THEN
            CONTINUE;
        ELSIF c.good_qty = c.original_good THEN
            INSERT INTO production.production_result_lot_allocation (production_result_id, lot_id, allocated_qty, uom_id)
            SELECT c.production_result_id, a.lot_id, a.allocated_qty, a.uom_id
              FROM production.production_result_lot_allocation a WHERE a.production_result_id = c.original_id;
            filled := filled + 1;
        ELSIF lots = 1 THEN
            IF c.good_qty > 0 THEN
                INSERT INTO production.production_result_lot_allocation (production_result_id, lot_id, allocated_qty, uom_id)
                SELECT c.production_result_id, a.lot_id, c.good_qty, a.uom_id
                  FROM production.production_result_lot_allocation a WHERE a.production_result_id = c.original_id;
            END IF;
            filled := filled + 1;
        ELSE
            skipped := skipped + 1;
        END IF;
    END LOOP;
    RAISE NOTICE '옛 정정 배분 보정: 채움 % 건 · 옮기지 못함(여러 LOT·양품 변경) % 건 — 장부 P-120 의 확인 SQL 로 그 LOT 을 확인한다', filled, skipped;
END $$;
