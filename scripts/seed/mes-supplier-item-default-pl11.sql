-- 공급사·품목 기본 정보(mdm.supplier_item_default · W-06-25) — PL11 · WH32 부자재 196품목.
-- 원천: 「품목별 소포장 수량_261120.xlsx」(2026-11-20). 자재 관리 LOT = 박스(EA/BOX), 패키징 = 소포장(BAG 「봉지」).
-- 같은 공장·공급사·품목이 있으면 엑셀 값으로 덮는다 — 엑셀에 비고가 없으면 있던 비고는 둔다.
-- MES 에 없는 품목·공급사는 건너뛰고 목록을 찍는다(ERP 에서 들어온 뒤 다시 돌리면 들어간다).
-- 품목 LOT 기본값(mdm.item · W-06-05)도 같은 값으로 채운다 — P/O 몫 자동 생성(피처 014)이 읽는 자리. 비어 있는 칸만.
-- 실행: psql -v apply=true -f <이 파일>. apply 를 주지 않으면 검증·건수만 보고 롤백한다(배포 서버는
--       SQL_FILE=<이 파일> seed/load-mes-initial-data.sh [--dry-run]). 다시 돌려도 안전하다.
\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif
BEGIN;

INSERT INTO mdm.uom (uom_code, uom_name, decimal_scale) VALUES ('BAG', '봉지', 0)
ON CONFLICT (uom_code) DO NOTHING;

