# I-13 재수립 — **api 관점** 리뷰

> 대상 `slices/I-13.md`(1080행) · 브리프 `brief-I-13-review.md` · base `origin/main` 771c541 · 계약 `a6a87e1`.
> ⭐ **실측 부록(67행)은 재측정하지 않았다** — 내 판정이 그 값을 뒤집는 자리가 **0**이라 예외를 쓰지 않았다.
> 내가 «새로» 잰 것은 계획자가 안 본 다섯 자리뿐이다: 계약 `responses` 전수(python) · 두 가드(`IdempotencyGuard`·`OptimisticLockGuard`) ·
> `operation-permissions.spec.ts` · `assignment.tsv` S05 배정 · `error-codes.ts` 전문.

## 1. 「반드시 볼 자리 5」 판정

| # | 판정 | 근거 |
|:-:|:-:|---|
| **①** 창고 간 제한을 서버가 400 `INVALID`(`toWarehouseId`) | ✅ **동의** | 계약 원문 재확인 — `StockTransfer.description` 「출발 창고와 도착 창고가 같을 수 없다」 · x-internal-note 「⚠ 창고 간만 받는다 … 후보 ①」(둘 다 실재). 봉투도 적법하다: `ErrorItem` required 3(`scope`·`code`·`message`) + `field` 선택이라 `{scope:'field', field:'toWarehouseId', code:'INVALID'}` 가 그대로 선다. ⭐ 다만 **400 은 채번보다 먼저여야** 한다(§4-4 가 이미 그렇다 — 그물 → 채번 → tx). 뒤집히지 않는다 |
| **②** 도착이 `from_inventory_status_code` 로 되돌린다 | ✅ **동의** | ⭐ api 관점에서 이 갈림은 **계약 표면이 없다** — 원장 끝점 4칸이 `StockTransferArrive`·`StockTransfer`·`StockTransferLine` 어디에도 없다(스키마 전수 실측). 어느 쪽을 골라도 계약 위반이 아니므로 §2 2단계 기준 4 가 유일한 잣대이고, 그 잣대로 「되돌린다」가 맞다. 화면이 값을 못 보므로 문의 125 도 정당하다 |
| **③** `:arrive` 는 한 번만(재도착 400 `STATE_LOCKED`) | ✅ **동의**(계획자보다 강하게) | ⭐ 되풀이 도착을 요구하는 계약 문장이 **0건**임을 전수로 확인했다 — `:arrive` description 은 「반출한 수량 이하만 받을 수 있다」 한 줄, x-internal-note 는 **오프라인·`Idempotency-Key` 한 줄뿐**이고 `StockTransferArrive` 에 description·note 가 없다. ⇒ `plan-api.md:752` 의 「`received_qty` **합**」은 계약 근거가 없는 추정이다. PR ③ 예산(+60줄)이 지켜진다 |
| **④** `PUT …/lines` 는 자물쇠까지만 | ✅ **동의** | path description 원문 「반출이 끝난 라인은 바꿀 수 없다 … 부모 자원 GET 200 의 ETag 다. 잠그는 단위가 부모이기 때문이다」 · `StockTransferLineUpsert.description` 「— 400 `STATE_LOCKED`」 · `POST` note 「도출 단계의 `:depart` 를 두지 않는다」 셋 다 실재. 200 응답이 `StockTransferLineListResponse` 지만 도달 불가라 뷰 재사용 0줄이 맞다(CLAUDE.md) |
| **⑤** 이 슬라이스가 문서진행 조회를 고친다 | ✅ **동의** + 보강 3 | 스니펫이 그대로 선다 — `steps()` 의 `row` 는 `findFirst`(select 없음 · `document-progress-query.service.ts:93`)라 `row.stock_transfer_no` 가 실재하고, `STOCK_TRANSFER` 의 `noColumn` 은 `'stock_transfer_no'`(`document-type-registry.ts:69`)로 non-null 이라 가드가 참이다. ⓐ 접두 축은 한 전표의 원장 **둘 다**(`ST-…`·`ST-…-A`)를 남기는데 `findFirst`+`occurred_at asc`(`:226-228`)라 **반출분이 집힌다** — 의도대로다. ⓑ `approval_request`·`document_cancellation` 갈래는 적치와 안 겹친다(`target_type_code`·`document_type_code` 축이 다르다). ⓒ ⚠ SEQ 가 4자리를 넘으면 `ST-…-0001` 이 `ST-…-00011` 의 접두가 된다(일 9999건 초과 — 오늘 도달 불가) ⇒ 주석 한 줄만 남긴다 |

