-- OMF MES 시나리오 기준정보·시작 데이터 — PLAN-WO-01(ERP 생산오더 → 계획 → W/O → 배포 → 피킹)
--
-- 교육·테스트 서버를 초기화한 뒤 표준 시드와 `mes-initial-data.sql` 위에 얹는다.
-- `mes-scenario-data.sql`(제품 기초재고·자재 P/O)과는 **독립**이라 순서를 가리지 않는다.
--
-- 담는 것
--   A. 완성형 — 공정·생산라인·설비·위치·라우팅·BOM 공정 매핑까지 만들어, 받자마자 계획 전개부터
--      배포·피킹까지 돌 수 있다. ERP 생산오더 3건(PO-ERP-PLANWO-01~03).
--   B. 연습형 — 마스터를 사용자가 화면에서 직접 만들어 보는 용. 품목 둘의 BOM 구성품 시작 재고와
--      ERP 생산오더 2건(PO-ERP-PRACTICE-01~02)만 둔다. 공정·라우팅·설비·위치·매핑은 넣지 않는다.
--   C. 4M 보조(`-v with_4m_extras=false` 로 끈다) — 교대 둘, 금형 하나, 작업자 공정 자격 둘.
--
-- ⛔ id 를 적지 않는다. 공장·창고·품목·공정은 전부 코드로 찾는다.
-- ⛔ 검증 대상 업무 결과(생산계획·W/O·출고요청·피킹 지시·실적)는 만들지 않는다 — 시나리오가 만든다.
--
-- 재실행 안전: 전표 번호·코드로 건너뛰거나 ON CONFLICT DO NOTHING 이고, 매핑·관리수준은 같은 값을 다시 쓴다.
--
-- 실행(배포 디렉터리에서 기존 로더 재사용)
--   SQL_FILE=seed/mes-scenario-plan-wo-01.sql seed/load-mes-initial-data.sh --dry-run
--   SQL_FILE=seed/mes-scenario-plan-wo-01.sql seed/load-mes-initial-data.sh
-- 직접 실행
--   psql -X -U omf -d <db> -v apply=false < mes-scenario-plan-wo-01.sql   (검증 후 롤백)
--   psql -X -U omf -d <db> -v apply=true  < mes-scenario-plan-wo-01.sql
--   psql ... -v apply=true -v with_4m_extras=false < ...                  (4M 보조 제외)
--
-- 알려진 한계
--   * 조립 공정에 맞는 설비 유형이 코드 사전에 없다(EQUIPMENT_TYPE = INJECTION_MOLDING·PRESS·
--     WATER_HEATER). ASM-01 은 PRESS 로 넣는다 — 고객이 유형을 늘리면 그 값으로 바꾼다.
--   * LOT 유효기한을 비운다. 최소 잔존기한이 걸린 흐름에서는 피킹이 막힐 수 있다.
--   * LOT 원천 유형 `GOODS_RECEIPT` 는 코드그룹 `LOT_SOURCE_TYPE` 밖이다 — 기초재고용 값이 없어
--     원천 식별자가 가리키는 입고 전표를 이름한다(`mes-scenario-data.sql` 과 같은 규약).
--   * 연습형(B)은 마스터를 만들지 않으므로 그대로는 계획을 전개할 수 없다. 그것이 연습 과제다.

\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif
\if :{?with_4m_extras}
\else
\set with_4m_extras true
\endif

\echo 'PLAN-WO-01 seed: 원천 값·사전조건'
BEGIN;

CREATE TEMP TABLE pw_process (seq integer, process_code text, process_name text, process_type_code text) ON COMMIT DROP;
INSERT INTO pw_process VALUES
  (1, 'INJ', '사출', 'MACHINING'),
  (2, 'ASM', '조립', 'ASSEMBLY');

CREATE TEMP TABLE pw_equipment (seq integer, equipment_code text, equipment_name text, equipment_type_code text, process_code text) ON COMMIT DROP;
INSERT INTO pw_equipment VALUES
  (1, 'INJ-01', '사출기 1호기', 'INJECTION_MOLDING', 'INJ'),
  -- 조립 설비 유형이 사전에 없어 PRESS 로 둔다(위 「알려진 한계」).
  (2, 'ASM-01', '조립기 1호기', 'PRESS', 'ASM');

CREATE TEMP TABLE pw_location (seq integer, warehouse_code text, location_code text, location_name text) ON COMMIT DROP;
INSERT INTO pw_location VALUES
  (1, 'S220', 'S220-WIP', '재공 기본 위치'),
  (2, 'S210', 'S210-FG', '제품 기본 위치'),
  (3, 'S551', 'S551-SCRAP', '불량·폐기 기본 위치'),
  (4, 'S230', 'S230-01', '자재창고 기본 위치');

