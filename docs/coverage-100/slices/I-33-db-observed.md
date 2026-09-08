# I-33 root 읽기 전용 DB 관측

- 기록시각 2026-09-07 10:56:58 UTC, HEAD f521a89366f349ee691aca1cec0d725dca702ce4. I33 draft §2-사전 SQL을 root가 직접 읽고 실행.
- 전용 omf_mes_lane_b/UTC, RepeatableRead READ ONLY, exit0. E2E 종료/정리 후 실행. 설정/업무행/마이그 변경0, 운영DB 관측 아님.
- 최초 문서 범위 추출에 닫는 Markdown fence가 섞여 syntax error exit1(쿼리 전체 파싱 실패·실행0). fence를 제외한 동일 SQL로 재실행 exit0, 게이트 실패로 세지 않음.
- tool_usage/collection_channel/collection_observation/equipment_calibration/mold 각각0, 누락/범위초과/역전/중복/값CHECK 불일치0. 신 collection_channel_observation 없음, 기존 collection_observation 실재.
- 코드: CALIBRATION_AGENCY_TYPE system-owned INTERNAL/EXTERNAL2, HISTORY_TYPE customer-owned CALIBRATION/CHECK2, RESULT customer-owned PASS/ADJUSTED/FAIL3, 전부active·effective날짜null. 나머지 요청4그룹0. 행 존재는 고객확장 결과의 의미 분류 정의가 아님.
- 70칼럼(코드2표포함),22제약/9인덱스. 업무4표의 비내부trigger0, mdm equipment/mold updated_at트리거2. 업무44칼럼주석전부null.

