-- 위치 코드를 모든 창고를 통틀어 유일하게 — 위치 QR 하나로 「어느 창고의 어디」가 풀리게(사용자 결정 2026-11-17 · omf-all-around#292).
-- 접두는 창고 코드가 아니라 창고에 새로 두는 「창고 위치 코드」(location_prefix)다. 창고 위치 코드는 모든 창고를 통틀어 유일하고,
-- 등록한 뒤에는 바꾸지 않는다(서버가 막는다 — 바꾸면 위치 코드와 붙인 라벨이 어긋난다).
-- 위치 코드 = {창고 위치 코드}-{나머지}. 창고 위치 코드에는 '-' 가 없으므로 첫 조각이 곧 창고다 — 창고끼리는 겹칠 수 없다.

-- ① 창고 위치 코드 무작위 발급 — 헷갈리는 글자(0/O · 1/I/L)를 뺀 대문자·숫자 4자, 쓰지 않은 값이 나올 때까지 다시 뽑는다.
--    칸 기본값이라 어느 길로 창고를 넣어도(서버 · ERP 동기화 · 시드 · e2e 픽스처 · 맨 SQL) 채워진다.
--    ⚠ VOLATILE 이라 함수 안 SELECT 가 같은 거래의 앞선 문장이 넣은 값을 본다(아래 ③ 의 한 행씩 채우기가 이것에 기댄다).
CREATE FUNCTION mdm.new_location_prefix() RETURNS varchar(6) LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet  constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate varchar(6);
BEGIN
  LOOP
    candidate := '';
    FOR i IN 1..4 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM mdm.warehouse WHERE location_prefix = candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION mdm.new_location_prefix() IS
  '쓰지 않은 무작위 창고 위치 코드(대문자·숫자 4자, 0/O·1/I/L 제외) — mdm.warehouse.location_prefix 기본값(omf-all-around#292)';

-- ② 데이터를 고치기 전에 멈출 자리를 본다 — 새 코드가 칸(varchar 50)을 넘으면 잘라 넣지 않는다.
--    무작위 접두는 4자라 「4자 + '-'」 를 더해 잰다.
DO $$
DECLARE
  too_long text;
BEGIN
  SELECT string_agg(location_code, ', ' ORDER BY location_code) INTO too_long
    FROM mdm.location
   WHERE length(location_code) + 5 > 50;
  IF too_long IS NOT NULL THEN
    RAISE EXCEPTION '창고 위치 코드(4자)를 붙이면 50자를 넘는 위치 코드가 있습니다: % — 위치 코드를 줄인 뒤 배포하세요', too_long;
  END IF;
END;
$$;

-- ③ 칸을 더하고 기존 창고마다 무작위 값을 채운다. 한 문장으로 채우면 함수가 같은 문장이 넣은 값을 못 봐 겹칠 수 있다 —
--    한 행씩 채운다.
ALTER TABLE mdm.warehouse ADD COLUMN location_prefix varchar(6);

DO $$
DECLARE
  target bigint;
BEGIN
  FOR target IN SELECT warehouse_id FROM mdm.warehouse ORDER BY warehouse_id LOOP
    UPDATE mdm.warehouse SET location_prefix = mdm.new_location_prefix() WHERE warehouse_id = target;
  END LOOP;
END;
$$;

ALTER TABLE mdm.warehouse
  ALTER COLUMN location_prefix SET NOT NULL,
  ALTER COLUMN location_prefix SET DEFAULT mdm.new_location_prefix(),
  ADD CONSTRAINT uq_warehouse_location_prefix UNIQUE (location_prefix),
  ADD CONSTRAINT ck_warehouse_location_prefix CHECK (location_prefix ~ '^[A-Z0-9]{2,6}$');

COMMENT ON COLUMN mdm.warehouse.location_prefix IS
  '창고 위치 코드 — 위치 코드 앞에 붙는다({창고 위치 코드}-Z01). 모든 창고에서 유일, 등록 뒤 바꾸지 않는다(omf-all-around#292)';

-- ④ 바꾼 위치의 옛 코드 → 새 코드 — 현장에 붙은 위치 라벨을 창고별로 다시 뽑을 목록이다.
--    FK 를 걸지 않는다: 걸면 위치·창고를 지울 때 이 기록이 막고, 참조 목록(LOCATION_REFERRERS·WAREHOUSE_REFERRERS)이 어긋난다.
CREATE TABLE mdm.location_code_rename (
  location_id  bigint      NOT NULL PRIMARY KEY,
  warehouse_id bigint      NOT NULL,
  old_code     varchar(50) NOT NULL,
  new_code     varchar(50) NOT NULL,
  renamed_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mdm.location_code_rename IS
  '위치 코드에 창고 위치 코드를 붙일 때(omf-all-around#292) 바뀐 위치의 옛 코드 → 새 코드. 위치 라벨 재발행 목록';

-- 예외 없이 모두 바꾼다 — 사람이 짓던 옛 코드(S230-01 · S230-A-01-02 등)도 붙인다(사용자 결정).
INSERT INTO mdm.location_code_rename (location_id, warehouse_id, old_code, new_code)
SELECT l.location_id, l.warehouse_id, l.location_code, w.location_prefix || '-' || l.location_code
  FROM mdm.location l
  JOIN mdm.warehouse w ON w.warehouse_id = l.warehouse_id;

-- 붙인 뒤 겹치면(접두가 창고마다 달라 날 수 없지만) 데이터를 고치기 전에 멈춘다.
DO $$
DECLARE
  duplicated text;
BEGIN
  SELECT string_agg(new_code || '(' || n || '건)', ', ' ORDER BY new_code) INTO duplicated
    FROM (SELECT new_code, count(*) AS n FROM mdm.location_code_rename GROUP BY new_code HAVING count(*) > 1) dup;
  IF duplicated IS NOT NULL THEN
    RAISE EXCEPTION '창고 위치 코드를 붙여도 겹치는 위치 코드가 있습니다: % — 위치를 정리한 뒤 배포하세요', duplicated;
  END IF;
END;
$$;

ALTER TABLE mdm.location DROP CONSTRAINT uq_location;

-- 코드가 바뀌었으니 버전을 올린다 — 이전에 받아 둔 ETag 로 덮어쓰지 못하게.
UPDATE mdm.location l
   SET location_code = r.new_code,
       version_no = l.version_no + 1
  FROM mdm.location_code_rename r
 WHERE r.location_id = l.location_id;

ALTER TABLE mdm.location ADD CONSTRAINT uq_location_code UNIQUE (location_code);

-- ⑤ 서버가 창고마다 만드는 자리도 창고 위치 코드로 시작한다.
--    트리거는 AFTER INSERT 다(20261029100000) — 칸 기본값은 행을 만들 때 이미 채워지므로 NEW.location_prefix 가 비지 않는다.
CREATE OR REPLACE FUNCTION mdm.create_system_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mdm.location
    (warehouse_id, location_code, location_name, location_type_code, system_role_code, location_level_code, created_by)
  VALUES
    (NEW.warehouse_id, NEW.location_prefix || '-SYS-STAGING', '적치 대기', 'TEMP', 'PUTAWAY_STAGING', 'ZONE', NEW.created_by),
    (NEW.warehouse_id, NEW.location_prefix || '-SYS-WHOLE', '창고 전체', 'DEFAULT', 'WAREHOUSE_WHOLE', 'ZONE', NEW.created_by);
  RETURN NEW;
END;
$$;