-- 관리수준을 ZONE 으로 올릴 창고(이미 ZONE 이상이면 그대로 둔다).
CREATE TEMP TABLE pw_zone_warehouse (warehouse_code text) ON COMMIT DROP;
INSERT INTO pw_zone_warehouse VALUES ('S220'), ('S210'), ('S551');

CREATE TEMP TABLE pw_routing_op (
  operation_seq integer, operation_name text, process_code text, standard_cycle_time_sec numeric, output_lot_required boolean
) ON COMMIT DROP;
INSERT INTO pw_routing_op VALUES
  (1, '사출', 'INJ', 30, false),
  (2, '조립', 'ASM', 45, true);

-- BOM 구성품을 공정에 묶는다. 이 매핑이 없으면 배포가 자재 출고요청을 만들지 않는다
-- (`release-plan.ts` 는 이 공정의 라인만 담는다).
CREATE TEMP TABLE pw_bom_map (component_item_code text, operation_seq integer, actual_use_process_code text) ON COMMIT DROP;
INSERT INTO pw_bom_map VALUES
  ('A5C1M50101', 1, 'INJ'),
  ('F534202801', 2, 'ASM'),
  ('F534202802', 2, 'ASM');

-- 시작 재고. block A 는 완성형 품목의 구성품, block B 는 연습형 두 품목의 구성품이다.
CREATE TEMP TABLE pw_stock (block text, seq integer, lot_no text, item_code text, qty numeric) ON COMMIT DROP;
INSERT INTO pw_stock VALUES
  ('A', 1, 'SEED-S230-A01', 'F534202801', 500),
  ('A', 2, 'SEED-S230-A02', 'F534202802', 500),
  ('A', 3, 'SEED-S230-A03', 'A5C1M50101', 500);

CREATE TEMP TABLE pw_practice_item (seq integer, item_code text, order_no text) ON COMMIT DROP;
INSERT INTO pw_practice_item VALUES
  (1, 'F536A42301AP', 'PO-ERP-PRACTICE-01'),
  (2, '11107-001WH0', 'PO-ERP-PRACTICE-02');

CREATE TEMP TABLE pw_order (seq integer, production_order_no text, item_code text, qty numeric) ON COMMIT DROP;
INSERT INTO pw_order VALUES
  (1, 'PO-ERP-PLANWO-01', 'F534F50200', 100),
  (2, 'PO-ERP-PLANWO-02', 'F534F50200', 100),
  (3, 'PO-ERP-PLANWO-03', 'F534F50200', 100);

CREATE TEMP TABLE pw_context ON COMMIT DROP AS
SELECT plant.plant_id,
       plant.legal_entity_id,
       plant.business_unit_id AS plant_business_unit_id,
       warehouse.warehouse_id AS material_warehouse_id,
       warehouse.business_unit_id AS warehouse_business_unit_id,
       (now() AT TIME ZONE plant.timezone_code)::date AS business_date,
       (date_trunc('month', (now() AT TIME ZONE plant.timezone_code)::date)
         + interval '1 month' - interval '1 day')::date AS month_end,
       (SELECT app_user_id FROM app.app_user WHERE login_id = 'admin') AS admin_user_id
FROM mdm.legal_entity entity
JOIN mdm.plant plant ON plant.legal_entity_id = entity.legal_entity_id AND plant.plant_code = 'PL13'
JOIN mdm.warehouse warehouse ON warehouse.plant_id = plant.plant_id AND warehouse.warehouse_code = 'S230'
WHERE entity.legal_entity_code = 'SAMJIN_LND_VINA';

-- 연습형 품목의 구성품도 시작 재고 대상이다 — BOM 에서 뽑아 붙인다(품목마다 구성품 수가 다르다).
INSERT INTO pw_stock (block, seq, lot_no, item_code, qty)
SELECT 'B',
       row_number() OVER (ORDER BY practice.seq, component.sequence_no),
       'SEED-S230-B' || lpad((row_number() OVER (ORDER BY practice.seq, component.sequence_no))::text, 2, '0'),
       component_item.item_code,
       500
FROM pw_practice_item practice
JOIN mdm.item parent ON parent.item_code = practice.item_code
JOIN planning.bom bom ON bom.parent_item_id = parent.item_id AND bom.is_default
JOIN planning.bom_component component ON component.bom_id = bom.bom_id
JOIN mdm.item component_item ON component_item.item_id = component.component_item_id;

DO $$
DECLARE
  missing text;
