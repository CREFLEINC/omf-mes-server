-- 다국어 명칭(한/베)을 마스터 9종에 세운다.
--
-- 계약이 nameKo·nameVi 를 22개 스키마에 선언했는데(9표) 물리 컬럼이 하나도 없다(실측
-- 2026-09-02). 공유계약 §I-1 이 「✅ 되살렸다(2026-08-30) — nameKo·nameVi 를 9개
-- 마스터에」로 적었으나 계약만 갔고 모델이 안 따라왔다.
--
-- 근거는 지배 제약 C5 다 — 「다국어 전범위(UI·마스터·라벨 출력물, 한/베)」
-- (✅REQ-PR-0012 · ✓확정 QA #33). QA #34 가 「다국어 명칭 = MES 확장 속성」으로
-- 못박았으므로 ERP 수신 원본 명칭 칸을 덮지 않고 «옆에» 둔다.
--
-- nullable 로 둔다. 기존 행에 값이 없고, 계약도 ["string","null"] 로 선언했다 —
-- 번역이 아직 없는 마스터가 정상이다.
-- 타입은 그 표의 기존 명칭 칸과 같은 app.name_t 를 쓴다(계약 maxLength 200 과 맞는다).

ALTER TABLE mdm.code_value            ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE mdm.department            ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE mdm.item                  ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE mdm.worker                ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE planning.routing_operation ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE quality.cause_code        ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE quality.defect_code       ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE quality.inspection_item_spec ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;
ALTER TABLE quality.inspection_plan   ADD COLUMN name_ko app.name_t, ADD COLUMN name_vi app.name_t;

COMMENT ON COLUMN mdm.code_value.name_ko IS
  '한국어 명칭. 다국어는 MES 확장 속성이라 ERP 수신 원본 명칭을 덮지 않는다 (QA #34).';
COMMENT ON COLUMN mdm.code_value.name_vi IS
  '베트남어 명칭. 현장이 하노이라 라벨·출력물이 이 값을 쓴다 (C5 · QA #33).';
