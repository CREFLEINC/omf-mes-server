-- 공통코드 그룹 이름을 「출고 요청」 표기로 맞춘다(피처 003 FR-034 · omf-all-around#66).
-- 시드는 배포마다 돌지 않아(deploy/RELEASE.md) 이미 선 DB 는 옛 이름으로 남는다. 개명이지 업무 변경이
-- 아니라 version_no·updated_at 은 건드리지 않는다. 옛 이름일 때만 바꾼다 — 고객이 고친 이름은 둔다.
-- 새 DB 는 그룹이 없어 0행이고 시드가 새 이름으로 세운다.
UPDATE mdm.code_group
   SET group_name = '출고 요청 사유'
 WHERE group_code = 'MATERIAL_ISSUE_REQUEST_REASON'
   AND group_name = '자재 출고요청 사유';
