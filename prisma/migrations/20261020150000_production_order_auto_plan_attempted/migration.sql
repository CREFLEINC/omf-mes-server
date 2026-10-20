-- 서버가 이 ERP W/O 의 자동 계획을 시도한 시각. 비어 있으면 시도한 적이 없다 — 그 기능 전에 받은 ERP W/O 는
-- 「확인 필요」로 보이지 않게 이 칸으로 가른다. 기본값으로 채우지 않는다(옛 ERP W/O 는 비어 있어야 한다).
ALTER TABLE planning.production_order
    ADD COLUMN auto_plan_attempted_at timestamptz;