CREATE TEMP TABLE src (excel_row int, item_code text, supplier_code text, lot_qty numeric, package_count int, qty_per_package numeric, remarks text) ON COMMIT DROP;
INSERT INTO src VALUES
  (3, 'AD0302-00001', '100288', 20000, 10, 2000, NULL),
  (4, 'AD0302-00002', '100288', 50000, 10, 5000, NULL),
  (5, 'AD0303-00005', '100132', 50000, 10, 5000, NULL),
  (6, 'AD0303-00006', '100132', 50000, 10, 5000, NULL),
  (7, 'AD0303-00007', '100132', 50000, 10, 5000, NULL),
  (8, 'AD0303-00009', '100132', 50000, 10, 5000, NULL),
  (9, 'AD0303-00011', '100132', 50000, 10, 5000, NULL),
  (10, 'AD0303-00012', '100132', 50000, 10, 5000, NULL),
  (11, 'AD0303-00014', '100132', 50000, 10, 5000, NULL),
  (12, 'AD0303-00016', '100132', 50000, 10, 5000, NULL),
  (13, 'AD0303-00017', '100129', 60000, 20, 3000, NULL),
  (14, 'AD0303-00021', '100132', 50000, 10, 5000, NULL),
  (15, 'AD0303-00022', '100132', 50000, 10, 5000, NULL),
  (16, 'AD0303-00025', '100288', 50000, 25, 2000, NULL),
  (17, 'AD0303-00027', '100288', 50000, 25, 2000, NULL),
  (18, 'AD0303-00030', '100288', 50000, 25, 2000, NULL),
  (19, 'AD0303-00032', '100288', 50000, 25, 2000, NULL),
  (20, 'AD0303-00033', '100288', 30000, 20, 1500, NULL),
  (21, 'AD0303-00034', '100288', 50000, 10, 5000, NULL),
  (22, 'AD0303-00035', '100288', 50000, 25, 2000, NULL),
  (23, 'AD0303-00036', '100288', 50000, 10, 5000, NULL),
  (24, 'AD0303-00037', '100132', 50000, 10, 5000, NULL),
  (25, 'AD0303-00038', '100132', 50000, 10, 5000, NULL),
  (26, 'AD0303-00039', '100288', 50000, 10, 5000, NULL),
  (27, 'AD0303-00040', '100288', 10000, 10, 1000, NULL),
  (28, 'AD0303-00041', '100288', 4000, 8, 500, NULL),
  (29, 'AD0303-00042', '100288', 50000, 10, 5000, NULL),
  (30, 'AD0303-00043', '100288', 15000, 10, 1500, NULL),
  (31, 'AD0303-00044', '100132', 20000, 10, 2000, NULL),
  (32, 'AD0303-00045', '100132', 20000, 10, 2000, NULL),
  (33, 'AD0303-00046', '100132', 20000, 10, 2000, NULL),
  (34, 'AD0303-00047', '100132', 20000, 10, 2000, NULL),
  (35, 'AD0303-00048', '100132', 20000, 10, 2000, NULL),
  (36, 'AD0303-00049', '100132', 20000, 10, 2000, NULL),
  (37, 'AD0303-00050', '100132', 20000, 10, 2000, NULL),
  (38, 'AD0303-00051', '100132', 20000, 10, 2000, NULL),
  (39, 'AD0303-00052', '100288', 50000, 10, 5000, NULL),
  (40, 'AD0303-00053', '100288', 15000, 15, 1000, NULL),
  (41, 'AD0303-00054', '100288', 50000, 10, 5000, NULL),
  (42, 'AD0303-00056', '100132', 20000, 10, 2000, NULL),
  (43, 'AD0303-00057', '100132', 20000, 10, 2000, NULL),
  (44, 'AD0303-00058', '100132', 20000, 10, 2000, NULL),
  (45, 'AD0303-00059', '100132', 20000, 10, 2000, NULL),
  (46, 'AD0303-00060', '100288', 30000, 15, 2000, NULL),
  (47, 'AD0303-00061', '100288', 50000, 10, 5000, NULL),
  (48, 'AD0303-00062', '100288', 15000, 10, 1500, NULL),
  (49, 'AD0303-00063', '100288', 30000, 15, 2000, NULL),
  (50, 'AD0303-00064', '100132', 10000, 10, 1000, NULL),
  (51, 'AD0303-00065', '100132', 10000, 10, 1000, NULL),
  (52, 'AD0303-00066', '200057', 200, 2, 100, NULL),
  (53, 'AD0303-00067', '200057', 200, 2, 100, NULL),
  (54, 'AD0303-00068', '200057', 200, 2, 100, NULL),
  (55, 'AD0404-00001', '100189', 30000, 15, 2000, NULL),
  (56, 'AD0404-00002', '100189', 40000, 20, 2000, NULL),
  (57, 'AD0404-00003', '100189', 40000, 10, 4000, NULL),
  (58, 'AD0404-00006', '100189', 30000, 15, 2000, NULL),
  (59, 'AD0404-00008', '100189', 20000, 40, 500, NULL),
  (60, 'AD0404-00009', '100189', 54000, 10, 5400, NULL),
  (61, 'AD0404-00010', '100189', 45000, 15, 3000, NULL),
  (62, 'AD0404-00011', '100189', 50400, 10, 5040, NULL),
  (63, 'AD0404-00012', '100189', 10000, 20, 500, NULL),
  (64, 'AD0404-00013', '100189', 30000, 10, 3000, NULL),
  (65, 'AD0404-00014', '100189', 20000, 20, 1000, NULL),
  (66, 'AD0404-00015', '100222', 6000, 6, 1000, NULL),
  (67, 'AD0404-00016', '100189', 20000, 20, 1000, NULL),
  (68, 'AD0404-00021', '100279', 25000, 5, 5000, '~5000EA/ROLL'),
  (69, 'AD0404-00022', '100279', 25000, 5, 5000, '~5000EA/ROLL'),
  (70, 'AD0404-00023', '100279', 51850, 5, 10370, '10370EA/ROLL'),
  (71, 'AD0506-00001', '100189', 20000, 1, 20000, NULL),
  (72, 'AD0509-00002', '100132', 10000, 5, 2000, NULL),
  (73, 'AD0509-00003', '200045', 5000, 5, 1000, NULL),
  (74, 'AD0509-00005', '100288', 10000, 10, 1000, NULL),
  (75, 'AD0509-00006', '100222', 5000, 10, 500, NULL),
  (76, 'AD0509-00007', '100288', 10000, 10, 1000, NULL),
  (77, 'AD0509-00009', '200045', 2000, 4, 500, NULL),
  (78, 'AD0509-00011', '200045', 2000, 4, 500, NULL),
  (79, 'AD0509-00012', '200045', 5000, 5, 1000, NULL),
  (80, 'AD0509-00013', '200045', 2000, 4, 500, NULL),
  (81, 'AD0509-00014', '200045', 2000, 4, 500, NULL),
  (82, 'AD0509-00015', '200045', 2000, 4, 500, NULL),
  (83, 'AD0509-00016', '200045', 1200, 4, 300, NULL),
  (84, 'AD0509-00017', '200045', 2000, 4, 500, NULL),
  (85, 'AD0509-00018', '100222', 10000, 10, 1000, NULL),
  (86, 'AD0509-00020', '200045', 3000, 6, 500, NULL),
  (87, 'AD0509-00021', '200045', 3000, 6, 500, NULL),
  (88, 'AD0509-00022', '100222', 5000, 10, 500, NULL),
  (89, 'AD0509-00023', '100222', 5000, 10, 500, NULL),
  (90, 'AD0509-00024', '100222', 5000, 10, 500, NULL),
  (91, 'AD0509-00025', '100222', 5000, 10, 500, NULL),
  (92, 'AD0509-00027', '200045', 5000, 5, 1000, NULL),
  (93, 'AD0509-00032', '200045', 2000, 4, 500, NULL),
  (94, 'AD0509-00034', '200045', 2000, 4, 500, NULL),
  (95, 'AD0509-00036', '200045', 3000, 6, 500, NULL),
  (96, 'AD0509-00037', '100222', 6000, 6, 1000, NULL),
  (97, 'AD0509-00040', '100222', 5000, 10, 500, NULL),
  (98, 'AD0509-00041', '200045', 1200, 4, 300, NULL),
  (99, 'AD0509-00042', '200045', 2000, 4, 500, NULL),
  (100, 'AD0509-00044', '200045', 2000, 4, 500, NULL),
  (101, 'AD0509-00045', '100222', 5000, 10, 500, NULL),
  (102, 'AD0509-00046', '200045', 2000, 4, 500, NULL),
  (103, 'AD0509-00047', '100222', 2000, 10, 200, NULL),
  (104, 'AD0509-00048', '100222', 30000, 6, 5000, NULL),
  (105, 'AD0509-00049', '100132', 10000, 5, 2000, NULL),
  (106, 'AD0509-00050', '200045', 3000, 6, 500, NULL),
  (107, 'AD0509-00051', '200045', 5000, 5, 1000, NULL),
  (108, 'AD0509-00052', '100288', 10000, 10, 1000, NULL),
  (109, 'AD0509-00053', '100222', 5000, 10, 500, NULL),
  (110, 'AD0509-00054', '100222', 10000, 10, 1000, NULL),
  (111, 'AD0509-00055', '100222', 5000, 10, 500, NULL),
  (112, 'AD0509-00056', '200045', 2000, 4, 500, NULL),
  (113, 'AD0509-00057', '200045', 2000, 4, 500, NULL),
  (114, 'AD0509-00058', '200045', 2000, 4, 500, NULL),
  (115, 'AD0509-00064', '100132', 10000, 5, 2000, NULL),
  (116, 'AD0606-00003', '100189', 50000, 10, 5000, '5000EA/ROLL'),
  (117, 'AD0606-00004', '100189', 50000, 10, 5000, '5000EA/ROLL'),
  (118, 'CA0404-00004', '100665', 20000, 4, 5000, NULL),
  (119, 'CA0404-00005', '100665', 20000, 4, 5000, NULL),
  (120, 'CA0404-00006', '100665', 20000, 4, 5000, NULL),
  (121, 'CA0404-00010', '100707', 20000, 4, 5000, NULL),
  (122, 'CA0404-00011', '100707', 20000, 4, 5000, NULL),
  (123, 'CA0404-00012', '100707', 20000, 4, 5000, NULL),
  (124, 'CA0404-00013', '100707', 20000, 4, 5000, NULL),
  (125, 'CA0404-00014', '100707', 20000, 4, 5000, NULL),
  (126, 'CA0404-00015', '100707', 20000, 4, 5000, NULL),
  (127, 'CA0404-00016', '100707', 20000, 4, 5000, NULL),
  (128, 'CA0404-00017', '100707', 20000, 4, 5000, NULL),
  (129, 'CA0404-00018', '100707', 20000, 4, 5000, NULL),
  (130, 'CA0404-00019', '100707', 15000, 3, 5000, NULL),
  (131, 'CA0404-00020', '100707', 15000, 3, 5000, NULL),
  (132, 'CA0404-00021', '100707', 15000, 3, 5000, NULL),
  (133, 'CA0404-00022', '100707', 15000, 3, 5000, NULL),
  (134, 'CA0404-00023', '100707', 15000, 3, 5000, NULL),
  (135, 'CA0404-00024', '100707', 15000, 3, 5000, NULL),
  (136, 'CA0507-00004', '100813', 20000, 4, 5000, NULL),
  (137, 'CA0507-00005', '100813', 20000, 4, 5000, NULL),
  (138, 'CA0507-00006', '100813', 20000, 4, 5000, NULL),
  (139, 'CA0507-00007', '100813', 20000, 4, 5000, NULL),
  (140, 'CA0507-00008', '100813', 20000, 4, 5000, NULL),
  (141, 'CA0507-00009', '100813', 20000, 4, 5000, NULL),
  (142, 'CA0507-00010', '100813', 18000, 9, 2000, NULL),
  (143, 'CA0518-00004', '100665', 20000, 4, 5000, NULL),
  (144, 'CA0518-00005', '100665', 20000, 4, 5000, NULL),
  (145, 'CA0518-00006', '100665', 20000, 4, 5000, NULL),
  (146, 'CA0518-00010', '100707', 20000, 4, 5000, NULL),
  (147, 'CA0518-00011', '100707', 20000, 4, 5000, NULL),
  (148, 'CA0518-00012', '100707', 20000, 4, 5000, NULL),
  (149, 'CA0518-00013', '100707', 20000, 4, 5000, NULL),
  (150, 'CA0518-00014', '100707', 20000, 4, 5000, NULL),
  (151, 'CA0518-00015', '100707', 20000, 4, 5000, NULL),
  (152, 'CA0518-00017', '100707', 20000, 4, 5000, NULL),
  (153, 'CA0518-00018', '100707', 20000, 4, 5000, NULL),
  (154, 'CA0518-00019', '100707', 20000, 4, 5000, NULL),
  (155, 'CA0518-00020', '100707', 15000, 3, 5000, NULL),
  (156, 'CA0518-00021', '100707', 15000, 3, 5000, NULL),
  (157, 'CA0518-00022', '100707', 15000, 3, 5000, NULL),
  (158, 'CA0518-00023', '100707', 15000, 3, 5000, NULL),
  (159, 'CA0518-00024', '100707', 15000, 3, 5000, NULL),
  (160, 'CA0518-00025', '100707', 15000, 3, 5000, NULL),
  (161, 'CA0518-00026', '100707', 15000, 3, 5000, NULL),
  (162, 'CA0518-00027', '100707', 15000, 3, 5000, NULL),
  (163, 'CA0518-00028', '100707', 15000, 3, 5000, NULL),
  (164, 'CA0601-00001', '100707', 15000, 3, 5000, NULL),
  (165, 'CA0601-00002', '100707', 15000, 3, 5000, NULL),
  (166, 'CA0601-00003', '100707', 15000, 3, 5000, NULL),
  (167, 'EL0304-00001', '100189', 28800, 24, 1200, NULL),
  (168, 'EL0511-00001', '100824', 10000, 10, 1000, NULL),
  (169, 'EL0511-00002', '100824', 10000, 5, 2000, NULL),
  (170, 'EL0511-00003', '100824', 5000, 5, 1000, NULL),
  (171, 'EL0528-00002', '100132', 10000, 10, 1000, NULL),
  (172, 'EL0528-00004', '100132', 10000, 10, 1000, NULL),
  (173, 'EL0539-00001', '100189', 20000, 40, 500, NULL),
  (174, 'ES0602-00062', '100330', 5000, 25, 200, NULL),
  (175, 'ES0602-00064', '100330', 5000, 25, 200, NULL),
  (176, 'ES0602-00079', '100330', 10000, 10, 1000, NULL),
  (177, 'PR0303-00001', '100129', 60000, 6, 10000, NULL),
  (178, 'PR0303-00002', '100129', 60000, 3, 20000, NULL),
  (179, 'PR0803-00001', '100129', 3000, 3, 1000, NULL),
  (180, 'UP0517-00001', '100282', 100, 2, 50, NULL),
  (181, 'AD0509-00039', '200045', 1200, 4, 300, NULL),
  (182, 'EL0301-00001', '200013', 100, 1, 100, NULL),
  (183, 'AD0509-00060', '200045', 5000, 5, 1000, NULL),
  (184, 'AD0509-00061', '200045', 5000, 5, 1000, NULL),
  (185, 'AD0509-00062', '200045', 5000, 5, 1000, NULL),
  (186, 'AD0509-00063', '200045', 5000, 5, 1000, NULL),
  (187, 'AD0518-00001', '100189', 20000, 1, 20000, NULL),
  (188, 'CA0518-00035', '100890', 20000, 4, 5000, NULL),
  (189, 'CA0518-00036', '100890', 20000, 4, 5000, NULL),
  (190, 'CA0518-00037', '100951', 20000, 4, 5000, NULL),
  (191, 'CA0518-00038', '100890', 20000, 4, 5000, NULL),
  (192, 'CA0518-00039', '100890', 20000, 4, 5000, NULL),
  (193, 'CA0518-00040', '100890', 20000, 4, 5000, NULL),
  (194, '030312-00001', '100222', 24072, 24, 1003, NULL),
  (195, '051109-00001', '200045', 10000, 10, 1000, NULL),
  (196, '051109-00002', '200045', 10000, 10, 1000, NULL),
  (197, '051109-00003', '200045', 10000, 10, 1000, NULL),
  (198, '051407-00001', '100805', 20000, 10, 2000, NULL);

