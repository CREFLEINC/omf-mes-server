# I-31 root 읽기 전용 DB 관측

- 기록 시각: 2026-09-07 10:54:30 UTC. HEAD f521a89366f349ee691aca1cec0d725dca702ce4, I30 미커밋 후보와 별개.
- I31 draft §3-5 Q1~Q8을 root가 직접 읽고 전용 컨테이너 psql의 BEGIN READ ONLY/COMMIT 안에서 실행, exit0.
- E2E lease 반납·fixture9종0 확인 뒤 실행. source·DB 업무행/설정·마이그 변경0. 운영DB 관측 아님.
- 4표44칼럼/25제약, 비내부trigger0, order/result/item/trigger0행. 결과line코드그룹은 active/customer-owned이나값0,나머지상태/trigger9값실재. mold0/plant Asia/Ho_Chi_Minh1. 대상3종번호규칙0, spare출고0·복수UOM0, 직접고장연결0·다중source0. 참조FK73행. 아래 실제 출력 참조.

```text
BEGIN
 current_database | current_user | current_setting | current_setting
------------------+--------------+-----------------+-----------------
 omf_mes_lane_b   | omf_lane_b   | 16.14           | UTC
(1 row)

                         migration_name                          |          finished_at          | rolled_back_at
-----------------------------------------------------------------+-------------------------------+----------------
 20260907174412_inspection_request_plan_and_result_draft_relax   | 2026-09-07 09:35:09.29475+00  |
 20260908090000_production_plan_split                            | 2026-09-07 07:01:07.990117+00 |
 20260907800000_work_session_shift_nullable                      | 2026-09-07 07:01:07.983668+00 |
 20260907700000_material_consumption_terminal_and_return_quality | 2026-09-07 07:01:07.980717+00 |
 20260906600000_production_result_shift_and_correct_reason       | 2026-09-07 07:01:07.978465+00 |
 20260906500000_work_order_resource_plan_unique                  | 2026-09-07 07:01:07.968653+00 |
 20260906400000_document_cancellation_reason_nullable            | 2026-09-07 07:01:07.966006+00 |
 20260906300000_inbound_receipt_lot_and_variance_reason          | 2026-09-07 07:01:07.963928+00 |
 20260906200000_purchase_order_approval_and_source               | 2026-09-07 07:01:07.959547+00 |
 20260906100000_approval_route_active_unique                     | 2026-09-07 07:01:07.955692+00 |
 20260904160000_mold_pm_and_maintenance_target                   | 2026-09-07 07:01:07.951728+00 |
 20260904150000_integration_message_status_done                  | 2026-09-07 07:01:07.94728+00  |
(12 rows)

 table_schema |        table_name         |         column_name          |        data_type         | is_nullable |  column_default
--------------+---------------------------+------------------------------+--------------------------+-------------+-------------------
 maintenance  | maintenance_order         | maintenance_order_id         | bigint                   | NO          |
 maintenance  | maintenance_order         | maintenance_order_no         | character varying        | NO          |
 maintenance  | maintenance_order         | equipment_id                 | bigint                   | YES         |
 maintenance  | maintenance_order         | breakdown_id                 | bigint                   | YES         |
 maintenance  | maintenance_order         | order_type_code              | character varying        | NO          |
 maintenance  | maintenance_order         | priority_code                | character varying        | NO          |
 maintenance  | maintenance_order         | scheduled_start_at           | timestamp with time zone | YES         |
 maintenance  | maintenance_order         | scheduled_end_at             | timestamp with time zone | YES         |
 maintenance  | maintenance_order         | assigned_worker_id           | bigint                   | YES         |
 maintenance  | maintenance_order         | status_code                  | character varying        | NO          |
 maintenance  | maintenance_order         | cancellation_reason_code     | character varying        | YES         |
 maintenance  | maintenance_order         | created_at                   | timestamp with time zone | NO          | clock_timestamp()
 maintenance  | maintenance_order         | created_by                   | bigint                   | YES         |
 maintenance  | maintenance_order         | updated_at                   | timestamp with time zone | NO          | clock_timestamp()
 maintenance  | maintenance_order         | updated_by                   | bigint                   | YES         |
 maintenance  | maintenance_order         | version_no                   | integer                  | NO          | 1
 maintenance  | maintenance_order         | target_type_code             | character varying        | NO          |
 maintenance  | maintenance_order         | mold_id                      | bigint                   | YES         |
 maintenance  | maintenance_order_item    | maintenance_order_item_id    | bigint                   | NO          |
 maintenance  | maintenance_order_item    | maintenance_order_id         | bigint                   | NO          |
 maintenance  | maintenance_order_item    | sequence_no                  | integer                  | NO          |
 maintenance  | maintenance_order_item    | inspection_item_id           | bigint                   | YES         |
 maintenance  | maintenance_order_item    | item_name                    | character varying        | YES         |
 maintenance  | maintenance_order_item    | status_code                  | character varying        | NO          |
 maintenance  | maintenance_order_trigger | maintenance_order_trigger_id | bigint                   | NO          |
 maintenance  | maintenance_order_trigger | maintenance_order_id         | bigint                   | NO          |
 maintenance  | maintenance_order_trigger | trigger_type_code            | character varying        | NO          |
 maintenance  | maintenance_order_trigger | source_id                    | bigint                   | YES         |
 maintenance  | maintenance_order_trigger | snapshot_note                | text                     | YES         |
 maintenance  | maintenance_order_trigger | pm_due_axis_code             | character varying        | YES         |
 maintenance  | maintenance_order_trigger | shot_count_at_due            | integer                  | YES         |
 maintenance  | maintenance_order_trigger | guaranteed_shot_count_at_due | integer                  | YES         |
 maintenance  | maintenance_order_trigger | created_at                   | timestamp with time zone | NO          | clock_timestamp()
 maintenance  | maintenance_result        | maintenance_result_id        | bigint                   | NO          |
 maintenance  | maintenance_result        | maintenance_order_id         | bigint                   | NO          |
 maintenance  | maintenance_result        | result_seq                   | integer                  | NO          |
 maintenance  | maintenance_result        | action_code                  | character varying        | NO          |
 maintenance  | maintenance_result        | action_description           | text                     | NO          |
 maintenance  | maintenance_result        | started_at                   | timestamp with time zone | NO          |
 maintenance  | maintenance_result        | completed_at                 | timestamp with time zone | NO          |
 maintenance  | maintenance_result        | performed_by                 | bigint                   | YES         |
 maintenance  | maintenance_result        | result_code                  | character varying        | NO          |
 maintenance  | maintenance_result        | created_at                   | timestamp with time zone | NO          | clock_timestamp()
 maintenance  | maintenance_result        | created_by                   | bigint                   | YES         |
(44 rows)

                 owner                 |                       conname                       | contype |                                                                                                     definition
---------------------------------------+-----------------------------------------------------+---------+---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 maintenance.maintenance_order         | ck_maintenance_order_target                         | c       | CHECK (((((target_type_code)::text = 'EQUIPMENT'::text) AND (equipment_id IS NOT NULL) AND (mold_id IS NULL)) OR (((target_type_code)::text = 'MOLD'::text) AND (mold_id IS NOT NULL) AND (equipment_id IS NULL))))
 maintenance.maintenance_order         | ck_maintenance_order_window                         | c       | CHECK (((scheduled_end_at IS NULL) OR (scheduled_start_at IS NULL) OR (scheduled_end_at >= scheduled_start_at)))
 maintenance.maintenance_order         | maintenance_order_assigned_worker_id_fkey           | f       | FOREIGN KEY (assigned_worker_id) REFERENCES mdm.worker(worker_id)
 maintenance.maintenance_order         | maintenance_order_breakdown_id_fkey                 | f       | FOREIGN KEY (breakdown_id) REFERENCES maintenance.breakdown(breakdown_id)
 maintenance.maintenance_order         | maintenance_order_equipment_id_fkey                 | f       | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 maintenance.maintenance_order         | maintenance_order_maintenance_order_no_key          | u       | UNIQUE (maintenance_order_no)
 maintenance.maintenance_order         | maintenance_order_mold_id_fkey                      | f       | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 maintenance.maintenance_order         | maintenance_order_pkey                              | p       | PRIMARY KEY (maintenance_order_id)
 maintenance.maintenance_order         | maintenance_order_version_no_check                  | c       | CHECK ((version_no > 0))
 maintenance.maintenance_order_item    | ck_maintenance_order_item_seq                       | c       | CHECK ((sequence_no > 0))
 maintenance.maintenance_order_item    | ck_maintenance_order_item_target                    | c       | CHECK (((inspection_item_id IS NOT NULL) OR (item_name IS NOT NULL)))
 maintenance.maintenance_order_item    | maintenance_order_item_inspection_item_id_fkey      | f       | FOREIGN KEY (inspection_item_id) REFERENCES mdm.equipment_inspection_item(equipment_inspection_item_id)
 maintenance.maintenance_order_item    | maintenance_order_item_maintenance_order_id_fkey    | f       | FOREIGN KEY (maintenance_order_id) REFERENCES maintenance.maintenance_order(maintenance_order_id)
 maintenance.maintenance_order_item    | maintenance_order_item_pkey                         | p       | PRIMARY KEY (maintenance_order_item_id)
 maintenance.maintenance_order_item    | uq_maintenance_order_item_seq                       | u       | UNIQUE (maintenance_order_id, sequence_no)
 maintenance.maintenance_order_trigger | ck_maintenance_order_trigger_shots                  | c       | CHECK ((((shot_count_at_due IS NULL) OR (shot_count_at_due >= 0)) AND ((guaranteed_shot_count_at_due IS NULL) OR (guaranteed_shot_count_at_due >= 0))))
 maintenance.maintenance_order_trigger | maintenance_order_trigger_maintenance_order_id_fkey | f       | FOREIGN KEY (maintenance_order_id) REFERENCES maintenance.maintenance_order(maintenance_order_id)
 maintenance.maintenance_order_trigger | maintenance_order_trigger_pkey                      | p       | PRIMARY KEY (maintenance_order_trigger_id)
 maintenance.maintenance_order_trigger | uq_maintenance_order_trigger                        | u       | UNIQUE (maintenance_order_id)
 maintenance.maintenance_result        | ck_maintenance_result_window                        | c       | CHECK ((completed_at >= started_at))
 maintenance.maintenance_result        | maintenance_result_maintenance_order_id_fkey        | f       | FOREIGN KEY (maintenance_order_id) REFERENCES maintenance.maintenance_order(maintenance_order_id)
 maintenance.maintenance_result        | maintenance_result_performed_by_fkey                | f       | FOREIGN KEY (performed_by) REFERENCES mdm.worker(worker_id)
 maintenance.maintenance_result        | maintenance_result_pkey                             | p       | PRIMARY KEY (maintenance_result_id)
 maintenance.maintenance_result        | maintenance_result_result_seq_check                 | c       | CHECK ((result_seq > 0))
 maintenance.maintenance_result        | uq_maintenance_result                               | u       | UNIQUE (maintenance_order_id, result_seq)
(25 rows)

 owner | tgname | definition
-------+--------+------------
(0 rows)

 target_type_code | order_type_code | status_code | count
------------------+-----------------+-------------+-------
(0 rows)

 result_rows | worker_performer_rows | reversed_rows
-------------+-----------------------+---------------
           0 |                     0 |             0
(1 row)

 trigger_type_code | rows | source_null_rows | max_shot | max_guaranteed
-------------------+------+------------------+----------+----------------
(0 rows)

 item_rows | name_null_rows | master_null_rows
-----------+----------------+------------------
         0 |              0 |                0
(1 row)

           group_code           | group_active | is_system_owned |     code      |  code_name  | is_active | effective_from | effective_to
--------------------------------+--------------+-----------------+---------------+-------------+-----------+----------------+--------------
 MAINTENANCE_ORDER_ITEM_STATUS  | t            | t               | PLANNED       | 계획        | t         |                |
 MAINTENANCE_ORDER_ITEM_STATUS  | t            | t               | DONE          | 완료        | t         |                |
 MAINTENANCE_ORDER_ITEM_STATUS  | t            | t               | NA            | 해당 없음   | t         |                |
 MAINTENANCE_ORDER_STATUS       | t            | t               | ISSUED        | 발행        | t         |                |
 MAINTENANCE_ORDER_STATUS       | t            | t               | DONE          | 완료        | t         |                |
 MAINTENANCE_ORDER_STATUS       | t            | t               | CANCELLED     | 취소        | t         |                |
 MAINTENANCE_ORDER_TRIGGER_TYPE | t            | t               | BREAKDOWN     | 고장        | t         |                |
 MAINTENANCE_ORDER_TRIGGER_TYPE | t            | t               | INSPECTION_NG | 점검 불합격 | t         |                |
 MAINTENANCE_ORDER_TRIGGER_TYPE | t            | t               | PM_DUE        | 주기 도래   | t         |                |
 MAINTENANCE_RESULT_LINE_RESULT | t            | f               |               |             |           |                |
(10 rows)

 timezone_code | pm_trigger_type_code | pm_cycle_unit_code | molds | missing_base | missing_guaranteed | unsafe_number
---------------+----------------------+--------------------+-------+--------------+--------------------+---------------
(0 rows)

  timezone_code   | count
------------------+-------
 Asia/Ho_Chi_Minh |     1
(1 row)

 document_type_code | plant_id | pattern | reset_cycle_code | is_active
--------------------+----------+---------+------------------+-----------
(0 rows)

     target     |                  referrer                   |                          conname                          |                                 pg_get_constraintdef
----------------+---------------------------------------------+-----------------------------------------------------------+--------------------------------------------------------------------------------------
 app.app_user   | app.approval_request                        | approval_request_decided_by_fkey                          | FOREIGN KEY (decided_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.approval_request                        | approval_request_requested_by_fkey                        | FOREIGN KEY (requested_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.approval_route_step                     | approval_route_step_approver_user_id_fkey                 | FOREIGN KEY (approver_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.approval_step                           | approval_step_approver_id_fkey                            | FOREIGN KEY (approver_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.attachment                              | attachment_uploaded_by_fkey                               | FOREIGN KEY (uploaded_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.document_cancellation                   | document_cancellation_cancelled_by_fkey                   | FOREIGN KEY (cancelled_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.document_issue_log                      | document_issue_log_issued_by_fkey                         | FOREIGN KEY (issued_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.exception_case                          | exception_case_assigned_user_id_fkey                      | FOREIGN KEY (assigned_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.idempotency_record                      | idempotency_record_app_user_id_fkey                       | FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.notice                                  | notice_closed_by_fkey                                     | FOREIGN KEY (closed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.notice                                  | notice_published_by_fkey                                  | FOREIGN KEY (published_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.notice_acknowledgement                  | notice_acknowledgement_app_user_id_fkey                   | FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.notification                            | notification_recipient_user_id_fkey                       | FOREIGN KEY (recipient_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.notification_subscription               | notification_subscription_app_user_id_fkey                | FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.user_credential                         | user_credential_app_user_id_fkey                          | FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id) ON DELETE CASCADE
 app.app_user   | app.user_data_scope                         | user_data_scope_app_user_id_fkey                          | FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.user_role                               | user_role_app_user_id_fkey                                | FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | app.worker_lease                            | worker_lease_owner_user_id_fkey                           | FOREIGN KEY (owner_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | inventory.handling_unit_reconfiguration     | handling_unit_reconfiguration_performed_by_fkey           | FOREIGN KEY (performed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | inventory.inventory_count_line              | fk_inventory_count_line_counted_by                        | FOREIGN KEY (counted_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.goods_issue                       | goods_issue_cancelled_by_fkey                             | FOREIGN KEY (cancelled_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.goods_issue_spare_line            | goods_issue_spare_line_created_by_fkey                    | FOREIGN KEY (created_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.inbound_receipt                   | fk_inbound_receipt_received_by                            | FOREIGN KEY (received_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.material_issue_request            | material_issue_request_requested_by_fkey                  | FOREIGN KEY (requested_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.shipment                          | shipment_cancelled_by_fkey                                | FOREIGN KEY (cancelled_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.shipment                          | shipment_confirmed_by_fkey                                | FOREIGN KEY (confirmed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.shopfloor_receipt                 | fk_shopfloor_receipt_received_by                          | FOREIGN KEY (received_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | logistics.subcontract_reconciliation        | subcontract_reconciliation_confirmed_by_fkey              | FOREIGN KEY (confirmed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | maintenance.breakdown                       | breakdown_reported_by_fkey                                | FOREIGN KEY (reported_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | maintenance.equipment_downtime              | equipment_downtime_closed_by_fkey                         | FOREIGN KEY (closed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | mdm.worker                                  | worker_app_user_id_fkey                                   | FOREIGN KEY (app_user_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | planning.production_plan                    | fk_production_plan_confirmed_by                           | FOREIGN KEY (confirmed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | production.precheck_decision                | precheck_decision_created_by_fkey                         | FOREIGN KEY (created_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | production.production_order_acknowledgement | production_order_acknowledgement_acknowledged_by_fkey     | FOREIGN KEY (acknowledged_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | production.repair_execution                 | repair_execution_created_by_fkey                          | FOREIGN KEY (created_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | production.work_session_event               | fk_work_session_event_performed_by                        | FOREIGN KEY (performed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | quality.disposition_decision                | disposition_decision_decided_by_fkey                      | FOREIGN KEY (decided_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | quality.equipment_calibration               | equipment_calibration_calibrated_by_fkey                  | FOREIGN KEY (calibrated_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | quality.inspection_plan                     | inspection_plan_approved_by_fkey                          | FOREIGN KEY (approved_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | quality.nonconformance                      | nonconformance_action_owner_id_fkey                       | FOREIGN KEY (action_owner_id) REFERENCES app.app_user(app_user_id)
 app.app_user   | trace.impact_analysis                       | impact_analysis_analyzed_by_fkey                          | FOREIGN KEY (analyzed_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | trace.lot_hold                              | lot_hold_held_by_fkey                                     | FOREIGN KEY (held_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | trace.lot_hold                              | lot_hold_released_by_fkey                                 | FOREIGN KEY (released_by) REFERENCES app.app_user(app_user_id)
 app.app_user   | trace.lot_status_event                      | lot_status_event_changed_by_fkey                          | FOREIGN KEY (changed_by) REFERENCES app.app_user(app_user_id)
 mdm.equipment  | maintenance.breakdown                       | breakdown_equipment_id_fkey                               | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | maintenance.collection_channel              | collection_channel_equipment_id_fkey                      | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | maintenance.equipment_downtime              | equipment_downtime_equipment_id_fkey                      | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | maintenance.equipment_inspection            | equipment_inspection_equipment_id_fkey                    | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | maintenance.maintenance_order               | maintenance_order_equipment_id_fkey                       | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | maintenance.planned_stop                    | planned_stop_equipment_id_fkey                            | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | maintenance.tool_usage                      | tool_usage_equipment_id_fkey                              | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | mdm.equipment_group_member                  | equipment_group_member_equipment_id_fkey                  | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | mdm.equipment_inspection_item_assignment    | equipment_inspection_item_assignment_equipment_id_fkey    | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | mdm.spare_part_equipment                    | spare_part_equipment_equipment_id_fkey                    | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | mdm.terminal                                | terminal_equipment_id_fkey                                | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | production.precheck_decision                | precheck_decision_equipment_id_fkey                       | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | production.production_result                | production_result_equipment_id_fkey                       | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | production.work_order                       | work_order_planned_equipment_id_fkey                      | FOREIGN KEY (planned_equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | production.work_order_resource_assignment   | work_order_resource_assignment_equipment_id_fkey          | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | production.work_session                     | work_session_equipment_id_fkey                            | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | quality.defect_record                       | defect_record_equipment_id_fkey                           | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | quality.equipment_calibration               | equipment_calibration_equipment_id_fkey                   | FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | quality.inspection_item_spec                | inspection_item_spec_default_inspection_equipment_id_fkey | FOREIGN KEY (default_inspection_equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.equipment  | quality.inspection_measurement              | inspection_measurement_inspection_equipment_id_fkey       | FOREIGN KEY (inspection_equipment_id) REFERENCES mdm.equipment(equipment_id)
 mdm.mold       | maintenance.maintenance_order               | maintenance_order_mold_id_fkey                            | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 mdm.mold       | maintenance.tool_usage                      | tool_usage_mold_id_fkey                                   | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 mdm.mold       | production.production_result                | production_result_mold_id_fkey                            | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 mdm.mold       | production.work_order                       | work_order_planned_mold_id_fkey                           | FOREIGN KEY (planned_mold_id) REFERENCES mdm.mold(mold_id)
 mdm.mold       | production.work_order_resource_assignment   | work_order_resource_assignment_mold_id_fkey               | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 mdm.mold       | production.work_session                     | work_session_mold_id_fkey                                 | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 mdm.mold       | quality.defect_record                       | defect_record_mold_id_fkey                                | FOREIGN KEY (mold_id) REFERENCES mdm.mold(mold_id)
 mdm.spare_part | logistics.goods_issue_spare_line            | goods_issue_spare_line_spare_part_id_fkey                 | FOREIGN KEY (spare_part_id) REFERENCES mdm.spare_part(spare_part_id)
 mdm.spare_part | mdm.spare_part_equipment                    | spare_part_equipment_spare_part_id_fkey                   | FOREIGN KEY (spare_part_id) REFERENCES mdm.spare_part(spare_part_id)
(73 rows)

 spare_issue_lines | issues
-------------------+--------
                 0 |      0
(1 row)

 ambiguous_issue_part_uoms
---------------------------
                         0
(1 row)

 direct_breakdown_orders
-------------------------
                       0
(1 row)

 trigger_type_code | source_id | orders
-------------------+-----------+--------
(0 rows)

COMMIT

```
