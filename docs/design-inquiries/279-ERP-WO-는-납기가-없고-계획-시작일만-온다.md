# 279. ERP W/O 는 **납기가 없고 계획 시작일만** 옵니다 — ERP W/O 를 시작일 기준으로 바꿔 주십시오

> ERP W/O = 계약의 P/O(생산오더)·`ProductionOrder`. 용어 변경은 요청 282.

**구분: 질의**(계약을 고쳐야 화면이 선다 · 서버는 저장까지 먼저 했다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /planning/production-orders` · `GET /planning/production-orders/{productionOrderId}` · `POST /planning/production-orders/{productionOrderId}:acknowledge` |
| 구현 상태 | 서버가 ERP W/O 를 받아 `planned_start_date` 에 저장한다. `dueDate` 는 비어 있다(선행 P-66) |
| 판정 | 정본(ERP)에 없는 값으로 도는 화면은 MES 가 고친다 — 사용자 결정 2026-10-20 |

## 사실

- ERP 중계 표 `T_IF_SND_PROD_ORD_KO324` 의 날짜 칸은 `PLAN_START_DT`(계획 시작일) **하나**다. 3,013건 모두 그렇다.
- ERP 수주에도 납기가 없다. ERP W/O 와 수주를 잇는 칸도 없다 — 품목으로 짐작하면 3,013건 중 123건만 수주 하나로 정해진다.
- ⇒ ERP W/O 는 `dueDate` 가 늘 비어 있다.

## 지금 계약에서 걸리는 자리

| 자리 | 지금 | 결과 |
|---|---|---|
| `GET /planning/production-orders` 질의 `dueDateFrom`·`dueDateTo` | 납기로 거른다 | ERP W/O 가 하나도 안 걸린다 |
| `ProductionOrder.dueDate` | 납기 | 늘 없다 |
| `ProductionOrderChangedField.field` enum | `ORDER_QTY`·`DUE_DATE`·`STATUS_CODE` | ERP 가 바꾸는 날짜(시작일)를 담을 값이 없다. 「넷째가 필요해지면 값을 더한다」고 열려 있다 |
| `:acknowledge` 의 `workOrderAdjustments[].plannedStartAt` | MES W/O 시작 시각 조정 | 기준이 될 ERP W/O 날짜가 시작일이다 |

## 📨 요청

1. `ProductionOrder.plannedStartDate`(date)를 더해 주십시오.
2. 목록 질의 `plannedStartDateFrom`·`plannedStartDateTo` 를 더해 주십시오.
3. `ProductionOrderChangedField.field` 에 `PLANNED_START_DATE`(표시명 「계획 시작일」)를 더해 주십시오.
4. `dueDate` 는 테스트용으로 MES 에서 등록한 것(`POST /planning/production-orders`)이거나 ERP 가 납기를 보낼 때만 찬다 — 이렇게 두어도 되는지 확인해 주십시오.

## 서버가 먼저 한 것

- 시작일을 `planned_start_date` 에 저장한다. 시작일이 바뀌면 이전 값을 `PLANNED_START_DATE` 로 남기지만, enum 에 없어 `changedFields` 에는 싣지 않는다.
- 시작일만 바뀐 변경은 `changedFields` 가 빈 배열이다(계약이 허용한 모양).
- 목록 기본 정렬을 계획 시작일 → 납기 → id 순으로 바꿨다(정렬은 계약이 서버에 맡겼다 · 사용자 결정 2026-10-20). 시작일이 없는 테스트용 등록분은 뒤에 납기 순으로 선다.
