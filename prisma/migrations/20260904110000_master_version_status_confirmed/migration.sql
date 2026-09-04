-- 마스터 버전(Routing·BOM·검사기준 버전)의 확정 상태 문자열을 계약에 맞춘다 —
-- `MASTER_VERSION_STATUS` DRAFT·CONFIRMED·OBSOLETE (결정 07 · 사본 6d03a44).
--
-- 서버가 확정을 'ACTIVE' 로 저장해 왔다(시드 그룹 이름 REVISION_STATUS). 계약이 그 이름을
-- 「결정 07 이 확정한 뜻(작성중·확정·폐기) 중 어느 것도 아니다」로 되돌리라 적어 두었고
-- 6d03a44 가 CONFIRMED 로 확정했다. 개명이지 업무 변경이 아니므로 version_no·updated_at 은
-- 건드리지 않는다.
--
-- 코드 값에는 FK 가 없어 문자열이 곧 뜻이다 — 그룹·값·세 표의 행을 함께 바꿔야 어긋나지
-- 않는다. 새 DB 는 그룹이 없어 0행이고, 시드가 새 이름으로 세운다.

UPDATE mdm.code_group
   SET group_code = 'MASTER_VERSION_STATUS',
       group_name = '마스터 버전 상태',
       is_system_owned = true
 WHERE group_code = 'REVISION_STATUS'
   AND NOT EXISTS (SELECT 1 FROM mdm.code_group WHERE group_code = 'MASTER_VERSION_STATUS');

UPDATE mdm.code_value v
   SET code = 'CONFIRMED',
       code_name = '확정'
  FROM mdm.code_group g
 WHERE g.code_group_id = v.code_group_id
   AND g.group_code = 'MASTER_VERSION_STATUS'
   AND v.code = 'ACTIVE';

UPDATE planning.routing                SET status_code = 'CONFIRMED' WHERE status_code = 'ACTIVE';
UPDATE planning.bom                    SET status_code = 'CONFIRMED' WHERE status_code = 'ACTIVE';
UPDATE quality.inspection_plan_version SET status_code = 'CONFIRMED' WHERE status_code = 'ACTIVE';
