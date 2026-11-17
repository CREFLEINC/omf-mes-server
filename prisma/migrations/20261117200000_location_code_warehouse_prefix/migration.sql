-- 위치 코드에 창고 코드를 앞에 붙인다 — 위치 QR 하나로 「어느 창고의 어디」가 풀리게(사용자 결정 · omf-all-around#292).
-- 코드는 모든 창고를 통틀어 유일하다(uq_location_code). 창고 코드로 이미 시작하는 옛 코드(S230 의 S230-A-01-02 같은
-- 사람이 짓던 코드)는 그대로 둔다(사용자 결정).

-- 바꾼 위치의 옛 코드 → 새 코드 — 현장에 붙은 위치 라벨을 다시 뽑을 목록이다.
-- FK 를 걸지 않는다: 걸면 위치·창고를 지울 때 이 기록이 막고, 참조 목록(LOCATION_REFERRERS·WAREHOUSE_REFERRERS)이 어긋난다.
CREATE TABLE mdm.location_code_rename (
  location_id  bigint      NOT NULL PRIMARY KEY,
  warehouse_id bigint      NOT NULL,
  old_code     varchar(50) NOT NULL,
  new_code     varchar(50) NOT NULL,
  renamed_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mdm.location_code_rename IS
  '위치 코드에 창고 코드를 붙일 때(omf-all-around#292) 바뀐 위치의 옛 코드 → 새 코드. 위치 라벨 재발행 목록';

DO $$
DECLARE
  too_long   integer;
  duplicated text;
BEGIN
  -- 새 코드가 칸(varchar 50)을 넘으면 잘라 넣지 않고 멈춘다.
  SELECT count(*) INTO too_long
    FROM mdm.location l
    JOIN mdm.warehouse w ON w.warehouse_id = l.warehouse_id
   WHERE left(l.location_code, length(w.warehouse_code) + 1) <> w.warehouse_code || '-'
     AND length(w.warehouse_code || '-' || l.location_code) > 50;
  IF too_long > 0 THEN
    RAISE EXCEPTION '창고 코드를 붙이면 50자를 넘는 위치 코드가 %건 있습니다 — 위치 코드나 창고 코드를 줄인 뒤 배포하세요', too_long;
  END IF;

  -- 붙인 뒤에도 겹치는 코드가 있으면 데이터를 고치지 않고 멈춘다.
  SELECT string_agg(code || '(' || n || '건)', ', ' ORDER BY code) INTO duplicated
    FROM (
      SELECT CASE
               WHEN left(l.location_code, length(w.warehouse_code) + 1) = w.warehouse_code || '-' THEN l.location_code
               ELSE w.warehouse_code || '-' || l.location_code
             END AS code,
             count(*) AS n
        FROM mdm.location l
        JOIN mdm.warehouse w ON w.warehouse_id = l.warehouse_id
       GROUP BY 1
      HAVING count(*) > 1
    ) dup;
  IF duplicated IS NOT NULL THEN
    RAISE EXCEPTION '창고 코드를 붙여도 겹치는 위치 코드가 있습니다: % — 위치를 정리한 뒤 배포하세요', duplicated;
  END IF;
END;
$$;

INSERT INTO mdm.location_code_rename (location_id, warehouse_id, old_code, new_code)
SELECT l.location_id, l.warehouse_id, l.location_code, w.warehouse_code || '-' || l.location_code
  FROM mdm.location l
  JOIN mdm.warehouse w ON w.warehouse_id = l.warehouse_id
 WHERE left(l.location_code, length(w.warehouse_code) + 1) <> w.warehouse_code || '-';

ALTER TABLE mdm.location DROP CONSTRAINT uq_location;

-- 코드가 바뀌었으니 버전을 올린다 — 이전에 받아 둔 ETag 로 덮어쓰지 못하게.
UPDATE mdm.location l
   SET location_code = r.new_code,
       version_no = l.version_no + 1
  FROM mdm.location_code_rename r
 WHERE r.location_id = l.location_id;

ALTER TABLE mdm.location ADD CONSTRAINT uq_location_code UNIQUE (location_code);

-- 서버가 창고마다 만드는 자리도 창고 코드로 시작한다.
CREATE OR REPLACE FUNCTION mdm.create_system_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mdm.location
    (warehouse_id, location_code, location_name, location_type_code, system_role_code, location_level_code, created_by)
  VALUES
    (NEW.warehouse_id, NEW.warehouse_code || '-SYS-STAGING', '적치 대기', 'TEMP', 'PUTAWAY_STAGING', 'ZONE', NEW.created_by),
    (NEW.warehouse_id, NEW.warehouse_code || '-SYS-WHOLE', '창고 전체', 'DEFAULT', 'WAREHOUSE_WHOLE', 'ZONE', NEW.created_by);
  RETURN NEW;
END;
$$;
