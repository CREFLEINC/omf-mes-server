-- I-3 선행 커밋 · A3 · V-inbound_variance · ix_inbound_variance_line (I-3.md §2-6 · R-9)
--
-- 추가 2 · 완화 1 · 삭제 0 — 두 릴리스 규칙 미해당. 백필 0(`lot_id` 는 새 칸이다).
--
-- ── A3. logistics.inbound_receipt_line.lot_id ───────────────────────────────
-- 계약 `InboundReceiptLine.lotId` 가 앵커(x-source-column) 없이 선 자리다.
-- ⛔ 「lot.source_type_code='INBOUND_RECEIPT_LINE' AND lot.source_id = <라인>」 역조회로
--    대신할 수 «없다» — 세 가지 이유가 있다.
--    ⓐ trace.lot 에 (source_type_code, source_id) 유일 제약이 없어 역조회가 여러 행을
--       돌려줄 수 있는데 계약의 lotId 는 «단수»다.
--    ⓑ GET .../lines 의 labelIssued 필터가 「그 라인의 LOT 에 발행 기록이 있는가」다.
--       칸이 있으면 관계 필터 한 줄(lot -> document_issue_log)로 접히고, 없으면
--       다형 축(source_id)을 Prisma 관계로 못 태워 원시 SQL 로 내려가야 한다.
--    ⓒ 계약이 lotId 를 type:[integer,null] 로 적었다 — required 가 아니어도 «널로
--       내려야» 하므로 칸이 필요하다(I-2 R-7 이 approval_request_id 에서 같은 판정).
-- ⛔ FK 제약 이름을 적지 않는다 — PostgreSQL 이 짓는 `inbound_receipt_line_lot_id_fkey`
--    가 Prisma 기본형이다. `fk_*` 로 지으면 `migrate diff` 가 드리프트를 낸다.
ALTER TABLE logistics.inbound_receipt_line
    ADD COLUMN lot_id bigint
        REFERENCES trace.lot(lot_id);

COMMENT ON COLUMN logistics.inbound_receipt_line.lot_id IS
    '이 라인으로 만들어진 자재 LOT. 사전부착 라인은 입하 등록과 같은 트랜잭션에서, 미부착 라인은 POST /trace/lots(P-01-01)가 채운다. 계약 InboundReceiptLine.lotId.';

-- labelIssued·「LOT 이 붙은 라인은 못 지운다」 판정이 이 축으로 돈다.
CREATE INDEX ix_inbound_line_lot
    ON logistics.inbound_receipt_line(lot_id);

-- ── V-inbound_variance. reason_code 의 NOT NULL 해제 ────────────────────────
-- 계약 InboundVarianceCreate 의 required 에 reasonCode 가 없고 설명이 「⛔ 선택이다 …
-- 현장이 사유를 모를 때 오류 기록 자체가 막히면 안 된다」이다. M-01-06 §6 도 「사유
-- 미선택 — 막지 않는다」. 도메인 `app.code_t` 에 NOT NULL 이 없어 컬럼 해제로 충분하다.
ALTER TABLE logistics.inbound_variance
    ALTER COLUMN reason_code DROP NOT NULL;

-- ── ix_inbound_variance_line (R-9) ──────────────────────────────────────────
-- GET .../variances 와 라인 삭제 가드의 자식 count 가 둘 다 이 축으로 돈다.
-- ⚠ goods_receipt_line.inbound_receipt_line_id·purchase_order.source_inbound_receipt_line_id
--    의 인덱스 부재는 이 슬라이스에서 걸지 않는다(I-2 R-6 처방 — 쓰는 오퍼레이션이 설 때).
CREATE INDEX ix_inbound_variance_line
    ON logistics.inbound_variance(inbound_receipt_line_id);
