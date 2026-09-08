# 121. 창고 «내» 위치 이동을 막던 물리 CHECK 가 이미 사라졌는데 계약·화면은 그것이 있다고 적는다 — 게다가 그 이동을 받을 슬라이스가 0건이다

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — 가장자리(같은 창고 호출)에서만 갈리고, 거부→허용은 호환 완화다 |
| 걸리는 오퍼레이션 | `POST /logistics/stock-transfers` · `GET /logistics/stock-transfers` · `GET …/{stockTransferId}` · `GET …/{stockTransferId}/lines` |
| 구현 상태 | **구현·병합함**(`main` · 조회 3건 + 반출 등록) — 서버가 같은 창고 호출을 400 `INVALID`(field `toWarehouseId`)로 막는다 |
| 판정 | `coverage-100/README.md` §2 1단계 **가장자리**(`fromWarehouseId = toWarehouseId` 인 호출에서만 갈린다) → 2단계 **기준 2**(거부하는 쪽 — 거부→허용은 호환 완화, 허용→거부는 깨는 변경) |
| 되돌릴 때 | 「열라」면 `stock-transfer.service.ts` 의 검증 한 줄 삭제(완화) · 계약 `description` 과 x-internal-note 문장 교체 · 화면 `M-01-10` 다섯 자리 갱신 · 「막아라」면 마이그레이션으로 CHECK 를 되살리는 별건이 된다 |

## 무엇이 문제인가

ⓐ 계약이 **스스로 후보 ①을 적었고, 물리는 그 후보를 글자 그대로 적용했다.** `StockTransfer` x-internal-note 원문(`contracts/logistics-01자재창고.json:14081`):

> 한 행에 shipped_at·received_at 이 둘 다 있다 — 두 문서가 아니라 한 문서의 두 전이다(02-URL동작규약 §2-4). ⚠ 창고 간(from_warehouse_id ≠ to_warehouse_id)만 받는다 — 창고 «안» Location·파렛트 간 이동을 담을 헤더가 없어 M-01-07 임시 적치의 복귀 경로가 막힌다. 후보 ① CHECK를 from_location_id ≠ to_location_id 로 완화 ② handling_unit_content 파렛트 재편성 이력 신설. 근거: 공유계약 §I-19 · M-01-10 §5-1 · omf-mes#82

ⓑ 물리 실측 — `ck_stock_transfer_warehouses CHECK (from_warehouse_id <> to_warehouse_id)` 는 baseline 이 세웠다가(`prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:2192-2193`) **`prisma/migrations/20260826000000_data_model_v4/migration.sql:90-91` 이 DROP** 했고, 같은 마이그 `:93-95` 가 그 자리에 라인 CHECK `ck_stock_transfer_locations (from_location_id <> to_location_id)` 를 세웠다. 그 마이그 머리 주석도 「Broader state transitions are expressed by **relaxing constraints**」(`:5`)라 적었다. psql `pg_constraint` 실측(2026-09-07)에서 `stock_transfer` 의 CHECK 는 `stock_transfer_version_no_check` 하나뿐이다.
ⓒ 그런데 **같은 계약의 나머지 문장은 아직 옛 제약을 말한다** — `StockTransfer.description` 「재고 이동. **출발 창고와 도착 창고가 같을 수 없다.** 근거: M-01-10」(`contracts/…:13973`). 위 x-internal-note 의 「⚠ 창고 간만 받는다」도 그대로다. 한 스키마 안에서 「막는다」와 「완화 후보」가 나란히 있다.
ⓓ 화면 `M-01-10`(v0.1 · **2026-08-05** — 마이그 08-26 보다 **앞선다**)은 **다섯 자리**에서 이 CHECK 를 실재로 전제한다 — §2 데이터면 · §4-B · §5-1(제약 SQL 원문) · §6 · §8 #1(`.design-reference/omf-mes/design/wiki/screens/01/M-01-10-재고이동불량반출.md:106-149,256-265`). 그 전제 위에서 「같은 창고 안 이동 = 헤더 없이 수불만」(A-11 물러남)을 확정했다.
ⓔ 서버는 계약 `description` 문자를 따라 **400 으로 막는다** — 그러므로 오늘 창고 내 이동을 막는 것은 **계약 문자와 서버뿐**이고 물리는 이미 받는다.
ⓕ 이 슬라이스는 CHECK 를 **되살리지 않는다** — 이미 완화된 제약을 조이는 것은 설계 회신 없이 할 일이 아니고, 레인 규약(추가·완화만)에도 걸린다(`I-13.md` §2-5).
ⓖ ⭐ **물러난 자리의 받는 쪽이 없다.** 서버 쪽 계획서는 처음에 「창고 내 위치 이동은 적치(U10)로 흡수」로 판정했는데 **성립하지 않는다** — `M-01-07`(임시 적치)은 §5-4 에서 복귀처를 **`M-01-10` 으로** 주고(「01-S-D의 복귀는 **「[정위치 이동] → 01-S-G」** 다. 이 화면은 **닫히지 않는다** — 임시 상태를 만들고 끝난다」 · `.design-reference/…/screens/01/M-01-07-임시위치적재.md:124-130`), 그 `putaway_task` 는 임시 적치로 이미 `COMPLETED_TEMPORARY` 가 되어 닫혔다. 적치가 다시 받을 지시 행이 **0** 이다. ⇒ **창고 «내» 위치 이동을 만드는 슬라이스가 오늘 전 계획에 0건**이다.

## 지금 서버는

- `POST /logistics/stock-transfers` 에서 `fromWarehouseId === toWarehouseId` 이면 400 `INVALID`, field `toWarehouseId`, 메시지 「출발 창고와 도착 창고가 같을 수 없습니다.」(`src/logistics/stock-transfer/stock-transfer.service.ts:188-189`). 이 검사는 **채번보다 먼저** 돈다(전표 번호를 태우지 않는다).
- 라인의 `from_location_id ≠ to_location_id` 는 물리 CHECK 가 지므로 서버가 따로 안 본다.
- 그러므로 `M-01-07` 임시 적치에서 정위치로 되돌릴 길이 **API 에 0건**이다.

⇒ **묻는 것**: 창고 «내» 위치 이동에 이 헤더를 열 것인가(그러면 `M-01-07` 임시 적치의 복귀 경로가 살아나고 서버는 검증 한 줄을 지운다), 아니면 계약 `description`·x-internal-note 와 화면 `M-01-10` 다섯 자리를 물리에 맞게 고치고 **창고 내 이동을 받을 다른 오퍼레이션·화면을 지정할 것인가**.

흔적: `docs/coverage-100/slices/I-13.md` §0-재수립 R-1 · §2-2 · §2-5 · §4-2 · §11-1 #1 · 실측 부록 #12·#16·#55·#59 · `I-13-review-uiux.md`(수정 4 · ⓖ) · `docs/coverage-100/plan-uiux.md:597`·`:1192`(「적치로 흡수」를 「흡수처 없음」으로 이미 고쳤다).
