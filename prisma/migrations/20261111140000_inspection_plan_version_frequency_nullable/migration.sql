-- 검사 주기는 기록용이라 화면에서 받지 않는다(omf-all-around#263) — 비워 둘 수 있게 한다.
ALTER TABLE quality.inspection_plan_version ALTER COLUMN inspection_frequency_code DROP NOT NULL;
