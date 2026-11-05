# flowtrack ↔ MES 연동 제안 — OA(PL13)

상태: 제안 · 안 B 로 정함 · 남은 결정 있음(§9-4) (2026-11-05)

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
| 5 | 제품 LOT | **정함(사용자 2026-11-05): 안 B(§9)** — ERP W/O 마다 MES W/O 를 자동으로 만들고, 배포 때 생기는 제품 LOT 을 쓴다. 원칙을 지키고 LOT 원천이 W/O 인 기존 기능을 그대로 쓴다 | 안 A — ERP W/O 하나에 제품 LOT 하나를 MES W/O 없이 만든다(새 LOT 원천 `PRODUCTION_ORDER`) |
| 6 | 자재 차감이 모자랄 때 | 있는 만큼 빼고 모자란 몫은 「미차감」으로 남겨 화면에서 정리한다 | 거절(제품 입고까지 막힌다) · 음수 재고 허용 |
| 7 | 출하 계기 | 컨테이너 출하 완료(flowtrack 계획의 `POST /shipments/{id}/complete`). 재오픈은 취소 | 출하 스캔마다 — flowtrack 은 스캔 삭제를 이력 없이 지우고 완료 뒤에도 헤더를 고칠 수 있다 |
| 8 | 출하 전기 | 새 간단 출고 — 시리얼로 LOT 을 찾아 그 LOT 이 있는 자리에서 뺀다 | 기존 출하작업지시 → 피킹 → 출하 흐름에 맞춘다 |
| 9 | ERP 송신 | 이번 범위 밖 — MES 장부만 다룬다(사용자 2026-11-04) | |
| 10 | 다단 BOM 차감 | `planning.bom` 에 공장 칸을 더한다(사용자 2026-11-04). PL13 BOM 이 있는 구성품(PL13 라인이 조립)은 그 PL13 BOM 으로 풀어 부품을 빼고, PL13 BOM 이 없는 구성품(구매품·PL11 납품)은 그 품목을 뺀다 | 한 단계만 뺀다 — 総組·SUB ASSY 는 창고에 없어 전부 미차감이 된다 · 품목계정으로 가른다 |
| 11 | 안 B 의 라우팅 | 서버가 만든다 — 공정은 「조립」 하나(`OA-ASSY`)를 쓴다(사용자 2026-11-05). §9-4 의 2 | |

⚠ 5 의 안 A 는 `docs/server-architecture.md` §4.4 「작업지시(MES W/O)는 항상 생성한다」와 어긋난다. 안 B 는 지킨다. §2~§8 은 두 안에 함께 쓰는 부분과 안 A 를 적었고, 안 B 에서 달라지는 것은 §9 에 적었다.

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
- 추적성 제외 목록(9-4 의 6)의 품목은 싣지 않는다. 그 밖에 flowtrack 이 모르는 품목코드는 `unmapped_item_codes`(flowtrack 계획)로 돌려준다.
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
- **LOT 원천** `PRODUCTION_ORDER`(공통코드 `LOT_SOURCE_TYPE`) — 안 A 만. 지금 원천 넷(`INBOUND_RECEIPT_LINE`·`RECYCLE_ENTRY`·`WORK_ORDER`·`LOT_SPLIT`)에 없다.
- **원장 원천** — 생산 완료 입고 · 자재 차감 · flowtrack 출고. 지금 원천 enum 다섯에 자리가 없다.
- **BOM 공장 칸** — `planning.bom.plant_id`. ERP BOM 받기가 `PLANT_CD` 로 채운다(지금은 읽고 버린다). 이미 있는 판은 ERP 사본으로 채운다. 같은 모품목 BOM 이 두 공장에서 오면 지금처럼 오류.
- **자재 차감(백플러시)** — 기본 BOM 판 · `required_qty ÷ base_qty × 수량` · 소요량 0 은 건너뛴다 · PL13 BOM 이 있는 구성품은 그 BOM 으로 다시 푼다 · 생산창고의 LOT 을 오래된 것부터. 재고 posting 코어를 만지므로 전용 PR.
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
| BOM 구성품(ERP 원본 2026-08-25 · OA 완제품 25개 · 최대 9단) | 서로 다른 구성품 4,407. PL13 BOM 이 있는 품목 1,158 · PL11 BOM 만 있는 품목 466(그중 PL11 ERP W/O(WH20) 기록 288) · BOM 이 없는 품목 2,783 |
| BOM 의 공장 | ERP BOM 은 공장(`PLANT_CD`)마다 오고 두 공장에 같은 모품목이 있는 경우는 없다. MES `planning.bom` 에는 공장 칸이 없다 — PL11 이 만드는 사출품 F534237402 의 BOM(수지 2줄)이 공장 없이 들어 있다 |
| `backflush_allowed` | 모든 줄이 false |
| 소요량 0 | 720행. 개발 DB·하노이 사본 모두 0 이다(ERP 받기가 새 판으로 바꿨다). 초기 데이터 생성기는 여전히 1 로 넣는다 |
| 소요량 0 의 모양 | 옆 줄에 바뀐 품번이 있는 경우가 보인다 — 07BA15930 0 · 07BA15930D 3, 4163529371 0 · 4163529301 12 |
| PL13 창고 | 제품(생산) S220·S420 · 제품(영업) S210·S410·S510 · 자재(생산) S230·S530 · S430 사용 안 함 |
| PL13 재고 | S510 에 한 품목뿐 |

