-- I-24 선행 커밋 · A11 · 추가 2 · 완화 0 · 삭제 0 — forward-only 이고 두 릴리스 규칙 미해당. 백필 0.
--
-- 사전 대조(마이그 «전» 개발 DB 실측 · 읽기만):
--   SELECT count(*) FROM planning.production_plan;                 -- → 0
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='planning' AND table_name='production_plan'
--      AND column_name IN ('split_of_plan_id','split_reason_code'); -- → 0행
--
-- 계약 `ProductionPlanCreate.splitOfPlanId` 가 `ProductionPlanSplitRef`
-- (`{sourcePlanId, reasonCode}`) 를 가리키는데 담을 칸이 둘 다 없다.
-- ⛔ `reasonCode` 를 버리지 않는다 — 시드 `PRODUCTION_PLAN_SPLIT_REASON` 이 5값으로
--    이미 서 있어(DB 실측) 버리면 그 그룹이 죽는다. 선례: I-7 D2
--    (`production_result.correct_reason_code` — 계약이 이름만 준 사유 칸에 컬럼을 더했다).
-- ⛔ FK 제약 이름을 적지 않는다 — PostgreSQL 기본형 `production_plan_split_of_plan_id_fkey`
--    가 Prisma 기본형이다. `fk_*` 로 지으면 `migrate diff` 가 드리프트를 낸다.
-- ⚠ 같은 표의 `fk_production_plan_confirmed_by` 는 map 을 지정했지만 새 FK 만 Prisma 기본형으로 둔다.
ALTER TABLE planning.production_plan
    ADD COLUMN split_of_plan_id bigint
        REFERENCES planning.production_plan(production_plan_id),
    ADD COLUMN split_reason_code app.code_t;

-- 형제 선례 `ck_production_order_parent`·`ck_work_order_split_self` 와 같은 모양.
ALTER TABLE planning.production_plan
    ADD CONSTRAINT ck_production_plan_split_self
        CHECK (split_of_plan_id IS NULL OR split_of_plan_id <> production_plan_id);

-- 원본 계획을 지울 때 자식 존재를 FK 가 막는다 — 그 판정이 이 축으로 돈다.
CREATE INDEX ix_production_plan_split_of
    ON planning.production_plan(split_of_plan_id);

COMMENT ON COLUMN planning.production_plan.split_of_plan_id IS
    '러닝체인지로 이 계획을 나눌 때의 원본 계획. 계약 ProductionPlanCreate.splitOfPlanId.sourcePlanId.';
COMMENT ON COLUMN planning.production_plan.split_reason_code IS
    '분할 사유. 공통코드 그룹 PRODUCTION_PLAN_SPLIT_REASON. 계약 ProductionPlanSplitRef.reasonCode.';
