# flowtrack ↔ MES 연동 제안 — OA(PL13)

상태: 제안 · 안 B 로 정함 · API 는 flowtrack 구현(`flowtrack_backend/docs/mes-integration.md` · `mes-dev` 2026-11-09)에 맞춤 · flowtrack 회신 반영 · 미룬 것 1(§1-2) (2026-11-12)

OA 사업부는 MES 에서 생산계획을 세우지 않는다. ERP W/O 를 그대로 쓰고, 창고·IQC 는 MES 를 쓴다. 조립·검사·포장·출하 스캔은 flowtrack(`flowtrack_swarm/flowtrack_backend`, FastAPI)이 한다.

| 요구 | 연동 |
|---|---|
| flowtrack 이 W/O 를 받는다 | MES → flowtrack |
| 포장 scan 완료 → 제품 완성 · BOM 만큼 생산창고 자재 차감 | flowtrack → MES |
| 출하 scan 완료 → 완제품 창고에서 제품 차감 | flowtrack → MES |
| S410 품목(시리얼 없음) — 품목코드로 W/O 를 찾아 골라 마감 → 제품 완성 · 자재 차감. 출하는 품목·수량 | flowtrack → MES |
| W/O 조기 마감 — 남은 수량 처리·사유를 골라 마감 → MES W/O 마감 | flowtrack → MES |

## 1. 결정

### 1-1. 정한 것

| # | 무엇 | 정한 안 | 언제 |
|---|---|---|---|
| 1 | 제품 LOT | 안 B — ERP W/O 마다 MES W/O 를 자동으로 만들고 배포 때 생기는 제품 LOT 을 쓴다(§7) | 사용자 2026-11-05 |
| 2 | API 형식 | flowtrack 구현에 맞춘다 — 호출 방향(flowtrack 이 MES 를 부른다) · 인증(단말 유형 `TRACKING_SYSTEM`) · W/O 받기(MES W/O 목록) · 포장은 W/O 단위 · 출하는 컨테이너 완료 때 D/O 별 시리얼(§3) | 사용자 2026-11-12 |
| 3 | ERP 송신 | 이번 범위 밖 — MES 장부만 다룬다 | 사용자 2026-11-04 |
| 4 | 창고 | 자재 차감 S530 OA 생산창고 · 제품 입고는 ERP W/O 의 창고(SL_CD — 생산이 끝난 제품을 넣는 창고. 지금 S510 · S410) · 불량 S550 | 사용자 2026-11-05 |
| 5 | 다단 BOM | `planning.bom` 에 공장 칸을 더한다. PL13 BOM 이 있는 구성품은 그 BOM 으로 풀고, 없는 구성품(구매품·PL11 납품)은 그 품목을 뺀다. 자동 계획도 PL13 BOM 을 고른다 | 사용자 2026-11-04 · 11-05 |
| 6 | 라우팅 | 서버가 만든다 — 공정 「조립」 `OA-ASSY` 1줄(§7-3 의 2) | 사용자 2026-11-05 |
| 7 | 생산라인 | OA 자동 W/O 는 라인·기본 위치 없이 배포한다(§7-3 의 1) | 사용자 2026-11-12 |
| 8 | 실적 작업자 | 작업자 필수 설정을 두지 않는다. 작업자 칸을 비울 수 있게 하고 연동 실적은 작업자 없이 쓴다(§7-3 의 3) | 사용자 2026-11-12 |
| 9 | OA 설정 | 운영 정책(W-05-01 · `app.operation_policy`)에 PL13 범위 행으로 둔다 — 자동 라우팅 공정 · 자재 차감 창고. 정책 코드 둘을 더한다 | 사용자 2026-11-12 |
| 10 | 마감 | 양품 합이 지시수량에 닿으면 마감한다. 마감 뒤 오는 포장은 거절한다. 마감 뒤 포장 취소는 막는다 | 사용자 2026-11-05 |
| 11 | ERP W/O 취소 | 실적이 없으면 MES W/O 도 취소한다. 실적이 있으면 사람 확인 목록(W-02-06)에 남긴다 | 사용자 2026-11-05 |
| 12 | 투입 스캔 없이 포장된 시리얼 | 거절한다. flowtrack 은 공정 순서 판정을 「막음」(ENFORCE)으로 운영한다(§5) | 사용자 2026-11-12 |
| 13 | 제품 입고의 적치 지시 | 만들지 않는다 — S510·S410 에는 선반이 없다 | 사용자 2026-11-12 |
| 14 | 배포 검사의 기본 위치 | 모든 공장에서 폐기·FG 위치를 검사에서 뺀다. WIP 만 남긴다(OA 와 별개 · §7-3 의 1-2) | 사용자 2026-11-12 |
| 15 | S410 품목 | 시리얼이 없다. flowtrack 이 품목코드로 W/O 를 찾아 골라 마감하고, MES 는 마감 보고로 실적·제품 입고·자재 차감·마감을 한다. 출하는 품목·수량(§3-5) | 사용자 2026-11-05 · 11-12 |
| 16 | 자재 차감이 모자랄 때 | 있는 만큼 빼고 모자란 몫은 「미차감」으로 남겨 화면에서 정리한다. 제품 입고는 막지 않는다 | 사용자 2026-11-12 |
| 17 | 마감 전이 | 연동 마감이 `RELEASED` 에서 바로 마감하는 전이를 연다(§7-3 의 4) | 사용자 2026-11-12 |
| 18 | ERP W/O 에 창고(SL_CD)가 없거나 MES 에 없는 창고 | 포장 입고이동·마감 보고를 거절한다 | 사용자 2026-11-12 |
| 19 | 조기 마감 | flowtrack 이 수동 마감하고, 그 W/O 의 포장을 모두 보낸 뒤 마감 보고(3-5)에 남은 수량 처리·사유·비고를 싣는다. 사유 목록은 MES 공통코드 조회로 받는다. 양품 합이 0 이면 MES 는 마감하지 않고 취소한다. MES 관리웹은 OA 자동 W/O 를 마감하지 않는다(§7-3 의 4 · §5) | 사용자 2026-11-12 |
| 20 | 업무일자 | flowtrack 이 모든 본문에 `businessDate` 를 더한다(공유계약 C-8 · §5) | 사용자 2026-11-12 |

