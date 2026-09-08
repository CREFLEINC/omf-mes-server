# 070 — `trace.lot_hold` 한 행이 도착 상태를 «둘» 요구한다

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — 「정하고 통보」다. MES 본질(추적성 이력)이지만 바꾸는 비용은 낮다(nullable 컬럼 추가만 · 이미 쌓인 행 정정 불필요 · 계약 변경 0) |
| 걸리는 오퍼레이션 | `GET /quality/lot-holds` · `GET /quality/lot-holds/{lotHoldId}`(I-20 PR ②a) · `GET /quality/lot-hold-events`(②b) · `POST /quality/lot-holds`(④) · `POST /quality/lot-holds/{lotHoldId}:release`(⑤) |
| 구현 상태 | 구현함(M-f 마이그 — `20260908110558_lot_hold_target_status_and_version`) |
| 판정 | `docs/coverage-100/README.md` §2 1-1단계 표 — MES 본질 × 비용 낮음 ⇒ 통보 |
| 되돌릴 때 | 회신이 「한 칸으로 충분하다」면 두 칸 중 하나를 두 릴리스 규칙으로 폐기하고 조회 뷰의 매핑만 고친다 |

## 무엇을 봤나

계약 `LotHold.lotStatusCode` 설명(`contracts/quality-03품질.json:4035` 인접)은 「**이 보류가 걸었을 때** LOT 이 간 상태」(등록 도착)다. 반면 `LotHoldEvent.targetLotStatusCode` 설명(`:4191`)은 「**해제 사건이** LOT 을 어느 상태로 보냈나」(해제 도착)다. 둘은 **값 집합조차 겹치지 않는다** — 등록 도착은 `INSPECTION_PENDING`(C10)·`DEFECTIVE`(C9) 둘뿐이고, 해제 도착은 `NORMAL`(C7)·`DEFECTIVE`(C8) 둘뿐이다.

`trace.lot_hold` 는 등록과 해제가 **같은 물리 행**에 있다(보류 「문서」 모델 — 계약 `:1555`가 직접 그렇게 적었다). 한 칸에 도착 상태를 담고 해제 때 덮어쓰면 **등록 도착값이 사라져** `LotHold.lotStatusCode` 를 다시 채울 원본이 없어진다.

## 무엇을 했나

`trace.lot_hold` 에 칸을 **둘** 더했다(둘 다 nullable · 백필 0 · 삭제 0):
- `target_lot_status_code` — 등록 도착. `LotHold.lotStatusCode` 가 이 칸을 그대로 낸다.
- `release_target_lot_status_code` — 해제 도착. `LotHoldEvent.targetLotStatusCode`(RELEASED 사건)가 이 칸을 낸다.

마이그 «전»에 태어난 행(이 슬라이스 이전의 모든 입하 보류)은 두 칸이 NULL 이다 — 계약 위반은 아니다(둘 다 `required` 밖, 실측 확인). 조회는 NULL 이면 **키를 생략**한다(널 금지 규칙).

## 참고 — 같은 계약 칸이 두 GET 에서 뜻이 갈릴 뻔했다

`GET /trace/lots/{lotId}`(이미 커버된 오퍼레이션)의 `holdView()` 가 이 두 칸이 생기기 «전»에는 `LotHold.lotStatusCode` 를 `lot.status_code`(LOT 의 «지금» 상태)로 채우고 있었다 — 보류가 걸린 뒤 LOT 이 다시 옮겨지면 값이 달라지는 다른 뜻이다. 이번 PR(②a)이 그 자리도 `target_lot_status_code` 로 맞췄다(회귀 e2e 포함 — 상세는 통보 079).
