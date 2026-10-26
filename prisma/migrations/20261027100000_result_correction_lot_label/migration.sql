-- 실적 정정이 LOT 배분을 갖고, LOT 수량은 정정되지 않은 실적(잎)의 배분만 센다 — 장부 P-120. 추가만이라 옛 코드와 함께 산다.

-- 「이 실적을 정정한 행이 있는가」를 실적마다 묻는다(LOT 수량·완료 판정·라벨). 그 외래키 쪽에 인덱스가 없었다.
CREATE INDEX ix_production_result_corrects ON production.production_result (corrects_production_result_id);

-- 발행 순간의 라벨 수량. 생산 LOT 수량은 정정으로 바뀌므로, 찍힌 수량을 남겨야 「재발행 필요」를 가리고
-- 같은 발행 기록을 다시 그려도 그때 수량이 나온다. 옛 기록은 비어 있다(그때는 현재 수량으로 그린다).
ALTER TABLE app.document_issue_log ADD COLUMN label_qty numeric(20, 6);

-- 재발행 사유 「실적 정정」. 배포는 migrate deploy 만 돌고 시드를 안 돌려 마이그에 둔다 — seed.ts 에도 같은 줄이 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'RESULT_CORRECTED', '실적 정정으로 수량 변경', 60
FROM mdm.code_group cg
WHERE cg.group_code = 'REISSUE_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
