-- 수입검사(IQC) 공정 1행 — omf-all-around#106 · 2026-10-16 결정 ④.
-- IQC 불합격 불량 기록의 발생·검출 공정으로 쓴다(defect_record 두 칸 NOT NULL · 스키마 변경 없음).
-- ⛔ 자동으로 돌지 않는다. 운영·테스트 DB 반영 전에 사람이 확인하고 실행한다.
--
-- 1) 확인(영향 0 또는 1행):
--    SELECT process_id, process_code, process_name, process_type_code, is_active
--      FROM mdm.process WHERE process_code = 'IQC';
-- 2) 반영(이미 있으면 아무것도 바꾸지 않는다 — 재실행 안전):
INSERT INTO mdm.process (process_code, process_name, process_type_code)
VALUES ('IQC', '수입검사', 'INSPECTION')
ON CONFLICT (process_code) DO NOTHING;
-- 3) 되돌리기(불량 기록이 이 공정을 가리키기 «전»에만 — 가리키면 FK 로 막힌다):
--    DELETE FROM mdm.process WHERE process_code = 'IQC'
--      AND NOT EXISTS (SELECT 1 FROM quality.defect_record r
--                       WHERE r.occurrence_process_id = mdm.process.process_id
--                          OR r.detection_process_id = mdm.process.process_id);
