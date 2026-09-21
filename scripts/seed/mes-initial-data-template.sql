-- OMF MES initial master data for Samjin LND Vina
-- Generated from gateway.sqlite3. Do not edit the generated SQL directly.
-- Re-run scripts/seed/generate_mes_initial_data.py after changing this template.
--
-- Provisional organization values for customer review:
--   legal entity  SAMJIN_LND_VINA / Samjin LND Vina
--   business unit VIETNAM / Vietnam Operations
--   plants        PL11 / Parts Plant, PL13 / OA Plant
--   country/timezone VN / Asia/Ho_Chi_Minh
--
-- Deliberate source adjustments:
--   * 720 BOM component rows have source required_qty=0 EA. MES requires > 0,
--     so they are provisionally loaded as 1 EA.
--   * 30 BOMs start with sequence_no=0. All 194 components in those BOMs are
--     shifted by +1 to preserve their source ordering while satisfying sequence_no > 0.
--   * Five external warehouses cannot be linked reliably to an ERP partner.
--     Deterministic EXTWH_* placeholder partners are created for them.
--   * ERP item group Mold remains an item classification. No mdm.mold rows are made.
--   * Item AD0404-00022 (HA100038-2510 WW) is inserted explicitly; it is present in
--     the ERP source but does not come through the bulk item load.
--   * Six items are marked inspection_required; the ERP source carries no such flag.

\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif

\echo 'OMF MES initial-data seed: staging source snapshot'
BEGIN;

CREATE SCHEMA IF NOT EXISTS erp_seed;

DROP TABLE IF EXISTS erp_seed.seed_adjustment;
DROP TABLE IF EXISTS erp_seed.erp_code;
DROP TABLE IF EXISTS erp_seed.erp_employee;
DROP TABLE IF EXISTS erp_seed.erp_item;
DROP TABLE IF EXISTS erp_seed.erp_partner;
DROP TABLE IF EXISTS erp_seed.erp_bom;

CREATE TABLE erp_seed.erp_code (
  type_code text,
  type_name text,
  code text,
  code_name text,
  plant_cd text,
  trans_type text,
  t_flag text,
  t_seq integer,
  is_canceled integer,
  source_inf_id integer,
  synced_at text
);

CREATE TABLE erp_seed.erp_employee (
  emp_code text,
  emp_name text,
  emp_grade text,
  dept_code text,
  dept_name text,
  parent_dept_code text,
  parent_dept_name text,
  mobile_no text,
  email text,
  enter_date text,
  expire_date text,
  expire_yn text,
  direct_flag text,
  t_flag text,
  t_seq integer,
  is_canceled integer,
  source_inf_id integer,
  synced_at text
);

CREATE TABLE erp_seed.erp_item (
  plant_cd text,
  item_cd text,
  item_nm text,
  spec text,
  item_acct_cd text,
  item_acct_nm text,
  item_group_cd text,
  item_group_nm text,
  item_class text,
  item_class_nm text,
  basic_unit text,
  if_seq integer,
  create_type text,
  is_canceled integer,
  source_inf_id integer,
  synced_at text
);

CREATE TABLE erp_seed.erp_partner (
  bp_cd text,
  bp_nm text,
  bp_type text,
  bp_type_nm text,
  repre_nm text,
  tel_no text,
  zip_cd text,
  addr text,
  bp_prsn_nm text,
  bp_contact_pt text,
  email text,
  bp_rgst_no text,
  if_seq integer,
  create_type text,
  is_canceled integer,
  source_inf_id integer,
  synced_at text
);

CREATE TABLE erp_seed.erp_bom (
  plant_cd text,
  prnt_item_cd text,
  child_item_seq integer,
  child_item_cd text,
  prnt_item_qty numeric(20, 6),
  child_item_qty numeric(20, 6),
  prnt_item_unit text,
  child_item_unit text,
  if_seq integer,
  create_type text,
  is_canceled integer,
  source_inf_id integer,
  synced_at text
);

