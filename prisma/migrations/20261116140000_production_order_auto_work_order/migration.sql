-- OA 자동 W/O 실행기의 마지막 시도(사용자 결정 2026-11-16 · flowtrack 연동 제안 §8 의 5).
-- 실패하면 까닭을 남기고 10분 뒤 다시 한다. 성공하면 까닭을 지운다. 옛 자동 계획(auto_plan_*)과는 다른 칸이다.
ALTER TABLE planning.production_order
  ADD COLUMN auto_work_order_attempted_at timestamptz,
  ADD COLUMN auto_work_order_error_text   varchar(1000);
