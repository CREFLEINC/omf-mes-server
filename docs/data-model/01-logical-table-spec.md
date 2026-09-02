# OMF-MES 논리 테이블 명세서 v4.0

> 설계 기준 `a8f46f2` · 논리 테이블 180개 · 물리 파티션 2개 · 컬럼 2371개

## 범례

- MASTER: 기준정보, TRANSACTION: 업무 헤더, DETAIL: 상세, EVENT: 이력·감사, PARTITION: 물리 파티션
- 필수는 최종 PostgreSQL 카탈로그의 `NOT NULL` 기준이며 API 요청 필수 여부와 동일한 개념이 아니다.

## app — 공통 애플리케이션

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `app.app_user` | APP 사용자 | TRANSACTION | 12 | `app_user_id` | 1 | APP 사용자의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.approval_request` | 승인 요청 | TRANSACTION | 15 | `approval_request_id` | 2 | 승인 요청의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.approval_route` | 승인 경로 | MASTER | 11 | `approval_route_id` | 1 | 승인 경로의 업무 기준과 유효 상태를 관리한다. |
| `app.approval_route_step` | 승인 경로 단계 | MASTER | 9 | `approval_route_step_id` | 4 | 승인 경로 단계의 업무 기준과 유효 상태를 관리한다. |
| `app.approval_step` | 승인 단계 | DETAIL | 8 | `approval_step_id` | 2 | 승인 단계의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `app.attachment` | 첨부 | TRANSACTION | 10 | `attachment_id` | 1 | 첨부의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.document_cancellation` | 문서 취소 | TRANSACTION | 9 | `document_cancellation_id` | 1 | 문서 취소의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.document_issue_log` | 문서 출고 LOG | EVENT | 12 | `document_issue_log_id` | 3 | 문서 출고 LOG의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `app.entity_type_registry` | ENTITY 유형 REGISTRY | MASTER | 7 | `entity_type_code` | 0 | ENTITY 유형 REGISTRY의 업무 기준과 유효 상태를 관리한다. |
| `app.exception_case` | 예외 CASE | TRANSACTION | 16 | `exception_case_id` | 2 | 예외 CASE의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.idempotency_record` | 멱등 기록 | TRANSACTION | 10 | `idempotency_key` | 1 | 범용 멱등 저장소. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-08-05). |
| `app.localized_text` | 다국어 문구 | TRANSACTION | 11 | `localized_text_id` | 1 | 다국어 문구의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.notice` | 공지 | TRANSACTION | 20 | `notice_id` | 3 | 공지의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.notice_acknowledgement` | 공지 확인응답 | TRANSACTION | 8 | `notice_acknowledgement_id` | 2 | 공지 확인응답의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.notification` | 알림 | TRANSACTION | 7 | `notification_id` | 2 | 알림의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.notification_event` | 알림 이력 | EVENT | 7 | `notification_event_id` | 0 | 알림 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `app.notification_subscription` | 알림 구독 | TRANSACTION | 8 | `notification_subscription_id` | 1 | 알림 구독의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.numbering_counter` | 채번 채번카운터 | TRANSACTION | 5 | `numbering_counter_id` | 1 | 채번 채번카운터의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.numbering_rule` | 채번 규칙 | MASTER | 12 | `numbering_rule_id` | 1 | 채번 규칙의 업무 기준과 유효 상태를 관리한다. |
| `app.operation_policy` | 공정 정책 | MASTER | 16 | `operation_policy_id` | 4 | 공정 정책의 업무 기준과 유효 상태를 관리한다. |
| `app.printer` | 프린터 | TRANSACTION | 13 | `printer_id` | 1 | 프린터의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.role` | 역할 | MASTER | 10 | `role_id` | 0 | 역할의 업무 기준과 유효 상태를 관리한다. |
| `app.role_permission` | 역할 권한 | MASTER | 5 | `role_permission_id` | 1 | 역할 권한의 업무 기준과 유효 상태를 관리한다. |
| `app.user_credential` | 사용자 자격증명 | TRANSACTION | 13 | `app_user_id` | 1 | 관리 화면 로그인 자격증명. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-07-28). |
| `app.user_data_scope` | 사용자 데이터 SCOPE | TRANSACTION | 7 | `user_data_scope_id` | 4 | 사용자 데이터 SCOPE의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.user_role` | 사용자 역할 | TRANSACTION | 5 | `user_role_id` | 2 | 사용자 역할의 업무 진행 상태와 실행 결과를 관리한다. |
| `app.worker_lease` | 작업자 작업잠금 | TRANSACTION | 8 | `worker_lease_id` | 1 | 작업자 작업잠금의 업무 진행 상태와 실행 결과를 관리한다. |

### app.app_user — APP 사용자

APP 사용자의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `app_user_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `app_user_id` | `bigint` | Y | PK | `-` |
| 2 | `login_id` | `character varying(100)` | Y | - | `-` |
| 3 | `user_name` | `app.name_t` | Y | - | `-` |
| 4 | `department_id` | `bigint` | N | FK→mdm.department | `-` |
| 5 | `email` | `character varying(200)` | N | - | `-` |
| 6 | `status_code` | `app.code_t` | Y | - | `'ACTIVE'::character varying` |
| 7 | `is_active` | `boolean` | Y | - | `true` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### app.approval_request — 승인 요청

승인 요청의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `approval_request_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `approval_request_id` | `bigint` | Y | PK | `-` |
| 2 | `approval_request_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `approval_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `target_id` | `bigint` | Y | - | `-` |
| 6 | `requested_by` | `bigint` | Y | FK→app.app_user | `-` |
| 7 | `requested_at` | `timestamp with time zone` | Y | - | `-` |
| 8 | `status_code` | `app.code_t` | Y | - | `-` |
| 9 | `reason` | `text` | Y | - | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `version_no` | `integer` | Y | - | `1` |
| 13 | `target_summary` | `jsonb` | N | - | `-` |
| 14 | `decided_at` | `timestamp with time zone` | N | - | `-` |
| 15 | `decided_by` | `bigint` | N | FK→app.app_user | `-` |

### app.approval_route — 승인 경로

승인 경로의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `approval_route_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `approval_route_id` | `bigint` | Y | PK | `-` |
| 2 | `approval_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `business_unit_id` | `bigint` | N | FK→mdm.business_unit | `-` |
| 4 | `min_value` | `numeric(20,6)` | N | - | `-` |
| 5 | `max_value` | `numeric(20,6)` | N | - | `-` |
| 6 | `is_active` | `boolean` | Y | - | `true` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |

### app.approval_route_step — 승인 경로 단계

승인 경로 단계의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `approval_route_step_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `approval_route_step_id` | `bigint` | Y | PK | `-` |
| 2 | `approval_route_id` | `bigint` | Y | FK→app.approval_route | `-` |
| 3 | `step_no` | `integer` | Y | - | `-` |
| 4 | `approver_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `approver_user_id` | `bigint` | N | FK→app.app_user | `-` |
| 6 | `approver_role_id` | `bigint` | N | FK→app.role | `-` |
| 7 | `approver_department_id` | `bigint` | N | FK→mdm.department | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |

### app.approval_step — 승인 단계

승인 단계의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `approval_step_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `approval_step_id` | `bigint` | Y | PK | `-` |
| 2 | `approval_request_id` | `bigint` | Y | FK→app.approval_request | `-` |
| 3 | `step_no` | `integer` | Y | - | `-` |
| 4 | `approver_id` | `bigint` | Y | FK→app.app_user | `-` |
| 5 | `decision_code` | `app.code_t` | N | - | `-` |
| 6 | `decision_at` | `timestamp with time zone` | N | - | `-` |
| 7 | `decision_comment` | `text` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### app.attachment — 첨부

첨부의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `attachment_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `attachment_id` | `bigint` | Y | PK | `-` |
| 2 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `target_id` | `bigint` | Y | - | `-` |
| 4 | `file_name` | `character varying(255)` | Y | - | `-` |
| 5 | `storage_key` | `character varying(500)` | Y | - | `-` |
| 6 | `mime_type` | `character varying(150)` | Y | - | `-` |
| 7 | `file_size` | `bigint` | Y | - | `-` |
| 8 | `checksum_sha256` | `character varying(64)` | N | - | `-` |
| 9 | `uploaded_by` | `bigint` | Y | FK→app.app_user | `-` |
| 10 | `uploaded_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### app.document_cancellation — 문서 취소

문서 취소의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `document_cancellation_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `document_cancellation_id` | `bigint` | Y | PK | `-` |
| 2 | `document_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `document_id` | `bigint` | Y | - | `-` |
| 4 | `previous_status_code` | `app.code_t` | N | - | `-` |
| 5 | `reason_code` | `app.code_t` | Y | - | `-` |
| 6 | `reason_detail` | `text` | N | - | `-` |
| 7 | `cancelled_at` | `timestamp with time zone` | Y | - | `-` |
| 8 | `cancelled_by` | `bigint` | Y | FK→app.app_user | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### app.document_issue_log — 문서 출고 LOG

문서 출고 LOG의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `document_issue_log_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `document_issue_log_id` | `bigint` | Y | PK | `-` |
| 2 | `document_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `target_id` | `bigint` | Y | - | `-` |
| 5 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 6 | `issue_seq` | `integer` | Y | - | `1` |
| 7 | `reissue_reason_code` | `app.code_t` | N | - | `-` |
| 8 | `issued_by` | `bigint` | Y | FK→app.app_user | `-` |
| 9 | `issued_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `terminal_id` | `bigint` | N | FK→mdm.terminal | `-` |
| 11 | `printer_name` | `character varying(100)` | N | - | `-` |
| 12 | `remarks` | `text` | N | - | `-` |

### app.entity_type_registry — ENTITY 유형 REGISTRY

ENTITY 유형 REGISTRY의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `entity_type_code`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `entity_type_code` | `app.code_t` | Y | PK | `-` |
| 2 | `schema_name` | `character varying(63)` | Y | - | `-` |
| 3 | `table_name` | `character varying(63)` | Y | - | `-` |
| 4 | `id_column_name` | `character varying(63)` | Y | - | `-` |
| 5 | `is_active` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### app.exception_case — 예외 CASE

예외 CASE의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `exception_case_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `exception_case_id` | `bigint` | Y | PK | `-` |
| 2 | `exception_case_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `exception_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `severity_code` | `app.code_t` | Y | - | `-` |
| 5 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `target_id` | `bigint` | Y | - | `-` |
| 7 | `assigned_department_id` | `bigint` | N | FK→mdm.department | `-` |
| 8 | `assigned_user_id` | `bigint` | N | FK→app.app_user | `-` |
| 9 | `due_at` | `timestamp with time zone` | N | - | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `resolution` | `text` | N | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |
| 14 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `updated_by` | `bigint` | N | - | `-` |
| 16 | `version_no` | `integer` | Y | - | `1` |

### app.idempotency_record — 멱등 기록

범용 멱등 저장소. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-08-05).

- 유형: `TRANSACTION`
- 기본키: `idempotency_key`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `idempotency_key` | `uuid` | Y | PK | `-` |
| 2 | `request_fingerprint` | `text` | Y | - | `-` |
| 3 | `status` | `text` | Y | - | `-` |
| 4 | `response_status` | `integer` | N | - | `-` |
| 5 | `response_body` | `jsonb` | N | - | `-` |
| 6 | `app_user_id` | `bigint` | N | FK→app.app_user | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `completed_at` | `timestamp with time zone` | N | - | `-` |
| 9 | `expires_at` | `timestamp with time zone` | Y | - | `-` |
| 10 | `response_headers` | `jsonb` | N | - | `-` |

### app.localized_text — 다국어 문구

다국어 문구의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `localized_text_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `localized_text_id` | `bigint` | Y | PK | `-` |
| 2 | `entity_type_code` | `app.code_t` | Y | FK→app.entity_type_registry | `-` |
| 3 | `entity_id` | `bigint` | Y | - | `-` |
| 4 | `field_code` | `app.code_t` | Y | - | `-` |
| 5 | `language_code` | `character varying(10)` | Y | - | `-` |
| 6 | `localized_value` | `text` | Y | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |

### app.notice — 공지

공지의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `notice_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `notice_id` | `bigint` | Y | PK | `-` |
| 2 | `notice_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `title` | `character varying(300)` | Y | - | `-` |
| 4 | `content` | `text` | Y | - | `-` |
| 5 | `audience_scope` | `jsonb` | Y | - | `'{}'::jsonb` |
| 6 | `status_code` | `app.code_t` | Y | - | `'DRAFT'::character varying` |
| 7 | `published_at` | `timestamp with time zone` | N | - | `-` |
| 8 | `published_by` | `bigint` | N | FK→app.app_user | `-` |
| 9 | `closed_at` | `timestamp with time zone` | N | - | `-` |
| 10 | `closed_by` | `bigint` | N | FK→app.app_user | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |
| 16 | `start_date` | `date` | N | - | `-` |
| 17 | `end_date` | `date` | N | - | `-` |
| 18 | `scope_code` | `app.code_t` | N | - | `-` |
| 19 | `target_work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 20 | `acknowledge_required` | `boolean` | Y | - | `false` |

### app.notice_acknowledgement — 공지 확인응답

공지 확인응답의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `notice_acknowledgement_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `notice_acknowledgement_id` | `bigint` | Y | PK | `-` |
| 2 | `notice_id` | `bigint` | Y | FK→app.notice | `-` |
| 3 | `app_user_id` | `bigint` | Y | FK→app.app_user | `-` |
| 4 | `acknowledged_at` | `timestamp with time zone` | N | - | `-` |
| 5 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 6 | `acknowledged` | `boolean` | Y | - | `false` |
| 7 | `worker_no` | `app.business_no_t` | N | - | `-` |
| 8 | `worker_name` | `app.name_t` | N | - | `-` |

### app.notification — 알림

알림의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `notification_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `notification_id` | `bigint` | Y | PK | `-` |
| 2 | `notification_event_id` | `bigint` | Y | FK→app.notification_event | `-` |
| 3 | `recipient_user_id` | `bigint` | Y | FK→app.app_user | `-` |
| 4 | `title` | `character varying(300)` | Y | - | `-` |
| 5 | `message` | `text` | Y | - | `-` |
| 6 | `read_at` | `timestamp with time zone` | N | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### app.notification_event — 알림 이력

알림 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `notification_event_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `notification_event_id` | `bigint` | Y | PK | `-` |
| 2 | `event_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `aggregate_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `aggregate_id` | `bigint` | Y | - | `-` |
| 5 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 6 | `payload` | `jsonb` | Y | - | `'{}'::jsonb` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### app.notification_subscription — 알림 구독

알림 구독의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `notification_subscription_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `notification_subscription_id` | `bigint` | Y | PK | `-` |
| 2 | `app_user_id` | `bigint` | Y | FK→app.app_user | `-` |
| 3 | `event_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `channel_code` | `app.code_t` | Y | - | `-` |
| 5 | `is_enabled` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `version_no` | `integer` | Y | - | `1` |

### app.numbering_counter — 채번 채번카운터

채번 채번카운터의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `numbering_counter_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `numbering_counter_id` | `bigint` | Y | PK | `-` |
| 2 | `numbering_rule_id` | `bigint` | Y | FK→app.numbering_rule | `-` |
| 3 | `period_key` | `character varying(20)` | Y | - | `-` |
| 4 | `last_value` | `bigint` | Y | - | `0` |
| 5 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### app.numbering_rule — 채번 규칙

채번 규칙의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `numbering_rule_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `numbering_rule_id` | `bigint` | Y | PK | `-` |
| 2 | `document_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `plant_id` | `bigint` | N | FK→mdm.plant | `-` |
| 4 | `lot_type_code` | `app.code_t` | N | - | `-` |
| 5 | `pattern` | `character varying(200)` | Y | - | `-` |
| 6 | `reset_cycle_code` | `app.code_t` | Y | - | `'DAILY'::character varying` |
| 7 | `is_active` | `boolean` | Y | - | `true` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### app.operation_policy — 공정 정책

공정 정책의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `operation_policy_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `operation_policy_id` | `bigint` | Y | PK | `-` |
| 2 | `policy_code` | `app.code_t` | Y | - | `-` |
| 3 | `business_unit_id` | `bigint` | N | FK→mdm.business_unit | `-` |
| 4 | `plant_id` | `bigint` | N | FK→mdm.plant | `-` |
| 5 | `item_id` | `bigint` | N | FK→mdm.item | `-` |
| 6 | `process_id` | `bigint` | N | FK→mdm.process | `-` |
| 7 | `value_text` | `character varying(500)` | N | - | `-` |
| 8 | `value_numeric` | `numeric(20,6)` | N | - | `-` |
| 9 | `value_boolean` | `boolean` | N | - | `-` |
| 10 | `effective_from` | `date` | Y | - | `-` |
| 11 | `effective_to` | `date` | N | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |
| 14 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `updated_by` | `bigint` | N | - | `-` |
| 16 | `version_no` | `integer` | Y | - | `1` |

### app.printer — 프린터

프린터의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `printer_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `printer_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `printer_code` | `app.code_t` | Y | - | `-` |
| 4 | `printer_name` | `app.name_t` | Y | - | `-` |
| 5 | `printer_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `connection_uri` | `text` | Y | - | `-` |
| 7 | `dpi` | `integer` | N | - | `-` |
| 8 | `is_active` | `boolean` | Y | - | `true` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### app.role — 역할

역할의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `role_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `role_id` | `bigint` | Y | PK | `-` |
| 2 | `role_code` | `app.code_t` | Y | - | `-` |
| 3 | `role_name` | `app.name_t` | Y | - | `-` |
| 4 | `description` | `text` | N | - | `-` |
| 5 | `is_active` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |
| 8 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `updated_by` | `bigint` | N | - | `-` |
| 10 | `version_no` | `integer` | Y | - | `1` |

### app.role_permission — 역할 권한

역할 권한의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `role_permission_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `role_permission_id` | `bigint` | Y | PK | `-` |
| 2 | `role_id` | `bigint` | Y | FK→app.role | `-` |
| 3 | `permission_code` | `app.code_t` | Y | - | `-` |
| 4 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 5 | `created_by` | `bigint` | N | - | `-` |

### app.user_credential — 사용자 자격증명

관리 화면 로그인 자격증명. 정본 모델 미포함 — OMF-MES 구현 측 추가분(2026-07-28).

- 유형: `TRANSACTION`
- 기본키: `app_user_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `app_user_id` | `bigint` | Y | PK, FK→app.app_user | `-` |
| 2 | `password_hash` | `text` | Y | - | `-` |
| 3 | `password_algo` | `app.code_t` | Y | - | `'SCRYPT'::character varying` |
| 4 | `password_changed_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 5 | `must_change_password` | `boolean` | Y | - | `false` |
| 6 | `failed_attempt_count` | `integer` | Y | - | `0` |
| 7 | `locked_until` | `timestamp with time zone` | N | - | `-` |
| 8 | `last_login_at` | `timestamp with time zone` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### app.user_data_scope — 사용자 데이터 SCOPE

사용자 데이터 SCOPE의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `user_data_scope_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `user_data_scope_id` | `bigint` | Y | PK | `-` |
| 2 | `app_user_id` | `bigint` | Y | FK→app.app_user | `-` |
| 3 | `business_unit_id` | `bigint` | N | FK→mdm.business_unit | `-` |
| 4 | `plant_id` | `bigint` | N | FK→mdm.plant | `-` |
| 5 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 6 | `created_by` | `bigint` | N | - | `-` |
| 7 | `legal_entity_id` | `bigint` | N | FK→mdm.legal_entity | `-` |

### app.user_role — 사용자 역할

사용자 역할의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `user_role_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `user_role_id` | `bigint` | Y | PK | `-` |
| 2 | `app_user_id` | `bigint` | Y | FK→app.app_user | `-` |
| 3 | `role_id` | `bigint` | Y | FK→app.role | `-` |
| 4 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 5 | `created_by` | `bigint` | N | - | `-` |

### app.worker_lease — 작업자 작업잠금

작업자 작업잠금의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `worker_lease_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `worker_lease_id` | `bigint` | Y | PK | `-` |
| 2 | `resource_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `resource_id` | `bigint` | Y | - | `-` |
| 4 | `owner_user_id` | `bigint` | Y | FK→app.app_user | `-` |
| 5 | `lease_token` | `uuid` | Y | - | `-` |
| 6 | `acquired_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `expires_at` | `timestamp with time zone` | Y | - | `-` |
| 8 | `released_at` | `timestamp with time zone` | N | - | `-` |

## audit — 감사

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `audit.audit_event` | 감사 이력 | EVENT | 11 | `audit_event_id, occurred_at` | 1 | 감사 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `audit.audit_event_default` | 감사 이력 DEFAULT | PARTITION | 11 | `audit_event_id, occurred_at` | 1 | 감사 이력 DEFAULT의 대용량 이력의 기본 파티션 데이터를 보관한다. |

### audit.audit_event — 감사 이력

감사 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `audit_event_id, occurred_at`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `audit_event_id` | `bigint` | Y | PK | `-` |
| 2 | `occurred_at` | `timestamp with time zone` | Y | PK | `-` |
| 3 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `target_id` | `bigint` | Y | - | `-` |
| 5 | `event_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `before_value` | `jsonb` | N | - | `-` |
| 7 | `after_value` | `jsonb` | N | - | `-` |
| 8 | `reason` | `text` | N | - | `-` |
| 9 | `performed_by` | `bigint` | N | - | `-` |
| 10 | `terminal_id` | `bigint` | N | FK→mdm.terminal | `-` |
| 11 | `correlation_id` | `character varying(150)` | N | - | `-` |

