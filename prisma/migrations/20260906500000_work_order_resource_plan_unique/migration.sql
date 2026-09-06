-- I-6 M-d · 계약 `POST /production/work-orders/{workOrderId}/resource-plans`:
-- 「uq_work_order_resource_plan(work_order_id, resource_type_code, resource_id) 로 같은 자원
--  중복 배정을 막는다」. 물리는 resource_id 를 네 칸으로 갈라 두었고
--  ck_work_order_resource_target(num_nonnulls = 1) 이 넷 중 정확히 하나만 non-null 임을
--  지키므로 COALESCE 가 그 하나를 고른다 — 칸 수까지 계약과 같다(I-6.md R-9 · §2-6).
-- shift_id 도 식에 넣는다: 계약 enum 에 SHIFT 가 없어도 물리 칸은 넷이고 CHECK 가 넷을
--  대칭으로 다룬다. 셋만 넣으면 SHIFT 행 중복을 인덱스가 조용히 통과시킨다.
-- 「부분」이 아니라 «식» 유일 인덱스다 — WHERE 절이 없다.
-- 선례: uq_approval_route_active(I-1) · uq_numbering_rule(baseline).
-- 사전 대조(적용 전 개발·운영 DB 에서 0행이어야 한다):
--   SELECT work_order_id, resource_type_code,
--          COALESCE(equipment_id, mold_id, worker_id, shift_id), count(*)
--     FROM production.work_order_resource_assignment
--    GROUP BY 1, 2, 3 HAVING count(*) > 1;
CREATE UNIQUE INDEX uq_work_order_resource_plan
    ON production.work_order_resource_assignment (
        work_order_id,
        resource_type_code,
        COALESCE(equipment_id, mold_id, worker_id, shift_id)
    );