DO $$
DECLARE wh int;
BEGIN
  SELECT count(*) INTO wh FROM mdm.warehouse w JOIN mdm.plant p USING (plant_id) WHERE p.plant_code = 'PL11' AND w.warehouse_code = 'WH32';
  IF wh <> 1 THEN RAISE EXCEPTION 'PL11 공장에 WH32 창고가 없습니다'; END IF;
END $$;

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT s.*, i.item_id, i.is_active AS item_active, pt.partner_id AS supplier_id, pt.is_active AS supplier_active,
       (SELECT plant_id FROM mdm.plant WHERE plant_code = 'PL11') AS plant_id,
       (SELECT uom_id FROM mdm.uom WHERE uom_code = 'BAG') AS package_uom_id
  FROM src s
  LEFT JOIN mdm.item i ON i.item_code = s.item_code
  LEFT JOIN mdm.partner pt ON pt.partner_code = s.supplier_code;

\echo '--- 건너뜀(MES 에 없거나 사용 중지)'
SELECT excel_row, item_code, supplier_code,
       concat_ws(', ', CASE WHEN item_id IS NULL THEN '품목 없음' WHEN NOT item_active THEN '품목 사용 중지' END,
                       CASE WHEN supplier_id IS NULL THEN '공급사 없음' WHEN NOT supplier_active THEN '공급사 사용 중지' END) AS reason
  FROM resolved
 WHERE item_id IS NULL OR supplier_id IS NULL OR NOT item_active OR NOT supplier_active
 ORDER BY excel_row;