### audit.audit_event_default — 감사 이력 DEFAULT

감사 이력 DEFAULT의 대용량 이력의 기본 파티션 데이터를 보관한다.

- 유형: `PARTITION`
- 기본키: `audit_event_id, occurred_at`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `audit_event_id` | `bigint` | Y | PK | `-` |
| 2 | `occurred_at` | `timestamp with time zone` | Y | PK | `-` |
| 3 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `target_id` | `bigint` | Y | - | `-` |
| 5 | `event_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `before_value` | `jsonb` | N | - | `-` |
| 7 | `after_value` | `jsonb` | N | - | `-` |
| 8 | `reason` | `text` | N | - | `-` |
| 9 | `performed_by` | `bigint` | N | - | `-` |
| 10 | `terminal_id` | `bigint` | N | FK→mdm.terminal | `-` |
| 11 | `correlation_id` | `character varying(150)` | N | - | `-` |

## integration — 연계

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `integration.external_document_reference` | 외부 문서 REFERENCE | EVENT | 8 | `external_document_reference_id` | 0 | 외부 문서 REFERENCE의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `integration.integration_message` | 연계 메시지 | EVENT | 16 | `integration_message_id` | 0 | 연계 메시지의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `integration.interface_definition` | 인터페이스 정의 | EVENT | 14 | `interface_definition_id` | 0 | 인터페이스 정의의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `integration.outbound_item_setting` | 송신 품목 설정 | EVENT | 8 | `outbound_item_setting_id` | 2 | 송신 품목 설정의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `integration.record_provenance` | 기록 출처 | EVENT | 8 | `record_provenance_id` | 2 | 기록 출처의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |

### integration.external_document_reference — 외부 문서 REFERENCE

외부 문서 REFERENCE의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `external_document_reference_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `external_document_reference_id` | `bigint` | Y | PK | `-` |
| 2 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 3 | `target_id` | `bigint` | Y | - | `-` |
| 4 | `external_system_code` | `app.code_t` | Y | - | `-` |
| 5 | `external_document_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `external_document_no` | `character varying(150)` | Y | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |

### integration.integration_message — 연계 메시지

연계 메시지의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `integration_message_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `integration_message_id` | `bigint` | Y | PK | `-` |
| 2 | `message_key` | `character varying(150)` | Y | - | `-` |
| 3 | `interface_code` | `app.code_t` | Y | - | `-` |
| 4 | `direction_code` | `app.code_t` | Y | - | `-` |
| 5 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `target_id` | `bigint` | Y | - | `-` |
| 7 | `payload` | `jsonb` | Y | - | `-` |
| 8 | `status_code` | `app.code_t` | Y | - | `-` |
| 9 | `retry_count` | `integer` | Y | - | `0` |
| 10 | `last_error_message` | `text` | N | - | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `available_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `sent_at` | `timestamp with time zone` | N | - | `-` |
| 14 | `completed_at` | `timestamp with time zone` | N | - | `-` |
| 15 | `locked_at` | `timestamp with time zone` | N | - | `-` |
| 16 | `locked_by` | `character varying(100)` | N | - | `-` |

### integration.interface_definition — 인터페이스 정의

인터페이스 정의의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `interface_definition_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `interface_definition_id` | `bigint` | Y | PK | `-` |
| 2 | `interface_code` | `app.code_t` | Y | - | `-` |
| 3 | `interface_name` | `app.name_t` | Y | - | `-` |
| 4 | `direction_code` | `app.code_t` | Y | - | `-` |
| 5 | `transport_code` | `app.code_t` | Y | - | `-` |
| 6 | `endpoint_uri` | `text` | N | - | `-` |
| 7 | `message_schema` | `jsonb` | N | - | `-` |
| 8 | `retry_policy` | `jsonb` | Y | - | `'{}'::jsonb` |
| 9 | `is_active` | `boolean` | Y | - | `true` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |
| 12 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `updated_by` | `bigint` | N | - | `-` |
| 14 | `version_no` | `integer` | Y | - | `1` |

### integration.outbound_item_setting — 송신 품목 설정

송신 품목 설정의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `outbound_item_setting_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `outbound_item_setting_id` | `bigint` | Y | PK | `-` |
| 2 | `interface_definition_id` | `bigint` | Y | FK→integration.interface_definition | `-` |
| 3 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `is_enabled` | `boolean` | Y | - | `true` |
| 5 | `effective_from` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 6 | `effective_to` | `timestamp with time zone` | N | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |

### integration.record_provenance — 기록 출처

기록 출처의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `record_provenance_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `record_provenance_id` | `bigint` | Y | PK | `-` |
| 2 | `entity_type_code` | `app.code_t` | Y | FK→app.entity_type_registry | `-` |
| 3 | `entity_id` | `bigint` | Y | - | `-` |
| 4 | `source_system_code` | `app.code_t` | Y | - | `-` |
| 5 | `source_record_key` | `character varying(300)` | N | - | `-` |
| 6 | `received_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `integration_message_id` | `bigint` | N | FK→integration.integration_message | `-` |
| 8 | `attributes` | `jsonb` | Y | - | `'{}'::jsonb` |

## inventory — 재고

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `inventory.handling_unit` | 물류 단위 | TRANSACTION | 12 | `handling_unit_id` | 3 | 물류 단위의 업무 진행 상태와 실행 결과를 관리한다. |
| `inventory.handling_unit_content` | 물류 단위 내용 | DETAIL | 8 | `handling_unit_content_id` | 4 | 물류 단위 내용의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `inventory.handling_unit_reconfiguration` | 물류 단위 재구성 | TRANSACTION | 9 | `handling_unit_reconfiguration_id` | 3 | 물류 단위 재구성의 업무 진행 상태와 실행 결과를 관리한다. |
| `inventory.handling_unit_reconfiguration_line` | 물류 단위 재구성 상세 | DETAIL | 8 | `handling_unit_reconfiguration_line_id` | 4 | 물류 단위 재구성 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `inventory.inventory_adjustment` | 재고 조정 | TRANSACTION | 12 | `inventory_adjustment_id` | 2 | 재고 조정의 업무 진행 상태와 실행 결과를 관리한다. |
| `inventory.inventory_adjustment_line` | 재고 조정 상세 | DETAIL | 14 | `inventory_adjustment_line_id` | 6 | 재고 조정 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `inventory.inventory_balance` | 재고 잔량 | TRANSACTION | 22 | `inventory_balance_id` | 9 | 재고 잔량의 업무 진행 상태와 실행 결과를 관리한다. |
| `inventory.inventory_count` | 재고 실사 | TRANSACTION | 12 | `inventory_count_id` | 1 | 재고 실사의 업무 진행 상태와 실행 결과를 관리한다. |
| `inventory.inventory_count_line` | 재고 실사 상세 | DETAIL | 15 | `inventory_count_line_id` | 6 | 재고 실사 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `inventory.inventory_reservation` | 재고 예약 | TRANSACTION | 19 | `inventory_reservation_id` | 5 | 재고 예약의 업무 진행 상태와 실행 결과를 관리한다. |
| `inventory.inventory_transaction` | 재고 트랜잭션 | TRANSACTION | 14 | `inventory_transaction_id, business_date` | 3 | 재고 트랜잭션의 업무 진행 상태와 실행 결과를 관리한다. |
| `inventory.inventory_transaction_default` | 재고 트랜잭션 DEFAULT | PARTITION | 14 | `inventory_transaction_id, business_date` | 2 | 재고 트랜잭션 DEFAULT의 대용량 이력의 기본 파티션 데이터를 보관한다. |
| `inventory.inventory_transaction_line` | 재고 트랜잭션 상세 | DETAIL | 23 | `inventory_transaction_line_id` | 11 | 재고 트랜잭션 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |

### inventory.handling_unit — 물류 단위

물류 단위의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `handling_unit_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `handling_unit_id` | `bigint` | Y | PK | `-` |
| 2 | `handling_unit_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `handling_unit_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `parent_handling_unit_id` | `bigint` | N | FK→inventory.handling_unit | `-` |
| 5 | `warehouse_id` | `bigint` | N | FK→mdm.warehouse | `-` |
| 6 | `location_id` | `bigint` | N | FK→mdm.location | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### inventory.handling_unit_content — 물류 단위 내용

물류 단위 내용의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `handling_unit_content_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `handling_unit_content_id` | `bigint` | Y | PK | `-` |
| 2 | `handling_unit_id` | `bigint` | Y | FK→inventory.handling_unit | `-` |
| 3 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 5 | `qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |

### inventory.handling_unit_reconfiguration — 물류 단위 재구성

물류 단위 재구성의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `handling_unit_reconfiguration_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `handling_unit_reconfiguration_id` | `bigint` | Y | PK | `-` |
| 2 | `reconfiguration_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `reconfiguration_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `source_handling_unit_id` | `bigint` | Y | FK→inventory.handling_unit | `-` |
| 5 | `target_handling_unit_id` | `bigint` | Y | FK→inventory.handling_unit | `-` |
| 6 | `reason_code` | `app.code_t` | Y | - | `-` |
| 7 | `performed_at` | `timestamp with time zone` | Y | - | `-` |
| 8 | `performed_by` | `bigint` | N | FK→app.app_user | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### inventory.handling_unit_reconfiguration_line — 물류 단위 재구성 상세

물류 단위 재구성 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `handling_unit_reconfiguration_line_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `handling_unit_reconfiguration_line_id` | `bigint` | Y | PK | `-` |
| 2 | `handling_unit_reconfiguration_id` | `bigint` | Y | FK→inventory.handling_unit_reconfiguration | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 6 | `moved_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### inventory.inventory_adjustment — 재고 조정

재고 조정의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inventory_adjustment_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_adjustment_id` | `bigint` | Y | PK | `-` |
| 2 | `inventory_adjustment_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `inventory_count_id` | `bigint` | N | FK→inventory.inventory_count | `-` |
| 4 | `reason_code` | `app.code_t` | Y | - | `-` |
| 5 | `approval_request_id` | `bigint` | N | FK→app.approval_request | `-` |
| 6 | `status_code` | `app.code_t` | Y | - | `-` |
| 7 | `adjusted_at` | `timestamp with time zone` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### inventory.inventory_adjustment_line — 재고 조정 상세

재고 조정 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `inventory_adjustment_line_id`
- 직접 외래키: 6개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_adjustment_line_id` | `bigint` | Y | PK | `-` |
| 2 | `inventory_adjustment_id` | `bigint` | Y | FK→inventory.inventory_adjustment | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 7 | `quality_status_code` | `app.code_t` | Y | - | `-` |
| 8 | `inventory_status_code` | `app.code_t` | Y | - | `-` |
| 9 | `adjustment_qty` | `app.signed_qty_t` | Y | - | `-` |
| 10 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 11 | `reason_code` | `app.code_t` | Y | - | `-` |
| 12 | `inventory_transaction_line_id` | `bigint` | N | FK→inventory.inventory_transaction_line | `-` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |

### inventory.inventory_balance — 재고 잔량

재고 잔량의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inventory_balance_id`
- 직접 외래키: 9개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_balance_id` | `bigint` | Y | PK | `-` |
| 2 | `legal_entity_id` | `bigint` | Y | FK→mdm.legal_entity | `-` |
| 3 | `business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 4 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 5 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 6 | `location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 7 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 8 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 9 | `quality_status_code` | `app.code_t` | Y | - | `-` |
| 10 | `inventory_status_code` | `app.code_t` | Y | - | `-` |
| 11 | `ownership_type_code` | `app.code_t` | Y | - | `-` |
| 12 | `owner_partner_id` | `bigint` | N | FK→mdm.partner | `-` |
| 13 | `on_hand_qty` | `app.signed_qty_t` | Y | - | `0` |
| 14 | `reserved_qty` | `app.qty_t` | Y | - | `0` |
| 15 | `picked_qty` | `app.qty_t` | Y | - | `0` |
| 16 | `blocked_qty` | `app.qty_t` | Y | - | `0` |
| 17 | `available_qty` | `numeric(20,6)` | N | - | `((((on_hand_qty)::numeric - (reserved_qty)::numeric) - (picked_qty)::numeric) - (blocked_qty)::numeric)` |
| 18 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 19 | `last_transaction_at` | `timestamp with time zone` | N | - | `-` |
| 20 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 21 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 22 | `version_no` | `integer` | Y | - | `1` |

### inventory.inventory_count — 재고 실사

재고 실사의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inventory_count_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_count_id` | `bigint` | Y | PK | `-` |
| 2 | `inventory_count_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `count_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 5 | `planned_date` | `date` | Y | - | `-` |
| 6 | `blind_count` | `boolean` | Y | - | `false` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### inventory.inventory_count_line — 재고 실사 상세

재고 실사 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `inventory_count_line_id`
- 직접 외래키: 6개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_count_line_id` | `bigint` | Y | PK | `-` |
| 2 | `inventory_count_id` | `bigint` | Y | FK→inventory.inventory_count | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 7 | `system_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `counted_qty` | `app.qty_t` | Y | - | `-` |
| 9 | `variance_qty` | `numeric(20,6)` | N | - | `((counted_qty)::numeric - (system_qty)::numeric)` |
| 10 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 11 | `variance_reason_code` | `app.code_t` | N | - | `-` |
| 12 | `counted_by` | `bigint` | N | FK→app.app_user | `-` |
| 13 | `counted_at` | `timestamp with time zone` | Y | - | `-` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |

### inventory.inventory_reservation — 재고 예약

재고 예약의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inventory_reservation_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_reservation_id` | `bigint` | Y | PK | `-` |
| 2 | `reservation_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `reservation_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `source_document_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `source_document_id` | `bigint` | Y | - | `-` |
| 6 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 7 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 8 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 9 | `location_id` | `bigint` | N | FK→mdm.location | `-` |
| 10 | `reserved_qty` | `app.qty_t` | Y | - | `-` |
| 11 | `released_qty` | `app.qty_t` | Y | - | `0` |
| 12 | `consumed_qty` | `app.qty_t` | Y | - | `0` |
| 13 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 14 | `status_code` | `app.code_t` | Y | - | `-` |
| 15 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `created_by` | `bigint` | N | - | `-` |
| 17 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `updated_by` | `bigint` | N | - | `-` |
| 19 | `version_no` | `integer` | Y | - | `1` |

### inventory.inventory_transaction — 재고 트랜잭션

재고 트랜잭션의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inventory_transaction_id, business_date`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_transaction_id` | `bigint` | Y | PK | `-` |
| 2 | `business_date` | `date` | Y | PK | `-` |
| 3 | `transaction_no` | `app.business_no_t` | Y | - | `-` |
| 4 | `transaction_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 6 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `recorded_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `source_document_type_code` | `app.code_t` | Y | - | `-` |
| 9 | `source_document_id` | `bigint` | Y | - | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `idempotency_key` | `character varying(150)` | Y | - | `-` |
| 12 | `reversal_of_transaction_id` | `bigint` | N | FK→inventory.inventory_transaction, FK→inventory.inventory_transaction_default | `-` |
| 13 | `reversal_of_business_date` | `date` | N | FK→inventory.inventory_transaction, FK→inventory.inventory_transaction_default | `-` |
| 14 | `created_by` | `bigint` | N | - | `-` |

### inventory.inventory_transaction_default — 재고 트랜잭션 DEFAULT

재고 트랜잭션 DEFAULT의 대용량 이력의 기본 파티션 데이터를 보관한다.

- 유형: `PARTITION`
- 기본키: `inventory_transaction_id, business_date`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_transaction_id` | `bigint` | Y | PK | `-` |
| 2 | `business_date` | `date` | Y | PK | `-` |
| 3 | `transaction_no` | `app.business_no_t` | Y | - | `-` |
| 4 | `transaction_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 6 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `recorded_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `source_document_type_code` | `app.code_t` | Y | - | `-` |
| 9 | `source_document_id` | `bigint` | Y | - | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `idempotency_key` | `character varying(150)` | Y | - | `-` |
| 12 | `reversal_of_transaction_id` | `bigint` | N | FK→inventory.inventory_transaction | `-` |
| 13 | `reversal_of_business_date` | `date` | N | FK→inventory.inventory_transaction | `-` |
| 14 | `created_by` | `bigint` | N | - | `-` |

### inventory.inventory_transaction_line — 재고 트랜잭션 상세

재고 트랜잭션 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `inventory_transaction_line_id`
- 직접 외래키: 11개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inventory_transaction_line_id` | `bigint` | Y | PK | `-` |
| 2 | `inventory_transaction_id` | `bigint` | Y | FK→inventory.inventory_transaction, FK→inventory.inventory_transaction_default | `-` |
| 3 | `business_date` | `date` | Y | FK→inventory.inventory_transaction, FK→inventory.inventory_transaction_default | `-` |
| 4 | `line_no` | `integer` | Y | - | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 7 | `qty` | `app.qty_t` | Y | - | `-` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `from_warehouse_id` | `bigint` | N | FK→mdm.warehouse | `-` |
| 10 | `from_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 11 | `from_quality_status_code` | `app.code_t` | N | - | `-` |
| 12 | `from_inventory_status_code` | `app.code_t` | N | - | `-` |
| 13 | `to_warehouse_id` | `bigint` | N | FK→mdm.warehouse | `-` |
| 14 | `to_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 15 | `to_quality_status_code` | `app.code_t` | N | - | `-` |
| 16 | `to_inventory_status_code` | `app.code_t` | N | - | `-` |
| 17 | `ownership_type_code` | `app.code_t` | Y | - | `-` |
| 18 | `owner_partner_id` | `bigint` | N | FK→mdm.partner | `-` |
| 19 | `handling_unit_id` | `bigint` | N | FK→inventory.handling_unit | `-` |
| 20 | `from_qty_after_transaction` | `numeric(20,6)` | N | - | `-` |
| 21 | `to_qty_after_transaction` | `numeric(20,6)` | N | - | `-` |
| 22 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 23 | `created_by` | `bigint` | N | - | `-` |

## logistics — 물류

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `logistics.asn` | 입고예정 | TRANSACTION | 13 | `asn_id` | 2 | 입고예정의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.asn_line` | 입고예정 상세 | DETAIL | 10 | `asn_line_id` | 4 | 입고예정 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.goods_issue` | 물품 출고 | TRANSACTION | 22 | `goods_issue_id` | 3 | 물품 출고의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.goods_issue_line` | 물품 출고 상세 | DETAIL | 12 | `goods_issue_line_id` | 7 | 물품 출고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.goods_issue_spare_line` | 물품 출고 예비 상세 | DETAIL | 8 | `goods_issue_spare_line_id` | 4 | 예비품 출고 라인. goods_issue_line 과 형제이며 헤더(goods_issue)는 공유한다. 기존 라인을 쓰지 않는 것은 item_id·lot_id 가 둘 다 NOT NULL 이고 자재 출고가 그 제약에 기대고 있어서다 — 예비품 때문에 풀면 자재 쪽 무결성이 함께 내려간다. 근거: 설계 확정 2026-08-11 · 회신 E-2 정리본. |
| `logistics.goods_receipt` | 입고 | TRANSACTION | 16 | `goods_receipt_id` | 2 | 입고의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.goods_receipt_line` | 입고 상세 | DETAIL | 18 | `goods_receipt_line_id` | 8 | 입고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.inbound_receipt` | 입고 입고 | TRANSACTION | 19 | `inbound_receipt_id` | 5 | 입고 입고의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.inbound_receipt_line` | 입고 입고 상세 | DETAIL | 21 | `inbound_receipt_line_id` | 5 | 입고 입고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.inbound_variance` | 입고 차이 | TRANSACTION | 9 | `inbound_variance_id` | 3 | 입고 차이의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.material_issue_request` | 자재 출고 요청 | TRANSACTION | 14 | `material_issue_request_id` | 3 | 자재 출고 요청의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.material_issue_request_line` | 자재 출고 요청 상세 | DETAIL | 10 | `material_issue_request_line_id` | 4 | 자재 출고 요청 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.picking_line` | 피킹 상세 | DETAIL | 16 | `picking_line_id` | 6 | 피킹 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.picking_order` | 피킹 지시 | TRANSACTION | 13 | `picking_order_id` | 2 | 피킹 지시의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.purchase_order` | 구매 지시 | TRANSACTION | 14 | `purchase_order_id` | 3 | 구매 지시의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.purchase_order_line` | 구매 지시 상세 | DETAIL | 14 | `purchase_order_line_id` | 3 | 구매 지시 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.putaway_rule` | 적치 규칙 | TRANSACTION | 14 | `putaway_rule_id` | 4 | 적치 규칙의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.putaway_task` | 적치 TASK | TRANSACTION | 23 | `putaway_task_id` | 10 | 적치 TASK의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.recycle_entry` | 재활용 ENTRY | TRANSACTION | 18 | `recycle_entry_id` | 5 | 재활용 ENTRY의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.sales_order` | 판매 지시 | TRANSACTION | 12 | `sales_order_id` | 2 | 판매 지시의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.sales_order_line` | 판매 지시 상세 | DETAIL | 13 | `sales_order_line_id` | 3 | 판매 지시 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.shipment` | 출하 | TRANSACTION | 25 | `shipment_id` | 6 | 출하의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.shipment_line` | 출하 상세 | DETAIL | 10 | `shipment_line_id` | 5 | 출하 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.shipment_lot_allocation` | 출하 LOT 배분 | DETAIL | 8 | `shipment_lot_allocation_id` | 4 | 출하 LOT 배분의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.shipment_request` | 출하 요청 | TRANSACTION | 14 | `shipment_request_id` | 2 | 출하 요청의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.shipment_request_line` | 출하 요청 상세 | DETAIL | 17 | `shipment_request_line_id` | 4 | 출하 요청 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.shopfloor_receipt` | 현장 입고 | TRANSACTION | 13 | `shopfloor_receipt_id` | 4 | 현장 입고의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.shopfloor_receipt_line` | 현장 입고 상세 | DETAIL | 12 | `shopfloor_receipt_line_id` | 5 | 현장 입고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.stock_transfer` | 재고이동 이동 | TRANSACTION | 18 | `stock_transfer_id` | 4 | 재고이동 이동의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.stock_transfer_line` | 재고이동 이동 상세 | DETAIL | 15 | `stock_transfer_line_id` | 8 | 재고이동 이동 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `logistics.subcontract_issue` | 외주 출고 | TRANSACTION | 8 | `subcontract_issue_id` | 2 | 외주 출고의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.subcontract_order` | 외주 지시 | TRANSACTION | 15 | `subcontract_order_id` | 5 | 외주 지시의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.subcontract_receipt` | 외주 입고 | TRANSACTION | 9 | `subcontract_receipt_id` | 2 | 외주 입고의 업무 진행 상태와 실행 결과를 관리한다. |
| `logistics.subcontract_reconciliation` | 외주 RECONCILIATION | TRANSACTION | 18 | `subcontract_reconciliation_id` | 3 | 외주 RECONCILIATION의 업무 진행 상태와 실행 결과를 관리한다. |

### logistics.asn — 입고예정

입고예정의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `asn_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `asn_id` | `bigint` | Y | PK | `-` |
| 2 | `asn_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `supplier_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 4 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 5 | `expected_arrival_date` | `date` | Y | - | `-` |
| 6 | `delivery_note_no` | `character varying(100)` | N | - | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `remarks` | `text` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### logistics.asn_line — 입고예정 상세