### 1-2. 미룬 것

| 무엇 | 지금 | 살펴본 안 | 언제 |
|---|---|---|---|
| 도입 전 재고의 시리얼 | flowtrack 은 도입 전 재고를 제품별 가짜 W/O `STOCK-<품목코드>` 의 투입으로 넣는다. MES 에 그 W/O·시리얼이 없어 그 포장의 입고이동과 그 시리얼이 섞인 출고가 4xx 다. 재고 조정은 LOT 을 만들지 않고, 시리얼은 LOT 이 있어야 등록된다(`trace.serial_number.lot_id` NOT NULL) | 기초 재고 API(시리얼째 · 새 LOT 원천) · 재고 조정(수량만 · 출하가 시리얼·수량 두 전송으로 갈린다) | 정상 흐름을 마친 뒤(사용자 2026-11-12) |

## 2. 흐름

```
ERP ──(중계 표 15분)──▶ MES ERP W/O (PL13)
   └ 자동 계획 → 확정 → MES W/O(OA-ASSY 1공정 · 라인 없음) → 자동 배포 → 제품 LOT 1개(lotSize = 지시수량)
        │  GET /production/work-orders (5분마다 · TRACKING_SYSTEM 토큰)
        ▼
   flowtrack work_orders (mes_work_order_id)

시리얼 품목
   투입 스캔 → 시리얼을 W/O 에 붙인다
   포장 스캔 → 포장 수가 지시수량에 닿음 · 조기 마감 전 · 출하 완료 전
        ─▶ POST /integration/tracking-system/stock-moves (W/O 하나 · 시리얼 목록)
             ├ 실적(양품 = 시리얼 수 · 작업자 없음) → 「검사 없는 실적」으로 LOT NORMAL
             ├ 시리얼 등록(flowtrack 번호 그대로 · 그 LOT)
             ├ 제품 입고 → ERP W/O 의 창고 `SYS-WHOLE` · 적치 지시 없음
             ├ 자재 차감 → PL13 BOM × 수량 · S530 · LOT 선입선출
             └ 양품 합이 지시수량에 닿으면 마감
   조기 마감(남은 수량 처리·사유를 고른다)
        ─▶ POST /integration/tracking-system/work-order-closes (qty 0)
             └ 마감 · 양품 합이 0 이면 취소
   출하 완료(컨테이너)
        ─▶ POST /integration/tracking-system/stock-issues (D/O 별 시리얼)
             └ 제품 출고 → 시리얼 → LOT → 그 자리

S410 품목(시리얼 없음)
   품목코드로 W/O 를 찾아 골라 마감
        ─▶ POST /integration/tracking-system/work-order-closes (qty = 만든 수 · 적으면 남은 수량 처리·사유)
             └ 실적 · 제품 입고(S410) · 자재 차감 · 마감
   출하
        ─▶ GET  /integration/tracking-system/stocks (S410 재고 확인)
        ─▶ POST /integration/tracking-system/qty-issues (품목·수량)
             └ 제품 출고 → S410 의 LOT 을 오래된 것부터
```

## 3. API (flowtrack 형식)

### 3-1. 인증

- 단말 유형 `TRACKING_SYSTEM` 을 더한다. 지금 단말 유형은 `POP` · `MOBILE` 뿐이다.
- 이 유형에 토큰을 발급한다(`POST /mdm/terminals/{id}:issue-token`).
- 공장 PL13 고정 · `X-Worker-No` 없음 · 행위자는 연동 계정.
- 허용 오퍼레이션: W/O 목록 · 공통코드 조회(`GET /mdm/code-values` — 마감 사유) · 3-3 · 3-4 · 3-5 의 셋.