\echo '--- 결과'
WITH ok AS (
  SELECT * FROM resolved WHERE item_id IS NOT NULL AND supplier_id IS NOT NULL AND item_active AND supplier_active
), up AS (
  INSERT INTO mdm.supplier_item_default AS d (plant_id, supplier_id, item_id, lot_qty, package_uom_id, package_count, qty_per_package, remarks)
  SELECT plant_id, supplier_id, item_id, lot_qty, package_uom_id, package_count, qty_per_package, remarks FROM ok
  ON CONFLICT (plant_id, supplier_id, item_id) DO UPDATE
     SET lot_qty = EXCLUDED.lot_qty, package_uom_id = EXCLUDED.package_uom_id, package_count = EXCLUDED.package_count,
         qty_per_package = EXCLUDED.qty_per_package, remarks = COALESCE(EXCLUDED.remarks, d.remarks),
         updated_at = clock_timestamp(), updated_by = NULL, version_no = d.version_no + 1
   WHERE (d.lot_qty, d.package_uom_id, d.package_count, d.qty_per_package, d.remarks)
         IS DISTINCT FROM (EXCLUDED.lot_qty, EXCLUDED.package_uom_id, EXCLUDED.package_count, EXCLUDED.qty_per_package, COALESCE(EXCLUDED.remarks, d.remarks))
  RETURNING (xmax = 0) AS inserted
)
SELECT (SELECT count(*) FROM src) AS excel_rows,
       (SELECT count(*) FROM ok) AS matched,
       count(*) FILTER (WHERE inserted) AS inserted,
       count(*) FILTER (WHERE NOT inserted) AS updated,
       (SELECT count(*) FROM ok) - count(*) AS unchanged
  FROM up;