## 7. 확인할 것

1. 제품을 넣는 창고 — 답(사용자 2026-11-05): S510 OA 생산완제품창고.
2. 자재를 빼는 생산창고 — 답(사용자 2026-11-05): S530 OA 생산창고. 불량품창고는 S550.
3. 투입 없이 포장된 시리얼(W/O 없음)은 거절하나, 그 품목의 가장 오래된 열린 W/O 에 붙이나.
4. 포장 수량이 W/O 수량을 넘으면 — 답(사용자 2026-11-05): 지시수량을 채우면 마감하고, 마감 뒤 더 오는 포장은 거절한다.
5. 제품 입고 때 적치 지시를 만드나 — 만들면 MES 모바일에 적치 작업이 쌓인다.
6. 안 A 면 ERP W/O 자동 계획에서 PL13 을 빼나. 개발 DB 의 PL13 170건은 받을 때 계획 시작일이 지나 자동 계획을 건너뛰었다(`auto_plan_attempted_at` 0건). 시작일이 앞날인 ERP W/O 가 오면 라우팅이 없어 `NEEDS_REVIEW`(`ROUTING_MISSING`)가 된다.

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
| 9 | BOM 공장 칸 — 칸 더하기(널 허용) · ERP 받기가 채움 · 기존 판 채우기 | 5 전에. 마이그레이션 선행 커밋. 채운 뒤 NOT NULL 은 다음 릴리스 |

## 9. 안 B — MES W/O 를 거친다

ERP W/O 하나마다 MES W/O 하나를 자동으로 만들고 배포한다. 제품 LOT·실적·시리얼은 지금 MES W/O 가 쓰는 길을 그대로 탄다.

### 9-1. 흐름

```
ERP W/O 받기(PL13)
  └ 자동 계획 → 계획 확정 → MES W/O 1건(라우팅 공정 1개) → 자동 배포
       └ lotSize = 지시수량 → 제품 LOT 1개(INSPECTION_PENDING)
포장 이벤트
  ├ 실적 1건(양품 1 · 그 LOT 에 배분 · idempotency_key = eventId)
  │   └ 공정 검사 없음 → 「검사 없는 실적」으로 LOT NORMAL
  ├ 시리얼 등록(flowtrack 번호 그대로 · 그 LOT)
  ├ 제품 입고 전기(완제품 창고 · 적치 지시 없음)
  └ 자재 차감(§4)
출하 → 시리얼 → LOT → 출고(§3-3 과 같다)
```

### 9-2. 지금 있는 것과 없는 것

