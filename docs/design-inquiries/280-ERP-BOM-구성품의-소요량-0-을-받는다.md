# 280. ERP BOM 구성품의 **소요량 0** 을 받습니다 — `BomComponent.requiredQty` 를 0 이상으로 열어 주십시오

**구분: 질의**(0 구성품을 어떻게 보일지는 설계가 정한다 · 서버는 받기까지 먼저 했다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /planning/boms/{bomId}/components` · `GET /planning/boms/{bomId}/components/{bomComponentId}` |
| 구현 상태 | 소요량 0 을 저장하고 그대로 내린다. W/O 배포의 출고요청·부족 조회에서는 0 구성품을 뺀다(선행 P-65) |
| 판정 | ERP 가 정본이라 MES 제약을 푼다 — 사용자 결정 2026-10-20 |

## 사실

- ERP BOM 22,793행 중 **720행**(모품목 421개)이 소요량 0 이다. 대부분 원자재다.
- 계약 `BomComponent.requiredQty` 는 `exclusiveMinimum: 0` 이다. 물리 CHECK 도 `> 0` 이었다.
- 받지 않으면 그 모품목의 BOM 이 반쪽이 된다. 받되 0 을 1 로 바꾸면 ERP 와 소요량이 어긋난다.

## 📨 요청

1. `BomComponent.requiredQty` 를 `minimum: 0` 으로 바꿔 주십시오.
2. 소요량 0 구성품을 화면(BOM 상세·W/O 자재 목록)과 소요량 계산에서 어떻게 다룰지 정해 주십시오.
   - 서버는 지금 출고요청 라인과 부족 조회에서 뺀다(출고요청 라인은 `requested_qty > 0` 이라 담을 수 없다).
   - 투입 실적·LOT 추적 대상으로는 남는다.

## 쓰기 쪽

`PUT /planning/boms/{bomId}/components/{bomComponentId}` 본문(`BomComponentUpdate`)에는 소요량이 없다 — 0 이 쓰기에 걸리는 자리는 없다.