입고예정 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `asn_line_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `asn_line_id` | `bigint` | Y | PK | `-` |
| 2 | `asn_id` | `bigint` | Y | FK→logistics.asn | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `purchase_order_line_id` | `bigint` | N | FK→logistics.purchase_order_line | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `expected_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `supplier_lot_no` | `character varying(100)` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |

### logistics.goods_issue — 물품 출고

물품 출고의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `goods_issue_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `goods_issue_id` | `bigint` | Y | PK | `-` |
| 2 | `goods_issue_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `issue_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `source_document_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `source_document_id` | `bigint` | Y | - | `-` |
| 6 | `source_warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 7 | `destination_type_code` | `app.code_t` | N | - | `-` |
| 8 | `destination_id` | `bigint` | N | - | `-` |
| 9 | `issued_at` | `timestamp with time zone` | Y | - | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `reason_code` | `app.code_t` | N | - | `-` |
| 12 | `replacement_expected` | `boolean` | N | - | `-` |
| 13 | `remarks` | `text` | N | - | `-` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |
| 16 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `updated_by` | `bigint` | N | - | `-` |
| 18 | `version_no` | `integer` | Y | - | `1` |
| 19 | `approval_request_id` | `bigint` | N | FK→app.approval_request | `-` |
| 20 | `cancelled_at` | `timestamp with time zone` | N | - | `-` |
| 21 | `cancelled_by` | `bigint` | N | FK→app.app_user | `-` |
| 22 | `cancellation_reason_code` | `app.code_t` | N | - | `-` |

### logistics.goods_issue_line — 물품 출고 상세

물품 출고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `goods_issue_line_id`
- 직접 외래키: 7개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `goods_issue_line_id` | `bigint` | Y | PK | `-` |
| 2 | `goods_issue_id` | `bigint` | Y | FK→logistics.goods_issue | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `picking_line_id` | `bigint` | N | FK→logistics.picking_line | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 7 | `issue_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `source_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 10 | `inventory_transaction_line_id` | `bigint` | N | FK→inventory.inventory_transaction_line | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |

### logistics.goods_issue_spare_line — 물품 출고 예비 상세

예비품 출고 라인. goods_issue_line 과 형제이며 헤더(goods_issue)는 공유한다. 기존 라인을 쓰지 않는 것은 item_id·lot_id 가 둘 다 NOT NULL 이고 자재 출고가 그 제약에 기대고 있어서다 — 예비품 때문에 풀면 자재 쪽 무결성이 함께 내려간다. 근거: 설계 확정 2026-08-11 · 회신 E-2 정리본.

- 유형: `DETAIL`
- 기본키: `goods_issue_spare_line_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `goods_issue_spare_line_id` | `bigint` | Y | PK | `-` |
| 2 | `goods_issue_id` | `bigint` | Y | FK→logistics.goods_issue | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `spare_part_id` | `bigint` | Y | FK→mdm.spare_part | `-` |
| 5 | `issue_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | FK→app.app_user | `-` |

### logistics.goods_receipt — 입고

입고의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `goods_receipt_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `goods_receipt_id` | `bigint` | Y | PK | `-` |
| 2 | `goods_receipt_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `receipt_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 5 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 6 | `receipt_datetime` | `timestamp with time zone` | Y | - | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `source_document_type_code` | `app.code_t` | N | - | `-` |
| 9 | `source_document_id` | `bigint` | N | - | `-` |
| 10 | `reason_code` | `app.code_t` | N | - | `-` |
| 11 | `remarks` | `text` | N | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |
| 14 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `updated_by` | `bigint` | N | - | `-` |
| 16 | `version_no` | `integer` | Y | - | `1` |

### logistics.goods_receipt_line — 입고 상세

입고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `goods_receipt_line_id`
- 직접 외래키: 8개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `goods_receipt_line_id` | `bigint` | Y | PK | `-` |
| 2 | `goods_receipt_id` | `bigint` | Y | FK→logistics.goods_receipt | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `inbound_receipt_line_id` | `bigint` | N | FK→logistics.inbound_receipt_line | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 7 | `receipt_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `quality_status_code` | `app.code_t` | Y | - | `-` |
| 10 | `inventory_status_code` | `app.code_t` | Y | - | `-` |
| 11 | `destination_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 12 | `original_shipment_lot_allocation_id` | `bigint` | N | FK→logistics.shipment_lot_allocation | `-` |
| 13 | `inventory_transaction_line_id` | `bigint` | N | FK→inventory.inventory_transaction_line | `-` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |
| 16 | `expected_qty` | `app.qty_t` | N | - | `-` |
| 17 | `variance_reason_code` | `app.code_t` | N | - | `-` |
| 18 | `variance_note` | `text` | N | - | `-` |

### logistics.inbound_receipt — 입고 입고

입고 입고의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inbound_receipt_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inbound_receipt_id` | `bigint` | Y | PK | `-` |
| 2 | `inbound_receipt_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `supplier_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 4 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 5 | `receipt_datetime` | `timestamp with time zone` | Y | - | `-` |
| 6 | `delivery_note_no` | `character varying(100)` | N | - | `-` |
| 7 | `vehicle_no` | `character varying(50)` | N | - | `-` |
| 8 | `dock_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 9 | `exception_type_code` | `app.code_t` | N | - | `-` |
| 10 | `exception_reason` | `text` | N | - | `-` |
| 11 | `approval_request_id` | `bigint` | N | FK→app.approval_request | `-` |
| 12 | `status_code` | `app.code_t` | Y | - | `-` |
| 13 | `received_by` | `bigint` | N | FK→app.app_user | `-` |
| 14 | `remarks` | `text` | N | - | `-` |
| 15 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `created_by` | `bigint` | N | - | `-` |
| 17 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `updated_by` | `bigint` | N | - | `-` |
| 19 | `version_no` | `integer` | Y | - | `1` |

### logistics.inbound_receipt_line — 입고 입고 상세

입고 입고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `inbound_receipt_line_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inbound_receipt_line_id` | `bigint` | Y | PK | `-` |
| 2 | `inbound_receipt_id` | `bigint` | Y | FK→logistics.inbound_receipt | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `purchase_order_line_id` | `bigint` | N | FK→logistics.purchase_order_line | `-` |
| 5 | `asn_line_id` | `bigint` | N | FK→logistics.asn_line | `-` |
| 6 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 7 | `received_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `package_count` | `integer` | N | - | `-` |
| 10 | `supplier_lot_no` | `character varying(100)` | N | - | `-` |
| 11 | `supplier_lot_missing` | `boolean` | Y | - | `false` |
| 12 | `substitute_lot_reason_code` | `app.code_t` | N | - | `-` |
| 13 | `manufactured_date` | `date` | N | - | `-` |
| 14 | `expiry_date` | `date` | N | - | `-` |
| 15 | `inspection_required` | `boolean` | Y | - | `-` |
| 16 | `status_code` | `app.code_t` | Y | - | `-` |
| 17 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `created_by` | `bigint` | N | - | `-` |
| 19 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 20 | `updated_by` | `bigint` | N | - | `-` |
| 21 | `version_no` | `integer` | Y | - | `1` |

### logistics.inbound_variance — 입고 차이

입고 차이의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inbound_variance_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inbound_variance_id` | `bigint` | Y | PK | `-` |
| 2 | `inbound_receipt_line_id` | `bigint` | Y | FK→logistics.inbound_receipt_line | `-` |
| 3 | `variance_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `variance_qty` | `app.qty_t` | Y | - | `-` |
| 5 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 6 | `reason_code` | `app.code_t` | Y | - | `-` |
| 7 | `approval_request_id` | `bigint` | N | FK→app.approval_request | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |

### logistics.material_issue_request — 자재 출고 요청

자재 출고 요청의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `material_issue_request_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `material_issue_request_id` | `bigint` | Y | PK | `-` |
| 2 | `issue_request_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 4 | `destination_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 5 | `required_at` | `timestamp with time zone` | N | - | `-` |
| 6 | `status_code` | `app.code_t` | Y | - | `-` |
| 7 | `requested_by` | `bigint` | N | FK→app.app_user | `-` |
| 8 | `remarks` | `text` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |
| 14 | `reason_code` | `app.code_t` | N | - | `-` |

### logistics.material_issue_request_line — 자재 출고 요청 상세

자재 출고 요청 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `material_issue_request_line_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `material_issue_request_line_id` | `bigint` | Y | PK | `-` |
| 2 | `material_issue_request_id` | `bigint` | Y | FK→logistics.material_issue_request | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `bom_component_id` | `bigint` | N | FK→planning.bom_component | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `requested_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `issued_qty` | `app.qty_t` | Y | - | `0` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |

### logistics.picking_line — 피킹 상세

피킹 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `picking_line_id`
- 직접 외래키: 6개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `picking_line_id` | `bigint` | Y | PK | `-` |
| 2 | `picking_order_id` | `bigint` | Y | FK→logistics.picking_order | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 6 | `location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 7 | `planned_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `picked_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 10 | `inventory_reservation_id` | `bigint` | N | FK→inventory.inventory_reservation | `-` |
| 11 | `status_code` | `app.code_t` | Y | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |
| 14 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `updated_by` | `bigint` | N | - | `-` |
| 16 | `version_no` | `integer` | Y | - | `1` |

### logistics.picking_order — 피킹 지시

피킹 지시의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `picking_order_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `picking_order_id` | `bigint` | Y | PK | `-` |
| 2 | `picking_order_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `picking_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `source_document_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `source_document_id` | `bigint` | Y | - | `-` |
| 6 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `assigned_worker_id` | `bigint` | N | FK→mdm.worker | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### logistics.purchase_order — 구매 지시

구매 지시의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `purchase_order_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `purchase_order_id` | `bigint` | Y | PK | `-` |
| 2 | `purchase_order_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `erp_purchase_order_no` | `character varying(100)` | N | - | `-` |
| 4 | `supplier_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 5 | `business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 6 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 7 | `order_date` | `date` | Y | - | `-` |
| 8 | `expected_receipt_date` | `date` | N | - | `-` |
| 9 | `status_code` | `app.code_t` | Y | - | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |
| 12 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `updated_by` | `bigint` | N | - | `-` |
| 14 | `version_no` | `integer` | Y | - | `1` |

### logistics.purchase_order_line — 구매 지시 상세

구매 지시 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `purchase_order_line_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `purchase_order_line_id` | `bigint` | Y | PK | `-` |
| 2 | `purchase_order_id` | `bigint` | Y | FK→logistics.purchase_order | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `ordered_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `received_qty` | `app.qty_t` | Y | - | `0` |
| 8 | `tolerance_over_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `tolerance_under_qty` | `app.qty_t` | Y | - | `0` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |
| 12 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `updated_by` | `bigint` | N | - | `-` |
| 14 | `version_no` | `integer` | Y | - | `1` |

### logistics.putaway_rule — 적치 규칙

적치 규칙의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `putaway_rule_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `putaway_rule_id` | `bigint` | Y | PK | `-` |
| 2 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 3 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 4 | `location_id` | `bigint` | N | FK→mdm.location | `-` |
| 5 | `capacity_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `priority_no` | `integer` | Y | - | `100` |
| 8 | `is_active` | `boolean` | Y | - | `true` |
| 9 | `remarks` | `text` | N | - | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |
| 12 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `updated_by` | `bigint` | N | - | `-` |
| 14 | `version_no` | `integer` | Y | - | `1` |

### logistics.putaway_task — 적치 TASK

적치 TASK의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `putaway_task_id`
- 직접 외래키: 10개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `putaway_task_id` | `bigint` | Y | PK | `-` |
| 2 | `putaway_task_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `goods_receipt_line_id` | `bigint` | Y | FK→logistics.goods_receipt_line | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 6 | `task_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `from_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 9 | `recommended_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 10 | `applied_putaway_rule_id` | `bigint` | N | FK→logistics.putaway_rule | `-` |
| 11 | `actual_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 12 | `priority_no` | `integer` | Y | - | `100` |
| 13 | `assigned_worker_id` | `bigint` | N | FK→mdm.worker | `-` |
| 14 | `status_code` | `app.code_t` | Y | - | `-` |
| 15 | `completed_at` | `timestamp with time zone` | N | - | `-` |
| 16 | `inventory_transaction_line_id` | `bigint` | N | FK→inventory.inventory_transaction_line | `-` |
| 17 | `remarks` | `text` | N | - | `-` |
| 18 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 19 | `created_by` | `bigint` | N | - | `-` |
| 20 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 21 | `updated_by` | `bigint` | N | - | `-` |
| 22 | `version_no` | `integer` | Y | - | `1` |
| 23 | `reason_code` | `app.code_t` | N | - | `-` |

### logistics.recycle_entry — 재활용 ENTRY

재활용 ENTRY의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `recycle_entry_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `recycle_entry_id` | `bigint` | Y | PK | `-` |
| 2 | `recycle_entry_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 6 | `source_document_type_code` | `app.code_t` | Y | - | `-` |
| 7 | `source_document_id` | `bigint` | Y | - | `-` |
| 8 | `recycle_type_code` | `app.code_t` | Y | - | `-` |
| 9 | `recycle_qty` | `app.qty_t` | Y | - | `-` |
| 10 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 11 | `destination_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 12 | `status_code` | `app.code_t` | Y | - | `-` |
| 13 | `processed_at` | `timestamp with time zone` | N | - | `-` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |
| 16 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `updated_by` | `bigint` | N | - | `-` |
| 18 | `version_no` | `integer` | Y | - | `1` |

### logistics.sales_order — 판매 지시

판매 지시의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `sales_order_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `sales_order_id` | `bigint` | Y | PK | `-` |
| 2 | `sales_order_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `erp_sales_order_no` | `character varying(100)` | N | - | `-` |
| 4 | `customer_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 5 | `ship_to_partner_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 6 | `order_date` | `date` | Y | - | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### logistics.sales_order_line — 판매 지시 상세

판매 지시 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `sales_order_line_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `sales_order_line_id` | `bigint` | Y | PK | `-` |
| 2 | `sales_order_id` | `bigint` | Y | FK→logistics.sales_order | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `ordered_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `requested_delivery_date` | `date` | N | - | `-` |
| 8 | `shipped_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### logistics.shipment — 출하

출하의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `shipment_id`
- 직접 외래키: 6개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shipment_id` | `bigint` | Y | PK | `-` |
| 2 | `shipment_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `shipment_request_id` | `bigint` | Y | FK→logistics.shipment_request | `-` |
| 4 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 5 | `vehicle_no` | `character varying(50)` | N | - | `-` |
| 6 | `driver_name` | `character varying(100)` | N | - | `-` |
| 7 | `seal_no` | `character varying(50)` | N | - | `-` |
| 8 | `transport_document_no` | `character varying(100)` | N | - | `-` |
| 9 | `loading_worker_id` | `bigint` | N | FK→mdm.worker | `-` |
| 10 | `carrier_id` | `bigint` | N | FK→mdm.partner | `-` |
| 11 | `loaded_at` | `timestamp with time zone` | N | - | `-` |
| 12 | `shipped_at` | `timestamp with time zone` | N | - | `-` |
| 13 | `status_code` | `app.code_t` | Y | - | `-` |
| 14 | `erp_delivery_no` | `character varying(100)` | N | - | `-` |
| 15 | `remarks` | `text` | N | - | `-` |
| 16 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `created_by` | `bigint` | N | - | `-` |
| 18 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 19 | `updated_by` | `bigint` | N | - | `-` |
| 20 | `version_no` | `integer` | Y | - | `1` |
| 21 | `confirmed_at` | `timestamp with time zone` | N | - | `-` |
| 22 | `confirmed_by` | `bigint` | N | FK→app.app_user | `-` |
| 23 | `cancelled_at` | `timestamp with time zone` | N | - | `-` |
| 24 | `cancelled_by` | `bigint` | N | FK→app.app_user | `-` |
| 25 | `cancellation_reason_code` | `app.code_t` | N | - | `-` |

### logistics.shipment_line — 출하 상세

출하 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `shipment_line_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shipment_line_id` | `bigint` | Y | PK | `-` |
| 2 | `shipment_id` | `bigint` | Y | FK→logistics.shipment | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `shipment_request_line_id` | `bigint` | Y | FK→logistics.shipment_request_line | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `shipped_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `goods_issue_line_id` | `bigint` | N | FK→logistics.goods_issue_line | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |

### logistics.shipment_lot_allocation — 출하 LOT 배분

출하 LOT 배분의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `shipment_lot_allocation_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shipment_lot_allocation_id` | `bigint` | Y | PK | `-` |
| 2 | `shipment_line_id` | `bigint` | Y | FK→logistics.shipment_line | `-` |
| 3 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 4 | `handling_unit_id` | `bigint` | N | FK→inventory.handling_unit | `-` |
| 5 | `allocated_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |

### logistics.shipment_request — 출하 요청

출하 요청의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `shipment_request_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shipment_request_id` | `bigint` | Y | PK | `-` |
| 2 | `shipment_request_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `customer_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 4 | `ship_to_partner_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 5 | `requested_ship_date` | `date` | Y | - | `-` |
| 6 | `status_code` | `app.code_t` | Y | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |
| 12 | `ship_time_slot_start` | `time without time zone` | N | - | `-` |
| 13 | `ship_time_slot_end` | `time without time zone` | N | - | `-` |
| 14 | `ship_time_slot_code` | `app.code_t` | N | - | `-` |

### logistics.shipment_request_line — 출하 요청 상세

출하 요청 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `shipment_request_line_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shipment_request_line_id` | `bigint` | Y | PK | `-` |
| 2 | `shipment_request_id` | `bigint` | Y | FK→logistics.shipment_request | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `sales_order_line_id` | `bigint` | N | FK→logistics.sales_order_line | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `requested_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `allocated_qty` | `app.qty_t` | Y | - | `0` |
| 8 | `shipped_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 10 | `customer_lot_requirement` | `character varying(200)` | N | - | `-` |
| 11 | `shipping_inspection_required` | `boolean` | Y | - | `false` |
| 12 | `minimum_remaining_shelf_life_days` | `integer` | N | - | `-` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |
| 15 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `updated_by` | `bigint` | N | - | `-` |
| 17 | `version_no` | `integer` | Y | - | `1` |

