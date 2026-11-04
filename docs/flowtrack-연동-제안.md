# flowtrack ↔ MES 연동 제안 — OA(PL13)

상태: 제안 · 결정 전 (2026-11-04)

OA 사업부는 MES 에서 생산계획을 세우지 않는다. ERP W/O 를 그대로 쓰고, 창고·IQC 는 MES 를 쓴다. 조립·검사·포장·출하 스캔은 flowtrack(`flowtrack_swarm/flowtrack_backend`, FastAPI)이 한다.

| 요구 | 연동 |
|---|---|
| flowtrack 이 ERP W/O 를 받는다 | MES → flowtrack |
| 포장 scan 완료 → 제품 완성 · BOM 만큼 생산창고 자재 차감 | flowtrack → MES |
| 출하 scan 완료 → 완제품 창고에서 제품 차감 | flowtrack → MES |

## 1. 정할 것

| # | 정할 것 | 권하는 안 | 다른 안 |
|---|---|---|---|
| 1 | 호출 방향 | flowtrack 백엔드가 MES 를 부른다. flowtrack 쪽 확정 결정(2026-10-27 노트 「MES 가 API 를 제공하고 백엔드가 MES 를 호출」)과 같다 | MES 가 flowtrack 을 부른다 — flowtrack 은 인증이 전혀 없다 |
| 2 | 인증 | 단말 토큰에 «연동» 종류를 더한다. 공장 PL13 고정 · 허용 오퍼레이션 목록 · 작업자 번호(`X-Worker-No`) 없음 · 행위자는 연동 계정 | 서비스 계정 세션(8시간마다 다시 로그인) · 별도 API 키 표 |
| 3 | ERP W/O 전달 | flowtrack 이 바뀐 것만 끌어간다(커서). flowtrack 에 계획된 `POST /api/v1/work-orders/sync` 가 이 API 를 부른다 | MES 가 ERP 받기 뒤 flowtrack 에 밀어 넣는다 |
| 4 | 포장 보내는 단위 | 포장 1건(시리얼 1개) = 이벤트 1개. 여러 개를 한 번에 보낼 수 있고 묶는 주기는 flowtrack 이 정한다(flowtrack 정책 `stock_move_unit`) | W/O 단위로 모아 수량만 보낸다 — 시리얼이 MES 에 남지 않아 출하 때 LOT 을 못 찾는다 |
| 5 | 제품 LOT | ERP W/O 하나에 제품 LOT 하나. 처음부터 `NORMAL`(OA 제품 검사는 flowtrack 이 한다) | 날짜별 LOT · MES W/O 를 자동으로 만들어 기존 흐름을 쓴다 — OA 에는 라우팅·생산계획이 없어 배포가 막힌다 |
| 6 | 자재 차감이 모자랄 때 | 있는 만큼 빼고 모자란 몫은 「미차감」으로 남겨 화면에서 정리한다 | 거절(제품 입고까지 막힌다) · 음수 재고 허용 |
| 7 | 출하 계기 | 컨테이너 출하 완료(flowtrack 계획의 `POST /shipments/{id}/complete`). 재오픈은 취소 | 출하 스캔마다 — flowtrack 은 스캔 삭제를 이력 없이 지우고 완료 뒤에도 헤더를 고칠 수 있다 |
| 8 | 출하 전기 | 새 간단 출고 — 시리얼로 LOT 을 찾아 그 LOT 이 있는 자리에서 뺀다 | 기존 출하작업지시 → 피킹 → 출하 흐름에 맞춘다 |
| 9 | ERP 송신 | 1단계는 보내지 않는다(§7 의 4·5 답을 받은 뒤 정한다) | 생산입고·출하를 ERP 로 보낸다 |

⚠ 5 의 권하는 안은 `docs/server-architecture.md` §4.4 「작업지시(MES W/O)는 항상 생성한다」와 어긋난다. OA 만 예외로 둘지 정해야 한다.

## 2. 흐름

