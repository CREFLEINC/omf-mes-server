-- 피처 005 운영 배포 전 점검 — 미실행 IQC 생략 결재(omf-all-around#254 · tasks T140 · data-model 「데이터 이전」 4 · FR-032).
-- ⚠ 읽기 전용이다(SELECT 만). 운영 DB 에서 «005 마이그레이션을 적용하기 전에» ① 을 돌리고, 결과가 0행이어야 배포한다.
--
-- 위험: 마이그레이션 `20261112170000_iqc_skip_target_inbound_lot` 은 IQC 생략 결재의 대상(`target_id`)을 자재 LOT id 에서
-- 그 LOT 의 입하 LOT id(옛 데이터는 입하 줄 하나 = 입하 LOT 하나, 선별 자식 LOT 포함)로 «전부» 옮긴다. 새 생략 실행은
-- 입하 LOT 의 열린 IQC 요청 «전부»를 SKIPPED 로 닫고 자재 관리 LOT «전부»를 정상(C22)으로 올린다. 그래서 한 입하 줄에
-- LOT·IQC 요청이 여럿인 옛 데이터(공급사 채널 발행·선별 자식)에서, LOT 하나를 보고 올린 생략 결재가 아직 실행되지
-- 않았다면(승인 전이거나 승인 뒤 미실행) 배포 뒤 실행 한 번이 결재자가 보지 않은 다른 LOT 의 검사까지 건너뛴다. ① 에
-- 나온 결재는 배포 전에 실행하거나(옛 코드 — 그 LOT 만 생략) 반려·회수해 정리한다. open_iqc_request_count 가 0 이면
-- 실행해도 409(열린 검사 없음)라 위험은 없지만 함께 정리한다.

-- ① 배포 전(옛 스키마 — target_id = 자재 LOT id). 결과 0행이어야 배포한다.
WITH RECURSIVE origin AS (
  SELECT l.lot_id, l.source_id AS inbound_receipt_line_id
    FROM trace.lot l
   WHERE l.source_type_code = 'INBOUND_RECEIPT_LINE'
  UNION ALL
  SELECT c.lot_id, o.inbound_receipt_line_id
    FROM trace.lot c
    JOIN origin o ON c.parent_lot_id = o.lot_id
   WHERE c.source_type_code = 'LOT_SPLIT'
), line_size AS (
  SELECT o.inbound_receipt_line_id,
         count(DISTINCT o.lot_id) AS lot_count,
         count(DISTINCT r.inspection_request_id) FILTER (WHERE r.status_code <> 'CANCELLED') AS iqc_request_count,
         count(DISTINCT r.inspection_request_id) FILTER (WHERE r.status_code IN ('REQUESTED', 'IN_PROGRESS')) AS open_iqc_request_count
    FROM origin o
    LEFT JOIN quality.inspection_request r ON r.lot_id = o.lot_id AND r.inspection_type_code = 'IQC'
   GROUP BY o.inbound_receipt_line_id
)
SELECT a.approval_request_id, a.approval_request_no, a.status_code,
       CASE WHEN a.status_code = 'PENDING' THEN '승인 전' ELSE '승인 후 미실행' END AS skip_state,
       a.target_id AS lot_id, l.lot_no, o.inbound_receipt_line_id,
       s.lot_count, s.iqc_request_count, s.open_iqc_request_count
  FROM app.approval_request a
  JOIN trace.lot l ON l.lot_id = a.target_id
  JOIN origin o ON o.lot_id = a.target_id
  JOIN line_size s ON s.inbound_receipt_line_id = o.inbound_receipt_line_id
 WHERE a.approval_type_code = 'IQC_SKIP'
   AND (a.status_code = 'PENDING'
        OR (a.status_code = 'APPROVED'
            AND NOT EXISTS (SELECT 1 FROM quality.inspection_request r
                             WHERE r.lot_id = a.target_id AND r.inspection_type_code = 'IQC'
                               AND r.status_code = 'SKIPPED' AND r.skip_basis_code = 'APPROVAL')))
   AND (s.lot_count > 1 OR s.iqc_request_count > 1)
 ORDER BY a.approval_request_id;

-- ② 배포 뒤 확인(새 스키마 — target_id = 입하 LOT id, 옮기기 전 LOT id 는 target_summary.migratedFromLotId).
--    ① 을 놓쳤을 때 남은 것을 찾는다. 0행이 정상이다.
WITH size AS (
  SELECT il.inbound_lot_id, il.inbound_lot_no,
         (SELECT count(*) FROM trace.lot l WHERE l.inbound_lot_id = il.inbound_lot_id) AS lot_count,
         (SELECT count(*) FROM quality.inspection_request r
           WHERE r.inspection_type_code = 'IQC' AND r.status_code <> 'CANCELLED'
             AND (r.inbound_lot_id = il.inbound_lot_id
                  OR r.lot_id IN (SELECT l.lot_id FROM trace.lot l WHERE l.inbound_lot_id = il.inbound_lot_id))) AS iqc_request_count,
         (SELECT count(*) FROM quality.inspection_request r
           WHERE r.inspection_type_code = 'IQC' AND r.status_code IN ('REQUESTED', 'IN_PROGRESS')
             AND (r.inbound_lot_id = il.inbound_lot_id
                  OR r.lot_id IN (SELECT l.lot_id FROM trace.lot l WHERE l.inbound_lot_id = il.inbound_lot_id))) AS open_iqc_request_count
    FROM trace.inbound_lot il
   WHERE il.erp_send_mode_code = 'PER_RECEIPT'
)
SELECT a.approval_request_id, a.approval_request_no, a.status_code,
       (a.target_summary ->> 'migratedFromLotId') AS migrated_from_lot_id,
       s.inbound_lot_no, s.lot_count, s.iqc_request_count, s.open_iqc_request_count
  FROM app.approval_request a
  JOIN size s ON s.inbound_lot_id = a.target_id
 WHERE a.approval_type_code = 'IQC_SKIP' AND a.target_type_code = 'INBOUND_LOT'
   AND (a.target_summary ->> 'migratedFromLotId') IS NOT NULL
   AND (a.target_summary ->> 'voidedAt') IS NULL
   AND (a.status_code = 'PENDING' OR (a.status_code = 'APPROVED' AND s.open_iqc_request_count > 0))
   AND (s.lot_count > 1 OR s.iqc_request_count > 1)
 ORDER BY a.approval_request_id;
