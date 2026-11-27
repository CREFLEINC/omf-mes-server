-- 부품사업부(PL11) 레진 수입검사(IQC) 기준 — 기준서 SJS-QIQ-101 Rev1(2025-05-07) · 「CHECK SHEET IQC RESIN」.
--
-- 선행: 표준 시드(node dist/seed.js) → mes-initial-data.sql. 운영 DB 에도 넣는 고객 기준정보다.
-- 다시 실행해도 이미 있는 것은 건너뛴다.
--
-- 기준서는 레진 전체에 하나고 MFR 시험 조건만 재질마다 다르다. MES 기준은 품목 하나에 붙고 품목군 기준이 없어서
-- (「전 품목 공통」은 레진 아닌 품목까지 받는다) 레진 품목마다 같은 기준을 복사한다(사용자 결정 2026-11-27).
--
-- 만드는 것
--   단위 G/10MIN 1     — MFR 측정값 단위
--   IQC 기준 190       — 신코드 0401 레진 전부. 품목마다 기준 1 · 버전 1(CONFIRMED) · 항목 5(MFR 조건 없는 재질은 4)
--   검사 대상 켬        — 위 품목의 inspection_required = true. 입하 때마다 IQC 의뢰가 서고 판정 전까지 LOT 은 검사 대기다
--
-- 건너뛰는 것 — 그 품목에 활성 IQC 기준이 이미 있으면(사람이 만든 기준 · 「기본 생략」 헤더 · 둘 이상) 건드리지 않고
-- 끝 보고에 KEEP 으로 남긴다. 품목 화면이 만든 버전 없는 헤더는 그 헤더에 버전을 붙인다.
--
-- 실행
--   SQL_FILE=seed/mes-iqc-resin-standard.sql seed/load-mes-initial-data.sh --dry-run
--   SQL_FILE=seed/mes-iqc-resin-standard.sql seed/load-mes-initial-data.sh

\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif

\echo 'OMF MES IQC resin seed: 원천 값·사전조건'
BEGIN;

-- 기준서의 Repot Test 표. 시험 시간은 모두 5초, 시료 2g 이다. 합격선은 「초과」인데 MES 는 하한을 포함해 판정한다.
CREATE TEMP TABLE resin_material (
  material_code text PRIMARY KEY,
  temperature_c integer NOT NULL,
  weight_g integer NOT NULL,
  mfr_lower numeric(20, 6) NOT NULL
) ON COMMIT DROP;

INSERT INTO resin_material (material_code, temperature_c, weight_g, mfr_lower)
VALUES
  ('PC', 300, 1200, 10),
  ('ABS', 220, 10000, 10),
  ('HIPS', 200, 5000, 4),
  ('PC/ABS', 250, 2160, 4),
  ('POM', 190, 2160, 6);

