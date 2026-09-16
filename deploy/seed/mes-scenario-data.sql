-- OMF MES 시나리오 테스트·교육용 기반 데이터 (Samjin LND Vina · PL13)
--
-- 선행: 표준 시드(node dist/seed.js) → mes-initial-data.sql. 이 파일은 그 위에 얹는다.
-- ⛔ 운영(하노이) DB 에 넣지 않는다. 재실행해도 이미 있는 것은 건너뛴다.
--
-- 만드는 것
--   S240 위치 1  — 기초 데이터에 mdm.location 이 0건이라 재고 잔량·입고 모두 위치가 없으면 막힌다
--   제품 LOT 10  — 제품입고 전표 GR-SEED-0001 한 건으로 S240 에 전기한다(원장 → 잔량)
--   자재 P/O 5   — PO-SEED-0001~0005, 건마다 라인 1
--   제품 OQC 기준 10 — 출하작업지시 편성이 검사 의뢰를 자동으로 만들 수 있게(아래 절)
--   관리자 계정 준비 — 데이터 범위(사업부+PL13) · 검사자 연결(901463) — 제품 출하 화면 4곳이 요구한다
--
-- 번호는 SEED 접두어다 — 서버 채번(PO-YYYYMMDD-SEQ4 등)과 겹치지 않아 채번 카운터를 건드리지 않는다.
-- 발주일·business_date 는 적재 당일의 PL13 현지 날짜(plant.timezone_code)다.

\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif

\echo 'OMF MES scenario seed: 원천 값·사전조건'
BEGIN;

CREATE TEMP TABLE scenario_stock_source (
  seq integer PRIMARY KEY,
  lot_no text NOT NULL,
  item_code text NOT NULL,
  qty numeric(20, 6) NOT NULL
) ON COMMIT DROP;

-- 제품(계정 10) · EA · PL13 BOM 보유. 수량은 100~1000 에서 고른 고정값이다 — 재실행·교재 캡처가 같도록.
INSERT INTO scenario_stock_source (seq, lot_no, item_code, qty)
VALUES
  (1, 'SEED-S240-0001', 'F534F50200', 480),
  (2, 'SEED-S240-0002', 'F536A42301AP', 250),
  (3, 'SEED-S240-0003', 'F534200504AP', 730),
  (4, 'SEED-S240-0004', 'F5340WY14DAP', 120),
  (5, 'SEED-S240-0005', 'F5360WY106AP', 910),
  (6, 'SEED-S240-0006', 'F5390WY106AP', 360),
  (7, 'SEED-S240-0007', 'F537A41001AP', 640),
  (8, 'SEED-S240-0008', 'F540U41000AP', 850),
  (9, 'SEED-S240-0009', 'A3EP03Y709AP', 200),
  (10, 'SEED-S240-0010', 'S511A56300AP', 570);

CREATE TEMP TABLE scenario_po_source (
  seq integer PRIMARY KEY,
  purchase_order_no text NOT NULL,
  item_code text NOT NULL,
  supplier_code text NOT NULL,
  qty numeric(20, 6) NOT NULL
) ON COMMIT DROP;

-- 원자재(계정 30) · EA · 위 제품들의 BOM 구성품. 공급사는 ERP bp_type=S(SUPPLIER 역할).
INSERT INTO scenario_po_source (seq, purchase_order_no, item_code, supplier_code, qty)
VALUES
  (1, 'PO-SEED-0001', 'PPAD003200', '100605', 320),
  (2, 'PO-SEED-0002', 'PBOX000100', '100889', 150),
  (3, 'PO-SEED-0003', 'BAG1000200', '100626', 480),
  (4, 'PO-SEED-0004', 'A5C1M50101', '100824', 240),
  (5, 'PO-SEED-0005', 'V144030603', '100569', 400);