| 단계 | 지금 MES | 안 B 에서 |
|---|---|---|
| 자동 계획 | ERP W/O 를 처음 받을 때, 계획 시작일이 앞날이면 돈다 | PL13 은 날짜와 상관없이 돌린다. 이미 받은 170건은 한 번에 돌린다 |
| 계획 확정 | 사람이 한다. 라우팅 공정마다 MES W/O 1건 | 자동으로 한다 |
| 배포 | 사람이 `lotSize` 를 넣는다. 기본 위치 셋(WIP·FG·폐기)이 있어야 한다 | 자동으로 한다. `lotSize = 지시수량` |
| 실적 | `X-Worker-No` 필수 · 결과 원천은 설비·수기·POP 셋 | 연동이 실적을 쓴다. 결과 원천에 연동 값을 더한다 |
| 시리얼 | 서버가 번호를 매기고 단말·라벨 권한이 있어야 한다 | flowtrack 번호를 받아 그 LOT 에 넣는다(새 코드) |
| 제품 재고 | 실적이 재고를 올리지 않는다. 사람이 생산입고를 따로 한다 | 실적과 같은 트랜잭션에서 제품 입고를 전기한다 |
| 자재 차감 | 없다 | 새로 만든다(§4) |
| 마감 | `RELEASED` 는 마감할 수 없다. `IN_PROGRESS` 는 단말 작업 세션으로만 된다. 마감하면 ERP 생산입고 송신이 쌓인다 | 정해야 한다(9-4) |

자재 출고요청은 생기지 않는다. 배포는 W/O 공정에 묶인 BOM 구성품만 출고요청에 담는데, BOM 구성품 22,793행 중 공정에 묶인 행이 0 이다.

### 9-3. OA 가 준비할 기준정보

| 기준정보 | 수 | 내용 |
|---|---|---|
| 공정 | 1 | 「조립」 `OA-ASSY`(유형 `ASSEMBLY`). 개발 DB 에 2026-11-05 등록됐다. 하노이 DB·초기 데이터에는 없다 |
| 라우팅 | 0 | 서버가 만든다(9-4 의 2) |
| 라인 | 1 | 기본 위치 셋(사용자 2026-11-05) — WIP = S530 OA 생산창고 · FG = S510 OA 생산완제품창고 · 폐기 = S550 OA 불량품창고. 지금 PL13 라인은 시험용 하나뿐이고 기본 위치가 비어 있다 |
| 라인을 정하는 근거 | 9-4 의 1 | 지금 자동 계획은 품목·설비 매핑(`item_resource_map`)의 설비가 속한 라인으로만 라인을 정한다 |
| 연동 계정 | 1 | 배포·마감·취소의 행위자 |

BOM 은 이미 있다(25개 모두 기본 BOM 하나).

⚠ 라인 기본 위치는 자재창고(`MATERIAL`) 유형 창고에 둘 수 없다(`src/mdm/equipment/equipment-group.service.ts` — 「자재창고 위치면 WIP 출고가 창고 안에서 맴돈다」). S530 과 S550 은 지금 `MATERIAL` 이다(초기 데이터가 창고 이름으로 유형을 정했다 — S530 「VICT 생산 원자재 창고」 · S550 「원자재 불량품 창고」). `MATERIAL` 유형은 그 밖에 자재 피킹이 출처 창고를 고를 때만 쓴다(`src/core/picking/picking-generation.ts`). 안 B 는 자재 출고요청·피킹을 만들지 않는다(9-2).

### 9-4. 안 B 에서 정할 것

정한 것(사용자 2026-11-05): 안 B 로 간다 · 2 · 4 · 5 · 6 · 7 · 창고(S530·S510·S550).

