-- 검사 항목별 허용 불량 수(omf-all-around#211 · 장부 P-155). 고객사 검사기준서는 항목마다 「n=5c=0」·「n=5c=1」처럼
-- 시료 수(n = measurement_count)와 허용 불량 수(c)를 따로 적는다 — 버전의 acceptance_number 하나로는 담지 못한다.
-- 비어 있으면 그 항목은 버전 기준을 따른다. 기본값 없는 NULL 칸이라 배포 중 옛 코드와 함께 돈다.
ALTER TABLE quality.inspection_item_spec ADD COLUMN acceptance_number INTEGER;
ALTER TABLE quality.inspection_item_spec
  ADD CONSTRAINT ck_inspection_item_acceptance CHECK (acceptance_number IS NULL OR acceptance_number >= 0);
