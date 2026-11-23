-- 폐기·선별 처분 결재(omf-all-around#352) — 처분 대기에서 폐기(SCRAP)·선별(SORT)을 결재(유형 DISPOSITION · 대상 NONCONFORMANCE)에 올린다.
-- 결재가 승인되면 `:apply` 가 저장한 본문으로 처분 판정을 그대로 만든다. 결재선이 없으면 이 표를 거치지 않고 바로 판정한다.
-- ⭐ 결재 유형 값은 DB 에 열거가 없다(app.approval_request·approval_route 에 CHECK 없음 · APPROVAL_TYPE 코드 그룹은 은퇴) — 계약 enum 만 늘린다.
-- 새 표만 만든다 — 기존 행·흐름은 바뀌지 않는다.
CREATE TABLE quality.disposition_approval (
    disposition_approval_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nonconformance_id        bigint NOT NULL REFERENCES quality.nonconformance(nonconformance_id),
    disposition_type_code    varchar(50) NOT NULL CHECK (disposition_type_code IN ('SCRAP', 'SORT')),
    decision_qty             numeric(20, 6) CHECK (decision_qty > 0),
    uom_id                   bigint REFERENCES mdm.uom(uom_id),
    lot_ids                  bigint[],
    good_qty                 numeric(20, 6) CHECK (good_qty >= 0),
    defect_qty               numeric(20, 6) CHECK (defect_qty >= 0),
    reason                   text NOT NULL,
    approval_request_id      bigint NOT NULL,
    status_code              varchar(20) NOT NULL CHECK (status_code IN ('PENDING', 'APPLIED', 'REJECTED')),
    disposition_decision_id  bigint,
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by               bigint NOT NULL,
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by               bigint NOT NULL,
    -- ⚠ FK 이름을 직접 준다 — `fk_disposition_approval` 은 disposition_decision.approval_request_id 가 이미 쓴다.
    CONSTRAINT fk_disposition_approval_request FOREIGN KEY (approval_request_id) REFERENCES app.approval_request(approval_request_id),
    CONSTRAINT fk_disposition_approval_decision FOREIGN KEY (disposition_decision_id) REFERENCES quality.disposition_decision(disposition_decision_id),
    CONSTRAINT fk_disposition_approval_created_by FOREIGN KEY (created_by) REFERENCES app.app_user(app_user_id),
    CONSTRAINT fk_disposition_approval_updated_by FOREIGN KEY (updated_by) REFERENCES app.app_user(app_user_id),
    -- 폐기는 수량·단위, 선별은 자재 관리 LOT 을 담는다(본문 모양 그대로 — `:apply` 가 이 값으로 판정한다).
    CONSTRAINT ck_disposition_approval_shape CHECK (
        (disposition_type_code = 'SCRAP' AND decision_qty IS NOT NULL AND uom_id IS NOT NULL AND (lot_ids IS NULL OR cardinality(lot_ids) = 0))
        OR (disposition_type_code = 'SORT' AND lot_ids IS NOT NULL AND cardinality(lot_ids) > 0)
    ),
    -- 반영됐으면 만든 처분 판정을 가리킨다.
    CONSTRAINT ck_disposition_approval_applied CHECK ((status_code = 'APPLIED') = (disposition_decision_id IS NOT NULL))
);
COMMENT ON TABLE quality.disposition_approval IS
  '폐기·선별 처분 결재 요청(omf-all-around#352) — 결재 승인 뒤 :apply 가 저장한 본문으로 처분 판정을 만든다. 상태 PENDING·APPLIED·REJECTED';
COMMENT ON COLUMN quality.disposition_approval.lot_ids IS '선별(SORT)만 — 불량 자재 관리 LOT(이 부적합의 LOT, 전부는 아님)';
COMMENT ON COLUMN quality.disposition_approval.disposition_decision_id IS '반영(APPLIED) 때 만든 처분 판정';
CREATE INDEX ix_disposition_approval_nonconformance ON quality.disposition_approval (nonconformance_id);
-- 한 부적합에 결재 진행 중인 처분은 하나다 — 동시 요청은 부적합 행 잠금이 먼저 막고, 이 인덱스가 마지막으로 막는다.
CREATE UNIQUE INDEX uq_disposition_approval_pending
    ON quality.disposition_approval (nonconformance_id)
 WHERE status_code = 'PENDING';