```
ERP ──(중계 표 15분)──▶ MES planning.production_order (PL13)
                              │  GET /integration/flowtrack/production-orders?cursor=
                              ▼
                        flowtrack work_orders (source=MES · mes_work_order_id)
                              │  투입 스캔이 시리얼을 W/O 에 붙인다
포장 스캔 ─▶ flowtrack packing_logs + outbox ─▶ POST /integration/flowtrack/packings
                                                   ├ 제품 입고: 제품 LOT(ERP W/O) → 완제품 창고
                                                   └ 자재 차감: 기본 BOM × 수량 → 생산창고, LOT 선입선출
출하 완료 ─▶ flowtrack shipment + outbox ─▶ POST /integration/flowtrack/shipments
                                                   └ 제품 출고: 시리얼 → LOT → 그 자리
포장 삭제 · 출하 재오픈 ─▶ …:cancel ─▶ 역전기
```

flowtrack 은 요청 하나에 DB 세션 하나를 쓰고 끝날 때 커밋한다(`app/core/database.py:80-100`). 포장·출하 기록과 같은 세션에 outbox 행을 넣고, 커밋 뒤 워커가 MES 로 보낸다. 서비스 안에서 MES 를 바로 부르면 커밋 전에 보내게 된다.

## 3. API 초안

모두 연동 토큰으로 부른다. 공장은 토큰이 정한다(PL13).

### 3-1. `GET /integration/flowtrack/production-orders`

질의: `cursor`(앞 응답의 `nextCursor`, 처음엔 생략) · `size`(최대 500).

```json
{
  "items": [{
    "productionOrderId": 8812,
    "productionOrderNo": "PD260711000005",
    "itemCode": "AAR4WY1",
    "itemName": "FS-539",
    "orderQty": 147,
    "uomCode": "EA",
    "plannedStartDate": "2026-07-13",
    "statusCode": "RECEIVED",
    "erpStorageLocationCode": "S510",
    "erpOperationNo": "010",
    "updatedAt": "2026-07-12T23:10:00Z"
  }],
  "nextCursor": "2026-07-12T23:10:00Z_8812"
}
```

- 커서는 `(updated_at, production_order_id)` — 같은 시각에 바뀐 행을 빠뜨리지 않는다.
- 취소된 W/O 도 실린다(`statusCode=CANCELLED`). flowtrack 은 `CANCELLED` → `CANCELLED`, 나머지 → `RELEASED` 로 둔다.
- 품목 거르기는 flowtrack 이 한다 — 모르는 품목코드는 `unmapped_item_codes`(flowtrack 계획)로 돌려준다.
- flowtrack 은 `productionOrderId` 를 `mes_work_order_id` 에, `productionOrderNo` 를 `work_order_no` 에 둔다.

### 3-2. `POST /integration/flowtrack/packings`

```json
{
  "events": [{
    "eventId": "6f1c2a9e-…",
    "serialNo": "AAR4WY1281098",
    "itemCode": "AAR4WY1",
    "productionOrderId": 8812,
    "packedAt": "2026-07-14T08:01:02+07:00",
    "businessDate": "2026-07-14"
  }]
}
```

```json
{ "results": [{ "eventId": "6f1c2a9e-…", "status": "POSTED", "shortages": [] }] }
```

- `eventId` = flowtrack `packing_logs.id`. MES 가 영구히 기억한다 — 같은 id 를 다시 받으면 `DUPLICATE` 로 답하고 전기하지 않는다. 헤더 `Idempotency-Key` 는 72시간만 기억해 오래 밀린 재전송을 못 막는다.
- `businessDate` 는 flowtrack 이 공장 시간대로 정해 보낸다(공유계약 C-8).
- 한 요청 안에서 ERP W/O 별로 묶어 문서 하나로 전기한다. 결과는 이벤트마다 — 한 이벤트가 틀려도 나머지는 들어간다.
- `status`: `POSTED` · `DUPLICATE` · `REJECTED`(오류 목록). `shortages` 는 미차감 몫(품목·수량).
- 거절: 모르는 W/O · 품목이 W/O 와 다름 · 취소된 W/O · 같은 시리얼이 이미 포장됨.