## 2. 브리프 추가 항목

- **6. 문의 6건(120~125) 신규성** ✅ — `docs/design-inquiries/` **016~062 전수 제목 대조**(001~015 는 발신 완료 · README §0 대기 15건과도 대조) 결과 겹침 **0**. 이름이 비슷한 050·051 은 `POST /production/material-returns` 라 **다른 자원**이다. 121·124 를 직접 재확인 — 121 은 계약 문장 실재(위 ①)로 성립, 124 는 「닫는 오퍼레이션 0건」이 계약 전수(6건 + 취소 enum 3값)로 성립. ✏ **한 줄 보탤 것**: 051 이 반대 선례를 남겼다 — 자재 반출은 `requested_at` 을 **서버 수신 시각**으로 채웠다. I-13 §4-1(`requestedAt ?? occurredAt`)이 더 맞다(여긴 계약이 `occurredAt` 을 준다). 그 대비를 §4-1 근거에 한 줄 붙여 두면 구현·리뷰가 흔들리지 않는다.
- **7. 새 에러 코드 0건** ✅ — `src/common/errors/error-codes.ts` 전문 실측. 쓰는 코드 7종(`REQUIRED`·`INVALID`·`RANGE`·`STATE_LOCKED`·`LINE_REQUIRED`·`NEGATIVE_BALANCE`·`PERMISSION_DENIED`)이 전부 실재하고 `QTY_EXCEEDS_ORDERED` 를 안 쓰는 판단도 그 파일 주석(「발주를 이미 받은 양보다 «적게» 고친다 — 반대 방향」)과 맞다.
- **8. e2e 39 · 단위 5 의 빠진 갈래** — **3건**(아래 M1~M3). 계획자가 「가드가 알아서 한다」를 적지 않아 순서가 비어 있고, `:arrive` 의 사번 그물은 §5-1 ① 에 세워 놓고 못 박지 않았다.
- **9. PR 4 분할** ✅ — 예산 근거가 api 관점에서도 선다(핸들러 6 · 뷰 2종 · 검증 그물 8). **PR ① 병행 스폰 ✅** — ① 은 조회·뷰·권한뿐이고 다섯 자리에 안 닿는다. 권한 2줄을 라우트보다 먼저 병합해도 안전하다: `operation-permissions.spec.ts:11` 은 **계약 실재**만 보고 핸들러 실재를 안 본다.
- **10. 자기 관점 계획서와의 어긋남** — 아래 §4. 구현에 영향 주는 것만 골랐다.

## 3. `I-13.md` 에 반영할 수정 — **9건**