BEGIN
  IF (SELECT count(*) FROM pw_context) <> 1 THEN
    RAISE EXCEPTION 'SAMJIN_LND_VINA/PL13/S230 이 없습니다 — mes-initial-data.sql 을 먼저 적재하세요';
  END IF;
  IF (SELECT admin_user_id FROM pw_context) IS NULL THEN
    RAISE EXCEPTION 'admin 계정이 없습니다 — 표준 시드(node dist/seed.js)를 먼저 실행하세요';
  END IF;

  SELECT string_agg(source.warehouse_code, ', ') INTO missing
  FROM (SELECT warehouse_code FROM pw_location UNION SELECT warehouse_code FROM pw_zone_warehouse) source
  WHERE NOT EXISTS (
    SELECT 1 FROM mdm.warehouse warehouse
    JOIN pw_context context ON context.plant_id = warehouse.plant_id
    WHERE warehouse.warehouse_code = source.warehouse_code AND warehouse.is_active
  );
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'PL13 에 활성 창고가 없습니다: %', missing; END IF;

  -- 완성형 품목과 그 BOM. 배포가 읽는 것은 «기본 BOM» 하나다.
  IF NOT EXISTS (
    SELECT 1 FROM mdm.item item
    JOIN planning.bom bom ON bom.parent_item_id = item.item_id AND bom.is_default AND bom.status_code = 'CONFIRMED'
    WHERE item.item_code = 'F534F50200' AND item.item_type_code = 'FINISHED' AND item.is_active
  ) THEN
    RAISE EXCEPTION 'F534F50200 의 확정 기본 BOM 이 없습니다';
  END IF;

  SELECT string_agg(map.component_item_code, ', ') INTO missing
  FROM pw_bom_map map
  WHERE NOT EXISTS (
    SELECT 1 FROM planning.bom bom
    JOIN mdm.item parent ON parent.item_id = bom.parent_item_id AND parent.item_code = 'F534F50200'
    JOIN planning.bom_component component ON component.bom_id = bom.bom_id
    JOIN mdm.item component_item ON component_item.item_id = component.component_item_id
    WHERE bom.is_default AND component_item.item_code = map.component_item_code
  );
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'F534F50200 BOM 에 없는 구성품입니다: %', missing; END IF;

  -- 기본 라우팅은 품목당 하나다(uq_routing_default). 다른 코드가 이미 기본이면 INSERT 가 터지기
  -- 전에 사람이 읽을 말로 멈춘다.
  SELECT string_agg(routing.routing_code, ', ') INTO missing
  FROM planning.routing routing
  JOIN mdm.item item ON item.item_id = routing.item_id AND item.item_code = 'F534F50200'
  WHERE routing.is_default AND routing.routing_code <> 'RT-F534F50200-01';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'F534F50200 에 다른 기본 라우팅이 있습니다: % — 이 시드는 RT-F534F50200-01 을 기본으로 둡니다', missing;
  END IF;

  -- 피킹은 요청 단위(bom_component.uom_id)와 재고 단위(LOT = 품목 기본 단위)가 같은 후보만 집는다
  -- (`core/picking/allocation.ts`). 둘이 다르면 배포는 되는데 피킹이 «조용히» 결품이 된다.
  SELECT string_agg(component_item.item_code, ', ') INTO missing
  FROM planning.bom bom
  JOIN mdm.item parent ON parent.item_id = bom.parent_item_id AND parent.item_code = 'F534F50200'
  JOIN planning.bom_component component ON component.bom_id = bom.bom_id
  JOIN mdm.item component_item ON component_item.item_id = component.component_item_id
  WHERE bom.is_default AND component.uom_id <> component_item.base_uom_id;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'BOM 소요 단위가 품목 기본 단위와 다릅니다(피킹이 결품이 됩니다): %', missing;
  END IF;

  -- 연습형 품목: 기본 BOM 이 있고 구성품이 전부 원자재여야 한다(연습 과제가 자재 흐름이라서다).
  SELECT string_agg(practice.item_code, ', ') INTO missing
  FROM pw_practice_item practice
  WHERE NOT EXISTS (
    SELECT 1 FROM mdm.item item
    JOIN planning.bom bom ON bom.parent_item_id = item.item_id AND bom.is_default AND bom.status_code = 'CONFIRMED'
    WHERE item.item_code = practice.item_code AND item.is_active
  );
  IF missing IS NOT NULL THEN RAISE EXCEPTION '연습형 품목의 확정 기본 BOM 이 없습니다: %', missing; END IF;

  SELECT string_agg(DISTINCT stock.item_code, ', ') INTO missing
  FROM pw_stock stock
  WHERE NOT EXISTS (
    SELECT 1 FROM mdm.item item
    WHERE item.item_code = stock.item_code AND item.item_type_code = 'RAW_MATERIAL' AND item.is_active
  );
  IF missing IS NOT NULL THEN RAISE EXCEPTION '시작 재고 대상이 활성 원자재가 아닙니다: %', missing; END IF;

  -- 코드값. 스키마가 FK 를 걸지 않는 자리라 여기서 본다.
  SELECT string_agg(expected.group_code || '/' || expected.code, ', ') INTO missing
  FROM (VALUES
      ('PROCESS_TYPE', 'MACHINING'), ('PROCESS_TYPE', 'ASSEMBLY'),
      ('LINE_TYPE', 'LINE'),
      ('EQUIPMENT_TYPE', 'INJECTION_MOLDING'), ('EQUIPMENT_TYPE', 'PRESS'),
      ('EQUIPMENT_STATUS', 'IN_SERVICE'),
      ('MANAGEMENT_LEVEL', 'ZONE'),
      ('LOCATION_TYPE', 'DEFAULT'),
      ('MASTER_VERSION_STATUS', 'CONFIRMED'),
      ('LOT_TYPE', 'MATERIAL'), ('RECEIPT_TYPE', 'MATERIAL'),
      ('PRODUCTION_ORDER_STATUS', 'RECEIVED')
    ) expected(group_code, code)
  WHERE NOT EXISTS (
    SELECT 1 FROM mdm.code_group code_group
    JOIN mdm.code_value code_value ON code_value.code_group_id = code_group.code_group_id AND code_value.is_active
    WHERE code_group.group_code = expected.group_code AND code_value.code = expected.code
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '표준 시드 코드값이 없습니다: % — node dist/seed.js 를 먼저 실행하세요', missing;
  END IF;
END $$;

\echo 'PLAN-WO-01 seed: A 완성형 — 공정·라인·설비'
INSERT INTO mdm.process (process_code, process_name, process_type_code, created_by)
SELECT source.process_code, source.process_name, source.process_type_code, context.admin_user_id
FROM pw_process source CROSS JOIN pw_context context
ORDER BY source.seq
ON CONFLICT (process_code) DO NOTHING;

INSERT INTO mdm.production_line (plant_id, line_code, line_name, line_type_code, created_by)
SELECT context.plant_id, 'LINE-A', 'A 라인', 'LINE', context.admin_user_id
FROM pw_context context
ON CONFLICT (plant_id, line_code) DO NOTHING;

INSERT INTO mdm.equipment
  (plant_id, equipment_code, equipment_name, equipment_type_code, status_code, production_line_id, process_id, created_by)
SELECT context.plant_id, source.equipment_code, source.equipment_name, source.equipment_type_code, 'IN_SERVICE',
       line.production_line_id, process.process_id, context.admin_user_id
FROM pw_equipment source
CROSS JOIN pw_context context
JOIN mdm.production_line line ON line.plant_id = context.plant_id AND line.line_code = 'LINE-A'
JOIN mdm.process process ON process.process_code = source.process_code
ORDER BY source.seq
ON CONFLICT (plant_id, equipment_code) DO NOTHING;

\echo 'PLAN-WO-01 seed: A 완성형 — 창고 관리수준·위치'
-- 위치를 쓰려면 창고가 위치 단위를 관리해야 한다. 이미 ZONE 이상이면 건드리지 않는다.
UPDATE mdm.warehouse warehouse
   SET management_level_code = 'ZONE', version_no = warehouse.version_no + 1, updated_by = context.admin_user_id
  FROM pw_context context, pw_zone_warehouse target
 WHERE warehouse.plant_id = context.plant_id
   AND warehouse.warehouse_code = target.warehouse_code
   AND warehouse.management_level_code = 'WAREHOUSE';

INSERT INTO mdm.location (warehouse_id, location_code, location_name, location_type_code, created_by)
SELECT warehouse.warehouse_id, source.location_code, source.location_name, 'DEFAULT', context.admin_user_id
FROM pw_location source
CROSS JOIN pw_context context
JOIN mdm.warehouse warehouse ON warehouse.plant_id = context.plant_id AND warehouse.warehouse_code = source.warehouse_code
ORDER BY source.seq
ON CONFLICT (warehouse_id, location_code) DO NOTHING;

\echo 'PLAN-WO-01 seed: A 완성형 — 라우팅·공정 구성'
INSERT INTO planning.routing
  (item_id, routing_code, routing_version, status_code, is_default, effective_from, created_by)
SELECT item.item_id, 'RT-F534F50200-01', 1, 'CONFIRMED', true, DATE '2026-09-01', context.admin_user_id
FROM pw_context context
JOIN mdm.item item ON item.item_code = 'F534F50200'
ON CONFLICT (item_id, routing_code, routing_version) DO NOTHING;

INSERT INTO planning.routing_operation
  (routing_id, operation_seq, process_id, operation_name, mes_managed, material_input_managed,
   production_result_managed, inspection_managed, output_lot_required, equipment_required, mold_required,
   standard_cycle_time_sec, created_by)
SELECT routing.routing_id, source.operation_seq, process.process_id, source.operation_name,
       true, true, true, false, source.output_lot_required, true, false,
       source.standard_cycle_time_sec, context.admin_user_id
FROM pw_routing_op source
CROSS JOIN pw_context context
JOIN mdm.item item ON item.item_code = 'F534F50200'
JOIN planning.routing routing ON routing.item_id = item.item_id AND routing.routing_code = 'RT-F534F50200-01'
JOIN mdm.process process ON process.process_code = source.process_code
ORDER BY source.operation_seq
ON CONFLICT (routing_id, operation_seq) DO NOTHING;

\echo 'PLAN-WO-01 seed: A 완성형 — BOM 구성품 공정 매핑'
UPDATE planning.bom_component component
   SET routing_operation_id = operation.routing_operation_id,
       actual_use_process_id = actual_process.process_id,
       version_no = component.version_no + 1,
       updated_by = context.admin_user_id
  FROM pw_bom_map map, pw_context context,
       mdm.item parent, planning.bom bom, mdm.item component_item,
       planning.routing routing, planning.routing_operation operation, mdm.process actual_process
 WHERE parent.item_code = 'F534F50200'
   AND bom.parent_item_id = parent.item_id AND bom.is_default
   AND component.bom_id = bom.bom_id
   AND component_item.item_id = component.component_item_id
   AND component_item.item_code = map.component_item_code
   AND routing.item_id = parent.item_id AND routing.routing_code = 'RT-F534F50200-01'
   AND operation.routing_id = routing.routing_id AND operation.operation_seq = map.operation_seq
   AND actual_process.process_code = map.actual_use_process_code
   AND (component.routing_operation_id IS DISTINCT FROM operation.routing_operation_id
     OR component.actual_use_process_id IS DISTINCT FROM actual_process.process_id);

\echo 'PLAN-WO-01 seed: 시작 재고 (GR-SEED-0003 완성형 · GR-SEED-0004 연습형)'
DO $$
DECLARE
  context pw_context%ROWTYPE;
  target_location_id bigint;
  block_code text;
  receipt_no text;
  receipt_id bigint;
  transaction_id bigint;
  line_count integer;
BEGIN
  SELECT * INTO context FROM pw_context;
  SELECT location_id INTO target_location_id
  FROM mdm.location
  WHERE warehouse_id = context.material_warehouse_id AND location_code = 'S230-01' AND is_active;
  IF target_location_id IS NULL THEN
    RAISE EXCEPTION 'S230-01 활성 위치가 없습니다';
  END IF;

  FOR block_code, receipt_no IN SELECT * FROM (VALUES ('A', 'GR-SEED-0003'), ('B', 'GR-SEED-0004')) blocks(b, n)
  LOOP
    IF EXISTS (SELECT 1 FROM logistics.goods_receipt WHERE goods_receipt_no = receipt_no) THEN
      RAISE NOTICE '% 이 이미 있어 % 블록 시작 재고를 건너뜁니다', receipt_no, block_code;
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM trace.lot lot JOIN pw_stock stock ON stock.lot_no = lot.lot_no
      WHERE lot.plant_id = context.plant_id AND stock.block = block_code
    ) THEN
      RAISE EXCEPTION '% 없이 % 블록 LOT 이 이미 있습니다 — 수동으로 만든 흔적을 정리한 뒤 다시 실행하세요',
        receipt_no, block_code;
    END IF;

    INSERT INTO logistics.goods_receipt
      (goods_receipt_no, receipt_type_code, plant_id, warehouse_id, receipt_datetime, status_code, remarks, created_by)
    VALUES
      (receipt_no, 'MATERIAL', context.plant_id, context.material_warehouse_id, now(), 'POSTED',
       'PLAN-WO-01 시나리오 시작 재고 (' || block_code || ')', context.admin_user_id)
    RETURNING goods_receipt_id INTO receipt_id;

    INSERT INTO trace.lot
      (lot_no, item_id, lot_type_code, plant_id, initial_qty, uom_id, source_type_code, source_id, status_code, remarks, created_by)
    SELECT stock.lot_no, item.item_id, 'MATERIAL', context.plant_id, stock.qty, item.base_uom_id,
           'GOODS_RECEIPT', receipt_id, 'NORMAL', 'PLAN-WO-01 시작 재고', context.admin_user_id
    FROM pw_stock stock
    JOIN mdm.item item ON item.item_code = stock.item_code
    WHERE stock.block = block_code
    ORDER BY stock.seq;

    INSERT INTO inventory.inventory_transaction
      (business_date, transaction_no, transaction_type_code, plant_id, occurred_at,
       source_document_type_code, source_document_id, status_code, idempotency_key, created_by)
    VALUES
      (context.business_date, receipt_no, 'GOODS_RECEIPT', context.plant_id, now(),
       'GOODS_RECEIPT', receipt_id, 'POSTED', 'GOODS_RECEIPT:' || receipt_no, context.admin_user_id)
    RETURNING inventory_transaction_id INTO transaction_id;

    INSERT INTO inventory.inventory_transaction_line
      (inventory_transaction_id, business_date, line_no, item_id, lot_id, qty, uom_id,
       to_warehouse_id, to_location_id, to_quality_status_code, to_inventory_status_code,
       ownership_type_code, to_qty_after_transaction, created_by)
    SELECT transaction_id, context.business_date, stock.seq, lot.item_id, lot.lot_id, stock.qty, lot.uom_id,
           context.material_warehouse_id, target_location_id, 'NORMAL', 'AVAILABLE', 'OWNED', stock.qty,
           context.admin_user_id
    FROM pw_stock stock
    JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = stock.lot_no
    WHERE stock.block = block_code;

    INSERT INTO inventory.inventory_balance
      (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id, lot_id,
       quality_status_code, inventory_status_code, ownership_type_code, on_hand_qty, uom_id, last_transaction_at)
    SELECT context.legal_entity_id, context.warehouse_business_unit_id, context.plant_id,
           line.to_warehouse_id, line.to_location_id, line.item_id, line.lot_id,
           line.to_quality_status_code, line.to_inventory_status_code, line.ownership_type_code,
           line.qty, line.uom_id, now()
    FROM inventory.inventory_transaction_line line
    WHERE line.inventory_transaction_id = transaction_id AND line.business_date = context.business_date;

    INSERT INTO logistics.goods_receipt_line
      (goods_receipt_id, line_no, item_id, lot_id, receipt_qty, uom_id, quality_status_code,
       inventory_status_code, destination_location_id, inventory_transaction_line_id, created_by)
    SELECT receipt_id, line.line_no, line.item_id, line.lot_id, line.qty, line.uom_id,
           line.to_quality_status_code, line.to_inventory_status_code, line.to_location_id,
           line.inventory_transaction_line_id, context.admin_user_id
    FROM inventory.inventory_transaction_line line
    WHERE line.inventory_transaction_id = transaction_id AND line.business_date = context.business_date;

    GET DIAGNOSTICS line_count = ROW_COUNT;
    RAISE NOTICE '% 블록 LOT %개를 S230-01 에 전기했습니다 (business_date=%)', block_code, line_count, context.business_date;
  END LOOP;