`POST /integration/flowtrack/packings:cancel` — `{ "eventIds": [...] }`. 제품 입고와 자재 차감을 되돌린다. 출하된 시리얼이면 거절.

### 3-3. `POST /integration/flowtrack/shipments`

```json
{
  "shipmentId": "b3e1…",
  "containerNo": "TGHU1234567",
  "invoiceNo": "INV-…",
  "deliveryOrderNos": ["4500123456"],
  "destination": "…",
  "shippedAt": "2026-07-20T16:00:00+07:00",
  "businessDate": "2026-07-20",
  "serialNos": ["AAR4WY1281098", "…"]
}
```

- `shipmentId` = flowtrack 출하 헤더 id. 영구 멱등.
- 시리얼마다 포장 이벤트에서 LOT 을 찾아 그 LOT 의 재고 자리에서 뺀다. 포장 이벤트가 아직 없는 시리얼이 있으면 전체 거절 — flowtrack outbox 가 포장을 먼저 보내고 다시 보낸다.
- `POST /integration/flowtrack/shipments/{shipmentId}:cancel` — 출하 재오픈. 출고를 되돌린다.

## 4. MES 에 새로 생기는 것

- **연동 이벤트 표** — 이벤트 id(유일) · 종류 · 시리얼 · ERP W/O · 제품 LOT · 만든 전표 · 상태 · 미차감 몫. 멱등·취소·시리얼 추적이 모두 이 표를 본다.
- **LOT 원천** `PRODUCTION_ORDER`(공통코드 `LOT_SOURCE_TYPE`) — 지금 원천 넷(`INBOUND_RECEIPT_LINE`·`RECYCLE_ENTRY`·`WORK_ORDER`·`LOT_SPLIT`)에 없다.
- **원장 원천** — 생산 완료 입고 · 자재 차감 · flowtrack 출고. 지금 원천 enum 다섯에 자리가 없다.
- **자재 차감(백플러시)** — 기본 BOM 판 · `required_qty ÷ base_qty × 수량` · 생산창고의 LOT 을 오래된 것부터. 재고 posting 코어를 만지므로 전용 PR.
- **공장 설정** — 자재를 빼는 생산창고, 제품을 넣는 창고(§7 의 1·2 답에 따라).
- **연동 토큰 종류** — 발급·폐기는 기존 단말 관리 화면 자리를 쓴다.
- **화면** — 연동 이벤트 목록(실패·미차감 정리). 클라이언트 작업.

## 5. flowtrack 쪽에서 할 일

flowtrack 저장소(`mes-dev` 브랜치 기준)의 일이다. 이 저장소에서 하지 않는다.

- outbox 표와 워커 — 포장 생성·삭제, 출하 완료·재오픈 서비스에서 같은 세션으로 행을 넣는다. uvicorn 이 단일 프로세스라 lifespan 루프나 별도 워커 컨테이너.
- `packing_logs.product_sno` 중복 막기 — 지금은 서버가 막지 않고, 중복 행이 생기면 조회가 500 이 난다.
- W/O 동기화 — 계획된 `POST /api/v1/work-orders/sync` 가 3-1 을 부른다. 엑셀 업로드와 겹치면 `source=MES` 가 이긴다(이미 엑셀이 `source=MES` 행을 못 고치게 막는다).
- 출하 완료·재오픈·잠금 — 계획(P5a)대로.
- MES 로 보낸 포장·출하는 삭제를 막고 취소 이벤트로만 되돌린다(계획의 `MES_SYNCED`).
- 연동 토큰 보관(환경변수).

## 6. 지금 데이터에서 본 사실

개발 DB(2026-11-04) 기준.