\echo '--- 품목 LOT 기본값(mdm.item · W-06-05) — 원자재·부자재만, 비어 있는 칸만'
-- P/O 몫 자동 생성(피처 014)은 공급사·품목 기본 정보가 아니라 품목의 LOT 기본값만 본다 — 여기서 함께 채운다.
-- 반제품·완제품은 뺀다(LOT 기본크기가 생산 LOT 크기로도 쓰인다). 보관 단위 = 품목 기본 단위(EA).
-- ⛔ 사람이 W-06-05 에서 넣은 값은 덮지 않는다. 보관 단위가 기본 단위와 다르면 기본크기 단위가 달라 건너뛴다.
--    패키징 두 칸은 함께 비어 있고, 기본크기가 엑셀 박스 수량과 같고, 「기본크기 × 10 mod 수량 = 0」(W-06-05 저장 검사)일 때만 채운다.
-- 부수 칸은 시스템 쓰기 관례 — updated_at 은 트리거, updated_by = NULL, version_no + 1.
WITH ok AS (
  SELECT item_id, lot_qty, package_uom_id, package_count
    FROM resolved WHERE item_id IS NOT NULL AND supplier_id IS NOT NULL AND item_active AND supplier_active
), one AS (
  -- 한 품목이 공급사를 달리해 두 번 오면 값이 같을 때만 쓴다.
  SELECT item_id, min(lot_qty) AS lot_qty, min(package_uom_id) AS package_uom_id, min(package_count) AS package_count
    FROM ok GROUP BY item_id
  HAVING count(DISTINCT concat_ws('|', lot_qty, package_uom_id, package_count)) = 1
), plan AS (
  SELECT i.item_id, i.base_uom_id, o.lot_qty, o.package_uom_id, o.package_count,
         coalesce(i.default_lot_storage_uom_id, i.base_uom_id) = i.base_uom_id AS storage_ok,
         coalesce(i.default_production_lot_size, o.lot_qty) AS size,
         o.package_count IS NOT NULL AND i.default_package_uom_id IS NULL AND i.default_package_count IS NULL
           AND coalesce(i.default_production_lot_size, o.lot_qty) = o.lot_qty
           AND (o.lot_qty * 10) % o.package_count = 0 AS fill_pkg,
         i.default_lot_storage_uom_id IS NULL OR i.default_production_lot_size IS NULL AS fill_size
    FROM one o JOIN mdm.item i ON i.item_id = o.item_id
   WHERE i.item_type_code IN ('RAW_MATERIAL', 'SUBSIDIARY_MATERIAL')
), up AS (
  UPDATE mdm.item i
     SET default_lot_storage_uom_id  = p.base_uom_id,
         default_production_lot_size = p.size,
         default_package_uom_id      = CASE WHEN p.fill_pkg THEN p.package_uom_id ELSE i.default_package_uom_id END,
         default_package_count       = CASE WHEN p.fill_pkg THEN p.package_count ELSE i.default_package_count END,
         updated_by = NULL,
         version_no = i.version_no + 1
    FROM plan p
   WHERE p.item_id = i.item_id AND p.storage_ok AND (p.fill_size OR p.fill_pkg)
  RETURNING p.fill_pkg
)
SELECT (SELECT count(DISTINCT item_id) FROM ok) AS items,
       (SELECT count(DISTINCT item_id) FROM ok) - (SELECT count(*) FROM one) AS ambiguous,
       (SELECT count(*) FROM one) - (SELECT count(*) FROM plan) AS not_material,
       (SELECT count(*) FROM plan WHERE NOT storage_ok) AS storage_differs,
       count(*) AS filled,
       count(*) FILTER (WHERE fill_pkg) AS with_package,
       (SELECT count(*) FROM plan WHERE storage_ok) - count(*) AS already_set
  FROM up;

\if :apply
COMMIT;
\echo '커밋했다'
\else
ROLLBACK;
\echo '검증만 하고 롤백했다 — 반영하려면 -v apply=true'
\endif
