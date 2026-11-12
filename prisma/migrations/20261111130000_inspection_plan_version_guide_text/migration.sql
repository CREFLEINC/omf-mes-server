-- 검사 지시문을 한 칸으로(omf-all-around#261). 옛 두 칸(guide_text_ko · guide_text_vi)은 블루-그린 배포 중 옛 코드가
-- 읽으므로 이번에 지우지 않는다 — 다음 릴리스에서 삭제한다.
ALTER TABLE quality.inspection_plan_version ADD COLUMN guide_text VARCHAR(3000) NULL;

-- 옛 값을 옮긴다 — 한쪽만 있으면 그 글, 둘 다 있으면 한국어 · 빈 줄 · 베트남어(합쳐 3000자를 넘으면 자른다).
UPDATE quality.inspection_plan_version
SET guide_text = LEFT(
  CASE
    WHEN NULLIF(BTRIM(guide_text_ko), '') IS NOT NULL AND NULLIF(BTRIM(guide_text_vi), '') IS NOT NULL
      THEN guide_text_ko || E'\n\n' || guide_text_vi
    ELSE COALESCE(NULLIF(BTRIM(guide_text_ko), ''), NULLIF(BTRIM(guide_text_vi), ''))
  END,
  3000)
WHERE NULLIF(BTRIM(guide_text_ko), '') IS NOT NULL OR NULLIF(BTRIM(guide_text_vi), '') IS NOT NULL;
