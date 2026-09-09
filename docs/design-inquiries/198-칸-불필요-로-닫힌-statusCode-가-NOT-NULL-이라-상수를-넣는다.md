# 198. 「칸 불필요」로 닫힌 `ShipmentRequest.statusCode` 가 **물리에서 NOT NULL** 이라 상수를 넣는다

**구분: 통보**(회신을 기다리지 않는다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/shipment-requests` · 그것을 내리는 조회 셋 |
| 구현 상태 | **구현 예정(I-22 PR ⑤)** — 상수 `'REGISTERED'` |
| 판정 | §2 **0단계 선례**(`Asn.statusCode`·`InboundReceiptLine.statusCode` 가 같은 자리에서 상수로 닫혔다 · `plan.md` §0 #10) |
| 되돌릴 때 | 상수 한 줄. ⚠ **데이터에 남으므로** 값을 정해 주시면 그때 마이그로 바꿉니다 |

## 실측

| 자리 | 내용 |
|---|---|
| 계약 `ShipmentRequest.statusCode` | **required** · `x-no-code-key` 「코드 그룹을 세우지 않는다 … **이 칸을 «움직이는» 액션도 계약에 0건**」 · `x-no-example` 「「칸 불필요」로 닫힌 칸이라 **값이 없다**」 |
| 물리 `logistics.shipment_request.status_code` | **`app.code_t NOT NULL`** |

⇒ **응답에 required 인 칸이라 nullable 로 완화해도 답이 안 됩니다**(널이면 실을 값이 없습니다). `plan.md` §0 #10 이 같은 결론을 이미 적었습니다 — 「계약이 응답에 required 로 적은 자리에는 nullable 이 안 선다 — 그 자리는 **상수**」.

## ⇒ 우리가 정한 것

- `POST` 가 **`'REGISTERED'`** 를 넣습니다. 저장소 선례가 셋 있습니다(`Asn`·`InboundReceiptLine`·`material_issue_request`).
- ⛔ **그 값을 움직이는 코드는 0줄**입니다 — `src/core/document-state/transitions.ts` 를 **한 줄도 건드리지 않습니다**(계약에 전이 액션이 0건).
- 같은 판정을 `inventory.inventory_reservation.status_code` 에도 씁니다(그 칸도 `x-no-code-key` 로 「예약의 유효·소진은 수량 축이 담는다」라 닫혔습니다).
- ⚠ `SalesOrder.statusCode` 는 **다릅니다** — 그 리소스는 **등록 경로가 0건**(ERP·엑셀 수신본)이라 우리가 쓰지 않고 **들어온 값을 그대로 내립니다.** 상수를 만들지 않습니다.

## 📨 알려 드리는 것

**`REGISTERED` 로 넣습니다.** 다른 값을 원하시면 알려 주십시오 — 지금은 행이 0건이라 마이그 없이 바꿀 수 있지만, 운영이 시작되면 데이터로 남습니다.
⭐ 이 자리는 `x-no-code-key` 로 닫힌 칸이 **NOT NULL 물리와 만나는 여러 자리 중 하나**입니다(`plan.md` §0 #10 의 「첫 발생 시 보고」 대상).

## 흔적

`docs/coverage-100/slices/I-22.md` §1-4-1 · §1-5 · §3-1 · §9-1 #7 ·
`contracts/shipment-04제품출하.json`(`ShipmentRequest.statusCode`) · baseline `migration.sql`(`shipment_request` DDL) ·
`docs/coverage-100/plan.md` §0 #10 · `src/logistics/asn/`·`src/logistics/material-issue-request/`(선례).