| # | 자리 | 수정 | 근거 |
|:-:|---|---|---|
| **M1** ⭐ | §6-2 순서 · e2e 36 | `PUT …/lines` 는 **If-Match 헤더가 «없으면» 가드가 400 `REQUIRED`(scope=screen)** 를 낸다 — 404·409·`STATE_LOCKED` 보다 **먼저**다. 순서표에 0단계로 넣고 e2e 36 에 그 갈래를 더한다 | `optimistic-lock.guard.ts:36-48` (`IfMatchVersion` = required 갈래) |
| **M2** ⭐ | e2e 37 | 「없는 전표의 라인 치환은 404」 테스트는 **유효한 `If-Match` 를 실어야** 한다 — 안 실으면 가드가 400 을 내 404 를 못 본다. 없는 전표라 ETag 를 못 받으니 `If-Match: '1'` 을 손으로 싣는다는 단서를 이름 옆에 남긴다 | 같은 자리 |
| **M3** ⭐ | e2e(PR ③) | **`:arrive` 의 `X-Worker-No` 갈래가 없다**(e2e 22 는 `POST` 만) — §5-1 ① 이 그 검사를 세웠는데 못 박지 않았다. 「`:arrive` 에 사번이 없으면 400 `REQUIRED` · 없는 사번이면 400 `INVALID`」 한 건 추가 ⇒ e2e **39 → 40** | `assertWorkerNo`(`work-session.service.ts:181-187`) · 계약 `WorkerNo` required 가 두 자리 |
| **M4** | §4-2 그물표 머리 | 「⚠ 이 표 «앞»에 가드 둘이 선다 — `Idempotency-Key` 부재 400 `REQUIRED` · 비-uuid 400 `INVALID`(`idempotency.guard.ts:36-53`) · `If-Match` 형식 오류 400 `INVALID`」 한 줄. 서비스가 그 셋을 다시 짜지 않게 못 박는다 | 같은 파일 |
| **M5** | §9-5 | 「⛔ `operation-permissions.spec.ts` 는 **안 고친다**」 한 줄 — 그 spec 은 `declares403` **250**(계약 무변경)과 `covered.length ≥ 152`(부등호)라 2건 추가에 숫자 단언이 안 걸린다. PR ① 구현자가 헛되이 spec 을 고치는 것을 막는다 | `operation-permissions.spec.ts:52-58` |
| **M6** ⭐ | §13-1 #3 | 「`plan-api.md:157` PR **3** → 4」는 셈이 어긋난다 — **S05 는 7건이고 그중 `POST /logistics/recycle-entries` 는 I-17 몫**이다(`assignment.tsv:122`). plan-api S05 의 ③ 이 그 재생재라 **I-13 몫은 2**다. 「**2 → 4**」로 고치고, 통합자가 S05 를 고칠 때 마이그 칸의 `recycle_entry.warehouse_id`·`remarks` 를 **지우지 않도록** 단서를 붙인다 | `assignment.tsv:96-101,122` · `plan-api.md` S05 |
| **M7** | §11-3 「알려둘 것」 11 → **13** | ⓛ 조회 3건은 계약이 **200 «만»** 선언한다 — §7-1 의 숫자 축 400 `INVALID` 도 404 와 같은 미선언 응답이다(형제 목록 셋도 200 만 선언 ⇒ 관행 동일 · 구현 변경 없음). ⓜ `:arrive` 는 `version_no` 를 올리는데 **응답 ETag 가 없다**(계약 200 headers 0) — 도착 뒤 다시 쓰려면 상세 GET 을 한 번 더 불러야 한다 | 계약 `responses` 전수(python) |
| **M8** | §3-8 스니펫 주석 | 「⚠ `startsWith` 는 SEQ 가 4자리를 넘으면 같은 날 앞 번호의 접두가 된다(일 9999건 초과 — 오늘 도달 불가)」 한 줄 | 위 ⑤ ⓒ |
| **M9** | §4-1 `requestedAt` 근거 | 문의 **051** 대비 한 줄 — 「자재 반출은 서버 수신 시각을 썼다. 거기는 계약이 `occurredAt` 을 안 줬고 여기는 준다」 | `docs/design-inquiries/051-…md` |

⛔ **반대(⛔) 0건.** 다섯 자리와 문의 6건 모두 계약 원문·가드·spec 실측으로 지탱된다.

## 4. `plan*.md` 에 반영할 것(api 몫)

1. **`plan-api.md` S05 149행 「예상 PR 수 3」** — I-13 4 + 재생재(I-17) 1 = **5**로 고치고 오퍼레이션 소속을 명기한다(M6).
2. **`plan-api.md:152`**(S05 설계 미정 초안 = `:arrive` 부분 도착 하나) → 신규 6건(120~125) + 기존 4건 줄 추가.
3. **`plan-api.md:748`** — `transfer-issue` `(없음)`→`REGISTERED` 행을 「전이가 아니다 — `from` 이 없다」로(계획안 §8-2 ✅ 동의).
4. **`plan-api.md:752`** — 「`received_qty` **합**」의 뒤 절반을 지운다. **계약 근거가 0**임을 위 ③ 에서 전수로 확인했다.
5. **`plan-api.md:1091`** 채번 표 — `stock_transfer_no` = **`ST-{YYYYMMDD}-{SEQ4}`** 로 채운다. ✅ 계약 example `ST-2026-000260` 과 형식이 다른 것이 **관행**이다(`numbering.service.ts:16,23,25,27` 넷이 「계약 example 은 형식만」을 이미 적었다).
6. **`plan-api.md:966`** ✅ 무변경 — 권한 미등록 2건(`:arrive`·`PUT …/lines`) 실측 재확인, derived 2 / manual 2.
7. `plan-integration.md:324`(`AVAILABLE` 고정) · `plan-uiux.md:48`·`:250-253` 은 계획안 §13-1 #1·#2·#4·#6 대로. api 관점에서 #4(응답 ETag 는 `POST` 201 · `GET` 상세 **둘뿐**)를 실측으로 재확인했다.

## 5. 요약

- **문의 최종 건수**: 신규 **6**(120~125) 유지 · 기존 4(059·031·14·060)에 줄 추가 유지 — **늘지도 줄지도 않는다**.
- **⛔ 반대 0건** · **멈춤 조건(README §3) 해당 없음** — 물리 삭제 0 · 게이트 실패 0 · 계약 모순 0(계약과 «물리»의 어긋남은 문의 121 로 올린다).
