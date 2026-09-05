-- I-1 A6 · 계약 POST /app/approval-routes: 「같은 (approvalTypeCode, businessUnitId) 로 활성 결재선이
-- 이미 있으면 400 이다 — 활성 결재선은 한 벌이어야 고를 것이 하나로 정해지므로 계약이 막는다」
-- business_unit_id 가 nullable 이라 COALESCE 로 접는다(선례 uq_user_data_scope).
CREATE UNIQUE INDEX uq_approval_route_active
    ON app.approval_route (approval_type_code, COALESCE(business_unit_id, 0))
    WHERE is_active;

-- 승인 자물쇠 조회 축(target_type_code, target_id) — I-2 이후 모든 :post 가 이 경로로 승인 상태를 읽는다.
CREATE INDEX ix_approval_request_target ON app.approval_request (target_type_code, target_id);
