# I-27 계획 DB 사전 관측 — root 실측

2026-09-07 12:17 UTC 실행, 완료 직후 clock 12:17:59 UTC, root 직접 실행. B lease를 구현자에게 반환받은 뒤 READ ONLY로 수행했다. 마이그/업무 쓰기/seed0. `.backend-dev/lane-b/I-27-draft.md` §11의 P1~P4만 실행, 신규 칼럼이 필요한 P5는 미실행. 개발 DB 결과이며 운영 인수로 확대하지 않는다. exit 0, tool wall 0.000003209s(PTY 반환 측정값이며 DB 서버 실행시간을 따로 측정한 값 아님).

실제 명령: `docker exec -i omf-mes-lane-b-postgres psql -X -v ON_ERROR_STOP=1 -U omf_lane_b -d omf_mes_lane_b < /private/tmp/i27-plan-pre.sql`

```text
BEGIN
 current_user | timezone
--------------+----------
 omf_lane_b   | UTC
(1 row)

 applied_migrations
--------------------
                 56
(1 row)

 current_database
------------------
 omf_mes_lane_b
(1 row)

 table_schema |     table_name     |      column_name      |        data_type         | is_nullable |  column_default
--------------+--------------------+-----------------------+--------------------------+-------------+-------------------
 app          | document_issue_log | document_issue_log_id | bigint                   | NO          |
 app          | document_issue_log | document_type_code    | character varying        | NO          |
 app          | document_issue_log | target_type_code      | character varying        | NO          |
 app          | document_issue_log | target_id             | bigint                   | NO          |
 app          | document_issue_log | lot_id                | bigint                   | YES         |
 app          | document_issue_log | issue_seq             | integer                  | NO          | 1
 app          | document_issue_log | reissue_reason_code   | character varying        | YES         |
 app          | document_issue_log | issued_by             | bigint                   | NO          |
 app          | document_issue_log | issued_at             | timestamp with time zone | NO          | clock_timestamp()
 app          | document_issue_log | terminal_id           | bigint                   | YES         |
 app          | document_issue_log | printer_name          | character varying        | YES         |
 app          | document_issue_log | remarks               | text                     | YES         |
 app          | printer            | printer_id            | bigint                   | NO          |
 app          | printer            | plant_id              | bigint                   | NO          |
 app          | printer            | printer_code          | character varying        | NO          |
 app          | printer            | printer_name          | character varying        | NO          |
 app          | printer            | printer_type_code     | character varying        | NO          |
 app          | printer            | connection_uri        | text                     | NO          |
 app          | printer            | dpi                   | integer                  | YES         |
 app          | printer            | is_active             | boolean                  | NO          | true
 app          | printer            | created_at            | timestamp with time zone | NO          | clock_timestamp()
 app          | printer            | created_by            | bigint                   | YES         |
 app          | printer            | updated_at            | timestamp with time zone | NO          | clock_timestamp()
 app          | printer            | updated_by            | bigint                   | YES         |
 app          | printer            | version_no            | integer                  | NO          | 1
 mdm          | terminal           | terminal_id           | bigint                   | NO          |
 mdm          | terminal           | terminal_code         | character varying        | NO          |
 mdm          | terminal           | plant_id              | bigint                   | NO          |
 mdm          | terminal           | location_id           | bigint                   | YES         |
 mdm          | terminal           | terminal_type_code    | character varying        | NO          |
 mdm          | terminal           | status_code           | character varying        | NO          |
 mdm          | terminal           | is_active             | boolean                  | NO          | true
 mdm          | terminal           | created_at            | timestamp with time zone | NO          | clock_timestamp()
 mdm          | terminal           | created_by            | bigint                   | YES         |
 mdm          | terminal           | updated_at            | timestamp with time zone | NO          | clock_timestamp()
 mdm          | terminal           | updated_by            | bigint                   | YES         |
 mdm          | terminal           | version_no            | integer                  | NO          | 1
 mdm          | terminal           | token_version         | integer                  | NO          | 1
 mdm          | terminal           | equipment_id          | bigint                   | YES         |
 mdm          | terminal           | token_issued_at       | timestamp with time zone | YES         |
(40 rows)

       table_name       |               conname               |                        pg_get_constraintdef
------------------------+-------------------------------------+---------------------------------------------------------------------
 app.document_issue_log | ck_document_reissue_reason          | CHECK (((issue_seq = 1) OR (reissue_reason_code IS NOT NULL)))
 app.document_issue_log | document_issue_log_issue_seq_check  | CHECK ((issue_seq > 0))
 app.document_issue_log | document_issue_log_issued_by_fkey   | FOREIGN KEY (issued_by) REFERENCES app.app_user(app_user_id)
 app.document_issue_log | document_issue_log_lot_id_fkey      | FOREIGN KEY (lot_id) REFERENCES trace.lot(lot_id)
 app.document_issue_log | document_issue_log_pkey             | PRIMARY KEY (document_issue_log_id)
 app.document_issue_log | document_issue_log_terminal_id_fkey | FOREIGN KEY (terminal_id) REFERENCES mdm.terminal(terminal_id)
 app.document_issue_log | uq_document_issue_log               | UNIQUE (document_type_code, target_type_code, target_id, issue_seq)
 app.printer            | printer_dpi_check                   | CHECK (((dpi IS NULL) OR (dpi > 0)))
 app.printer            | printer_pkey                        | PRIMARY KEY (printer_id)
 app.printer            | printer_plant_id_fkey               | FOREIGN KEY (plant_id) REFERENCES mdm.plant(plant_id)
 app.printer            | printer_version_no_check            | CHECK ((version_no > 0))
 app.printer            | uq_printer                          | UNIQUE (plant_id, printer_code)
(12 rows)

 schemaname |     tablename      |        indexname         |                                                                   indexdef
------------+--------------------+--------------------------+----------------------------------------------------------------------------------------------------------------------------------------------
 app        | document_issue_log | document_issue_log_pkey  | CREATE UNIQUE INDEX document_issue_log_pkey ON app.document_issue_log USING btree (document_issue_log_id)
 app        | document_issue_log | uq_document_issue_log    | CREATE UNIQUE INDEX uq_document_issue_log ON app.document_issue_log USING btree (document_type_code, target_type_code, target_id, issue_seq)
 app        | document_issue_log | ix_document_issue_lot    | CREATE INDEX ix_document_issue_lot ON app.document_issue_log USING btree (lot_id) WHERE (lot_id IS NOT NULL)
 app        | document_issue_log | ix_document_issue_target | CREATE INDEX ix_document_issue_target ON app.document_issue_log USING btree (target_type_code, target_id, issued_at DESC)
 app        | printer            | printer_pkey             | CREATE UNIQUE INDEX printer_pkey ON app.printer USING btree (printer_id)
 app        | printer            | uq_printer               | CREATE UNIQUE INDEX uq_printer ON app.printer USING btree (plant_id, printer_code)
(6 rows)

 table_schema |       table_name
--------------+------------------------
 app          | printer
 maintenance  | collection_observation
(2 rows)

 issue_rows
------------
          0
(1 row)

 document_type_code | target_type_code | count
--------------------+------------------+-------
(0 rows)

 document_issue_log_id | document_type_code | target_type_code | target_id | lot_id | issue_seq | reissue_reason_code
-----------------------+--------------------+------------------+-----------+--------+-----------+---------------------
(0 rows)

 document_issue_log_id
-----------------------
(0 rows)

 document_issue_log_id
-----------------------
(0 rows)

   group_code   | group_active | is_system_owned |        code        |      code_name       | is_active | effective_from | effective_to
----------------+--------------+-----------------+--------------------+----------------------+-----------+----------------+--------------
 JUDGMENT_TYPE  | t            | t               |                    |                      |           |                |
 LOT_STATUS     | t            | t               | NORMAL             | 정상                 | t         |                |
 LOT_STATUS     | t            | t               | INSPECTION_PENDING | 검사 대기            | t         |                |
 LOT_STATUS     | t            | t               | DEFECTIVE          | 불량                 | t         |                |
 LOT_STATUS     | t            | t               | SCRAPPED           | 폐기                 | t         |                |
 LOT_TYPE       | t            | t               | MATERIAL           | 자재                 | t         |                |
 LOT_TYPE       | t            | t               | PRODUCTION         | 생산                 | t         |                |
 LOT_TYPE       | t            | t               | PRODUCT            | 제품                 | t         |                |
 REISSUE_REASON | t            | f               | DAMAGED            | 훼손                 | t         |                |
 REISSUE_REASON | t            | f               | LOST               | 분실                 | t         |                |
 REISSUE_REASON | t            | f               | PRINT_FAILURE      | 인쇄 실패            | t         |                |
 REISSUE_REASON | t            | f               | PACKAGING          | 포장                 | t         |                |
 REISSUE_REASON | t            | f               | QUANTITY_CHANGE    | 재구성으로 수량 변경 | t         |                |
(13 rows)

 document_issue_log_id | reissue_reason_code
-----------------------+---------------------
(0 rows)

 plant_id | count
----------+-------
(0 rows)

 name_length | count
-------------+-------
(0 rows)

 worker_without_account | workers
------------------------+---------
                      0 |       0
(1 row)

 status_code | count
-------------+-------
(0 rows)

COMMIT

```
