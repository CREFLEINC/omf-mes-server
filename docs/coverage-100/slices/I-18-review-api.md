# I-18 독립 리뷰 — **API 설계 관점**

> 대상: `.backend-dev/lane-a2/I-18-draft.md`(499행 전문) · 브리프 `.backend-dev/lane-a2/brief-I-18-review.md` §3 「API 설계 관점」.
> 계약 `contracts/logistics-01자재창고.json`(읽기 전용 · `contracts/COMMIT.txt` = **a6a87e144116ebaa32c01df5a12a0fd2924427e7**)를 **python 으로 직접 파싱**해 초안 §1 실측표와 대조했다.
> ⛔ `I-18-review-uiux.md`·`I-18-review-integration.md` 는 **열지 않았다**. ⛔ 코드·계약·문서 수정 0 · DB 접근 0 · `gh`/`git` 쓰기 0 · `pnpm exec` 0 · 게이트 재실행 0.
> 심각도: CREFLE `pr-review` 4단계(Blocker/Major/Minor/Nit).

---

## ① 무엇을 직접 읽었나

### 계약 (직접 파싱 · 인용 줄 전건 재확인)

| 대상 | 확인 |
|---|---|
| 파일 전체 | path **67** · 오퍼레이션 **90** · I-18 대상 **5** — 초안 §0 「오퍼레이션 5/5 대조」와 **일치**(누락 0 · 여분 0) |
| `GET /trace/lot-status-events` | `:6331`(path) / `:6332`(get) · 질의 4(`occurredFrom`·`occurredTo` **required** `:6342`·`:6352` · `lotId`·`transitionCode` 선택 · enum 9값 `:6373-6383`) · responses **`200` 하나** |
| `GET /trace/lots/{lotId}/external-identifiers` | `:6190` · 질의 0 · responses **`200` 하나** · `LotExternalIdentifierListResponse` |
| `PUT /trace/lots/{lotId}/external-identifiers` | `:6209` · description `:6214`(부모 ETag 문장 **원문 그대로 확인**) · params = `IdempotencyKey`+`IfMatchVersion` `:6217`·`:6220` · responses **200·400·403·409**(200 에 `headers` **없음** · **404 없음**) |
| `GET /trace/lots/{lotId}/holds` | `:6300` · `activeOnly` default **true** `:6312` · 설명 「해제되지 않은 것만」 `:6314` · responses **`200` 하나** |
| `POST /trace/lots/{lotId}:request-iqc-skip` | `:6503`(post) · summary `:6507` · description `:6508`(원문 확인) · params `:6511`·`:6514` = `IdempotencyKey`+`WorkerNo`(**If-Match 없음**) · responses **202·400·403·409**(**404 없음**) · `x-internal-note` `:6569` |
| `components.parameters` | `IdempotencyKey` `:6869` · `IfMatchVersion` `:6880`(required **true**) · `WorkerNo` `:6899`(required **true** · ⭐ 설명에 **「없으면 서버가 거부한다」** 원문) |
| `components.schemas` | `LotExternalIdentifier` `:11680` · `…ListResponse` `:11747` · `…Upsert` `:11761` · `LotHold` `:11814` · `LotHoldListResponse` `:11956` · `LotStatusHistoryEvent` `:11970` · `ApprovalRequestCreate` `:6925` · `ApprovalRequestRef` `:6941` · `LotDetailResponse` `:11654` · `ErrorItem`·`ErrorResponse`·`ConflictResponse` |
| `GET /trace/lots/{lotId}` | 200 에 **`ETag` 헤더 선언 실재** · responses **200·404** |

### 코드·물리 (초안이 인용한 자리를 전부 열어 확인)

`src/trace/lot/lot-complete.service.ts`(40·65-73·116-122·159-168) · `lot.controller.ts`(전문 108행) · `lot.service.ts`(125-160·271-278·281-288) · `lot-view.ts`(95-159) · `lot-lifecycle-event.controller.ts`(전문 21행) · `lot-lifecycle-event.service.ts`(전문 57행) · `lot-lifecycle-event-view.ts`(전문 30행) · `lot-rules.ts`(35-75·125-129) ·
`src/logistics/goods-issue/goods-issue-update.service.ts`(36-95·130-215·268-282) · `goods-issue.controller.ts`(100-160) · `src/logistics/purchase-order/purchase-order.service.ts`(285-355) ·
`src/quality/lot-hold/lot-hold-view.ts`(40-63) · `lot-hold-query.service.ts`(35-90) ·
`src/core/approval/approval.service.ts`(55-135·185-232) · `src/core/lot/lot-registry.service.ts`(14-30·80-106) · `lot-quality-status.service.ts`(1-100) · `src/core/document-state/transitions.ts`(192-220) ·
`src/common/errors/error-codes.ts`(전문) · `error.filter.ts`(존재 확인) · `src/common/master/master-write.ts`(1-58) · `src/common/optimistic-lock/optimistic-lock.ts`(56-68) · `src/common/contract/contract-validator.ts`(88-100·200-212) · `src/common/permissions/{permission.guard.ts(30-60), derived-permissions.ts(250-265), manual-permissions.ts(1-30·78-92), operation-permissions.spec.ts(25-64)}` ·
`prisma/schema.prisma`(`lot` 3522- · `lot_external_identifier` 3601- · `lot_hold` 3617- · `lot_status_event` 4634-) · `prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:1078-1090` · `…/20260901030000_align_lot_status_event/migration.sql:58-80` ·
`test/trace-lot.e2e-spec.ts`(25-60) · `test/approval-request.fixture.ts`(1-40) · `test/app-approval-request.e2e-spec.ts`(60-70·200-210) · `docs/coverage-100/assignment.tsv`(I-18 5행) · `ls docs/design-inquiries/`(111파일 · `1[5-7][0-9]` **0건**).

