-- logistics.stock_transfer 에 사유·비고 두 칸.
--
-- 요청: 계약 f736739 의 POST /logistics/stock-reinstatements
-- 계약: shipment-04제품출하.json 의 StockReinstatementCreate
--
-- 재고 재등록이 이동 문서를 만들어 쓰는데, 계약이 받는 reasonCode·remarks 를 담을
-- 자리가 없었다. 표 16칸에 둘 다 없다.
--
-- reason_code 를 코드 축으로 두는 근거가 계약에 있다 — 「재등록이 몇 건인가」를 세려면
-- 자유 텍스트가 아니라 코드 축이어야 한다(공유계약 §I-41 · omf-mes#84). 불량 반출·
-- 분실 사유가 같은 계열이고, 20260901090000 이 예비품 출고 라인을 세울 때 본 것과
-- 같은 판단이다.
--
-- ⚠ 이 컬럼이 어느 코드 그룹을 참조하는지는 아직 정해지지 않았다. 계약이 이 자리에는
--   codeGroupCode 를 지정하지 않았고(다른 자리에는 지정한다) omf-mes#84 만 가리킨다.
--   컬럼은 app.code_t 라 그룹과 무관하게 선다 — trace.lot_hold.release_reason_code 를
--   만들 때와 같은 순서다. 그룹이 정해지면 시드만 더한다.
--
-- 둘 다 nullable 이다. 계약이 required 에 두지 않았고, 창고 간 이동처럼 사유가 없는
-- 이동이 이 표의 본래 쓰임이다 — 재등록만 사유를 싣는다.

ALTER TABLE logistics.stock_transfer
    ADD COLUMN reason_code app.code_t,
    ADD COLUMN remarks text;

COMMENT ON COLUMN logistics.stock_transfer.reason_code IS
    '이동 사유. 재고 재등록이 싣는다 — 「재등록이 몇 건인가」를 세려면 자유 텍스트가 아니라 코드 축이어야 한다(공유계약 §I-41). 창고 간 이동처럼 사유가 없는 이동도 있어 비어 있을 수 있다. ⚠ 참조할 코드 그룹은 아직 미정이다(omf-mes#84).';

COMMENT ON COLUMN logistics.stock_transfer.remarks IS
    '부가 비고. 사유는 reason_code 가 정본이다 — 계약이 그렇게 갈랐다.';
