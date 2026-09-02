-- 부서 행의 출처를 세운다 — ERP 수신본인가, MES 자체 등록인가.
--
-- 계약 `Department.sourceSystemCode` 가 `x-source-column: source_system_code` 로
-- 선언했는데 물리 컬럼이 없다(실측 2026-09-03). 근거는 WF06 S7 Result
-- 「'Legacy 출처' 플래그 + MES 원천 등록분과 연계분의 구분 플래그」를 되살린 것이다
-- (2026-08-30 · W-06-09 §4-D · W-06-05 §9-1 · W-06-06 §5-4).
--
-- ⛔ 이 컬럼은 표시용이 아니라 «편집 잠금의 근거»다. 계약이 `Editability.reason` 에
-- `RECEIVED_FROM_ERP` 를 두고 「수신본이라 항상 읽기 전용」으로 정의했다. 이 컬럼이
-- 없으면 서버가 그 판정을 내릴 재료가 없어 ERP 수신본을 화면이 고칠 수 있게 된다.
--
-- 기본값 'MES' — 기존 행은 ERP 연계가 서기 전에 MES 에서 만들어진 것이고, 등록
-- 경로(POST /mdm/departments)도 자체 등록이라 같은 값이다. ERP 연계가 서면 그쪽이
-- 'ERP' 로 넣는다. 반대로 'ERP' 를 기본값으로 두면 기존 행이 전부 잠겨, 근거 없이
-- 편집을 막는다.
--
-- CHECK 로 두 값을 가둔다 — 계약이 enum ['ERP','MES'] 로 못박았고, 이 값으로 잠금이
-- 갈리므로 오타 하나가 조용히 편집을 열어준다.

ALTER TABLE mdm.department
    ADD COLUMN source_system_code app.code_t NOT NULL DEFAULT 'MES',
    ADD CONSTRAINT ck_department_source_system
        CHECK (source_system_code IN ('ERP', 'MES'));

COMMENT ON COLUMN mdm.department.source_system_code IS
  'ERP = Legacy 수신본(읽기 전용) · MES = 자체 등록. 편집 잠금의 근거다 (W-06-06 §5-4).';
