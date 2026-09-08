# 079 — `LotHold.lotStatusCode` 를 두 GET 이 서로 다른 뜻으로 채우고 있었다(R-9)

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — MES 본질(추적성 표시값) × 비용 낮음(스키마 변경 없음 · 뷰 매핑만 · 계약 문구는 이미 명확) ⇒ 정하고 통보 |
| 걸리는 오퍼레이션 | `GET /trace/lots/{lotId}`(이미 커버 · `holds[]`) · `GET /quality/lot-holds/{lotHoldId}`(I-20 PR ②a · 신규) |
| 구현 상태 | 구현함 — 두 자리를 `lot_hold.target_lot_status_code`(등록 도착)로 통일 |
| 판정 | `docs/coverage-100/README.md` §2 2단계 기준 4(값을 조용히 도출하지 않는 쪽) · 0단계 선례(M-f 마이그 주석이 이미 「계약 `LotHold.lotStatusCode`」라고 그 칸의 뜻을 못 박아 두었다) |
| 되돌릴 때 | 없음 — 계약 문구(`:4035`, 「이 보류가 «걸었을 때» LOT 이 간 상태」)가 이미 등록 시점 고정값을 명시해 다른 해석의 여지가 없다 |

## 무엇을 봤나

`src/trace/lot/lot-view.ts:135`(`holdView()`, `GET /trace/lots/{lotId}` 가 쓴다)가 계약 `LotHold.lotStatusCode` 를 `lot.status_code` — LOT 의 **«지금»** 상태 — 로 채우고 있었다. 이 슬라이스(I-20)가 같은 계약 칸을 요구하는 두 번째 오퍼레이션(`GET /quality/lot-holds/{lotHoldId}`)을 열면서, M-f 마이그가 그 칸의 물리 원본으로 `lot_hold.target_lot_status_code`(보류를 «걸 때» LOT 이 간 상태 — 등록 시점 고정값)를 세웠다.

두 값은 **다른 사실**이다 — 보류가 걸린 뒤 LOT 이 재판정으로 다시 옮겨지면(`:release` 로 풀렸다가 다른 사유로 다시 걸리는 등) `lot.status_code` 는 바뀌지만 「그 보류가 걸었을 때 간 상태」는 안 바뀐다. 손대지 않으면 같은 계약 칸이 오퍼레이션마다 다른 뜻으로 나가는 셈이었다.

## 무엇을 했나

`holdView()` 를 `lot_hold.target_lot_status_code` 로 맞췄다(§0 #1·R-9 판정 — I-20 계획 §0-재수립 표). 세 갈래(브리프 §4-3) 중 **ⓐ「갈고 기존 행은 키 생략」**을 골랐다:
- 마이그 «전»에 태어난 행(오늘까지의 «모든» 입하 보류 — `core/lot/lot-registry.service.ts` 가 PR ③ 전까지 이 칸을 안 채운다)은 그 칸이 NULL 이라 **키를 생략**한다(널 금지 규칙). 계약 위반은 아니다 — `lotStatusCode` 는 `LotHold.required` 밖(실측 확인).
- 기존 행이 값 → 키 생략으로 «후퇴»하지만(#351 리뷰 G-6 과 같은 자리), `test/trace-lot.e2e-spec.ts` 는 이 칸의 값을 어디서도 단언하지 않아(실측) 회귀가 없었다 — 이번 커밋이 새 단언(회귀 테스트)을 더해 두 자리가 같은 원본을 쓰는 것과 마이그 전 특성화를 함께 잠갔다.
- 대안 ⓑ(`?? lot.status_code` 폴백)는 기각했다 — 「두 자리를 같은 뜻으로 맞춘다」는 판정과 정면으로 어긋난다(폴백을 쓰면 마이그 전 행이 다시 «지금» 값을 보이므로).
