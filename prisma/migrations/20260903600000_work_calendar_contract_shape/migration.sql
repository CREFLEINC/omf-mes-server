-- 작업 캘린더를 계약이 정한 모양으로 되맞춘다.
--
-- ── 1. 캘린더는 «전역» 유일이다
-- 계약 `WorkCalendar.calendarCode` 가 「전역에서 유일하다」로 적었고 스키마에 plantId 가
-- 없다. 물리는 plant_id NOT NULL 에 uq_work_calendar(plant_id, calendar_code) 다.
--
-- 방향이 앞의 마스터들과 반대다 — 창고·설비는 계약이 공장 축을 «넣으라» 했고, 캘린더는
-- 「전역」이라 한다. 캘린더가 공장에 매이지 않는 이유는 적용(application)이 대상을 정하기
-- 때문이다 — 한 캘린더를 여러 공장이 따를 수 있다.
--
-- plant_id 를 nullable 로 푼다(완화 — 하위 호환). 유일을 전역으로 옮긴다(0행이라 안전).
--
-- ── 2. timezone_name 을 받을 경로가 없다
-- 계약이 이 칸을 받지도 내지도 않는다. NOT NULL 이면 서버가 근거 없는 타임존을 지어
-- 넣어야 한다 — 공장 로컬 시각은 plant.timezone_code 가 정본이다(CLAUDE.md).
-- 완화한다.
--
-- ── 3. 날짜에 사유 코드가 없다
-- 계약 `WorkCalendarDay.reasonCode` 가 있고 시드에 WORK_CALENDAR_DAY_REASON 6값이
-- 이미 있다(PUBLIC_HOLIDAY·COMPANY_FOUNDING_DAY·…). 컬럼만 없다.

ALTER TABLE mdm.work_calendar
    ALTER COLUMN plant_id      DROP NOT NULL,
    ALTER COLUMN timezone_name DROP NOT NULL;

ALTER TABLE mdm.work_calendar
    DROP CONSTRAINT uq_work_calendar;

ALTER TABLE mdm.work_calendar
    ADD CONSTRAINT uq_work_calendar UNIQUE (calendar_code);

ALTER TABLE mdm.work_calendar_day
    ADD COLUMN reason_code app.code_t;

COMMENT ON COLUMN mdm.work_calendar.plant_id IS
  '계약이 캘린더를 공장에 매지 않는다 — 한 캘린더를 여러 공장이 따를 수 있고, 적용(work_calendar_application)이 대상을 정한다.';
COMMENT ON COLUMN mdm.work_calendar.timezone_name IS
  '계약이 받는 경로가 없다. 공장 로컬 시각의 정본은 plant.timezone_code 다.';
COMMENT ON COLUMN mdm.work_calendar_day.reason_code IS
  '휴무·부분가동의 사유 (WORK_CALENDAR_DAY_REASON).';
