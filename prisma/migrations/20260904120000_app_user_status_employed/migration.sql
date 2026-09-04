-- 사용자 «인사» 상태 문자열을 코드 사전(6d03a44 · CD-APP-USER-STATUS)에 맞춘다:
-- 재직 ACTIVE → EMPLOYED · 퇴사 RETIRED → RESIGNED (휴직 ON_LEAVE 는 그대로).
-- 계약이 「⛔ ACTIVE 를 쓰지 않는다 — 사용 여부(is_active)와 수명주기에 같은 낱말을 쓰면
-- 두 축이 다시 섞인다」고 못 박았다. 개명이지 업무 변경이 아니라 version_no·updated_at 은
-- 건드리지 않는다. 코드 값에 FK 가 없어 문자열만 옮기면 된다. 새 DB 는 0행이다.
-- ⚠ Prisma Client 는 정적 @default 를 DB 에 맡기지 않고 INSERT 값으로 채운다 — schema.prisma 의
-- 기본값 변경이 이 마이그레이션과 같은 커밋에 있어야 옛 클라이언트가 'ACTIVE' 를 계속 넣지 않는다.

ALTER TABLE app.app_user ALTER COLUMN status_code SET DEFAULT 'EMPLOYED';

UPDATE app.app_user SET status_code = 'EMPLOYED' WHERE status_code = 'ACTIVE';
UPDATE app.app_user SET status_code = 'RESIGNED' WHERE status_code = 'RETIRED';

UPDATE mdm.code_value v
   SET code = 'EMPLOYED'
  FROM mdm.code_group g
 WHERE g.code_group_id = v.code_group_id
   AND g.group_code = 'APP_USER_STATUS'
   AND v.code = 'ACTIVE'
   -- 새 시드가 먼저 돌아 새 값이 이미 있으면 개명하지 않는다 — 유일키(code_group_id, code)와 부딪힌다.
   AND NOT EXISTS (SELECT 1 FROM mdm.code_value x
                    WHERE x.code_group_id = v.code_group_id AND x.code = 'EMPLOYED');

UPDATE mdm.code_value v
   SET code = 'RESIGNED'
  FROM mdm.code_group g
 WHERE g.code_group_id = v.code_group_id
   AND g.group_code = 'APP_USER_STATUS'
   AND v.code = 'RETIRED'
   -- 새 시드가 먼저 돌아 새 값이 이미 있으면 개명하지 않는다 — 유일키(code_group_id, code)와 부딪힌다.
   AND NOT EXISTS (SELECT 1 FROM mdm.code_value x
                    WHERE x.code_group_id = v.code_group_id AND x.code = 'RESIGNED');