---

## ② §0 다섯 자리 판정

| # | 자리 | **판정** |
|:-:|---|---|
| 1 | `:request-iqc-skip` 자격 축 | **조건부** — 축 둘은 PASS · **ⓐ 의 에러코드는 뒤집는다** |
| 2 | `X-Worker-No` 부재 400 | **PASS**(근거는 초안보다 강하다) |
| 3 | `PUT …/external-identifiers` 넷 | **조건부** — ⓐⓑⓒ PASS · **ⓓ 조건부** |
| 4 | `GET …/{lotId}/holds` 의 뷰 | **PASS** |
| 5 | PR 2 · 파일 배치 | **조건부**(API 관점 한정) — 배치는 PASS · e2e 권한 한 줄이 빠졌다 |

### 자리 1 — 자격 판정 축 · **조건부**

**PASS 인 부분.** ⓐ `source_type_code='INBOUND_RECEIPT_LINE'` + ⓑ `status_code='INSPECTION_PENDING'` 둘 다 보는 것은 옳다.
- 계약 `:6508` 원문 「**입하돼 수입검사 대기인** LOT 에 대해」는 **두 사실**이고, 위반 응답을 한 줄도 안 적은 것도 사실이다(responses 202·400·403·409 · 400 은 `ErrorResponse` 뿐).
- ⓐ 의 값이 실재한다 — `src/core/lot/lot-registry.service.ts:25` `const INBOUND_RECEIPT_LINE = 'INBOUND_RECEIPT_LINE'`.
- ⓑ 의 값도 실재한다 — 같은 파일 `:23` `export const INITIAL_LOT_STATUS = 'INSPECTION_PENDING'`, `:87` 이 그 값으로 LOT 을 세운다.
- ⓒ 제외(열린 보류를 안 본다)도 옳다 — 계약 어디에도 보류 조건이 없고, `lot-registry.service.ts:96-104` 가 등록 즉시 `INCOMING_INSPECTION_WAIT` 를 걸므로 ⓒ 를 더해도 정보가 늘지 않는다.
- ⚠ 다만 초안이 못 본 것 하나 — `lot-registry.service.ts:87` 은 **선발행 생산 LOT 도** `INSPECTION_PENDING` 으로 세운다. 즉 ⓑ 만으로는 생산 LOT 을 못 거른다. 두 축이 **독립으로** 필요하다는 초안의 결론은 그래서 맞고, e2e 21 이 둘을 따로 반증하는 설계도 맞다(§7-2 #21 PASS).

**뒤집는 부분 — ⓐ 의 에러코드는 `STATE_LOCKED` 가 아니라 `INVALID` 다.**
초안이 근거로 든 바로 그 선례가 **두 축을 다른 코드로 가른다**:

```
src/trace/lot/lot-complete.service.ts:66-69
  // 계약이 ⌜**생산** LOT 을 완료로 옮긴다⌝ 라 적었다 — 자재·재생재 LOT 은 대상이 아니다.
  if (locked.source_type_code !== WORK_ORDER_LOT_SOURCE) {
    throw one(field('lotId', ERROR_CODE.INVALID, '생산 LOT 만 완료할 수 있습니다.'));
  }
src/trace/lot/lot-complete.service.ts:71-73
  if (locked.completed_at !== null) {
    throw one(field('lotId', ERROR_CODE.STATE_LOCKED, '이미 완료된 LOT 입니다.'));
  }
```

`source_type_code`(자원의 **종류** — 영원히 안 바뀐다) → `INVALID`, 상태(`completed_at`) → `STATE_LOCKED`. `error-codes.ts` 머리도 같은 뜻을 못 박았다 — 「`STATE_LOCKED` 는 **확정·전기 상태라 수정이 잠긴 것**」(계약 `ErrorItem.code` 설명 원문도 동일). 생산 LOT 에 IQC 생략을 상신하는 것은 「잠긴 상태」가 아니라 **애초에 대상이 아닌 자원**이다.
초안은 「`:complete` 의 거울」이라 적고도 거울의 코드를 안 가져왔다(§0 #1 · §1-6 · §3-1 4ⓑ · §8-1 #1 · 통보 150 전부 `STATE_LOCKED` 하나).

- **실패 예** — `POST /api/trace/lots/{생산LOT}:request-iqc-skip` → 초안대로면 `400 {code:'STATE_LOCKED'}`. 같은 자원 형제 `:complete` 는 완전히 같은 조건(원천 유형 불일치)에 `400 {code:'INVALID'}` 를 낸다. 화면 `M-01-13` 이 계약 `ErrorItem.code` 설명대로 `STATE_LOCKED` 를 「지금은 잠겼다 = 나중에 다시」로 읽으면, **영원히 자격이 없는 LOT 에 재시도 UI 를 띄운다.**
- **뒤집혔을 때** — e2e 21 의 첫 단언이 `STATE_LOCKED`→`INVALID` 로 바뀐다(줄 수 동일). 통보 150 본문 한 문장 수정. PR ② 예산 변화 **0**. 되돌리는 비용은 지금 0, 클라이언트 출하 뒤엔 계약 재협상이다 ⇒ **Major**.

**부수 — 초안이 든 두 번째 선례의 인용이 틀렸다.** §0 #1 이 `goods-issue-update.service.ts:82-83` 을 「계약이 상태 조건을 안 적은 `:request-approval` 을 「무의미하므로 막는다」」로 인용했는데, `:82-83` 은 **`replaceLines` 안의 「승인 대기 중에는 라인 수정을 막는다」** 다. 초안이 말하려던 문장은 **`:194-195`** 에 있다:
> `// ⚠ 계약이 :request-approval 에 상태 조건을 «안 적었다» — 전기된 전표의 상신은` / `//   무의미하므로 막는다(§2 2단계 기준 2 「거부하는 쪽」 · I-4.md §8-1 ⓖ).`

선례는 **실재하고 판정을 지지한다** — 줄만 틀렸다(Minor · §③ m-3).

### 자리 2 — `X-Worker-No` 부재 400 `REQUIRED` · **PASS**

전건 확인:
- 계약 `components/parameters/WorkerNo`(`:6899`) `required: true` ✓.
- ⭐ **초안이 안 쓴, 더 강한 근거가 계약 본문에 있다** — 그 파라미터 설명 원문: 「현장 단말·모바일은 계정 로그인이 없어 서버가 행위자를 풀 근거가 이 헤더뿐이다. **없으면 서버가 거부한다**.」 초안은 「계약 `required:true` + 형제 선례」로만 세웠는데, 계약이 **거부를 직접 명령**한다. 판정은 그대로 서고 근거가 한 단계 단단해진다.
- 가드가 안 본다는 것도 사실 — `contract-validator.ts:96-99` 「$ref 파라미터는 전부 공통 헤더다 … 헤더는 이 검증기가 다루지 않으므로 가리키는 곳을 풀어 `in` 만 본다」 ✓ 초안 인용 줄 **정확**.
- 형제 `assertWorkerNo` 실재 — `lot-complete.service.ts:164-168`, 400 `REQUIRED` · field `'X-Worker-No'` ✓(초안 `:160-168` 은 doc 주석 포함 · 정확).
- `error-codes.ts` 에 `REQUIRED` 실재 ✓.

⇒ **PASS.** 규칙 9 목록의 열한째로 올리는 판단도 API 관점에서 반대할 근거가 없다.

### 자리 3 — PUT 넷 · **조건부**(ⓐⓑⓒ PASS · ⓓ 조건부)

**ⓐ 토큰 = `trace.lot.version_no` — PASS.** 계약 `:6214` 원문이 초안 인용과 **한 글자도 다르지 않다**. 게다가 그 토큰을 실제로 내리는 자리도 확인했다 — `GET /trace/lots/{lotId}` 200 이 **`ETag` 헤더를 선언**하고(「낙관적 잠금 토큰 — 이 행의 version_no」), `lot.controller.ts:52` 가 `setEtag(response, versionNo)` 로 실제로 내린다. 고리가 끊긴 데가 없다.

**ⓑ 부모 `version_no` 를 올린다 — PASS.** 선례 인용 **정확**:
```
src/logistics/goods-issue/goods-issue-update.service.ts:46-47
 * ⛔ 응답에 ETag 가 없다(계약 미선언). 그래도 부모 `version_no` 는 «올린다» — 라인이
 *   바뀌면 부모 상세의 내용이 바뀐다. 다음 If-Match 는 상세 GET 이 준다(I-4.md §6-3).
```
반대편 선례(`:161-166` 「202 에 ETag 가 없어 … 올리면 다음 쓰기가 영원히 409 다」)도 **정확**하고, 초안이 둘을 가른 축(**200 이 본문을 바꾸는 치환** vs **202 상신**)이 옳다. `lot.service.ts:146` 이 `externalIdentifiers` 를 `LotDetailResponse` 본문에 싣는 것도 확인 ✓ ⇒ 부모 상세의 내용이 실제로 바뀐다.

**ⓒ 전삭제+전삽입 — PASS.** `LotExternalIdentifierUpsert` required **2** · 프로퍼티 **4** · **id 칸 없음** ✓. 「요청에서 빠진 기존 행은 삭제한다」 원문 ✓. `schema.prisma` 에서 `lot_external_identifier` 를 **참조하는 자식 0** 확인(역관계는 `lot`·`partner` 쪽 `lot_external_identifier[]` 둘뿐 — 부모 방향) ⇒ `deleteMany` 가 아무것도 고아로 만들지 않는다 ✓.

**ⓓ 요청 안 중복 400 `UNIQUE_VIOLATION` — 조건부.** 유일 인덱스 인용은 **완벽하다**:
```
prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:1082-1089
CREATE UNIQUE INDEX uq_lot_external_identifier
ON trace.lot_external_identifier (
    lot_id, identifier_type_code, COALESCE(partner_id, 0),
    COALESCE(external_system_code, ''), external_identifier );
```
손으로 앞당겨 막아야 한다는 결론도 옳다. **조건을 다는 이유 둘**:

1. **코드 선택을 안 따졌다.** 이 저장소는 「요청 안 중복」에 **두 관행이 공존**한다 — 치환 계열은 `INVALID`(`goods-issue-update.service.ts:274` 「같은 라인을 두 번 실었습니다」 · `purchase-order.service.ts:342-350` 같은 문장), 배열 키 중복 계열은 `UNIQUE_VIOLATION`(`planning/production-order/acknowledge.service.ts:59`). **치환 PUT 이라는 형태로는 `INVALID` 쪽이 형제**인데 초안은 그 갈래를 열지도 않고 `UNIQUE_VIOLATION` 을 골랐다.
2. **`UNIQUE_VIOLATION` 을 고른다면 `uniqueScope` 를 빼면 안 된다.** 계약 `ErrorItem.uniqueScope` 가 「code=UNIQUE_VIOLATION 일 때 어느 유일키 범위에서 중복인지(공유계약 **A-1**)」로 실재하고, **같은 디렉터리의 헬퍼가 이미 그렇게 쓴다**:
   `src/trace/lot/lot-rules.ts:53-61 duplicateLotNo()` → `uniqueScope: ['plantId','lotNo']`.
   초안은 §1-6·§3-2·§7-2 #17 어디에도 `uniqueScope` 를 안 적었다.
   - **실패 예** — `PUT …/external-identifiers` 에 `identifierTypeCode` 만 같고 `partnerId` 가 둘 다 null 인 두 행 → 응답 `{errors:[{scope:'field', field:'items.1.externalIdentifier', code:'UNIQUE_VIOLATION', message:'…'}]}`. `uniqueScope` 가 없어 화면 `M-01-02` 는 **다섯 축 중 무엇이 겹쳤는지 못 짚는다**. 같은 화면이 `POST /trace/lots` 에서는 `['plantId','lotNo']` 를 받으므로 **한 화면이 같은 코드를 두 모양으로 본다** — 자리 4 가 뷰에서 막은 것과 같은 형태의 사고다.

⇒ 판정: **ⓓ 는 「손검사한다」는 옳고, 「어떤 코드로·어떤 봉투로」가 미결이다.** 구현 전에 한 줄 정하면 되고 예산 변화는 0(±3줄).

### 자리 4 — `trace` 의 `holdView` 를 쓴다 · **PASS**

계약으로 재검증했다. `LotHold`(`:11814`) required **5**(`lotHoldId`·`lotId`·`reasonCode`·`statusCode`·`heldAt`) · 프로퍼티 **16** ✓ 초안 숫자 정확.
- 선택 칸 전부(`holdQty`·`uomId`·`releaseCondition`·`heldBy`·`releasedBy`·`releasedAt`·`releaseReasonCode`·`remarks`)가 `[T, null]` 이고 **enum 이 하나도 없다** ⇒ 널을 실어도, 키를 생략해도 스키마를 통과한다. `lotStatusCode` 는 `type:string`(널 불가) · required **밖** ⇒ **키 생략만이 유일한 합법 표현**. 초안의 ⓒ 「둘 다 계약을 통과한다」 **검증됨**.
- `LotDetailResponse.holds` = `LotHold[]` ✓, `lot.service.ts:148` 이 `holdView` 로 그린다 ✓ ⇒ 「같은 보류가 두 경로로 나가면 모양이 같아야 한다」가 이 자리의 결정 기준이라는 초안 논지가 선다.
- `holdView`(`lot-view.ts:135-158`)가 16칸 전건 · `lotStatusCode` 는 조건부 스프레드로 키 생략 ✓.
- `activeOnly=false` = **전체** 도 선례 원문 확인 — `lot-hold-query.service.ts:68-72` 「`open=false` 는 「해제된 것만」이 «아니라» «전체»다 ⇒ **필터를 걸지 않는다** … 참·거짓 갈래가 아니라 있음/없음 갈래」 ✓ 초안 인용 **정확**.

⇒ **PASS.** (뷰 파일의 두 부수 오류는 §③ m-6·m-3 으로 내린다.)

### 자리 5 — PR 2 · 파일 배치 · **조건부**(API 관점 한정)

API 관점에서 확인 가능한 것은 전부 맞다:
- `LotController` 생성자 의존 **정확히 3**(`lots`·`completes`·`idempotency`) ⇒ 「3 → 6」 산술 ✓. `lot.controller.ts` **108행** · `lot.service.ts` **293행** · `lot-view.ts` **159행** ✓ (§6-1 실측표 전건 일치).
- 전용 컨트롤러 판정 ✓ — 형제 주석이 진짜로 이 슬라이스를 예고한다: `lot-lifecycle-event.controller.ts:8-9` 「경로가 `trace/lots` 와 달라 `LotController` 에 얹지 않는다. 오퍼레이션 하나에 디렉터리를 새로 만들지도 않는다(R-13 · **I-18 이 같은 축을 더한다**)」(초안은 `:5-6` 으로 적었다 — Nit).
- 403 등록 판정 ✓ — `derived-permissions.ts:259` `'POST /trace/lots/{lotId}:request-iqc-skip': ['W-01-13']` **정확히 그 줄** · `manual-permissions.ts:84` `'PUT /trace/lots/{lotId}': ['M-01-02','P-01-01']` **정확히 그 줄** · `PUT …/external-identifiers` 는 **두 표 어디에도 없음** 확인 · 조회 3건은 403 미선언이라 `permission.guard.ts:41` 이 통과시킨다 ✓ · 미등록이면 `:48-53` 이 **던진다**(500) ✓.
- 새 ERROR_CODE **0건** ✓ — 초안이 든 9개 코드(`ROUTE_NOT_FOUND`·`ROUTE_AMBIGUOUS`·`APPROVAL_IN_PROGRESS`·`APPROVER_TYPE_NOT_SUPPORTED`·`STATE_LOCKED`·`REQUIRED`·`UNIQUE_VIOLATION`·`INVALID` + 409 봉투) 전부 `src/common/errors/error-codes.ts` 에 실재. 새로 지을 것 0.
- 멱등 2 · If-Match 필수 1 · 응답 ETag 0 ✓ 계약 실측과 일치. `runVersioned` 가 `setEtag` 를 부르므로 못 쓴다는 판정도 `master-write.ts:40-58` 로 확인 ✓, 대체 관행 `versionOf(request)` 도 `goods-issue.controller.ts:146-152` 에 실재 ✓.

**조건부인 이유** — e2e 가 **그대로는 안 돈다**. §③ m-5 참조.

---

## ③ 그 밖의 findings

### **Major 1** — §1-3 「널을 응답에 실을 수 없는 칸이 **하나**」가 틀렸다. **둘이고, 둘째가 이 슬라이스의 새 응답이다**

초안 §1-3: 「⛔ `null` 을 응답에 실을 수 없는 칸이 하나: `externalSystemCode` … 전 계약 16곳」. 계약을 전수 순회한 결과 이 슬라이스 응답 스키마에 **같은 모양이 둘**이다:

| 스키마 | 칸 | `type` | `enum` |
|---|---|---|---|
| `LotExternalIdentifier` | `externalSystemCode` | `["string","null"]` | 3값(널 없음) |
| ⭐ **`LotStatusHistoryEvent`** | **`sourceDocumentTypeCode`** | `["string","null"]` | **`["INSPECTION_RESULT","LOT_HOLD","NONCONFORMANCE"]`**(널 없음) |
| (요청측) `LotExternalIdentifierUpsert` | `externalSystemCode` | `["string","null"]` | 3값(널 없음) |

`LotStatusHistoryEvent` 는 **이 슬라이스가 새로 만드는 `GET /trace/lot-status-events` 의 응답**이다. 그리고 물리 칸은 널이 될 수 있다 — `lot-quality-status.service.ts:17` `sourceDocumentTypeCode?: string`(선택) · 마이그 `20260901030000/migration.sql:60-62` `ck_lot_status_event_source CHECK ((source_document_type_code IS NULL) = (source_document_id IS NULL))` 가 **둘 다 널인 행을 명시적으로 허용**한다.

초안 §1-4 는 이 칸을 「동명 그대로」로만 적고 넘어갔고(「채울 수 없는 칸이 0이다」), §4-1 의 「갈리는 곳 넷」에도 없다.

- **실패 예** — `lot_status_event(source_document_type_code = NULL, source_document_id = NULL)` 한 행. 뷰가 `sourceDocumentTypeCode: null` 로 그리면 응답이 계약 `LotStatusHistoryEvent` 를 **위반**한다(`enum` 이 `null` 을 안 받는다). 초안 §7-1 e2e **#8** 이 바로 그 응답을 ajv 로 검증하므로(`test/trace-lot.e2e-spec.ts:32-43` 의 `validator()` 가 계약 responses 스키마를 `$ref` 로 컴파일한다) **그 테스트가 빨개진다**.
- 요청측도 마찬가지 — `PUT` 본문에 `"externalSystemCode": null` 을 실으면 `type` 은 허용하는데 `enum` 이 막아 **400** 이다. 초안 §1-3 은 「검증 가드가 이미 막는다」로 enum 만 언급하고 널 갈래를 안 적었다.

### **Major 2** — §4-1 「직역 복제」와 §7-1 e2e #8 이 **서로를 부정한다**

복제 원본의 규약은 **키 생략**이고, 그 이유가 주석에 박혀 있다:
```
src/trace/lot/lot-lifecycle-event-view.ts:13-29
 * ⛔ 값이 없는 칸은 **키를 생략**한다 — `fromLifecycleStatusCode` 는 최초 전이(L1)에서
 *    비고, 그때 널이 아니라 키가 없다(형제 뷰 관행).
export function lotLifecycleEventView(row) { return omitEmpty({ …
    fromLifecycleStatusCode: row.from_lifecycle_status_code ?? undefined,
    sourceDocumentTypeCode:  row.source_document_type_code ?? undefined, … }); }
```
(형제 계약 `LotLifecycleHistoryEvent.sourceDocumentTypeCode` 도 **똑같이** `["string","null"]`+enum 3값이다 — 형제는 이 함정을 `omitEmpty`+`?? undefined` 로 이미 피한 것이다.)

그런데 초안 §7-1 **e2e #8** 은 정반대를 요구한다:
> 「`fromStatusCode` 가 null 인 행(C4)이 **키 생략이 아니라 `null`** 로 온다(계약이 `[string,null]` 로 열었다)」

- §4-1 은 「이름만 바꿔 복제한다 · 갈리는 곳 넷」이라 적고 **널 정책을 갈리는 곳에 안 넣었다** ⇒ 구현자가 문자 그대로 복제하면 `omitEmpty` 가 따라오고 **e2e #8 이 실패**한다.
- 반대로 e2e #8 을 좇아 `omitEmpty` 를 걷어내면 **Major 1** 의 `sourceDocumentTypeCode: null` 이 같은 테스트의 ajv 단언을 깬다.
- 즉 **계획대로는 어느 쪽으로 가도 빨갛다.** (합법 해 하나는 존재한다 — `fromStatusCode` 는 널로, `sourceDocumentTypeCode` 는 `?? undefined` 로 **칸마다 다르게**. 하지만 계획서가 그 말을 하지 않았고, `omitEmpty` 는 `undefined` 만 거르므로 이 구분은 손으로 써야만 나온다.)
- ⇒ §4-1 의 「갈리는 곳」 표에 **다섯째 행 「널 정책 — 칸마다」** 가 있어야 하고, §7-1 #8 은 두 칸을 **각각** 단언해야 한다. 예산 변화 0.

### **Major 3** — `transitionCode` 는 **enum 밖 값이 «생길 것이 이미 정해져 있다»** — §8-1 #10 이 그걸 못 봤다

`LotStatusHistoryEvent.transitionCode` 는 **required** 이고 **enum 9값으로 닫혀 있다**(`transitionCode` 질의 파라미터도 같은 9값으로 닫혔다). 그런데 전이표가 **코드 없는 전이를 일부러 남겨 뒀다**:
```
src/core/document-state/transitions.ts:215-219
    // ── I-23(레인 C · 재고 재등록)이 쓴다 ──────────────────────────
    // ⛔ `transitionCode` 가 없다 — 이력 칸은 NOT NULL 인데 계약 enum 9값(C4~C15)에 재등록을
    //    가리키는 코드가 «없다». 지어내지 않고 호출자가 넘기게 둔다. 설계 미정 — 문의 089(발행 예정).
    'stock-reinstate': { from: ['DEFECTIVE'], to: 'NORMAL', sourceOperation: 'POST /logistics/stock-reinstatements' },
```
`lot-quality-status.service.ts:52-54` 가 `transition.transitionCode ?? ctx.transitionCode` 로 **호출자가 준 임의 문자열**을 `lot_status_event.transition_code`(NOT NULL)에 그대로 싣는다.

초안 §8-1 #10 은 「0단계 — 형제 선례 ⇒ 안 떨어뜨린다」로 닫았다. 형제(`lot_lifecycle_history`)는 L1·L2·L3 로 전이가 닫혀 enum 밖 값이 **가정**일 뿐이지만, 여기서는 **레인 C 가 만들 것이 이미 코드에 예약돼 있다.**

- **실패 예** — I-23 병합 후 `POST /logistics/stock-reinstatements` 가 `lot_status_event(transition_code='<문의 089 미정값>')` 을 남긴다 → `GET /trace/lot-status-events?occurredFrom=…&occurredTo=…` 가 그 행을 `transitionCode:'<미정값>'` 으로 내린다 → **계약 required+enum 위반**. 게다가 질의 enum 도 닫혀 있어 그 행만 **골라볼 수도 없다** — 「감사 조회 전건」이라는 이 오퍼레이션의 존재 이유와 정면으로 어긋난다.
- ⇒ §8-4 「알려둘 것」에 **한 줄**(또는 통보 한 건)이 서야 한다. 초안 §8-4 여섯 항목(ⓐ~ⓕ)에 없다. 판정을 바꿀 필요는 없다(떨어뜨리지 않는 것은 맞다) — **모르는 채로 두면 안 되는 자리**다.

### **Major 4** — 자리 1 ⓐ 의 에러코드(§②에 상술). `STATE_LOCKED` → `INVALID`

### **Minor 5** — 쓰기 2건의 「없는 `lotId`」 응답을 **판정표가 다루지 않는다**(계약이 404 를 선언 안 했다)

- 실측: `PUT …/external-identifiers` responses = **200·400·403·409**, `:request-iqc-skip` = **202·400·403·409**. 둘 다 **404 없음**. (초안 실측부록 #4 가 「404 없음」을 적어 놓고 결론을 안 냈다.)
- 그런데 §3-1 2·4ⓐ 와 §3-2 2ⓐ 는 「없으면 **404**」로 적었다. §8-1 #5 는 「**조회 3건**의 없는 `lotId`」만 판정한다 — **쓰기 둘은 판정표에 없다**.
- 참고: 봉투 자체는 문제없다(`src/common/errors/error.filter.ts` 의 `ErrorResponseFilter` 가 `NotFoundException` 을 계약 `ErrorResponse` 로 바꾼다). **상태코드 404 가 미선언**인 것이 자리다.
- **실패 예** — `POST /api/trace/lots/999999:request-iqc-skip` → 404. 계약에서 생성한 클라이언트에는 404 분기가 없다(202/400/403/409 만). 형제 `GET /trace/lots/{lotId}` 는 404 를 **선언**하므로 「이 자원 계열은 404 를 낸다」가 자명하지도 않다.
- ⇒ 판정 자체는 선례대로 404 가 옳다(`goods-issue-update.service.ts:70`·`purchase-order.service.ts:286` 모두 미선언 404 를 낸다). **§8-1 #5 를 「쓰기 2건 포함」으로 넓히고 「알려둘 것」 한 줄**이면 닫힌다.

### **Minor 6** — §3-3 갈래 순서가 인용한 선례와 다르다

초안 §3-3 은 **6(요청 안 중복·코드값·partnerId) → 7(없는 LOT 404)** 순이다. 선례 `goods-issue-update.service.ts` 는 **0행/중복 400 → `header findUnique` → 404(`:70`) → FK·위치 400(`:71-77`)** 로, **404 가 FK 계열 400 «앞»** 이다.
- **실패 예** — `PUT /trace/lots/999999/external-identifiers` + `partnerId: 999999`(둘 다 없음) → 초안 순서는 `400 {field:'items.0.partnerId'}`, 선례 순서는 `404`. 「없는 LOT 인데 라인 오류를 보여 준다」가 되어 화면이 엉뚱한 칸을 빨갛게 만든다.
- 예산 0. 순서 한 줄만 정하면 된다.

### **Minor 7** — e2e 가 **권한 때문에 안 돈다** (PR ②)

`test/trace-lot.e2e-spec.ts:29` `const PERMISSIONS = ['M-01-02', 'P-01-01', 'M-01-04'];`
`:request-iqc-skip` 은 `derived-permissions.ts:259` 가 **`['W-01-13']`** 을 요구한다. 이 목록에 **없다**.
- **실패 예** — §7-2 e2e **#19**(202 기대) → `403 PERMISSION_DENIED`. #20·#21 도 같이 무너진다.
- 새 PUT 쪽은 괜찮다 — 초안이 고른 `['M-01-02','P-01-01']` 이 이 역할에 이미 있다(그래서 PUT 은 초록, IQC 만 빨갛다 — **더 헷갈리는 실패**다).
- ⇒ `:29` 에 `'W-01-13'` 을 더해야 한다. 이건 초안 §0 자리5 ⓒ 가 공용 파일에 대해 약속한 「**읽기만 하고 «등록 줄»만 더한다**」가 아니라 **기존 줄 수정**이다 — 레인 A 와의 충돌 창 설명을 그만큼 고쳐야 한다(가산적 변경이라 회귀 위험은 낮다).

### **Minor 8** — 계약·물리 실측 숫자 셋이 틀렸다

| 자리 | 초안 | 실측 |
|---|---|---|
| §1-4 · 실측부록 #23 | `LotExternalIdentifier` required 4 · 프로퍼티 **5** | required 4 ✓ · 프로퍼티 **6**(`lotExternalIdentifierId`·`lotId`·`identifierTypeCode`·`externalIdentifier`·`partnerId`·`externalSystemCode`) |
| §2 표 | 「계약 **5칸** ↔ 물리 8칸(초과분 `created_at`·`created_by`)」 | 5+2=7≠8. **6**+2=8 이라야 산술이 맞는다 |
| §1-4 · 실측부록 #16 | `trace.lot_status_event` **17칸** | **15칸**(스칼라) · 관계 3(`app_user`·`location`·`lot`) = 필드 18. 초안 자신의 §1-4 매핑표가 세는 것도 10+5=**15** 다 |

결론(「채울 수 없는 칸 0 · 마이그 0」)은 **바뀌지 않는다**. 다만 `identifierView`(`lot-view.ts:103-118`)가 실제로 **6칸**을 그리므로, 「5칸」을 믿고 뷰를 검수하면 한 칸을 안 본다.

### **Minor 9** — 「Prisma 가 관계 정렬을 안 한다」는 사실이 아니다 (§4-3)

초안: 「⚠ `include` 로 받으면 Prisma 가 관계 정렬을 안 하므로 **매핑 전에 손으로 정렬**한다」.
`include: { relation: { where, orderBy } }` 는 Prisma Client 가 지원하고, **이 저장소가 이미 두 곳에서 쓴다** — `src/core/approval/approval.service.ts:182` `include: { approval_route_step: { orderBy: { step_no: 'asc' } } }` · `src/core/inventory-posting/inventory-posting.service.ts:122`.
⇒ `include: { lot_hold: { where: activeOnly ? { released_at: null } : {}, orderBy: [{held_at:'desc'},{lot_hold_id:'desc'}] } }` 한 줄이면 §4-3 의 필터·정렬이 DB 에서 끝난다(`ix_lot_hold_held_at` 을 탄다). 손정렬도 **틀리지는 않지만** 근거로 든 사실이 틀렸고, 「손으로 정렬」이 §7-4 변이 점검 ⑦⑧ 을 하나 더 늘린다.

### **Minor 10** — 선례 인용 줄이 여러 곳에서 어긋난다

| 초안 인용 | 실제 |
|---|---|
| `goods-issue-update.service.ts:82-83`(「무의미하므로 막는다」) | **`:194-195`** — `:82-83` 은 다른 문장(라인 수정 차단) · **§②자리1 참조** |
| `purchase-order.service.ts:341-350`(「N→N−1」) | 문장은 **`:334-336`**(doc 주석) · `:341-350` 은 `assertLinesFit` 본체 |
| `approval.service.ts:127`(`APPROVAL_IN_PROGRESS`) | **`:118`** |
| 〃 `:189`(`ROUTE_AMBIGUOUS`) / `:214`·`:227` | **`:188`** / **`:215`**·**`:220`** (`:192` `ROUTE_NOT_FOUND` 만 정확) |
| 〃 `:102-110`(「호출자가 … 잠근다」) | **`:98-99`** |
| `lot-hold-view.ts:47-70`(`lotHoldView`) | **`:41-60`** |
| `lot.service.ts:277-283`(`assertCodeValues`) | **`:271-278`** |
| `lot-complete.service.ts:44`(「278줄이라 …」) | **`:40`** |
| `lot-complete.service.ts:132`(404) | **`:122`**(`lockLot` 안) |
| `lot-registry.service.ts:24`(`INSPECTION_PENDING`) | **`:23`**(`:24` 는 주석 · `:25` 가 `INBOUND_RECEIPT_LINE`) |
| `lot-lifecycle-event.controller.ts:5-6`(예고 주석) | **`:8-9`** |
| `lot.controller.ts:47`(`bool()`) | **`:51`** |
| `lot.service.ts:141-144`(식별자 정렬) | **`:139-142`** |

**전부 「그 문장이 그 파일에 실재한다」는 참**이다 — 인용이 지어낸 것은 하나도 없었다. 다만 `goods-issue-update.service.ts:82-83` 하나는 **다른 문장을 가리키고** 있어 판정 근거로 그대로 옮기면 안 된다. 나머지는 ±1~9행 표류(파일이 그 사이 안 바뀐 것을 확인했으니, 초안이 세던 기준이 조금씩 달랐던 것으로 보인다).

### **Nit 11** — `operation-permissions.spec.ts` 의 두 단언 성격을 뭉갰다

초안 §6-2·실측부록 #40: 「(403 선언 250 · covered ≥ 152)는 `toBeGreaterThanOrEqual` 이라 숫자를 안 고쳐도 초록이다」.
실제로는 `:61 expect(declares403).toHaveLength(250)` — **정확 일치**이고, `:62 covered` 만 `toBeGreaterThanOrEqual` 이다.
**결론(안 고친다)은 그대로 맞다** — 계약이 읽기 전용이라 `declares403` 이 250 에서 안 움직이고, `covered` 만 153 으로 는다. 표현만 정정하면 된다.

### **Nit 12** — `manual-permissions.ts` 줄 수가 §6-1(**+3**) ↔ §6-2(**+1줄**) 로 어긋난다
파일 머리가 「**각 줄에 근거를 적는다**」를 강제하므로 실제로는 주석 2 + 엔트리 1 = **+3** 이 맞다. §6-2 의 「+1줄」을 「엔트리 1줄(+근거 주석 2)」로 적으면 된다.

### **Nit 13** — §1-1 의 `:6507` 은 summary 줄이다
오퍼레이션 시작은 `:6503`(`"post"`). `GET /trace/lot-status-events` 의 `:6331` 도 path 줄이고 `get` 은 `:6332`. 다른 넷은 전부 정확.

---

## ④ 미수행 — 「PASS 로 적지 않는다」

- **게이트 일절 안 돌렸다** — `tsc`·`jest`(단위·e2e)·lint·`contracts:check` **전부 미수행**(브리프 §5 「게이트를 두 번 돌리지 않는다」·`pnpm exec` 금지). Major 2·Minor 7 의 「빨개진다」는 **코드·계약을 읽어 도출한 예측**이며 실행으로 확인한 것이 아니다.
- **DB 관측 0** — 초안 실측부록 #51·#52(마이그 60건·코드값 4/4/9/6·`APPROVAL_TYPE` 0행)는 **재측정하지 않았다**(브리프 「리뷰어는 이 표의 값을 재측정하지 않는다」 · 내 판정 중 이 값을 뒤집는 것이 없다). 파일로 확인 가능한 것만 봤다 — `ls prisma/migrations | wc -l` = 61(= 마이그 60 + `migration_lock.toml`) ✓.
- **UI/UX·통합 관점 미판정** — 화면 정본(`M-01-02`·`M-01-13`·`W-01-02`·`W-01-07`·`W-03-01`)·`plan-uiux.md`·`plan-integration.md`·`lanes.md`·`plan.md` §5 규칙 9·12 는 **읽지 않았다**(내 관점이 아니다). 따라서 **초안 §8-3(회신 12)·§9 PR 예산·모델 배분·레인 A 파일 충돌 처리에 대한 판정 없음.** 단 §8-3 의 API 측 전제 둘은 확인했다 — `ApprovalRequestCreate` 프로퍼티 **1**(`reason`)로 한도 칸 0 ✓, 계약 `:6508` 「한도는 승인자가 정한다」 ✓.
- **커버리지 382 → 387 미검증** — `docs/coverage-100/assignment.tsv` 의 I-18 **5행**만 확인했다(✓). 382 라는 기준값은 안 셌다.
- **초안 §7-4 변이 점검 8건** — 코드가 없어 실행 불가. 목록의 타당성만 읽었다(널 정책이 변이 축에 없다 — Major 2 와 같은 자리).

---

## ⑤ 한 줄 결론

**계약 대조는 놀랍도록 정확하다 — 5 오퍼레이션의 질의·본문·응답·에러·`required`·If-Match/멱등/ETag/403 이 전건 실측과 맞고 새 ERROR_CODE 0건도 참이다. 다섯 자리 중 둘(2·4)은 PASS, 셋(1·3·5)은 조건부이며, 뒤집을 것은 자리 1 ⓐ 의 에러코드 하나다. 그러나 응답 «널 정책»이 뚫려 있다 — 계약이 널을 못 받는 칸이 하나가 아니라 둘이고 둘째가 이 슬라이스의 새 응답이며(Major 1), §4-1 「직역 복제」와 e2e #8 이 서로를 부정해 계획대로는 어느 쪽으로 가도 테스트가 빨개진다(Major 2). 여기에 enum 밖 `transitionCode` 가 레인 C 에서 «생길 것이 이미 예약돼 있다»는 사실(Major 3)까지, 셋 다 구현 전 한 문단씩이면 닫히고 예산은 거의 안 움직인다.**

**Blocker 0 · Major 4 · Minor 6 · Nit 3.**