### logistics.shopfloor_receipt — 현장 입고

현장 입고의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `shopfloor_receipt_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shopfloor_receipt_id` | `bigint` | Y | PK | `-` |
| 2 | `shopfloor_receipt_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `goods_issue_id` | `bigint` | Y | FK→logistics.goods_issue | `-` |
| 4 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 5 | `destination_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 6 | `received_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `received_by` | `bigint` | N | FK→app.app_user | `-` |
| 8 | `status_code` | `app.code_t` | Y | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### logistics.shopfloor_receipt_line — 현장 입고 상세

현장 입고 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `shopfloor_receipt_line_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shopfloor_receipt_line_id` | `bigint` | Y | PK | `-` |
| 2 | `shopfloor_receipt_id` | `bigint` | Y | FK→logistics.shopfloor_receipt | `-` |
| 3 | `goods_issue_line_id` | `bigint` | Y | FK→logistics.goods_issue_line | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 6 | `issued_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `received_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `variance_qty` | `numeric(20,6)` | N | - | `((issued_qty)::numeric - (received_qty)::numeric)` |
| 9 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 10 | `variance_reason_code` | `app.code_t` | N | - | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |

### logistics.stock_transfer — 재고이동 이동

재고이동 이동의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `stock_transfer_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `stock_transfer_id` | `bigint` | Y | PK | `-` |
| 2 | `stock_transfer_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `transfer_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `from_business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 5 | `to_business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 6 | `from_warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 7 | `to_warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 8 | `requested_at` | `timestamp with time zone` | Y | - | `-` |
| 9 | `shipped_at` | `timestamp with time zone` | N | - | `-` |
| 10 | `received_at` | `timestamp with time zone` | N | - | `-` |
| 11 | `status_code` | `app.code_t` | Y | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |
| 14 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `updated_by` | `bigint` | N | - | `-` |
| 16 | `version_no` | `integer` | Y | - | `1` |
| 17 | `reason_code` | `app.code_t` | N | - | `-` |
| 18 | `remarks` | `text` | N | - | `-` |

### logistics.stock_transfer_line — 재고이동 이동 상세

재고이동 이동 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `stock_transfer_line_id`
- 직접 외래키: 8개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `stock_transfer_line_id` | `bigint` | Y | PK | `-` |
| 2 | `stock_transfer_id` | `bigint` | Y | FK→logistics.stock_transfer | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 6 | `requested_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `shipped_qty` | `app.qty_t` | Y | - | `0` |
| 8 | `received_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 10 | `from_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 11 | `to_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 12 | `issue_transaction_line_id` | `bigint` | N | FK→inventory.inventory_transaction_line | `-` |
| 13 | `receipt_transaction_line_id` | `bigint` | N | FK→inventory.inventory_transaction_line | `-` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |

### logistics.subcontract_issue — 외주 출고

외주 출고의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `subcontract_issue_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `subcontract_issue_id` | `bigint` | Y | PK | `-` |
| 2 | `subcontract_order_id` | `bigint` | Y | FK→logistics.subcontract_order | `-` |
| 3 | `goods_issue_id` | `bigint` | Y | FK→logistics.goods_issue | `-` |
| 4 | `issued_at` | `timestamp with time zone` | Y | - | `-` |
| 5 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 6 | `created_by` | `bigint` | N | - | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `'COMPLETED'::character varying` |
| 8 | `version_no` | `integer` | Y | - | `1` |

### logistics.subcontract_order — 외주 지시

외주 지시의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `subcontract_order_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `subcontract_order_id` | `bigint` | Y | PK | `-` |
| 2 | `subcontract_order_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 4 | `partner_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 5 | `process_id` | `bigint` | Y | FK→mdm.process | `-` |
| 6 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 7 | `order_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `expected_return_date` | `date` | N | - | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |

### logistics.subcontract_receipt — 외주 입고

외주 입고의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `subcontract_receipt_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `subcontract_receipt_id` | `bigint` | Y | PK | `-` |
| 2 | `subcontract_order_id` | `bigint` | Y | FK→logistics.subcontract_order | `-` |
| 3 | `goods_receipt_id` | `bigint` | Y | FK→logistics.goods_receipt | `-` |
| 4 | `supplier_lot_no` | `character varying(100)` | N | - | `-` |
| 5 | `received_at` | `timestamp with time zone` | Y | - | `-` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |
| 8 | `status_code` | `app.code_t` | Y | - | `'COMPLETED'::character varying` |
| 9 | `version_no` | `integer` | Y | - | `1` |

### logistics.subcontract_reconciliation — 외주 RECONCILIATION

외주 RECONCILIATION의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `subcontract_reconciliation_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `subcontract_reconciliation_id` | `bigint` | Y | PK | `-` |
| 2 | `subcontract_order_id` | `bigint` | Y | FK→logistics.subcontract_order | `-` |
| 3 | `settlement_seq` | `integer` | Y | - | `-` |
| 4 | `reconciled_at` | `timestamp with time zone` | Y | - | `-` |
| 5 | `issued_qty` | `app.qty_t` | Y | - | `0` |
| 6 | `received_good_qty` | `app.qty_t` | Y | - | `0` |
| 7 | `received_defect_qty` | `app.qty_t` | Y | - | `0` |
| 8 | `scrap_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `lost_qty` | `app.qty_t` | Y | - | `0` |
| 10 | `adjusted_qty` | `app.qty_t` | Y | - | `0` |
| 11 | `remaining_qty` | `app.qty_t` | Y | - | `0` |
| 12 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 13 | `status_code` | `app.code_t` | Y | - | `-` |
| 14 | `confirmed_by` | `bigint` | N | FK→app.app_user | `-` |
| 15 | `confirmed_at` | `timestamp with time zone` | N | - | `-` |
| 16 | `remarks` | `text` | N | - | `-` |
| 17 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `created_by` | `bigint` | N | - | `-` |

## maintenance — 설비보전

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `maintenance.breakdown` | 고장 | TRANSACTION | 17 | `breakdown_id` | 2 | 고장의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.collection_channel` | 수집 채널 | TRANSACTION | 15 | `collection_channel_id` | 2 | 수집 채널의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.collection_observation` | 수집 관측 | EVENT | 9 | `collection_observation_id` | 1 | 수집 관측의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `maintenance.equipment_downtime` | 설비 비가동 | TRANSACTION | 10 | `equipment_downtime_id` | 3 | 설비 비가동의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.equipment_inspection` | 설비 검사 | TRANSACTION | 15 | `equipment_inspection_id` | 2 | 설비 검사의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.equipment_inspection_result` | 설비 검사 실적 | TRANSACTION | 10 | `equipment_inspection_result_id` | 2 | 설비 검사 실적의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.maintenance_order` | 보전 지시 | TRANSACTION | 16 | `maintenance_order_id` | 3 | 보전 지시의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.maintenance_order_item` | 보전 지시 품목 | TRANSACTION | 6 | `maintenance_order_item_id` | 2 | 보전지시 항목 라인. 기존 자유텍스트 itemNames 를 대체한다 — 항목을 세거나 상태를 항목별로 갖게 하려면 행이어야 한다. 근거: 이슈 #44 · #63. |
| `maintenance.maintenance_order_trigger` | 보전 지시 TRIGGER | TRANSACTION | 9 | `maintenance_order_trigger_id` | 1 | 보전지시를 발행시킨 트리거와 발행 시점 스냅샷. 보전지시 하나에 하나다. 근거: 이슈 #44 · #63 · 설계 회신 B-4. |
| `maintenance.maintenance_result` | 보전 실적 | TRANSACTION | 11 | `maintenance_result_id` | 2 | 보전 실적의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.planned_stop` | 계획 정지 | TRANSACTION | 12 | `planned_stop_id` | 2 | 계획 정지의 업무 진행 상태와 실행 결과를 관리한다. |
| `maintenance.tool_usage` | 툴 사용 | TRANSACTION | 10 | `tool_usage_id` | 4 | 툴 사용의 업무 진행 상태와 실행 결과를 관리한다. |

### maintenance.breakdown — 고장

고장의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `breakdown_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `breakdown_id` | `bigint` | Y | PK | `-` |
| 2 | `breakdown_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 4 | `reported_at` | `timestamp with time zone` | Y | - | `-` |
| 5 | `reported_by` | `bigint` | N | FK→app.app_user | `-` |
| 6 | `symptom_code` | `app.code_t` | N | - | `-` |
| 7 | `description` | `text` | Y | - | `-` |
| 8 | `severity_code` | `app.code_t` | Y | - | `-` |
| 9 | `status_code` | `app.code_t` | Y | - | `-` |
| 10 | `started_at` | `timestamp with time zone` | N | - | `-` |
| 11 | `completed_at` | `timestamp with time zone` | N | - | `-` |
| 12 | `root_cause` | `text` | N | - | `-` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |
| 15 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `updated_by` | `bigint` | N | - | `-` |
| 17 | `version_no` | `integer` | Y | - | `1` |

### maintenance.collection_channel — 수집 채널

수집 채널의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `collection_channel_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `collection_channel_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 3 | `channel_code` | `app.code_t` | Y | - | `-` |
| 4 | `channel_name` | `app.name_t` | Y | - | `-` |
| 5 | `data_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | N | FK→mdm.uom | `-` |
| 7 | `collection_interval_sec` | `integer` | N | - | `-` |
| 8 | `lower_limit` | `numeric(20,6)` | N | - | `-` |
| 9 | `upper_limit` | `numeric(20,6)` | N | - | `-` |
| 10 | `is_active` | `boolean` | Y | - | `true` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |

### maintenance.collection_observation — 수집 관측

수집 관측의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `collection_observation_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `collection_observation_id` | `bigint` | Y | PK | `-` |
| 2 | `collection_channel_id` | `bigint` | Y | FK→maintenance.collection_channel | `-` |
| 3 | `observed_at` | `timestamp with time zone` | Y | - | `-` |
| 4 | `numeric_value` | `numeric(20,6)` | N | - | `-` |
| 5 | `text_value` | `text` | N | - | `-` |
| 6 | `boolean_value` | `boolean` | N | - | `-` |
| 7 | `quality_code` | `app.code_t` | N | - | `-` |
| 8 | `source_message_id` | `character varying(200)` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### maintenance.equipment_downtime — 설비 비가동

설비 비가동의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `equipment_downtime_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_downtime_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 3 | `breakdown_id` | `bigint` | N | FK→maintenance.breakdown | `-` |
| 4 | `downtime_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `started_at` | `timestamp with time zone` | Y | - | `-` |
| 6 | `ended_at` | `timestamp with time zone` | N | - | `-` |
| 7 | `reason_code` | `app.code_t` | N | - | `-` |
| 8 | `closed_by` | `bigint` | N | FK→app.app_user | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |

### maintenance.equipment_inspection — 설비 검사

설비 검사의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `equipment_inspection_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_inspection_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 4 | `inspection_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `scheduled_at` | `timestamp with time zone` | N | - | `-` |
| 6 | `inspected_at` | `timestamp with time zone` | N | - | `-` |
| 7 | `inspected_by` | `bigint` | N | FK→mdm.worker | `-` |
| 8 | `judgment_code` | `app.code_t` | N | - | `-` |
| 9 | `status_code` | `app.code_t` | Y | - | `-` |
| 10 | `remarks` | `text` | N | - | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |

### maintenance.equipment_inspection_result — 설비 검사 실적

설비 검사 실적의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `equipment_inspection_result_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_inspection_result_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_inspection_id` | `bigint` | Y | FK→maintenance.equipment_inspection | `-` |
| 3 | `equipment_inspection_item_id` | `bigint` | Y | FK→mdm.equipment_inspection_item | `-` |
| 4 | `numeric_value` | `numeric(20,6)` | N | - | `-` |
| 5 | `text_value` | `text` | N | - | `-` |
| 6 | `boolean_value` | `boolean` | N | - | `-` |
| 7 | `judgment_code` | `app.code_t` | Y | - | `-` |
| 8 | `remarks` | `text` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |

### maintenance.maintenance_order — 보전 지시

보전 지시의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `maintenance_order_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `maintenance_order_id` | `bigint` | Y | PK | `-` |
| 2 | `maintenance_order_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 4 | `breakdown_id` | `bigint` | N | FK→maintenance.breakdown | `-` |
| 5 | `order_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `priority_code` | `app.code_t` | Y | - | `-` |
| 7 | `scheduled_start_at` | `timestamp with time zone` | N | - | `-` |
| 8 | `scheduled_end_at` | `timestamp with time zone` | N | - | `-` |
| 9 | `assigned_worker_id` | `bigint` | N | FK→mdm.worker | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `cancellation_reason_code` | `app.code_t` | N | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |
| 14 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `updated_by` | `bigint` | N | - | `-` |
| 16 | `version_no` | `integer` | Y | - | `1` |

### maintenance.maintenance_order_item — 보전 지시 품목

보전지시 항목 라인. 기존 자유텍스트 itemNames 를 대체한다 — 항목을 세거나 상태를 항목별로 갖게 하려면 행이어야 한다. 근거: 이슈 #44 · #63.

- 유형: `TRANSACTION`
- 기본키: `maintenance_order_item_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `maintenance_order_item_id` | `bigint` | Y | PK | `-` |
| 2 | `maintenance_order_id` | `bigint` | Y | FK→maintenance.maintenance_order | `-` |
| 3 | `sequence_no` | `integer` | Y | - | `-` |
| 4 | `inspection_item_id` | `bigint` | N | FK→mdm.equipment_inspection_item | `-` |
| 5 | `item_name` | `app.name_t` | N | - | `-` |
| 6 | `status_code` | `app.code_t` | Y | - | `-` |

### maintenance.maintenance_order_trigger — 보전 지시 TRIGGER

보전지시를 발행시킨 트리거와 발행 시점 스냅샷. 보전지시 하나에 하나다. 근거: 이슈 #44 · #63 · 설계 회신 B-4.

- 유형: `TRANSACTION`
- 기본키: `maintenance_order_trigger_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `maintenance_order_trigger_id` | `bigint` | Y | PK | `-` |
| 2 | `maintenance_order_id` | `bigint` | Y | FK→maintenance.maintenance_order | `-` |
| 3 | `trigger_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `source_id` | `bigint` | N | - | `-` |
| 5 | `snapshot_note` | `text` | N | - | `-` |
| 6 | `pm_due_axis_code` | `app.code_t` | N | - | `-` |
| 7 | `shot_count_at_due` | `integer` | N | - | `-` |
| 8 | `guaranteed_shot_count_at_due` | `integer` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### maintenance.maintenance_result — 보전 실적

보전 실적의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `maintenance_result_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `maintenance_result_id` | `bigint` | Y | PK | `-` |
| 2 | `maintenance_order_id` | `bigint` | Y | FK→maintenance.maintenance_order | `-` |
| 3 | `result_seq` | `integer` | Y | - | `-` |
| 4 | `action_code` | `app.code_t` | Y | - | `-` |
| 5 | `action_description` | `text` | Y | - | `-` |
| 6 | `started_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `completed_at` | `timestamp with time zone` | Y | - | `-` |
| 8 | `performed_by` | `bigint` | N | FK→mdm.worker | `-` |
| 9 | `result_code` | `app.code_t` | Y | - | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |

### maintenance.planned_stop — 계획 정지

계획 정지의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `planned_stop_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `planned_stop_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 3 | `production_line_id` | `bigint` | N | FK→mdm.production_line | `-` |
| 4 | `stop_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `planned_start_at` | `timestamp with time zone` | Y | - | `-` |
| 6 | `planned_end_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `reason` | `text` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### maintenance.tool_usage — 툴 사용

툴 사용의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `tool_usage_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `tool_usage_id` | `bigint` | Y | PK | `-` |
| 2 | `mold_id` | `bigint` | Y | FK→mdm.mold | `-` |
| 3 | `equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 4 | `work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 5 | `usage_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `shot_count` | `bigint` | N | - | `-` |
| 7 | `used_from` | `timestamp with time zone` | Y | - | `-` |
| 8 | `used_to` | `timestamp with time zone` | N | - | `-` |
| 9 | `recorded_by` | `bigint` | N | FK→mdm.worker | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

## mdm — 기준정보

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `mdm.business_unit` | 사업 단위 | MASTER | 10 | `business_unit_id` | 1 | 사업 단위의 업무 기준과 유효 상태를 관리한다. |
| `mdm.code_group` | 코드 그룹 | MASTER | 11 | `code_group_id` | 0 | 코드 그룹의 업무 기준과 유효 상태를 관리한다. |
| `mdm.code_value` | 코드 값 | MASTER | 15 | `code_value_id` | 1 | 코드 값의 업무 기준과 유효 상태를 관리한다. |
| `mdm.department` | 부서 | MASTER | 14 | `department_id` | 2 | 부서의 업무 기준과 유효 상태를 관리한다. |
| `mdm.equipment` | 설비 | MASTER | 18 | `equipment_id` | 4 | 설비의 업무 기준과 유효 상태를 관리한다. |
| `mdm.equipment_group` | 설비 그룹 | MASTER | 10 | `equipment_group_id` | 1 | 설비 그룹의 업무 기준과 유효 상태를 관리한다. |
| `mdm.equipment_group_inspection_item` | 설비 그룹 검사 품목 | MASTER | 7 | `equipment_group_inspection_item_id` | 2 | 설비 그룹 검사 품목의 업무 기준과 유효 상태를 관리한다. |
| `mdm.equipment_group_member` | 설비 그룹 구성원 | MASTER | 7 | `equipment_group_member_id` | 2 | 설비 그룹 구성원의 업무 기준과 유효 상태를 관리한다. |
| `mdm.equipment_inspection_item` | 설비 검사 품목 | MASTER | 14 | `equipment_inspection_item_id` | 1 | 설비 검사 품목의 업무 기준과 유효 상태를 관리한다. |
| `mdm.equipment_inspection_item_assignment` | 설비 검사 품목 배정 | MASTER | 7 | `equipment_inspection_item_assignment_id` | 2 | 설비 검사 품목 배정의 업무 기준과 유효 상태를 관리한다. |
| `mdm.item` | 품목 | MASTER | 25 | `item_id` | 2 | 품목의 업무 기준과 유효 상태를 관리한다. |
| `mdm.item_bu_item_map` | 품목 BU 품목 매핑 | MASTER | 9 | `item_bu_item_map_id` | 4 | 품목 BU 품목 매핑의 업무 기준과 유효 상태를 관리한다. |
| `mdm.item_external_code` | 품목 외부 코드 | MASTER | 7 | `item_external_code_id` | 2 | 품목 외부 코드의 업무 기준과 유효 상태를 관리한다. |
| `mdm.item_uom_conversion` | 품목 단위 CONVERSION | MASTER | 9 | `item_uom_conversion_id` | 3 | 품목 단위 CONVERSION의 업무 기준과 유효 상태를 관리한다. |
| `mdm.judgment_type_control` | JUDGMENT 유형 CONTROL | MASTER | 12 | `code_value_id` | 2 | 판정유형(JUDGMENT_TYPE 코드값)의 통제 속성. 코드값과 1:1 이며 PK 가 code_value_id 다. 값이 출고·출하·피킹을 막고 결재를 태우므로 G-31 마스터안전형이 아니다 — 그룹을 시스템 소유로 잠갔다. 근거: 이슈 #42 §I-11 · 설계 회신 E-1. |
| `mdm.legal_entity` | 법인 ENTITY | MASTER | 11 | `legal_entity_id` | 0 | 법인 ENTITY의 업무 기준과 유효 상태를 관리한다. |
| `mdm.location` | 로케이션 | MASTER | 18 | `location_id` | 3 | 로케이션의 업무 기준과 유효 상태를 관리한다. |
| `mdm.mold` | 금형 | MASTER | 14 | `mold_id` | 1 | 금형의 업무 기준과 유효 상태를 관리한다. |
| `mdm.partner` | 거래처 | MASTER | 11 | `partner_id` | 0 | 거래처의 업무 기준과 유효 상태를 관리한다. |
| `mdm.partner_role` | 거래처 역할 | MASTER | 5 | `partner_role_id` | 1 | 거래처 역할의 업무 기준과 유효 상태를 관리한다. |
| `mdm.plant` | 공장 | MASTER | 12 | `plant_id` | 2 | 공장의 업무 기준과 유효 상태를 관리한다. |
| `mdm.process` | 공정 | MASTER | 10 | `process_id` | 0 | 공정의 업무 기준과 유효 상태를 관리한다. |
| `mdm.production_line` | 생산 상세 | MASTER | 12 | `production_line_id` | 2 | 생산 상세의 업무 기준과 유효 상태를 관리한다. |
| `mdm.shift` | 교대 | MASTER | 13 | `shift_id` | 1 | 교대의 업무 기준과 유효 상태를 관리한다. |
| `mdm.spare_part` | 예비 PART | MASTER | 12 | `spare_part_id` | 2 | 예비 PART의 업무 기준과 유효 상태를 관리한다. |
| `mdm.spare_part_equipment` | 예비 PART 설비 | MASTER | 6 | `spare_part_equipment_id` | 2 | 예비 PART 설비의 업무 기준과 유효 상태를 관리한다. |
| `mdm.terminal` | 단말 | MASTER | 15 | `terminal_id` | 3 | 단말의 업무 기준과 유효 상태를 관리한다. |
| `mdm.terminal_process` | 단말 공정 | MASTER | 13 | `terminal_process_id` | 2 | 단말 공정의 업무 기준과 유효 상태를 관리한다. |
| `mdm.uom` | 단위 | MASTER | 10 | `uom_id` | 0 | 단위의 업무 기준과 유효 상태를 관리한다. |
| `mdm.warehouse` | 창고 | MASTER | 16 | `warehouse_id` | 3 | 창고의 업무 기준과 유효 상태를 관리한다. |
| `mdm.warehouse_layout` | 창고 레이아웃 | MASTER | 11 | `warehouse_layout_id` | 1 | 창고 레이아웃의 업무 기준과 유효 상태를 관리한다. |
| `mdm.work_calendar` | 작업 달력 | MASTER | 11 | `work_calendar_id` | 1 | 작업 달력의 업무 기준과 유효 상태를 관리한다. |
| `mdm.work_calendar_application` | 작업 달력 적용 | MASTER | 8 | `work_calendar_application_id` | 1 | 작업 달력 적용의 업무 기준과 유효 상태를 관리한다. |
| `mdm.work_calendar_day` | 작업 달력 일자 | MASTER | 9 | `work_calendar_day_id` | 1 | 작업 달력 일자의 업무 기준과 유효 상태를 관리한다. |
| `mdm.worker` | 작업자 | MASTER | 16 | `worker_id` | 4 | 작업자의 업무 기준과 유효 상태를 관리한다. |
| `mdm.worker_qualification` | 작업자 자격 | MASTER | 10 | `worker_qualification_id` | 2 | 작업자 자격의 업무 기준과 유효 상태를 관리한다. |

### mdm.business_unit — 사업 단위

사업 단위의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `business_unit_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `business_unit_id` | `bigint` | Y | PK | `-` |
| 2 | `legal_entity_id` | `bigint` | Y | FK→mdm.legal_entity | `-` |
| 3 | `business_unit_code` | `app.code_t` | Y | - | `-` |
| 4 | `business_unit_name` | `app.name_t` | Y | - | `-` |
| 5 | `is_active` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |
| 8 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `updated_by` | `bigint` | N | - | `-` |
| 10 | `version_no` | `integer` | Y | - | `1` |

