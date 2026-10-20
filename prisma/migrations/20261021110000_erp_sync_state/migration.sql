-- ERP 받기 표마다 한 줄 — 사람이 누른 「지금 읽기」 요청과 마지막 회차의 결과·다음 예정 시각.
-- 실행기는 블루-그린 두 쪽 중 리스를 쥔 쪽에서만 돈다. 요청을 받은 api 가 회차를 직접 돌리지 않고
-- 여기에 적어 두면, 쥔 쪽이 몇 초 안에 보고 그 표를 돈다. 화면은 같은 줄을 읽어 상태를 보인다.
-- interface_code 는 연계 메시지(integration_message.interface_code)와 같은 값이다(IF-ERP-*-RECV).
CREATE TABLE integration.erp_sync_state (
    interface_code     varchar(50)  PRIMARY KEY,
    requested_at       timestamptz,
    requested_by       bigint,
    last_started_at    timestamptz,
    last_finished_at   timestamptz,
    last_status_code   varchar(20),
    last_read_count    integer,
    last_applied_count integer,
    last_failed_count  integer,
    last_held_count    integer,
    last_error_message text,
    next_run_at        timestamptz,
    updated_at         timestamptz  NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_erp_sync_state_status CHECK (last_status_code IN ('SUCCEEDED', 'FAILED'))
);