END $$;

\echo 'PLAN-WO-01 seed: ERP 생산오더 (완성형 3 · 연습형 2)'
-- ⛔ 서버에는 생산오더를 만드는 경로가 없다(수신기 부재 · I-24 §2-2). ERP 수신을 모사한다.
INSERT INTO planning.production_order
  (production_order_no, business_unit_id, plant_id, item_id, order_qty, uom_id, status_code, due_date, remarks, created_by)
SELECT source.production_order_no, context.plant_business_unit_id, context.plant_id, item.item_id,
       source.qty, item.base_uom_id, 'RECEIVED', context.month_end,
       'PLAN-WO-01 시나리오 — ERP 수신 모사', context.admin_user_id
FROM pw_order source
CROSS JOIN pw_context context
JOIN mdm.item item ON item.item_code = source.item_code
ORDER BY source.seq
ON CONFLICT (production_order_no) DO NOTHING;

INSERT INTO planning.production_order
  (production_order_no, business_unit_id, plant_id, item_id, order_qty, uom_id, status_code, due_date, remarks, created_by)
SELECT practice.order_no, context.plant_business_unit_id, context.plant_id, item.item_id,
       100, item.base_uom_id, 'RECEIVED', context.month_end,
       'PLAN-WO-01 연습형 — 마스터를 화면에서 직접 만든 뒤 전개한다', context.admin_user_id
