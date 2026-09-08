# I-21 독립 리뷰 — **API 설계 관점**

> 대상: `docs/coverage-100/slices/I-21.md`(901줄 전문 · PR **#416** · 브랜치 `docs/coverage-100-a-i21-plan`) ·
> 통보 `docs/design-inquiries/089-…md`(전문) · 내 관점의 통합 계획서 `docs/coverage-100/plan-api.md`.
> 계약 `contracts/quality-03품질.json`·`shipment-04제품출하.json`·`logistics-01자재창고.json`·`mdm-기준정보.json`
> (읽기 전용 · `contracts/COMMIT.txt` = **a6a87e144116ebaa32c01df5a12a0fd2924427e7**)를 **python 으로 직접 파싱**했다.
> ⛔ `I-21-review-uiux.md`·`I-21-review-integration.md` 는 **열지 않았다.** ⛔ 코드·계약·마이그레이션 수정 0 ·
> PR 생성/코멘트 0 · `contracts:update`/`contracts:check` 0 · `pnpm exec` 0 · 게이트 재실행 0 · DB 접속 0.
> 심각도: CREFLE `pr-review` 4단계(Blocker/Major/Minor/Nit).

---

## 0. 판정 요약

**채택 5 · 반증 4 · 유지 1** — 대상은 브리프 §2 의 「스스로 뒤집은 것 셋 + 정한 것 둘」과 계획안 §0 「리뷰가 반드시 볼 자리 5」.

| # | 자리 | 판정 |
|:-:|---|:-:|
| 뒤집기 ① | `plan-api.md:871`·`I-19.md` §11 ③ 이 「계약이 `SCRAPPED` 전이를 안 적었다」 | **채택**(확인 도장) |
| 뒤집기 ② | 잔량 초과는 400 이 아니라 **409 `DISPOSITION_QTY_EXCEEDED`** | **채택** |
| 뒤집기 ③ | 「`plan.md` §4 · `plan-integration.md:185` · `plan-api` 셋이 서로 다르다」 | ⛔ **반증** — 열을 하나 밀려 읽었다. **넷이 다 「마이그 0」으로 같다** |
| 정한 것 Ⓐ | `C17`·`C18`·`C19` 신설 | **채택**(조건 2 · 아래 §1-4) |
| 정한 것 Ⓑ | `concession.status_code = 'APPROVED'` | **유지**(조건 1 · 아래 §1-5) |
| §0 자리 1 | `SCRAPPED` 도착은 계약이 적었다 | **채택** |
| §0 자리 2 | 처분이 옮기는 LOT 집합 · `lots[].uomId` 혼합 400 | **부분 반증**(ⓐ · Major M-5) |
| §0 자리 3 | `followUp*` 는 폐기만 셀 수 있다 | **부분 반증**(근거 · Major M-3) |
| §0 자리 4 | 후보 목록을 **창고 축으로는 만들 수 없다** | ⛔⛔ **반증 — Blocker.** `mdm.warehouse.is_defect` 가 **실재하고 이미 구현돼 있다** |
| §0 자리 5 | If-Match 토큰 원천이 다른 계약 파일 | **채택 + 보강**(Major M-2 — 7계약 유일의 201+If-Match) |

**Blocker 1 · Major 5 · Minor 7 · Nit 2.**

---

## 1. ⭐⭐ 브리프 §2 의 다섯 — 개별 판정

### 1-1. 뒤집기 ① — **채택.** 계약은 도착 상태를 적었다

`contracts/quality-03품질.json:2460`(`POST /quality/nonconformances/{nonconformanceId}/disposition-decisions` 의 `description`) 원문을 python 으로 다시 꺼냈고 **한 글자도 다르지 않다**:

> ⭐ 판정 저장과 Lot Status 전이는 한 트랜잭션이다(공유계약 B-8) — 처분만 남고 LOT 이 안 바뀌면 다음 화면이 잘못된 대상을 집는다. …
> ⭐ **도착 상태는 처분에 따라 갈린다 — 재작업 → INSPECTION_PENDING(검사 대기) · 폐기 → SCRAPPED(폐기) · 정상 → NORMAL(정상).**

`plan-api.md:871-874` 도 원문 그대로다 — 「`SCRAPPED` 로 가는 전이도 계약에서 못 찾았다(폐기 처분 `disposition_type_code=SCRAP` 이 그 자리로 보이나 **계약이 LOT 상태를 옮긴다고 적지 않았다**)」. ⇒ **계획안이 맞고 `plan-api.md` §5.1-E 열거가 틀렸다.**

⭐ **다만 「3관점이 다 놓쳤다」는 과장이다** — `plan-integration.md:391` 이 **이미 옳게 적어 두었다**:
> **상태기계**: 처분 저장 + Lot Status 전이가 한 트랜잭션. **도착 상태가 계약에 표로 있다**(재작업→`INSPECTION_PENDING` · 폐기→`SCRAPPED` · 정상→`NORMAL`).

계획안 §10-1 7행이 `plan-integration.md:185`(표 한 줄)만 대조하고 같은 문서 `:387-392`(I-21 절 본문)를 안 읽어 이 사실을 놓쳤다. 통보 089 의 「우리 3관점 계획서 **두 곳**이 그렇게 적었다」는 정확하다(둘뿐이다) — 그 옆에 **맞게 적은 세 번째가 있었다**는 사실만 빠졌다. 통보 089 본문 한 줄로 닫힌다(Nit).

### 1-2. 뒤집기 ② — **채택.** 잔량 초과는 409 다

실측(python):
- `QualityConflictResponse.code` enum **6값** — `VERSION_CONFLICT`·`DUPLICATE_KEY`·`INVALID_STATE`·`DUPLICATE_HOLD`·`HOLD_QTY_EXCEEDED`·**`DISPOSITION_QTY_EXCEEDED`** ✓
- 그 `code` 설명 원문 — 「`DISPOSITION_QTY_EXCEEDED` 는 처분 결정 수량 합이 대상 수량을 넘는다는 뜻이고 **`remainingQty` 를 함께 내린다**」 ✓
- `QualityConflictResponse.remainingQty`(「화면 문구 「남은 수량은 120 EA 입니다」가 이 값을 쓴다. ⛔ **message 자유 텍스트에서 파싱하지 않는다**」)·`remainingQtyUomId` **둘 다 실재** ✓
- `POST …/disposition-decisions` 의 409 = `QualityConflictResponse` ✓
- `plan-integration.md:392` 원문 — 「수량 합이 대상 수량을 넘으면? 계약이 말하지 않는다 → 2단계 기준 2「거부하는 쪽」 → **400**」 ⇒ **틀렸다**(브리프가 `:389` 로 적었으나 실제 줄은 `:392` — 표기만 다르다).

⇒ **뒤집기 ② 는 옳다.** 계약이 값·구조화 칸·「자유문에서 파싱하지 마라」까지 적었으므로 400 은 성립하지 않는다.

⭐ **보강 — 계획안이 안 적은 반쪽.** `ShipmentConflictResponse`·`QualityConflictResponse` **둘 다 `required: ['code','message']`** 다. 그런데 이 저장소의 409 는 `ConflictException(cause, message, extra?)` 이고 `code` 는 **선택 `extra`** 다(`src/common/errors/conflict.exception.ts:22-36`). ⇒ 쓰기 3건의 **모든** 409 가 `code` 를 실어야 계약을 지킨다 — If-Match 불일치 포함(`assertUpdated(rows, cause, extra)` 의 셋째 인자 · `src/common/optimistic-lock/optimistic-lock.ts:57-66`). 계획안 §1-6 은 코드 값 목록만 적고 「누가 그 칸을 채우나」를 안 적었다. 관련 구멍은 아래 **m-6**.

### 1-3. 뒤집기 ③ — ⛔ **반증.** 「셋이 서로 다르다」가 아니라 **넷이 같다**

계획안 §2-5 머리:
> ⚠ 통합 계획서 §4 에 I-21 행이 «없다»(마이그 0 을 전제했다). `plan-integration.md:185` 는 「마이그 **있음**」이라 적어 **셋이 서로 다르다.**

`plan-integration.md:161`(범례)과 `:163`(표 머리)을 직접 읽었다:

```
161: 범례 — **표**: 있음 / 결손(마이그레이션 필요) · **원장**: posting 을 부르는가 · **상태기계**: …
163: | # | 슬라이스 | 건 | 선행 | 표 | 마이그 | 원장 | 상태기계 | PR |
185: | I-21 | 부적합·처분·특채 | 11 | I-20 | 있음 | ✕ | ✕(폐기는 I-4 재사용) | ⭕ | 3 |
```

- 5번째 칸 **「표」** = **물리 표가 있는가** → `있음`.
- 6번째 칸 **「마이그」** = **✕**.

⇒ `plan-integration.md:185` 는 「마이그 **있음**」이라 적은 적이 **없다. 「마이그 ✕」다.** 형제 행이 그 읽기를 못 박는다 — `I-16`(`| … | **신설 2**(`handling_unit_repack_event(+_line)`) | **⭕ N-2** | …`)·`I-17`(`있음(recycle_entry)`)·`I-23`(`있음(재등록은 stock_transfer 재사용)`)의 5번째 칸이 전부 **표 이름**이다.

같은 밀림이 §10-1 7행에도 있다 — 「`plan-integration.md:185` — 원장 ✕ · posting ✕ · 상태기계 ⭕ | 같다」는 **마이그 칸을 원장으로, 원장 칸을 posting 으로** 한 칸씩 당겨 읽은 것이다(그 표에 「posting」 칸은 없다).

⭐ 그리고 **내 관점의 통합 계획서도 「마이그 0」이다** — 계획안이 인용조차 하지 않은 자리다:
```
plan-api.md:520  | 마이그레이션 | 없음 — sourceCode·affectedQtyTotal·dispositionProgressCode·followUp* 는
                   **전부 계약이 「서버가 롤업한다」라 선언한 파생**이다(L-2). 저장 칸을 만들지 않는다. |
```

⇒ **`plan.md` §4(행 없음) · `plan-api.md:520`(없음) · `plan-integration.md:185`(✕) 넷이 아니라 셋이 다 「마이그 0」이고 서로 어긋난 곳이 0건이다.**
계획안의 **결론**(M-h 2항목)은 그대로 살아 있다 — 그것은 「통합 계획서끼리의 모순」이 아니라 **계획안이 통합 계획서 셋을 함께 뒤집는 것**이다. 문장을 그렇게 고쳐야 §12-1·§0-재수립 표가 없는 모순을 기록하지 않는다. ⇒ **Minor m-1.**

### 1-4. 정한 것 Ⓐ — `C17`·`C18`·`C19` · **채택(조건 2)**

**계약 정합 실측.** 7계약 전수에서 `C\d+` enum 은 **두 자리뿐**이고 둘 다 같은 파일이다:
```
logistics-01자재창고.json /paths//trace/lot-status-events/get/parameters[3]/schema  ['C4'..'C15'] (9값)
logistics-01자재창고.json /components/schemas/LotStatusHistoryEvent/properties/transitionCode ['C4'..'C15'] (9값)
```
⇒ 계획안 §11 ④ 의 「새는 곳은 I-18 의 `GET /trace/lot-status-events` 하나」는 **정확하다.** `GET /quality/lot-status-transitions`·`GET /mdm/code-values` 는 `transitionCode` enum 을 갖지 않아 3값을 더해도 계약 위반이 아니다.

⇒ **A안 채택에 동의한다.** B안(9종으로 접기)은 `to=SCRAPPED` 인 코드가 0개라 구조적으로 불가(실측 재확인 — 시드 9값 전건 `to` 가 `NORMAL`/`INSPECTION_PENDING`/`DEFECTIVE`), C안(전이 미등록)은 계약 `:2460` 의 본문을 정면으로 거스른다.

**조건 ① — `sourceOperation` 을 §6-2 표에 «문자열로» 적어라.** 이유가 계약이 아니라 **이미 배포된 오퍼레이션**에 있다:
```
src/quality/lot-status/lot-status-transition.service.ts:79-81
  const entries = Object.values(TRANSITIONS[QUALITY_COLUMN] ?? {}).filter(
    (t) => t.sourceOperation === CREATE_HOLD_OP || t.sourceOperation === RELEASE_HOLD_OP);
```
`GET /quality/lot-status-transitions`(I-20 PR ①c · 배포됨)가 `transitions.ts` 의 **같은 축**을 읽는다. 새 3행이 `sourceOperation: 'POST /quality/nonconformances/{nonconformanceId}/disposition-decisions'` 를 갖는 한 그 필터가 **걸러 낸다** ⇒ 응답 불변 ⇒ `test/quality-lot-status.e2e-spec.ts:423`·`:449` 의 `toHaveLength(4)` 도 초록이다. **비워 두거나 두 보류 오퍼레이션 문자열과 겹치면 그 두 단언이 즉시 깨지고**, 계약 `LotStatusTransitionSet.note`(`quality-03품질.json:4472` — 「불량(Hold)은 발신 전이가 0이라 빈 드롭다운 대신 안내를 보인다」)가 **`DEFECTIVE` LOT 에서 사라진다.** 계획안 §6-2 의 ⚠ 항목은 그 문장을 「도식 범위 문제」로만 다뤘고 **그 문장을 실제로 구현한 코드가 있다는 사실을 안 봤다.** 조건을 붙이면 PASS 다(예산 0).

**조건 ② — `moveWithin` 에 `transitionCode` 를 넘기지 마라(죽은 인자).** 아래 **m-5**.

### 1-5. 정한 것 Ⓑ — `concession.status_code = 'APPROVED'` · **유지(조건 1)**

- 계약이 값 목록을 안 줬다 — `Concession.statusCode` 는 `type: string` · **enum 없음** · `x-code-key` 없음 ✓(python 실측).
- `usableOnly` 설명 원문 — 「⭐ 지금 쓸 수 있는 것만 — **상태·유효기간·잔여의 3항 논리곱**을 서버가 판정한다」 ✓ 계획안 인용 정확.
- `usable` 프로퍼티 설명 원문 — 「⭐ 서버가 파생한 3항 논리곱 — **상태가 유효하고 `valid_to` 가 지나지 않았고 `approvedQty − consumedQty > 0`** 인가」 ✓

⇒ 값 자체는 API 관점에서 반대할 근거가 없다(계약이 안 줬고, 응답 `statusCode` 는 enum 이 아니라 어떤 문자열도 통과한다 · `writer` 가 0개라 임의 값이 들어올 길이 없다는 계획안 논지도 실측과 맞다).

**조건 — `valid_from <= 기준일` 은 계약이 «안 적은» 넷째 항이다.** 계약 두 자리 모두 **3항**이고 그중 기간 항은 **`valid_to` 하나**다. 계획안 §4-3 은 4항으로 적었다:
```
usable = status_code='APPROVED' AND valid_from <= 기준일 AND (valid_to IS NULL OR valid_to >= 기준일) AND (approved-consumed) > 0
```
- 미래 시작 특채(`valid_from` 이 내일)는 계약 문자대로면 `usable=true`, 계획대로면 `false` 다. **계획 쪽이 옳아 보이지만 그것은 «계약 밖 판정»이므로 통보 089 §2 에 한 줄이 서야 한다** — 지금 089 §2 는 식을 4항으로 적어 놓고 「3항 논리곱」이라는 계약 문장을 나란히 인용해, 설계팀이 읽으면 **우리가 계약을 그대로 구현했다고 읽힌다.**
- e2e §8-4 에도 반증 행이 없다 — #3·#4 는 `valid_to` 경계, #5 는 잔여, #6 은 상태다. **`valid_from` 이 미래인 행이 픽스처에 0건**이라 그 항을 지워도 13건이 전부 초록이다(**죽이는 변이 부재** — README §6-2). 픽스처 한 줄 + 시험 한 줄이면 닫힌다.

---

## 2. §0 「리뷰가 반드시 볼 자리 5」 — API 관점 판정

### 자리 1 — **채택**(§1-1).

### 자리 2 — **부분 반증.** ⓑⓒ 는 PASS, **ⓐ 는 계약 주석과 반대 방향이다** → **Major M-5**

ⓑ(판정 저장이 `nonconformance_lot` 전건을 옮긴다)·ⓒ(매 판정마다 · 마지막 도착이 남는다)는 API 관점에서 반대할 근거가 없다 — `disposition_decision` 에 `lot_id` 칸이 없고(`schema.prisma:3200-3216` 재확인 — 10칸 전건에 `lot_id`·`version_no`·`updated_at` 없음) 계약도 결정↔LOT 을 잇는 칸을 안 뒀다.

**ⓐ 는 다르다.** 계획안은 「설계도 답이 없다 — `W-03-10` §8 #7 이 미결」이라 적고 **계약 자기 주석을 안 봤다.** `DispositionRemainingSummary` 의 `x-internal-note` 원문:

> 한 부적합은 한 품목이라(`nonconformance.item_id` NOT NULL) 대상 LOT 의 단위가 하나라는 전제 위에 합을 낸다. **단위가 섞인 부적합이 실제로 성립하면 «합을 내리지 말고» 화면이 두 값을 그대로 보여야 한다(공유계약 A-11 보강).** 추적은 `W-03-10` §8 미결이 갖는다.

계약은 그 자리를 **미결로 두지 않았다** — 「성립하면 이렇게 하라」라는 지침을 적었고, 그 지침은 **「받지 마라」가 아니라 「합치지 마라」**다.

- **실패 예** — `POST /quality/nonconformances` 에 `lots: [{lotId:L1, affectedQty:100, uomId:EA}, {lotId:L3, affectedQty:5, uomId:BOX}]` → 계획대로면 **400 `INVALID`**. 계약이 상정한 화면 동작(두 값을 그대로 보임)은 서버가 그 부적합을 **애초에 만들 수 없게** 만들어 영원히 도달하지 못한다. 그런데 `NonconformanceLotCreate.uomId` 는 **LOT 마다 required 인 독립 칸**이다(required 3 = `lotId`·`affectedQty`·`uomId` · 실측) — 계약이 단위를 LOT 축에 둔 것 자체가 「섞일 수 있다」는 선언이다.
- 판정을 뒤집으라는 말은 아니다. README §2 2단계 기준 2(거부하는 쪽)로 **거부는 설 수 있다.** 다만 ⓐ 의 근거가 「설계도 답이 없다」에서 **「계약이 다른 답을 적었고 우리가 그것을 안 따르기로 정했다」**로 바뀌어야 하고, **통보 089 §6 이 그 사실을 적어야 한다** — 지금 089 §6 은 계약 주석을 인용하지 않아 설계팀이 「미결을 우리가 닫았다」로만 읽는다.
- 예산 변화 0(문장 두 줄).

### 자리 3 — **부분 반증.** 결론은 살지만 **근거 표가 계약과 다르다** → **Major M-3**

계획안 §0 #3 과 통보 089 §4 의 표는 후속 축을 이렇게 적었다: 폐기 = `logistics.goods_issue`(셀 수 있다) · 정상 = `logistics.stock_reinstatement`(표가 없다) · 재작업 = `production.work_order.rework_source_nonconformance_id`(부적합 축).

**계약 `DispositionDecision` 의 `x-internal-note` 는 셋 다 다르게 적었다**(python 실측 · 원문):

> `followUpStatusCode`·`followUpQty` 는 결정 «건별» 롤업이 안 서는 자리다 — 후속 전표(**폐기=logistics.goods_issue · 정상=logistics.stock_transfer · 재작업=production.production_result**)와는 **LOT 축까지만 이어지고**, 한 LOT 에 처분 결정이 여럿 달릴 수 있어 **건별 귀속이 갈리지 않는다.** 서버가 그 갈래를 어떻게 정하는지는 **아직 계약에 없다.**

세 가지가 갈린다:

1. **정상의 후속 표가 `stock_transfer` 다**(계획: `stock_reinstatement`). `logistics.stock_transfer` 는 **물리에 실재한다**(`schema.prisma:1424-1452`) — 즉 「표가 없어서 못 센다」가 아니다. 못 세는 이유는 **그 표에 처분 결정을 가리키는 칸이 없다**는 것이다(18칸 전수 — `source_document_*` 계열 0). 결론(원천 0)은 같지만 **통보 089 §4 가 설계팀에 「표가 없다」라는 틀린 사실을 보낸다.**
2. **재작업의 후속 표가 `production_result` 다**(계획: `work_order`). `production_result` 에도 처분 결정 칸이 없다(`result_source_code` 뿐 · `rework_source_*` 3칸은 `work_order` 쪽 · baseline `:2907-2909`). 결론은 같고 표 이름이 다르다.
3. ⭐ **계약은 폐기도 「셀 수 있다」고 하지 않았다** — 「후속 전표(폐기 포함)와는 **LOT 축까지만** 이어지고 … 건별 귀속이 갈리지 않는다」다. 계획안이 든 `goods_issue.source_document_type_code='DISPOSITION_DECISION'` 은 **`W-04-10` 화면 문서**가 근거이고 계약 본문이 아니다. 계약이 이 자리에서 스스로 「아직 계약에 없다」라 적었으므로, 폐기 롤업은 **우리가 계약보다 앞서 «정한 것»**이다 — README §2 3단계 흔적(`// 결정 — 통보 089`)이 그 자리에도 붙어야 하고, 통보 089 §4 가 「계약이 셋 다 못 센다고 적었는데 우리는 폐기 하나를 세기로 했다」로 읽혀야 한다.

⇒ 판정(폐기만 센다 · 나머지 `0`/`NOT_STARTED`)은 **유지**. 근거 표와 통보 089 §4 를 계약 주석 기준으로 다시 쓰라.

### 자리 4 — ⛔⛔ **반증 · Blocker.** `mdm.warehouse.is_defect` 는 **있다**

계획안 §0 #4 · §1-4 · §4-1 · 실측 부록 #27 의 전제:
> 물리 실측: **`mdm.warehouse` 에 「불량창고」를 가리는 칸이 0개**(`is_defect` 류 없음 · `warehouse_type_code`·`management_level_code`·`is_external` 뿐)라 `REQ-PR-0025` 「판정은 불량창고 입고 후」를 **창고 축으로 못 만든다**.

**틀렸다. 네 자리에서 동시에 반증된다:**

| 자리 | 실측 |
|---|---|
| 계약(mdm) | `Warehouse.isDefect` — **`x-source-column: "is_defect"`** · `default:false` · **`Warehouse.required` 안** · 「W-01-06 §3의 창고 선택이 `isDefect=true` 로 걸러진다. 근거: DR-012 확정 3-C(2026-08-13) · omf-mes#147」. `WarehouseCreate`·`WarehouseUpdate` 에도 있다 |
| 계약(질의) | `GET /mdm/warehouses` 의 질의 파라미터 **`isDefect`**(boolean) — 「불량창고만 거른다」 |
| 물리 | `prisma/schema.prisma:2314` **`is_defect Boolean @default(false)`** · 마이그레이션 `prisma/migrations/20260828000000_add_warehouse_is_defect/migration.sql:25` `ALTER TABLE mdm.warehouse ADD COLUMN is_defect boolean NOT NULL DEFAULT false` · **`main` 에 병합됨**(`de85fab feat(db): mdm.warehouse.is_defect — 불량창고 축 신설 (#47)`) |
| 소스 | `src/mdm/logistics/warehouse.service.ts:52` · `warehouse.controller.ts:107`·`:118` — **이미 구현·노출돼 있다** |
| 시드 | `prisma/seed.ts:219-224` — 「DEFECT는 유형이 아니라 축이라 **`mdm.warehouse.is_defect`(#47)로 옮겼다**」 |

그리고 **이 슬라이스의 계약이 그 축을 직접 가리킨다** — `GET /quality/disposition-candidates.warehouseId` 설명 원문:
> 「불량창고로 좁힐 때 쓴다 — **목록은 `GET /mdm/warehouses?isDefect=true` 가 준다**(DR-012 3-C).」

같은 오퍼레이션의 `quantity`·`receivedAt` 설명도 그 축 위에 서 있다 — 「판정 대상 수량 — 그 LOT 이 **불량창고에 들어온 수량**이다」·「**불량창고에 들어온 날**」.

**이것은 I-20 R-24 와 «같은 유형의 네 번째 사고»다** — 계획안이 **baseline 마이그레이션(`20260727000000:299-321`) 한 자리만 보고** 그 뒤 마이그레이션(`20260828000000`)과 `schema.prisma` 를 안 봤다. 실측 부록 #27 이 근거로 든 줄 범위가 정확히 그 자리다.

**무엇이 무너지나:**
- §0 #4 의 「⇒ **원천 축으로만 만든다**」 판정 전체.
- ⭐ **「잔액 창고가 둘 이상인 LOT 은 목록에서 뺀다」**(§0 #4 · §1-4 · §4-1 SQL 의 `WHERE bal.warehouse_id IS NOT NULL`). 이 조용한 탈락은 계약이 직접 금지한 모양이다 — 같은 오퍼레이션 설명: 「⛔ 화면이 응답을 걸러 「아직 안 만든 것」을 고르지 않는다 — **목록이 페이지 단위라 성립하지 않는다**」. 서버가 대상을 통째로 빼면 화면은 그 사실조차 못 본다. `is_defect` 축을 쓰면 모집단이 **`inventory_balance × warehouse WHERE is_defect`** 라 `warehouseId`(required)를 «고르는» 문제 자체가 사라진다.
- `quantity` 의 뜻 — 계약은 「**불량창고에 들어온 수량**」이라 적었는데 계획은 「LOT 전체 잔액 합」으로 냈다. 정상 창고에 남은 잔량까지 판정 대상 수량으로 보이는 것은 계약과 다르다.
- **PR ③**(`disposition-candidate-query.ts` 원시 SQL · 229줄)이 통째로 다시 그려진다 — 계획안 자신이 「뒤집히면 PR ③ 의 원시 SQL 이 통째로 바뀌고 예산이 ±80 흔들린다」라 적은 그 자리다.
- 픽스처 **L4**(잔액 창고 둘)·**L5**(0행)의 뜻과 e2e §8-3 **#2**·**#3** 이 다시 쓰인다.

⚠ **운영 사실 하나** — `is_defect` 는 `DEFAULT false` 로 백필 없이 섰다(마이그 주석 「거짓으로 두면 … 비어 보이고, 참으로 두면 모든 창고가 불량창고가 된다. 비어 보이는 쪽이 안전하다 — 운영에서 해당 창고를 켜면 된다」). ⇒ 축을 쓰면 **오늘 운영 DB 에서 후보 목록이 빈다.** 그것은 「축이 없다」가 아니라 「마스터가 아직 안 켜졌다」이고, 계약이 요구한 모양 그대로다. e2e 는 픽스처에서 켠다. 이 사실은 알려둘 것/통보 후보로 남긴다.

### 자리 5 — **채택 + 보강** → **Major M-2**

- 계약 실측이 계획안과 **전건 일치**한다: `POST …/disposition-decisions` 의 If-Match 원천은 04 계약의 `GET /quality/nonconformances/{nonconformanceId}` ETag(`description` 원문 확인) · 그 GET 의 200 이 **`ETag` 헤더를 실제로 선언**한다(「낙관적 잠금 토큰 — 이 행의 `version_no`」) · `x-internal-note` 가 「**판정 저장은 `nonconformance.version_no` 를 올려야 한다**」·「토큰 원천 검사기는 한 파일 안에서만 후보를 찾아 이 자리를 못 본다 — **원천이 다른 계약에 있는 첫 사례**」를 직접 적었다 ✓
- `quality.nonconformance.version_no Int @default(1)` 실재 ✓(`schema.prisma:3427-3457` 재확인) · `disposition_decision` 에 `version_no` **없음** ✓ ⇒ 「처분 결정의 판 번호」로 읽으면 죽은 칸 마이그가 난다는 계획안의 경고가 옳다.

**보강 — 계획안이 안 본 것: 이 오퍼레이션은 7계약 전체에서 «유일한» 201 + If-Match 필수다.** 전수 스캔(python — 7파일 · path-item/operation 양쪽 파라미터 합산):
```
quality-03품질.json POST /quality/nonconformances/{nonconformanceId}/disposition-decisions ['201','400','403','404','409']   ← 유일
```
그런데 이 저장소의 공용 골격은 200 고정이다:
```
src/common/master/master-write.ts:39-56
export async function runVersioned<T, K extends string>(…) {
  …
  const result = await runIdempotent(idempotency, request, HttpStatus.OK, () => work(version));
  setEtag(response, result.versionNo);
```
`runVersioned` 의 전 사용처(`worker`·`department`·`code`·`spare-part`·`work-calendar` 컨트롤러 · grep 전수)가 **200 짜리 PUT/전이**다. 201 자리는 전부 `runIdempotent(…, HttpStatus.CREATED, …)` 를 따로 쓴다.

- **실패 예** — §3-3 대로 `runVersioned` 를 쓰면 `idempotency_record.response_status` 에 **200 이 저장된다**(`idempotency.service.ts:83`·`:89`·`:126`). 오늘은 `runIdempotent` 가 `outcome.status` 를 버려 HTTP 상태가 안 바뀌지만, **저장된 값이 계약(201)과 다르고** 재생 경로가 그 값을 정본으로 삼는다.
- ⇒ 둘 중 하나다: ⓐ `runVersioned` 에 `successStatus` 를 더한다 — **`src/common/master/master-write.ts` 는 §7-1 파일표에도 §11-4 사용자 보고 목록에도 없다**(공용 코어 파일 · 전 도메인 사용처) ⓑ `runIdempotent(CREATED)` + `ifMatchVersion(request)` + `setEtag()` 를 손으로 엮는다(I-18 이 쓴 `versionOf(request)` 형). 어느 쪽이든 **PR ⑦ 의 코드 모양과 예산이 바뀌고 ⓐ 는 코어 보고 대상이 하나 는다.**

---

## 3. API 관점 전수 점검표 — `plan-api.md` ↔ 계획안

계획안 §10-1 대조표는 `plan.md`·`plan-uiux.md`·`plan-integration.md` 만 대조하고 **`plan-api.md` §S20(514~539행)·§S19(504행)을 한 번도 인용하지 않았다.** 내 관점의 통합 계획서 해당 절이 그것이다. 전건 대조:

| # | `plan-api.md` | 계획안 | 판정 |
|:-:|---|---|:-:|
| 1 | **§5.1-E `:871`** 「계약이 `SCRAPPED` 전이를 안 적었다」 | 실측으로 뒤집음 | **뒤집는다** ✓(§1-1) |
| 2 | §5.1-E 「계약이 도착 상태를 직접 적은 자리는 **넷**」 표 9행 | 판정 저장이 빠졌다 | **뒤집는다** ✓ — ⚠ 계획안 §0 #1 이 「넷」이라는 문구를 인용했는데 그 표는 **9행**이다(문구가 표와 안 맞는 것은 `plan-api` 쪽 결함) |
| 3 | **`:520`** 「마이그레이션 **없음** — `sourceCode`·`affectedQtyTotal`·`dispositionProgressCode`·`followUp*` 는 전부 파생(L-2)」 | M-h 2항목(code_value 3 + 인덱스 1) | **다르다** — ⭐ **계획안이 인용하지 않았다.** 다만 두 항목 중 어느 것도 「파생을 저장 칸으로 만든 것」이 아니어서 `plan-api` 의 «이유»는 그대로 산다 |
| 4 | **`:523`** 「예상 PR 수 **3** — ① 조회 GET 9건(분포·후보 포함) ② 부적합 등록 + `:request-disposition` ③ 처분 결정 + **승인 연결** + e2e」 | 9 · 결재 연결 **없음** | **다르다** — ⭐ 「승인 연결」이 빠진 것은 옳다(`plan-uiux.md:609` · `W-04-07` §8 #3 이 열려 있다). 계획안 §10-1 이 이 줄을 안 대조했다 |
| 5 | **`:524`** 「설계 미정 자리 · §2 판정 초안 | **없음 — 3값·2전이라 재량이 없다**」 | §9-1 이 **14건** | **다르다** ⭐⭐ — 내 관점의 통합 계획서에서 가장 크게 틀린 줄이고 계획안이 대조하지 않았다 |
| 6 | `:518` 「쓰는 표 … `defect_record`·`sorting_result`」·`:514` 「**12건**」 | 11건(불량 2건 제외) | **같다**(배정 정본 = `assignment.tsv` 11행 · `plan-api` 는 S20 에 불량 2건을 함께 담았다) |
| 7 | **§S20 4축 표 9행 + §S19 `:504`(후보)** — 멱등 3 · If-Match 필수 2 · ETag 2(`GET …/{ncId}` · 판정 저장) · 403 3 | §1-1 표 11행 | ✅ **전건 일치**(내 python 실측과도 일치 — 누락 0 · 여분 0) |
| 8 | `:941` 「`Nonconformance.sourceCode`·`affectedQtyTotal`·`dispositionProgressCode` = 서버 파생」 | 같다 | **같다** ✓ |
| 9 | `:1119`·`:1120` 「부적합 `nonconformance_no` ❌ · 특채 `concession_no` ❌ (채번 규칙 없음)」 | `NC-{YYYYMMDD}-{SEQ4}` · 특채는 writer 0이라 채번 안 함 | **같다**(문의 14 권고안) ✓ |
| 10 | `:843` 「`quality.nonconformance.status_code` … →`PENDING_DECISION` · →`DECIDED` · 안 부른다(`transitionCode` 없음)」 | §6-1 과 동일 | **같다** ✓ |

⇒ **`plan-api.md` 쪽에서 고쳐야 할 줄은 넷이다** — `:871`(뒤집힘) · `:520`(마이그 0 → M-h 2항목) · `:523`(PR 3 → 9 · 「승인 연결」 삭제) · `:524`(설계 미정 없음 → 14건). 계획안 §12 를 통합자가 채울 때 이 넷이 들어가야 `plan-api` 가 다음 슬라이스에 같은 오류를 물려주지 않는다(**R-24 의 재발 경로가 정확히 그것이다**).

---

## 4. 「계획자가 안 본 자리」 — 새로 찾은 것

### **Major M-1** — 응답 **널 정책**이 통째로 빠졌다. e2e 가 ajv 로 응답을 검증하므로 그대로 구현하면 빨개진다

형제 e2e 가 계약 응답 스키마를 **`$ref` 로 컴파일해 단언한다**:
```
test/quality-lot-hold.e2e-spec.ts:101-109
function validator(operation: string, status = 200): ValidateFunction {
  … ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` }); }
```
이 슬라이스 응답 스키마의 **선택 칸 널 허용 여부를 전수로 냈다**(python · `type` 배열에 `"null"` 이 있는가):

| 스키마 | **널을 실을 수 없는** 선택 칸 | 널을 실을 수 있는 칸 |
|---|---|---|
| `Nonconformance` | ⭐ **`workOrderId`·`responsibleDepartmentId`·`actionDescription`·`actionOwnerId`·`actionDueDate`·`actionCompletedAt`·`versionNo` (7)** | `inspectionResultId`·`closedAt` (2) |
| `NonconformanceLot` | `lotNo` (1) | — |
| `Concession` | ⭐ **`nonconformanceNo`·`lotNo`·`validTo`·`allowedWorkOrderId`·`allowedProcessId`·`allowedCustomerId`·`unrestrictedAxes`·`usable`·`remarks`·`versionNo` (10)** | — |
| `DispositionDecision` | ⭐ **`nonconformanceNo`·`lotId`·`lotNo`·`itemId`·`itemCode`·`itemName`·`decidedByName` (7)** | `approvalRequestId` (1) |
| `DispositionCandidate` | `itemCode`·`itemName`·`warehouseName` (3) | ⭐ **`goodsReceiptId`·`receiptNo`·`receivedAt`·`partnerName`·`inspectionResultId`·`nonconformanceId`·`nonconformanceNo`·`nonconformanceStatusCode` (8 — 전부 널 허용)** |

물리는 그 칸들이 **전부 nullable** 이다(`schema.prisma` 실측 — `nonconformance.work_order_id?`·`responsible_department_id?`·`action_description?`·`action_owner_id?`·`action_due_date?`·`action_completed_at?` · `concession.valid_to?`·`allowed_work_order_id?`·`allowed_process_id?`·`allowed_customer_id?`·`remarks?`).

**계획안이 널 정책을 적은 자리는 정확히 «한 곳»인데, 그 한 곳이 하필 계약이 널을 «허용한» 유일한 스키마다** — §1-4 `DispositionCandidate` 행: 「`sourceCode='PRODUCT'` 면 **키 생략**(계약이 「null 이다」라 적었으나 널 금지 규칙이 이긴다 — `plan.md` §5-7)」. e2e §8-3 **#12** 가 「PRODUCT 갈래는 … **키가 없다**(널 아님)」로 그것을 못 박는다.

- **실패 예 1(빨개진다)** — `GET /quality/concessions` 픽스처 **C5**(허용 3축 전부 NULL)를 그리며 `allowedWorkOrderId: null` 을 실으면 ajv 가 `type:"integer"` 로 막아 **§8-4 #10 이 실패**한다. `validTo` 가 NULL 인 특채도 같다.
- **실패 예 2** — `GET /quality/nonconformances` 의 N1~N6 은 전부 `workOrderId`·`responsibleDepartmentId`·`action*` 4칸이 NULL 이다. 널로 실으면 목록·상세 두 시험이 함께 빨개진다.
- **실패 예 3** — `DispositionDecision.lotId`·`lotNo` 는 계획안이 「N5(lots 2건)면 **키 생략**」이라 옳게 적었지만(§1-4 · e2e #29), **`nonconformanceNo`·`itemCode`·`itemName`·`decidedByName`** 의 널 갈래는 어디에도 없다.
- **실패 예 4(반대 방향)** — `DispositionCandidate` 는 계약이 「`sourceCode=PRODUCT` 면 **null 이다**」라 **본문에 명시**했다(`goodsReceiptId`·`inspectionResultId` 설명 원문). 여기서만 키를 생략하면 계약이 «시킨 대로» 하지 않은 유일한 자리가 된다.

⇒ **§1-4 에 「널 정책 — 스키마마다·칸마다」 절이 서야 하고, §8 의 세 e2e 파일에 각각 한 줄씩 단언이 붙어야 한다.** 예산 변화는 거의 0(뷰 함수의 `omitEmpty`/`?? undefined` 선택뿐)이지만 **없으면 PR ①·②a·⑤ 가 전부 한 바퀴 더 돈다.** I-18 Major 1·2 와 **같은 자리**다.

### **Major M-2** — 7계약 유일의 201+If-Match 를 200 고정 골격에 태웠다(§2 자리 5).

### **Major M-3** — 후속 롤업의 근거 표가 계약 주석과 다르다(§2 자리 3).

### **Major M-4** — 「죽은 절」 셋. **계약 검증 가드가 이미 막는 것을 서비스가 다시 단언한다**

계약 스키마 제약을 전수로 긁었다(python):
```
s:NonconformanceCreate/properties/lots        -> {'minItems': 1}
s:NonconformanceCreate/properties/description -> {'minLength': 1}
q:DispositionDecisionCreate/properties/decisionQty -> {'exclusiveMinimum': 0}
q:DispositionDecisionCreate/properties/reason      -> {'minLength': 1}
```
그리고 가드의 코드 매핑:
```
src/common/contract/validation-error.mapper.ts:14-27
const RANGE_KEYWORDS = new Set(['minimum','maximum','exclusiveMinimum','exclusiveMaximum',
  'minLength','maxLength','minItems','maxItems','multipleOf']);
… if (keyword === 'required') return ERROR_CODE.REQUIRED;
   if (RANGE_KEYWORDS.has(keyword)) return ERROR_CODE.RANGE; …
```
가드는 `@Contract` 핸들러의 **본문·질의·경로를 서비스보다 먼저** 검증한다(`contract-validation.guard.ts:26-42`).

| 계획안 | 실제 |
|---|---|
| §3-1 2 「`lots` 비었나」 → 400 `RANGE` · **e2e #19**(변이 = 「빈 배열 검사」) | `minItems:1` 이 **가드에서** 400 `RANGE` 를 낸다 ⇒ 서비스 검사를 지워도 **#19 는 초록이다** |
| §3-3 2 「`decisionQty > 0`」 → 400 `RANGE` | `exclusiveMinimum:0` 이 가드에서 막는다 ⇒ 서비스 검사는 죽은 절 |
| §3-3 2 「`dispositionTypeCode ∈ {REWORK,SCRAP,NORMAL}`」 → 400 `INVALID` | 계약 `enum` 이 가드에서 `INVALID` 를 낸다(`codeFor` 기본값) ⇒ 죽은 절 |
| §1-3 「`description`·`reason` 이 **공백만** → 400 `REQUIRED`」 · e2e #23(변이 = trim 삭제) | ⭐ **여기는 살아 있다** — `minLength:1` 은 `" "` 를 통과시킨다. 다만 **빈 문자열 `""` 은 가드가 `RANGE`** 로 내므로 「공백만 → `REQUIRED`」와 「빈 문자열 → `RANGE`」가 **다른 코드**다. 계획안 §1-6 이 둘을 한 줄로 묶었다 |
| §1-3 「`affectedQty` 는 `CHECK (> 0)` → 400 `RANGE`」 · e2e #22 | ⭐ **살아 있다** — `NonconformanceLotCreate.affectedQty` 에는 **제약이 0개**다(`format:double` 뿐). 서비스가 안 막으면 DB CHECK 가 **500** 으로 샌다 |
| §1-3 「`requestedQty >= 1`」 | ⭐ **살아 있다** — `DispositionRequest.requestedQty` 에 `minimum` 이 없다(설명만 「1 이상이어야 한다」) |

계획안 **§3-4 순서 1 이 스스로 이 함정을 금지했다** — 「계약 검증 가드가 서비스보다 «앞»이다 — ⛔ **서비스에서 같은 것을 다시 단언하면 되돌려도 안 깨진다**(I-20 R-19 #3·#9·#24)」. 그래 놓고 §3-1·§3-3 의 단계 2 가 정확히 그 짓을 한다. **README §6-2 전수 변이 점검을 계획 단계에서 미리 친 그물이 세 칸 비어 있다.**
⇒ 세 줄을 §3-1·§3-3 에서 빼고, e2e #19 와 `decisionQty` 시험의 「죽이는 변이」를 **「계약 스키마의 `minItems`/`exclusiveMinimum` 을 지우면」**으로 다시 쓰든지(계약은 읽기 전용이므로 사실상 회귀 잠금 시험이다) 살아 있는 셋(`affectedQty`·`requestedQty`·공백만)으로 그물을 옮겨라. 예산 −6줄.

### **Major M-5** — 단위 혼합 거부가 계약 지침과 반대 방향(§2 자리 2).

### **Minor m-1** — 뒤집기 ③ 의 열 밀림(§1-3).

### **Minor m-2** — **미선언 400 다섯 자리.** 인용한 선례의 반쪽을 안 가져왔다

실측 — 이 슬라이스의 조회 **5건이 200 하나만 선언**한다(`GET /quality/nonconformances`·`/quality/disposition-candidates`·`…/{ncId}/disposition-decisions`·`/quality/disposition-decisions`·`/quality/concessions`). 계획안 §1-1 이 그것을 「⭐ **없다**」로 정확히 적었다. 그런데 같은 문서가 그 다섯에 400 을 셋 얹는다:

| 자리 | 계획안 | 선언된 응답 |
|---|---|---|
| 갈래 A — `openedFrom/To` 부재 | **400 `REQUIRED`**(§1-2 · e2e #1·#2) | 200 **하나** |
| 갈래 B — `decidedFrom/To` 한쪽만 | **400 `PAIR`**(§1-2 · e2e #26) | 200 **하나** |
| 목록 `severityCode` 시드 밖 | **400 `INVALID`**(e2e #6) | 200 **하나** |

계획안이 근거로 든 선례 `I-20.md` §1-2 갈래 C 는 **판정과 흔적을 «함께»** 남겼다:
```
I-20.md:144  … ⭐ 400 `REQUIRED` 로 요구한다(§2 2단계 기준 2) · 400 미선언은 「알려둘 것」·문의 074
I-20.md:700  8 | 기간 「필수」인데 400 미선언 … | 400 REQUIRED 로 요구한다 · 400 미선언은 알려둘 것 | 074
```
I-21 은 판정만 물려받고 **「400 미선언은 알려둘 것」을 안 가져왔다** — §9-3 알려둘 것 ⓐ~ⓘ 9건에 없다. 판정은 유지(선례가 섰다). **한 줄이면 닫힌다.**

### **Minor m-3** — e2e #6(**조회 필터**를 코드값으로 막는다)은 **선례가 0**이다

`assertCodeValues` 전 사용처를 전수로 봤다(grep — 20자리): `mdm/*`·`trace/lot`·`app/access`·`quality/inspection-plan`·`planning/production-plan`·`logistics/*` **전부 쓰기 경로**다. 조회 서비스에서 부르는 자리는 **0건**이다(`work-session-query.service.ts:108` 은 주석 안 언급이지 호출이 아니다).
- **실패 예** — `GET /quality/nonconformances?severityCode=URGENT&openedFrom=…&openedTo=…` → 계획대로면 **400**. 계약은 그 파라미터를 `type:string` · enum 없음으로 열었고 응답에 400 이 없다. 계약에서 만든 클라이언트에는 400 분기가 없어 화면이 목록 대신 알 수 없는 오류를 본다.
- 계약이 「⭐ **고객이 늘릴 수 있다** — 아래는 초기값(기본값)이지 **닫힌 목록이 아니다**」라 적은 축이라(`severityCode` 설명 원문) 필터를 서버가 닫는 것 자체가 계약 의도와 어긋난다.
- ⇒ **쓰기(`POST /quality/nonconformances`)에서만 `assertCodeValues` 를 걸고 조회 필터는 그대로 통과시키는 쪽**을 권한다(안 걸리면 빈 목록). 그러면 m-2 의 세 자리 중 하나가 함께 사라진다.

### **Minor m-4** — `versionNo` 를 **본문에 싣지 마라**

계획안 §1-4: 「`versionNo` | required 밖이나 **판정 #5 의 토큰이라 늘 싣는다**」.
계약이 반대를 적었다 — `GET /quality/nonconformances/{nonconformanceId}` 200 의 `ETag` 헤더 설명:
> 낙관적 잠금 토큰 — 이 행의 `version_no`. 다음 쓰기의 If-Match 에 그대로 담는다. **본문 필드로는 내리지 않는다** — 표시하지 않되 전달한다

코어도 같다:
```
src/common/optimistic-lock/optimistic-lock.ts:11-16
 * ⛔ **본문 필드로 내리지 않는다** — 공유계약 `A-4`(`version_no` 는 화면에 노출하지 않는다).
 *   그래서 응답 본문에서 도출할 수 없고 핸들러가 명시로 싣는다. 계약도 그렇게 적었다: 「표시하지 않되 전달한다」.
```
`Nonconformance.versionNo`·`Concession.versionNo` 가 스키마에 «있으므로» 실어도 위반은 아니지만, **저장소 전 도메인 관행과 반대**다(`versionNo` 를 본문에 싣는 뷰가 0건 — grep 전수. 전부 `setEtag(response, versionNo)` 로만 나간다). ⇒ §1-4 의 그 줄을 빼고 e2e #13 의 ETag 단언만 남겨라. 「늘 싣는다」로 가면 `Concession`·`Nonconformance` 두 목록이 A-4 를 어기는 첫 자리가 된다.

### **Minor m-5** — `moveWithin(… { transitionCode })` 는 **죽은 인자**다

§3-3 7단계가 `moveWithin(tx, lots, action, { …, transitionCode: 'C17'|'C18'|'C19', … })` 를 넘기는데, §6-2 표가 **같은 코드를 전이표 행에 박는다**. 코어는 표를 먼저 본다:
```
src/core/lot/lot-quality-status.service.ts:61
  const transitionCode = transition.transitionCode ?? ctx.transitionCode;
```
그리고 `LotQualityMoveContext.transitionCode` 의 주석이 그 뜻을 못 박았다 — 「**전이표에 코드가 없는 자리(재등록)만 채운다** — 설계 미정 · 문의 089(발행 예정)」(`:28-30`).
⇒ ctx 인자를 지워도 **아무 시험도 안 깨진다.** e2e #31·#32·#33 이 `transition_code='C17'|'C18'|'C19'` 를 단언하지만 그 값은 전이표에서 온다. §3-3 에서 그 줄을 빼라(−3줄). 남겨 두면 다음 사람이 「값이 두 곳에 있다」로 읽는다.

### **Minor m-6** — 409 봉투 둘 다 `code` **required** 인데, 멱등 재생 두 갈래가 `code` 없이 던진다

```
src/common/idempotency/idempotency.service.ts:113  throw new ConflictException('user', '같은 요청 키로 다른 내용이 왔습니다. 새 키로 보내세요.');
src/common/idempotency/idempotency.service.ts:120  throw new ConflictException('workerLease', '같은 요청이 처리 중입니다. 잠시 뒤 다시 확인하세요.');
```
`ConflictException(cause, message)` 는 `{conflictCause, message}` 만 낸다 — **`code` 가 없다.** 이 슬라이스 쓰기 3건의 409 는 `ShipmentConflictResponse`(required `code`·`message`) 또는 `QualityConflictResponse`(같음)다.
- **실패 예** — 같은 `Idempotency-Key` 로 **다른 본문**을 보내면 409 `{conflictCause:'user', message:'…'}` → `ShipmentConflictResponse` 의 `required: ['code','message']` 위반. e2e 가 그 409 를 ajv 로 재면 빨개진다.
- 선행 슬라이스부터 있던 구멍이라 이 계획의 결함은 아니다. 다만 **e2e #27(멱등 재전송)이 그 경로를 건드리므로** 계획안 §8-2 에 「다른 본문 재전송」 갈래를 넣을지, 알려둘 것으로 남길지 한 줄이 필요하다.

### **Minor m-7** — 페이지 기본값이 계약 안에서 비대칭인데 §1-2 에 그 줄이 없다

| 오퍼레이션 | `page` | `size` |
|---|---|---|
| `GET /quality/disposition-candidates` | **스키마 `default: 1`** | **스키마 `default: 50`** |
| 나머지 넷 | 스키마 default **없음**(설명에 「1 부터」) | 스키마 default **없음**(설명에 「기본 50」) |

그리고 검증기는 **기본값을 채우지 않는다** — `new Ajv2020({ strict:false, allErrors:true, coerceTypes })` 에 `useDefaults` 가 없다(`contract-validator.ts:46-52`). ⇒ 서버가 손으로 채운다. §1-2 질의 칸 표에 페이지 기본값이 한 줄도 없고, `…/{ncId}/disposition-decisions` 의 `{page:1, size:total, total:total}` 판정만 있다(`total=0` 이면 `size:0` — `PageMeta` 에 하한이 없어 합법이지만 형제 목록과 모양이 다르다).

### **Nit n-1** — 계약 안 모순 하나(계획안 결론은 맞다)

`DispositionDecisionCreate.dispositionTypeCode` 설명: 「✅ **값 목록 확정 2026-09-01**(사용자 · `omf-mes#336`) — `REWORK`·`SCRAP`·`NORMAL` 셋이다」.
같은 오퍼레이션 `x-internal-note`: 「⚠ **`disposition_type_code` 값 목록은 미확정이다** — 2차 값 목록 제안안 대상」.
⇒ 스키마 `enum` 이 이겨 계획안 판정(코드 상수 검증 · 시드 그룹 안 만듦)이 맞다. **R-24 형 「정정된 문장이 남아 있는 자리」**이므로 알려둘 것에 한 줄 남길 값이 있다.

### **Nit n-2** — 계획안이 인용한 계약 줄은 **전건 정확**했다

`quality-03품질.json:2460`(판정 저장 description) ✓ · `:4472`(`LotStatusTransitionSet.note` — 「불량(Hold)은 발신 전이가 0」) ✓ · `logistics-01자재창고.json:11970`(`LotStatusHistoryEvent`) ✓ · `plan-api.md:871` ✓ · `plan-uiux.md:609`·`:1230`·`:1231` ✓ · `plan-integration.md:185` ✓(줄은 맞고 **읽기가 틀렸다** — m-1). `plan-integration.md:389` 만 ±3행 표류(실제 `:392`).
계약 실측 숫자도 전건 맞았다 — 오퍼레이션 27/21, 대상 6+5=11, `NonconformanceCreate` 4/7, `NonconformanceLotCreate` 3/3, `DispositionRequest` 2/3, `Nonconformance` 12/21, `NonconformanceLot` 6/7, `DispositionCandidate` 7/18, `DispositionDecisionCreate` 4/4, `DispositionDecision` 10/18, `DispositionRemainingSummary` 4/4, `Concession` 10/20, `ShipmentConflictResponse` 5값, `QualityConflictResponse` 6값, 질의 칸 10/10/0/11/8, `derived-permissions` 10/11(`GET /quality/concessions/{concessionId}` 만 없음). **누락 0 · 여분 0.**

---

## 5. PR 분할·줄수 예산(§10) — 판정

**판정: 「9 로 쪼갠다」는 방향은 옳고, 예산 ≈1,911 은 «지금 숫자로는» 현실적이지 않다.** 아래 셋이 더해진다.

| 자리 | 예산 영향 |
|---|---|
| **PR ③**(후보 · 229) | ⛔ **Blocker B-1 로 통째로 다시 그린다.** `is_defect` 축이면 UNION 두 갈래는 그대로지만 `JOIN LATERAL` 접기·`count(DISTINCT warehouse_id)=1` 필터가 사라지고 `inventory_balance × warehouse WHERE is_defect` 조인이 들어온다. 계획안 자신이 「±80」이라 적었다 ⇒ **≤280 예산 안에는 들지만 원시 SQL 을 다시 설계해야 하므로 R-n 확정 전에는 스폰 불가** |
| **PR ⑦**(심장 B · 248) | **M-2** — `runVersioned` 대체 배선(+10~15) 또는 `master-write.ts` 수정(공용 코어 · 별도 커밋 · §11-4 보고 +1건). ≤300 안 |
| **PR ①·②a·⑤** | **M-1**(널 정책)이 뷰 셋에 각각 몇 줄. ±0~10 · 예산 안 |
| **PR ⑥·⑦** | **M-4** 로 **−6줄**(죽은 절 셋 삭제) |

- ⭐ **①(부적합 조회 2건)을 3관점 재수립과 나란히 스폰해도 되는가 — API 관점에서 «조건부 아니오»다.** 계획안 §10 이 「① 은 나란히 스폰할 수 있다(README §6-1 ③ — 마이그 0 · 코어 0 · 순수 조회)」라 적었는데, **M-1(널 정책)이 `nonconformance-view.ts` 를 정면으로 겨눈다**(`Nonconformance` 의 널 불가 선택 칸이 7개로 이 슬라이스에서 가장 많다). 나란히 띄우면 그 PR 리뷰에서 고치게 되는데, 같은 수정이 ②a·⑤ 로 세 번 반복된다. **재수립 R-n 이 널 정책 한 줄을 먼저 정하는 편이 싸다.**
- **M-h(마이그) 는 그대로 둘 수 있다** — 두 항목(code_value 3 · `ix_disposition_decision_nonconformance`) 어느 쪽도 B-1 에 안 걸린다. `is_defect` 는 이미 서 있어 **마이그가 늘지 않는다**(B-1 이 예산을 늘리지 않는 유일한 좋은 소식이다).
- **④(코어 · 28줄 ≤60)** — 조건 ①(`sourceOperation` 명시)만 붙이면 그대로 선다. 계획안이 「B·C 와 매번 충돌하는 자리라 단독으로 뜨고 먼저 병합」이라 한 판정은 `document-state.spec.ts:423` `toHaveLength(41)` 실측과 맞다.
- **합계** — 위를 반영하면 비테스트 ≈1,915~1,930. **전건 350 이하 · 코어 60 이하**는 유지된다. ⇒ **PR 수 9 는 유지, ③ 만 R-n 뒤로 미룬다.**

---

## 6. 통보 후보 (번호 없음 · 레인 A 대역 소진)

| 제목(안) | 한 줄 요지 | 왜 번호가 필요한가 |
|---|---|---|
| **`GET /quality/disposition-candidates` 의 모집단은 `warehouse.is_defect` 축이다 — 우리 계획서가 「칸이 없다」로 잘못 읽었다** | 계약이 `GET /mdm/warehouses?isDefect=true` 를 직접 가리키고 `mdm.warehouse.is_defect` 는 `20260828000000` 로 이미 섰다. 「잔액 창고 둘이면 목록에서 뺀다」는 계획을 철회한다 | 설계팀에 보내는 통보 089 §6 이 「창고 축으로 못 만든다」를 전제로 쓰여 있어 **그대로 나가면 설계팀이 없는 결손을 메우려 한다.** 089 발행 전이면 089 본문 수정으로 흡수 가능 |
| **`is_defect` 가 백필 없이 `DEFAULT false` 라 오늘 운영 DB 에서 후보 목록이 빈다** | 마이그 주석이 「운영에서 해당 창고를 켠다」로 남겼다 — 마스터 설정 없이는 `W-04-07` 진입 목록이 0행이다 | 배포 노트·현장 설정 항목. 서버 결함이 아님을 못 박아야 한다 |
| **처분 후속 롤업 — 계약 자기 주석은 「폐기도 건별로 못 센다」다** | `DispositionDecision.x-internal-note` 가 후속 전표를 폐기=`goods_issue`·정상=`stock_transfer`·재작업=`production_result` 로 적고 셋 다 「LOT 축까지만」이라 했다. 우리는 폐기 하나를 세기로 «정했다» | 통보 089 §4 의 표가 계약과 다른 사실(정상=`stock_reinstatement` 표 없음 · 재작업=`work_order`)을 설계팀에 보낸다. 정정 없이 나가면 회신이 엉뚱한 표를 겨눈다 |
| **단위가 섞인 부적합 — 계약은 「합치지 마라」인데 우리는 「받지 마라」로 정했다** | `DispositionRemainingSummary.x-internal-note`(A-11 보강)가 지침을 적었다. 우리는 등록에서 400 `INVALID` 로 막는다 | README §2 3단계 흔적. 계약 지침을 «알고» 다른 쪽을 골랐음을 남겨야 한다 |
| **조회 다섯 건이 400 을 선언하지 않았는데 서버가 400 을 낸다** | 갈래 A `REQUIRED` · 갈래 B `PAIR`(+ 조회 코드값 검증을 남긴다면 `INVALID`). I-20 문의 074 와 같은 모양이고 대상만 다르다 | 074 와 묶어 보내면 「계약이 기간을 필수라 «설명»하고 `required`·400 을 안 적는 패턴」이 두 도메인에서 반복된다는 것을 보일 수 있다 |
| **`Concession.usable` — 계약은 3항, 우리는 4항이다** | `valid_from <= 기준일` 을 더했다. 미래 시작 특채의 답이 계약과 갈린다 | 통보 089 §2 가 3항 문장을 인용하며 4항 식을 싣고 있어 그대로면 우리가 계약대로 했다고 읽힌다 |
| **`code` 없는 409 — 멱등 재생 두 갈래가 `*ConflictResponse.required` 를 어긴다** | `idempotency.service.ts:113`·`:120`. 두 봉투 다 `code` required | 코어 공용 결함이고 03·04 계약을 쓰는 전 슬라이스에 걸린다. 레인 A 단독으로 못 고친다 |
| **계약 안 모순 — `disposition_type_code` 「값 목록 확정」 ↔ 같은 오퍼레이션 주석 「미확정」** | 스키마 enum 3값이 정본이라 보고 구현한다 | 정정된 문장이 남은 자리(R-24 재발 경로). 설계팀이 지우면 다음 슬라이스가 안 헤맨다 |
| **`POST …/disposition-decisions` 는 7계약 유일의 201+If-Match 필수다** | 공용 골격 `runVersioned` 가 200 고정이라 배선이 하나만 다르다 | 계약 쪽 결정은 아니지만 **레인 A 가 공용 코어를 건드릴지**의 사용자 보고 항목(§11-4)에 한 줄이 는다 |

---

## 7. 미수행 — 「PASS 로 적지 않는다」

- **게이트 일절 안 돌렸다** — `tsc`·`jest`(단위·e2e)·lint·`contracts:check` **전부 미수행**(브리프 §5). M-1·M-4 의 「빨개진다」·「초록이다」는 **계약·코드를 읽어 도출한 예측**이다.
- **DB 관측 0** — 계획안 실측 부록의 시드 값(#34~#39)·마이그 grep(#29·#46)은 **재측정하지 않았다.** 단 **#27(`mdm.warehouse` 칸)만은 내 판정이 뒤집으므로 재측정했다**(브리프 규칙대로) — `schema.prisma`·마이그레이션 파일·`git log main`·`src/mdm/logistics/*` 넷으로 교차 확인.
- **UI/UX·통합 관점 미판정** — `plan-uiux.md`·`plan-integration.md` 는 **I-21 관련 줄만** 열었다(`:185`·`:161-163`·`:387-392` · `:609`·`:1230`·`:1231` 은 미열람). 화면 정본(`W-03-09`·`W-03-10`·`W-04-07`·`W-04-10`·`W-04-11`·`P-04-03`)·`lanes.md`·`plan.md` §5 는 **읽지 않았다.** ⇒ **§8 e2e 85건의 픽스처 타당성·§11 인계·모델 배분·레인 충돌 처리에 대한 판정 없음.**
- **커버리지 399 → 410 미검증** — `assignment.tsv` 의 I-21 11행과 계약 실물 11건이 맞는 것만 확인했다(누락 0 · 여분 0). 399 라는 기준값은 안 셌다.
- **§8 의 「죽이는 변이」 85건 전수 검증은 안 했다** — 표본 여섯(#1·#6·#19·#22·#31·#33 + §8-4 #3)만 계약·코드로 성립 여부를 쟀고 그중 **넷이 안 성립**했다(M-4 셋 + §1-5 의 `valid_from`).

---

## 8. 내가 실제로 연 파일 · 돌린 명령

**계약(python 파싱 · 읽기 전용)**
`contracts/quality-03품질.json`(23 path / 27 op · 대상 6 · `POST …/disposition-decisions` description+x-internal-note 전문 · `DispositionDecisionCreate`·`DispositionDecision`·`DispositionRemainingSummary`·`QualityConflictResponse`·`Concession`·`LotStatusTransitionSet`·`PageMeta`·`ErrorItem`·`ErrorResponse` 전문 · `GET /quality/lot-status-transitions` 전문 · `:2460`·`:4472` 원문) ·
`contracts/shipment-04제품출하.json`(18 path / 21 op · 대상 5 · `NonconformanceCreate`·`NonconformanceLotCreate`·`DispositionRequest`·`Nonconformance`·`NonconformanceLot`·`DispositionCandidate`·`ShipmentConflictResponse` 전문 · `IdempotencyKey`·`IfMatchVersion`·`IfMatchVersionOptional`·`WorkerNo`) ·
`contracts/logistics-01자재창고.json`(`LotStatusHistoryEvent.transitionCode` enum · `GET /trace/lot-status-events` 질의 enum) ·
`contracts/mdm-기준정보.json`(`Warehouse.isDefect`·`WarehouseCreate`·`WarehouseUpdate` · `GET /mdm/warehouses?isDefect`) · `contracts/COMMIT.txt`

**돌린 것**(전부 읽기 · DB·게이트·`gh`·`pnpm exec` 0)
- 11 오퍼레이션의 `parameters`(path-item + operation 합산)·`requestBody`·`responses`·`headers` 전수 덤프
- 두 파일 `components.schemas` 의 **선택 칸 널 허용 여부** 전수(`type` 배열에 `"null"`) — M-1 의 표
- 두 파일 관련 스키마의 **제약 키워드 전수**(`minItems`·`minLength`·`exclusiveMinimum`·`maxLength`·`default`·`pattern`…) — M-4 의 표
- 7계약 전수 — `C\d+` 형 enum 이 있는 자리(2건) · **201 + `IfMatchVersion`(필수) 오퍼레이션**(1건) · `isDefect` 출현
- `awk`/`grep`: `plan-integration.md:161`(범례)·`:163`(표 머리)·`:180-196` · `plan-api.md:495-545`·`:840-900` · `plan.md` §4 전문·`:22`·`:52`·`:128`

**소스·물리·시험**
`src/common/contract/{contract-validation.guard.ts, validation-error.mapper.ts, contract-validator.ts:1-140, contract-coverage.spec.ts:20-40}` ·
`src/common/optimistic-lock/{optimistic-lock.ts, optimistic-lock.guard.ts}` · `src/common/master/master-write.ts:1-80` ·
`src/common/idempotency/idempotency.service.ts:55-135` · `src/common/errors/conflict.exception.ts` ·
`src/common/permissions/{derived-permissions.ts(grep 11건), manual-permissions.ts(grep), operation-permissions.spec.ts:40-70}` ·
`src/core/document-state/transitions.ts:1-40·190-225` · `src/core/lot/lot-quality-status.service.ts:1-100` ·
`src/quality/lot-status/lot-status-transition.service.ts`(전문) ·
`grep -rn "runVersioned|runIdempotent.*CREATED|assertCodeValues|versionNo|conflictCause|is_defect" src/` ·
`prisma/schema.prisma`(`nonconformance` 3423-3485 · `nonconformance_lot` · `disposition_decision` 3196-3220 · `concession` 3085-3125 · `warehouse` 2298-2328 · `stock_transfer` 1424-1452) ·
`prisma/migrations/20260828000000_add_warehouse_is_defect/migration.sql`(전문) · `prisma/seed.ts:210-235` ·
`test/quality-lot-hold.e2e-spec.ts:1-110`(ajv 응답 검증 규약) · `test/quality-lot-status.e2e-spec.ts`(grep — `toHaveLength(4)` 두 자리) · `ls test/quality-*.e2e-spec.ts`(8파일) ·
`git log --oneline main -- prisma/migrations/20260828000000_add_warehouse_is_defect`(`de85fab`) · `git show --stat HEAD`

**문서**
`docs/coverage-100/README.md`(전문) · `docs/coverage-100/slices/I-21.md`(901줄 전문) · `docs/design-inquiries/089-…md`(전문) ·
`docs/coverage-100/slices/I-18-review-api.md`(전문 · 형식 본보기) · `docs/coverage-100/slices/I-20.md`(§1-2 갈래·§9 판정표·부록 — grep 발췌) ·
`docs/coverage-100/plan-api.md`(§S19·§S20·§5.1-E) · `docs/coverage-100/plan.md`(§0 11행·§1 17행·§4 전문) · `docs/coverage-100/plan-integration.md`(§ 표 범례·머리·I-21 행·I-21 절)

---

## 9. 한 줄 결론

**계약 대조는 대부분 정확하다 — 11 오퍼레이션의 질의 칸·본문 required·응답 스키마·409 봉투 둘·멱등/If-Match/ETag/403 이 전건 실측과 맞고 새 `ERROR_CODE` 0건도 참이다. 뒤집기 둘(①②)은 확인 도장이고, `C17`~`C19` 는 계약 enum 이 닫힌 자리가 정확히 둘뿐이라 새는 곳이 하나임을 실측으로 확인해 채택한다. 그러나 뒤집기 ③ 은 통합 계획서의 열을 하나 밀려 읽은 것이고(넷이 다 「마이그 0」이다), 무엇보다 ⭐ 「리뷰가 반드시 볼 자리」 넷째 「`mdm.warehouse` 에 불량창고 칸이 0개」가 사실이 아니다 — `is_defect` 는 계약(`x-source-column`)·물리(`20260828000000`)·소스(`warehouse.service.ts`)·시드 주석 넷에서 실재하고 `main` 에 병합돼 있어, 후보 목록의 모집단·「창고 둘이면 뺀다」·PR ③ 원시 SQL·픽스처 L4·e2e 두 건이 전부 다시 서야 한다(I-20 R-24 와 같은 «baseline 만 읽은» 사고의 네 번째). 그다음이 응답 널 정책 — 계약이 널을 못 받는 선택 칸이 25개인데 계획서가 널 정책을 적은 유일한 자리가 하필 계약이 널을 «허용한» 유일한 스키마다.**

**Blocker 1 · Major 5 · Minor 7 · Nit 2 · 채택 5 · 반증 4 · 유지 1.**