```text
BEGIN
 current_database | session_timezone
------------------+------------------
 omf_mes_lane_b   | UTC
(1 row)

              relation              | rows
------------------------------------+------
 maintenance.tool_usage             |    0
 maintenance.collection_channel     |    0
 maintenance.collection_observation |    0
 quality.equipment_calibration      |    0
 mdm.mold                           |    0
(5 rows)

 missing_work_order | missing_shot_count | missing_worker | outside_api_count
--------------------+--------------------+----------------+-------------------
                  0 |                  0 |              0 |                 0
(1 row)

 usage_type_code | count
-----------------+-------
(0 rows)

 outside_api_cumulative | minimum_count | maximum_count
------------------------+---------------+---------------
                      0 |               |
(1 row)

 result_code | count
-------------+-------
(0 rows)

 absent_performer | absent_legacy_creator | reversed_dates
------------------+-----------------------+----------------
                0 |                     0 |              0
(1 row)

 channel_code | count
--------------+-------
(0 rows)

 data_type_code | count
----------------+-------
(0 rows)

 equipment_id | channel_code | count
--------------+--------------+-------
(0 rows)

 legacy_key_too_long | legacy_key_blank
---------------------+------------------
                   0 |                0
(1 row)

 invalid_value_count
---------------------
                   0
(1 row)

        group_code        |    group_name    | is_system_owned | group_active |    code     |  code_name   | value_active | effective_from | effective_to
--------------------------+------------------+-----------------+--------------+-------------+--------------+--------------+----------------+--------------
 CALIBRATION_AGENCY_TYPE  | 교정 기관 구분   | t               | t            | INTERNAL    | 내부         | t            |                |
 CALIBRATION_AGENCY_TYPE  | 교정 기관 구분   | t               | t            | EXTERNAL    | 외부         | t            |                |
 CALIBRATION_HISTORY_TYPE | 계측기 이력 유형 | f               | t            | CALIBRATION | 교정         | t            |                |
 CALIBRATION_HISTORY_TYPE | 계측기 이력 유형 | f               | t            | CHECK       | 점검         | t            |                |
 CALIBRATION_RESULT       | 검교정 결과      | f               | t            | PASS        | 적합         | t            |                |
 CALIBRATION_RESULT       | 검교정 결과      | f               | t            | ADJUSTED    | 조정 후 적합 | t            |                |
 CALIBRATION_RESULT       | 검교정 결과      | f               | t            | FAIL        | 부적합       | t            |                |
(7 rows)

        group_code
--------------------------
 CALIBRATION_AGENCY_TYPE
 CALIBRATION_HISTORY_TYPE
 CALIBRATION_RESULT
(3 rows)

 new_observation |          old_observation
-----------------+------------------------------------
                 | maintenance.collection_observation
(1 row)

 table_schema |       table_name       |        column_name        |        data_type         | is_nullable |  column_default   | character_maximum_length | numeric_precision | numeric_scale
--------------+------------------------+---------------------------+--------------------------+-------------+-------------------+--------------------------+-------------------+---------------
 maintenance  | collection_channel     | collection_channel_id     | bigint                   | NO          |                   |                          |                64 |             0
 maintenance  | collection_channel     | equipment_id              | bigint                   | NO          |                   |                          |                64 |             0
 maintenance  | collection_channel     | channel_code              | character varying        | NO          |                   |                       50 |                   |
 maintenance  | collection_channel     | channel_name              | character varying        | NO          |                   |                      200 |                   |
 maintenance  | collection_channel     | data_type_code            | character varying        | NO          |                   |                       50 |                   |
 maintenance  | collection_channel     | uom_id                    | bigint                   | YES         |                   |                          |                64 |             0
 maintenance  | collection_channel     | collection_interval_sec   | integer                  | YES         |                   |                          |                32 |             0
 maintenance  | collection_channel     | lower_limit               | numeric                  | YES         |                   |                          |                20 |             6
 maintenance  | collection_channel     | upper_limit               | numeric                  | YES         |                   |                          |                20 |             6
 maintenance  | collection_channel     | is_active                 | boolean                  | NO          | true              |                          |                   |
 maintenance  | collection_channel     | created_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 maintenance  | collection_channel     | created_by                | bigint                   | YES         |                   |                          |                64 |             0
 maintenance  | collection_channel     | updated_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 maintenance  | collection_channel     | updated_by                | bigint                   | YES         |                   |                          |                64 |             0
 maintenance  | collection_channel     | version_no                | integer                  | NO          | 1                 |                          |                32 |             0
 maintenance  | collection_observation | collection_observation_id | bigint                   | NO          |                   |                          |                64 |             0
 maintenance  | collection_observation | collection_channel_id     | bigint                   | NO          |                   |                          |                64 |             0
 maintenance  | collection_observation | observed_at               | timestamp with time zone | NO          |                   |                          |                   |
 maintenance  | collection_observation | numeric_value             | numeric                  | YES         |                   |                          |                20 |             6
 maintenance  | collection_observation | text_value                | text                     | YES         |                   |                          |                   |
 maintenance  | collection_observation | boolean_value             | boolean                  | YES         |                   |                          |                   |
 maintenance  | collection_observation | quality_code              | character varying        | YES         |                   |                       50 |                   |
 maintenance  | collection_observation | source_message_id         | character varying        | YES         |                   |                      200 |                   |
 maintenance  | collection_observation | created_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 maintenance  | tool_usage             | tool_usage_id             | bigint                   | NO          |                   |                          |                64 |             0
 maintenance  | tool_usage             | mold_id                   | bigint                   | NO          |                   |                          |                64 |             0
 maintenance  | tool_usage             | equipment_id              | bigint                   | YES         |                   |                          |                64 |             0
 maintenance  | tool_usage             | work_order_id             | bigint                   | YES         |                   |                          |                64 |             0
 maintenance  | tool_usage             | usage_type_code           | character varying        | NO          |                   |                       50 |                   |
 maintenance  | tool_usage             | shot_count                | bigint                   | YES         |                   |                          |                64 |             0
 maintenance  | tool_usage             | used_from                 | timestamp with time zone | NO          |                   |                          |                   |
 maintenance  | tool_usage             | used_to                   | timestamp with time zone | YES         |                   |                          |                   |
 maintenance  | tool_usage             | recorded_by               | bigint                   | YES         |                   |                          |                64 |             0
 maintenance  | tool_usage             | created_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 mdm          | code_group             | code_group_id             | bigint                   | NO          |                   |                          |                64 |             0
 mdm          | code_group             | group_code                | character varying        | NO          |                   |                       50 |                   |
 mdm          | code_group             | group_name                | character varying        | NO          |                   |                      200 |                   |
 mdm          | code_group             | description               | text                     | YES         |                   |                          |                   |
 mdm          | code_group             | is_active                 | boolean                  | NO          | true              |                          |                   |
 mdm          | code_group             | created_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 mdm          | code_group             | created_by                | bigint                   | YES         |                   |                          |                64 |             0
 mdm          | code_group             | updated_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 mdm          | code_group             | updated_by                | bigint                   | YES         |                   |                          |                64 |             0
 mdm          | code_group             | version_no                | integer                  | NO          | 1                 |                          |                32 |             0
 mdm          | code_group             | is_system_owned           | boolean                  | NO          | false             |                          |                   |
 mdm          | code_value             | code_value_id             | bigint                   | NO          |                   |                          |                64 |             0
 mdm          | code_value             | code_group_id             | bigint                   | NO          |                   |                          |                64 |             0
 mdm          | code_value             | code                      | character varying        | NO          |                   |                       50 |                   |
 mdm          | code_value             | code_name                 | character varying        | NO          |                   |                      200 |                   |
 mdm          | code_value             | display_order             | integer                  | NO          | 0                 |                          |                32 |             0
 mdm          | code_value             | effective_from            | date                     | YES         |                   |                          |                   |
 mdm          | code_value             | effective_to              | date                     | YES         |                   |                          |                   |
 mdm          | code_value             | is_active                 | boolean                  | NO          | true              |                          |                   |
 mdm          | code_value             | created_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 mdm          | code_value             | created_by                | bigint                   | YES         |                   |                          |                64 |             0
 mdm          | code_value             | updated_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 mdm          | code_value             | updated_by                | bigint                   | YES         |                   |                          |                64 |             0
 mdm          | code_value             | version_no                | integer                  | NO          | 1                 |                          |                32 |             0
 mdm          | code_value             | name_ko                   | character varying        | YES         |                   |                      200 |                   |
 mdm          | code_value             | name_vi                   | character varying        | YES         |                   |                      200 |                   |
 quality      | equipment_calibration  | equipment_calibration_id  | bigint                   | NO          |                   |                          |                64 |             0
 quality      | equipment_calibration  | equipment_id              | bigint                   | NO          |                   |                          |                64 |             0
 quality      | equipment_calibration  | calibration_date          | date                     | NO          |                   |                          |                   |
 quality      | equipment_calibration  | result_code               | character varying        | NO          |                   |                       50 |                   |
 quality      | equipment_calibration  | valid_until               | date                     | YES         |                   |                          |                   |
 quality      | equipment_calibration  | certificate_no            | character varying        | YES         |                   |                      100 |                   |
 quality      | equipment_calibration  | calibrated_by             | bigint                   | YES         |                   |                          |                64 |             0
 quality      | equipment_calibration  | remarks                   | text                     | YES         |                   |                          |                   |
 quality      | equipment_calibration  | created_at                | timestamp with time zone | NO          | clock_timestamp() |                          |                   |
 quality      | equipment_calibration  | created_by                | bigint                   | YES         |                   |                          |                64 |             0
(70 rows)

 schema_name |       table_name       |                      conname                      |                                              definition
-------------+------------------------+---------------------------------------------------+------------------------------------------------------------------------------------------------------
 maintenance | collection_channel     | ck_collection_channel_limits                      | CHECK (((lower_limit IS NULL) OR (upper_limit IS NULL) OR (lower_limit <= upper_limit)))
 maintenance | collection_channel     | collection_channel_collection_interval_sec_check  | CHECK (((collection_interval_sec IS NULL) OR (collection_interval_sec > 0)))
 maintenance | collection_channel     | collection_channel_equipment_id_fkey              | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 maintenance | collection_channel     | collection_channel_pkey                           | PRIMARY KEY (collection_channel_id)
 maintenance | collection_channel     | collection_channel_uom_id_fkey                    | FOREIGN KEY (uom_id) REFERENCES mdm.uom(uom_id)
 maintenance | collection_channel     | collection_channel_version_no_check               | CHECK ((version_no > 0))
 maintenance | collection_channel     | uq_collection_channel                             | UNIQUE (equipment_id, channel_code)
 maintenance | collection_observation | ck_collection_observation_value                   | CHECK ((num_nonnulls(numeric_value, text_value, boolean_value) = 1))
 maintenance | collection_observation | collection_observation_collection_channel_id_fkey | FOREIGN KEY (collection_channel_id) REFERENCES maintenance.collection_channel(collection_channel_id)
 maintenance | collection_observation | collection_observation_pkey                       | PRIMARY KEY (collection_observation_id)
 maintenance | collection_observation | uq_collection_observation                         | UNIQUE (collection_channel_id, observed_at, source_message_id)
 maintenance | tool_usage             | ck_tool_usage_window                              | CHECK (((used_to IS NULL) OR (used_to >= used_from)))
 maintenance | tool_usage             | tool_usage_equipment_id_fkey                      | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 maintenance | tool_usage             | tool_usage_mold_id_fkey                           | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 maintenance | tool_usage             | tool_usage_pkey                                   | PRIMARY KEY (tool_usage_id)
 maintenance | tool_usage             | tool_usage_recorded_by_fkey                       | FOREIGN KEY (recorded_by) REFERENCES mdm.worker(worker_id)
 maintenance | tool_usage             | tool_usage_shot_count_check                       | CHECK (((shot_count IS NULL) OR (shot_count >= 0)))
 maintenance | tool_usage             | tool_usage_work_order_id_fkey                     | FOREIGN KEY (work_order_id) REFERENCES production.work_order(work_order_id)
 quality     | equipment_calibration  | equipment_calibration_calibrated_by_fkey          | FOREIGN KEY (calibrated_by) REFERENCES app.app_user(app_user_id)
 quality     | equipment_calibration  | equipment_calibration_equipment_id_fkey           | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 quality     | equipment_calibration  | equipment_calibration_pkey                        | PRIMARY KEY (equipment_calibration_id)
 quality     | equipment_calibration  | uq_equipment_calibration                          | UNIQUE (equipment_id, calibration_date)
(22 rows)

 schemaname  |       tablename        |               indexname                |                                                                        indexdef
-------------+------------------------+----------------------------------------+---------------------------------------------------------------------------------------------------------------------------------------------------------
 maintenance | collection_channel     | collection_channel_pkey                | CREATE UNIQUE INDEX collection_channel_pkey ON maintenance.collection_channel USING btree (collection_channel_id)
 maintenance | collection_channel     | uq_collection_channel                  | CREATE UNIQUE INDEX uq_collection_channel ON maintenance.collection_channel USING btree (equipment_id, channel_code)
 maintenance | collection_observation | collection_observation_pkey            | CREATE UNIQUE INDEX collection_observation_pkey ON maintenance.collection_observation USING btree (collection_observation_id)
 maintenance | collection_observation | ix_collection_observation_channel_time | CREATE INDEX ix_collection_observation_channel_time ON maintenance.collection_observation USING btree (collection_channel_id, observed_at DESC)
 maintenance | collection_observation | uq_collection_observation              | CREATE UNIQUE INDEX uq_collection_observation ON maintenance.collection_observation USING btree (collection_channel_id, observed_at, source_message_id)
 maintenance | tool_usage             | tool_usage_pkey                        | CREATE UNIQUE INDEX tool_usage_pkey ON maintenance.tool_usage USING btree (tool_usage_id)
 quality     | equipment_calibration  | equipment_calibration_pkey             | CREATE UNIQUE INDEX equipment_calibration_pkey ON quality.equipment_calibration USING btree (equipment_calibration_id)
 quality     | equipment_calibration  | ix_equipment_calibration_history       | CREATE INDEX ix_equipment_calibration_history ON quality.equipment_calibration USING btree (equipment_id, calibration_date DESC)
 quality     | equipment_calibration  | uq_equipment_calibration               | CREATE UNIQUE INDEX uq_equipment_calibration ON quality.equipment_calibration USING btree (equipment_id, calibration_date)
(9 rows)

 nspname |  relname  |            tgname            |                                                          definition
---------+-----------+------------------------------+-------------------------------------------------------------------------------------------------------------------------------
 mdm     | equipment | trg_equipment_set_updated_at | CREATE TRIGGER trg_equipment_set_updated_at BEFORE UPDATE ON mdm.equipment FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()
 mdm     | mold      | trg_mold_set_updated_at      | CREATE TRIGGER trg_mold_set_updated_at BEFORE UPDATE ON mdm.mold FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()
(2 rows)

   nspname   |        relname         |          attname          | comment
-------------+------------------------+---------------------------+---------
 maintenance | collection_channel     | collection_channel_id     |
 maintenance | collection_channel     | equipment_id              |
 maintenance | collection_channel     | channel_code              |
 maintenance | collection_channel     | channel_name              |
 maintenance | collection_channel     | data_type_code            |
 maintenance | collection_channel     | uom_id                    |
 maintenance | collection_channel     | collection_interval_sec   |
 maintenance | collection_channel     | lower_limit               |
 maintenance | collection_channel     | upper_limit               |
 maintenance | collection_channel     | is_active                 |
 maintenance | collection_channel     | created_at                |
 maintenance | collection_channel     | created_by                |
 maintenance | collection_channel     | updated_at                |
 maintenance | collection_channel     | updated_by                |
 maintenance | collection_channel     | version_no                |
 maintenance | collection_observation | collection_observation_id |
 maintenance | collection_observation | collection_channel_id     |
 maintenance | collection_observation | observed_at               |
 maintenance | collection_observation | numeric_value             |
 maintenance | collection_observation | text_value                |
 maintenance | collection_observation | boolean_value             |
 maintenance | collection_observation | quality_code              |
 maintenance | collection_observation | source_message_id         |
 maintenance | collection_observation | created_at                |
 maintenance | tool_usage             | tool_usage_id             |
 maintenance | tool_usage             | mold_id                   |
 maintenance | tool_usage             | equipment_id              |
 maintenance | tool_usage             | work_order_id             |
 maintenance | tool_usage             | usage_type_code           |
 maintenance | tool_usage             | shot_count                |
 maintenance | tool_usage             | used_from                 |
 maintenance | tool_usage             | used_to                   |
 maintenance | tool_usage             | recorded_by               |
 maintenance | tool_usage             | created_at                |
 quality     | equipment_calibration  | equipment_calibration_id  |
 quality     | equipment_calibration  | equipment_id              |
 quality     | equipment_calibration  | calibration_date          |
 quality     | equipment_calibration  | result_code               |
 quality     | equipment_calibration  | valid_until               |
 quality     | equipment_calibration  | certificate_no            |
 quality     | equipment_calibration  | calibrated_by             |
 quality     | equipment_calibration  | remarks                   |
 quality     | equipment_calibration  | created_at                |
 quality     | equipment_calibration  | created_by                |
(44 rows)

COMMIT

```