FROM pw_practice_item practice
CROSS JOIN pw_context context
JOIN mdm.item item ON item.item_code = practice.item_code
ORDER BY practice.seq
ON CONFLICT (production_order_no) DO NOTHING;

\if :with_4m_extras
\echo 'PLAN-WO-01 seed: C 4M 보조 — 교대·금형·작업자 자격'
INSERT INTO mdm.shift (plant_id, shift_code, shift_name, start_time, end_time, crosses_midnight, created_by)
SELECT context.plant_id, source.shift_code, source.shift_name, source.start_time, source.end_time,
       source.crosses_midnight, context.admin_user_id
FROM (VALUES
    ('DAY', '주간', TIME '08:00', TIME '17:00', false),
    ('NIGHT', '야간', TIME '20:00', TIME '05:00', true)
  ) source(shift_code, shift_name, start_time, end_time, crosses_midnight)
CROSS JOIN pw_context context
ON CONFLICT (plant_id, shift_code) DO NOTHING;

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected.group_code || '/' || expected.code, ', ') INTO missing
  FROM (VALUES ('TOOL_TYPE', 'MOLD'), ('MOLD_PM_TRIGGER_TYPE', 'NONE'), ('QUALIFICATION_TYPE', 'PROCESS_OPERATION')) expected(group_code, code)
  WHERE NOT EXISTS (
    SELECT 1 FROM mdm.code_group code_group
    JOIN mdm.code_value code_value ON code_value.code_group_id = code_group.code_group_id AND code_value.is_active
    WHERE code_group.group_code = expected.group_code AND code_value.code = expected.code
  );
  IF missing IS NOT NULL THEN RAISE EXCEPTION '4M 보조 코드값이 없습니다: %', missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM mdm.worker worker JOIN pw_context context ON context.plant_id = worker.plant_id
                  WHERE worker.worker_no = '901463' AND worker.is_active) THEN
    RAISE EXCEPTION 'PL13 의 재직 작업자 901463 이 없습니다';
  END IF;
