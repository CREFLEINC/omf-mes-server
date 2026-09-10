-- I-17 재생재 등록(A5). 계약 `RecycleEntryCreate.warehouseId`(required)·`remarks` 를 담을 칸이 없다.
-- ⛔ 추가·완화만이다 — 삭제 0 · 백필 0 · DEFAULT 0(`lanes.md` §1-2 — 레인 셋의 마이그가 뒤섞인 순서로 들어온다).

ALTER TABLE logistics.recycle_entry ADD COLUMN warehouse_id BIGINT;
ALTER TABLE logistics.recycle_entry ADD COLUMN remarks       TEXT;

-- FK 이름은 이 표의 나머지 FK 다섯과 같은 이름 규칙이다. ON DELETE/UPDATE 는 이 표의 나머지 FK 다섯과 같은 NO ACTION.
ALTER TABLE logistics.recycle_entry
  ADD CONSTRAINT recycle_entry_warehouse_id_fkey
  FOREIGN KEY (warehouse_id) REFERENCES mdm.warehouse(warehouse_id)
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ⭐ 원천 문서 짝을 NULL 로 푼다. 계약 `RecycleEntryCreate` 에 원천 문서 칸이 «0개»이고,
--    공유계약 A-10 이 「가리킬 문서가 없으면 «둘을 함께» 비운다 — 한쪽만 채우지 않는다」로 못 박았다
--    (`goods-receipt.service.ts:135-140` 이 그 규칙을 코드로 들고 있고 그 표의 같은 두 칸은 이미 nullable 이다).
--    NOT NULL 을 남기면 값을 «지어내야만» INSERT 가 선다(README §2 2단계 기준 4 위반).
ALTER TABLE logistics.recycle_entry ALTER COLUMN source_document_type_code DROP NOT NULL;
ALTER TABLE logistics.recycle_entry ALTER COLUMN source_document_id        DROP NOT NULL;

COMMENT ON COLUMN logistics.recycle_entry.warehouse_id IS
  '재생재를 잡는 창고. 계약 RecycleEntryCreate.warehouseId (required) 의 저장처다.';
COMMENT ON COLUMN logistics.recycle_entry.remarks IS
  '비고. 계약 RecycleEntryCreate.remarks 의 저장처다.';
COMMENT ON COLUMN logistics.recycle_entry.source_document_type_code IS
  '원천 문서 짝(A-10). 재생재 등록은 가리킬 문서가 없어 둘 다 NULL 이다 (통보 215).';
