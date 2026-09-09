# 197. 제품 피킹 `:pick` 이 **`businessDate`·`occurredAt` 을 받지 않는다** — 「오늘」과 채번 기간 축을 서버가 정했다

**구분: 통보**(회신을 기다리지 않는다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/shipment-requests/{id}/lines/{lineId}:pick` |
| 구현 상태 | **구현 예정(I-22 PR ⑥)** — 서버 UTC 날짜 |
| 판정 | §2 **1단계 본길**(모든 호출이 걸린다) → **0단계 선례**(I-10 `MR-` 채번이 서버 UTC 를 썼다) · CLAUDE.md 「TZ = UTC 고정」 |
| 되돌릴 때 | 본문 칸이 생기면 서비스 두 줄(판정·채번) |

## 실측

| | 01 자재 피킹 `PickingLinePick` | 04 제품 피킹 `ShipmentLinePick` |
|---|---|---|
| `businessDate` | **required** | ⛔ **없다** |
| `occurredAt` | **required** | ⛔ **없다** |
| 프로퍼티 | 4 | **3**(`lotId`·`pickedQty`·`uomId`) |

그런데 04 `:pick` 은 **날짜가 필요한 판정을 둘** 합니다:

1. **잔여 유효기간 하한** — `x-internal-note` 「잔여 유효기간 하한(`minimumRemainingShelfLifeDays`)도 **서버가 판정한다**」. 판정식은 `lot.expiry_date − 오늘 ≥ 하한` 인데 **「오늘」의 원천이 없습니다.**
2. **예약 번호 채번** — `RS-{YYYYMMDD}-{SEQ4}` 의 기간 키.

## ⇒ 우리가 정한 것

- **둘 다 서버 UTC 날짜(`CURRENT_DATE`)** 를 씁니다.
  ⛔ `plant.timezone_code` 로 풀지 않습니다 — **출하작업지시에 공장 축이 0개**라 타임존을 얻을 데가 없습니다(`shipment_request` 에 `plant_id` 없음).
- `lot.expiry_date` 가 **NULL 인데 라인에 하한이 걸려 있으면 거부**합니다(400 `RANGE`) — 「하한을 만족한다」를 확인할 수 없기 때문입니다(§2 2단계 기준 2).
- ⚠ 하노이는 **UTC+7** 이라 **현지 새벽 0~7시의 피킹이 «전날» 번호를 받고 「오늘」도 전날로 잡힙니다.** I-6 의 `WO-`·`MIR-`, I-10 의 `MC-`·`MR-` 과 같은 자리입니다.

## 📨 알려 드리는 것

1. **`ShipmentLinePick` 에 `businessDate` 를 넣어 주십시오.** 공유계약 C-8 이 「`business_date` 는 클라이언트가 보낸다 — 서버가 수신 시각으로 다시 잡지 않는다」로 못박았는데, 이 오퍼레이션만 그 칸이 없습니다. **잔여 유효기간 판정이 자정을 넘긴 재전송에서 흔들립니다.**
2. 「오늘」을 **공장 로컬 달력일**로 봐야 한다면 **작업지시에 공장 축**이 필요합니다.

## 흔적

`docs/coverage-100/slices/I-22.md` §1-3 · §3-2 ⑨ · §9-1 #6 · 부록 **#11** ·
`contracts/shipment-04제품출하.json`(`ShipmentLinePick`·`x-internal-note`) · `contracts/logistics-01자재창고.json`(`PickingLinePick`) ·
`src/core/numbering/numbering.service.ts:85-88` · `CLAUDE.md`(도메인 · TZ) · **문의 15**(businessDate/occurredAt 의 C-8-1 어긋남)의 04 판.