CREATE TABLE erp_seed.seed_adjustment (
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  field_name text NOT NULL,
  source_value text,
  seed_value text NOT NULL,
  reason text NOT NULL
);

-- __COPY_ERP_CODE__
-- __COPY_ERP_EMPLOYEE__
-- __COPY_ERP_ITEM__
-- __COPY_ERP_PARTNER__
-- __COPY_ERP_BOM__

\echo 'OMF MES initial-data seed: validating source snapshot'
DO $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*) INTO actual_count FROM erp_seed.erp_code;
  IF actual_count <> 244 THEN
    RAISE EXCEPTION 'erp_code count: expected 244, got %', actual_count;
  END IF;
  SELECT count(*) INTO actual_count FROM erp_seed.erp_employee;
  IF actual_count <> 786 THEN
    RAISE EXCEPTION 'erp_employee count: expected 786, got %', actual_count;
  END IF;
  SELECT count(*) INTO actual_count FROM erp_seed.erp_item;
  IF actual_count <> 9813 THEN
    RAISE EXCEPTION 'erp_item count: expected 9813, got %', actual_count;
  END IF;
  SELECT count(*) INTO actual_count FROM erp_seed.erp_partner;
  IF actual_count <> 931 THEN
    RAISE EXCEPTION 'erp_partner count: expected 931, got %', actual_count;
  END IF;
  SELECT count(*) INTO actual_count FROM erp_seed.erp_bom;
  IF actual_count <> 22793 THEN
    RAISE EXCEPTION 'erp_bom count: expected 22793, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM (
    SELECT item_cd
    FROM erp_seed.erp_item
    GROUP BY item_cd
    HAVING count(DISTINCT item_nm || '|' || item_acct_cd || '|' || basic_unit) > 1
  ) conflicts;
  IF actual_count > 0 THEN
    RAISE EXCEPTION '% item codes differ across plants', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM (
    SELECT normalize(item_cd, NFKC)
    FROM erp_seed.erp_item
    GROUP BY 1
    HAVING count(DISTINCT item_cd) > 1
  ) collisions;
  IF actual_count > 0 THEN
    RAISE EXCEPTION '% item codes collide after NFKC normalization', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM erp_seed.erp_bom source
  WHERE NOT EXISTS (
    SELECT 1 FROM erp_seed.erp_item item
    WHERE normalize(item.item_cd, NFKC) = normalize(source.prnt_item_cd, NFKC)
  );
  IF actual_count > 0 THEN
    RAISE EXCEPTION '% BOM parent references are missing from item source', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM erp_seed.erp_bom source
  WHERE NOT EXISTS (
    SELECT 1 FROM erp_seed.erp_item item
    WHERE normalize(item.item_cd, NFKC) = normalize(source.child_item_cd, NFKC)
  );
  IF actual_count > 0 THEN
    RAISE EXCEPTION '% BOM component references are missing from item source', actual_count;
  END IF;
END $$;

INSERT INTO erp_seed.seed_adjustment
  (entity_type, entity_key, field_name, source_value, seed_value, reason)
SELECT
  'BOM_COMPONENT',
  prnt_item_cd || ':' || child_item_seq || ':' || child_item_cd,
  'required_qty',
  child_item_qty::text,
  '1',
  'MES ck requires required_qty > 0; provisional customer-review value'
FROM erp_seed.erp_bom
WHERE child_item_qty <= 0;

INSERT INTO erp_seed.seed_adjustment
  (entity_type, entity_key, field_name, source_value, seed_value, reason)
SELECT
  'BOM_COMPONENT',
  source.prnt_item_cd || ':' || source.child_item_seq || ':' || source.child_item_cd,
  'sequence_no',
  source.child_item_seq::text,
  (source.child_item_seq + 1)::text,
  'BOM contains sequence 0; all component sequences shifted by +1 to preserve order'
FROM erp_seed.erp_bom source
WHERE EXISTS (
  SELECT 1
  FROM erp_seed.erp_bom invalid
  WHERE invalid.plant_cd = source.plant_cd
    AND invalid.prnt_item_cd = source.prnt_item_cd
    AND invalid.child_item_seq <= 0
);