| 항목 | 값 |
|---|---|
| PL13 ERP W/O | 170건, 모두 `RECEIVED` |
| ERP W/O 의 창고(SL_CD) | S510(VICT 영업창고) 157 · S410(제품 창고 영업) 13 |
| 품목코드 | flowtrack `code_prefix` 와 같다 — AAR4WY1(FS-539) · A87JWY5(RU-513) 등 |
| S410 W/O 품목 | 하위 조립품(F537…·F540… ASSY) — flowtrack 제품이 아니다 |
| 기본 BOM | ERP W/O 품목 25개 모두 있다 |
| BOM 모양 | FS-539 98줄(소요량 0 넷) · RU-513 은 総組 셋(다단) |
| 하위 조립품 | ERP 품목 계정 20(반제품)인 総組·SUB ASSY 는 ERP W/O 가 없다. 계정 30(원자재)인 사출품 F534237402·F536339101 은 PL11 의 ERP W/O(WH20)로 만든다 |
| `backflush_allowed` | 모든 줄이 false |
| 소요량 0 | 720행. 개발 DB·하노이 사본 모두 0 이다(ERP 받기가 새 판으로 바꿨다). 초기 데이터 생성기는 여전히 1 로 넣는다 |
| 소요량 0 의 모양 | 옆 줄에 바뀐 품번이 있는 경우가 보인다 — 07BA15930 0 · 07BA15930D 3, 4163529371 0 · 4163529301 12 |
| PL13 창고 | 제품(생산) S220·S420 · 제품(영업) S210·S410·S510 · 자재(생산) S230·S530 · S430 사용 안 함 |
| PL13 재고 | S510 에 한 품목뿐 |

## 7. 확인할 것

1. 제품을 넣는 창고는 ERP W/O 의 SL_CD(S510 등)인가, 제품 창고(생산) S220·S420 인가.
2. 자재를 빼는 생산창고는 어디인가 — S230·S530. ERP W/O 마다 다른가.
3. 다단 BOM — ERP W/O 가 없는 반제품(総組·SUB ASSY)은 풀어서 그 부품을 빼고, ERP W/O 로 만들어 들어오는 품목(사출품 등)은 그 품목을 빼나.
4. OA 생산입고를 지금 ERP 에 누가 어떻게 넣나. MES 가 보내게 되면, ERP 가 생산입고를 반영할 때 BOM 자재도 빼는가(ERP 송신 고객 질문 1번) — 빼면 MES 는 자재 소모를 ERP 로 보내지 않아야 한다.
5. OA 출하를 ERP 에 보내야 하나 — flowtrack 출하에는 수주가 없어 지금 ERP 출하(PGI) 송신 조건에 안 맞는다.
6. 투입 없이 포장된 시리얼(W/O 없음)은 거절하나, 그 품목의 가장 오래된 열린 W/O 에 붙이나.
7. 포장 수량이 W/O 수량을 넘으면 받나.
8. 제품 입고 때 적치 지시를 만드나 — 만들면 MES 모바일에 적치 작업이 쌓인다.
9. ERP W/O 자동 계획에서 PL13 을 빼나 — 지금은 라우팅이 없어 `NEEDS_REVIEW` 로 쌓인다.

## 8. 나눠 만들기 (MES)

| 순서 | PR | 비고 |
|---|---|---|
| 1 | 연동 토큰 종류 · 연동 계정 · 허용 오퍼레이션 | 마이그레이션 선행 커밋 |
| 2 | ERP W/O 읽기 API(3-1) | 계약 `contracts/` 에 새 파일 |
| 3 | 연동 이벤트 표 · LOT 원천 · 원장 원천 | 마이그레이션 |
| 4 | 포장 → 제품 입고(3-2, 자재 차감 빼고) | |
| 5 | 자재 차감(백플러시) | 코어 전용 PR ≤ 200줄 |
| 6 | 출하 → 제품 출고(3-3) | |
| 7 | 취소 둘 | |
| 8 | 초기 데이터 생성기가 소요량 0 을 1 로 바꾸지 않게 | 5 전에. DB 제약은 이미 0 을 받는다 |
