-- 마스터 유형 코드 문자열을 코드 사전(6d03a44)에 맞춘다 — 뜻이 같은 값은 제자리에서 개명하고
-- 업무 행의 문자열을 함께 옮긴다. 대응값이 없는 값(ITEM_TYPE DEV · LOCATION_TYPE ZONE/CELL/DOCK ·
-- WAREHOUSE_TYPE SEMI_FINISHED/MERCHANDISE/PRODUCTION · TERMINAL_TYPE ADMIN_WEB · WORK_ORDER_STATUS
-- BLOCKED)은 시드가 is_active=false 로 내리고 업무 행은 손대지 않는다. 코드 값에 FK 가 없다.
-- 개명이지 업무 변경이 아니라 version_no·updated_at 은 건드리지 않는다. 새 DB 는 전부 0행이다.
-- 새 시드가 먼저 돌아 새 값이 이미 있으면 개명하지 않는다 — 유일키 (code_group_id, code) 와 부딪힌다.

-- ITEM_TYPE (CD-ITEM-TYPE): RAW→RAW_MATERIAL · SEMI→SEMI_FINISHED · FG→FINISHED · MDSE→MERCHANDISE
UPDATE mdm.code_value v
   SET code = m.new_code
  FROM mdm.code_group g,
       (VALUES ('RAW', 'RAW_MATERIAL'), ('SEMI', 'SEMI_FINISHED'), ('FG', 'FINISHED'), ('MDSE', 'MERCHANDISE'))
         AS m(old_code, new_code)
 WHERE g.code_group_id = v.code_group_id
   AND g.group_code = 'ITEM_TYPE'
   AND v.code = m.old_code
   AND NOT EXISTS (SELECT 1 FROM mdm.code_value x
                    WHERE x.code_group_id = v.code_group_id AND x.code = m.new_code);

UPDATE mdm.item i
   SET item_type_code = m.new_code
  FROM (VALUES ('RAW', 'RAW_MATERIAL'), ('SEMI', 'SEMI_FINISHED'), ('FG', 'FINISHED'), ('MDSE', 'MERCHANDISE'))
         AS m(old_code, new_code)
 WHERE i.item_type_code = m.old_code;

-- TERMINAL_STATUS (CD-TERMINAL-STATUS): NORMAL→RUNNING. MAINTENANCE·DISPOSED 는 사전에 없다 —
-- 「폐기는 재발급이 담당한다」(W-CO-06 §5-4)라 단말 행은 STOPPED 로 모으고 값은 시드가 내린다.
-- 'ACTIVE' 는 검증이 없던 시절 화면·e2e 가 넣은 잔재다.
UPDATE mdm.code_value v
   SET code = 'RUNNING'
  FROM mdm.code_group g
 WHERE g.code_group_id = v.code_group_id
   AND g.group_code = 'TERMINAL_STATUS'
   AND v.code = 'NORMAL'
   AND NOT EXISTS (SELECT 1 FROM mdm.code_value x
                    WHERE x.code_group_id = v.code_group_id AND x.code = 'RUNNING');

UPDATE mdm.terminal SET status_code = 'RUNNING' WHERE status_code IN ('NORMAL', 'ACTIVE');
UPDATE mdm.terminal SET status_code = 'STOPPED' WHERE status_code IN ('MAINTENANCE', 'DISPOSED');

-- WORK_SESSION_STATUS (CD-WORK-SESSION-STATUS): OPEN→RUNNING · PAUSED→STOPPED · CLOSED→ENDED
UPDATE mdm.code_value v
   SET code = m.new_code
  FROM mdm.code_group g,
       (VALUES ('OPEN', 'RUNNING'), ('PAUSED', 'STOPPED'), ('CLOSED', 'ENDED')) AS m(old_code, new_code)
 WHERE g.code_group_id = v.code_group_id
   AND g.group_code = 'WORK_SESSION_STATUS'
   AND v.code = m.old_code
   AND NOT EXISTS (SELECT 1 FROM mdm.code_value x
                    WHERE x.code_group_id = v.code_group_id AND x.code = m.new_code);

UPDATE production.work_session s
   SET status_code = m.new_code
  FROM (VALUES ('OPEN', 'RUNNING'), ('PAUSED', 'STOPPED'), ('CLOSED', 'ENDED')) AS m(old_code, new_code)
 WHERE s.status_code = m.old_code;
