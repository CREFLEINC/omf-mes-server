-- 코드 그룹 이름을 코드 사전(6d03a44)에 맞춘다 — PR C(MASTER_VERSION_STATUS)와 같은 형태.
-- 계약이 codeGroupCode= 로 새 이름을 가리키므로 옛 이름으로 두면 화면이 빈 목록을 받는다
-- (GET /mdm/code-values 는 그룹이 없어도 404 가 아니다). 개명이지 업무 변경이 아니라
-- version_no·updated_at 은 건드리지 않는다. 새 DB 는 그룹이 없어 0행이고 시드가 새 이름으로 세운다.
-- 시드가 먼저 돌아 새 이름이 이미 있으면 개명하지 않는다 — group_code 유일키와 부딪힌다.

-- DEPENDENCY_TYPE → ROUTING_OPERATION_DEPENDENCY_TYPE (CD-ROUTING-OPERATION-DEPENDENCY-TYPE).
-- 값 문자열은 그대로라 planning.routing_operation.dependency_type_code 는 손대지 않는다.
UPDATE mdm.code_group
   SET group_code = 'ROUTING_OPERATION_DEPENDENCY_TYPE',
       group_name = '공정 선후관계 유형',
       is_system_owned = true
 WHERE group_code = 'DEPENDENCY_TYPE'
   AND NOT EXISTS (SELECT 1 FROM mdm.code_group WHERE group_code = 'ROUTING_OPERATION_DEPENDENCY_TYPE');

-- FREQUENCY_INTERVAL_UOM → INSPECTION_FREQUENCY_INTERVAL_UOM (CD-INSPECTION-FREQUENCY-INTERVAL-UOM),
-- 값 QTY → QUANTITY. MINUTE·SHIFT 는 사전에 없어 시드가 내린다.
UPDATE mdm.code_group
   SET group_code = 'INSPECTION_FREQUENCY_INTERVAL_UOM',
       group_name = '검사 주기 단위',
       is_system_owned = true
 WHERE group_code = 'FREQUENCY_INTERVAL_UOM'
   AND NOT EXISTS (SELECT 1 FROM mdm.code_group WHERE group_code = 'INSPECTION_FREQUENCY_INTERVAL_UOM');

UPDATE mdm.code_value v
   SET code = 'QUANTITY'
  FROM mdm.code_group g
 WHERE g.code_group_id = v.code_group_id
   AND g.group_code = 'INSPECTION_FREQUENCY_INTERVAL_UOM'
   AND v.code = 'QTY'
   AND NOT EXISTS (SELECT 1 FROM mdm.code_value x
                    WHERE x.code_group_id = v.code_group_id AND x.code = 'QUANTITY');

UPDATE quality.inspection_plan_version
   SET frequency_interval_uom_code = 'QUANTITY'
 WHERE frequency_interval_uom_code = 'QTY';
