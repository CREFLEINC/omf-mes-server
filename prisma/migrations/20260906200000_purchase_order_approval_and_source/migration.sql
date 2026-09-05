-- I-2 선행 커밋 · A1·A2·M-b (plan.md §4)
--
-- ── A1. 승인 요청 역참조 ────────────────────────────────────────────────────
-- 계약 `PurchaseOrder.approvalRequestId` 가 `x-source-column` 없이 서 있다(실측) —
-- 「승인 요청 식별자. 승인 진행 상태를 읽는 경로는 별도 계약에서 온다」. 응답 필수 칸은
-- 아니지만 화면(W-01-11 §5-6)이 「등록 → 승인 요청 → 승인 완료」를 한 줄로 보이므로
-- 이 칸이 없으면 상세를 두 번 부른다.
--
-- ⛔ 이 FK 는 «업무 승인 하나»만 담는다(plan.md §5 #12 · I-1 R-3) — P/O 의 취소 승인은
--    애초에 없다(§5-2). 승인 «판정»은 언제나 다형 축(target_type_code, target_id,
--    approval_type_code)으로 조회한다. 이 칸은 표시용 역참조다.
-- FK 제약 이름을 적지 않는다 — PostgreSQL 이 짓는 `purchase_order_approval_request_id_fkey`
-- 가 Prisma 기본형이다. `fk_*` 로 지으면 `migrate diff` 가 드리프트를 낸다(선례:
-- data_model_v4 의 `goods_issue.approval_request_id` 도 인라인 REFERENCES 다).
ALTER TABLE logistics.purchase_order
    ADD COLUMN approval_request_id bigint REFERENCES app.approval_request(approval_request_id);

COMMENT ON COLUMN logistics.purchase_order.approval_request_id IS
    '이 P/O 의 업무 승인 요청. 취소·특수 승인은 여기 담지 않는다(공유계약 A-10 다형 축이 정본). 근거: 계약 PurchaseOrder.approvalRequestId.';

-- ── A2. 초과 입하 분리에서 승계된 입하 라인 ─────────────────────────────────
-- 계약 `PurchaseOrderCreate.sourceInboundReceiptLineId` — 「초과 입하 분리에서 넘어온
-- 경우 승계된 입하 라인. 근거: W-01-03 §5-1」. 응답에는 없다(받기만 한다).
--
-- ⚠ 받아서 버릴 수도 있었다(선례: businessDate 미저장 · 대기 15). 저장을 고른 것은
--    W-01-03 이 「초과분 입하를 이 P/O 에 귀속」시키는 «되짚기»의 유일한 흔적이어서다 —
--    귀속은 inbound_receipt_line.purchase_order_line_id 가 지지만 그것은 «어느 라인에»
--    붙었는지만 말하고 「이 P/O 가 어느 초과분 때문에 생겼는가」는 어디에도 안 남는다.
ALTER TABLE logistics.purchase_order
    ADD COLUMN source_inbound_receipt_line_id bigint
        REFERENCES logistics.inbound_receipt_line(inbound_receipt_line_id);

COMMENT ON COLUMN logistics.purchase_order.source_inbound_receipt_line_id IS
    '초과 입하 분리(W-01-03)에서 승계된 입하 라인. 일반 발주는 비어 있다. 근거: 계약 PurchaseOrderCreate.sourceInboundReceiptLineId.';

-- ── M-b. ERP 발주번호 유일 (§I-48) ──────────────────────────────────────────
-- 계약 `erpPurchaseOrderNo` x-internal-note 원문: 「⚠ 유일 제약이 없다(실측) — 같은 ERP
-- 번호를 두 MES P/O가 가질 수 있다. 의도인지 누락인지 미확정 — 화면은 중복을 경고할 수
-- 있으나 «강제는 서버·DB 몫»이다. 근거: W-01-11 §6·§8-3 · omf-mes#75」
--
-- 부분 유일로 둔다 — PostgreSQL 은 UNIQUE 에서 NULL 을 서로 다르게 보므로 맨 UNIQUE 와
-- 결과는 같지만, WHERE 절이 「비어 있는 것은 세지 않는다」는 의도를 구조로 말한다.
-- ⚠ 지금 이 칸을 채우는 오퍼레이션이 계약에 «0건»이다(§7-3) — 다만 `계약-되돌림-mdm.md`
--    §X-1 이 「확정된 수신 대상은 품목·자재명세·조직·작업자·**구매발주** 다섯」을 인용하고
--    서버가 `PURCHASE_ORDER` 문자열을 이미 골라 두었다 ⇒ 「올 수도 있는 경로」가 아니라
--    «확정된 수신 대상»이다(재수립 R-9). 인덱스는
--    당분간 빈 집합 위에 선다. 그래도 지금 거는 것은, 02 P/O 수신 I/F 가 붙는 순간
--    중복이 «데이터로» 들어오면 되돌리는 비용이 인덱스보다 크기 때문이다.
CREATE UNIQUE INDEX uq_purchase_order_erp_no
    ON logistics.purchase_order (erp_purchase_order_no)
    WHERE erp_purchase_order_no IS NOT NULL;
