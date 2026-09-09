# 273. counted 물리 칸과 블라인드 실사 마스킹을 추가한다

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — 회신을 기다리지 않는다 |
| 걸리는 오퍼레이션 | `GET /inventory/counts/{id}` · `GET/PUT /inventory/counts/{id}/lines` |
| 구현 상태 | I-15에서 구현 완료(PR #556·#558·#562) |
| 판정 | 실사 완료 여부는 MES 본질에 가깝지만 계약이 이미 `counted`를 정본으로 지정했다. 누락 물리 칸 추가는 forward-only이고 되돌림 비용이 낮아 개발팀이 정한다 |
| 되돌릴 때 | boolean 칸은 사용 중단 후 남겨 둘 수 있고, 응답 마스킹 함수와 테스트만 바꾸면 된다 |

## 결정

1. `inventory.inventory_count_line`에 `counted boolean NOT NULL DEFAULT false`를 추가한다. `counted_by` nullable이나 `counted_qty=0`으로 미실사를 추정하지 않는다.
2. 기존 행은 임의로 완료 처리하지 않고 기본 `false`로 둔다.
3. 블라인드 실사의 미실사 라인은 `systemQty`를 생략하고 `countedQty=0`, `varianceQty=0`으로 내려 장부 수량이 차이에서 역산되지 않게 한다.
4. 실제 계수 제출 뒤에는 `counted=true`와 실제 차이를 내려 조정 흐름을 연다.
5. 계약 `InventoryCountLine.required`는 `systemQty`를 필수로 두면서 같은 스키마 설명과 `x-internal-note`는 블라인드 시 생략하라고 적었다. 서버는 더 구체적인 블라인드 규칙을 따르며, 설계 문서는 required 목록을 조건부 표현으로 정정할 필요가 있다.

## 근거

- `contracts/logistics-01자재창고.json` — `InventoryCountLine.counted`, `systemQty`, `x-internal-note`
- `prisma/schema.prisma` — `inventory_count_line`에 counted 원천 0칸
- `docs/coverage-100/slices/I-15.md` §2-1·§3-2·§3-3
