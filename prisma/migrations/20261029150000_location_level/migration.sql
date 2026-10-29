-- 위치 계층: 창고 › 구역(ZONE) › 랙(RACK) › 층(LEVEL) › 셀(CELL) — 사용자 결정 2026-10-29(장부 P-153).
-- 단계는 서버가 상위를 보고 정한다. 서버가 만든 자리(적치 대기 · 창고 전체)는 구역이다.
ALTER TABLE mdm.location
  ADD COLUMN location_level_code varchar(30),
  ADD CONSTRAINT ck_location_level CHECK (location_level_code IN ('ZONE', 'RACK', 'LEVEL', 'CELL'));

UPDATE mdm.location SET location_level_code = 'ZONE' WHERE system_role_code IS NOT NULL;

-- 사람이 만든 위치는 깊이로 채운다 — 넷보다 깊은 위치는 비운다(그 밑에는 달 수 없다).
WITH RECURSIVE tree AS (
  SELECT location_id, 0 AS depth
    FROM mdm.location
   WHERE parent_location_id IS NULL AND system_role_code IS NULL
  UNION ALL
  SELECT child.location_id, tree.depth + 1
    FROM mdm.location child
    JOIN tree ON child.parent_location_id = tree.location_id
   WHERE tree.depth < 3
)
UPDATE mdm.location l
   SET location_level_code = (ARRAY['ZONE', 'RACK', 'LEVEL', 'CELL'])[tree.depth + 1]
  FROM tree
 WHERE l.location_id = tree.location_id;

CREATE OR REPLACE FUNCTION mdm.create_system_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mdm.location
    (warehouse_id, location_code, location_name, location_type_code, system_role_code, location_level_code, created_by)
  VALUES
    (NEW.warehouse_id, 'SYS-STAGING', '적치 대기', 'TEMP', 'PUTAWAY_STAGING', 'ZONE', NEW.created_by),
    (NEW.warehouse_id, 'SYS-WHOLE', '창고 전체', 'DEFAULT', 'WAREHOUSE_WHOLE', 'ZONE', NEW.created_by);
  RETURN NEW;
END;
$$;

-- 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 값을 둔다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('LOCATION_LEVEL', '위치 단계', true)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order
  FROM mdm.code_group cg
 CROSS JOIN (VALUES ('ZONE', '구역', 10), ('RACK', '랙', 20), ('LEVEL', '층', 30), ('CELL', '셀', 40))
       AS v(code, code_name, display_order)
 WHERE cg.group_code = 'LOCATION_LEVEL'
ON CONFLICT (code_group_id, code) DO NOTHING;
