# 78. `LotStatusTransition.impact` 의 「진행 중인 피킹」·「이미 출고된 수량」 정의

**구분: 통보**(회신을 기다리지 않는다 — README §2 1-1단계 「본질 아님 × 비용 낮음」)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/quality/lot-status-transitions` (I-20 PR ①c) |
| 구현 상태 | 구현함 — 아래 두 정의대로 `lot-status-transition.service.ts#impactOf()` |
| 판정 | §2 1-1단계(본질 아님 · 비용 낮음 ⇒ 정하고 통보) |
| 되돌릴 때 | 계약이 더 정밀한 정의를 확정하면 `impactOf()` 의 WHERE 절만 고치면 된다(사용처 하나) |

## 사실 — 계약은 문장만 주고 정의는 안 줬다

- `LotStatusTransition.impact.openPickingCount` 설명: 「진행 중인 피킹 **요청** 건수 — 이 전이로 함께
  막힌다」. `shippedQty` 설명: 「이미 출고된 수량 — 이 전이로 회수되지 않는다」(`:4424`~`:4436`).
  「진행 중」·「이미 출고된」이 어느 물리 조건인지는 계약이 적지 않았다.
- 원천은 있다 — `logistics.picking_line(lot_id, planned_qty, picked_qty)` · `.picking_order(status_code)` ·
  `logistics.goods_issue_line(lot_id, issue_qty)`(계약 `:4424` 인접 요약 · `schema.prisma:1006-1015`·
  `:1037-1051`·`:777-800`).

## 우리가 정한 것

1. **「진행 중인 피킹」= 「요청」 단위**(R-7) — `picking_line` 중 `picked_qty < planned_qty` 인 라인이
   하나라도 있는 **`picking_order` 의 개수**(`count(DISTINCT picking_order_id)`). 라인 개수가 아니다 —
   계약 본문·`W-03-02:258`·`W-03-03:64` 셋 다 「요청」이라 적었다.
2. **「진행 중」의 종결 판정 = `picking_order.status_code = 'CANCELLED'` 하나뿐.**
   `PickingOrder.statusCode` 설명(`contracts/logistics-01자재창고.json`)이 `LOGISTICS_DOCUMENT_STATUS`
   4값(`REGISTERED`·`POSTED`·`CANCEL_REQUESTED`·`CANCELLED`)을 명시했다 — 그중 되돌릴 수 없는 값
   하나만 「더는 진행되지 않는다」로 본다. `CANCEL_REQUESTED` 는 아직 뒤집힐 수 있어 진행 중에 남긴다.
   ⚠ `src/logistics/document-progress/document-type-registry.ts` 의 `PICKING_ORDER.cancelledStatus:
   null` 은 «다른 축»의 판단이다(후속 문서 취소 판정에 이 값을 지어 넣지 않는다는 것) — 이 슬라이스가
   피킹 진행 축을 처음 열어 그대로 옮기지 않는다.
3. **「이미 출고된 수량」= `Σ goods_issue_line.issue_qty`(그 LOT), `goods_issue.status_code IN
   ('POSTED', 'CANCEL_REQUESTED')` 인 것만.**(⚠ #361 리뷰 Minor-2 로 갱신 — 최초 구현은
   `POSTED` 단독이었다.) 0단계 선례 — `src/logistics/material-issue-request/shortage.service.ts`
   `issuedByItem()`(I-8.md R-18)이 「기출고」를 같은 표에서 `POSTED` 필터로 이미 낸다: 그 선례를
   그대로 옮기되(§2 0단계 「있으면 인용, 판단 아님」), **`CANCEL_REQUESTED` 는 이 화면이 새로
   판단해야 했다** — `shortage.service.ts` 는 그 값을 안 다룬다. 판단: `transitions.ts` 의
   `document-request-cancel`(`from: ['REGISTERED','POSTED'] → CANCEL_REQUESTED`)이 보이듯
   **전기(`POSTED`)까지 간 출고도 취소 «요청»만으로 이 상태에 온다** — 그런데 원장 역분개는
   `document-cancel`(→`CANCELLED`)에서만 일어난다(`document-cancel-execute.service.ts#reverseLedger`).
   ⇒ **`CANCEL_REQUESTED` 출고는 실물이 이미 나갔고 원장도 아직 안 돌아온 상태**라 「이미
   출고된 수량」에서 빼면 **과소 보고**가 된다 — 계약이 이 칸을 「되돌릴 수 없음을 알리는 것」
   이라 적었으므로 과소 보고가 더 나쁜 방향이다. **원장 역분개가 끝난 `CANCELLED`만** 「이미
   나간 것」이 아니다로 뺀다. 같은 함수의 피킹 축(위 2번)도 `CANCEL_REQUESTED` 를 「진행 중」에
   남겨 뒀다 — 두 축의 보수(conservative) 방향이 이제 같다(둘 다 「아직 뒤집힐 수 있는 상태는
   위험 쪽으로 카운트한다」). ⛔ 예약분(`picking_line.picked_qty`)은 섞지 않는다 — 그 값은
   아직 「출고」가 아니다.

## 관련

- `src/quality/lot-status/lot-status-transition.service.ts` `impactOf()` 코드 주석 — `// 결정 — 통보 078`
- `docs/design-inquiries/084-lot-status-transitions-allowed-축-판정.md` — 같은 오퍼레이션의 자매 판정
  (`allowed` 는 실행 가능성까지 보지 않는다)