\echo 'OMF MES initial-data seed: required reference and organization data'
INSERT INTO mdm.uom (uom_code, uom_name, decimal_scale)
VALUES
  ('EA', '개', 0),
  ('KG', '킬로그램', 3),
  ('GR', '그램(ERP)', 3),
  ('PC', '개(ERP)', 0),
  ('M2', '제곱미터', 3),
  ('SH', '장', 0)
ON CONFLICT (uom_code) DO NOTHING;

INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('ITEM_TYPE', '품목구분', false)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT code_group_id, value.code, value.code_name, value.display_order
FROM mdm.code_group
CROSS JOIN (VALUES
  ('RAW_MATERIAL', '원자재', 10),
  ('SEMI_FINISHED', '반제품', 20),
  ('FINISHED', '제품', 30),
  ('MERCHANDISE', '상품', 40),
  ('SUBSIDIARY_MATERIAL', '부자재', 50)
) AS value(code, code_name, display_order)
WHERE group_code = 'ITEM_TYPE'
ON CONFLICT (code_group_id, code) DO NOTHING;

INSERT INTO mdm.legal_entity
  (legal_entity_code, legal_entity_name, country_code, timezone_code)
VALUES ('SAMJIN_LND_VINA', 'Samjin LND Vina', 'VN', 'Asia/Ho_Chi_Minh')
ON CONFLICT (legal_entity_code) DO NOTHING;

INSERT INTO mdm.business_unit
  (legal_entity_id, business_unit_code, business_unit_name)
SELECT legal_entity_id, 'VIETNAM', 'Vietnam Operations'
FROM mdm.legal_entity
WHERE legal_entity_code = 'SAMJIN_LND_VINA'
ON CONFLICT (legal_entity_id, business_unit_code) DO NOTHING;

INSERT INTO mdm.plant
  (legal_entity_id, business_unit_id, plant_code, plant_name, timezone_code)
SELECT entity.legal_entity_id, unit.business_unit_id, plant.code, plant.name,
       'Asia/Ho_Chi_Minh'
FROM mdm.legal_entity entity
JOIN mdm.business_unit unit
  ON unit.legal_entity_id = entity.legal_entity_id
 AND unit.business_unit_code = 'VIETNAM'
CROSS JOIN (VALUES ('PL11', 'Parts Plant'), ('PL13', 'OA Plant')) plant(code, name)
WHERE entity.legal_entity_code = 'SAMJIN_LND_VINA'
ON CONFLICT (legal_entity_id, plant_code) DO NOTHING;

INSERT INTO erp_seed.seed_adjustment
  (entity_type, entity_key, field_name, source_value, seed_value, reason)
VALUES
  ('LEGAL_ENTITY', 'SAMJIN_LND_VINA', 'identity', NULL,
   'Samjin LND Vina|VN|Asia/Ho_Chi_Minh', 'Provisional organization value'),
  ('BUSINESS_UNIT', 'VIETNAM', 'identity', NULL,
   'Vietnam Operations', 'Provisional organization value'),
  ('PLANT', 'PL11', 'plant_name', NULL, 'Parts Plant', 'Provisional organization value'),
  ('PLANT', 'PL13', 'plant_name', NULL, 'OA Plant', 'Provisional organization value');

\echo 'OMF MES initial-data seed: ERP code, department, worker and partner data'
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
SELECT type_code, min(type_name), false
FROM erp_seed.erp_code
GROUP BY type_code
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value
  (code_group_id, code, code_name, name_ko, display_order)
SELECT group_row.code_group_id, source.code, min(source.code_name),
       min(source.code_name), 0
FROM erp_seed.erp_code source
JOIN mdm.code_group group_row ON group_row.group_code = source.type_code
GROUP BY group_row.code_group_id, source.code
ON CONFLICT (code_group_id, code) DO NOTHING;

