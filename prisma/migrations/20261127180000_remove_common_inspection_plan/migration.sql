-- omf-all-around#366 — 「전 품목 공통」 검사 기준(품목 칸이 빈 inspection_plan)을 없앤다.
-- 서버는 이제 품목 전용 기준만 고르고, 기준이 없는 품목의 IQC·OQC 는 생략(SKIPPED · DEFAULT)으로 남긴다.
--
-- ⭐ 검사 기록이 가리키는 공통 기준은 지우지 않고 사용 중지만 한다 — 지우면 지난 검사 의뢰·측정값까지 지워야 한다.
--    검사 의뢰(inspection_request) · 측정값(inspection_measurement) · 설비 수집 채널(collection_channel)이 가리키지 않는
--    공통 기준은 버전·항목·도면 첨부와 함께 지운다.

CREATE TEMP TABLE common_plan_removed AS
SELECT p.inspection_plan_id
  FROM quality.inspection_plan p
 WHERE p.item_id IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM quality.inspection_plan_version v
          WHERE v.inspection_plan_id = p.inspection_plan_id
            AND (EXISTS (SELECT 1 FROM quality.inspection_request r WHERE r.inspection_plan_version_id = v.inspection_plan_version_id)
                 OR EXISTS (SELECT 1
                              FROM quality.inspection_item_spec s
                             WHERE s.inspection_plan_version_id = v.inspection_plan_version_id
                               AND (EXISTS (SELECT 1 FROM quality.inspection_measurement m WHERE m.inspection_item_spec_id = s.inspection_item_spec_id)
                                    OR EXISTS (SELECT 1 FROM maintenance.collection_channel c WHERE c.inspection_item_id = s.inspection_item_spec_id)))));

DELETE FROM app.attachment a
 USING quality.inspection_plan_version v
 WHERE a.target_type_code = 'INSPECTION_PLAN_VERSION'
   AND a.target_id = v.inspection_plan_version_id
   AND v.inspection_plan_id IN (SELECT inspection_plan_id FROM common_plan_removed);

DELETE FROM quality.inspection_item_spec s
 USING quality.inspection_plan_version v
 WHERE s.inspection_plan_version_id = v.inspection_plan_version_id
   AND v.inspection_plan_id IN (SELECT inspection_plan_id FROM common_plan_removed);

DELETE FROM quality.inspection_plan_version
 WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM common_plan_removed);

DELETE FROM quality.inspection_plan
 WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM common_plan_removed);

-- 남은 공통 기준(검사 기록이 있는 것)은 사용 중지 — 서버가 더는 고르지 않고 목록에도 나오지 않는다.
UPDATE quality.inspection_plan
   SET is_active = false, version_no = version_no + 1
 WHERE item_id IS NULL AND is_active;

DROP TABLE common_plan_removed;
