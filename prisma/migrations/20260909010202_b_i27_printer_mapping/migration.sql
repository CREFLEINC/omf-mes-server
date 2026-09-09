-- 프린터 관측 producer가 없는 기존 행은 NULL을 유지한다. 조회는 이를 OFFLINE으로 표시한다.
ALTER TABLE app.printer
  ADD COLUMN status_code varchar(40),
  ADD COLUMN status_message varchar(200),
  ADD CONSTRAINT ck_printer_status
    CHECK (status_code IS NULL OR status_code IN ('READY','BUSY','OFFLINE','ERROR'));

-- 단말 사용 가능 범위·기본 프린터·지원 문서는 명시 매핑만 신뢰한다.
-- 같은 공장, 첫 행, printer_type_code에서 값을 추정하지 않는다.
CREATE TABLE app.terminal_printer (
  terminal_printer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  terminal_id bigint NOT NULL REFERENCES mdm.terminal(terminal_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  printer_id bigint NOT NULL REFERENCES app.printer(printer_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  is_default boolean NOT NULL DEFAULT false,
  supported_document_type_codes varchar(40)[] NOT NULL DEFAULT '{}',
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  created_by bigint,
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_by bigint,
  version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  CONSTRAINT uq_terminal_printer UNIQUE (terminal_id, printer_id),
  CONSTRAINT ck_terminal_printer_document_types CHECK (
    supported_document_type_codes <@ ARRAY[
      'MATERIAL_LOT_LABEL','GOODS_ISSUE_QR','PRODUCTION_LOT_LABEL',
      'IDENTIFICATION_TAG','PACKING_LABEL','DELIVERY_LABEL',
      'CERTIFICATE_OF_ANALYSIS','TOOL_LABEL','LOCATION_LABEL'
    ]::varchar(40)[]
  )
);

CREATE INDEX ix_terminal_printer_printer
  ON app.terminal_printer(printer_id);
CREATE UNIQUE INDEX uq_terminal_printer_default
  ON app.terminal_printer(terminal_id) WHERE is_default;

COMMENT ON COLUMN app.printer.status_code IS
  '프린터 상태 관측값. NULL은 관측 producer가 없음을 뜻하며 API는 OFFLINE으로 표시한다.';
COMMENT ON COLUMN app.printer.status_message IS
  '상태 관측 producer가 저장한 사용자용 설명. 서버가 상태 코드로 조립하지 않는다.';
COMMENT ON TABLE app.terminal_printer IS
  '단말별 사용 가능 프린터와 기본·지원 문서 종류의 명시 설정.';