WITH names AS (
  SELECT dept_code AS code, dept_name AS name, count(*) AS frequency
  FROM erp_seed.erp_employee
  WHERE coalesce(dept_code, '') <> ''
  GROUP BY dept_code, dept_name
  UNION ALL
  SELECT parent_dept_code, parent_dept_name, count(*)
  FROM erp_seed.erp_employee
  WHERE coalesce(parent_dept_code, '') <> ''
  GROUP BY parent_dept_code, parent_dept_name
), ranked AS (
  SELECT code, name,
         row_number() OVER (PARTITION BY code ORDER BY frequency DESC, name) AS rank
  FROM names
)
INSERT INTO mdm.department
  (department_code, department_name, name_vi, business_unit_id, source_system_code)
SELECT ranked.code, left(ranked.name, 200), left(ranked.name, 200),
       unit.business_unit_id, 'ERP'
FROM ranked
CROSS JOIN mdm.legal_entity entity
JOIN mdm.business_unit unit
  ON unit.legal_entity_id = entity.legal_entity_id
 AND unit.business_unit_code = 'VIETNAM'
WHERE ranked.rank = 1
  AND entity.legal_entity_code = 'SAMJIN_LND_VINA'
ON CONFLICT (department_code) DO NOTHING;

UPDATE mdm.department child
SET parent_department_id = parent.department_id
FROM (
  SELECT DISTINCT dept_code, parent_dept_code
  FROM erp_seed.erp_employee
  WHERE coalesce(parent_dept_code, '') <> ''
) source
JOIN mdm.department parent ON parent.department_code = source.parent_dept_code
WHERE child.department_code = source.dept_code
  AND child.parent_department_id IS DISTINCT FROM parent.department_id;

INSERT INTO mdm.worker
  (worker_no, worker_name, name_vi, business_unit_id, plant_id,
   department_id, status_code, is_active)
SELECT source.emp_code, left(source.emp_name, 200), left(source.emp_name, 200),
       unit.business_unit_id,
       CASE WHEN source.dept_name LIKE 'OA%' THEN oa.plant_id ELSE parts.plant_id END,
       department.department_id,
       CASE WHEN source.expire_yn = 'Y' THEN 'RESIGNED' ELSE 'EMPLOYED' END,
       source.expire_yn <> 'Y'
FROM erp_seed.erp_employee source
LEFT JOIN mdm.department department ON department.department_code = source.dept_code
CROSS JOIN mdm.legal_entity entity
JOIN mdm.business_unit unit
  ON unit.legal_entity_id = entity.legal_entity_id
 AND unit.business_unit_code = 'VIETNAM'
JOIN mdm.plant parts
  ON parts.legal_entity_id = entity.legal_entity_id AND parts.plant_code = 'PL11'
JOIN mdm.plant oa
  ON oa.legal_entity_id = entity.legal_entity_id AND oa.plant_code = 'PL13'
WHERE entity.legal_entity_code = 'SAMJIN_LND_VINA'
ON CONFLICT (worker_no) DO NOTHING;

INSERT INTO mdm.partner (partner_code, partner_name, erp_partner_code)
SELECT bp_cd, left(bp_nm, 200), bp_cd
FROM erp_seed.erp_partner
ON CONFLICT (partner_code) DO NOTHING;

INSERT INTO mdm.partner_role (partner_id, role_type_code)
SELECT partner.partner_id, role.code
FROM erp_seed.erp_partner source
JOIN mdm.partner partner ON partner.partner_code = source.bp_cd
CROSS JOIN LATERAL unnest(CASE source.bp_type
  WHEN 'S' THEN ARRAY['SUPPLIER']
  WHEN 'C' THEN ARRAY['CUSTOMER']
  WHEN 'CS' THEN ARRAY['SUPPLIER', 'CUSTOMER']
  WHEN '*' THEN ARRAY['CUSTOMER']
  ELSE ARRAY[]::text[]
END) role(code)
ON CONFLICT (partner_id, role_type_code) DO NOTHING;

