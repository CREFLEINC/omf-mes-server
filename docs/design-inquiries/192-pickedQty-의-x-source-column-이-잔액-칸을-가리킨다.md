# 192. `ShipmentRequestLine.pickedQty` 의 **`x-source-column` 앵커가 «잔액» 칸을 가리키는데 응답은 «라인» 축**이다

**구분: 통보**(회신을 기다리지 않는다) · ⭐ **3관점 재검토가 초판의 진단(「가리킬 칸이 없다」)을 정정했습니다**

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /logistics/shipment-requests` · `…/{id}` · `POST /logistics/shipment-requests` · `…:pick` — `ShipmentRequestLine` 을 내리는 넷 |
| 구현 상태 | **구현 예정(I-22 PR ③·④)** — 저장 칸을 만들지 않고 **예약 롤업**으로 낸다 |
| 판정 | §2 **1단계 본길** → **2단계 기준 3**(스키마를 안 늘리는 쪽) · 기준 4(두 벌 장부를 안 만든다) |
| 되돌릴 때 | 칸을 세우면 마이그 한 항목 + 갱신 두 자리. ⚠ **되돌리기가 비쌉니다** — 칸이 서면 두 벌 장부가 됩니다 |

## 실측 — 앵커가 «안 매달렸습니다»

| 사실 | 근거 |
|---|---|
| `ShipmentRequestLine.pickedQty` 에 **`x-source-column: "picked_qty"`** 가 달려 있다 | 04 계약 |
| 그것이 04 계약 **파일 전체에서 유일한 `x-source-column`** 이고, **`x-source-table` 은 0개**다 | python 전수 |
| `logistics.shipment_request_line` 에 **`picked_qty` 칸이 없다** | `prisma/migrations` **68 디렉터리 전건** grep — `picked_qty` 는 `inventory_balance`·`picking_line` 둘뿐 |
| 그런데 **`M-04-01` §4-A 가 그 앵커를 «명시»한다** — 「피킹 수량 \| **`inventory_balance.picked_qty` 파생** \| 진행 표시」 | 설계 사본 |

⇒ **「가리킬 칸이 없다」가 아니라 「앵커가 «표»를 안 적어 잔액 칸을 가리키는 것으로 읽힌다」**가 정확합니다.

## ⛔ 그런데 잔액 칸은 라인 축을 못 줍니다

`inventory_balance.picked_qty` 는 **(법인·사업부·공장·창고·위치·품목·LOT·품질·재고·소유·소유처) 11칸 차원**입니다.
**같은 LOT 을 집은 두 라인을 가르지 못합니다.**
그런데 `M-04-01` §3 목업이 그리는 것은 **라인 축**입니다 — 「FG-1001 **배정 300 · 피킹 120**」.

## ⇒ 우리가 정한 것

`pickedQty` 와 `picks[]` 를 **`inventory.inventory_reservation` 행에서 롤업**합니다.

```
picks[]     = 그 라인의 예약 행들 (source_document_type_code='SHIPMENT_REQUEST_LINE', source_document_id=라인 id)
              lotId ← lot_id · pickedQty ← reserved_qty · uomId ← uom_id · pickedAt ← created_at
pickedQty   = Σ(reserved_qty − released_qty)          ← 문의 208 과 한 몸입니다
```

- `ShipmentLinePickedLot` 의 required 넷이 예약 칸 넷과 **1:1** 입니다.
- 인덱스도 이미 있습니다 — `ix_reservation_source (source_document_type_code, source_document_id, status_code)`.
- ⛔ **저장 칸을 세우지 않습니다.** 세우면 예약 합과 칸이 갈릴 수 있고, 같은 사고를 **문의 046**(`issued_qty` 가 두 벌이 된 자리)에서 이미 겪었습니다.

## 📨 알려 드리는 것

1. **`x-source-column` 에 `x-source-table` 을 함께 달아 주시거나, 이 칸의 앵커를 지워 주십시오.** 지금 문장대로면 「라인 칸을 읽는다」로 오독됩니다.
2. ⭐ **`M-04-01` §4-A 의 출처 칸을 고쳐 주십시오** — 「피킹 수량 = `inventory_balance.picked_qty`」는 라인별 「피킹 120」을 못 줍니다. 그 값의 정본은 **계약 `ShipmentRequestLine.pickedQty`** 입니다.

## 🔎 이 통보가 «흡수»한 것 (3관점 재검토 · 2026-09-09)

| 어디서 왔나 | 무엇 |
|---|---|
| **통합 관점**(§1-2 · **결론 채택 · 근거 반증**) | ⭐ 「가리킬 칸이 «저장소 전체에» 없다」가 **틀렸다** — `x-source-column` 이 04 파일에 **하나**이고 `x-source-table` 이 **0개**이며 **`M-04-01` §4-A 가 앵커를 `inventory_balance.picked_qty` 로 명시**한다. ⇒ 제목이 **「앵커가 «잔액» 칸을 가리킨다」**로 바뀌었다. `plan-api.md:25` 의 전수 인구조사(「`x-source-column` 중 물리에 없는 칸 = 0」)도 이 판정에서만 참이다 |
| **UI/UX 관점**(후보 **θ**) | ⭐ **그 잔액 칸은 라인 축을 못 준다** — (품목·LOT·창고) 차원이라 **같은 LOT 을 집은 두 라인을 못 가른다.** `M-04-01` §3 목업의 「배정 300 · **피킹 120**」은 라인 축이다 ⇒ 화면 문서 출처 칸 정정 요청을 함께 담았다 |

⇒ 초판 후보 **C** 에 통합의 근거 정정과 uiux **θ** 를 합쳐 이 문서가 됐다.

## 흔적

`docs/coverage-100/slices/I-22.md` §0 #2 · §1-4-1 · §5-1 · 부록 **#12** · §0-재수립 **R-3**(3관점) ·
`M-04-01` §3·§4-A(설계 사본) · `grep -rn 'picked_qty' prisma/migrations`(7히트 전부 baseline) · **문의 046**(I-8) · **문의 208**(형제).
