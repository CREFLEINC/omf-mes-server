-- 검사 기준 버전별 안내 문구(omf-all-around#252). 검사 화면이 기준 정보 바로 아래에 보인다.
-- 칸을 더하는 것뿐이다 — NULL 허용이라 기존 버전은 「문구 없음」으로 옛 동작 그대로다.
ALTER TABLE quality.inspection_plan_version
    ADD COLUMN guide_text_ko varchar(1000),
    ADD COLUMN guide_text_vi varchar(1000);

COMMENT ON COLUMN quality.inspection_plan_version.guide_text_ko IS '검사 안내 문구(한국어). 작성중 버전에서만 고치고, 개정하면 새 버전에 복사된다.';
COMMENT ON COLUMN quality.inspection_plan_version.guide_text_vi IS '검사 안내 문구(베트남어). 작성중 버전에서만 고치고, 개정하면 새 버전에 복사된다.';
