# 36. 선발행 슬롯의 `lot.sourceTypeCode` 값이 `LOT_SOURCE_TYPE` 2값에 없다 — 그런데 `GET /trace/lots?workOrderId=` 은 그 값의 존재를 전제한다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /production/work-orders/{id}:release`(선발행 슬롯 N건 생성) · `GET /trace/lots?workOrderId=` |
| 구현 상태 | **구현 예정(I-6 · `'WORK_ORDER'` 를 시드 `LOT_SOURCE_TYPE` 에 1행 추가 · 상수는 `src/core/lot/lot-source.ts` 한 곳)** |
| 판정 | `coverage-100/README.md` §2 0단계 선례 — `LOT_SOURCE_TYPE` 이 `isSystemOwned`(`seed.ts:1082`)라 시드가 값의 등록부인데, 등록부 밖 값을 코드가 **이미** 쓰고 있다(`src/trace/lot/lot-rules.ts:73-75 workOrderWhere()` · `source_type_code: 'WORK_ORDER'`). I-5 R-6 「`ENTITY_TYPES` +6 은 시드지 마이그가 아니다」와 같은 성격 |
| 되돌릴 때 | 값 이름이 다르게 오면(예: `WORK_ORDER_PREISSUE`) 상수 한 곳 + 시드 한 행 + 데이터 UPDATE 한 줄. 「선발행 슬롯은 LOT 이 아니다(별도 표)」로 오면 I-6 코어 `preIssueWithin()` 을 통째로 되돌려야 한다 — 그 답은 비싸므로 먼저 알려 달라 |

## 무엇이 문제인가

`:release` 는 ⌜`lotSize` 로 잘라 선발행 LOT 슬롯 N 건을 만든다⌝(계약 R28). 슬롯은 `trace.lot` 행이고 `source_type_code` NOT NULL 이다. 시드 `LOT_SOURCE_TYPE` 은 **2값**(`INBOUND_RECEIPT_LINE` · `RECYCLE_ENTRY`)뿐이고 `WORK_ORDER` 가 없다 — 그룹이 `isSystemOwned` 라 서버가 값을 «가진» 축이다.

그런데 `GET /trace/lots?workOrderId=` 계약은 ⌜서버가 W/O 원천으로 풀어 준다⌝ 라 적어 그 값이 이미 있다고 전제하고, 실제로 `lot-rules.ts:73-75` 가 `source_type_code='WORK_ORDER'` 를 조건으로 쓴다. 즉 **읽는 쪽은 있고 쓰는 쪽과 등록부가 없다.**

무게를 낮추는 근거 하나: 계약 `Lot.sourceTypeCode` 응답 스키마는 enum 이 아니라 열린 문자열이라 값이 늘어도 계약 위반은 아니다. 그래서 「문의」이지 「모순」이 아니다 — 값 이름 확정만 받으면 된다.

## 지금 서버는

- `prisma/seed.ts` `LOT_SOURCE_TYPE` 에 `WORK_ORDER`(「작업지시 선발행」) 1행을 더한다. 마이그레이션이 아니다.
- 상수 `WORK_ORDER_SOURCE = 'WORK_ORDER'` 를 `src/core/lot/lot-source.ts` 한 곳에 두고 `lot-rules.ts` 와 `:release` 코어가 같이 import 한다(도메인 간 import 금지 규칙 때문에 core 로 옮긴다).
- 슬롯 행: `source_type_code='WORK_ORDER'` · `source_id=work_order_id` · `lifecycle_status_code='WAITING'` · `lot_type_code='PRODUCTION'` · `work_order_lot_seq` 1..N · `lot_hold` 는 걸지 않는다(실물이 없어 수입검사 보류가 뜻이 안 맞고, 걸면 `heldOnly`·`heldLotCount` 가 오염된다).

흔적: `lot-source.ts` 주석 `// LOT_SOURCE_TYPE 시드에 없던 값 — 시드 1행과 함께 더했다(문의 036)` · e2e `release — 슬롯 N 건의 sourceTypeCode 가 WORK_ORDER 이고 GET /trace/lots?workOrderId= 로 잡힌다`.
