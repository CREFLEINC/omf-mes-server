-- 송신 항목 설정을 계약 모양으로 세운다. 지금 표는 «다른 것»을 담고 있다.
--
--   물리: (연계정의, 품목, 유효기간) 단위로 「이 품목을 내보낼까」
--   계약: 「송신 «항목» 다섯(생산 실적·입고·출하·반품·실사 조정)을 내보낼까」
--
-- 축이 다르다. 그리고 품목 단위 축은 «옮겨 갔다» — 설계가 「개발품 제외의 판정 축은
-- 품목으로 닫혔다(사용자 확정 2026-08-24 · omf-mes#70 종료)」로 정하고 `Item.developmentItem`
-- 을 품목 마스터에 앉혔다. 즉 이 표의 품목 축은 «대체된 설계»의 흔적이다.
--
-- ⛔ 지우지 않는다. 「컬럼·테이블 삭제는 두 릴리스로 분리」(CLAUDE.md) — 이번에는 계약이
--    요구하는 축을 더하고 옛 축의 NOT NULL 만 푼다. 다음 릴리스에서 지울지 판단한다.
--
-- 표가 비어 있다(실측 0행).

ALTER TABLE integration.outbound_item_setting
    ADD COLUMN outbound_item_code app.code_t,
    ADD COLUMN updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN updated_by         bigint,
    ADD COLUMN version_no         integer     NOT NULL DEFAULT 1,
    ALTER COLUMN interface_definition_id DROP NOT NULL,
    ALTER COLUMN item_id                 DROP NOT NULL,
    ALTER COLUMN effective_from          DROP NOT NULL,
    ADD CONSTRAINT outbound_item_setting_version_no_check CHECK (version_no > 0);

-- 항목 하나에 줄 하나. 계약이 「고정 목록 다섯」이라 했으므로 코드가 곧 키다.
CREATE UNIQUE INDEX uq_outbound_item_setting_code
    ON integration.outbound_item_setting (outbound_item_code);

COMMENT ON COLUMN integration.outbound_item_setting.outbound_item_code IS
  '송신 항목(PRODUCTION_RESULT·GOODS_RECEIPT·SHIPMENT_PGI·RETURN·STOCK_ADJUSTMENT). 앱이 소유한 고정 다섯.';
COMMENT ON COLUMN integration.outbound_item_setting.item_id IS
  '⚠ 대체된 설계의 흔적. 「개발품 제외」의 판정 축은 품목 마스터로 옮겼다 (omf-mes#70 종료).';
COMMENT ON COLUMN integration.outbound_item_setting.effective_from IS
  '⚠ 대체된 설계의 흔적. 송신 항목 on/off 는 유효기간을 두지 않는다.';