-- 재질은 ERP 품목 코드 앞자리(040101 PC · 040102 ABS · 040113 POM · 040114 PS/HIPS)로 갈린다.
-- 040101 안의 PC/ABS 11개만 ERP 규격(spec)의 「PC/ABS」·「PC+ABS」로 골랐다. OTHER 는 기준서에 MFR 조건이 없는
-- 재질(PMMA·PA·PP·PBT·PPS·PPSU·TPE·POLYKETONE)이라 MFR 항목을 넣지 않는다.
-- 목록을 코드로 고정한다 — 뒤에 생긴 레진 품목을 앞자리만 보고 PC 로 넣지 않게.
CREATE TEMP TABLE resin_item ON COMMIT DROP AS
SELECT source.material_code, unnest(source.item_codes) AS item_code
FROM (VALUES
  ('PC', ARRAY[
    '040101-00016', '040101-00022', '040101-00022S', '040101-00029', '040101-00029S', '040101-00042', '040101-00042S', '040101-00043',
    '040101-00043C', '040101-00044', '040101-00045', '040101-00046', '040101-00046S', '040101-00047', '040101-00047C', '040101-00047S',
    '040101-00048', '040101-00048C', '040101-00049', '040101-00050', '040101-00051', '040101-00052', '040101-00053', '040101-00054',
    '040101-00054C', '040101-00055', '040101-00056', '040101-00057', '040101-00058', '040101-00059', '040101-00059C', '040101-00060',
    '040101-00061', '040101-00061C', '040101-00062', '040101-00063', '040101-00063S', '040101-00064', '040101-00064S', '040101-00065',
    '040101-00066', '040101-00067', '040101-00067C', '040101-00068', '040101-00069', '040101-00070', '040101-00070C', '040101-00071',
    '040101-00072', '040101-00073', '040101-00074', '040101-00075', '040101-00076', '040101-00077', '040101-00077C', '040101-00077S',
    '040101-00079', '040101-00082', '040101-00083', '040101-00085', '040101-00086', '040101-00087', '040101-00088', '040101-00090',
    '040101-00091', '040101-00092', '040101-00092S', '040101-00093', '040101-00094', '040101-00098', '040101-00099', '040101-00104',
    '040101-00105', '040101-00106', '040101-00107']),
  ('PC/ABS', ARRAY[
    '040101-00078', '040101-00078S', '040101-00080', '040101-00080S', '040101-00081', '040101-00081C', '040101-00081S', '040101-00084',
    '040101-00089', '040101-00095', '040101-00097']),
  ('ABS', ARRAY[
    '040102-00002', '040102-00002C', '040102-00003', '040102-00004', '040102-00004C', '040102-00005', '040102-00006', '040102-00006C',
    '040102-00007', '040102-00008', '040102-00008S', '040102-00009', '040102-00010', '040102-00010C', '040102-00011', '040102-00011C',
    '040102-00012', '040102-00012C', '040102-00013', '040102-00013C', '040102-00014', '040102-00014C', '040102-00015', '040102-00015C',
    '040102-00016', '040102-00016C', '040102-00017', '040102-00018', '040102-00019', '040102-00019C', '040102-00020', '040102-00020C',
    '040102-00020S', '040102-00021', '040102-00021C', '040102-00022', '040102-00023', '040102-00024', '040102-00025', '040102-00026',
    '040102-00027', '040102-00028', '040102-00029', '040102-00030', '040102-00031', '040102-00032', '040102-00033']),
  ('HIPS', ARRAY[
    '040114-00001', '040114-00002', '040114-00003', '040114-00003S', '040114-00004', '040114-00005', '040114-00006', '040114-00006S',
    '040114-00007', '040114-00007C', '040114-00008', '040114-00008C', '040114-00019', '040114-00019C', '040114-00020', '040114-00021',
    '040114-00022', '040114-00023', '040114-00024']),
  ('POM', ARRAY[
    '040113-00001', '040113-00001C', '040113-00003', '040113-00003C', '040113-00004', '040113-00004C', '040113-00005', '040113-00005C',
    '040113-00006', '040113-00007', '040113-00007C', '040113-00008', '040113-00008C', '040113-00009', '040113-00009C', '040113-00010',
    '040113-00011', '040113-00012', '040113-00013', '040113-00014']),
  ('OTHER', ARRAY[
    '040103-00001', '040103-00002', '040103-00003', '040104-00002', '040104-00002C', '040104-00003', '040104-00004', '040104-00005',
    '040106-00008', '040106-00009', '040109-00008', '040109-00009', '040111-00001', '040111-00002', '040116-00001', '040117-00001',
    '040117-00002', '040119-00001'])
) source(material_code, item_codes);

-- 안내 문구는 기준서 문장 그대로다(베트남어는 원문). MFR 줄은 조건이 있는 재질에만 싣는다.
CREATE TEMP TABLE resin_guide ON COMMIT DROP AS
SELECT has_mfr, concat_ws(E'\n',
  '기준서 SJS-QIQ-101 Rev1 (2025-05-07) · 매 LOT',
  '· 조도 800~1000 LUX 에서 검사한다.',
  '· 외관(시료 1kg): 한도 견본과 대조한다. 이물이 섞이거나 한 박스에 두 색이 섞이면 불합격. 흑점 길이 0.4mm 이상 / 면적 0.16mm 이상이면 불합격. 오염·홍선·청선이 생기면 불합격.',
  CASE WHEN has_mfr THEN '· MFR(시료 2g · MI 측정기): 재질별 온도·추 무게는 항목 이름에, 합격선은 하한에 있다.' END,
  '· 색상: 검정·흰색·회색 등 색을 적고 이물이 섞였는지 본다.',
  '· 입고 대장·성적서: LOT 입고 때 공급사가 자료를 보냈는지 확인한다.',
  '· RoHS: 공급사 ICP 자료를 참고한다.',
  '',
  'Tiêu chuẩn SJS-QIQ-101 Rev1 (07.05.2025) · Mỗi LOT',
  '· Độ chiếu sáng phải được kiểm tra trong điều kiện 800 ~ 1000LUX',
  '· Ngoại quan (1kg): Đối chiếu bề ngoài (đối chiếu mẫu chuẩn hoặc kiểm tra để xem có gì bất thường không), Hạt nhựa không được lẫn với các tạp chất, không lẫn các hạt nhựa khắc màu bên trong box. Kích thước chấm đen chiều dài từ 0.4mm trở lên / diện tích từ 0.16mm trở lên → Xử lý là không đạt. Khi xảy ra vết bẩn, đốm đỏ, đốm xanh → Xử lý là không đạt',
  CASE WHEN has_mfr THEN '· Repot Test (n=2g · Máy đo MI)' END,
  '· Xác định mầu nhựa (đen, trắng, xám..., có lẫn tạp chất không)',
  '· Khi LOT nhập kho, xác nhận sổ theo dõi và giấy chứng nhận vật liệu đã được cung cấp chưa',
  '· RoHS: Tham khảo ICP DATA của nhà cung cấp'
) AS guide_text
FROM (VALUES (true), (false)) flag(has_mfr);