1. 라인을 정하는 근거 — 생산창고·완제품 창고가 한 쌍(S530·S510)이므로 공장 기본 라인 설정 자리 하나(「PL13 자동 계획 라인」)를 권한다. 다른 안은 가상 설비 하나와 품목마다 매핑.
1-2. S530·S550 의 창고 유형 — `MATERIAL` 을 다른 유형으로 바꿔 라인 기본 위치에 둘 수 있게 하나(`GENERAL` 또는 공통코드 `WAREHOUSE_TYPE` 에 「생산」을 더한다). 바꾸면 두 창고가 자재 피킹 출처 후보에서 빠진다. 폐기 위치는 S550 대신 폐기창고 S551(`GENERAL`)로 둘 수도 있다.
1-3. 위치 — 기본 위치는 위치 하나를 가리킨다. 자재 차감은 그 위치가 아니라 그 창고(S530)의 맨 아래 위치 전체에서 오래된 LOT 부터 뺀다 — S530 에는 `SYS-WHOLE` 과 선반 `Z01-R001-L01~L03` 이 있다. 제품은 S510 `SYS-WHOLE` 에 넣는다(S510 의 지금 재고가 그 자리에 있다).
2. 라우팅 — **정함(사용자 2026-11-05): 서버가 만든다.** PL13 ERP W/O 로 자동 계획을 돌릴 때 그 품목에 쓸 수 있는 라우팅이 없으면, 공정 `OA-ASSY` 1줄짜리 라우팅을 만들어 확정하고 기본 판으로 둔다. 줄의 설정 — 실적 관리 켬 · 공정 검사 끔 · 설비 필수 끔 · 금형 필수 끔 · 자재 투입 관리 끔. 사람이 만든 라우팅이 이미 있으면 그것을 쓰고 만들지 않는다. 쓸 공정은 코드에 박지 않고 설정 한 곳에 둔다. 공정 마스터는 MES 정본이라(W-06-01 《공정 마스터》) 하노이 DB 에도 같은 코드로 등록해야 한다.
3. 실적 작업자 — 사용자 2026-11-05: OA 사업부는 작업자를 관리하지 않고 부품사업부(PL11)는 관리한다. 지금 `production.production_result.worker_id` 가 NOT NULL 이라 마이그레이션으로 널을 허용해야 한다. 누가 비울 수 있나:
   - 가. 공장 설정 「실적 작업자 필수」 — PL11 켬 · PL13 끔. 서버가 W/O 의 공장으로 본다. OA 에서 사람이 실적을 고칠 때도 작업자가 없다. DB 는 공장을 못 보므로 서버만 막는다.
   - 나. 결과 원천이 연동인 실적만 비운다 — DB CHECK 로 막는다. OA 에서 POP·수기 실적을 쓰면 작업자가 필요하다.
   - 권하는 안: 가. 사업부마다 다르다는 규칙을 그대로 옮긴다. 실적을 읽는 화면·응답은 작업자가 없는 행을 견뎌야 한다.
4. 마감 — **정함: 포장이 지시수량을 채우면 마감한다.** 양품 합이 지시수량에 닿는 포장 이벤트의 트랜잭션에서 연동이 마감한다(판정 `NORMAL`). 필요한 것:
   - 전이 — 지금 마감은 `COMPLETED`·`IN_PROGRESS`·`SUSPENDED` 에서만 되고 `IN_PROGRESS` 는 단말 작업 세션으로만 된다. 첫 포장 실적 때 `RELEASED` → `IN_PROGRESS` 로 올리거나, 연동 마감이 `RELEASED` 에서 바로 마감하는 전이를 연다.
   - 마감 뒤 그 W/O 에 더 오는 포장은 거절한다(사용자 2026-11-05). 마감한 W/O 는 고칠 수 없다(트리거 `trg_work_order_closed_immutable`).
   - 마감 뒤 포장 취소는 막는다(사용자 2026-11-05).
   - 마감은 ERP 생산입고 송신(`IF_WO_CLOSE`)을 쌓는다 — ERP 가 범위 밖이므로 PL13 은 쌓지 않는다.
5. ERP W/O 취소 — **정함: MES W/O 도 취소한다.** 지금 ERP 의 변경·취소는 사람 확인 흐름(W-02-06)으로 가는데, PL13 은 ERP 받기가 MES W/O 취소까지 한다. 취소는 쓰고 있는 LOT 까지 폐번하므로, 실적이 없으면 자동으로 취소하고 실적이 있으면 취소하지 않고 사람 확인 목록(W-02-06)에 남긴다(사용자 2026-11-05).
6. 추적성 제외 목록 — **정함: 목록에 든 품목은 제외한다.** 제외 품목의 ERP W/O 는 라우팅 자동 생성·자동 계획·MES W/O 를 만들지 않고, flowtrack W/O 목록(3-1)에도 싣지 않는다. 목록은 사람이 늘리고 줄이는 설정(공통코드 그룹 등)에 둔다. 처음 목록 — 개발 DB 에서 ERP W/O 의 창고가 S410 인 13건의 품목 11개:

   | 품목 | 이름 | ERP W/O |
   |---|---|---|
   | A3EP03Y709AP | RU UNIT : LXK | PD260529000072 |
   | A63GF80007 | Feed Path Switching Assy | PD260626000008 |
   | F534290700AP | PM MOTOR:M05Z18 | PD260601000027 |
   | F5360WY106AP | EJECT UNIT | PD260629000074 |
   | F537D31000AP | SUB ASSY:CAM PS MOTOR:PADDLE | PD260601000029 · PD260629000075 |
   | F537F36100AP | ASSY:KBL42SCP521B:S2M12T | PD260601000030 · PD260629000076 |
   | F540C36000AP | ASSY:SUB:TRAY:TAMPER:FRONT | PD260629000077 |
   | F540C52101AP | ASSY:SUB:STAPLER HEAD:STAPLER | PD260629000078 |
   | F540E30400AP | SUB ASSY:MP:PADDLE | PD260629000079 |
   | S511290600AP | ASSY:BKT:GUIDE PRESS:SD | PD260629000080 |
   | S511591300AP | ASSY:BKT:MOTOR:FOLDING ROLL | PD260601000028 |

   목록의 단위는 품목이다 — 같은 품목의 ERP W/O 가 새로 와도 제외된다. 창고 코드(S410)로 가르지 않는다.