\echo 'OMF MES initial-data seed: item and warehouse data'
WITH external_warehouse AS (
  SELECT code, code_name
  FROM erp_seed.erp_code
  WHERE type_code = 'SL_TYPE'
    AND NOT (code LIKE 'WH%' OR code ~ '^S[0-9]')
), unresolved AS (
  SELECT warehouse.code, warehouse.code_name
  FROM external_warehouse warehouse
  LEFT JOIN erp_seed.erp_partner exact_partner
    ON exact_partner.bp_cd = warehouse.code
  LEFT JOIN erp_seed.erp_partner named_partner
    ON warehouse.code LIKE 'OH%'
   AND named_partner.bp_cd = substring(warehouse.code FROM 3)
   AND lower(trim(named_partner.bp_nm)) = lower(trim(warehouse.code_name))
  WHERE exact_partner.bp_cd IS NULL AND named_partner.bp_cd IS NULL
)
INSERT INTO mdm.partner (partner_code, partner_name, country_code)
SELECT 'EXTWH_' || code, left(code_name || ' external warehouse', 200), 'VN'
FROM unresolved
ON CONFLICT (partner_code) DO NOTHING;

INSERT INTO erp_seed.seed_adjustment
  (entity_type, entity_key, field_name, source_value, seed_value, reason)
SELECT 'WAREHOUSE', source.code, 'partner_id', NULL, 'EXTWH_' || source.code,
       'External warehouse requires partner_id; no reliable ERP partner match'
FROM erp_seed.erp_code source
LEFT JOIN erp_seed.erp_partner exact_partner ON exact_partner.bp_cd = source.code
LEFT JOIN erp_seed.erp_partner named_partner
  ON source.code LIKE 'OH%'
 AND named_partner.bp_cd = substring(source.code FROM 3)
 AND lower(trim(named_partner.bp_nm)) = lower(trim(source.code_name))
WHERE source.type_code = 'SL_TYPE'
  AND NOT (source.code LIKE 'WH%' OR source.code ~ '^S[0-9]')
  AND exact_partner.bp_cd IS NULL
  AND named_partner.bp_cd IS NULL;

WITH deduplicated AS (
  SELECT item_cd, min(item_nm) AS item_nm, min(item_acct_cd) AS item_acct_cd,
         min(basic_unit) AS basic_unit
  FROM erp_seed.erp_item
  GROUP BY item_cd
)
INSERT INTO mdm.item
  (item_code, item_name, name_vi, item_type_code, base_uom_id)
SELECT source.item_cd, left(source.item_nm, 200), left(source.item_nm, 200),
       CASE source.item_acct_cd
         WHEN '10' THEN 'FINISHED'
         WHEN '20' THEN 'SEMI_FINISHED'
         WHEN '30' THEN 'RAW_MATERIAL'
         WHEN '35' THEN 'SUBSIDIARY_MATERIAL'
         WHEN '50' THEN 'MERCHANDISE'
       END,
       unit.uom_id
FROM deduplicated source
JOIN mdm.uom unit ON unit.uom_code = source.basic_unit
ON CONFLICT (item_code) DO NOTHING;

-- AD0404-00022 는 ERP 원본에 있으면서 위 적재에서 빠진다. 하노이 현장이 쓰는 자재라
-- 여기서 명시로 채운다(원본에 다시 들어오면 위 INSERT 가 먼저 잡고 이 블록은 비활성).
INSERT INTO mdm.item
  (item_code, item_name, name_vi, item_type_code, base_uom_id)
SELECT 'AD0404-00022', 'HA100038-2510 WW', 'HA100038-2510 WW', 'RAW_MATERIAL',
       unit.uom_id
FROM mdm.uom unit
WHERE unit.uom_code = 'EA'
ON CONFLICT (item_code) DO NOTHING;

-- IQC 대상 자재. ERP 원본에 검사 여부가 없어 여기서 지정한다.
UPDATE mdm.item
   SET inspection_required = true
 WHERE item_code IN (
   'AD0303-00037', 'AD0303-00038', 'AD0404-00022',
   'AD0509-00058', '040101-00064', 'AD9001-00041'
 );

INSERT INTO mdm.item_external_code
  (item_id, external_system_code, external_item_code)