### mdm.code_group — 코드 그룹

코드 그룹의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `code_group_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `code_group_id` | `bigint` | Y | PK | `-` |
| 2 | `group_code` | `app.code_t` | Y | - | `-` |
| 3 | `group_name` | `app.name_t` | Y | - | `-` |
| 4 | `description` | `text` | N | - | `-` |
| 5 | `is_active` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |
| 8 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `updated_by` | `bigint` | N | - | `-` |
| 10 | `version_no` | `integer` | Y | - | `1` |
| 11 | `is_system_owned` | `boolean` | Y | - | `false` |

### mdm.code_value — 코드 값

코드 값의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `code_value_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `code_value_id` | `bigint` | Y | PK | `-` |
| 2 | `code_group_id` | `bigint` | Y | FK→mdm.code_group | `-` |
| 3 | `code` | `app.code_t` | Y | - | `-` |
| 4 | `code_name` | `app.name_t` | Y | - | `-` |
| 5 | `display_order` | `integer` | Y | - | `0` |
| 6 | `effective_from` | `date` | N | - | `-` |
| 7 | `effective_to` | `date` | N | - | `-` |
| 8 | `is_active` | `boolean` | Y | - | `true` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |
| 14 | `name_ko` | `app.name_t` | N | - | `-` |
| 15 | `name_vi` | `app.name_t` | N | - | `-` |

### mdm.department — 부서

부서의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `department_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `department_id` | `bigint` | Y | PK | `-` |
| 2 | `department_code` | `app.code_t` | Y | - | `-` |
| 3 | `department_name` | `app.name_t` | Y | - | `-` |
| 4 | `parent_department_id` | `bigint` | N | FK→mdm.department | `-` |
| 5 | `business_unit_id` | `bigint` | N | FK→mdm.business_unit | `-` |
| 6 | `is_active` | `boolean` | Y | - | `true` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |
| 12 | `name_ko` | `app.name_t` | N | - | `-` |
| 13 | `name_vi` | `app.name_t` | N | - | `-` |
| 14 | `source_system_code` | `app.code_t` | Y | - | `'MES'::character varying` |

### mdm.equipment — 설비

설비의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `equipment_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `equipment_code` | `app.code_t` | Y | - | `-` |
| 4 | `equipment_name` | `app.name_t` | Y | - | `-` |
| 5 | `equipment_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `process_id` | `bigint` | N | FK→mdm.process | `-` |
| 7 | `production_line_id` | `bigint` | N | FK→mdm.production_line | `-` |
| 8 | `status_code` | `app.code_t` | Y | - | `-` |
| 9 | `calibration_required` | `boolean` | Y | - | `false` |
| 10 | `last_calibration_date` | `date` | N | - | `-` |
| 11 | `calibration_due_date` | `date` | N | - | `-` |
| 12 | `is_active` | `boolean` | Y | - | `true` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |
| 15 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `updated_by` | `bigint` | N | - | `-` |
| 17 | `version_no` | `integer` | Y | - | `1` |
| 18 | `location_id` | `bigint` | N | FK→mdm.location | `-` |

### mdm.equipment_group — 설비 그룹

설비 그룹의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `equipment_group_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_group_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `equipment_group_code` | `app.code_t` | Y | - | `-` |
| 4 | `equipment_group_name` | `app.name_t` | Y | - | `-` |
| 5 | `is_active` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |
| 8 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `updated_by` | `bigint` | N | - | `-` |
| 10 | `version_no` | `integer` | Y | - | `1` |

### mdm.equipment_group_inspection_item — 설비 그룹 검사 품목

설비 그룹 검사 품목의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `equipment_group_inspection_item_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_group_inspection_item_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_group_id` | `bigint` | Y | FK→mdm.equipment_group | `-` |
| 3 | `equipment_inspection_item_id` | `bigint` | Y | FK→mdm.equipment_inspection_item | `-` |
| 4 | `display_order` | `integer` | Y | - | `100` |
| 5 | `is_required_override` | `boolean` | N | - | `-` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### mdm.equipment_group_member — 설비 그룹 구성원

설비 그룹 구성원의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `equipment_group_member_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_group_member_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_group_id` | `bigint` | Y | FK→mdm.equipment_group | `-` |
| 3 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 4 | `effective_from` | `date` | Y | - | `-` |
| 5 | `effective_to` | `date` | N | - | `-` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### mdm.equipment_inspection_item — 설비 검사 품목

설비 검사 품목의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `equipment_inspection_item_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_inspection_item_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_item_code` | `app.code_t` | Y | - | `-` |
| 3 | `inspection_item_name` | `app.name_t` | Y | - | `-` |
| 4 | `data_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `uom_id` | `bigint` | N | FK→mdm.uom | `-` |
| 6 | `lower_limit` | `numeric(20,6)` | N | - | `-` |
| 7 | `upper_limit` | `numeric(20,6)` | N | - | `-` |
| 8 | `is_required` | `boolean` | Y | - | `true` |
| 9 | `is_active` | `boolean` | Y | - | `true` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |
| 12 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `updated_by` | `bigint` | N | - | `-` |
| 14 | `version_no` | `integer` | Y | - | `1` |

### mdm.equipment_inspection_item_assignment — 설비 검사 품목 배정

설비 검사 품목 배정의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `equipment_inspection_item_assignment_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_inspection_item_assignment_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 3 | `equipment_inspection_item_id` | `bigint` | Y | FK→mdm.equipment_inspection_item | `-` |
| 4 | `display_order` | `integer` | Y | - | `100` |
| 5 | `is_required_override` | `boolean` | N | - | `-` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### mdm.item — 품목

품목의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `item_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `item_id` | `bigint` | Y | PK | `-` |
| 2 | `item_code` | `app.code_t` | Y | - | `-` |
| 3 | `item_name` | `app.name_t` | Y | - | `-` |
| 4 | `item_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `base_uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 6 | `lot_control_type_code` | `app.code_t` | Y | - | `-` |
| 7 | `serial_control_type_code` | `app.code_t` | Y | - | `'NONE'::character varying` |
| 8 | `shelf_life_days` | `integer` | N | - | `-` |
| 9 | `inspection_required` | `boolean` | Y | - | `false` |
| 10 | `fifo_policy_code` | `app.code_t` | Y | - | `'FIFO'::character varying` |
| 11 | `negative_stock_allowed` | `boolean` | Y | - | `false` |
| 12 | `storage_condition_code` | `app.code_t` | N | - | `-` |
| 13 | `opened_shelf_life_hours` | `integer` | N | - | `-` |
| 14 | `is_active` | `boolean` | Y | - | `true` |
| 15 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `created_by` | `bigint` | N | - | `-` |
| 17 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `updated_by` | `bigint` | N | - | `-` |
| 19 | `version_no` | `integer` | Y | - | `1` |
| 20 | `default_lot_storage_uom_id` | `bigint` | N | FK→mdm.uom | `-` |
| 21 | `default_production_lot_size` | `app.qty_t` | N | - | `-` |
| 22 | `is_development_item` | `boolean` | Y | - | `false` |
| 23 | `mes_category_code` | `app.code_t` | N | - | `-` |
| 24 | `name_ko` | `app.name_t` | N | - | `-` |
| 25 | `name_vi` | `app.name_t` | N | - | `-` |

### mdm.item_bu_item_map — 품목 BU 품목 매핑

품목 BU 품목 매핑의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `item_bu_item_map_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `item_bu_item_map_id` | `bigint` | Y | PK | `-` |
| 2 | `from_business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 3 | `from_item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `to_business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 5 | `to_item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `effective_from` | `date` | Y | - | `-` |
| 7 | `effective_to` | `date` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |

### mdm.item_external_code — 품목 외부 코드

품목 외부 코드의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `item_external_code_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `item_external_code_id` | `bigint` | Y | PK | `-` |
| 2 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 3 | `external_system_code` | `app.code_t` | Y | - | `-` |
| 4 | `partner_id` | `bigint` | N | FK→mdm.partner | `-` |
| 5 | `external_item_code` | `character varying(100)` | Y | - | `-` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### mdm.item_uom_conversion — 품목 단위 CONVERSION

품목 단위 CONVERSION의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `item_uom_conversion_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `item_uom_conversion_id` | `bigint` | Y | PK | `-` |
| 2 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 3 | `from_uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 4 | `to_uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 5 | `conversion_rate` | `app.rate_t` | Y | - | `-` |
| 6 | `effective_from` | `date` | Y | - | `-` |
| 7 | `effective_to` | `date` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |

### mdm.judgment_type_control — JUDGMENT 유형 CONTROL

판정유형(JUDGMENT_TYPE 코드값)의 통제 속성. 코드값과 1:1 이며 PK 가 code_value_id 다. 값이 출고·출하·피킹을 막고 결재를 태우므로 G-31 마스터안전형이 아니다 — 그룹을 시스템 소유로 잠갔다. 근거: 이슈 #42 §I-11 · 설계 회신 E-1.

- 유형: `MASTER`
- 기본키: `code_value_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `code_value_id` | `bigint` | Y | PK, FK→mdm.code_value | `-` |
| 2 | `blocks_issue` | `boolean` | Y | - | `false` |
| 3 | `blocks_shipment` | `boolean` | Y | - | `false` |
| 4 | `blocks_picking` | `boolean` | Y | - | `false` |
| 5 | `requires_approval` | `boolean` | Y | - | `false` |
| 6 | `approver_role_id` | `bigint` | N | FK→app.role | `-` |
| 7 | `lot_status_code` | `app.code_t` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### mdm.legal_entity — 법인 ENTITY

법인 ENTITY의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `legal_entity_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `legal_entity_id` | `bigint` | Y | PK | `-` |
| 2 | `legal_entity_code` | `app.code_t` | Y | - | `-` |
| 3 | `legal_entity_name` | `app.name_t` | Y | - | `-` |
| 4 | `country_code` | `character varying(3)` | Y | - | `-` |
| 5 | `timezone_code` | `character varying(64)` | Y | - | `-` |
| 6 | `is_active` | `boolean` | Y | - | `true` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |

### mdm.location — 로케이션

로케이션의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `location_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `location_id` | `bigint` | Y | PK | `-` |
| 2 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 3 | `parent_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 4 | `location_code` | `app.code_t` | Y | - | `-` |
| 5 | `location_name` | `app.name_t` | Y | - | `-` |
| 6 | `location_type_code` | `app.code_t` | Y | - | `-` |
| 7 | `quality_zone_code` | `app.code_t` | N | - | `-` |
| 8 | `storage_condition_code` | `app.code_t` | N | - | `-` |
| 9 | `allow_mixed_item` | `boolean` | Y | - | `true` |
| 10 | `allow_mixed_lot` | `boolean` | Y | - | `true` |
| 11 | `capacity_qty` | `app.qty_t` | N | - | `-` |
| 12 | `capacity_uom_id` | `bigint` | N | FK→mdm.uom | `-` |
| 13 | `is_active` | `boolean` | Y | - | `true` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |
| 16 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `updated_by` | `bigint` | N | - | `-` |
| 18 | `version_no` | `integer` | Y | - | `1` |

### mdm.mold — 금형

금형의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `mold_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `mold_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `mold_code` | `app.code_t` | Y | - | `-` |
| 4 | `mold_name` | `app.name_t` | Y | - | `-` |
| 5 | `cavity_count` | `integer` | Y | - | `1` |
| 6 | `guaranteed_shot_count` | `bigint` | N | - | `-` |
| 7 | `current_shot_count` | `bigint` | Y | - | `0` |
| 8 | `status_code` | `app.code_t` | Y | - | `-` |
| 9 | `is_active` | `boolean` | Y | - | `true` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |
| 12 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `updated_by` | `bigint` | N | - | `-` |
| 14 | `version_no` | `integer` | Y | - | `1` |

### mdm.partner — 거래처

거래처의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `partner_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `partner_id` | `bigint` | Y | PK | `-` |
| 2 | `partner_code` | `app.code_t` | Y | - | `-` |
| 3 | `partner_name` | `app.name_t` | Y | - | `-` |
| 4 | `country_code` | `character varying(3)` | N | - | `-` |
| 5 | `erp_partner_code` | `character varying(100)` | N | - | `-` |
| 6 | `is_active` | `boolean` | Y | - | `true` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |

### mdm.partner_role — 거래처 역할

거래처 역할의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `partner_role_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `partner_role_id` | `bigint` | Y | PK | `-` |
| 2 | `partner_id` | `bigint` | Y | FK→mdm.partner | `-` |
| 3 | `role_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 5 | `created_by` | `bigint` | N | - | `-` |

### mdm.plant — 공장

공장의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `plant_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `plant_id` | `bigint` | Y | PK | `-` |
| 2 | `legal_entity_id` | `bigint` | Y | FK→mdm.legal_entity | `-` |
| 3 | `business_unit_id` | `bigint` | N | FK→mdm.business_unit | `-` |
| 4 | `plant_code` | `app.code_t` | Y | - | `-` |
| 5 | `plant_name` | `app.name_t` | Y | - | `-` |
| 6 | `timezone_code` | `character varying(64)` | Y | - | `-` |
| 7 | `is_active` | `boolean` | Y | - | `true` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### mdm.process — 공정

공정의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `process_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `process_id` | `bigint` | Y | PK | `-` |
| 2 | `process_code` | `app.code_t` | Y | - | `-` |
| 3 | `process_name` | `app.name_t` | Y | - | `-` |
| 4 | `process_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `is_active` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |
| 8 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `updated_by` | `bigint` | N | - | `-` |
| 10 | `version_no` | `integer` | Y | - | `1` |

### mdm.production_line — 생산 상세

생산 상세의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `production_line_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `production_line_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `parent_line_id` | `bigint` | N | FK→mdm.production_line | `-` |
| 4 | `line_code` | `app.code_t` | Y | - | `-` |
| 5 | `line_name` | `app.name_t` | Y | - | `-` |
| 6 | `line_type_code` | `app.code_t` | Y | - | `'LINE'::character varying` |
| 7 | `is_active` | `boolean` | Y | - | `true` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### mdm.shift — 교대

교대의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `shift_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `shift_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `shift_code` | `app.code_t` | Y | - | `-` |
| 4 | `shift_name` | `app.name_t` | Y | - | `-` |
| 5 | `start_time` | `time without time zone` | Y | - | `-` |
| 6 | `end_time` | `time without time zone` | Y | - | `-` |
| 7 | `crosses_midnight` | `boolean` | Y | - | `false` |
| 8 | `is_active` | `boolean` | Y | - | `true` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### mdm.spare_part — 예비 PART

예비 PART의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `spare_part_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `spare_part_id` | `bigint` | Y | PK | `-` |
| 2 | `spare_part_code` | `app.code_t` | Y | - | `-` |
| 3 | `spare_part_name` | `app.name_t` | Y | - | `-` |
| 4 | `item_id` | `bigint` | N | FK→mdm.item | `-` |
| 5 | `base_uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 6 | `minimum_stock_qty` | `app.qty_t` | N | - | `-` |
| 7 | `is_active` | `boolean` | Y | - | `true` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### mdm.spare_part_equipment — 예비 PART 설비

예비 PART 설비의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `spare_part_equipment_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `spare_part_equipment_id` | `bigint` | Y | PK | `-` |
| 2 | `spare_part_id` | `bigint` | Y | FK→mdm.spare_part | `-` |
| 3 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 4 | `recommended_qty` | `app.qty_t` | N | - | `-` |
| 5 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 6 | `created_by` | `bigint` | N | - | `-` |

### mdm.terminal — 단말

단말의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `terminal_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `terminal_id` | `bigint` | Y | PK | `-` |
| 2 | `terminal_code` | `app.code_t` | Y | - | `-` |
| 3 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 4 | `location_id` | `bigint` | N | FK→mdm.location | `-` |
| 5 | `terminal_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `status_code` | `app.code_t` | Y | - | `-` |
| 7 | `is_active` | `boolean` | Y | - | `true` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |
| 13 | `token_version` | `integer` | Y | - | `1` |
| 14 | `equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 15 | `token_issued_at` | `timestamp with time zone` | N | - | `-` |

### mdm.terminal_process — 단말 공정

단말 공정의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `terminal_process_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `terminal_process_id` | `bigint` | Y | PK | `-` |
| 2 | `terminal_id` | `bigint` | Y | FK→mdm.terminal | `-` |
| 3 | `process_id` | `bigint` | Y | FK→mdm.process | `-` |
| 4 | `can_input_material` | `boolean` | Y | - | `false` |
| 5 | `can_input_result` | `boolean` | Y | - | `false` |
| 6 | `can_input_inspection` | `boolean` | Y | - | `false` |
| 7 | `can_print_label` | `boolean` | Y | - | `false` |
| 8 | `can_start_work` | `boolean` | Y | - | `false` |
| 9 | `can_complete_work` | `boolean` | Y | - | `false` |
| 10 | `can_cancel_input` | `boolean` | Y | - | `false` |
| 11 | `can_return_material` | `boolean` | Y | - | `false` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |

### mdm.uom — 단위

단위의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `uom_id`
- 직접 외래키: 0개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `uom_id` | `bigint` | Y | PK | `-` |
| 2 | `uom_code` | `app.code_t` | Y | - | `-` |
| 3 | `uom_name` | `app.name_t` | Y | - | `-` |
| 4 | `decimal_scale` | `smallint` | Y | - | `0` |
| 5 | `is_active` | `boolean` | Y | - | `true` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |
| 8 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `updated_by` | `bigint` | N | - | `-` |
| 10 | `version_no` | `integer` | Y | - | `1` |

### mdm.warehouse — 창고

창고의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `warehouse_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `warehouse_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 4 | `warehouse_code` | `app.code_t` | Y | - | `-` |
| 5 | `warehouse_name` | `app.name_t` | Y | - | `-` |
| 6 | `warehouse_type_code` | `app.code_t` | Y | - | `-` |
| 7 | `management_level_code` | `app.code_t` | Y | - | `-` |
| 8 | `is_external` | `boolean` | Y | - | `false` |
| 9 | `partner_id` | `bigint` | N | FK→mdm.partner | `-` |
| 10 | `is_active` | `boolean` | Y | - | `true` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |
| 16 | `is_defect` | `boolean` | Y | - | `false` |

### mdm.warehouse_layout — 창고 레이아웃

창고 레이아웃의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `warehouse_layout_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `warehouse_layout_id` | `bigint` | Y | PK | `-` |
| 2 | `warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 3 | `layout_version` | `integer` | Y | - | `-` |
| 4 | `layout_data` | `jsonb` | Y | - | `-` |
| 5 | `status_code` | `app.code_t` | Y | - | `'DRAFT'::character varying` |
| 6 | `effective_from` | `timestamp with time zone` | N | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |

### mdm.work_calendar — 작업 달력

작업 달력의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `work_calendar_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_calendar_id` | `bigint` | Y | PK | `-` |
| 2 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 3 | `calendar_code` | `app.code_t` | Y | - | `-` |
| 4 | `calendar_name` | `app.name_t` | Y | - | `-` |
| 5 | `timezone_name` | `character varying(100)` | Y | - | `-` |
| 6 | `is_active` | `boolean` | Y | - | `true` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |

### mdm.work_calendar_application — 작업 달력 적용

작업 달력 적용의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `work_calendar_application_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_calendar_application_id` | `bigint` | Y | PK | `-` |
| 2 | `work_calendar_id` | `bigint` | Y | FK→mdm.work_calendar | `-` |
| 3 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `target_id` | `bigint` | Y | - | `-` |
| 5 | `effective_from` | `date` | Y | - | `-` |
| 6 | `effective_to` | `date` | N | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |

### mdm.work_calendar_day — 작업 달력 일자

작업 달력 일자의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `work_calendar_day_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_calendar_day_id` | `bigint` | Y | PK | `-` |
| 2 | `work_calendar_id` | `bigint` | Y | FK→mdm.work_calendar | `-` |
| 3 | `calendar_date` | `date` | Y | - | `-` |
| 4 | `day_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `work_start_time` | `time without time zone` | N | - | `-` |
| 6 | `work_end_time` | `time without time zone` | N | - | `-` |
| 7 | `remarks` | `text` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |

### mdm.worker — 작업자

작업자의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `worker_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `worker_id` | `bigint` | Y | PK | `-` |
| 2 | `worker_no` | `app.code_t` | Y | - | `-` |
| 3 | `worker_name` | `app.name_t` | Y | - | `-` |
| 4 | `business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 5 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 6 | `department_id` | `bigint` | N | FK→mdm.department | `-` |
| 7 | `app_user_id` | `bigint` | N | FK→app.app_user | `-` |
| 8 | `status_code` | `app.code_t` | Y | - | `-` |
| 9 | `is_active` | `boolean` | Y | - | `true` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |
| 12 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `updated_by` | `bigint` | N | - | `-` |
| 14 | `version_no` | `integer` | Y | - | `1` |
| 15 | `name_ko` | `app.name_t` | N | - | `-` |
| 16 | `name_vi` | `app.name_t` | N | - | `-` |

### mdm.worker_qualification — 작업자 자격

작업자 자격의 업무 기준과 유효 상태를 관리한다.

- 유형: `MASTER`
- 기본키: `worker_qualification_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `worker_qualification_id` | `bigint` | Y | PK | `-` |
| 2 | `worker_id` | `bigint` | Y | FK→mdm.worker | `-` |
| 3 | `qualification_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `process_id` | `bigint` | N | FK→mdm.process | `-` |
| 5 | `certificate_no` | `character varying(100)` | N | - | `-` |
| 6 | `valid_from` | `date` | Y | - | `-` |
| 7 | `valid_to` | `date` | N | - | `-` |
| 8 | `certified_by` | `bigint` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |

## planning — 계획

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `planning.bom` | BOM | TRANSACTION | 15 | `bom_id` | 2 | BOM의 업무 진행 상태와 실행 결과를 관리한다. |
| `planning.bom_component` | BOM 구성품 | TRANSACTION | 17 | `bom_component_id` | 5 | BOM 구성품의 업무 진행 상태와 실행 결과를 관리한다. |
| `planning.material_substitution_rule` | 자재 대체 규칙 | TRANSACTION | 11 | `substitution_rule_id` | 3 | 자재 대체 규칙의 업무 진행 상태와 실행 결과를 관리한다. |
| `planning.production_order` | 생산 지시 | TRANSACTION | 19 | `production_order_id` | 5 | 생산 지시의 업무 진행 상태와 실행 결과를 관리한다. |
| `planning.production_order_change_field` | 생산 지시 CHANGE FIELD | TRANSACTION | 6 | `production_order_change_field_id` | 1 | ERP 가 보낸 마지막 P/O 변경에서 바뀐 항목별 「변경 전」 값. 수신 시각은 planning.production_order.last_change_received_at 이 갖는다. 행이 없으면 열거한 세 항목(수량·납기·상태) 밖이 바뀐 것이다 — 계약이 빈 배열을 허용한다. 근거: 이슈 #73. |
| `planning.production_plan` | 생산 계획 | TRANSACTION | 18 | `production_plan_id` | 6 | 생산 계획의 업무 진행 상태와 실행 결과를 관리한다. |
| `planning.routing` | 라우팅 | TRANSACTION | 13 | `routing_id` | 1 | 라우팅의 업무 진행 상태와 실행 결과를 관리한다. |
| `planning.routing_operation` | 라우팅 공정 | TRANSACTION | 22 | `routing_operation_id` | 2 | 라우팅 공정의 업무 진행 상태와 실행 결과를 관리한다. |
| `planning.routing_operation_dependency` | 라우팅 공정 선후행 | TRANSACTION | 6 | `routing_operation_dependency_id` | 2 | 라우팅 공정 선후행의 업무 진행 상태와 실행 결과를 관리한다. |

### planning.bom — BOM

BOM의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `bom_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `bom_id` | `bigint` | Y | PK | `-` |
| 2 | `parent_item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 3 | `bom_code` | `app.code_t` | Y | - | `-` |
| 4 | `bom_version` | `integer` | Y | - | `-` |
| 5 | `status_code` | `app.code_t` | Y | - | `-` |
| 6 | `is_default` | `boolean` | Y | - | `false` |
| 7 | `effective_from` | `date` | Y | - | `-` |
| 8 | `effective_to` | `date` | N | - | `-` |
| 9 | `base_qty` | `app.qty_t` | Y | - | `-` |
| 10 | `base_uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |

### planning.bom_component — BOM 구성품

BOM 구성품의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `bom_component_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `bom_component_id` | `bigint` | Y | PK | `-` |
| 2 | `bom_id` | `bigint` | Y | FK→planning.bom | `-` |
| 3 | `component_item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `routing_operation_id` | `bigint` | N | FK→planning.routing_operation | `-` |
| 5 | `actual_use_process_id` | `bigint` | N | FK→mdm.process | `-` |
| 6 | `required_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `scrap_rate` | `numeric(9,6)` | Y | - | `0` |
| 9 | `is_mandatory` | `boolean` | Y | - | `true` |
| 10 | `lot_trace_required` | `boolean` | Y | - | `false` |
| 11 | `backflush_allowed` | `boolean` | Y | - | `false` |
| 12 | `sequence_no` | `integer` | Y | - | `1` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |
| 15 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `updated_by` | `bigint` | N | - | `-` |
| 17 | `version_no` | `integer` | Y | - | `1` |

### planning.material_substitution_rule — 자재 대체 규칙

자재 대체 규칙의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `substitution_rule_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `substitution_rule_id` | `bigint` | Y | PK | `-` |
| 2 | `bom_component_id` | `bigint` | Y | FK→planning.bom_component | `-` |
| 3 | `substitute_item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `priority_no` | `integer` | Y | - | `1` |
| 5 | `max_substitute_qty` | `app.qty_t` | N | - | `-` |
| 6 | `approval_required` | `boolean` | Y | - | `true` |
| 7 | `customer_restriction_id` | `bigint` | N | FK→mdm.partner | `-` |
| 8 | `effective_from` | `date` | Y | - | `-` |
| 9 | `effective_to` | `date` | N | - | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |

### planning.production_order — 생산 지시

생산 지시의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `production_order_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `production_order_id` | `bigint` | Y | PK | `-` |
| 2 | `production_order_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `erp_order_no` | `character varying(100)` | N | - | `-` |
| 4 | `parent_production_order_id` | `bigint` | N | FK→planning.production_order | `-` |
| 5 | `bom_level` | `smallint` | Y | - | `0` |
| 6 | `business_unit_id` | `bigint` | Y | FK→mdm.business_unit | `-` |
| 7 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 8 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 9 | `order_qty` | `app.qty_t` | Y | - | `-` |
| 10 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 11 | `due_date` | `date` | N | - | `-` |
| 12 | `status_code` | `app.code_t` | Y | - | `-` |
| 13 | `remarks` | `text` | N | - | `-` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |
| 16 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `updated_by` | `bigint` | N | - | `-` |
| 18 | `version_no` | `integer` | Y | - | `1` |
| 19 | `last_change_received_at` | `timestamp with time zone` | N | - | `-` |

### planning.production_order_change_field — 생산 지시 CHANGE FIELD

ERP 가 보낸 마지막 P/O 변경에서 바뀐 항목별 「변경 전」 값. 수신 시각은 planning.production_order.last_change_received_at 이 갖는다. 행이 없으면 열거한 세 항목(수량·납기·상태) 밖이 바뀐 것이다 — 계약이 빈 배열을 허용한다. 근거: 이슈 #73.

- 유형: `TRANSACTION`
- 기본키: `production_order_change_field_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `production_order_change_field_id` | `bigint` | Y | PK | `-` |
| 2 | `production_order_id` | `bigint` | Y | FK→planning.production_order | `-` |
| 3 | `field_code` | `app.code_t` | Y | - | `-` |
| 4 | `before_order_qty` | `app.qty_t` | N | - | `-` |
| 5 | `before_due_date` | `date` | N | - | `-` |
| 6 | `before_status_code` | `app.code_t` | N | - | `-` |

### planning.production_plan — 생산 계획

생산 계획의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `production_plan_id`
- 직접 외래키: 6개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `production_plan_id` | `bigint` | Y | PK | `-` |
| 2 | `production_order_id` | `bigint` | Y | FK→planning.production_order | `-` |
| 3 | `plan_no` | `app.business_no_t` | Y | - | `-` |
| 4 | `plan_date` | `date` | Y | - | `-` |
| 5 | `planned_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `bom_id` | `bigint` | Y | FK→planning.bom | `-` |
| 8 | `routing_id` | `bigint` | Y | FK→planning.routing | `-` |
| 9 | `planned_line_id` | `bigint` | N | FK→mdm.production_line | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `confirmed_at` | `timestamp with time zone` | N | - | `-` |
| 12 | `confirmed_by` | `bigint` | N | FK→app.app_user | `-` |
| 13 | `remarks` | `text` | N | - | `-` |
| 14 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 15 | `created_by` | `bigint` | N | - | `-` |
| 16 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `updated_by` | `bigint` | N | - | `-` |
| 18 | `version_no` | `integer` | Y | - | `1` |

### planning.routing — 라우팅

라우팅의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `routing_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `routing_id` | `bigint` | Y | PK | `-` |
| 2 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 3 | `routing_code` | `app.code_t` | Y | - | `-` |
| 4 | `routing_version` | `integer` | Y | - | `-` |
| 5 | `status_code` | `app.code_t` | Y | - | `-` |
| 6 | `effective_from` | `date` | Y | - | `-` |
| 7 | `effective_to` | `date` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |
| 13 | `is_default` | `boolean` | Y | - | `false` |

### planning.routing_operation — 라우팅 공정

라우팅 공정의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `routing_operation_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `routing_operation_id` | `bigint` | Y | PK | `-` |
| 2 | `routing_id` | `bigint` | Y | FK→planning.routing | `-` |
| 3 | `operation_seq` | `integer` | Y | - | `-` |
| 4 | `process_id` | `bigint` | Y | FK→mdm.process | `-` |
| 5 | `operation_name` | `app.name_t` | Y | - | `-` |
| 6 | `mes_managed` | `boolean` | Y | - | `true` |
| 7 | `material_input_managed` | `boolean` | Y | - | `false` |
| 8 | `production_result_managed` | `boolean` | Y | - | `true` |
| 9 | `inspection_managed` | `boolean` | Y | - | `false` |
| 10 | `output_lot_required` | `boolean` | Y | - | `false` |
| 11 | `equipment_required` | `boolean` | Y | - | `false` |
| 12 | `mold_required` | `boolean` | Y | - | `false` |
| 13 | `standard_cycle_time_sec` | `numeric(18,6)` | N | - | `-` |
| 14 | `standard_yield_rate` | `numeric(9,6)` | N | - | `-` |
| 15 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `created_by` | `bigint` | N | - | `-` |
| 17 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `updated_by` | `bigint` | N | - | `-` |
| 19 | `version_no` | `integer` | Y | - | `1` |
| 20 | `is_subcontract` | `boolean` | Y | - | `false` |
| 21 | `name_ko` | `app.name_t` | N | - | `-` |
| 22 | `name_vi` | `app.name_t` | N | - | `-` |

### planning.routing_operation_dependency — 라우팅 공정 선후행

라우팅 공정 선후행의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `routing_operation_dependency_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `routing_operation_dependency_id` | `bigint` | Y | PK | `-` |
| 2 | `predecessor_operation_id` | `bigint` | Y | FK→planning.routing_operation | `-` |
| 3 | `successor_operation_id` | `bigint` | Y | FK→planning.routing_operation | `-` |
| 4 | `dependency_type_code` | `app.code_t` | Y | - | `'FINISH_TO_START'::character varying` |
| 5 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 6 | `created_by` | `bigint` | N | - | `-` |

## production — 생산실행

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `production.material_consumption` | 자재 소비 | TRANSACTION | 31 | `material_consumption_id` | 13 | 자재 소비의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.material_loss` | 자재 손실 | TRANSACTION | 12 | `material_loss_id` | 5 | 자재 손실의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.material_return` | 자재 반납 | TRANSACTION | 13 | `material_return_id` | 3 | 자재 반납의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.material_return_line` | 자재 반납 상세 | DETAIL | 13 | `material_return_line_id` | 5 | 자재 반납 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `production.material_usage_allocation` | 자재 사용 배분 | DETAIL | 12 | `material_usage_allocation_id` | 4 | 자재 사용 배분의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `production.operation_handover` | 공정 인계 | TRANSACTION | 12 | `operation_handover_id` | 2 | 공정 인계의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.operation_handover_line` | 공정 인계 상세 | DETAIL | 11 | `operation_handover_line_id` | 5 | 공정 인계 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `production.precheck_decision` | PRECHECK 판정 | TRANSACTION | 11 | `precheck_decision_id` | 4 | 작업 전 점검 판정. 작업지시를 설비에 걸기 전 점검 상태를 보고 통과·차단·경고·우회를 정한 기록이다. 근거: P-02-02 §5-8. |
| `production.production_order_acknowledgement` | 생산 지시 확인응답 | TRANSACTION | 12 | `production_order_acknowledgement_id` | 3 | 생산 지시 확인응답의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.production_result` | 생산 실적 | TRANSACTION | 29 | `production_result_id` | 9 | 생산 실적의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.production_result_lot_allocation` | 생산 실적 LOT 배분 | DETAIL | 7 | `production_result_lot_allocation_id` | 3 | 생산 실적 LOT 배분의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `production.repair_execution` | REPAIR EXECUTION | TRANSACTION | 13 | `repair_execution_id` | 6 | 수리 투입·반출 기록. 원 불량(quality.defect_record)은 기록 전용이라 갱신하지 않고 여기에 쌓는다. 근거: M-02-02 §5-4. |
| `production.work_order` | 작업 지시 | TRANSACTION | 38 | `work_order_id` | 16 | 작업 지시의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.work_order_dependency` | 작업 지시 선후행 | TRANSACTION | 7 | `work_order_dependency_id` | 2 | 작업 지시 선후행의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.work_order_resource_assignment` | 작업 지시 RESOURCE 배정 | TRANSACTION | 15 | `work_order_resource_assignment_id` | 5 | 작업 지시 RESOURCE 배정의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.work_session` | 작업 세션 | TRANSACTION | 18 | `work_session_id` | 5 | 작업 세션의 업무 진행 상태와 실행 결과를 관리한다. |
| `production.work_session_event` | 작업 세션 이력 | EVENT | 8 | `work_session_event_id` | 3 | 작업 세션 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `production.work_session_worker` | 작업 세션 작업자 | TRANSACTION | 8 | `work_session_worker_id` | 2 | 작업 세션 작업자의 업무 진행 상태와 실행 결과를 관리한다. |

### production.material_consumption — 자재 소비

자재 소비의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `material_consumption_id`
- 직접 외래키: 13개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `material_consumption_id` | `bigint` | Y | PK | `-` |
| 2 | `consumption_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 4 | `work_session_id` | `bigint` | N | FK→production.work_session | `-` |
| 5 | `shopfloor_receipt_line_id` | `bigint` | N | FK→logistics.shopfloor_receipt_line | `-` |
| 6 | `bom_component_id` | `bigint` | N | FK→planning.bom_component | `-` |
| 7 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 8 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 9 | `consumption_type_code` | `app.code_t` | Y | - | `-` |
| 10 | `corrects_consumption_id` | `bigint` | N | FK→production.material_consumption | `-` |
| 11 | `replaced_consumption_id` | `bigint` | N | FK→production.material_consumption | `-` |
| 12 | `change_reason_code` | `app.code_t` | N | - | `-` |
| 13 | `actual_use_process_id` | `bigint` | N | FK→mdm.process | `-` |
| 14 | `input_qty` | `app.qty_t` | Y | - | `-` |
| 15 | `actual_consumed_qty` | `app.qty_t` | Y | - | `0` |
| 16 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 17 | `entered_qty` | `app.qty_t` | N | - | `-` |
| 18 | `entered_uom_id` | `bigint` | N | FK→mdm.uom | `-` |
| 19 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 20 | `recorded_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 21 | `late_entry_reason_code` | `app.code_t` | N | - | `-` |
| 22 | `worker_id` | `bigint` | Y | FK→mdm.worker | `-` |
| 23 | `terminal_id` | `bigint` | Y | FK→mdm.terminal | `-` |
| 24 | `status_code` | `app.code_t` | Y | - | `-` |
| 25 | `idempotency_key` | `character varying(150)` | Y | - | `-` |
| 26 | `remarks` | `text` | N | - | `-` |
| 27 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 28 | `created_by` | `bigint` | N | - | `-` |
| 29 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 30 | `updated_by` | `bigint` | N | - | `-` |
| 31 | `version_no` | `integer` | Y | - | `1` |

### production.material_loss — 자재 손실

자재 손실의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `material_loss_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `material_loss_id` | `bigint` | Y | PK | `-` |
| 2 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 3 | `material_consumption_id` | `bigint` | Y | FK→production.material_consumption | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 6 | `loss_type_code` | `app.code_t` | Y | - | `-` |
| 7 | `loss_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `reason_code` | `app.code_t` | Y | - | `-` |
| 10 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |

### production.material_return — 자재 반납

자재 반납의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `material_return_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `material_return_id` | `bigint` | Y | PK | `-` |
| 2 | `material_return_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 4 | `source_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 5 | `destination_warehouse_id` | `bigint` | Y | FK→mdm.warehouse | `-` |
| 6 | `status_code` | `app.code_t` | Y | - | `-` |
| 7 | `requested_at` | `timestamp with time zone` | Y | - | `-` |
| 8 | `received_at` | `timestamp with time zone` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |
| 11 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `updated_by` | `bigint` | N | - | `-` |
| 13 | `version_no` | `integer` | Y | - | `1` |

### production.material_return_line — 자재 반납 상세

자재 반납 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `material_return_line_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `material_return_line_id` | `bigint` | Y | PK | `-` |
| 2 | `material_return_id` | `bigint` | Y | FK→production.material_return | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 5 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 6 | `return_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `package_opened` | `boolean` | Y | - | `false` |
| 9 | `quality_check_required` | `boolean` | Y | - | `false` |
| 10 | `return_quality_status_code` | `app.code_t` | Y | - | `-` |
| 11 | `inventory_transaction_line_id` | `bigint` | N | FK→inventory.inventory_transaction_line | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |

### production.material_usage_allocation — 자재 사용 배분

자재 사용 배분의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `material_usage_allocation_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `material_usage_allocation_id` | `bigint` | Y | PK | `-` |
| 2 | `material_consumption_id` | `bigint` | Y | FK→production.material_consumption | `-` |
| 3 | `production_result_id` | `bigint` | N | FK→production.production_result | `-` |
| 4 | `output_lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 5 | `allocated_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `allocation_method_code` | `app.code_t` | Y | - | `-` |
| 8 | `trace_accuracy_code` | `app.code_t` | Y | - | `-` |
| 9 | `effective_from_at` | `timestamp with time zone` | N | - | `-` |
| 10 | `effective_to_at` | `timestamp with time zone` | N | - | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |

### production.operation_handover — 공정 인계