CREATE TEMP TABLE resin_context ON COMMIT DROP AS
SELECT (SELECT app_user_id FROM app.app_user WHERE login_id = 'admin') AS admin_user_id;

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(source.item_code, ', ' ORDER BY source.item_code) INTO missing
  FROM resin_item source
  LEFT JOIN mdm.item item ON item.item_code = source.item_code
  WHERE item.item_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '레진 품목이 없습니다: % — mes-initial-data.sql 을 먼저 적재하세요', missing;
  END IF;

  -- 검사 수량(1kg)을 기본 단위로 적는다 — 둘 말고는 환산을 모른다.
  SELECT string_agg(item.item_code || '(' || uom.uom_code || ')', ', ' ORDER BY item.item_code) INTO missing
  FROM resin_item source
  JOIN mdm.item item ON item.item_code = source.item_code
  JOIN mdm.uom uom ON uom.uom_id = item.base_uom_id
  WHERE uom.uom_code NOT IN ('KG', 'GR');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '기본 단위가 KG·GR 이 아닌 레진 품목이 있습니다: %', missing;
  END IF;

  -- 물리에 CHECK 가 없는 코드 칸이라 여기서 지킨다.
  SELECT string_agg(expected.group_code || '/' || expected.code, ', ') INTO missing
  FROM (VALUES
    ('QUALITY_INSPECTION_TYPE', 'IQC'),
    ('MASTER_VERSION_STATUS', 'CONFIRMED'),
    ('INSPECTION_SAMPLING_METHOD', 'SAMPLE_BY_LOT'),
    ('INSPECTION_FREQUENCY', 'MATERIAL_LOT'),
    ('INSPECTION_ITEM_SPEC_DATA_TYPE', 'NUMERIC'),
    ('INSPECTION_ITEM_SPEC_DATA_TYPE', 'TEXT'),
    ('INSPECTION_ITEM_SPEC_DATA_TYPE', 'BOOLEAN'),
    ('INSPECTION_ITEM_SPEC_METHOD', 'MEASUREMENT'),
    ('INSPECTION_ITEM_SPEC_METHOD', 'VISUAL')
  ) expected(group_code, code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM mdm.code_group code_group
    JOIN mdm.code_value code_value ON code_value.code_group_id = code_group.code_group_id
    WHERE code_group.group_code = expected.group_code AND code_value.code = expected.code
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '표준 시드 코드값이 없습니다: % — node dist/seed.js 를 먼저 실행하세요', missing;
  END IF;
END $$;

\echo 'OMF MES IQC resin seed: MFR 단위'
INSERT INTO mdm.uom (uom_code, uom_name, decimal_scale, created_by)
SELECT 'G/10MIN', 'g/10min', 2, context.admin_user_id
FROM resin_context context
ON CONFLICT (uom_code) DO NOTHING;

\echo 'OMF MES IQC resin seed: 품목별 처리 구분'
-- 입하는 활성 IQC 기준 중 그 날짜에 유효한 확정 버전이 «정확히 하나»일 때만 기준을 쓴다(inspection-plan-version.ts).
-- 이미 활성 기준이 있는 품목에 하나를 더 세우면 둘이 되어 기준 없는 의뢰로 떨어진다 — 그래서 있으면 건드리지 않는다.
CREATE TEMP TABLE resin_target ON COMMIT DROP AS
SELECT source.item_code, source.material_code, item.item_id, item.item_name, uom.uom_code AS base_uom_code,
       (SELECT count(*) FROM quality.inspection_plan plan
         WHERE plan.item_id = item.item_id AND plan.inspection_type_code = 'IQC' AND plan.is_active) AS active_plan_count,
       (SELECT min(plan.inspection_plan_id) FROM quality.inspection_plan plan
         WHERE plan.item_id = item.item_id AND plan.inspection_type_code = 'IQC' AND plan.is_active
           AND NOT plan.default_skip
           AND NOT EXISTS (SELECT 1 FROM quality.inspection_plan_version version
                            WHERE version.inspection_plan_id = plan.inspection_plan_id)) AS empty_header_id,
       EXISTS (SELECT 1 FROM quality.inspection_plan plan
                JOIN quality.inspection_plan_version version ON version.inspection_plan_id = plan.inspection_plan_id
                JOIN quality.inspection_item_spec spec ON spec.inspection_plan_version_id = version.inspection_plan_version_id
               WHERE plan.item_id = item.item_id AND plan.inspection_type_code = 'IQC' AND plan.is_active
                 AND spec.inspection_item_code = 'RESIN-APPEARANCE') AS seeded,
       NULL::text AS action,
       NULL::bigint AS inspection_plan_id,
       NULL::bigint AS inspection_plan_version_id
FROM resin_item source
JOIN mdm.item item ON item.item_code = source.item_code
JOIN mdm.uom uom ON uom.uom_id = item.base_uom_id;

UPDATE resin_target
   SET action = CASE
         WHEN seeded THEN 'SEEDED'
         WHEN active_plan_count = 0 THEN 'CREATE'
         WHEN active_plan_count = 1 AND empty_header_id IS NOT NULL THEN 'REUSE'
         ELSE 'KEEP'
       END,
       inspection_plan_id = CASE WHEN NOT seeded AND active_plan_count = 1 THEN empty_header_id END;

\echo 'OMF MES IQC resin seed: 기준 헤더'
-- 코드·이름은 품목 화면이 만드는 헤더(item-iqc-plan-sync.ts)와 같게 — IQC-품목코드, 쓰였으면 IQC-ITEM-품목id.
WITH created AS (
  INSERT INTO quality.inspection_plan
    (inspection_plan_code, inspection_plan_name, item_id, inspection_type_code, is_active,
     default_skip, pqc_skip_allowed, created_by)
  SELECT CASE WHEN EXISTS (SELECT 1 FROM quality.inspection_plan taken
                            WHERE taken.inspection_plan_code = 'IQC-' || target.item_code)
              THEN 'IQC-ITEM-' || target.item_id
              ELSE 'IQC-' || target.item_code END,
         left(target.item_name || ' 수입검사', 200),
         target.item_id, 'IQC', true, false, false, context.admin_user_id
  FROM resin_target target
  CROSS JOIN resin_context context
  WHERE target.action = 'CREATE'
  RETURNING inspection_plan_id, item_id
)
UPDATE resin_target target
   SET inspection_plan_id = created.inspection_plan_id
  FROM created
 WHERE created.item_id = target.item_id;

\echo 'OMF MES IQC resin seed: 기준 버전'
-- 외관 시료 1kg 을 LOT 마다 본다 — 검사 수량은 기본 단위(KG 1 · GR 1000)다. 불량이 하나라도 있으면 불합격(Ac 0 · Re 1).
WITH created AS (
  INSERT INTO quality.inspection_plan_version
    (inspection_plan_id, plan_version, effective_from, effective_to, sampling_method_code, sampling_qty,
     acceptance_number, rejection_number, inspection_frequency_code, status_code, guide_text, created_by)
  SELECT target.inspection_plan_id, 1, DATE '2025-05-07', NULL, 'SAMPLE_BY_LOT',
         CASE target.base_uom_code WHEN 'KG' THEN 1 WHEN 'GR' THEN 1000 END,
         0, 1, 'MATERIAL_LOT', 'CONFIRMED', guide.guide_text, context.admin_user_id
  FROM resin_target target
  JOIN resin_guide guide ON guide.has_mfr = (target.material_code <> 'OTHER')
  CROSS JOIN resin_context context
  WHERE target.action IN ('CREATE', 'REUSE')
  RETURNING inspection_plan_version_id, inspection_plan_id
)
UPDATE resin_target target
   SET inspection_plan_version_id = created.inspection_plan_version_id
  FROM created
 WHERE created.inspection_plan_id = target.inspection_plan_id;

\echo 'OMF MES IQC resin seed: 검사 항목'
-- 순서는 기준서 항목 번호 그대로다 — MFR 이 없는 재질은 2번이 빈다.
-- 이름은 현장 표기(베트남어)에 한국어를 붙인다. 판정은 모두 사람이 OK/NG 하고 MFR 만 하한으로 자동 판정한다.
INSERT INTO quality.inspection_item_spec
  (inspection_plan_version_id, sequence_no, inspection_item_code, inspection_item_name, name_ko, name_vi,
   data_type_code, uom_id, lower_limit, measurement_count, inspection_method_code, required_flag,
   automatic_judgment, created_by)
SELECT target.inspection_plan_version_id, spec.sequence_no, spec.item_code, spec.name_vi || ' (' || spec.name_ko || ')',
       spec.name_ko, spec.name_vi, spec.data_type_code, NULL, NULL, 1, spec.method_code, true, true,
       context.admin_user_id
FROM resin_target target
CROSS JOIN (VALUES
  (1, 'RESIN-APPEARANCE', '외관', 'Ngoại quan', 'BOOLEAN', 'VISUAL'),
  (3, 'RESIN-COLOR', '색상 확인', 'Kiểm tra màu nhựa', 'TEXT', 'VISUAL'),
  (4, 'RESIN-RECEIPT-DOC', '입고 대장·성적서 확인', 'Sổ theo dõi nhập kho · giấy chứng nhận vật liệu', 'BOOLEAN', NULL),
  (5, 'RESIN-ROHS', 'RoHS 적합', 'Phù hợp tiêu chuẩn quản lý RoHS', 'BOOLEAN', NULL)
) spec(sequence_no, item_code, name_ko, name_vi, data_type_code, method_code)
CROSS JOIN resin_context context
WHERE target.inspection_plan_version_id IS NOT NULL
UNION ALL
SELECT target.inspection_plan_version_id, 2, 'RESIN-MFR', 'Repot Test MFR (용융지수) ' || mfr.condition,
       '용융지수(MFR) ' || mfr.condition, 'Repot Test MFR ' || mfr.condition, 'NUMERIC', uom.uom_id,
       material.mfr_lower, 1, 'MEASUREMENT', true, true, context.admin_user_id
FROM resin_target target
JOIN resin_material material ON material.material_code = target.material_code
CROSS JOIN LATERAL (
  SELECT format('%s %s°C · %sg · 5s', material.material_code, material.temperature_c, material.weight_g) AS condition
) mfr
JOIN mdm.uom uom ON uom.uom_code = 'G/10MIN'
CROSS JOIN resin_context context
WHERE target.inspection_plan_version_id IS NOT NULL;

\echo 'OMF MES IQC resin seed: 검사 대상'
-- API 로 품목 기준을 만들 때와 같다(inspection-plan.service.ts) — 대상으로 켜고 품목 저장 토큰을 올린다.
UPDATE mdm.item item
   SET inspection_required = true,
       version_no = item.version_no + 1,
       updated_by = context.admin_user_id
  FROM resin_target target
  CROSS JOIN resin_context context
 WHERE item.item_id = target.item_id
   AND target.action IN ('CREATE', 'REUSE')
   AND NOT item.inspection_required;

\echo 'OMF MES IQC resin seed: 결과'
SELECT target.action, target.material_code, count(*) AS items
FROM resin_target target
GROUP BY target.action, target.material_code
ORDER BY target.action, target.material_code;

-- KEEP — 사람이 손볼 품목. 활성 IQC 기준을 화면에서 확인한다.
SELECT target.item_code, target.item_name, target.material_code, target.active_plan_count
FROM resin_target target
WHERE target.action = 'KEEP'
ORDER BY target.item_code;

-- 입하가 고를 기준 — 품목마다 오늘 유효한 확정 버전이 정확히 하나여야 한다(0 이 아닌 행이 있으면 안 된다).
SELECT target.item_code, count(version.inspection_plan_version_id) AS valid_versions
FROM resin_target target
LEFT JOIN quality.inspection_plan plan
  ON plan.item_id = target.item_id AND plan.inspection_type_code = 'IQC' AND plan.is_active
LEFT JOIN quality.inspection_plan_version version
  ON version.inspection_plan_id = plan.inspection_plan_id AND version.status_code = 'CONFIRMED'
 AND version.effective_from <= current_date
 AND (version.effective_to IS NULL OR version.effective_to >= current_date)
WHERE target.action <> 'KEEP'
GROUP BY target.item_code
HAVING count(version.inspection_plan_version_id) <> 1
ORDER BY target.item_code;

\if :apply
COMMIT;
\echo 'OMF MES IQC resin seed committed'
\else
ROLLBACK;
\echo 'OMF MES IQC resin seed dry-run rolled back'
\endif
