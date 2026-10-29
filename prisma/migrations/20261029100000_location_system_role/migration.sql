-- 서버가 창고마다 두는 위치(사용자 결정 2026-10-29). 사람이 등록하지 않고, 코드·이름을 고치지 않는다.
--   PUTAWAY_STAGING 적치 대기 — 입고는 됐고 아직 놓지 않은 자리(입고 기본 위치). 모든 창고에 하나.
--   WAREHOUSE_WHOLE 창고 전체 — 관리수준 WAREHOUSE 창고의 적치 자리. 관리수준을 바꾸면 끄는 것은 사람이 한다.
-- alias_name 은 MES 가 붙이는 별칭이다 — 서버가 만든 위치도 별칭은 고친다.
ALTER TABLE mdm.location
  ADD COLUMN system_role_code varchar(30),
  ADD COLUMN alias_name varchar(200),
  ADD CONSTRAINT ck_location_system_role CHECK (system_role_code IN ('PUTAWAY_STAGING', 'WAREHOUSE_WHOLE'));

CREATE UNIQUE INDEX uq_location_system_role ON mdm.location (warehouse_id, system_role_code)
  WHERE system_role_code IS NOT NULL;

-- 트리거인 이유 — 창고는 관리 화면·ERP 받기·초기 데이터 SQL 어느 길로도 생긴다. 한 길이라도 빠지면 그 창고는 입고 기본 위치가 없다.
CREATE FUNCTION mdm.create_system_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mdm.location (warehouse_id, location_code, location_name, location_type_code, system_role_code, created_by)
  VALUES (NEW.warehouse_id, 'SYS-STAGING', '적치 대기', 'TEMP', 'PUTAWAY_STAGING', NEW.created_by);
  IF NEW.management_level_code = 'WAREHOUSE' THEN
    INSERT INTO mdm.location (warehouse_id, location_code, location_name, location_type_code, system_role_code, created_by)
    VALUES (NEW.warehouse_id, 'SYS-WHOLE', '창고 전체', 'DEFAULT', 'WAREHOUSE_WHOLE', NEW.created_by);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_warehouse_system_locations
  AFTER INSERT ON mdm.warehouse
  FOR EACH ROW EXECUTE FUNCTION mdm.create_system_locations();

-- 만든 것은 함께 지운다 — 쓰인 자리(재고·원장이 가리킴)면 FK 가 창고 삭제를 막는 것은 그대로다.
CREATE FUNCTION mdm.delete_system_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM mdm.location WHERE warehouse_id = OLD.warehouse_id AND system_role_code IS NOT NULL;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_warehouse_system_locations_delete
  BEFORE DELETE ON mdm.warehouse
  FOR EACH ROW EXECUTE FUNCTION mdm.delete_system_locations();

-- 이미 있는 창고. 창고 전체는 활성 위치가 하나도 없는 WAREHOUSE 창고에만 둔다 — 하나 있으면 그것이 이미 창고 전체다.
INSERT INTO mdm.location (warehouse_id, location_code, location_name, location_type_code, system_role_code)
SELECT warehouse_id, 'SYS-STAGING', '적치 대기', 'TEMP', 'PUTAWAY_STAGING'
  FROM mdm.warehouse;

INSERT INTO mdm.location (warehouse_id, location_code, location_name, location_type_code, system_role_code)
SELECT w.warehouse_id, 'SYS-WHOLE', '창고 전체', 'DEFAULT', 'WAREHOUSE_WHOLE'
  FROM mdm.warehouse w
 WHERE w.management_level_code = 'WAREHOUSE'
   AND NOT EXISTS (
     SELECT 1 FROM mdm.location l
      WHERE l.warehouse_id = w.warehouse_id AND l.is_active AND l.system_role_code IS NULL);
