-- 검사 유형 공통 「기본 생략」(omf-all-around#212 · 장부 P-152). PQC 전용 「생략 허용」(pqc_skip_allowed · #119)을 IQC·OQC 로 넓힌다.
-- ⚠ pqc_skip_allowed 는 이번 릴리스에서 지우지 않는다 — 블루-그린 전환 중 옛 코드가 읽고, 서버가 같은 값을 함께 쓴다. 삭제는 다음 릴리스.
ALTER TABLE quality.inspection_plan ADD COLUMN default_skip boolean NOT NULL DEFAULT false;
UPDATE quality.inspection_plan SET default_skip = true WHERE pqc_skip_allowed;

-- 생략(SKIPPED) 의뢰가 무엇으로 생략됐는지 — 기준의 기본 생략(DEFAULT)인지, 건별 결재 승인(APPROVAL)인지. 화면이 둘을 갈라 보인다.
ALTER TABLE quality.inspection_request
    ADD COLUMN skip_basis_code varchar(50),
    ADD CONSTRAINT ck_inspection_request_skip_basis
        CHECK (skip_basis_code IS NULL OR skip_basis_code IN ('DEFAULT', 'APPROVAL'));
-- 기존 생략 의뢰: PQC 는 생략 허용 기준으로 배포가 만든 것뿐이고(#119), IQC·OQC 는 결재 승인 실행으로만 생략됐다(#105 · #119).
UPDATE quality.inspection_request
   SET skip_basis_code = CASE inspection_type_code WHEN 'PQC' THEN 'DEFAULT' ELSE 'APPROVAL' END
 WHERE status_code = 'SKIPPED';

-- 승인된 PQC 건별 생략 실행이 검사 대기 생산LOT 을 정상으로 올리는 전이 코드. 기본 생략(C26)과 이력으로 가른다(IQC C22 · OQC C27 의 자리).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1). seed.ts 에도 같은 줄이 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'C28', 'PQC 생략(결재) → 정상', 210
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;
