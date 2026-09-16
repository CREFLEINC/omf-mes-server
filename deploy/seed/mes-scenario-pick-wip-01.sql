-- OMF MES 시나리오 기준정보 — PICK-ISSUE-01 → WIP-CHAIN-01
--   (출고 지시 실행: 모바일 피킹·출고 전기·생산창고 입고 → 사출·조립 2공정을 WIP 로 잇는 POP 흐름)
--
-- 교육·테스트 서버를 초기화한 뒤 표준 시드 → `mes-initial-data.sql` → `mes-scenario-plan-wo-01.sql`
-- 위에 얹는다. PLAN-WO-01 시드가 만든 공정(INJ·ASM)·설비(INJ-01·ASM-01)·라우팅(RT-F534F50200-01)·
-- 위치·시작 재고·ERP 생산오더를 그대로 쓰고, 두 시나리오가 추가로 요구한 기준정보만 더한다.
--
-- 담는 것
--   A. 라우팅 공정 선후행 — RT-F534F50200-01 op1 사출 → op2 조립, FINISH_TO_START.
--      계획을 확정할 때 서버가 이 행을 W/O 선후행으로 옮긴다(`plan-confirm.service.ts`). 그 W/O 선후행이
--      있어야 모바일 M-02-01 WIP 인계가 후행 W/O 를 찾는다(`successorOfWorkOrderId`).
--      ⛔ 그래서 이 파일은 계획을 확정하기 **전**에 넣는다.
--   B. 교대 — PL13 DAY 08:00~20:00 · NIGHT 20:00~08:00(자정 넘김). PLAN-WO-01 시드의 DAY 08~17 ·
--      NIGHT 20~05 는 17~20시·05~08시가 비어 그 시각의 작업 세션은 교대 없이 선다(막히지는 않는다).
--      하루를 빈틈없이 덮도록 넓힌다. `-v full_day_shifts=false` 면 있는 행은 두고 없는 행만 만든다.
--   C. 단말 — 모바일 1대(SEED-MOB-01), POP 2대(SEED-POP-INJ-01 = INJ-01 사출 · SEED-POP-ASM-01 = ASM-01
--      조립). POP 단말마다 공정 하나만 묶고(작업 시작·자재 투입·실적 입력·라벨 인쇄·작업 완료 허용),
--      모바일 단말은 공정을 묶지 않는다. 단말 **등록(토큰)** 은 만들지 않는다 — 관리자 웹 W-CO-06 에서
--      토큰을 발급해 기기에 넣는 것이 시나리오의 첫걸음이다. POP PC 가 한 대면 사출을 마친 뒤
--      [단말 재등록]으로 조립 단말 토큰을 넣는다.
--   D. (선택, 기본 꺼짐) W/O 선후행 소급 — 이 파일보다 **먼저** 확정한 계획의 W/O 에는 선후행이
--      없다. `-v backfill_wo_dependency=true` 면 같은 계획 안의 W/O 쌍에 라우팅 선후행을 옮겨 적는다.
--      검증 대상 데이터를 만지는 일이라 기본으로는 하지 않는다.
--
-- ⛔ id 를 적지 않는다. 공장·설비·공정·라우팅은 전부 코드로 찾는다.
-- ⛔ 검증 대상 업무 결과(계획·W/O·출고요청·피킹·출고·입고·세션·투입·실적·LOT·인계)는 만들지 않는다.
--
-- 재실행 안전: 코드로 건너뛰거나 ON CONFLICT DO NOTHING 이고, 교대 시각은 같은 값이면 쓰지 않는다.
--
-- 실행(배포 디렉터리에서 기존 로더 재사용)
--   SQL_FILE=seed/mes-scenario-pick-wip-01.sql seed/load-mes-initial-data.sh --dry-run
--   SQL_FILE=seed/mes-scenario-pick-wip-01.sql seed/load-mes-initial-data.sh
-- 직접 실행
--   psql -X -U omf -d <db> -v apply=false < mes-scenario-pick-wip-01.sql   (검증 후 롤백)
--   psql -X -U omf -d <db> -v apply=true  < mes-scenario-pick-wip-01.sql
--   psql ... -v apply=true -v full_day_shifts=false < ...                   (교대 시각은 두고 없는 것만)
--   psql ... -v apply=true -v backfill_wo_dependency=true < ...             (기존 W/O 에 선후행 소급)
--
-- 시나리오 순서(화면)
--   1. W-CO-06 단말 3대 토큰 발급 → 모바일 앱·POP 에 등록
--   2. PLAN-WO-01: 생산오더 PO-ERP-PLANWO-01 → 계획 → 확정(W/O 2건 + 선후행) → 배포(출고요청·피킹 지시)
--   3. PICK-ISSUE-01: 모바일 M-01-08 피킹·출고 확정 → M-01-09 생산창고 입고 → W-01-13·W-01-07·W-02-10
--   4. WIP-CHAIN-01: POP(사출) 작업 시작 → 자재 투입 → 실적·LOT 라벨·완료 → 모바일 M-02-01 인계 →
--      POP(조립) 작업 시작 → 투입 → 실적·라벨·완료 → W-02-08 확인
--
-- 알려진 한계
--   * 단말 등록 토큰은 서버가 서명해 발급하므로 SQL 로 만들 수 없다(위 C).
--   * 라벨 인쇄는 POP PC 의 프린터(셸 협상: raw 미지원이면 png)를 쓴다. `app.printer` 는 넣지 않는다.
--   * 조립 설비 ASM-01 의 유형은 PLAN-WO-01 시드의 한계 그대로 PRESS 다.

