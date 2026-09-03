-- 연계 정의를 계약 모양으로 세운다. 지금 표는 계약이 요구하는 축을 절반쯤 갖고 있지 않다.
--
-- 계약 `InterfaceDefinition` 이 요구하는 것 중 물리에 «없는» 여섯:
--
--   target_code           무엇을 나르는가(품목·자재명세·조직·작업자·구매발주 …)
--   external_system_code  어느 외부 시스템인가(UNIERP · TRACKING_SYSTEM · EQUIPMENT_STANDARD_IF)
--   trigger_type_code     주기로 도는가 사건에 반응하는가(TIME_SCHEDULE · EVENT)
--   schedule_expression   주기·시각
--   event_condition       촉발 조건
--   relay_table_name      중계 테이블 이름
--
-- 그리고 «칸 잇기»(`columnMappings`)를 담을 표가 통째로 없다. 계약이 그것을 적어 두었다 —
-- 「물리 모델에 저장처가 없다. 계약이 화면 요구대로 먼저 선다. 데이터 모델 담당에게 낸
-- 작업 통지는 omf-mes#66 이다」.
--
-- ⛔ 거꾸로 물리에만 있고 계약에 없는 둘(`transport_code`·`retry_policy`)은 NOT NULL 이라
--    계약대로 등록하면 «저장 자체가 안 된다». 서버가 채울 근거가 없으므로(계약에 그 축이
--    없다) NOT NULL 을 푼다 — 값을 지어내는 것보다 비워 두는 것이 정직하다.
--
-- 표가 비어 있어(실측 0행) 새 NOT NULL 을 그대로 세울 수 있다.

ALTER TABLE integration.interface_definition
    ADD COLUMN target_code          app.code_t   NOT NULL,
    ADD COLUMN external_system_code app.code_t   NOT NULL,
    ADD COLUMN trigger_type_code    app.code_t   NOT NULL,
    ADD COLUMN schedule_expression  text,
    ADD COLUMN event_condition      text,
    ADD COLUMN relay_table_name     varchar(200),
    ALTER COLUMN transport_code DROP NOT NULL,
    ALTER COLUMN retry_policy   DROP NOT NULL;

COMMENT ON COLUMN integration.interface_definition.target_code IS
  '연계 대상. 확정 다섯(품목·자재명세·조직·작업자·구매발주) 밖의 값도 받는다 — 막지 않고 표식만 한다.';
COMMENT ON COLUMN integration.interface_definition.external_system_code IS
  '외부 시스템(UNIERP · TRACKING_SYSTEM · EQUIPMENT_STANDARD_IF). 성격이 달라 축을 나눈다.';
COMMENT ON COLUMN integration.interface_definition.trigger_type_code IS
  '주기(TIME_SCHEDULE)인가 사건(EVENT)인가. 짝이 되는 칸이 함께 채워져야 한다 — 서버가 본다.';
COMMENT ON COLUMN integration.interface_definition.transport_code IS
  '계약에 이 축이 없다 — 서버가 채울 근거가 없어 비워 둔다 (omf-mes#66).';
COMMENT ON COLUMN integration.interface_definition.retry_policy IS
  '계약에 이 축이 없다 — 서버가 채울 근거가 없어 비워 둔다 (omf-mes#66).';

-- 칸 잇기. 중계 테이블의 칸과 이 시스템의 칸을 잇는다.
--
-- ⚠ `sequence_no` 는 계약에 «없다». 그런데 `columnMappings` 가 배열이고 통째로 교체되므로
--    화면이 보낸 순서가 되돌아와야 같은 화면이 된다 — 순서를 잃으면 저장할 때마다 줄이
--    뒤바뀐다. 노출하지 않고 정렬에만 쓴다.
CREATE TABLE integration.interface_column_mapping (
    interface_column_mapping_id bigserial PRIMARY KEY,
    interface_definition_id     bigint       NOT NULL
        REFERENCES integration.interface_definition (interface_definition_id),
    sequence_no                 integer      NOT NULL CHECK (sequence_no > 0),
    relay_column                varchar(100) NOT NULL,
    target_table                varchar(100) NOT NULL,
    target_column               varchar(100) NOT NULL,
    created_at                  timestamptz  NOT NULL DEFAULT clock_timestamp(),
    created_by                  bigint,
    CONSTRAINT uq_interface_column_mapping UNIQUE (interface_definition_id, sequence_no)
);

COMMENT ON TABLE integration.interface_column_mapping IS
  '연계 정의의 칸 잇기. 계약 InterfaceColumnMapping 의 저장처 (omf-mes#66).';
COMMENT ON COLUMN integration.interface_column_mapping.sequence_no IS
  '화면이 보낸 순서. 계약에는 없고 정렬에만 쓴다 — 순서를 잃으면 저장할 때마다 줄이 뒤바뀐다.';
