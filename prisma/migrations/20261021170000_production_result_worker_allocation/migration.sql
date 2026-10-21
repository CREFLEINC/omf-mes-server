-- 생산 실적 한 건의 수량을 그 구간에 참여한 작업자에게 나눈 몫. 실적 저장 때 함께 쓰고 고치지 않는다.
-- 실적을 지우면 몫도 함께 지운다 — 실적에 매달린 파생 행이라 따로 남을 뜻이 없다.
CREATE TABLE production.production_result_worker_allocation (
    production_result_worker_allocation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    production_result_id bigint NOT NULL
                         REFERENCES production.production_result(production_result_id) ON DELETE CASCADE,
    worker_id            bigint NOT NULL REFERENCES mdm.worker(worker_id),
    worker_role_code     varchar(50) NOT NULL,
    -- 실적 구간(직전 실적 또는 세션 시작 ~ 이 실적)에 참여한 분 — 배분의 근거라 남긴다.
    participated_minutes numeric(12, 2) NOT NULL CHECK (participated_minutes >= 0),
    -- 정정 실적은 원 실적의 이 비율을 다시 쓴다.
    share_ratio          numeric(12, 10) NOT NULL CHECK (share_ratio >= 0 AND share_ratio <= 1),
    good_qty             app.qty_t NOT NULL DEFAULT 0,
    defect_qty           app.qty_t NOT NULL DEFAULT 0,
    hold_qty             app.qty_t NOT NULL DEFAULT 0,
    scrap_qty            app.qty_t NOT NULL DEFAULT 0,
    rework_qty           app.qty_t NOT NULL DEFAULT 0,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint,
    CONSTRAINT uq_production_result_worker UNIQUE (production_result_id, worker_id)
);

CREATE INDEX ix_production_result_worker_worker ON production.production_result_worker_allocation (worker_id, production_result_id);
