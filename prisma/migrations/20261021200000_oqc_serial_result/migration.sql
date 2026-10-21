-- 시리얼 OQC(omf-all-around#68 · 장부 P-101). 출하작업지시 OQC 를 확정할 때 검사한 시리얼마다 OK/NG 를 남긴다.
-- ⭐ 시리얼당 한 줄이다 — 재검 회차가 같은 줄을 고친다. 1차 판정은 처음 값 그대로, 최종 판정과 마지막 회차만 바뀐다(담당자 결정 Q4).
--    회차별 이력은 남지 않는다(한계 · 장부 P-101). 제품 검사표(#89)가 들어오면 그 「출하검사」 줄은 이 표를 읽어 잇는다.
CREATE TABLE quality.oqc_serial_result (
    oqc_serial_result_id bigserial PRIMARY KEY,
    serial_number_id     bigint      NOT NULL REFERENCES trace.serial_number(serial_number_id),
    inspection_result_id bigint      NOT NULL REFERENCES quality.inspection_result(inspection_result_id),
    first_judgment_code  varchar(10) NOT NULL,
    final_judgment_code  varchar(10) NOT NULL,
    inspected_worker_id  bigint REFERENCES mdm.worker(worker_id),
    inspected_at         timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by           bigint REFERENCES app.app_user(app_user_id),
    updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by           bigint REFERENCES app.app_user(app_user_id),
    version_no           integer     NOT NULL DEFAULT 1 CHECK (version_no > 0),
    CONSTRAINT uq_oqc_serial_result_serial UNIQUE (serial_number_id),
    CONSTRAINT ck_oqc_serial_result_judgment
        CHECK (first_judgment_code IN ('OK', 'NG') AND final_judgment_code IN ('OK', 'NG')),
    -- 1차가 OK 면 최종도 OK 다 — NG → 수리 → 재검 OK 만 있다.
    CONSTRAINT ck_oqc_serial_result_first_ok
        CHECK (first_judgment_code = 'NG' OR final_judgment_code = 'OK')
);

CREATE INDEX ix_oqc_serial_result_inspection_result
    ON quality.oqc_serial_result (inspection_result_id);
