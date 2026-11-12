-- 검사표 기준의 관리용 기준코드 · 기준명(omf-all-around#260). 「검사 기준 등록」 팝업에서 PQC 로 등록할 때 받는다.
-- 칸을 더하는 것뿐이다 — NULL 허용이라 기존 기준은 비어 있고 옛 동작 그대로다. 같은 품목의 버전끼리는 같은 코드를 쓰므로
-- 유일 제약은 걸지 않는다(다른 품목과 겹치는지는 서버가 본다).
ALTER TABLE quality.inspection_sheet_template
    ADD COLUMN template_code varchar(50),
    ADD COLUMN template_name varchar(200);

COMMENT ON COLUMN quality.inspection_sheet_template.template_code IS '관리용 기준코드. 같은 품목의 버전끼리 같고, 다른 품목의 검사표와는 겹치지 않는다.';
COMMENT ON COLUMN quality.inspection_sheet_template.template_name IS '관리용 기준명.';
