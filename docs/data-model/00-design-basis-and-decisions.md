# OMF-MES 데이터 모델 v4 설계 기준

## 1. 설계 기준선

- 설계 자료: `CREFLEINC/omf-mes` commit `a8f46f2` (2026-08-25)
- 계약 우선순위: 최신 Wiki 결정·공유계약 → OpenAPI → 화면 상세명세 → 과거 v3 모델
- 구현 기준선: 현재 `prisma/schema.prisma`와 모든 순방향 마이그레이션
- 대상 DBMS: PostgreSQL 16
- 결과 모델: v4.0, 물리 테이블 174개(논리 172개, 파티션 2개), 컬럼 2254개, FK 533개
- API 추적성: OpenAPI 작업 437개, 테이블 매핑 커버리지 100%

설계 저장소의 최신 결정은 데이터 모델의 소유권을 백엔드로 이관한다. 과거 v3 모델은 출발점으로만 사용하고, 최신 계약에서 확정된 필드·관계·상태 전이를 v4 순방향 확장으로 반영했다.

## 2. 모델링 원칙

1. 최신 OpenAPI의 필드와 필수 여부를 물리 모델의 기존 `NOT NULL`에서 역추론하지 않는다.
2. 기존 테이블·컬럼은 삭제하지 않는다. 상태 범위 확대는 제약 완화와 신규 이력 테이블로 처리한다.
3. 품질상태는 LOT의 단일 상태가 아니라 `inventory.inventory_balance`의 재고 차원으로 유지하고, 변경 이력은 `trace.lot_status_event`에 남긴다.
4. `business_date`는 timestamptz 단순 형변환으로 만들지 않고 공장 시간대와 교대 기준으로 산출한다.
5. 미결 업무코드는 DB enum으로 고정하지 않는다. `app.code_t`와 `mdm.code_group/code_value`에서 배포 시점 코드값을 관리한다.
6. API 쓰기는 멱등·감사·낙관적 잠금 계약을 교차 검증한다. 멱등 헤더가 있는 쓰기는 `app.idempotency_record`, 모든 쓰기는 `audit.audit_event`와 연결한다.
7. 다형 대상은 물리 FK를 가장할 수 없으므로 `app.entity_type_registry`로 허용 테이블과 ID 컬럼을 등록한다.

## 3. 스키마 구성

| 스키마 | 역할 | 테이블 수 |
|---|---|---:|
| `app` | 공통 애플리케이션 | 27 |
| `audit` | 감사 | 2 |
| `integration` | 연계 | 5 |
| `inventory` | 재고 | 13 |
| `logistics` | 물류 | 33 |
| `maintenance` | 설비보전 | 10 |
| `mdm` | 기준정보 | 35 |
| `planning` | 계획 | 8 |
| `production` | 생산실행 | 16 |
| `quality` | 품질 | 17 |
| `trace` | 추적성 | 8 |

## 4. 계약 차이 해소표

| No. | 확인된 차이 | v4 반영 | 상태 |
|---:|---|---|---|
| 1 | 다국어 명칭 | app.localized_text + entity_type_registry | 해결 |
| 2 | ERP·레거시 원천 식별 | integration.record_provenance | 해결 |
| 3 | 자체 비밀번호 인증 | app.user_credential | 기존 해결 |
| 4 | 법인 단위 데이터 접근범위 | app.user_data_scope.legal_entity_id | 해결 |
| 5 | 다형 대상 테이블 검증 | app.entity_type_registry | 해결 |
| 6 | 품목 LOT·개발·재활용 속성 | mdm.item 확장 | 해결 |
| 7 | 기본 라우팅 단일 선택 | planning.routing.is_default + 부분 유니크 | 해결 |
| 8 | 외주 공정 구분 | planning.routing_operation.is_subcontract | 해결 |
| 9 | 검사 생략·간이판정·샘플링 비율 | quality.inspection_plan/version 확장 | 해결 |
| 10 | 불량-공정 N:M과 처분 유형 | quality.defect_code_process + defect_code 확장 | 해결 |
| 11 | 보전·점검·고장·비가동 | maintenance 스키마 10개 테이블 | 해결 |
| 12 | 인터페이스 정의·품목별 송신 | integration.interface_definition/outbound_item_setting | 해결 |
| 13 | 긴급 작업지시 | work_order.production_plan_id 선택화 | 해결 |
| 14 | LOT별 BOM 스냅샷 | trace.lot.bom_id/bom_version | 해결 |
| 15 | 선발행 LOT 0 수량 | PREISSUED 조건부 허용 | 해결 |
| 16 | 설비 위치·그룹·점검항목 | mdm.equipment 및 신규 매핑 테이블 | 해결 |
| 17 | 창고 내 로케이션 이동 | stock_transfer 창고 제약 완화 + 상세 위치 차이 | 해결 |
| 18 | 수리 실행 실적 | quality.repair_result | 해결 |
| 19 | 불량 발생 원천 축·동시성 | quality.defect_record 확장 | 해결 |
| 20 | 계획 자원 복수 배정 | production.work_order_resource_assignment | 해결 |
| 21 | 생산오더 변경 확인 이력 | production.production_order_acknowledgement | 해결 |
| 22 | 재고조정 상세 | inventory.inventory_adjustment_line | 해결 |
| 23 | 공지·알림·구독 | app.notice/notification 계열 | 해결 |
| 24 | 문서 출력 프린터 | app.printer + document_issue_log | 해결 |
| 25 | LOT 보류 해제 사유 | trace.lot_hold.release_reason_code | 해결 |
| 26 | 외주 입출고 상태·버전 | subcontract_issue/receipt 확장 | 해결 |
| 27 | 취소 감사 | app.document_cancellation + 핵심 전표 취소 컬럼 | 해결 |
| 28 | 출하 시간대·확정자 | shipment_request/shipment 확장 | 해결 |
| 29 | 포장단위 재구성 | inventory.handling_unit_reconfiguration 계열 | 해결 |
| 30 | 작업달력·계획정지 | mdm.work_calendar 계열 + maintenance.planned_stop | 해결 |
| 31 | 미결 업무코드 50종 | app.code_t + mdm.code_group/value로 외부화 | 코드값 결정 대기 |

## 5. 논리 설계 동결 판단

- 구조 차이는 모두 테이블·컬럼·관계 또는 명시적인 외부 코드 정책으로 귀결됐다.
- 미결 업무코드 50종은 값의 확정 문제이며 테이블 구조 변경을 요구하지 않는다.
- 긴급 작업지시, 선발행 LOT, 창고 내 이동처럼 기존 제약으로 불가능했던 흐름은 데이터 손실 없이 허용했다.
- 정정된 LOT 품질상태 계약은 중복 컬럼을 만들지 않고 재고 차원과 이벤트 이력으로 구현했다.
- 따라서 본 문서와 `01-logical-table-spec.md`를 논리 모델 v4.0의 동결 기준으로 삼는다.

## 6. 산출물 연결

- 논리 테이블 명세: `01-logical-table-spec.md` 및 XLSX
- 물리 전체 DDL: `02-omf-mes-postgresql-v4.sql`
- 배포용 순방향 SQL: `prisma/migrations/20260826000000_data_model_v4/migration.sql`
- API 관계 명세: `api-table-map.yaml`
- 대화형 검증 자료: `03-data-model-api-map.html`