END $$;

INSERT INTO mdm.mold
  (plant_id, mold_code, mold_name, cavity_count, status_code, tool_type_code, pm_trigger_type_code, created_by)
SELECT context.plant_id, 'MOLD-01', '사출 금형 1호', 1, 'IN_SERVICE', 'MOLD', 'NONE', context.admin_user_id
FROM pw_context context
ON CONFLICT (plant_id, mold_code) DO NOTHING;

-- 자격에는 유니크 제약이 없다 — 같은 공정 자격이 이미 유효하면 넣지 않는다.
INSERT INTO mdm.worker_qualification (worker_id, qualification_type_code, process_id, valid_from, created_by)
SELECT worker.worker_id, 'PROCESS_OPERATION', process.process_id, context.business_date, context.admin_user_id
FROM pw_process source
CROSS JOIN pw_context context
JOIN mdm.worker worker ON worker.plant_id = context.plant_id AND worker.worker_no = '901463'
JOIN mdm.process process ON process.process_code = source.process_code
WHERE NOT EXISTS (
  SELECT 1 FROM mdm.worker_qualification existing
  WHERE existing.worker_id = worker.worker_id
    AND existing.qualification_type_code = 'PROCESS_OPERATION'
    AND existing.process_id = process.process_id
)
ORDER BY source.seq;
\endif

