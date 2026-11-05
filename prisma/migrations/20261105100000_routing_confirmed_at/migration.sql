-- 공정 경로 이력 관리의 「확정 일시」(omf-all-around#231) — :confirm 이 그 시각을 적는다.
-- 기본값 없는 NULL 칸이라 하위 호환이다. 이미 확정된 Rev 는 확정 시각을 알 수 없어 NULL 로 둔다(지어내지 않는다).
ALTER TABLE planning.routing ADD COLUMN confirmed_at TIMESTAMPTZ(6);
