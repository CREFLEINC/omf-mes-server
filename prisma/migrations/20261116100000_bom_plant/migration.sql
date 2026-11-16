-- BOM 의 공장(사용자 결정 2026-11-04 · flowtrack 연동 제안 §4) — OA 자동 계획·자재 차감은 PL13 BOM 만 푼다.
-- ERP 는 BOM 행마다 공장(PLANT_CD)을 보내는데 저장하지 않았다. 널을 허용해 더하고(옛 코드와 함께 산다),
-- 모두 채운 뒤 NOT NULL 은 다음 릴리스에서 붙인다.
ALTER TABLE planning.bom
    ADD COLUMN plant_id bigint,
    ADD CONSTRAINT bom_plant_id_fkey FOREIGN KEY (plant_id) REFERENCES mdm.plant (plant_id);

-- 이미 받은 BOM 은 MES 에 남은 ERP 받기 기록의 공장으로 채운다 — BOM 코드가 `ERP-<모품목 코드>` 다.
-- 두 공장에서 온 모품목과 코드가 겹치는 공장은 고르지 않고 비워 둔다.
-- 기록이 없는 BOM(ERP 받기를 끈 채 초기 데이터로 넣은 현장)은 초기 데이터 SQL 을 다시 돌려 채운다(사용자 2026-11-16).
UPDATE planning.bom bom
SET plant_id = plant.plant_id
FROM (
    SELECT payload->'row'->>'PRNT_ITEM_CD' AS parent_code, min(payload->'row'->>'PLANT_CD') AS plant_code
    FROM integration.integration_message
    WHERE interface_code = 'IF-ERP-BOM-RECV'
    GROUP BY 1
    HAVING count(DISTINCT payload->'row'->>'PLANT_CD') = 1
) source
JOIN (
    SELECT plant_code, min(plant_id) AS plant_id FROM mdm.plant GROUP BY plant_code HAVING count(*) = 1
) plant ON plant.plant_code = source.plant_code
WHERE bom.bom_code = 'ERP-' || source.parent_code
  AND bom.plant_id IS NULL;