\echo 'PLAN-WO-01 seed: 검증'
DO $$
DECLARE
  context pw_context%ROWTYPE;
  actual_count integer;
BEGIN
  SELECT * INTO context FROM pw_context;

  SELECT count(*) INTO actual_count FROM mdm.process WHERE process_code IN ('INJ', 'ASM');
  IF actual_count <> 2 THEN RAISE EXCEPTION '공정: 2개여야 하는데 %개', actual_count; END IF;

  SELECT count(*) INTO actual_count FROM mdm.equipment equipment
  WHERE equipment.plant_id = context.plant_id AND equipment.equipment_code IN ('INJ-01', 'ASM-01')
    AND equipment.status_code = 'IN_SERVICE' AND equipment.production_line_id IS NOT NULL AND equipment.process_id IS NOT NULL;
  IF actual_count <> 2 THEN RAISE EXCEPTION '설비(라인·공정 연결): 2대여야 하는데 %대', actual_count; END IF;

  SELECT count(*) INTO actual_count
  FROM pw_location source
  JOIN mdm.warehouse warehouse ON warehouse.plant_id = context.plant_id AND warehouse.warehouse_code = source.warehouse_code
  JOIN mdm.location location ON location.warehouse_id = warehouse.warehouse_id
   AND location.location_code = source.location_code AND location.is_active;
  IF actual_count <> 4 THEN RAISE EXCEPTION '위치: 4곳이어야 하는데 %곳', actual_count; END IF;

  SELECT count(*) INTO actual_count
  FROM planning.routing_operation operation
  JOIN planning.routing routing ON routing.routing_id = operation.routing_id AND routing.routing_code = 'RT-F534F50200-01'
  WHERE routing.status_code = 'CONFIRMED';
  IF actual_count <> 2 THEN RAISE EXCEPTION '라우팅 공정: 2건이어야 하는데 %건', actual_count; END IF;

  -- 배포가 자재 출고요청을 만들려면 구성품이 «이 라우팅의» 공정에 묶여 있어야 한다.
  SELECT count(*) INTO actual_count
  FROM planning.bom_component component
  JOIN planning.bom bom ON bom.bom_id = component.bom_id AND bom.is_default
  JOIN mdm.item parent ON parent.item_id = bom.parent_item_id AND parent.item_code = 'F534F50200'
  JOIN planning.routing_operation operation ON operation.routing_operation_id = component.routing_operation_id
  JOIN planning.routing routing ON routing.routing_id = operation.routing_id AND routing.routing_code = 'RT-F534F50200-01'
  WHERE component.actual_use_process_id IS NOT NULL;
  IF actual_count <> 3 THEN RAISE EXCEPTION 'BOM 공정 매핑: 3행이어야 하는데 %행', actual_count; END IF;

  -- 잔량은 원장의 결과다(C-1) — LOT 별 잔량 합이 원장 순합과 같아야 한다.
  SELECT count(*) INTO actual_count
  FROM pw_stock stock
  JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = stock.lot_no
  WHERE coalesce((SELECT sum(balance.on_hand_qty) FROM inventory.inventory_balance balance WHERE balance.lot_id = lot.lot_id), 0)
     <> coalesce((SELECT sum(CASE WHEN ledger.to_location_id IS NOT NULL THEN ledger.qty ELSE 0 END)
                       - sum(CASE WHEN ledger.from_location_id IS NOT NULL THEN ledger.qty ELSE 0 END)
                  FROM inventory.inventory_transaction_line ledger WHERE ledger.lot_id = lot.lot_id), 0);
  IF actual_count <> 0 THEN RAISE EXCEPTION '잔량과 원장 순합이 다른 LOT: %개', actual_count; END IF;

  SELECT count(*) INTO actual_count
  FROM pw_stock stock
  JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = stock.lot_no
  WHERE lot.initial_qty = stock.qty;
  IF actual_count <> (SELECT count(*) FROM pw_stock) THEN
    RAISE EXCEPTION '시작 재고 LOT: %개여야 하는데 %개', (SELECT count(*) FROM pw_stock), actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM planning.production_order
  WHERE production_order_no IN (SELECT production_order_no FROM pw_order UNION SELECT order_no FROM pw_practice_item)
    AND status_code = 'RECEIVED' AND plant_id = context.plant_id;
  IF actual_count <> 5 THEN RAISE EXCEPTION 'ERP 생산오더: 5건이어야 하는데 %건', actual_count; END IF;

  -- 검증 대상 업무 결과를 시드가 만들지 않았는지 본다.
  SELECT (SELECT count(*) FROM planning.production_plan)
       + (SELECT count(*) FROM production.work_order)
       + (SELECT count(*) FROM logistics.material_issue_request)
       + (SELECT count(*) FROM logistics.picking_order)
    INTO actual_count;
  IF actual_count <> 0 THEN
    RAISE NOTICE '계획·W/O·출고요청·피킹이 %건 있습니다 — 이 시드가 만든 것은 아닙니다(이전 실행 흔적)', actual_count;
  END IF;
