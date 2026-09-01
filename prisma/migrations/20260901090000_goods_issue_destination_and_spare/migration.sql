-- 출고 도착지 완화 + 예비품 출고 라인 신설.
--
-- 요청: 설계 회신 2026-09-01 E-2 정리본 · 이슈 #44 하위 3표의 남은 하나
-- 계약: logistics-01자재창고.json 의 GoodsIssue·GoodsIssueCreate

-- ═══ 1. 도착지 두 칸을 비울 수 있게 ═════════════════════════════════════════
--
-- 계약이 둘을 nullable 로 두고 required 에서도 뺐다. enum 에 null 이 들어 있고 설명이
-- 「⭐ 자체 폐기면 도착지 짝을 통째로 비운다 — 나가서 없어지는 물건에는 도착지가
-- 없다」(2026-08-16 업무 확정)이다.
--
-- 물리가 NOT NULL 이라 «계약이 정의한 자체 폐기 출고를 담을 수 없었다». 원천 두 칸이
-- 「필수 유지」로 정리된 것과 «별개 자리»다 — 회신이 원천만 보고 도착지를 다루지
-- 않았으나, 계약이 확정한 요구이므로 물리를 맞춘다.
--
-- 「없음」을 값으로 두지 않는다 — 가리킬 대상이 없는 값을 다형 참조 판별자에 섞지
-- 않는 것이 공유계약 A-10 이다. 대신 짝으로 묶어 한쪽만 채운 행을 막는다.
-- goods_receipt(20260901040000)·lot_status_event·lot_lifecycle_history 와 같은 형태다.

ALTER TABLE logistics.goods_issue
    ALTER COLUMN destination_type_code DROP NOT NULL,
    ALTER COLUMN destination_id DROP NOT NULL;

ALTER TABLE logistics.goods_issue
    ADD CONSTRAINT ck_goods_issue_destination
        CHECK ((destination_type_code IS NULL) = (destination_id IS NULL));

COMMENT ON COLUMN logistics.goods_issue.destination_type_code IS
    '도착지 유형 — 위치·거래처·폐기거래처·설비. destination_id 와 짝이며, 자체 폐기처럼 나가서 없어지는 물건에는 도착지가 없어 둘을 함께 비운다(2026-08-16 확정 · 공유계약 A-10).';

-- ⚠ 원천 두 칸(source_document_type_code·source_document_id)은 그대로 둔다. 설계가
--   두 갈래를 화면 스펙까지 내려가 실측한 결과 「원천이 없는 출고 갈래는 없다」로
--   정리했다 — 예비품 출고는 보전 지시, 출하는 출하 건이 원천이다.

-- ═══ 2. logistics.goods_issue_spare_line — 예비품 출고 라인 ══════════════════
--
-- 설계가 2026-08-11 에 「예비품은 기존 출고 라인에 담지 않고 형제 라인을 신설한다」로
-- 확정해 놓고 요청이 나가지 않았던 건이다(회신에서 자진 정정).
--
-- 헤더(goods_issue)는 재사용한다. 갈리는 것은 라인뿐이다.
--
-- 왜 기존 goods_issue_line 을 쓰지 않는가 — 셋이다.
--
--   기존 제약이 약해진다   goods_issue_line.item_id·lot_id 가 둘 다 NOT NULL 이고
--                          자재 출고가 그 제약에 기대고 있다. 예비품 때문에 풀면 자재
--                          쪽 무결성이 함께 내려간다. 실측으로 확인했다.
--   LOT 이 없는 것이 정상  자재 LOT 은 입하에서 만들어지고 예비품은 그 경로를 타지
--                          않는다. 발번할 근거가 없다.
--   가리키는 대상이 다르다 기존 라인은 품목 마스터를, 예비품은 예비품 마스터를
--                          가리킨다. 한 표에 섞으면 조회하는 쪽이 매번 유형을 본다.
--
-- ⛔ lot_id 를 두지 않는다 — 위 둘째가 그대로 근거다.
--
-- 컬럼은 설계가 준 셋(spare_part_id·issue_qty·uom_id)에 구조에 필요한 것만 더한다.
-- 재고 원장 연결(inventory_transaction_line_id)은 넣지 않는다 — 형제 라인에는 있으나
-- 예비품 전기 경로가 아직 설계되지 않았고, 쓰지 않을 칸을 미리 세우지 않는다.

CREATE TABLE logistics.goods_issue_spare_line (
    goods_issue_spare_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    goods_issue_id bigint NOT NULL REFERENCES logistics.goods_issue(goods_issue_id),
    line_no integer NOT NULL,
    spare_part_id bigint NOT NULL REFERENCES mdm.spare_part(spare_part_id),
    issue_qty app.qty_t NOT NULL,
    uom_id bigint NOT NULL REFERENCES mdm.uom(uom_id),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_by bigint REFERENCES app.app_user(app_user_id),

    CONSTRAINT ck_goods_issue_spare_line_qty CHECK (issue_qty > 0),
    CONSTRAINT uq_goods_issue_spare_line UNIQUE (goods_issue_id, line_no)
);

CREATE INDEX ix_goods_issue_spare_line_issue
    ON logistics.goods_issue_spare_line USING btree (goods_issue_id, line_no);
CREATE INDEX ix_goods_issue_spare_line_part
    ON logistics.goods_issue_spare_line USING btree (spare_part_id);

COMMENT ON TABLE logistics.goods_issue_spare_line IS
    '예비품 출고 라인. goods_issue_line 과 형제이며 헤더(goods_issue)는 공유한다. 기존 라인을 쓰지 않는 것은 item_id·lot_id 가 둘 다 NOT NULL 이고 자재 출고가 그 제약에 기대고 있어서다 — 예비품 때문에 풀면 자재 쪽 무결성이 함께 내려간다. 근거: 설계 확정 2026-08-11 · 회신 E-2 정리본.';

COMMENT ON COLUMN logistics.goods_issue_spare_line.spare_part_id IS
    '예비품 마스터. 기존 라인이 품목 마스터를 가리키는 것과 다르다 — 한 표에 섞으면 조회하는 쪽이 매번 유형을 봐야 한다.';
