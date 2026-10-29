-- 창고 관리수준을 없앤다(사용자 결정 2026-10-29) — 「창고 전체」는 관리수준과 상관없이 모든 창고에 둔다.
-- 구역을 만들지 않은 창고는 이 자리 하나가 재고 자리다. 구역을 만들면 그 구역들과 나란히 있는 자리 하나가 된다.
CREATE OR REPLACE FUNCTION mdm.create_system_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mdm.location (warehouse_id, location_code, location_name, location_type_code, system_role_code, created_by)
  VALUES
    (NEW.warehouse_id, 'SYS-STAGING', '적치 대기', 'TEMP', 'PUTAWAY_STAGING', NEW.created_by),
    (NEW.warehouse_id, 'SYS-WHOLE', '창고 전체', 'DEFAULT', 'WAREHOUSE_WHOLE', NEW.created_by);
  RETURN NEW;
END;
$$;

-- 이미 있는 창고. 사람이 만든 활성 위치가 있는 창고는 채우지 않는다 — 이미 나뉜 창고라, 넣으면 도착 위치를
-- 하나로 고르던 창고(관리수준 창고 + 위치 하나)가 고를 자리 둘이 되어 위치를 묻게 된다.
INSERT INTO mdm.location (warehouse_id, location_code, location_name, location_type_code, system_role_code)
SELECT w.warehouse_id, 'SYS-WHOLE', '창고 전체', 'DEFAULT', 'WAREHOUSE_WHOLE'
  FROM mdm.warehouse w
 WHERE NOT EXISTS (
         SELECT 1 FROM mdm.location l
          WHERE l.warehouse_id = w.warehouse_id AND l.system_role_code = 'WAREHOUSE_WHOLE')
   AND NOT EXISTS (
         SELECT 1 FROM mdm.location l
          WHERE l.warehouse_id = w.warehouse_id AND l.is_active AND l.system_role_code IS NULL);