7. BOM 공장 — **정함: 자동 계획은 PL13 BOM 을 고르고, 자재 차감도 PL13 BOM 만 푼다**(정할 것 10).

### 9-5. 안 A 와 비교

| | 안 A — ERP W/O 에 LOT | 안 B — MES W/O 를 거친다 |
|---|---|---|
| 설계 원칙 §4.4 | 예외를 둔다 | 지킨다 |
| LOT 원천을 W/O 로 보는 기존 기능 — 실적 LOT 배분 · 자재 → 제품 계보 · 시리얼 · OA 검사표 · LOT 추적 흐름 · 생산입고 현황 · 재작업 W/O · ERP W/O 진행 | 새 원천에 맞춰 하나씩 다시 맞춘다 | 그대로 쓴다 |
| OA 기준정보 | 창고 설정뿐 | 공정 하나 · 라인 · 라인 근거 · 연동 계정 · 추적성 제외 목록. 라우팅은 서버가 만든다 |
| 품목이 늘면 | 할 일 없다 | 라인 근거를 하나씩 더한다(9-4 의 1 에 따라 없을 수도 있다) |
| 새 코드 | LOT 원천 · 연동 이벤트 표 · 제품 입고 · 자재 차감 · 출고 | 자동 계획·확정·배포 묶음 · 실적 변환 · 시리얼 등록 · 제품 입고 · 자재 차감 · 출고 · 마감 처리 |
| 연동 이벤트 표 | 멱등·시리얼·취소를 모두 맡는다 | 포장은 실적의 `idempotency_key` 와 시리얼 표가 맡는다. 출하·미차감 기록만 남는다 |
| 화면 | OA 생산은 ERP W/O 화면에서만 보인다 | MES W/O · 실적 · LOT · 시리얼 화면에 그대로 보인다 |

### 9-6. 나눠 만들기 (안 B)

| 순서 | PR | 비고 |
|---|---|---|
| 1 | 연동 토큰 · 연동 계정 · 허용 오퍼레이션 | §8 의 1 과 같다 |
| 2 | ERP W/O 읽기 API | §8 의 2 와 같다 |
| 3 | BOM 공장 칸 · 소요량 0 생성기 | §8 의 8·9 와 같다 |
| 4 | PL13 라우팅 자동 생성(`OA-ASSY` 1줄) | 쓸 공정 설정 자리 |
| 4-2 | PL13 자동 계획·확정·배포 묶음 · 라인 근거(9-4 의 1) · 추적성 제외 목록(9-4 의 6) · PL13 BOM 고르기(9-4 의 7) | planning → production 경계를 넘는다 |
| 5 | 포장 → 실적 · 시리얼 · 제품 입고 | 결과 원천 공통코드 · 실적 작업자 널 허용(9-4 의 3) — 마이그레이션 선행 커밋 |
| 6 | 자재 차감(백플러시) | 코어 전용 PR ≤ 200줄 |
| 7 | 출하 → 제품 출고 · 연동 이벤트 표(출하·미차감) | |
| 8 | 지시수량을 채우면 마감(9-4 의 4) · ERP W/O 취소 → MES W/O 취소(9-4 의 5) · 포장 취소 | |
