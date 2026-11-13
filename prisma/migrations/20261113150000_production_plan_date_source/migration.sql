-- 계획일을 시스템이 정했는지 사람이 정했는지. 시스템이 정한 날짜만 캘린더가 바뀔 때 재검토 대상이다.
-- 기본값이 있어 배포 중 옛 코드가 넣는 행도 USER 가 된다. 기존 계획도 USER — 휴일이어도 경고만 받는다.
ALTER TABLE planning.production_plan
  ADD COLUMN plan_date_source_code varchar(20) NOT NULL DEFAULT 'USER',
  ADD CONSTRAINT ck_production_plan_plan_date_source
    CHECK (plan_date_source_code IN ('SYSTEM', 'USER'));