END $$;

SELECT 'process' AS kind, process_code AS code, process_name AS name, process_type_code AS detail
FROM mdm.process WHERE process_code IN ('INJ', 'ASM')
UNION ALL
SELECT 'equipment', equipment.equipment_code, equipment.equipment_name, equipment.equipment_type_code
FROM mdm.equipment equipment JOIN pw_context context ON context.plant_id = equipment.plant_id
WHERE equipment.equipment_code IN ('INJ-01', 'ASM-01')
UNION ALL
SELECT 'location', location.location_code, warehouse.warehouse_code, warehouse.management_level_code
FROM mdm.location location
JOIN mdm.warehouse warehouse ON warehouse.warehouse_id = location.warehouse_id
JOIN pw_context context ON context.plant_id = warehouse.plant_id
JOIN pw_location source ON source.location_code = location.location_code
UNION ALL
SELECT 'routing-op', operation.operation_seq::text, operation.operation_name, process.process_code
FROM planning.routing_operation operation
JOIN planning.routing routing ON routing.routing_id = operation.routing_id AND routing.routing_code = 'RT-F534F50200-01'
JOIN mdm.process process ON process.process_id = operation.process_id
ORDER BY 1, 2;

SELECT stock.block, stock.lot_no, item.item_code, trim_scale(lot.initial_qty) AS initial_qty,
       trim_scale(balance.on_hand_qty) AS on_hand, trim_scale(balance.available_qty) AS available
FROM pw_stock stock
JOIN pw_context context ON true
JOIN trace.lot lot ON lot.plant_id = context.plant_id AND lot.lot_no = stock.lot_no
JOIN mdm.item item ON item.item_id = lot.item_id
LEFT JOIN inventory.inventory_balance balance ON balance.lot_id = lot.lot_id
ORDER BY stock.block, stock.seq;

SELECT production_order.production_order_no, item.item_code, trim_scale(production_order.order_qty) AS order_qty,
       production_order.status_code, production_order.due_date
FROM planning.production_order production_order
JOIN mdm.item item ON item.item_id = production_order.item_id
WHERE production_order.production_order_no IN (
  SELECT production_order_no FROM pw_order UNION SELECT order_no FROM pw_practice_item)
ORDER BY 1;

\if :apply
COMMIT;
\echo 'PLAN-WO-01 seed committed'
\else
ROLLBACK;
\echo 'PLAN-WO-01 seed dry-run rolled back'
\endif