### 3-2. W/O 조회 — `GET /production/work-orders`

flowtrack 은 `open=true&page=&size=100` 을 끝까지 읽는다. 쓰는 칸 — `workOrderId` · `workOrderNo` · `itemCode` · `orderQty` · `statusCode` · `workOrderTypeCode` · `priorityNo` · `remarks` · `plannedStartAt` · `plannedEndAt` · `releasedAt`(모두 지금 응답에 있다).

| 요청(flowtrack 2.2) | MES |
|---|---|
| `TRACKING_SYSTEM` 토큰은 PL13 W/O 를 공정 매핑 없이 읽는다 | 단말 읽기 범위(`src/auth/terminal-read-policy.ts`)에 이 유형을 더한다. POP 는 공정 매핑으로 좁히고 `open=true` 만 받는다 |
| 닫힌 W/O(`COMPLETED` · `CLOSED` · `CANCELLED`)도 읽는다 | `updatedSince` 로 읽으면 닫힌 W/O 도 실린다 |
| 변경분 조회 `updatedSince=<시각>` | 질의를 더하고 응답에 `updatedAt` 을 싣는다. `production.work_order.updated_at` 은 있다 |

- flowtrack 은 `open=true` 로 열린 W/O 를 읽고, `updatedSince=<마지막 받기 − 10분>` 으로 닫힌 W/O 만 옮긴다(회신 2026-11-12). 두 응답은 같은 칸이다. `updatedAt` 은 flowtrack 이 쓰지 않는다.

### 3-3. 포장 입고이동 — `POST /integration/tracking-system/stock-moves`

```
Authorization: Bearer <TRACKING_SYSTEM 토큰>
Idempotency-Key: <transmissionId>
```

```json
{
  "transmissionId": "5f0c…",
  "workOrderNo": "WO-2611-0012",
  "mesWorkOrderId": 1001,
  "itemCode": "A4F3WY7",
  "qty": 120,
  "serialNos": ["A4F3WY7000001", "A4F3WY7000002"],
  "packedFrom": "2026-11-09T01:00:00Z",
  "packedTo": "2026-11-09T09:30:00Z",
  "businessDate": "2026-11-09"
}
```

- flowtrack 은 W/O 포장 수가 지시수량에 닿을 때 · 조기 마감 전 · 출하 완료 전(그 컨테이너의 아직 안 보낸 포장) 보낸다.
- `businessDate` 는 더해 달라는 칸이다(§1-1 의 20).
- `mesWorkOrderId` 가 `null` 이면 `workOrderNo` 로 찾는다.
- 처리 — 한 트랜잭션: 실적(양품 `qty`) · 시리얼 등록 · 제품 입고 · 자재 차감 · 양품 합이 지시수량에 닿으면 마감.
- 거절(4xx): 모르는 W/O · 품목이 W/O 와 다름 · `qty` ≠ 시리얼 수 · 취소·마감된 W/O · 양품 합이 지시수량을 넘음 · MES 에 이미 있는 시리얼 · ERP W/O 에 창고(SL_CD)가 없거나 MES 에 없는 창고.

### 3-4. 출하 출고 — `POST /integration/tracking-system/stock-issues`

```json
{
  "transmissionId": "9a1d…",
  "containerNo": "TCLU1234567",
  "viNo": "VI-2611-001",
  "invoiceNo": "INV-2611-001",
  "shipDate": "2026-11-10",
  "destination": "Japan",
  "qty": 240,
  "lines": [
    {"doNo": "0001234567", "itemCode": "A4F3WY7", "qty": 120, "serialNos": ["A4F3WY7000001"]}
  ],
  "businessDate": "2026-11-10"
}
```

- flowtrack 은 컨테이너가 다 차거나 관리자가 미달 완료하면 보낸다. 그 컨테이너 시리얼의 입고이동이 모두 `SENT` 가 된 뒤다.
- 처리: 시리얼 → LOT → 그 LOT 의 재고 자리에서 뺀다. 컨테이너·VI·인보이스·D/O 번호를 출고 전표에 남긴다.
- 거절(4xx): MES 에 없는 시리얼 · 이미 출고된 시리얼 · 줄의 품목 ≠ 시리얼의 품목 · 줄 `qty` ≠ 시리얼 수 · 머리 `qty` ≠ 줄 합.
- `POST /logistics/shipments`(출하지시·LOT 배분 필수)는 쓰지 않는다.

### 3-5. 마감 보고 · S410 품목(시리얼 없음)

flowtrack 은 3-2 로 받아 둔 W/O 를 품목코드로 찾는다. MES 목록 질의 `q` 는 W/O 번호만 찾으므로, MES 에서 바로 찾으려면 `itemCode` 질의를 더한다.

**마감 보고 — `POST /integration/tracking-system/work-order-closes`**