\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif
\if :{?full_day_shifts}
\else
\set full_day_shifts true
\endif
\if :{?backfill_wo_dependency}
\else
\set backfill_wo_dependency false
\endif

\echo 'PICK-WIP-01 seed: 원천 값·사전조건'
BEGIN;

-- 라우팅 공정 선후행. 공정 순번으로 라우팅 공정을 찾는다.
CREATE TEMP TABLE pk_routing_dep (predecessor_seq integer, successor_seq integer, dependency_type_code text) ON COMMIT DROP;
INSERT INTO pk_routing_dep VALUES (1, 2, 'FINISH_TO_START');

-- 교대. 하루를 빈틈없이 덮는다.
CREATE TEMP TABLE pk_shift (seq integer, shift_code text, shift_name text, start_time time, end_time time, crosses_midnight boolean) ON COMMIT DROP;
INSERT INTO pk_shift VALUES
  (1, 'DAY',   '주간', TIME '08:00', TIME '20:00', false),
  (2, 'NIGHT', '야간', TIME '20:00', TIME '08:00', true);

-- 단말. equipment_code·process_code 가 NULL 이면 설비·공정을 묶지 않는다(모바일).
CREATE TEMP TABLE pk_terminal (seq integer, terminal_code text, terminal_type_code text, equipment_code text, process_code text) ON COMMIT DROP;
INSERT INTO pk_terminal VALUES
  (1, 'SEED-MOB-01',     'MOBILE', NULL,     NULL),
  (2, 'SEED-POP-INJ-01', 'POP',    'INJ-01', 'INJ'),
  (3, 'SEED-POP-ASM-01', 'POP',    'ASM-01', 'ASM');

-- psql 변수는 $$ 블록 안에서 치환되지 않는다 — 검증 블록이 읽도록 표에 담아 둔다.
CREATE TEMP TABLE pk_option ON COMMIT DROP AS
SELECT :'full_day_shifts'::boolean AS full_day_shifts;

CREATE TEMP TABLE pk_context ON COMMIT DROP AS
SELECT plant.plant_id,
       plant.timezone_code,
       routing.routing_id,
       (SELECT app_user_id FROM app.app_user WHERE login_id = 'admin') AS admin_user_id
FROM mdm.legal_entity entity
JOIN mdm.plant plant ON plant.legal_entity_id = entity.legal_entity_id AND plant.plant_code = 'PL13'
LEFT JOIN mdm.item item ON item.item_code = 'F534F50200'
LEFT JOIN planning.routing routing ON routing.item_id = item.item_id AND routing.routing_code = 'RT-F534F50200-01'
WHERE entity.legal_entity_code = 'SAMJIN_LND_VINA';

DO $$
DECLARE
  missing text;
  n integer;
