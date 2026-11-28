-- 피처 019 반납 입고(omf-all-around#367) — 쓰지 않던 「자재 반출 요청」 표 둘을 반납 입고 기록으로 고쳐 쓴다(research R-1).
-- 사람이 주는 것은 LOT·수량(·W/O 로 찾기·PDA 위치)뿐이고, 귀속 W/O 는 서버가 그 LOT 의 가장 최근 W/O 출고 라인으로 정해
-- 줄에 남긴다. 머리의 W/O·출발 위치는 쓰지 않는다(한 건에 W/O 가 다른 줄이 섞이고, #362 뒤 현장 위치가 없다).
-- ⭐ forward-only — NOT NULL 을 풀고 칸을 더하기만 한다. 옛 「요청」 행은 그대로 두고 새 칸은 NULL 이다.

-- ① 머리 — W/O·출발 위치 NULL 허용, 처리 단말 종류·처리 작업자·업무일.
ALTER TABLE production.material_return
    ALTER COLUMN work_order_id DROP NOT NULL,
    ALTER COLUMN source_location_id DROP NOT NULL,
    ADD COLUMN terminal_kind_code varchar(50),
    ADD COLUMN received_by bigint REFERENCES mdm.worker(worker_id),
    ADD COLUMN business_date date,
    ADD CONSTRAINT ck_material_return_terminal_kind CHECK (terminal_kind_code IS NULL OR terminal_kind_code IN ('POP', 'PDA'));

COMMENT ON COLUMN production.material_return.work_order_id IS
  '옛 「반출 요청」의 W/O. 반납 입고(019)는 쓰지 않는다 — 귀속 W/O 는 줄(material_return_line.work_order_id)에 있다';
COMMENT ON COLUMN production.material_return.source_location_id IS
  '옛 「반출 요청」의 출발 위치. 반납 입고(019)는 쓰지 않는다 — #362 뒤 현장 위치가 없다';
COMMENT ON COLUMN production.material_return.destination_warehouse_id IS
  '받은 창고 — 반납 입고는 첫 줄의 받은 위치의 창고(적치 대기면 그 LOT 을 출고한 생산창고)';
COMMENT ON COLUMN production.material_return.status_code IS
  '서버 상수(공통코드 아님 · 계약 x-no-code-key). 옛 행 REQUESTED, 반납 입고는 바로 RECEIVED';
COMMENT ON COLUMN production.material_return.received_at IS '반납 입고 시각 — 단말이 보낸 occurredAt(C-8)';
COMMENT ON COLUMN production.material_return.terminal_kind_code IS '처리 단말 종류 POP · PDA. 계정 세션 호출이면 NULL';
COMMENT ON COLUMN production.material_return.received_by IS '처리 작업자(단말 X-Worker-No). 계정 세션 호출이면 NULL — 그때는 created_by 가 계정이다';
COMMENT ON COLUMN production.material_return.business_date IS '단말이 보낸 업무일(C-8) — 원장 업무일과 같다';

-- ② 줄 — 귀속 W/O·근거 출고 라인·귀속 방법·받은 위치.
ALTER TABLE production.material_return_line
    ADD COLUMN work_order_id bigint REFERENCES production.work_order(work_order_id),
    ADD COLUMN goods_issue_line_id bigint REFERENCES logistics.goods_issue_line(goods_issue_line_id),
    ADD COLUMN attribution_code varchar(50),
    ADD COLUMN destination_location_id bigint REFERENCES mdm.location(location_id),
    ADD CONSTRAINT ck_material_return_line_attribution CHECK (
        attribution_code IS NULL OR attribution_code IN ('AUTO_LATEST_ISSUE', 'WORK_ORDER_PICKED', 'NONE_FINALIZED')),
    -- 귀속 없음(NONE_FINALIZED)이면 W/O 가 비고, 귀속이면 W/O 가 있다. 옛 줄(귀속 코드 NULL)은 묻지 않는다.
    ADD CONSTRAINT ck_material_return_line_attributed CHECK (
        attribution_code IS NULL
        OR (attribution_code = 'NONE_FINALIZED' AND work_order_id IS NULL)
        OR (attribution_code <> 'NONE_FINALIZED' AND work_order_id IS NOT NULL));

COMMENT ON COLUMN production.material_return_line.work_order_id IS
  '귀속 W/O — 017 최종 마감이 W/O·LOT 별로 빼는 반납 합의 축. NULL = 귀속 없음(그 W/O 가 최종 마감됨) 또는 옛 줄';
COMMENT ON COLUMN production.material_return_line.goods_issue_line_id IS
  '귀속 근거 — 반납 때 그 LOT 의 가장 최근 W/O 출고 라인. 반납 가능 양 = 그 라인 수량 − 이 칸이 그 라인인 반납 줄 합(귀속 없음 줄 포함). 새 줄은 서비스가 반드시 채운다';
COMMENT ON COLUMN production.material_return_line.attribution_code IS
  '귀속 방법 AUTO_LATEST_ISSUE(LOT 스캔) · WORK_ORDER_PICKED(W/O 로 찾기) · NONE_FINALIZED(그 W/O 최종 마감 — 귀속 없음)';
COMMENT ON COLUMN production.material_return_line.destination_location_id IS '받은 위치 — 적치 대기(출고 생산창고) 또는 PDA 스캔 위치';
COMMENT ON COLUMN production.material_return_line.inventory_transaction_line_id IS '반납 입고 원장 라인(거래 유형 MATERIAL_RETURN)';

CREATE INDEX ix_material_return_line_goods_issue_line ON production.material_return_line (goods_issue_line_id);
CREATE INDEX ix_material_return_line_work_order_lot ON production.material_return_line (work_order_id, lot_id);

-- ③ 원천 문서 — 반납 입고 원장(source_document_type_code = MATERIAL_RETURN)이 머리를 가리킨다.
--    ⭐ 배포는 migrate deploy 만 돈다 — prisma/seed.ts ENTITY_TYPES 에도 같은 행이 있다.
INSERT INTO app.entity_type_registry (entity_type_code, schema_name, table_name, id_column_name)
VALUES ('MATERIAL_RETURN', 'production', 'material_return', 'material_return_id')
ON CONFLICT DO NOTHING;

-- ④ 화면 권한 — PDA 반납 입고(M-01-15)는 적치(M-01-05)를 가진 창고 작업 역할에, POP 반납 입고(P-01-03)는
--    분할 LOT 라벨(P-01-02)을 가진 역할에 준다. POP 단말은 권한이 아니라 단말 공정 매핑 can_return_material 로 연다.
--    시드는 기본 역할에 권한을 주지 않는 관례라 기존 DB 는 여기서 준다(20261125170000 선례).
INSERT INTO app.role_permission (role_id, permission_code)
SELECT rp.role_id, v.new_code
  FROM app.role_permission rp
  JOIN (VALUES ('M-01-05', 'M-01-15'), ('P-01-02', 'P-01-03')) AS v(old_code, new_code) ON rp.permission_code = v.old_code
ON CONFLICT (role_id, permission_code) DO NOTHING;
