-- 피처 005 FR-023a(사용자 결정 2026-11-12) — 재검 사유 기본값. 불합격·보류를 덮는 IQC 결과는 재검 사유가 필수인데
-- 그룹 `REINSPECTION_REASON` 에 값이 0건이면 아무도 그 결과를 저장할 수 없다(400 REINSPECTION_REASON_REQUIRED).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 값이 있다.
-- 그룹은 열린 그룹 그대로(is_system_owned = false) — 고객사가 값을 더한다. 이미 같은 코드가 있으면 건너뛴다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('REINSPECTION_REASON', '재검사 사유', false)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order, name_ko, name_vi)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order, v.code_name, v.name_vi
  FROM mdm.code_group cg
  JOIN (VALUES
    ('REMEASURE', '재측정', 10, 'Đo lại'),
    ('REWORK_REINSPECT', '재작업 후 재검', 20, 'Kiểm lại sau gia công lại')
  ) AS v(code, code_name, display_order, name_vi) ON cg.group_code = 'REINSPECTION_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