공정 인계의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `operation_handover_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `operation_handover_id` | `bigint` | Y | PK | `-` |
| 2 | `handover_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `from_work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 4 | `to_work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 5 | `status_code` | `app.code_t` | Y | - | `-` |
| 6 | `handed_over_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `received_at` | `timestamp with time zone` | N | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |
| 10 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `updated_by` | `bigint` | N | - | `-` |
| 12 | `version_no` | `integer` | Y | - | `1` |

### production.operation_handover_line — 공정 인계 상세

공정 인계 상세의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `operation_handover_line_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `operation_handover_line_id` | `bigint` | Y | PK | `-` |
| 2 | `operation_handover_id` | `bigint` | Y | FK→production.operation_handover | `-` |
| 3 | `line_no` | `integer` | Y | - | `-` |
| 4 | `source_lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 5 | `handover_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `received_qty` | `app.qty_t` | Y | - | `0` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `source_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 9 | `destination_location_id` | `bigint` | Y | FK→mdm.location | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | - | `-` |

### production.precheck_decision — PRECHECK 판정

작업 전 점검 판정. 작업지시를 설비에 걸기 전 점검 상태를 보고 통과·차단·경고·우회를 정한 기록이다. 근거: P-02-02 §5-8.

- 유형: `TRANSACTION`
- 기본키: `precheck_decision_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `precheck_decision_id` | `bigint` | Y | PK | `-` |
| 2 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 3 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 4 | `decided_at` | `timestamp with time zone` | Y | - | `-` |
| 5 | `control_level_code` | `app.code_t` | Y | - | `-` |
| 6 | `decision_code` | `app.code_t` | Y | - | `-` |
| 7 | `basis_inspection_id` | `bigint` | N | FK→maintenance.equipment_inspection | `-` |
| 8 | `override_reason_code` | `app.code_t` | N | - | `-` |
| 9 | `worker_no` | `app.business_no_t` | N | - | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 11 | `created_by` | `bigint` | N | FK→app.app_user | `-` |

### production.production_order_acknowledgement — 생산 지시 확인응답

생산 지시 확인응답의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `production_order_acknowledgement_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `production_order_acknowledgement_id` | `bigint` | Y | PK | `-` |
| 2 | `production_order_id` | `bigint` | Y | FK→planning.production_order | `-` |
| 3 | `acknowledgement_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `upstream_version` | `character varying(100)` | N | - | `-` |
| 5 | `received_at` | `timestamp with time zone` | Y | - | `-` |
| 6 | `acknowledged_at` | `timestamp with time zone` | N | - | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `details` | `jsonb` | Y | - | `'{}'::jsonb` |
| 9 | `integration_message_id` | `bigint` | N | FK→integration.integration_message | `-` |
| 10 | `acknowledged_by` | `bigint` | N | FK→app.app_user | `-` |
| 11 | `acknowledge_decision_code` | `app.code_t` | N | - | `-` |
| 12 | `reason` | `text` | N | - | `-` |

### production.production_result — 생산 실적

생산 실적의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `production_result_id`
- 직접 외래키: 9개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `production_result_id` | `bigint` | Y | PK | `-` |
| 2 | `production_result_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 4 | `work_session_id` | `bigint` | N | FK→production.work_session | `-` |
| 5 | `result_sequence` | `integer` | Y | - | `-` |
| 6 | `corrects_production_result_id` | `bigint` | N | FK→production.production_result | `-` |
| 7 | `good_qty` | `app.qty_t` | Y | - | `0` |
| 8 | `defect_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `hold_qty` | `app.qty_t` | Y | - | `0` |
| 10 | `scrap_qty` | `app.qty_t` | Y | - | `0` |
| 11 | `rework_qty` | `app.qty_t` | Y | - | `0` |
| 12 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 13 | `result_source_code` | `app.code_t` | Y | - | `-` |
| 14 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 15 | `recorded_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `late_entry_reason_code` | `app.code_t` | N | - | `-` |
| 17 | `worker_id` | `bigint` | Y | FK→mdm.worker | `-` |
| 18 | `equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 19 | `mold_id` | `bigint` | N | FK→mdm.mold | `-` |
| 20 | `shift_id` | `bigint` | Y | FK→mdm.shift | `-` |
| 21 | `terminal_id` | `bigint` | N | FK→mdm.terminal | `-` |
| 22 | `status_code` | `app.code_t` | Y | - | `-` |
| 23 | `idempotency_key` | `character varying(150)` | Y | - | `-` |
| 24 | `remarks` | `text` | N | - | `-` |
| 25 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 26 | `created_by` | `bigint` | N | - | `-` |
| 27 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 28 | `updated_by` | `bigint` | N | - | `-` |
| 29 | `version_no` | `integer` | Y | - | `1` |

### production.production_result_lot_allocation — 생산 실적 LOT 배분

생산 실적 LOT 배분의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `production_result_lot_allocation_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `production_result_lot_allocation_id` | `bigint` | Y | PK | `-` |
| 2 | `production_result_id` | `bigint` | Y | FK→production.production_result | `-` |
| 3 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 4 | `allocated_qty` | `app.qty_t` | Y | - | `-` |
| 5 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### production.repair_execution — REPAIR EXECUTION

수리 투입·반출 기록. 원 불량(quality.defect_record)은 기록 전용이라 갱신하지 않고 여기에 쌓는다. 근거: M-02-02 §5-4.

- 유형: `TRANSACTION`
- 기본키: `repair_execution_id`
- 직접 외래키: 6개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `repair_execution_id` | `bigint` | Y | PK | `-` |
| 2 | `defect_record_id` | `bigint` | Y | FK→quality.defect_record | `-` |
| 3 | `repair_process_id` | `bigint` | N | FK→mdm.process | `-` |
| 4 | `started_at` | `timestamp with time zone` | Y | - | `-` |
| 5 | `returned_at` | `timestamp with time zone` | N | - | `-` |
| 6 | `repair_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `repair_result_code` | `app.code_t` | N | - | `-` |
| 9 | `reintroduced_lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 10 | `terminal_id` | `bigint` | N | FK→mdm.terminal | `-` |
| 11 | `worker_no` | `app.business_no_t` | N | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | FK→app.app_user | `-` |

### production.work_order — 작업 지시

작업 지시의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `work_order_id`
- 직접 외래키: 16개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_order_id` | `bigint` | Y | PK | `-` |
| 2 | `work_order_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `production_plan_id` | `bigint` | N | FK→planning.production_plan | `-` |
| 4 | `routing_operation_id` | `bigint` | Y | FK→planning.routing_operation | `-` |
| 5 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 6 | `order_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `work_order_type_code` | `app.code_t` | Y | - | `'NORMAL'::character varying` |
| 9 | `parent_work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 10 | `rework_source_work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 11 | `rework_source_lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 12 | `rework_source_nonconformance_id` | `bigint` | N | FK→quality.nonconformance | `-` |
| 13 | `production_line_id` | `bigint` | N | FK→mdm.production_line | `-` |
| 14 | `responsible_worker_id` | `bigint` | N | FK→mdm.worker | `-` |
| 15 | `planned_start_at` | `timestamp with time zone` | N | - | `-` |
| 16 | `planned_end_at` | `timestamp with time zone` | N | - | `-` |
| 17 | `planned_equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 18 | `planned_mold_id` | `bigint` | N | FK→mdm.mold | `-` |
| 19 | `planned_shift_id` | `bigint` | N | FK→mdm.shift | `-` |
| 20 | `priority_no` | `integer` | Y | - | `100` |
| 21 | `default_wip_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 22 | `default_fg_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 23 | `default_scrap_location_id` | `bigint` | N | FK→mdm.location | `-` |
| 24 | `operation_settings_snapshot` | `jsonb` | N | - | `-` |
| 25 | `status_code` | `app.code_t` | Y | - | `-` |
| 26 | `released_at` | `timestamp with time zone` | N | - | `-` |
| 27 | `completed_at` | `timestamp with time zone` | N | - | `-` |
| 28 | `completion_variance_reason_code` | `app.code_t` | N | - | `-` |
| 29 | `closed_at` | `timestamp with time zone` | N | - | `-` |
| 30 | `remarks` | `text` | N | - | `-` |
| 31 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 32 | `created_by` | `bigint` | N | - | `-` |
| 33 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 34 | `updated_by` | `bigint` | N | - | `-` |
| 35 | `version_no` | `integer` | Y | - | `1` |
| 36 | `close_disposition_code` | `app.code_t` | N | - | `-` |
| 37 | `cancellation_reason_code` | `app.code_t` | N | - | `-` |
| 38 | `po_mismatch` | `boolean` | Y | - | `false` |

### production.work_order_dependency — 작업 지시 선후행

작업 지시 선후행의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `work_order_dependency_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_order_dependency_id` | `bigint` | Y | PK | `-` |
| 2 | `predecessor_work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 3 | `successor_work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 4 | `dependency_type_code` | `app.code_t` | Y | - | `'FINISH_TO_START'::character varying` |
| 5 | `required_qty_rule_code` | `app.code_t` | Y | - | `'AVAILABLE_GOOD_QTY'::character varying` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### production.work_order_resource_assignment — 작업 지시 RESOURCE 배정

작업 지시 RESOURCE 배정의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `work_order_resource_assignment_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_order_resource_assignment_id` | `bigint` | Y | PK | `-` |
| 2 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 3 | `resource_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 5 | `mold_id` | `bigint` | N | FK→mdm.mold | `-` |
| 6 | `worker_id` | `bigint` | N | FK→mdm.worker | `-` |
| 7 | `shift_id` | `bigint` | N | FK→mdm.shift | `-` |
| 8 | `planned_start_at` | `timestamp with time zone` | N | - | `-` |
| 9 | `planned_end_at` | `timestamp with time zone` | N | - | `-` |
| 10 | `assignment_status_code` | `app.code_t` | Y | - | `'PLANNED'::character varying` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |

### production.work_session — 작업 세션

작업 세션의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `work_session_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_session_id` | `bigint` | Y | PK | `-` |
| 2 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 3 | `session_no` | `integer` | Y | - | `-` |
| 4 | `shift_id` | `bigint` | Y | FK→mdm.shift | `-` |
| 5 | `equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 6 | `mold_id` | `bigint` | N | FK→mdm.mold | `-` |
| 7 | `terminal_id` | `bigint` | Y | FK→mdm.terminal | `-` |
| 8 | `started_at` | `timestamp with time zone` | Y | - | `-` |
| 9 | `ended_at` | `timestamp with time zone` | N | - | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `stop_reason_code` | `app.code_t` | N | - | `-` |
| 12 | `remarks` | `text` | N | - | `-` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |
| 15 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `updated_by` | `bigint` | N | - | `-` |
| 17 | `version_no` | `integer` | Y | - | `1` |
| 18 | `idempotency_key` | `character varying(150)` | Y | - | `-` |

### production.work_session_event — 작업 세션 이력

작업 세션 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `work_session_event_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_session_event_id` | `bigint` | Y | PK | `-` |
| 2 | `work_session_id` | `bigint` | Y | FK→production.work_session | `-` |
| 3 | `event_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 5 | `reason_code` | `app.code_t` | N | - | `-` |
| 6 | `performed_by` | `bigint` | N | FK→app.app_user | `-` |
| 7 | `terminal_id` | `bigint` | N | FK→mdm.terminal | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### production.work_session_worker — 작업 세션 작업자

작업 세션 작업자의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `work_session_worker_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `work_session_worker_id` | `bigint` | Y | PK | `-` |
| 2 | `work_session_id` | `bigint` | Y | FK→production.work_session | `-` |
| 3 | `worker_id` | `bigint` | Y | FK→mdm.worker | `-` |
| 4 | `worker_role_code` | `app.code_t` | Y | - | `'OPERATOR'::character varying` |
| 5 | `joined_at` | `timestamp with time zone` | Y | - | `-` |
| 6 | `left_at` | `timestamp with time zone` | N | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |

## quality — 품질

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `quality.cause_code` | 원인 코드 | TRANSACTION | 13 | `cause_code_id` | 2 | 원인 코드의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.concession` | 특채 | TRANSACTION | 20 | `concession_id` | 7 | 특채의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.defect_code` | 불량 코드 | TRANSACTION | 14 | `defect_code_id` | 2 | 불량 코드의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.defect_code_process` | 불량 코드 공정 | TRANSACTION | 6 | `defect_code_process_id` | 2 | 불량 코드 공정의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.defect_record` | 불량 기록 | TRANSACTION | 27 | `defect_record_id` | 14 | 불량 기록의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.disposition_decision` | 처리 판정 | TRANSACTION | 10 | `disposition_decision_id` | 4 | 처리 판정의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.equipment_calibration` | 설비 교정 | TRANSACTION | 10 | `equipment_calibration_id` | 2 | 설비 교정의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.inspection_item_spec` | 검사 품목 SPEC | TRANSACTION | 19 | `inspection_item_spec_id` | 3 | 검사 품목 SPEC의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.inspection_measurement` | 검사 측정 | DETAIL | 12 | `inspection_measurement_id` | 3 | 검사 측정의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다. |
| `quality.inspection_plan` | 검사 계획 | TRANSACTION | 20 | `inspection_plan_id` | 4 | 검사 계획의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.inspection_plan_version` | 검사 계획 버전 | TRANSACTION | 20 | `inspection_plan_version_id` | 1 | 검사 계획 버전의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.inspection_request` | 검사 요청 | TRANSACTION | 21 | `inspection_request_id` | 6 | 검사 요청의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.inspection_result` | 검사 실적 | TRANSACTION | 24 | `inspection_result_id` | 5 | 검사 실적의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.nonconformance` | 부적합 | TRANSACTION | 20 | `nonconformance_id` | 5 | 부적합의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.nonconformance_lot` | 부적합 LOT | TRANSACTION | 9 | `nonconformance_lot_id` | 3 | 부적합 LOT의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.repair_result` | REPAIR 실적 | TRANSACTION | 17 | `repair_result_id` | 5 | REPAIR 실적의 업무 진행 상태와 실행 결과를 관리한다. |
| `quality.sorting_result` | 선별 실적 | TRANSACTION | 17 | `sorting_result_id` | 5 | 선별 실적의 업무 진행 상태와 실행 결과를 관리한다. |

### quality.cause_code — 원인 코드

원인 코드의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `cause_code_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `cause_code_id` | `bigint` | Y | PK | `-` |
| 2 | `cause_code` | `app.code_t` | Y | - | `-` |
| 3 | `cause_name` | `app.name_t` | Y | - | `-` |
| 4 | `parent_cause_code_id` | `bigint` | N | FK→quality.cause_code | `-` |
| 5 | `process_id` | `bigint` | N | FK→mdm.process | `-` |
| 6 | `is_active` | `boolean` | Y | - | `true` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |
| 12 | `name_ko` | `app.name_t` | N | - | `-` |
| 13 | `name_vi` | `app.name_t` | N | - | `-` |

### quality.concession — 특채

특채의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `concession_id`
- 직접 외래키: 7개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `concession_id` | `bigint` | Y | PK | `-` |
| 2 | `concession_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `nonconformance_id` | `bigint` | Y | FK→quality.nonconformance | `-` |
| 4 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 5 | `approved_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `consumed_qty` | `app.qty_t` | Y | - | `0` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `valid_from` | `date` | Y | - | `-` |
| 9 | `valid_to` | `date` | N | - | `-` |
| 10 | `allowed_work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 11 | `allowed_process_id` | `bigint` | N | FK→mdm.process | `-` |
| 12 | `allowed_customer_id` | `bigint` | N | FK→mdm.partner | `-` |
| 13 | `approval_request_id` | `bigint` | Y | FK→app.approval_request | `-` |
| 14 | `status_code` | `app.code_t` | Y | - | `-` |
| 15 | `remarks` | `text` | N | - | `-` |
| 16 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `created_by` | `bigint` | N | - | `-` |
| 18 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 19 | `updated_by` | `bigint` | N | - | `-` |
| 20 | `version_no` | `integer` | Y | - | `1` |

### quality.defect_code — 불량 코드

불량 코드의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `defect_code_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `defect_code_id` | `bigint` | Y | PK | `-` |
| 2 | `defect_code` | `app.code_t` | Y | - | `-` |
| 3 | `defect_name` | `app.name_t` | Y | - | `-` |
| 4 | `parent_defect_code_id` | `bigint` | N | FK→quality.defect_code | `-` |
| 5 | `process_id` | `bigint` | N | FK→mdm.process | `-` |
| 6 | `is_active` | `boolean` | Y | - | `true` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |
| 12 | `disposition_type_code` | `app.code_t` | N | - | `-` |
| 13 | `name_ko` | `app.name_t` | N | - | `-` |
| 14 | `name_vi` | `app.name_t` | N | - | `-` |

### quality.defect_code_process — 불량 코드 공정

불량 코드 공정의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `defect_code_process_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `defect_code_process_id` | `bigint` | Y | PK | `-` |
| 2 | `defect_code_id` | `bigint` | Y | FK→quality.defect_code | `-` |
| 3 | `process_id` | `bigint` | Y | FK→mdm.process | `-` |
| 4 | `is_primary` | `boolean` | Y | - | `false` |
| 5 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 6 | `created_by` | `bigint` | N | - | `-` |

### quality.defect_record — 불량 기록

불량 기록의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `defect_record_id`
- 직접 외래키: 14개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `defect_record_id` | `bigint` | Y | PK | `-` |
| 2 | `production_result_id` | `bigint` | N | FK→production.production_result | `-` |
| 3 | `inspection_result_id` | `bigint` | N | FK→quality.inspection_result | `-` |
| 4 | `work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 5 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 6 | `defect_code_id` | `bigint` | Y | FK→quality.defect_code | `-` |
| 7 | `suspected_cause_code_id` | `bigint` | N | FK→quality.cause_code | `-` |
| 8 | `confirmed_cause_code_id` | `bigint` | N | FK→quality.cause_code | `-` |
| 9 | `responsibility_type_code` | `app.code_t` | N | - | `-` |
| 10 | `responsible_department_id` | `bigint` | N | FK→mdm.department | `-` |
| 11 | `worker_id` | `bigint` | N | FK→mdm.worker | `-` |
| 12 | `defect_description` | `text` | N | - | `-` |
| 13 | `defect_qty` | `app.qty_t` | Y | - | `-` |
| 14 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 15 | `occurrence_process_id` | `bigint` | Y | FK→mdm.process | `-` |
| 16 | `detection_process_id` | `bigint` | Y | FK→mdm.process | `-` |
| 17 | `equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 18 | `mold_id` | `bigint` | N | FK→mdm.mold | `-` |
| 19 | `occurred_at` | `timestamp with time zone` | N | - | `-` |
| 20 | `detected_at` | `timestamp with time zone` | Y | - | `-` |
| 21 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 22 | `created_by` | `bigint` | N | - | `-` |
| 23 | `source_type_code` | `app.code_t` | N | - | `-` |
| 24 | `source_document_id` | `bigint` | N | - | `-` |
| 25 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 26 | `updated_by` | `bigint` | N | - | `-` |
| 27 | `version_no` | `integer` | Y | - | `1` |

### quality.disposition_decision — 처리 판정

처리 판정의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `disposition_decision_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `disposition_decision_id` | `bigint` | Y | PK | `-` |
| 2 | `nonconformance_id` | `bigint` | Y | FK→quality.nonconformance | `-` |
| 3 | `disposition_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `decision_qty` | `app.qty_t` | Y | - | `-` |
| 5 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 6 | `reason` | `text` | Y | - | `-` |
| 7 | `decided_by` | `bigint` | Y | FK→app.app_user | `-` |
| 8 | `decided_at` | `timestamp with time zone` | Y | - | `-` |
| 9 | `approval_request_id` | `bigint` | N | FK→app.approval_request | `-` |
| 10 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### quality.equipment_calibration — 설비 교정

설비 교정의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `equipment_calibration_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `equipment_calibration_id` | `bigint` | Y | PK | `-` |
| 2 | `equipment_id` | `bigint` | Y | FK→mdm.equipment | `-` |
| 3 | `calibration_date` | `date` | Y | - | `-` |
| 4 | `result_code` | `app.code_t` | Y | - | `-` |
| 5 | `valid_until` | `date` | N | - | `-` |
| 6 | `certificate_no` | `character varying(100)` | N | - | `-` |
| 7 | `calibrated_by` | `bigint` | N | FK→app.app_user | `-` |
| 8 | `remarks` | `text` | N | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `created_by` | `bigint` | N | - | `-` |

### quality.inspection_item_spec — 검사 품목 SPEC

검사 품목 SPEC의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inspection_item_spec_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inspection_item_spec_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_plan_version_id` | `bigint` | Y | FK→quality.inspection_plan_version | `-` |
| 3 | `sequence_no` | `integer` | Y | - | `-` |
| 4 | `inspection_item_code` | `app.code_t` | Y | - | `-` |
| 5 | `inspection_item_name` | `app.name_t` | Y | - | `-` |
| 6 | `data_type_code` | `app.code_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | N | FK→mdm.uom | `-` |
| 8 | `target_value` | `numeric(20,6)` | N | - | `-` |
| 9 | `lower_limit` | `numeric(20,6)` | N | - | `-` |
| 10 | `upper_limit` | `numeric(20,6)` | N | - | `-` |
| 11 | `measurement_count` | `integer` | Y | - | `1` |
| 12 | `inspection_method_code` | `app.code_t` | N | - | `-` |
| 13 | `default_inspection_equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 14 | `required_flag` | `boolean` | Y | - | `true` |
| 15 | `automatic_judgment` | `boolean` | Y | - | `true` |
| 16 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `created_by` | `bigint` | N | - | `-` |
| 18 | `name_ko` | `app.name_t` | N | - | `-` |
| 19 | `name_vi` | `app.name_t` | N | - | `-` |

