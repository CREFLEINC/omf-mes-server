-- 검사 기준 승인 기록(승인자·승인 시각)을 지운다 — 승인 기능을 없앴다(화면 omf-all-around#357 · 서버 앞 커밋).
-- ⛔ 승인 API·응답을 뗀 릴리스가 배포된 «다음» 릴리스에만 싣는다 — 블루-그린 전환 중 옛 판이 이 칸을 읽는다.
-- 칸을 지우면 기존 승인 기록도 함께 사라진다(되돌릴 수 없다). 승인 기록을 따로 남긴 감사 행은 없다.
ALTER TABLE quality.inspection_plan DROP CONSTRAINT IF EXISTS inspection_plan_approved_by_fkey;
ALTER TABLE quality.inspection_plan DROP COLUMN approved_by, DROP COLUMN approved_at;
