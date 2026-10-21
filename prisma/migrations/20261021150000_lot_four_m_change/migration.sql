-- 4M 변경품 — IQC 판정 때 자재 LOT 하나에 «변경품»과 변경 종류·비고를 적는다(omf-all-around#63 · 장부 P-86).
-- ⚠ 내부 「4M 자원배정」(W/O 에 라인·설비·금형·작업자 배정)과 다른 말이다 — 공급사가 사람·설비·자재·방법을 바꿔 보낸 자재다.
-- LOT 하나에 한 줄이다. 변경품이 아니면 줄이 없다(체크 해제 = 줄 삭제).
CREATE TABLE quality.lot_four_m_change (
    lot_four_m_change_id  bigserial PRIMARY KEY,
    lot_id                bigint      NOT NULL REFERENCES trace.lot(lot_id),
    inspection_request_id bigint      NOT NULL REFERENCES quality.inspection_request(inspection_request_id),
    change_type_code      varchar(50) NOT NULL,
    remarks               varchar(500),
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by            bigint REFERENCES app.app_user(app_user_id),
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by            bigint REFERENCES app.app_user(app_user_id),
    version_no            integer     NOT NULL DEFAULT 1 CHECK (version_no > 0)
);

CREATE UNIQUE INDEX uq_lot_four_m_change_lot ON quality.lot_four_m_change (lot_id);
CREATE INDEX ix_lot_four_m_change_request ON quality.lot_four_m_change (inspection_request_id);

-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 값이 있다.
-- 목록은 고객 회신 전 기본 4종이다 — 시스템 소유가 아니라 기준정보 화면에서 더하고 고칠 수 있다.
INSERT INTO mdm.code_group (group_code, group_name, is_system_owned)
VALUES ('FOUR_M_CHANGE_TYPE', '4M 변경 종류', false)
ON CONFLICT (group_code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order
FROM mdm.code_group cg
CROSS JOIN (VALUES ('MAN', '사람', 10), ('MACHINE', '설비', 20), ('MATERIAL', '자재', 30), ('METHOD', '방법', 40))
    AS v(code, code_name, display_order)
WHERE cg.group_code = 'FOUR_M_CHANGE_TYPE'
ON CONFLICT (code_group_id, code) DO NOTHING;