SELECT item.item_id, 'ERP', item.item_code
FROM mdm.item item
WHERE EXISTS (
  SELECT 1 FROM erp_seed.erp_item source WHERE source.item_cd = item.item_code
)
ON CONFLICT DO NOTHING;

INSERT INTO mdm.warehouse
  (plant_id, business_unit_id, warehouse_code, warehouse_name,
   warehouse_type_code, management_level_code, is_external, partner_id)
SELECT
  CASE WHEN source.code LIKE 'WH%' THEN parts.plant_id
       WHEN source.code ~ '^S[0-9]' THEN oa.plant_id
       ELSE parts.plant_id END,
  unit.business_unit_id,
  source.code,
  left(source.code_name, 200),
  CASE WHEN source.code_name ~* '자재|원자재|NVL|RAW MAT|SUBSIDIARY|Nguyên'
         THEN 'MATERIAL'
       WHEN source.code_name ~* '제품|Thành Phẩm|SALES|PRODUCT'
         THEN 'PRODUCT'
       ELSE 'GENERAL' END,
  'WAREHOUSE',
  NOT (source.code LIKE 'WH%' OR source.code ~ '^S[0-9]'),
  CASE WHEN source.code LIKE 'WH%' OR source.code ~ '^S[0-9]' THEN NULL
       ELSE coalesce(exact_partner.partner_id, named_partner.partner_id,
                     placeholder_partner.partner_id) END
FROM erp_seed.erp_code source
CROSS JOIN mdm.legal_entity entity
JOIN mdm.business_unit unit
  ON unit.legal_entity_id = entity.legal_entity_id
 AND unit.business_unit_code = 'VIETNAM'
JOIN mdm.plant parts
  ON parts.legal_entity_id = entity.legal_entity_id AND parts.plant_code = 'PL11'
JOIN mdm.plant oa
  ON oa.legal_entity_id = entity.legal_entity_id AND oa.plant_code = 'PL13'
LEFT JOIN mdm.partner exact_partner ON exact_partner.partner_code = source.code
LEFT JOIN mdm.partner named_partner
  ON source.code LIKE 'OH%'
 AND named_partner.partner_code = substring(source.code FROM 3)
 AND lower(trim(named_partner.partner_name)) = lower(trim(source.code_name))
LEFT JOIN mdm.partner placeholder_partner
  ON placeholder_partner.partner_code = 'EXTWH_' || source.code
WHERE source.type_code = 'SL_TYPE'
  AND entity.legal_entity_code = 'SAMJIN_LND_VINA'
ON CONFLICT (plant_id, warehouse_code) DO NOTHING;

\echo 'OMF MES initial-data seed: BOM data'
INSERT INTO planning.bom
  (parent_item_id, bom_code, bom_version, status_code,
   is_default, effective_from, base_qty, base_uom_id)
SELECT parent_item.item_id, 'ERP-' || source.prnt_item_cd, 1, 'CONFIRMED',
       true, DATE '2026-08-25', min(source.prnt_item_qty), min(unit.uom_id)
FROM erp_seed.erp_bom source
JOIN mdm.item parent_item
  ON normalize(parent_item.item_code, NFKC) = normalize(source.prnt_item_cd, NFKC)
JOIN mdm.uom unit ON unit.uom_code = source.prnt_item_unit
GROUP BY parent_item.item_id, source.prnt_item_cd
ON CONFLICT (parent_item_id, bom_code, bom_version) DO NOTHING;

INSERT INTO planning.bom_component
  (bom_id, component_item_id, required_qty, uom_id, sequence_no)
SELECT bom.bom_id, component_item.item_id,
       CASE WHEN source.child_item_qty > 0 THEN source.child_item_qty ELSE 1 END,
       unit.uom_id,
       CASE WHEN EXISTS (
         SELECT 1
         FROM erp_seed.erp_bom invalid
         WHERE invalid.plant_cd = source.plant_cd
           AND invalid.prnt_item_cd = source.prnt_item_cd
           AND invalid.child_item_seq <= 0
       ) THEN source.child_item_seq + 1 ELSE source.child_item_seq END
