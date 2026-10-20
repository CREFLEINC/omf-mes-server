-- 자동 계획을 오더마다 하나씩만 돌린다 — 이 시각까지는 다른 호출이 손대지 않는다. 비어 있거나 지났으면 비어 있다.
-- 트랜잭션·연결을 쥐고 기다리지 않으려고 행 하나의 조건부 UPDATE 로 잡는다. 프로세스가 죽어도 시각이 지나면 풀린다.
ALTER TABLE planning.production_order
    ADD COLUMN auto_plan_running_until timestamptz;

-- ERP W/O 목록의 자동 계획 상태(확정 계획 수량 합)와 필터가 오더마다 계획을 찾는다.
CREATE INDEX ix_production_plan_order ON planning.production_plan (production_order_id);
