-- 공급사명 정렬이 대소문자를 가렸다(SD Chemical Vina 가 Samheung 앞) — alpine 의 musl 은 DB 기본 정렬(en_US.utf8)을 지키지 않아 바이트 순이 된다.
-- ICU 루트 정렬은 대소문자·성조를 2차로 미뤄 Samheung → SD → solum 이 된다. 결정적(deterministic) 정렬이라 = 비교·ILIKE 는 그대로다.
-- 타입은 도메인 app.name_t 그대로다. 칸에 인덱스·뷰가 없어 표를 다시 쓰지 않고, 옛 코드도 그대로 읽는다.
-- ⚠ 정본 물리 모델에 없는 구현 측 추가분이다 — 모델링 SQL 에 역반영이 필요하다.
ALTER TABLE mdm.partner ALTER COLUMN partner_name TYPE app.name_t COLLATE "und-x-icu";
