-- 추적 시스템(flowtrack) 연동이 사람 없이 세운 계획(사용자 결정 2026-11-16 · flowtrack 연동 제안 §7-3 의 1).
-- 그 계획의 W/O 는 라인·WIP·스크랩 위치 없이 배포하고 배포 인계 알림을 보내지 않는다. 사람이 세운 계획은 자동 흐름이 건드리지 않는다.
-- 기본값이 있어 배포 중 옛 코드가 넣는 행과 기존 계획은 모두 사람이 세운 계획이다.
ALTER TABLE planning.production_plan
  ADD COLUMN created_automatically boolean NOT NULL DEFAULT false;