```json
{
  "transmissionId": "c27e…",
  "workOrderNo": "WO-2611-0031",
  "mesWorkOrderId": 1020,
  "itemCode": "F537D31000AP",
  "qty": 50,
  "businessDate": "2026-11-12"
}
```

시리얼 품목의 조기 마감:

```json
{
  "transmissionId": "d41a…",
  "workOrderNo": "WO-2611-0012",
  "mesWorkOrderId": 1001,
  "itemCode": "A4F3WY7",
  "qty": 0,
  "remainderDispositionCode": "WRITE_OFF",
  "reasonCode": "PLAN_CHANGE",
  "remarks": "flowtrack 마감: <관리자>",
  "businessDate": "2026-11-12"
}
```

- `qty` — 시리얼 없이 올릴 양품 수. S410 은 만든 수 — 다 만들면 지시수량(flowtrack 2.6), 적게 끝내면 그 수(#274). 시리얼 품목은 0 — 시리얼은 입고이동(3-3)으로 이미 왔다.
- `remainderDispositionCode`(`CARRY_OVER` 이월 · `WRITE_OFF` 소멸) · `reasonCode` — 양품 합이 지시수량보다 적으면 둘 다 필수, 지시수량에 닿으면 둘 다 비운다(`close-rules.ts` · 관리웹 마감과 같다). 이월은 표시만 하고 새 W/O 를 만들지 않는다.
- 사유 목록 — `GET /mdm/code-values?codeGroupCode=WORK_ORDER_COMPLETION_VARIANCE_REASON`. `OVER_PRODUCTION` 은 초과 마감용이다.
- `remarks` — 선택. flowtrack 마감자를 싣는다. MES 의 마감자는 연동 계정이다.
- 처리 — 한 트랜잭션: `qty` 만큼 실적 · 제품 입고(ERP W/O 의 창고) · 자재 차감 → 마감. 양품 합이 0 이면 마감하지 않고 취소한다(LOT 폐번 · §1-1 의 11 과 같다).
- 그 W/O 의 입고이동이 모두 `SENT` 가 된 뒤에 보낸다. 지시수량에 닿은 W/O 는 MES 가 이미 마감했으므로 보내지 않는다.
- 거절(4xx): 모르는 W/O · 품목이 W/O 와 다름 · 취소·마감된 W/O · 양품 합이 지시수량을 넘음 · 미달인데 처분·사유가 없음 · 모르는 사유 코드 · ERP W/O 에 창고(SL_CD)가 없거나 MES 에 없는 창고.

**재고 조회 — `GET /integration/tracking-system/stocks?warehouseCode=S410&itemCode=`**

```json
{ "items": [{ "itemCode": "F537D31000AP", "qty": 30 }] }
```

- `qty` — 그 창고의 품질 NORMAL 재고 합. `itemCode` 를 빼면 그 창고의 품목 전부.
- 시스템 도입 전 S410 재고는 MES 에 먼저 넣는다(재고 조정). 개발 DB 의 S410 재고는 0 이다.

**수량 출고 — `POST /integration/tracking-system/qty-issues`**

```json
{
  "transmissionId": "e81b…",
  "warehouseCode": "S410",
  "itemCode": "F537D31000AP",
  "qty": 20,
  "businessDate": "2026-11-12"
}
```

- 처리: 그 창고의 LOT 을 오래된 것부터 뺀다.
- 거절(4xx): 재고가 모자람 · PL13 창고가 아님.

### 3-6. 공통

- 응답: 2xx 받음 · 4xx 거절(flowtrack 은 다시 보내지 않고 `FAILED`, 본문 `{errors: [{code, message}]}` 의 메시지를 화면에 보인다) · 5xx·시간 초과는 flowtrack 이 간격을 늘려 다시 보낸다.
- 멱등: 처리한 `transmissionId` 를 영구히 기억하고, 다시 오면 처리하지 않고 2xx 를 돌려준다. 헤더 `Idempotency-Key` 는 72시간만 기억하고, flowtrack 은 `FAILED` 를 관리자가 언제든 다시 보낸다. 거절한 전송은 기억하지 않는다.
- 되돌리는 API 는 두지 않는다 — flowtrack 이 MES 로 보낸 포장의 삭제(`MES_SYNCED`)와 출하의 재오픈을 막는다.

## 4. MES 에 새로 생기는 것

- **단말 유형 `TRACKING_SYSTEM`** · 연동 계정 · 허용 오퍼레이션 · 단말 읽기 범위. 발급·폐기는 기존 단말 관리 화면 자리를 쓴다.
- **W/O 목록** — `updatedSince` 질의 · `updatedAt` 칸.
- **연동 전송 표** — 받은 전송 하나에 한 행: `transmissionId`(유일) · 종류 · W/O · 만든 전표 · 미차감 몫.
- **원장 원천** — 생산 완료 입고 · 자재 차감 · 연동 출고. 지금 원천 enum 다섯에 자리가 없다.
- **결과 원천** — 실적 결과 원천 공통코드에 연동 값. 지금은 설비·수기·POP.
- **실적 작업자 널 허용**(§7-3 의 3).
- **운영 정책 코드 둘** — 자동 라우팅 공정 · 자재 차감 창고. 값이 글자이므로 저장할 때 그 공정·창고가 있는지 서버가 검사한다. 정책을 고치는 공용 화면이 없어 처음 값은 초기 데이터로 넣는다.
- **BOM 공장 칸** — `planning.bom.plant_id`. ERP BOM 받기가 `PLANT_CD` 로 채운다(지금은 읽고 버린다). 이미 있는 판은 ERP 사본으로 채운다. 같은 모품목 BOM 이 두 공장에서 오면 지금처럼 오류.
- **자재 차감(백플러시)** — 기본 BOM 판 · `required_qty ÷ base_qty × 수량` · 소요량 0 은 건너뛴다 · PL13 BOM 이 있는 구성품은 그 BOM 으로 다시 푼다 · S530 의 맨 아래 위치 전체에서 LOT 을 오래된 것부터 · 모자란 몫은 미차감(§1-1 의 16). 재고 posting 코어를 만지므로 전용 PR.
- **제품 입고** — ERP W/O 의 창고 `SYS-WHOLE`. 적치 지시를 만들지 않는다(`receipt-posting.ts` 의 `putawayNos` 에 `null` — 긴급 직행 출하와 같다).
- **화면** — 연동 전송 목록(실패·미차감 정리). 클라이언트 작업.

## 5. flowtrack 쪽에 요청한 것

flowtrack 저장소(`mes-dev`)의 일이다. 회신: 2026-11-12 · `bb31e61`(push 전) · `MES_ENABLED` 는 꺼 둔 채.

| 요청 | flowtrack 회신 |
|---|---|
| 모든 전송 본문에 `businessDate`(§1-1 의 20) | 반영 — 입고이동·출고·마감 보고. 전송을 쌓은 때의 공장(UTC+7) 날짜. 다시 보내도 바뀌지 않는다 |
| 공정 순서 판정 「막음」(ENFORCE)(§1-1 의 12) | 코드 변경 없음 · 전환 시점은 OA 가 정한다. 사용 중인 라인에 없는 제품: ZU-609(P81) `A63GP81` · RU-513(P81) `A87JP81` · 시험 제품 — 두 품목은 MES 에 있고 PL13 ERP W/O 는 0건 |
| 시리얼 품목 수동 마감 → 마감 보고 `qty` 0 | 반영 — 그 W/O 의 입고이동이 모두 받아진 뒤. 포장이 없어도 보낸다. 오더수량에 닿은 W/O 는 MES 가 이미 마감했으므로 보내지 않는다. ⇒ 남은 수량 처리·사유·비고를 더한다(§1-1 의 19 · 아래 다음 요청) |
| S410 화면(데스크탑 #274) | #274 에서 따로. API 셋은 받은 형식대로 |
| S410 품목 11개 등록 | #274 에서 정한다 — 시리얼이 없는 품목이라 flowtrack 제품 기준정보 설계가 필요하다 |
| `packing_logs.product_sno` 중복 막기 | 반영 — 지우지 않은 포장은 S/NO 당 1건(부분 UNIQUE) · 다시 포장하면 409 |

다음 요청(2026-11-12):

| 요청 | flowtrack 회신 |
|---|---|
| 수동 마감에서 남은 수량 처리(이월·소멸)·사유를 고르고 비고와 함께 마감 보고에 싣는다. 사유 목록은 `GET /mdm/code-values` 로 받는다(§1-1 의 19 · §3-5) | |
| S410 을 지시수량보다 적게 마감할 때 만든 수와 같은 칸을 싣는다(#274) | |
| `STOCK-` W/O 는 지금대로 둔다(§1-2) | |

## 6. 지금 데이터에서 본 사실

개발 DB(2026-11-04 · 재고는 11-12) 기준.

| 항목 | 값 |
|---|---|
| PL13 ERP W/O | 170건, 모두 `RECEIVED` |
| ERP W/O 의 창고(SL_CD) | S510(VICT 영업창고) 157건 14품목 · S410(제품 창고 영업) 13건 11품목. 두 창고에 걸친 품목은 없다 |
| 품목코드 | flowtrack `code_prefix` 와 같다 — AAR4WY1(FS-539) · A87JWY5(RU-513) 등. flowtrack 제품 23개 중 20개 일치 · `S511WY1` · `S512WY1` 은 MES 에 없다 |
| S410 W/O 품목 | 하위 조립품(F537…·F540… ASSY) |
| S410·S510 위치 | 둘 다 `SYS-WHOLE`(DEFAULT) · `SYS-STAGING`(TEMP) 뿐 |
| PL13 재고 | S510 한 품목 50,000 · S410 0 · S530 0 |
| 기본 BOM | ERP W/O 품목 25개 모두 있다 |
| BOM 모양 | FS-539 98줄(소요량 0 넷) · RU-513 은 総組 셋(다단) |
| BOM 구성품(ERP 원본 2026-08-25 · OA 완제품 25개 · 최대 9단) | 서로 다른 구성품 4,407. PL13 BOM 이 있는 품목 1,158 · PL11 BOM 만 있는 품목 466(그중 PL11 ERP W/O(WH20) 기록 288) · BOM 이 없는 품목 2,783 |
| BOM 의 공장 | ERP BOM 은 공장(`PLANT_CD`)마다 오고 두 공장에 같은 모품목이 있는 경우는 없다. MES `planning.bom` 에는 공장 칸이 없다 — PL11 이 만드는 사출품 F534237402 의 BOM(수지 2줄)이 공장 없이 들어 있다 |
| `backflush_allowed` | 모든 줄이 false |
| 소요량 0 | 720행. 개발 DB·하노이 사본 모두 0 이다(ERP 받기가 새 판으로 바꿨다). 초기 데이터 생성기는 여전히 1 로 넣는다 |
| 소요량 0 의 모양 | 옆 줄에 바뀐 품번이 있는 경우가 보인다 — 07BA15930 0 · 07BA15930D 3, 4163529371 0 · 4163529301 12 |
| PL13 창고 | 제품(생산) S220·S420 · 제품(영업) S210·S410·S510 · 자재(생산) S230·S530 · S430 사용 안 함 |
| 운영 정책 | 0행 |
| 생산라인 | 1개(PL13) · 기본 위치 셋 모두 비어 있다 |

## 7. 안 B 세부

### 7-1. 지금 있는 것과 없는 것

| 단계 | 지금 MES | 안 B 에서 |
|---|---|---|
| 자동 계획 | ERP W/O 를 처음 받을 때, 계획 시작일이 앞날이면 돈다 | PL13 은 날짜와 상관없이 돌린다. 이미 받은 170건은 한 번에 돌린다 |
| 계획 확정 | 사람이 한다. 라우팅 공정마다 MES W/O 1건 | 자동으로 한다 |
| 배포 | 사람이 `lotSize` 를 넣는다. 생산라인과 기본 위치 셋(WIP·FG·폐기)이 있어야 한다 | 자동으로 한다. `lotSize = 지시수량`. 라인·기본 위치 없이 배포한다 |
| 실적 | `X-Worker-No` 필수 · 결과 원천은 설비·수기·POP 셋 | 연동이 작업자 없이 실적을 쓴다. 결과 원천에 연동 값을 더한다 |
| 시리얼 | 서버가 번호를 매기고 단말·라벨 권한이 있어야 한다 | flowtrack 번호를 받아 그 LOT 에 넣는다(새 코드). S410 은 없다 |
| 제품 재고 | 실적이 재고를 올리지 않는다. 사람이 생산입고를 따로 한다 | 실적과 같은 트랜잭션에서 제품 입고를 전기한다 |
| 자재 차감 | 없다 | 새로 만든다(§4) |
| 마감 | `RELEASED` 는 마감할 수 없다. `IN_PROGRESS` 는 단말 작업 세션으로만 된다. 마감하면 ERP 생산입고 송신이 쌓인다 | 연동이 마감한다(7-3 의 4) |

자재 출고요청은 생기지 않는다. 배포는 W/O 공정에 묶인 BOM 구성품만 출고요청에 담는데, BOM 구성품 22,793행 중 공정에 묶인 행이 0 이다.

### 7-2. OA 가 준비할 기준정보

| 기준정보 | 수 | 내용 |
|---|---|---|
| 공정 | 1 | 「조립」 `OA-ASSY`(유형 `ASSEMBLY`). 개발 DB 에 2026-11-05 등록됐다. 하노이 DB·초기 데이터에는 없다 |
| 라우팅 | 0 | 서버가 만든다(7-3 의 2) |
| 운영 정책 | 2 | PL13 범위 — 자동 라우팅 공정 `OA-ASSY` · 자재 차감 창고 S530 |
| 연동 계정 | 1 | 배포·실적·마감·취소의 행위자 |
| 연동 단말 | 1 | 유형 `TRACKING_SYSTEM` · 공장 PL13 |
| S410 기초 재고 | | 시스템 도입 전 재고를 재고 조정으로 넣는다 |

생산라인·설비 그룹·설비·품목·설비 매핑은 만들지 않는다. BOM 은 이미 있다(25개 모두 기본 BOM 하나).

### 7-3. 정한 것의 세부

1. 생산라인 — **정함(사용자 2026-11-12): OA 자동 W/O 는 라인 없이 간다.** OA 는 설비를 쓰지 않는다. 설비 그룹(W-05-12)과 생산라인은 같은 표 `mdm.production_line` 이다 — 설비가 속하는 묶음(라인 · 작업구역 계층). OA 자동 W/O 가 라인에 기대는 셋과 라인 없이 푸는 법:

   | 기대는 곳 | 지금 | 라인 없이 |
   |---|---|---|
   | 자동 계획 | 품목·설비 매핑의 설비로 라인을 찾고, 못 찾으면 계획이 작성중(`LINE_UNKNOWN`)에 머문다 | OA 자동 계획은 라인을 찾지 않는다 |
   | 배포 검사 | 라인이 없으면 400. 단말 권한이 W/O 라인의 공장으로 판정해서다(omf-all-around#36) | OA 자동 W/O 는 POP·모바일 단말이 다루지 않으므로 검사하지 않는다. 라인이 없는 W/O 의 단말 범위는 ERP W/O 의 공장으로 푼다 |
   | 기본 위치 셋 | 라인에서 W/O 로 복사한다 | 비워 둔다. 자재 차감 창고는 운영 정책, 제품 입고 창고는 ERP W/O 의 창고에서 읽는다 |

1-2. 기본 위치 셋 — **정함(사용자 2026-11-12): 모든 공장의 배포 검사에서 폐기·FG 를 뺀다.** 셋을 실제로 읽는 곳:

   | 위치 | 읽는 곳 |
   |---|---|
   | WIP | 자재 출고요청·피킹의 도착 자리 · 부족 조회 · 공정 인계 |
   | FG | 없다 — 저장·복사·표시·배포 검사뿐. 안 B 의 제품 입고도 ERP W/O 의 창고를 쓴다 |
   | 폐기 | 없다 — 저장·복사·표시·배포 검사뿐 |

   고칠 곳 — `src/production/work-order/release-plan.ts` 의 `missingLocations` 와 함께 고칠 `production-order-worklist.ts`(갈리면 ERP W/O 목록에는 「배포 대기」로 보이는데 배포가 막힌다). 저장·복사·표시는 둔다.
1-3. 위치 — 자재 차감은 S530 의 맨 아래 위치 전체에서 오래된 LOT 부터 뺀다 — S530 에는 `SYS-WHOLE` 과 선반 `Z01-R001-L01~L03` 이 있다. 제품은 ERP W/O 의 창고(S510·S410)의 `SYS-WHOLE` 에 넣는다(S510 의 지금 재고가 그 자리에 있다). 라인의 기본 WIP 위치는 자재창고(`MATERIAL`) 유형 창고에 둘 수 없다(`src/mdm/equipment/equipment-group.service.ts`) — OA 는 S530 에서 바로 빼므로 라인 옆 단계가 없다.
2. 라우팅 — **정함(사용자 2026-11-05): 서버가 만든다.** PL13 ERP W/O 로 자동 계획을 돌릴 때 그 품목에 쓸 수 있는 라우팅이 없으면, 운영 정책의 공정(`OA-ASSY`) 1줄짜리 라우팅을 만들어 확정하고 기본 판으로 둔다. 줄의 설정 — 실적 관리 켬 · 공정 검사 끔 · 설비 필수 끔 · 금형 필수 끔 · 자재 투입 관리 끔. 사람이 만든 라우팅이 이미 있으면 그것을 쓰고 만들지 않는다. 공정 마스터는 MES 정본이라(W-06-01 《공정 마스터》) 하노이 DB 에도 같은 코드로 등록해야 한다.
3. 실적 작업자 — **정함(사용자 2026-11-12): 작업자 필수 설정을 두지 않는다.** 실적의 작업자 칸을 비울 수 있게 하고, 연동 실적은 작업자 없이 쓴다. 단말·POP·수기 실적은 지금처럼 작업자를 싣는다. 필요한 것:
   - 마이그레이션 — `production.production_result.worker_id` 의 NOT NULL 을 푼다.
   - 계약 — `ProductionResult.workerId` 가 필수 칸이다. 작업자가 없는 실적에서는 칸을 뺀다. 실적을 읽는 화면·응답은 작업자가 없는 행을 견뎌야 한다.
4. 마감 — **정함: 양품 합이 지시수량에 닿으면 마감한다.** 그 입고이동(3-3)이나 마감 보고(3-5)의 트랜잭션에서 연동이 마감한다(판정 `NORMAL`). 필요한 것:
   - 전이 — 지금 마감은 `COMPLETED`·`IN_PROGRESS`·`SUSPENDED` 에서만 되고 `IN_PROGRESS` 는 단말 작업 세션으로만 된다. 연동 마감은 `RELEASED` 에서 바로 마감한다(§1-1 의 17).
   - 마감 뒤 그 W/O 에 더 오는 포장은 거절한다(사용자 2026-11-05). 마감한 W/O 는 고칠 수 없다(트리거 `trg_work_order_closed_immutable`).
   - 마감 뒤 포장 취소는 막는다(사용자 2026-11-05). flowtrack 도 보낸 포장의 삭제를 막는다.
   - 조기 마감 — flowtrack 마감 보고(3-5)로만 한다. 관리웹 마감(`POST /production/work-orders/{id}:close`)은 OA 자동 W/O 를 막고 「OA W/O 는 flowtrack 에서 마감합니다」로 안내한다. 지금도 `RELEASED` 라 막히지만 문구가 취소를 권한다(§1-1 의 19).
   - 마감은 ERP 생산입고 송신(`IF_WO_CLOSE`)을 쌓는다 — ERP 가 범위 밖이므로 PL13 은 쌓지 않는다.
5. ERP W/O 취소 — **정함: MES W/O 도 취소한다.** 지금 ERP 의 변경·취소는 사람 확인 흐름(W-02-06)으로 가는데, PL13 은 ERP 받기가 MES W/O 취소까지 한다. 취소는 쓰고 있는 LOT 까지 폐번하므로, 실적이 없으면 자동으로 취소하고 실적이 있으면 취소하지 않고 사람 확인 목록(W-02-06)에 남긴다(사용자 2026-11-05).
6. S410 품목 — **정함(사용자 2026-11-05 · 11-12): flowtrack 이 처리하고 MES 도 자동 처리한다. 시리얼이 없어 flowtrack 이 품목코드로 W/O 를 찾아 골라 마감한다(3-5).** 제품은 ERP W/O 의 창고(S410)에 넣는다. 개발 DB 에서 ERP W/O 의 창고가 S410 인 13건의 품목 11개:

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

7. BOM 공장 — **정함: 자동 계획은 PL13 BOM 을 고르고, 자재 차감도 PL13 BOM 만 푼다.**

## 8. 나눠 만들기 (MES)

| 순서 | PR | 비고 |
|---|---|---|
| 1 | 단말 유형 `TRACKING_SYSTEM` · 연동 계정 · 허용 오퍼레이션 · 단말 읽기 범위 | 마이그레이션 선행 커밋 |
| 2 | W/O 목록 `updatedSince` · `updatedAt` | 계약 `contracts/` |
| 3 | BOM 공장 칸 · 초기 데이터 생성기가 소요량 0 을 1 로 바꾸지 않게 | 6 전에. 마이그레이션 선행 커밋. 채운 뒤 NOT NULL 은 다음 릴리스 |
| 4 | 운영 정책 코드 둘 · PL13 라우팅 자동 생성(`OA-ASSY` 1줄) | |
| 5 | PL13 자동 계획·확정·배포 · 라인·기본 위치 없이 배포 · PL13 BOM 고르기 | planning → production 경계를 넘는다 |
| 6 | 실적 작업자 널 허용 · 결과 원천 · 연동 전송 표 · 원장 원천 | 마이그레이션 선행 커밋 |
| 7 | 포장 입고이동(3-3) → 실적 · 시리얼 · 제품 입고 · 마감 | 자재 차감 빼고 |
| 8 | 자재 차감(백플러시) | 코어 전용 PR ≤ 200줄 |
| 9 | 출하 출고(3-4) | |
| 10 | 마감 보고(조기 마감 · S410) · 재고 조회 · 수량 출고(3-5) · 관리웹 마감의 OA 안내 | |
| 11 | ERP W/O 취소 → MES W/O 취소(7-3 의 5) | |
| 별개 | 배포 검사에서 폐기·FG 위치 빼기(7-3 의 1-2) | OA 와 별개 |

## 9. 안 A 와 비교

안 A — ERP W/O 하나에 제품 LOT 하나를 MES W/O 없이 만든다(새 LOT 원천 `PRODUCTION_ORDER`). `docs/server-architecture.md` §4.4 「작업지시(MES W/O)는 항상 생성한다」와 어긋난다.

| | 안 A — ERP W/O 에 LOT | 안 B — MES W/O 를 거친다 |
|---|---|---|
| 설계 원칙 §4.4 | 예외를 둔다 | 지킨다 |
| LOT 원천을 W/O 로 보는 기존 기능 — 실적 LOT 배분 · 자재 → 제품 계보 · 시리얼 · OA 검사표 · LOT 추적 흐름 · 생산입고 현황 · 재작업 W/O · ERP W/O 진행 | 새 원천에 맞춰 하나씩 다시 맞춘다 | 그대로 쓴다 |
| OA 기준정보 | 창고 설정뿐 | 공정 하나 · 운영 정책 · 연동 계정. 라우팅은 서버가 만들고 라인은 쓰지 않는다 |
| W/O 받기 | 새 ERP W/O 읽기 API | 지금 있는 MES W/O 목록 — flowtrack 구현과 같다 |
| 새 코드 | LOT 원천 · 연동 이벤트 표 · 제품 입고 · 자재 차감 · 출고 | 자동 계획·확정·배포 묶음 · 실적 변환 · 시리얼 등록 · 제품 입고 · 자재 차감 · 출고 · 마감 처리 |
| 화면 | OA 생산은 ERP W/O 화면에서만 보인다 | MES W/O · 실적 · LOT · 시리얼 화면에 그대로 보인다 |