BEGIN
  IF (SELECT count(*) FROM pk_context) <> 1 THEN
    RAISE EXCEPTION 'SAMJIN_LND_VINA/PL13 이 없습니다 — mes-initial-data.sql 을 먼저 적재하세요';
  END IF;
  IF (SELECT admin_user_id FROM pk_context) IS NULL THEN
    RAISE EXCEPTION 'admin 계정이 없습니다 — 표준 시드(node dist/seed.js)를 먼저 실행하세요';
  END IF;
  IF (SELECT routing_id FROM pk_context) IS NULL THEN
    RAISE EXCEPTION '라우팅 RT-F534F50200-01 이 없습니다 — mes-scenario-plan-wo-01.sql 을 먼저 적재하세요';
  END IF;

  -- 라우팅 공정 두 개(op1 사출 · op2 조립)가 있어야 선후행을 걸 수 있다.
  SELECT string_agg(seq::text, ', ') INTO missing
  FROM (SELECT predecessor_seq AS seq FROM pk_routing_dep UNION SELECT successor_seq FROM pk_routing_dep) needed
  WHERE NOT EXISTS (
    SELECT 1 FROM planning.routing_operation operation
    JOIN pk_context context ON context.routing_id = operation.routing_id
    WHERE operation.operation_seq = needed.seq
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'RT-F534F50200-01 에 공정 순번 % 이 없습니다 — mes-scenario-plan-wo-01.sql 을 먼저 적재하세요', missing;
  END IF;

  -- 단말이 묶일 설비·공정. 설비는 PL13 소속이고 그 공정과 같은 공정에 묶여 있어야 한다.
  SELECT string_agg(source.terminal_code, ', ') INTO missing
  FROM pk_terminal source
  WHERE source.equipment_code IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM mdm.equipment equipment
      JOIN pk_context context ON context.plant_id = equipment.plant_id
      JOIN mdm.process process ON process.process_id = equipment.process_id
      WHERE equipment.equipment_code = source.equipment_code
        AND process.process_code = source.process_code
        AND equipment.is_active
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '단말이 묶일 설비·공정이 없거나 공정이 다릅니다: % — mes-scenario-plan-wo-01.sql 을 먼저 적재하세요', missing;
  END IF;

  -- 같은 코드의 단말이 다른 공장·유형으로 이미 있으면 사람이 읽을 말로 멈춘다(재실행이면 같은 값이라 지나간다).
  SELECT string_agg(terminal.terminal_code, ', ') INTO missing
  FROM mdm.terminal terminal
  JOIN pk_terminal source ON source.terminal_code = terminal.terminal_code
  JOIN pk_context context ON true
  WHERE terminal.plant_id <> context.plant_id OR terminal.terminal_type_code <> source.terminal_type_code;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '같은 코드의 단말이 다른 공장·유형으로 있습니다: %', missing;
  END IF;

  -- 코드값. 스키마가 FK 를 걸지 않는 자리라 여기서 본다.
  SELECT string_agg(expected.group_code || '/' || expected.code, ', ') INTO missing
  FROM (VALUES
      ('TERMINAL_TYPE', 'POP'), ('TERMINAL_TYPE', 'MOBILE'),
      ('TERMINAL_STATUS', 'RUNNING'),
      ('ROUTING_OPERATION_DEPENDENCY_TYPE', 'FINISH_TO_START')
    ) expected(group_code, code)
  WHERE NOT EXISTS (
    SELECT 1 FROM mdm.code_group code_group
    JOIN mdm.code_value code_value ON code_value.code_group_id = code_group.code_group_id AND code_value.is_active
    WHERE code_group.group_code = expected.group_code AND code_value.code = expected.code
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '표준 시드 코드값이 없습니다: % — node dist/seed.js 를 먼저 실행하세요', missing;
  END IF;

  -- DAY·NIGHT 밖의 활성 교대가 있으면 겹침 판정(시작 시각이 앞선 것)이 달라질 수 있다 — 알리기만 한다.
  SELECT count(*) INTO n
  FROM mdm.shift shift JOIN pk_context context ON context.plant_id = shift.plant_id
  WHERE shift.is_active AND shift.shift_code NOT IN (SELECT shift_code FROM pk_shift);
  IF n > 0 THEN
    RAISE NOTICE 'PL13 에 DAY·NIGHT 밖의 활성 교대가 %행 있습니다 — 세션 교대 판정이 이 시드의 가정과 다를 수 있습니다', n;
  END IF;
END $$;

\echo 'PICK-WIP-01 seed: A 라우팅 공정 선후행 (op1 사출 → op2 조립)'
INSERT INTO planning.routing_operation_dependency (predecessor_operation_id, successor_operation_id, dependency_type_code, created_by)
SELECT predecessor.routing_operation_id, successor.routing_operation_id, source.dependency_type_code, context.admin_user_id
FROM pk_routing_dep source
CROSS JOIN pk_context context
JOIN planning.routing_operation predecessor
  ON predecessor.routing_id = context.routing_id AND predecessor.operation_seq = source.predecessor_seq
JOIN planning.routing_operation successor
  ON successor.routing_id = context.routing_id AND successor.operation_seq = source.successor_seq
ON CONFLICT (predecessor_operation_id, successor_operation_id) DO NOTHING;

\echo 'PICK-WIP-01 seed: B 교대 (DAY 08~20 · NIGHT 20~08)'
INSERT INTO mdm.shift (plant_id, shift_code, shift_name, start_time, end_time, crosses_midnight, created_by)
SELECT context.plant_id, source.shift_code, source.shift_name, source.start_time, source.end_time,
       source.crosses_midnight, context.admin_user_id
FROM pk_shift source
CROSS JOIN pk_context context
ORDER BY source.seq
ON CONFLICT (plant_id, shift_code) DO NOTHING;

\if :full_day_shifts
-- PLAN-WO-01 시드의 시각(08~17 · 20~05)을 하루를 덮는 시각으로 넓힌다. 같은 값이면 쓰지 않는다.
UPDATE mdm.shift shift
   SET start_time = source.start_time,
       end_time = source.end_time,
       crosses_midnight = source.crosses_midnight,
       is_active = true,
       version_no = shift.version_no + 1,
       updated_by = context.admin_user_id
  FROM pk_shift source, pk_context context
 WHERE shift.plant_id = context.plant_id
   AND shift.shift_code = source.shift_code
   AND (shift.start_time <> source.start_time
     OR shift.end_time <> source.end_time
     OR shift.crosses_midnight <> source.crosses_midnight
     OR NOT shift.is_active);
\endif

\echo 'PICK-WIP-01 seed: C 단말 (모바일 1 · POP 사출 1 · POP 조립 1)'
INSERT INTO mdm.terminal (terminal_code, plant_id, terminal_type_code, status_code, equipment_id, created_by)
SELECT source.terminal_code, context.plant_id, source.terminal_type_code, 'RUNNING', equipment.equipment_id, context.admin_user_id
FROM pk_terminal source
CROSS JOIN pk_context context
LEFT JOIN mdm.equipment equipment
  ON equipment.plant_id = context.plant_id AND equipment.equipment_code = source.equipment_code
ORDER BY source.seq
ON CONFLICT (terminal_code) DO NOTHING;

-- 재실행에서 설비가 비어 있는 같은 코드의 단말이 있으면(예: 화면에서 먼저 만든 경우) 설비만 채운다.
UPDATE mdm.terminal terminal
   SET equipment_id = equipment.equipment_id,
       version_no = terminal.version_no + 1,
       updated_by = context.admin_user_id
  FROM pk_terminal source, pk_context context, mdm.equipment equipment
 WHERE terminal.terminal_code = source.terminal_code
   AND source.equipment_code IS NOT NULL
   AND equipment.plant_id = context.plant_id AND equipment.equipment_code = source.equipment_code
   AND terminal.equipment_id IS NULL;

INSERT INTO mdm.terminal_process
  (terminal_id, process_id, can_start_work, can_input_material, can_input_result, can_print_label, can_complete_work,
   can_input_inspection, can_cancel_input, can_return_material, created_by)
SELECT terminal.terminal_id, process.process_id, true, true, true, true, true, false, false, false, context.admin_user_id
FROM pk_terminal source
CROSS JOIN pk_context context
JOIN mdm.terminal terminal ON terminal.terminal_code = source.terminal_code
JOIN mdm.process process ON process.process_code = source.process_code
WHERE source.process_code IS NOT NULL
ORDER BY source.seq
ON CONFLICT (terminal_id, process_id) DO NOTHING;

\if :backfill_wo_dependency
\echo 'PICK-WIP-01 seed: D (선택) 기존 W/O 에 선후행 소급'
INSERT INTO production.work_order_dependency
  (predecessor_work_order_id, successor_work_order_id, dependency_type_code, required_qty_rule_code, created_by)
SELECT predecessor.work_order_id, successor.work_order_id, dependency.dependency_type_code, 'AVAILABLE_GOOD_QTY', context.admin_user_id
FROM planning.routing_operation_dependency dependency
JOIN pk_context context ON true
JOIN planning.routing_operation predecessor_operation
  ON predecessor_operation.routing_operation_id = dependency.predecessor_operation_id
 AND predecessor_operation.routing_id = context.routing_id
JOIN production.work_order predecessor ON predecessor.routing_operation_id = dependency.predecessor_operation_id
JOIN production.work_order successor
  ON successor.routing_operation_id = dependency.successor_operation_id
 AND successor.production_plan_id = predecessor.production_plan_id
WHERE predecessor.production_plan_id IS NOT NULL
ON CONFLICT (predecessor_work_order_id, successor_work_order_id) DO NOTHING;
\endif

\echo 'PICK-WIP-01 seed: 검증'
DO $$
DECLARE
  context pk_context%ROWTYPE;
  actual_count integer;
  full_day boolean;
BEGIN
  SELECT * INTO context FROM pk_context;
  SELECT full_day_shifts INTO full_day FROM pk_option;

  SELECT count(*) INTO actual_count
  FROM pk_routing_dep source
  JOIN planning.routing_operation predecessor
    ON predecessor.routing_id = context.routing_id AND predecessor.operation_seq = source.predecessor_seq
  JOIN planning.routing_operation successor
    ON successor.routing_id = context.routing_id AND successor.operation_seq = source.successor_seq
  JOIN planning.routing_operation_dependency dependency
    ON dependency.predecessor_operation_id = predecessor.routing_operation_id
   AND dependency.successor_operation_id = successor.routing_operation_id;
  IF actual_count <> (SELECT count(*) FROM pk_routing_dep) THEN
    RAISE EXCEPTION '라우팅 선후행: %건이어야 하는데 %건', (SELECT count(*) FROM pk_routing_dep), actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM mdm.shift shift
  JOIN pk_shift source ON source.shift_code = shift.shift_code
  WHERE shift.plant_id = context.plant_id AND shift.is_active;
  IF actual_count <> 2 THEN RAISE EXCEPTION '교대 DAY·NIGHT: 2행이어야 하는데 %행', actual_count; END IF;

  IF full_day THEN
    SELECT count(*) INTO actual_count
    FROM mdm.shift shift
    JOIN pk_shift source ON source.shift_code = shift.shift_code
    WHERE shift.plant_id = context.plant_id AND shift.is_active
      AND shift.start_time = source.start_time AND shift.end_time = source.end_time
      AND shift.crosses_midnight = source.crosses_midnight;
    IF actual_count <> 2 THEN RAISE EXCEPTION '교대 시각이 하루를 덮는 값이 아닙니다(%행만 일치)', actual_count; END IF;
  END IF;

  SELECT count(*) INTO actual_count
  FROM mdm.terminal terminal
  JOIN pk_terminal source ON source.terminal_code = terminal.terminal_code
  WHERE terminal.plant_id = context.plant_id AND terminal.is_active AND terminal.status_code = 'RUNNING';
  IF actual_count <> 3 THEN RAISE EXCEPTION '단말: 3대여야 하는데 %대', actual_count; END IF;

  -- POP 단말은 설비가 묶여 있고, 그 설비의 공정과 단말-공정 매핑의 공정이 같아야 한다.
  SELECT count(*) INTO actual_count
  FROM pk_terminal source
  JOIN mdm.terminal terminal ON terminal.terminal_code = source.terminal_code
  JOIN mdm.equipment equipment ON equipment.equipment_id = terminal.equipment_id
  JOIN mdm.terminal_process mapping ON mapping.terminal_id = terminal.terminal_id AND mapping.process_id = equipment.process_id
  JOIN mdm.process process ON process.process_id = mapping.process_id AND process.process_code = source.process_code
  WHERE source.process_code IS NOT NULL
    AND mapping.can_start_work AND mapping.can_input_material AND mapping.can_input_result
    AND mapping.can_print_label AND mapping.can_complete_work;
  IF actual_count <> 2 THEN RAISE EXCEPTION 'POP 단말-공정 매핑(설비 공정과 일치·5권한): 2행이어야 하는데 %행', actual_count; END IF;

  -- 단말 하나에 공정 하나(G7). 둘 이상이면 화면 범위가 이 시나리오의 가정과 다르다.
  SELECT count(*) INTO actual_count
  FROM (
    SELECT mapping.terminal_id
    FROM mdm.terminal_process mapping
    JOIN mdm.terminal terminal ON terminal.terminal_id = mapping.terminal_id
    JOIN pk_terminal source ON source.terminal_code = terminal.terminal_code
    GROUP BY mapping.terminal_id HAVING count(*) > 1
  ) crowded;
  IF actual_count > 0 THEN
    RAISE EXCEPTION '공정이 둘 이상 묶인 단말 %대 — 단말당 공정 하나가 이 시나리오의 가정입니다', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM mdm.terminal terminal
  JOIN pk_terminal source ON source.terminal_code = terminal.terminal_code
  WHERE terminal.registration_confirmed_at IS NULL;
  IF actual_count > 0 THEN
    RAISE NOTICE '등록되지 않은 단말 %대 — W-CO-06 에서 토큰을 발급해 기기에 넣으세요(시드로는 만들 수 없습니다)', actual_count;
  END IF;

  -- 검증 대상 업무 결과를 시드가 만들지 않았는지 본다. 있으면 이전 실행 흔적이다.
  SELECT (SELECT count(*) FROM production.work_session)
       + (SELECT count(*) FROM production.material_consumption)
       + (SELECT count(*) FROM production.production_result)
       + (SELECT count(*) FROM production.operation_handover)
       + (SELECT count(*) FROM logistics.goods_issue)
       + (SELECT count(*) FROM logistics.shopfloor_receipt)
    INTO actual_count;
  IF actual_count <> 0 THEN
    RAISE NOTICE '세션·투입·실적·인계·출고·생산창고 입고가 %건 있습니다 — 이 시드가 만든 것은 아닙니다(이전 실행 흔적)', actual_count;
  END IF;

  -- 이 파일보다 먼저 확정된 계획이 있으면 그 W/O 에는 선후행이 없다 — 알린다.
  SELECT count(*) INTO actual_count
  FROM production.work_order predecessor
  JOIN planning.routing_operation_dependency dependency ON dependency.predecessor_operation_id = predecessor.routing_operation_id
  JOIN production.work_order successor
    ON successor.routing_operation_id = dependency.successor_operation_id
   AND successor.production_plan_id = predecessor.production_plan_id
  WHERE predecessor.production_plan_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM production.work_order_dependency existing
      WHERE existing.predecessor_work_order_id = predecessor.work_order_id
        AND existing.successor_work_order_id = successor.work_order_id
    );
  IF actual_count > 0 THEN
    RAISE NOTICE '선후행이 없는 기존 W/O 쌍 %건 — 계획을 다시 확정하거나 -v backfill_wo_dependency=true 로 소급하세요', actual_count;
  END IF;
END $$;

SELECT 'routing-dep' AS kind,
       predecessor.operation_seq || '->' || successor.operation_seq AS code,
       dependency.dependency_type_code AS detail,
       NULL::text AS extra
FROM planning.routing_operation_dependency dependency
JOIN pk_context context ON true
JOIN planning.routing_operation predecessor
  ON predecessor.routing_operation_id = dependency.predecessor_operation_id AND predecessor.routing_id = context.routing_id
JOIN planning.routing_operation successor ON successor.routing_operation_id = dependency.successor_operation_id
UNION ALL
SELECT 'shift', shift.shift_code,
       to_char(shift.start_time, 'HH24:MI') || '~' || to_char(shift.end_time, 'HH24:MI'),
       'midnight=' || shift.crosses_midnight || ' active=' || shift.is_active
FROM mdm.shift shift JOIN pk_context context ON context.plant_id = shift.plant_id
UNION ALL
SELECT 'terminal', terminal.terminal_code,
       terminal.terminal_type_code || ' ' || terminal.status_code || ' equipment=' || coalesce(equipment.equipment_code, '-'),
       'process=' || coalesce(string_agg(process.process_code, ','), '-')
         || ' registered=' || (terminal.registration_confirmed_at IS NOT NULL)
FROM mdm.terminal terminal
JOIN pk_terminal source ON source.terminal_code = terminal.terminal_code
LEFT JOIN mdm.equipment equipment ON equipment.equipment_id = terminal.equipment_id
LEFT JOIN mdm.terminal_process mapping ON mapping.terminal_id = terminal.terminal_id
LEFT JOIN mdm.process process ON process.process_id = mapping.process_id
GROUP BY terminal.terminal_id, terminal.terminal_code, terminal.terminal_type_code, terminal.status_code,
         equipment.equipment_code, terminal.registration_confirmed_at, source.seq
UNION ALL
SELECT 'wo-dep-count', count(*)::text, 'W/O 선후행(서버가 계획 확정 때 만든다)', NULL
FROM production.work_order_dependency
ORDER BY 1, 2;

\if :apply
COMMIT;
\echo 'PICK-WIP-01 seed committed'
\else
ROLLBACK;
\echo 'PICK-WIP-01 seed dry-run rolled back'
\endif