### quality.inspection_measurement — 검사 측정

검사 측정의 상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.

- 유형: `DETAIL`
- 기본키: `inspection_measurement_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inspection_measurement_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_result_id` | `bigint` | Y | FK→quality.inspection_result | `-` |
| 3 | `inspection_item_spec_id` | `bigint` | Y | FK→quality.inspection_item_spec | `-` |
| 4 | `sample_no` | `integer` | Y | - | `-` |
| 5 | `numeric_value` | `numeric(20,6)` | N | - | `-` |
| 6 | `text_value` | `text` | N | - | `-` |
| 7 | `boolean_value` | `boolean` | N | - | `-` |
| 8 | `judgment_code` | `app.code_t` | Y | - | `-` |
| 9 | `measured_at` | `timestamp with time zone` | Y | - | `-` |
| 10 | `inspection_equipment_id` | `bigint` | N | FK→mdm.equipment | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |

### quality.inspection_plan — 검사 계획

검사 계획의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inspection_plan_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inspection_plan_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_plan_code` | `app.code_t` | Y | - | `-` |
| 3 | `inspection_plan_name` | `app.name_t` | Y | - | `-` |
| 4 | `item_id` | `bigint` | N | FK→mdm.item | `-` |
| 5 | `process_id` | `bigint` | N | FK→mdm.process | `-` |
| 6 | `routing_id` | `bigint` | N | FK→planning.routing | `-` |
| 7 | `inspection_type_code` | `app.code_t` | Y | - | `-` |
| 8 | `approved_by` | `bigint` | N | FK→app.app_user | `-` |
| 9 | `approved_at` | `timestamp with time zone` | N | - | `-` |
| 10 | `is_active` | `boolean` | Y | - | `true` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |
| 13 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `updated_by` | `bigint` | N | - | `-` |
| 15 | `version_no` | `integer` | Y | - | `1` |
| 16 | `pqc_skip_allowed` | `boolean` | Y | - | `false` |
| 17 | `skip_reason_code` | `app.code_t` | N | - | `-` |
| 18 | `simple_judgment_allowed` | `boolean` | Y | - | `false` |
| 19 | `name_ko` | `app.name_t` | N | - | `-` |
| 20 | `name_vi` | `app.name_t` | N | - | `-` |

### quality.inspection_plan_version — 검사 계획 버전

검사 계획 버전의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inspection_plan_version_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inspection_plan_version_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_plan_id` | `bigint` | Y | FK→quality.inspection_plan | `-` |
| 3 | `plan_version` | `integer` | Y | - | `-` |
| 4 | `effective_from` | `date` | Y | - | `-` |
| 5 | `effective_to` | `date` | N | - | `-` |
| 6 | `sampling_method_code` | `app.code_t` | Y | - | `-` |
| 7 | `sampling_qty` | `app.qty_t` | N | - | `-` |
| 8 | `aql_value` | `numeric(9,4)` | N | - | `-` |
| 9 | `acceptance_number` | `integer` | N | - | `-` |
| 10 | `rejection_number` | `integer` | N | - | `-` |
| 11 | `inspection_frequency_code` | `app.code_t` | Y | - | `-` |
| 12 | `frequency_interval_value` | `numeric(18,6)` | N | - | `-` |
| 13 | `frequency_interval_uom_code` | `app.code_t` | N | - | `-` |
| 14 | `status_code` | `app.code_t` | Y | - | `-` |
| 15 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `created_by` | `bigint` | N | - | `-` |
| 17 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `updated_by` | `bigint` | N | - | `-` |
| 19 | `version_no` | `integer` | Y | - | `1` |
| 20 | `sampling_ratio` | `numeric(9,6)` | N | - | `-` |

### quality.inspection_request — 검사 요청

검사 요청의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inspection_request_id`
- 직접 외래키: 6개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inspection_request_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_request_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `inspection_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `inspection_plan_version_id` | `bigint` | Y | FK→quality.inspection_plan_version | `-` |
| 5 | `target_type_code` | `app.code_t` | Y | - | `-` |
| 6 | `target_id` | `bigint` | Y | - | `-` |
| 7 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 8 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 9 | `work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 10 | `production_result_id` | `bigint` | N | FK→production.production_result | `-` |
| 11 | `target_qty` | `app.qty_t` | Y | - | `-` |
| 12 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 13 | `coverage_from_at` | `timestamp with time zone` | N | - | `-` |
| 14 | `coverage_to_at` | `timestamp with time zone` | N | - | `-` |
| 15 | `status_code` | `app.code_t` | Y | - | `-` |
| 16 | `requested_at` | `timestamp with time zone` | Y | - | `-` |
| 17 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `created_by` | `bigint` | N | - | `-` |
| 19 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 20 | `updated_by` | `bigint` | N | - | `-` |
| 21 | `version_no` | `integer` | Y | - | `1` |

### quality.inspection_result — 검사 실적

검사 실적의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `inspection_result_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `inspection_result_id` | `bigint` | Y | PK | `-` |
| 2 | `inspection_result_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `inspection_request_id` | `bigint` | Y | FK→quality.inspection_request | `-` |
| 4 | `inspection_round` | `integer` | Y | - | `1` |
| 5 | `inspected_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `accepted_qty` | `app.qty_t` | Y | - | `0` |
| 7 | `rejected_qty` | `app.qty_t` | Y | - | `0` |
| 8 | `held_qty` | `app.qty_t` | Y | - | `0` |
| 9 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 10 | `overall_judgment_code` | `app.code_t` | Y | - | `-` |
| 11 | `inspector_id` | `bigint` | Y | FK→mdm.worker | `-` |
| 12 | `inspected_at` | `timestamp with time zone` | Y | - | `-` |
| 13 | `confirmed_at` | `timestamp with time zone` | N | - | `-` |
| 14 | `terminal_id` | `bigint` | N | FK→mdm.terminal | `-` |
| 15 | `status_code` | `app.code_t` | Y | - | `-` |
| 16 | `previous_result_id` | `bigint` | N | FK→quality.inspection_result | `-` |
| 17 | `reinspection_reason_code` | `app.code_t` | N | - | `-` |
| 18 | `idempotency_key` | `character varying(150)` | Y | - | `-` |
| 19 | `remarks` | `text` | N | - | `-` |
| 20 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 21 | `created_by` | `bigint` | N | - | `-` |
| 22 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 23 | `updated_by` | `bigint` | N | - | `-` |
| 24 | `version_no` | `integer` | Y | - | `1` |

### quality.nonconformance — 부적합

부적합의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `nonconformance_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `nonconformance_id` | `bigint` | Y | PK | `-` |
| 2 | `nonconformance_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 5 | `inspection_result_id` | `bigint` | N | FK→quality.inspection_result | `-` |
| 6 | `severity_code` | `app.code_t` | Y | - | `-` |
| 7 | `description` | `text` | Y | - | `-` |
| 8 | `responsible_department_id` | `bigint` | N | FK→mdm.department | `-` |
| 9 | `action_description` | `text` | N | - | `-` |
| 10 | `action_owner_id` | `bigint` | N | FK→app.app_user | `-` |
| 11 | `action_due_date` | `date` | N | - | `-` |
| 12 | `action_completed_at` | `timestamp with time zone` | N | - | `-` |
| 13 | `status_code` | `app.code_t` | Y | - | `-` |
| 14 | `opened_at` | `timestamp with time zone` | Y | - | `-` |
| 15 | `closed_at` | `timestamp with time zone` | N | - | `-` |
| 16 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `created_by` | `bigint` | N | - | `-` |
| 18 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 19 | `updated_by` | `bigint` | N | - | `-` |
| 20 | `version_no` | `integer` | Y | - | `1` |

### quality.nonconformance_lot — 부적합 LOT

부적합 LOT의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `nonconformance_lot_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `nonconformance_lot_id` | `bigint` | Y | PK | `-` |
| 2 | `nonconformance_id` | `bigint` | Y | FK→quality.nonconformance | `-` |
| 3 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 4 | `affected_qty` | `app.qty_t` | Y | - | `-` |
| 5 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 6 | `quality_status_before_code` | `app.code_t` | Y | - | `-` |
| 7 | `quality_status_after_code` | `app.code_t` | Y | - | `-` |
| 8 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 9 | `created_by` | `bigint` | N | - | `-` |

### quality.repair_result — REPAIR 실적

REPAIR 실적의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `repair_result_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `repair_result_id` | `bigint` | Y | PK | `-` |
| 2 | `repair_result_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `defect_record_id` | `bigint` | Y | FK→quality.defect_record | `-` |
| 4 | `work_order_id` | `bigint` | N | FK→production.work_order | `-` |
| 5 | `lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 6 | `repair_type_code` | `app.code_t` | Y | - | `-` |
| 7 | `repair_qty` | `app.qty_t` | Y | - | `-` |
| 8 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 9 | `result_code` | `app.code_t` | Y | - | `-` |
| 10 | `repaired_at` | `timestamp with time zone` | Y | - | `-` |
| 11 | `repaired_by` | `bigint` | N | FK→mdm.worker | `-` |
| 12 | `remarks` | `text` | N | - | `-` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |
| 15 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `updated_by` | `bigint` | N | - | `-` |
| 17 | `version_no` | `integer` | Y | - | `1` |

### quality.sorting_result — 선별 실적

선별 실적의 업무 진행 상태와 실행 결과를 관리한다.

- 유형: `TRANSACTION`
- 기본키: `sorting_result_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `sorting_result_id` | `bigint` | Y | PK | `-` |
| 2 | `disposition_decision_id` | `bigint` | Y | FK→quality.disposition_decision | `-` |
| 3 | `sorted_qty` | `app.qty_t` | Y | - | `-` |
| 4 | `good_qty` | `app.qty_t` | Y | - | `0` |
| 5 | `defect_qty` | `app.qty_t` | Y | - | `0` |
| 6 | `hold_qty` | `app.qty_t` | Y | - | `0` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `sorting_criteria` | `text` | N | - | `-` |
| 9 | `worker_id` | `bigint` | Y | FK→mdm.worker | `-` |
| 10 | `started_at` | `timestamp with time zone` | Y | - | `-` |
| 11 | `ended_at` | `timestamp with time zone` | N | - | `-` |
| 12 | `good_lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 13 | `defect_lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 14 | `status_code` | `app.code_t` | Y | - | `-` |
| 15 | `remarks` | `text` | N | - | `-` |
| 16 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 17 | `created_by` | `bigint` | N | - | `-` |

## trace — 추적성

| 물리 테이블 | 논리명 | 유형 | 컬럼 | PK | FK | 목적 |
|---|---|---|---:|---|---:|---|
| `trace.impact_analysis` | 영향 분석 | EVENT | 12 | `impact_analysis_id` | 2 | 영향 분석의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `trace.lot` | LOT | EVENT | 24 | `lot_id` | 5 | LOT의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `trace.lot_external_identifier` | LOT 외부 IDENTIFIER | EVENT | 8 | `lot_external_identifier_id` | 2 | LOT 외부 IDENTIFIER의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `trace.lot_hold` | LOT 보류 | EVENT | 15 | `lot_hold_id` | 4 | LOT 보류의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `trace.lot_lifecycle_history` | LOT LIFECYCLE HISTORY | EVENT | 9 | `lot_lifecycle_history_id` | 1 | LOT 생명주기 전이 이력(L1~L3). 품질 판정 축인 trace.lot_status_event 와 다른 축이며 한 이력에 섞지 않는다 — 계약 명시 사항이다. 근거: 이슈 #63 · DR-007. |
| `trace.lot_relation` | LOT 관계 | EVENT | 13 | `lot_relation_id` | 3 | LOT 관계의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `trace.lot_status_event` | LOT 상태 이력 | EVENT | 15 | `lot_status_event_id` | 3 | LOT 상태 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `trace.serial_component_relation` | 시리얼 구성품 관계 | EVENT | 7 | `serial_component_relation_id` | 3 | 시리얼 구성품 관계의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |
| `trace.serial_number` | 시리얼 번호 | EVENT | 11 | `serial_number_id` | 2 | 시리얼 번호의 발생 사실과 변경 이력을 불변 기록으로 보존한다. |

### trace.impact_analysis — 영향 분석

영향 분석의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `impact_analysis_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `impact_analysis_id` | `bigint` | Y | PK | `-` |
| 2 | `analysis_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `source_lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 4 | `direction_code` | `app.code_t` | Y | - | `-` |
| 5 | `analysis_condition` | `text` | N | - | `-` |
| 6 | `analyzed_at` | `timestamp with time zone` | Y | - | `-` |
| 7 | `analyzed_by` | `bigint` | N | FK→app.app_user | `-` |
| 8 | `affected_lot_count` | `integer` | N | - | `-` |
| 9 | `result_summary` | `jsonb` | N | - | `-` |
| 10 | `status_code` | `app.code_t` | Y | - | `-` |
| 11 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 12 | `created_by` | `bigint` | N | - | `-` |

### trace.lot — LOT

LOT의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `lot_id`
- 직접 외래키: 5개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `lot_id` | `bigint` | Y | PK | `-` |
| 2 | `lot_no` | `app.business_no_t` | Y | - | `-` |
| 3 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `lot_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `plant_id` | `bigint` | Y | FK→mdm.plant | `-` |
| 6 | `initial_qty` | `app.qty_t` | Y | - | `-` |
| 7 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 8 | `manufactured_at` | `timestamp with time zone` | N | - | `-` |
| 9 | `expiry_date` | `date` | N | - | `-` |
| 10 | `source_type_code` | `app.code_t` | Y | - | `-` |
| 11 | `source_id` | `bigint` | Y | - | `-` |
| 12 | `status_code` | `app.code_t` | Y | - | `-` |
| 13 | `parent_lot_id` | `bigint` | N | FK→trace.lot | `-` |
| 14 | `remarks` | `text` | N | - | `-` |
| 15 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 16 | `created_by` | `bigint` | N | - | `-` |
| 17 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 18 | `updated_by` | `bigint` | N | - | `-` |
| 19 | `version_no` | `integer` | Y | - | `1` |
| 20 | `bom_id` | `bigint` | N | FK→planning.bom | `-` |
| 21 | `bom_version` | `integer` | N | - | `-` |
| 22 | `work_order_lot_seq` | `integer` | N | - | `-` |
| 23 | `lifecycle_status_code` | `app.code_t` | N | - | `-` |
| 24 | `completed_at` | `timestamp with time zone` | N | - | `-` |

### trace.lot_external_identifier — LOT 외부 IDENTIFIER

LOT 외부 IDENTIFIER의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `lot_external_identifier_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `lot_external_identifier_id` | `bigint` | Y | PK | `-` |
| 2 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 3 | `identifier_type_code` | `app.code_t` | Y | - | `-` |
| 4 | `external_identifier` | `character varying(150)` | Y | - | `-` |
| 5 | `partner_id` | `bigint` | N | FK→mdm.partner | `-` |
| 6 | `external_system_code` | `app.code_t` | N | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |

### trace.lot_hold — LOT 보류

LOT 보류의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `lot_hold_id`
- 직접 외래키: 4개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `lot_hold_id` | `bigint` | Y | PK | `-` |
| 2 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 3 | `hold_qty` | `app.qty_t` | N | - | `-` |
| 4 | `uom_id` | `bigint` | N | FK→mdm.uom | `-` |
| 5 | `reason_code` | `app.code_t` | Y | - | `-` |
| 6 | `release_condition` | `text` | N | - | `-` |
| 7 | `status_code` | `app.code_t` | Y | - | `-` |
| 8 | `held_by` | `bigint` | N | FK→app.app_user | `-` |
| 9 | `held_at` | `timestamp with time zone` | Y | - | `-` |
| 10 | `released_by` | `bigint` | N | FK→app.app_user | `-` |
| 11 | `released_at` | `timestamp with time zone` | N | - | `-` |
| 12 | `remarks` | `text` | N | - | `-` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `created_by` | `bigint` | N | - | `-` |
| 15 | `release_reason_code` | `app.code_t` | N | - | `-` |

### trace.lot_lifecycle_history — LOT LIFECYCLE HISTORY

LOT 생명주기 전이 이력(L1~L3). 품질 판정 축인 trace.lot_status_event 와 다른 축이며 한 이력에 섞지 않는다 — 계약 명시 사항이다. 근거: 이슈 #63 · DR-007.

- 유형: `EVENT`
- 기본키: `lot_lifecycle_history_id`
- 직접 외래키: 1개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `lot_lifecycle_history_id` | `bigint` | Y | PK | `-` |
| 2 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 3 | `from_lifecycle_status_code` | `app.code_t` | N | - | `-` |
| 4 | `to_lifecycle_status_code` | `app.code_t` | Y | - | `-` |
| 5 | `transition_code` | `app.code_t` | Y | - | `-` |
| 6 | `source_document_type_code` | `app.code_t` | N | - | `-` |
| 7 | `source_document_id` | `bigint` | N | - | `-` |
| 8 | `changed_at` | `timestamp with time zone` | Y | - | `-` |
| 9 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |

### trace.lot_relation — LOT 관계

LOT 관계의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `lot_relation_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `lot_relation_id` | `bigint` | Y | PK | `-` |
| 2 | `source_lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 3 | `target_lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 4 | `relation_type_code` | `app.code_t` | Y | - | `-` |
| 5 | `relation_qty` | `app.qty_t` | Y | - | `-` |
| 6 | `uom_id` | `bigint` | Y | FK→mdm.uom | `-` |
| 7 | `source_event_type_code` | `app.code_t` | Y | - | `-` |
| 8 | `source_event_id` | `bigint` | Y | - | `-` |
| 9 | `allocation_method_code` | `app.code_t` | Y | - | `-` |
| 10 | `trace_accuracy_code` | `app.code_t` | Y | - | `-` |
| 11 | `occurred_at` | `timestamp with time zone` | Y | - | `-` |
| 12 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 13 | `created_by` | `bigint` | N | - | `-` |

### trace.lot_status_event — LOT 상태 이력

LOT 상태 이력의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `lot_status_event_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `lot_status_event_id` | `bigint` | Y | PK | `-` |
| 2 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 3 | `location_id` | `bigint` | N | FK→mdm.location | `-` |
| 4 | `quality_status_code` | `app.code_t` | N | - | `-` |
| 5 | `inventory_status_code` | `app.code_t` | N | - | `-` |
| 6 | `previous_status_code` | `app.code_t` | N | - | `-` |
| 7 | `new_status_code` | `app.code_t` | Y | - | `-` |
| 8 | `reason_code` | `app.code_t` | N | - | `-` |
| 9 | `source_document_type_code` | `app.code_t` | N | - | `-` |
| 10 | `source_document_id` | `bigint` | N | - | `-` |
| 11 | `changed_at` | `timestamp with time zone` | Y | - | `-` |
| 12 | `changed_by` | `bigint` | Y | FK→app.app_user | `-` |
| 13 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 14 | `transition_code` | `app.code_t` | Y | - | `-` |
| 15 | `reason` | `text` | N | - | `-` |

### trace.serial_component_relation — 시리얼 구성품 관계

시리얼 구성품 관계의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `serial_component_relation_id`
- 직접 외래키: 3개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `serial_component_relation_id` | `bigint` | Y | PK | `-` |
| 2 | `parent_serial_number_id` | `bigint` | Y | FK→trace.serial_number | `-` |
| 3 | `component_serial_number_id` | `bigint` | Y | FK→trace.serial_number | `-` |
| 4 | `work_order_id` | `bigint` | Y | FK→production.work_order | `-` |
| 5 | `assembled_at` | `timestamp with time zone` | Y | - | `-` |
| 6 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 7 | `created_by` | `bigint` | N | - | `-` |

### trace.serial_number — 시리얼 번호

시리얼 번호의 발생 사실과 변경 이력을 불변 기록으로 보존한다.

- 유형: `EVENT`
- 기본키: `serial_number_id`
- 직접 외래키: 2개

| No. | 컬럼 | 데이터 타입 | 필수 | 키/참조 | 기본값 |
|---:|---|---|:---:|---|---|
| 1 | `serial_number_id` | `bigint` | Y | PK | `-` |
| 2 | `serial_no` | `character varying(150)` | Y | - | `-` |
| 3 | `item_id` | `bigint` | Y | FK→mdm.item | `-` |
| 4 | `lot_id` | `bigint` | Y | FK→trace.lot | `-` |
| 5 | `status_code` | `app.code_t` | Y | - | `-` |
| 6 | `produced_at` | `timestamp with time zone` | N | - | `-` |
| 7 | `created_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 8 | `created_by` | `bigint` | N | - | `-` |
| 9 | `updated_at` | `timestamp with time zone` | Y | - | `clock_timestamp()` |
| 10 | `updated_by` | `bigint` | N | - | `-` |
| 11 | `version_no` | `integer` | Y | - | `1` |