CREATE TEMP TABLE scenario_context ON COMMIT DROP AS
SELECT plant.plant_id,
       plant.legal_entity_id,
       plant.business_unit_id AS plant_business_unit_id,
       warehouse.warehouse_id,
       warehouse.business_unit_id AS warehouse_business_unit_id,
       (now() AT TIME ZONE plant.timezone_code)::date AS business_date,
       (SELECT app_user_id FROM app.app_user WHERE login_id = 'admin') AS admin_user_id
FROM mdm.legal_entity entity
JOIN mdm.plant plant
  ON plant.legal_entity_id = entity.legal_entity_id AND plant.plant_code = 'PL13'
JOIN mdm.warehouse warehouse
  ON warehouse.plant_id = plant.plant_id AND warehouse.warehouse_code = 'S240'
WHERE entity.legal_entity_code = 'SAMJIN_LND_VINA';

DO $$
DECLARE
  context_count integer;
  missing text;
BEGIN
  SELECT count(*) INTO context_count
  FROM scenario_context
  WHERE plant_business_unit_id IS NOT NULL AND warehouse_business_unit_id IS NOT NULL;
  IF context_count <> 1 THEN
    RAISE EXCEPTION 'SAMJIN_LND_VINA/PL13/S240 이 없습니다 — mes-initial-data.sql 을 먼저 적재하세요';
  END IF;

  SELECT string_agg(source.item_code, ', ' ORDER BY source.seq) INTO missing
  FROM scenario_stock_source source
  LEFT JOIN mdm.item item
    ON item.item_code = source.item_code AND item.item_type_code = 'FINISHED'
  WHERE item.item_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '제품(FINISHED) 품목이 없습니다: % — mes-initial-data.sql 을 먼저 적재하세요', missing;
  END IF;

  SELECT string_agg(source.item_code, ', ' ORDER BY source.seq) INTO missing
  FROM scenario_po_source source
  LEFT JOIN mdm.item item
    ON item.item_code = source.item_code AND item.item_type_code = 'RAW_MATERIAL'
  WHERE item.item_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '원자재(RAW_MATERIAL) 품목이 없습니다: %', missing;
  END IF;

  SELECT string_agg(source.supplier_code, ', ' ORDER BY source.seq) INTO missing
  FROM scenario_po_source source
  WHERE NOT EXISTS (
    SELECT 1
    FROM mdm.partner partner
    JOIN mdm.partner_role role
      ON role.partner_id = partner.partner_id AND role.role_type_code = 'SUPPLIER'
    WHERE partner.partner_code = source.supplier_code
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'SUPPLIER 역할의 거래처가 없습니다: %', missing;
  END IF;

  SELECT string_agg(expected.group_code || '/' || expected.code, ', ') INTO missing
  FROM (VALUES ('LOT_TYPE', 'PRODUCT'), ('RECEIPT_TYPE', 'PRODUCT')) expected(group_code, code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM mdm.code_group code_group
    JOIN mdm.code_value code_value ON code_value.code_group_id = code_group.code_group_id
    WHERE code_group.group_code = expected.group_code AND code_value.code = expected.code
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '표준 시드 코드값이 없습니다: % — node dist/seed.js 를 먼저 실행하세요', missing;
  END IF;
END $$;

\echo 'OMF MES scenario seed: S240 위치'
-- 활성 위치가 이미 있으면 만들지 않는다 — 긴급 직행·재등록은 창고의 활성 위치가 «정확히 하나»일 때만
-- 도착지를 정한다(src/logistics/destination-location.ts).
INSERT INTO mdm.location
  (warehouse_id, location_code, location_name, location_type_code, created_by)
SELECT context.warehouse_id, 'S240-01', '자재창고 기본 위치', 'DEFAULT', context.admin_user_id
FROM scenario_context context
WHERE NOT EXISTS (
  SELECT 1 FROM mdm.location location
  WHERE location.warehouse_id = context.warehouse_id AND location.is_active
)
ON CONFLICT (warehouse_id, location_code) DO NOTHING;

\echo 'OMF MES scenario seed: 제품 기초재고 (GR-SEED-0001)'
-- 기초재고는 제품입고(PRODUCT) 전표로 싣는다. 재고 조정은 서버가 «없는 재고 차원»을 만들지 않아
-- (adjustment-posting.ts) 서버가 걸을 수 없는 길이 된다. 적치 지시는 만들지 않는다 — 물건이 이미
-- 제자리에 있어 현장 화면에 유령 작업만 남는다.
DO $$
DECLARE
  context scenario_context%ROWTYPE;
  target_location_id bigint;
  receipt_id bigint;
  transaction_id bigint;
  line_count integer;
BEGIN
  -- 원장은 UPDATE·DELETE 가 트리거로 막혀 있어 두 번 전기하면 되돌릴 수 없다 — 전표 번호로 건너뛴다.
  IF EXISTS (SELECT 1 FROM logistics.goods_receipt WHERE goods_receipt_no = 'GR-SEED-0001') THEN
    RAISE NOTICE 'GR-SEED-0001 이 이미 있어 기초재고를 건너뜁니다';
    RETURN;
  END IF;

  SELECT * INTO context FROM scenario_context;

  IF EXISTS (
    SELECT 1 FROM trace.lot lot
    JOIN scenario_stock_source source ON source.lot_no = lot.lot_no
    WHERE lot.plant_id = context.plant_id
  ) THEN
    RAISE EXCEPTION 'GR-SEED-0001 없이 SEED-S240 LOT 이 이미 있습니다 — 수동으로 만든 흔적을 정리한 뒤 다시 실행하세요';
  END IF;

  SELECT location_id INTO target_location_id
  FROM mdm.location
  WHERE warehouse_id = context.warehouse_id AND is_active
  ORDER BY (location_code = 'S240-01') DESC, location_id
  LIMIT 1;
  IF target_location_id IS NULL THEN
    RAISE EXCEPTION 'S240 에 활성 위치가 없습니다';
  END IF;

  INSERT INTO logistics.goods_receipt
    (goods_receipt_no, receipt_type_code, plant_id, warehouse_id, receipt_datetime,
     status_code, remarks, created_by)
  VALUES
    ('GR-SEED-0001', 'PRODUCT', context.plant_id, context.warehouse_id, now(),
     'POSTED', '시나리오·교육용 기초재고 (mes-scenario-data.sql)', context.admin_user_id)
  RETURNING goods_receipt_id INTO receipt_id;

  -- LOT_SOURCE_TYPE 에 «기초재고» 값이 없다. 원천 값은 source_id 가 가리키는 표를 이름한다는 계약
  -- 규약(공유계약 A-16)을 따라 이 입고 전표를 가리킨다 — 입하·재생재·작업지시 전용 흐름에는 타지 않는다.
  INSERT INTO trace.lot
    (lot_no, item_id, lot_type_code, plant_id, initial_qty, uom_id,
     source_type_code, source_id, status_code, remarks, created_by)
  SELECT source.lot_no, item.item_id, 'PRODUCT', context.plant_id, source.qty, item.base_uom_id,
         'GOODS_RECEIPT', receipt_id, 'NORMAL', '시나리오·교육용 기초재고', context.admin_user_id
  FROM scenario_stock_source source
  JOIN mdm.item item ON item.item_code = source.item_code
  ORDER BY source.seq;

  INSERT INTO inventory.inventory_transaction
    (business_date, transaction_no, transaction_type_code, plant_id, occurred_at,
     source_document_type_code, source_document_id, status_code, idempotency_key, created_by)
  VALUES
    (context.business_date, 'GR-SEED-0001', 'GOODS_RECEIPT', context.plant_id, now(),
     'GOODS_RECEIPT', receipt_id, 'POSTED', 'GOODS_RECEIPT:GR-SEED-0001', context.admin_user_id)
  RETURNING inventory_transaction_id INTO transaction_id;

  INSERT INTO inventory.inventory_transaction_line
    (inventory_transaction_id, business_date, line_no, item_id, lot_id, qty, uom_id,
     to_warehouse_id, to_location_id, to_quality_status_code, to_inventory_status_code,
     ownership_type_code, to_qty_after_transaction, created_by)
  SELECT transaction_id, context.business_date, source.seq, lot.item_id, lot.lot_id, source.qty,
         lot.uom_id, context.warehouse_id, target_location_id, 'NORMAL', 'AVAILABLE',
         'OWNED', source.qty, context.admin_user_id
  FROM scenario_stock_source source
  JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = source.lot_no;

  -- 조직 축은 서버 posting 과 같이 창고에서 읽는다(법인은 공장, 사업부는 창고).
  INSERT INTO inventory.inventory_balance
    (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id, lot_id,
     quality_status_code, inventory_status_code, ownership_type_code, on_hand_qty, uom_id,
     last_transaction_at)
  SELECT context.legal_entity_id, context.warehouse_business_unit_id, context.plant_id,
         line.to_warehouse_id, line.to_location_id, line.item_id, line.lot_id,
         line.to_quality_status_code, line.to_inventory_status_code, line.ownership_type_code,
         line.qty, line.uom_id, now()
  FROM inventory.inventory_transaction_line line
  WHERE line.inventory_transaction_id = transaction_id
    AND line.business_date = context.business_date;

  INSERT INTO logistics.goods_receipt_line
    (goods_receipt_id, line_no, item_id, lot_id, receipt_qty, uom_id, quality_status_code,
     inventory_status_code, destination_location_id, inventory_transaction_line_id, created_by)
  SELECT receipt_id, line.line_no, line.item_id, line.lot_id, line.qty, line.uom_id,
         line.to_quality_status_code, line.to_inventory_status_code, line.to_location_id,
         line.inventory_transaction_line_id, context.admin_user_id
  FROM inventory.inventory_transaction_line line
  WHERE line.inventory_transaction_id = transaction_id
    AND line.business_date = context.business_date;
  GET DIAGNOSTICS line_count = ROW_COUNT;

  RAISE NOTICE '기초재고 LOT %개를 S240 에 전기했습니다 (business_date=%)',
    line_count, context.business_date;
END $$;

\echo 'OMF MES scenario seed: 자재 P/O (PO-SEED-0001~0005)'
-- 서버가 P/O 에 쓰는 상태는 REGISTERED 하나다(purchase-order.service.ts). 이미 있는 번호는 건너뛰고
-- 새로 들어간 헤더에만 라인을 붙인다.
WITH new_order AS (
  INSERT INTO logistics.purchase_order
    (purchase_order_no, supplier_id, business_unit_id, plant_id, order_date,
     expected_receipt_date, status_code, created_by)
  SELECT source.purchase_order_no, supplier.partner_id, context.plant_business_unit_id,
         context.plant_id, context.business_date, context.business_date + 7, 'REGISTERED',
         context.admin_user_id
  FROM scenario_po_source source
  CROSS JOIN scenario_context context
  JOIN mdm.partner supplier ON supplier.partner_code = source.supplier_code
  ORDER BY source.seq
  ON CONFLICT (purchase_order_no) DO NOTHING
  RETURNING purchase_order_id, purchase_order_no, created_by
)
INSERT INTO logistics.purchase_order_line
  (purchase_order_id, line_no, item_id, ordered_qty, uom_id, created_by)
SELECT new_order.purchase_order_id, 1, item.item_id, source.qty, item.base_uom_id,
       new_order.created_by
FROM new_order
JOIN scenario_po_source source ON source.purchase_order_no = new_order.purchase_order_no
JOIN mdm.item item ON item.item_code = source.item_code;

\echo 'OMF MES scenario seed: 검증'
-- 교육 중 출고·이동·입하가 일어난 뒤 재실행해도 참이어야 하는 불변식만 본다
-- (잔량이 S240 에 그대로 있다거나 P/O 가 아직 열려 있다는 것은 보지 않는다).
DO $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*) INTO actual_count
  FROM mdm.location location
  JOIN scenario_context context ON context.warehouse_id = location.warehouse_id
  WHERE location.is_active;
  IF actual_count < 1 THEN
    RAISE EXCEPTION 'S240 활성 위치: 1개 이상이어야 하는데 %개', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM scenario_stock_source source
  JOIN scenario_context context ON true
  JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = source.lot_no
  JOIN mdm.item item ON item.item_id = lot.item_id AND item.item_code = source.item_code
  WHERE lot.lot_type_code = 'PRODUCT'
    AND lot.initial_qty = source.qty
    AND lot.initial_qty BETWEEN 100 AND 1000;
  IF actual_count <> 10 THEN
    RAISE EXCEPTION '제품 LOT: 10개여야 하는데 %개', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM logistics.goods_receipt receipt
  JOIN logistics.goods_receipt_line line ON line.goods_receipt_id = receipt.goods_receipt_id
  JOIN inventory.inventory_transaction_line ledger
    ON ledger.inventory_transaction_line_id = line.inventory_transaction_line_id
  JOIN trace.lot lot ON lot.lot_id = line.lot_id
  WHERE receipt.goods_receipt_no = 'GR-SEED-0001'
    AND ledger.lot_id = line.lot_id
    AND ledger.qty = lot.initial_qty
    AND ledger.to_warehouse_id = receipt.warehouse_id;
  IF actual_count <> 10 THEN
    RAISE EXCEPTION 'GR-SEED-0001 라인(원장 연결): 10개여야 하는데 %개', actual_count;
  END IF;

  -- 잔량은 원장의 결과다(C-1) — LOT 별 잔량 합이 원장 순합(도착 − 출발)과 같아야 한다.
  SELECT count(*) INTO actual_count
  FROM scenario_stock_source source
  JOIN scenario_context context ON true
  JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = source.lot_no
  WHERE coalesce((
          SELECT sum(balance.on_hand_qty) FROM inventory.inventory_balance balance
          WHERE balance.lot_id = lot.lot_id), 0)
     <> coalesce((
          SELECT sum(CASE WHEN ledger.to_location_id IS NOT NULL THEN ledger.qty ELSE 0 END)
               - sum(CASE WHEN ledger.from_location_id IS NOT NULL THEN ledger.qty ELSE 0 END)
          FROM inventory.inventory_transaction_line ledger
          WHERE ledger.lot_id = lot.lot_id), 0);
  IF actual_count <> 0 THEN
    RAISE EXCEPTION '잔량과 원장 순합이 다른 LOT: %개', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM scenario_po_source source
  JOIN scenario_context context ON true
  JOIN logistics.purchase_order purchase_order
    ON purchase_order.purchase_order_no = source.purchase_order_no
   AND purchase_order.plant_id = context.plant_id
  JOIN mdm.partner supplier
    ON supplier.partner_id = purchase_order.supplier_id
   AND supplier.partner_code = source.supplier_code
  WHERE (SELECT count(*) FROM logistics.purchase_order_line line
         WHERE line.purchase_order_id = purchase_order.purchase_order_id) = 1
    AND EXISTS (
      SELECT 1 FROM logistics.purchase_order_line line
      JOIN mdm.item item ON item.item_id = line.item_id
      WHERE line.purchase_order_id = purchase_order.purchase_order_id
        AND item.item_code = source.item_code
        AND line.ordered_qty BETWEEN 100 AND 500
    );
  IF actual_count <> 5 THEN
    RAISE EXCEPTION '자재 P/O(라인 1개·수량 100~500): 5건이어야 하는데 %건', actual_count;
  END IF;
END $$;

SELECT lot.lot_no, item.item_code, item.item_name, trim_scale(lot.initial_qty) AS initial_qty,
       trim_scale(coalesce(sum(balance.on_hand_qty)
         FILTER (WHERE balance.warehouse_id = context.warehouse_id), 0)) AS s240_on_hand
FROM scenario_stock_source source
JOIN scenario_context context ON true
JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = source.lot_no
JOIN mdm.item item ON item.item_id = lot.item_id
LEFT JOIN inventory.inventory_balance balance ON balance.lot_id = lot.lot_id
GROUP BY source.seq, lot.lot_no, item.item_code, item.item_name, lot.initial_qty
ORDER BY source.seq;

SELECT purchase_order.purchase_order_no, purchase_order.order_date,
       supplier.partner_code || ' ' || supplier.partner_name AS supplier,
       item.item_code, item.item_name, trim_scale(line.ordered_qty) AS ordered_qty,
       trim_scale(line.received_qty) AS received_qty
FROM scenario_po_source source
JOIN logistics.purchase_order purchase_order
  ON purchase_order.purchase_order_no = source.purchase_order_no
JOIN mdm.partner supplier ON supplier.partner_id = purchase_order.supplier_id
JOIN logistics.purchase_order_line line
  ON line.purchase_order_id = purchase_order.purchase_order_id
JOIN mdm.item item ON item.item_id = line.item_id
ORDER BY source.seq;

\echo 'OMF MES scenario seed: 제품 출하검사(OQC) 기준'
-- ⭐ **없으면 출하작업지시 편성이 400 으로 막힌다.** 편성(`POST /logistics/shipment-requests`)이
--    검사 필수 라인의 품목마다 OQC 의뢰를 만드는데, 그때 「그 날짜에 유효한 기준 버전」을
--    요구한다. 0 건이든 2 건 이상이든 `STATE_LOCKED` 로 거절한다 — 라인의
--    `shipping_inspection_required` 가 이미 「검사 불요」를 뜻하므로, 필수라고 해 놓고 기준이
--    없는 것은 마스터 결손이고 조용히 넘기면 그 출하의 검사 판정이 영영 `PENDING` 에 갇힌다.
-- ⛔ 위 기초재고 10건의 제품 품목 «전부»에 건다 — 어느 것으로 시나리오를 돌려도 막히지 않게.
-- ⚠ 값은 코드 그룹의 살아 있는 것만 쓴다(`INSPECTION_SAMPLING_METHOD`·`INSPECTION_FREQUENCY`).
--   물리에 CHECK 가 없어 아무 문자열이나 들어가므로 여기서 지킨다.
INSERT INTO quality.inspection_plan
  (inspection_plan_code, inspection_plan_name, item_id, inspection_type_code, is_active, created_by)
SELECT 'OQC-SEED-' || item.item_code,
       item.item_name || ' 출하검사 기준',
       item.item_id,
       'OQC',
       true,
       context.admin_user_id
FROM scenario_stock_source source
JOIN mdm.item item ON item.item_code = source.item_code
CROSS JOIN scenario_context context
WHERE NOT EXISTS (
  SELECT 1 FROM quality.inspection_plan plan
  WHERE plan.item_id = item.item_id AND plan.inspection_type_code = 'OQC'
);

-- 유효기간은 열어 둔다(`effective_to` NULL) — 시나리오를 언제 돌려도 「그 날짜에 유효」해야 한다.
-- ⛔ 기준당 «정확히 하나»여야 한다. 둘이면 서버가 고르지 않고 400 으로 막는다.
INSERT INTO quality.inspection_plan_version
  (inspection_plan_id, plan_version, effective_from, effective_to,
   sampling_method_code, inspection_frequency_code, status_code, created_by)
SELECT plan.inspection_plan_id, 1, DATE '2020-01-01', NULL,
       'FULL_INSPECTION', 'PRODUCTION_LOT', 'CONFIRMED', context.admin_user_id
FROM quality.inspection_plan plan
CROSS JOIN scenario_context context
WHERE plan.inspection_plan_code LIKE 'OQC-SEED-%'
  AND NOT EXISTS (
    SELECT 1 FROM quality.inspection_plan_version version
    WHERE version.inspection_plan_id = plan.inspection_plan_id
  );

SELECT plan.inspection_plan_code, item.item_code, version.plan_version,
       version.effective_from, version.status_code, version.sampling_method_code
FROM quality.inspection_plan plan
JOIN mdm.item item ON item.item_id = plan.item_id
JOIN quality.inspection_plan_version version
  ON version.inspection_plan_id = plan.inspection_plan_id
WHERE plan.inspection_plan_code LIKE 'OQC-SEED-%'
ORDER BY item.item_code;

\echo 'OMF MES scenario seed: 관리자 계정 준비(데이터 범위 · 검사자 연결)'
-- 제품 출하 시나리오를 관리자 계정 `admin` 하나로 돌리려면 기능 권한 말고도 둘이 더 있어야 한다.
-- 둘 다 파이널 루틴 SHIP-FINAL-01(2026-09-17)에서 «없어서 막혔던» 자리다.
--   A. 데이터 범위 — W-04-01 편성이 이행 공장에 대한 데이터 권한(`app.user_data_scope`)을 본다.
--      표준 시드는 관리자에게 범위를 주지 않아(0행) 첫 편성이 403(`fulfillmentPlantId`)이다.
--      ⚠ 공장만 넣으면 세션이 그 행을 버린다 — `session.service.ts` 는 `business_unit_id` 가 NULL 인
--        범위를 걸러 낸다. 반드시 공장의 사업부와 «함께» 넣는다.
--   B. 검사자 연결 — W-04-03 OQC 판정 저장은 검사자(작업자)를 요구한다. 관리자 웹은 사번 헤더를
--      싣지 않으므로 서버가 «계정에 연결된 작업자»(`mdm.worker.app_user_id`)로 푼다
--      (`inspection-result-write-rules.ts` resolveInspector). 연결이 없으면 400 이고, 계약에 연결
--      화면·API 가 없어 여기서 넣는다. 작업자는 시나리오 작업자 901463(기초데이터의 실재 사번).
--      ⛔ admin 에 이미 다른 작업자가 연결돼 있거나 901463 이 다른 계정에 묶여 있으면 건드리지 않는다.
-- 기능 권한(W-04-01·02·03·04·12 · W-01-13 · W-01-07)은 표준 시드 `seed.js` 의 ROLE_SYS_ADMIN 이 넣는다 —
-- 로더가 적용할 때마다 그것을 먼저 돌리므로 여기 적지 않는다(두 곳에 적으면 값이 갈린다).
DO $$
DECLARE
  worker_count integer;
BEGIN
  SELECT count(*) INTO worker_count FROM mdm.worker WHERE worker_no = '901463';
  IF worker_count <> 1 THEN
    RAISE EXCEPTION '작업자 901463 이 없습니다 — mes-initial-data.sql 을 먼저 적재하세요';
  END IF;
END $$;

INSERT INTO app.user_data_scope (app_user_id, business_unit_id, plant_id, created_by)
SELECT context.admin_user_id, context.plant_business_unit_id, context.plant_id, context.admin_user_id
FROM scenario_context context
WHERE context.admin_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM app.user_data_scope scope
    WHERE scope.app_user_id = context.admin_user_id
      AND scope.business_unit_id = context.plant_business_unit_id
      AND scope.plant_id = context.plant_id
  );

UPDATE mdm.worker worker
   SET app_user_id = context.admin_user_id,
       version_no = worker.version_no + 1,
       updated_by = context.admin_user_id
  FROM scenario_context context
 WHERE worker.worker_no = '901463'
   AND worker.app_user_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM mdm.worker linked WHERE linked.app_user_id = context.admin_user_id);

SELECT 'admin-data-scope' AS kind,
       count(*) FILTER (WHERE scope.business_unit_id = context.plant_business_unit_id AND scope.plant_id = context.plant_id) AS matched,
       count(*) AS total
FROM scenario_context context
LEFT JOIN app.user_data_scope scope ON scope.app_user_id = context.admin_user_id
GROUP BY context.admin_user_id
UNION ALL
SELECT 'admin-inspector(901463)',
       count(*) FILTER (WHERE worker.app_user_id = context.admin_user_id),
       count(*)
FROM scenario_context context
LEFT JOIN mdm.worker worker ON worker.worker_no = '901463'
GROUP BY context.admin_user_id;

\if :apply
COMMIT;
\echo 'OMF MES scenario seed committed'
\else
ROLLBACK;
\echo 'OMF MES scenario seed dry-run rolled back'
\endif