FROM erp_seed.erp_bom source
JOIN mdm.item parent_item
  ON normalize(parent_item.item_code, NFKC) = normalize(source.prnt_item_cd, NFKC)
JOIN planning.bom bom
  ON bom.parent_item_id = parent_item.item_id
 AND bom.bom_code = 'ERP-' || source.prnt_item_cd
 AND bom.bom_version = 1
JOIN mdm.item component_item
  ON normalize(component_item.item_code, NFKC) = normalize(source.child_item_cd, NFKC)
JOIN mdm.uom unit ON unit.uom_code = source.child_item_unit
ON CONFLICT (bom_id, sequence_no) DO NOTHING;

\echo 'OMF MES initial-data seed: verifying target counts'
DO $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*) INTO actual_count FROM mdm.department
  WHERE department_code IN (
    SELECT dept_code FROM erp_seed.erp_employee WHERE dept_code IS NOT NULL
    UNION
    SELECT parent_dept_code FROM erp_seed.erp_employee WHERE parent_dept_code IS NOT NULL
  );
  IF actual_count <> 15 THEN
    RAISE EXCEPTION 'department target count: expected 15, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM mdm.worker
  WHERE worker_no IN (SELECT emp_code FROM erp_seed.erp_employee);
  IF actual_count <> 786 THEN
    RAISE EXCEPTION 'worker target count: expected 786, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM mdm.partner
  WHERE partner_code IN (SELECT bp_cd FROM erp_seed.erp_partner);
  IF actual_count <> 931 THEN
    RAISE EXCEPTION 'ERP partner target count: expected 931, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM mdm.partner
  WHERE partner_code LIKE 'EXTWH\_%' ESCAPE '\';
  IF actual_count < 5 THEN
    RAISE EXCEPTION 'external warehouse placeholder partners: expected at least 5, got %',
      actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM mdm.item
  WHERE inspection_required
    AND item_code IN ('AD0303-00037', 'AD0303-00038', 'AD0404-00022',
                      'AD0509-00058', '040101-00064', 'AD9001-00041');
  IF actual_count <> 6 THEN
    RAISE EXCEPTION 'IQC item count: expected 6, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM mdm.item
  WHERE item_code IN (SELECT item_cd FROM erp_seed.erp_item);
  IF actual_count <> 9270 THEN
    RAISE EXCEPTION 'item target count: expected 9270, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM mdm.warehouse warehouse
  WHERE EXISTS (
    SELECT 1 FROM erp_seed.erp_code source
    WHERE source.type_code = 'SL_TYPE' AND source.code = warehouse.warehouse_code
  );
  IF actual_count <> 33 THEN
    RAISE EXCEPTION 'warehouse target count: expected 33, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM planning.bom
  WHERE bom_code IN (SELECT DISTINCT 'ERP-' || prnt_item_cd FROM erp_seed.erp_bom);
  IF actual_count <> 4198 THEN
    RAISE EXCEPTION 'BOM target count: expected 4198, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count
  FROM planning.bom_component component
  JOIN planning.bom bom ON bom.bom_id = component.bom_id
  WHERE bom.bom_code IN (
    SELECT DISTINCT 'ERP-' || prnt_item_cd FROM erp_seed.erp_bom
  );
  IF actual_count <> 22793 THEN
    RAISE EXCEPTION 'BOM component target count: expected 22793, got %', actual_count;
  END IF;

  SELECT count(*) INTO actual_count FROM mdm.mold;
  RAISE NOTICE 'mdm.mold unchanged by this seed; current total=%', actual_count;
END $$;

SELECT entity_type, field_name, count(*) AS adjusted_rows
FROM erp_seed.seed_adjustment
GROUP BY entity_type, field_name
ORDER BY entity_type, field_name;

\if :apply
COMMIT;
\echo 'OMF MES initial-data seed committed'
\else
ROLLBACK;
\echo 'OMF MES initial-data seed dry-run rolled back'
\endif
