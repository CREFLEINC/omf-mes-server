# I-5 재검토 — **api 관점**

> 대상 `docs/coverage-100/slices/I-5.md`(1,019줄) · 브리프 `brief-I-5-review.md` · 계약 `contracts/COMMIT.txt` = `a6a87e1` · 실측일 2026-09-06.
> 실측 수단: `jq`(계약 읽기 전용) · `grep`/`sed`(코드) · DB 접속 없음. 판정 번호는 통합자가 `R-api-N` 으로 인용한다.

---

## 1. 문의 032·033·034 가 정말 새 문의인가 — **✏**

- **032 ✅ 그대로 선다.** `jq` 실측: `:cancel` 의 `requestBody` 가 **NONE** 이고(4 오퍼레이션 중 본문 있는 것은 `:request-cancel` 의 `ApprovalRequestCreate` 하나), `shipment-04` 의 `ShipmentCancel` 은 `required=[businessDate, occurredAt]` 에 ⌜취소는 재고를 되돌리므로 원장을 지난다 — 유일 제약에 영업일이 들어 있다(C-8 · W-04-12 §5-8)⌝ 가 붙어 있다. **C-8·026 과 겹치지 않는다** — C-8 은 「누가 보낸 영업일을 서버가 다시 잡지 않는다」이고 032 는 「같은 행위인데 한쪽은 아무도 안 보낸다」라 층이 다르다. 026 은 입하 `POSTED` 도달 축이라 무관.
- **033 ✅ 문의감이다 · ✏ 물음의 축을 바꾼다.** `app-공통.json` 승인 경로 실측 — 결재선 5경로 + 요청 4경로(`GET /app/approval-requests` · `{id}` · `:approve` · `:reject`)로 **9경로가 맞고 철회·취소는 0건**이다(⚠ I-5 §6-5 의 「GET/POST /app/approval-requests」는 GET 뿐 — POST 는 없다). 다만 물어야 할 쪽은 **`document-progress` 의 되돌림 전이가 아니라 `app-공통` 의 승인 요청 철회 오퍼레이션 부재**다 — 문서 상태만 되돌리면 `approval_request` 가 `PENDING` 으로 영원히 남아 `assertNoOpenRequest` 가 재상신을 막는다(`approval.service.ts:73·102-118`). W-01-13 §5-7 「취소 요청 철회」와의 불일치도 승인 축의 문제다. **⇒ 033 의 제목을 승인 축으로 고쳐 쓴다.**
- **034 ✅ 문의다(물리 정정이 아니다) · ✏ 물음을 두 갈래로 명시한다.** 계약 실측: `ApprovalRequestCreate` 는 `reason` 한 칸 required 뿐이고 `reasonCode` 는 본문·파라미터 어디에도 없다. 다만 §2-4 가 근거로 든 0단계 선례(I-3 §5-4)와 **성격이 다르다** — 그때는 «같은 축»(`LOGISTICS_DOCUMENT_STATUS`)의 시드 값을 재사용했는데, `'OTHER'` 는 `WORK_ORDER_CANCEL_REASON` 이라는 **다른 코드 그룹**의 값이다. 그 칸을 읽는 응답이 0건이라 실해는 없으나, 034 에 ⌜nullable 로 풀 것인가 · 물류 취소 사유 그룹을 신설할 것인가⌝를 **명시적으로 묻는 문장**을 넣어야 회신이 두 갈래로 갈린다.
- **⛔ 신규 문의가 하나 빠졌다 — 035.** `DocumentSuccessor.successorTypeCode` 의 계약 원문은 ⌜**앞 넷**은 sourceDocument\* 로 거꾸로 조회하는 «문서 하류»이고, 자재 투입은 … LOT 을 가리키는 «재고 사용»이다⌝ 다(jq 실측 · 앞 넷에 `INVENTORY_TRANSACTION` 이 포함된다). I-5 §4-2 는 이것을 **계약이 인용한 화면(W-01-13 §5-3)과 FR-IM-077 로 뒤집어** LOT 축으로 옮기고 「§2 0단계로 끝난다」로 닫았다. 그러나 0단계는 「계약·설계 자료에 답이 있으면 그대로」이지 **계약 문자와 계약이 인용한 화면이 서로 어긋날 때 어느 쪽이 이기는지 슬라이스가 정하는 절차가 아니다.** 판정 결과(LOT 축)에는 동의하나 — 문서 축으로 읽으면 자기 자신뿐이라 언제나 0 이고 이동이 안 잡히는 것이 맞다 — **그 어긋남 자체를 035 로 올린다.** 이것은 `cancellable` 이 조용히 틀리는 자리라 「알려둘 것」으로 내려서는 안 된다.
- §9-3 「알려둘 것」 12건 중 문의로 올릴 것은 **없다**(전부 실해 없는 실측 기록이거나 이미 문의에 매달렸다). §9-1 판정표의 §2 절차 적용은 20자리 중 **19자리가 맞고** #6(위 035) 하나가 절차를 건너뛰었다.

## 2. 마이그레이션 0 — **✅**

- api 관점에서 확인할 것은 「계약이 그 칸을 읽는가」 하나다. `GoodsIssue` 스키마 15칸에 `cancelled*` 가 0건이고, 계약 5벌 전체에서 `cancell` 문자열은 `cancellable`·`cancellableOnly` 둘뿐 — **`goods_issue` 취소 3칸을 읽는 응답이 하나도 없다.** §2-4 의 「한 표」 판정이 계약 실측으로 선다.
- **두-릴리스 삭제 규칙과 무관하다** — 안 채우는 것은 삭제가 아니고, 이 슬라이스는 그 3칸을 지우지 않는다.
- `CancelResult` required 4(`documentTypeCode`·`documentId`·`statusCode`·`reversed`) + nullable 2 실측 일치. 두 nullable 칸을 `reversed:false` 에서 **키 생략**하는 것은 `plan.md` §5 규칙 7(「값 없는 칸 — 키 생략(널 금지)」)에 정확히 걸린다. ✅
- seed `ENTITY_TYPES` +7 이 마이그가 아니라는 판정에 api 관점 이견 없다(응답에 안 실린다).

## 3. `reverse()` 코어 — **✏**(판정은 유지 · 근거 한 줄 보강)

- 계약이 이 코어에 대해 말하는 것은 `CancelResult` 의 두 nullable 칸뿐이고 **값을 정하는 쪽이 서버**라는 것까지다(⌜역트랜잭션 영업일 — 원장 조회에 함께 쓴다⌝). §3-4 ⓐ(원 트랜잭션의 영업일)는 CLAUDE.md ⌜서버가 수신 시각으로 다시 잡지 않는다⌝ 와 정면으로 맞고, 멱등키가 같은 날짜에서 도는 부수 효과를 근거로 든 것도 옳다. ✅
- ✏ **§3-5 에 계약 실측 한 줄이 빠졌다.** `CancelResult.reversalTransactionNo` 의 example 이 **`TX-2026-0011`** 이다 — 오늘 `transaction_no` 가 문서번호 그 자체인 것(`issue-posting.ts:154`·`receipt-posting.ts:116`)과도, `{원 번호}-R` 파생과도 어긋나는 **별도 계열**이다. 판정(`-R`)은 새 개념 0 이라 유지가 맞으나, **설계가 전용 채번 계열을 상정했다는 증거**이므로 **문의 032 ②의 근거 문장에 이 example 을 실어야** 회신이 「파생으로 두라」인지 「계열을 만들라」인지로 갈린다.
- `NEGATIVE_BALANCE` 를 코어가 던지는 역전: 계약이 ⌜역처리가 재고 잔액을 음수로 만들면 400 이다⌝ 를 `:cancel` 설명에 직접 적었고 `error-codes.ts:55` 주석이 이미 「I-5 의 `posting.reverse()` 가 같은 문자열을 쓴다」로 자리를 예약해 뒀다(실측). ✅ ~162줄 ≤200 도 타당.

## 4. 후속 판정 함수 하나 — **✏**

- 「같은 함수」 요구는 계약이 직접 세웠다 — `cancellable` ⌜유형에 취소 경로가 있는가 · 후속 유무 · 상태 · 진행 중 취소 요청을 함께 본 결과다⌝ 로 **판정 입력 넷을 셌다**(jq 실측). 세 호출자 · `withSuccessorRows` 옵션 구조 ✅.
- **§4-5 「등록부는 검증, 매핑은 코드」에 전적으로 동의한다.** api 근거가 하나 더 있다 — `DocumentProgress` 의 **required 가 10칸**인데 `entity_type_registry` 는 칸이 넷이다. 등록부에서 읽는 갈래는 required 칸을 채울 출처가 애초에 없어 계약을 만족시키지 못한다. `plan-integration.md` §9 #5 반박은 이 한 줄로 닫힌다.
- ⛔ **§4-4 의 `STATE_LOCKED` 는 `evaluate()` 에서 도달 불가다.** 취소 3종의 `status_code` 는 시드 4값(`prisma/seed.ts:1069-1078` 실측)뿐이고, 우선순위대로 가면 `CANCELLED`→2, `CANCEL_REQUESTED`→3, `REGISTERED`·`POSTED`→통과 다. 넷 밖 값을 갖는 외주 2종의 `'COMPLETED'` 는 1(`TYPE_NOT_CANCELABLE`)에서 먼저 걸린다. ⇒ **계약 enum 5값 중 `STATE_LOCKED` 는 조회 응답에 영원히 안 나온다.** PR ② 단위 테스트 5 `상태가 넷 밖이면 STATE_LOCKED 다` 는 실재하지 않는 상태를 지어내야 통과하는 테스트다. **문구를 「경합으로 그 사이 상태가 바뀌면 `assertTransition` 이 `STATE_LOCKED` 를 던진다」로 바꾸고, 조회 축에서 그 값이 안 나오는 사실을 「알려둘 것」에 올린다.**
- 5값 우선순위 자체는 옳다 — 2·3 을 4 앞에 두지 않으면 `STATE_LOCKED` 가 둘을 삼켜 화면 안내가 뭉개진다. `CANCEL_IN_PROGRESS` 의 OR 조건(상태 ∨ 열린 요청)도 반려 뒤 잠긴 문서를 결재함으로 안내하는 근거로 타당. ✅

## 5. 조회 2건 — **✅**(단 두 자리 보강)

- `documentTypeCode` 가 **query 에서도 `required: true`**(jq 실측)라 유니온이 필요 없다는 §5-3 의 출발점이 실측으로 선다. 목록 400 ⌜덮지 않는 문서 유형이면 여기로 온다⌝ 는 `contract-validation.guard.ts` 가 enum 위반을 `INVALID` 로 내는 기존 기계가 그대로 받는다(`contract-validator.spec.ts:112` 실측). ✅
- `DocumentProgressStep.stepCode` 가 `x-code-key: CD-LOGISTICS-DOCUMENT-STATUS` 이고 ⌜전표의 진행 상태와 «같은 값집합»이다⌝ 라 못박은 것 실측 확인 — **체인을 거슬러 오르지 않는다**는 §5-4 의 결론이 계약 문자 그대로다. `POSTED` 줄에 `actorName` 을 생략하는 것도 ⌜사람이 한 것이 아니면 비어 있다⌝ 와 맞다. ✅
- ✏ `cancellableOnly=true` 뒤거르기로 **페이지가 요청보다 작아지고 `totalElements` 가 거르기 전 수**가 되는 것은 계약이 그리는 목록 계약과 눈에 보이게 어긋나는 자리다. 판정(뒤에서 거른다)에는 동의하나 「알려둘 것」 ⓖ 한 줄로는 약하다 — **035 회신 요청서에 한 문단으로 함께 싣는 편이 낫다**(같은 화면의 같은 응답을 다룬다).
- sonnet 배분 ✅ — 다만 PR ③ 이 지는 계약 문자 판정(`screenId` 언제나 생략 · `documentSubTypeCode` 7종 생략 · `remainingQty` 음수 유지)이 매퍼에 몰려 있으므로 단위 테스트 6개에 그 셋이 모두 이름으로 박혀 있어야 한다 — 현재 초안은 `screenId`·`remainingQty` 둘만 있다. `documentSubTypeCode` 한 줄을 더한다.

## 6. 상태기계·어댑터 — **✏**

- `transitions.ts` 실측 160줄 · 키 6개 · **`:158` 에 「I-5 가 이 키 안에 `document-request-cancel`·`document-cancel` 을 더한다 — 키를 다시 만들지 않는다」 주석이 실재**한다. `conflictStatus` 400 판정도 그 파일 `:144-147` 주석(⌜409 는 If-Match 저장 충돌이 쓴다⌝)과 일치. ✅
- **`${documentTypeCode}_CANCEL` 이 계약 enum 에 정확히 앉는다** — jq 실측: `approvalTypeCode` enum 9값에 `INBOUND_RECEIPT_CANCEL`·`GOODS_RECEIPT_CANCEL`·`GOODS_ISSUE_CANCEL` · `ApprovalTarget.targetTypeCode` enum 8값에 `INBOUND_RECEIPT`·`GOODS_RECEIPT`·`GOODS_ISSUE`. 지어내는 것이 0 이다. ✅
- ⛔ **§6-3 ③-2 에 `assertApproved` 의 성질 한 줄이 빠졌다.** `approval.service.ts:147-157` 실측 — 대상 요청이 **0행이면 그대로 통과한다**(⌜`requests.length === 0 || … 'APPROVED'`⌝). 계약은 `:cancel` 을 ⌜승인이 끝난 요청만 받는다⌝ 로 닫았으므로, 승인 게이트의 **정본 가드는 `assertApproved` 가 아니라 상태 자물쇠**(`document-cancel` `from:['CANCEL_REQUESTED']`)다. §9-1 #20 이 030 갈래로 이 성질을 알고 있으나 `:cancel` 순서 절에는 안 적혔다 — **③-2 에 한 줄 + PR ⑤ 단위 테스트 한 줄**(`실행 — 승인 요청이 0건이면 assertApproved 가 통과하므로 상태 자물쇠가 정본 가드다`)을 더한다.
- ✏ 인용 정정: §6-2 의 ⌜`assertNoOpenRequest` 는 `request()` 안에서 이미 돈다(실측 `approval.service.ts:102`)⌝ — 호출은 **`:73`** 이고 `:102` 는 정의 줄이다.
- I-3 R-12 ⓑ 자물쇠 유지 · `putaway_task`·LOT 손대지 않음 · 원 트랜잭션 2행+ 던짐: api 관점 이견 없다(계약이 그 값을 읽는 자리가 없다). ✅

## 7. 횡단·PR 분할 — **✏**(중요 2건)

- ⭐ **`CANCEL_IN_PROGRESS` 400 판정은 옳으나 정정 대상 문서가 틀렸다.** 실측 —
  ① 01 계약: `cancelBlockedReasonCode` enum 5값 + `:request-cancel` 400 설명이 ⌜이미 취소됐다 · 취소 요청이 이미 진행 중이다 · 취소 결재선이 없다⌝ 를 `SUCCESSOR_EXISTS` 와 **나란히 400 으로** 적었다. ② 04 계약 `:1396`: ⌜취소 결재가 진행 중이면 **409 CANCEL_IN_PROGRESS** 다(J-7)⌝ — S22 전용. ⇒ **자리마다 상태가 다른 것이 계약 문자다.** ③ 그런데 `plan-api.md` §5.4 는 **이미 두 줄을 다 갖고 있다** — `:1044` 「`CANCEL_IN_PROGRESS` | **409** | … | S22」 와 `:1054` 「`CANCEL_IN_PROGRESS` | **400** | 취소 요청이 이미 진행 중이다 | **S06** | 같음(S22 의 409 와 상태만 다르고 뜻이 같다)」. **§7-4·§10·§11 #5 가 말한 「`plan-api.md` §5.4 는 409 로 적었다 · 주석을 단다」는 사실이 아니고, 그 정정은 이미 반영돼 있다.** 실제로 어긋난 문서는 **`plan.md` §5 규칙 6**(`docs/coverage-100/plan.md:147`)이다 — ⌜계약이 이름 적은 것(… `CANCEL_IN_PROGRESS`(409)…)은 그대로⌝ 가 자리를 안 갈랐다. ⇒ **§11 #5 행과 §10 정정 목록의 대상을 `plan.md` §5 규칙 6 으로 바꾼다**(문구: 「`CANCEL_IN_PROGRESS` 는 S22 `:confirm` 만 409 · S06 다형 취소는 400」).
- ✏ **파일 경로 정정** — §7-1 의 `derived-permissions.ts` 는 `src/common/http/` 가 아니라 **`src/common/permissions/derived-permissions.ts`** 다(브리프도 같은 오기). 줄 번호 `:48`·`:49`·`:167`·`:168` 과 값 `['W-01-13']` 4건은 실측 그대로 맞다. 더할 것 0 ✅.
- If-Match 토큰 출처 ✅ — 계약이 상세 GET·`:request-cancel`·`:cancel` **세 곳 description** 에 ⌜이 경로가 «아니다» — 대상 문서 리소스의 상세 GET 이 내려주는 ETag 다⌝ 를 적었고 `plan.md` §5 규칙 3 도 같다. 네 응답 전건에 `headers.ETag` 선언 0건(jq) ⇒ `runVersioned` 불가 ✅ — `master-write.ts:52-53` 이 `HttpStatus.OK` 고정 + `setEtag` 라 202 자리에도 못 쓴다(실측).
- 404/409 봉투 ✅ — 404 는 상세 GET·`:request-cancel`·`:cancel` **셋 다 선언**, 409 는 둘 다 `ConflictResponse`, 목록 GET 은 200·400 뿐(jq 실측). `error-codes.ts` 줄 번호도 전건 일치(`STATE_LOCKED:17`·`ROUTE_NOT_FOUND:30`·`APPROVAL_IN_PROGRESS:36`·`APPROVAL_REQUIRED:41`·`SUCCESSOR_EXISTS:45`·`NEGATIVE_BALANCE:55`) — 더할 3건 판정 ✅.
- ⛔ **PR ③ ~378 줄이 README §6 ② 「비테스트 350」을 깬다.** I-5 자신이 그 수를 적어 놓고 「전건 ≤400 ✅」로 넘어갔다. **③을 둘로 가른다** — ③ 목록 GET(컨트롤러+쿼리+매퍼 ~230 · sonnet) / ④ 상세 GET(`steps`·`successors` ~150 · sonnet). ⇒ **PR 6개**. ⑤ `:request-cancel` ~258 · ⑥ `:cancel` ~330 은 예산 안이다.
- 단위 테스트가 e2e 로 못 가는 가드를 덮는가: 세 겹 ③(PR① 8) · `NEGATIVE_BALANCE` 0행(PR① 12) · 2행+ 던짐(PR⑤ 7) · 5값 우선순위(PR② 6) · 반려 뒤 머묾(PR④ 8) — **다섯 다 있다** ✅. 위 4·6 에서 두 줄(교정 1 · 추가 1)만 손본다. §10-1 e2e 정리 순서(원장 `TRUNCATE … CASCADE` 먼저)와 J-8·M1 배치는 api 관점 이견 없다.

## 8. 자기 관점 계획서와 어긋나는 자리 — **✏**(§11 대조표 api 행 실측)

| §11 # | I-5 의 주장 | 실측 | 판정 |
|:-:|---|---|:-:|
| 1 | `plan.md` §1 6행·`plan-api.md` S06 = PR 3 | `plan.md:39` 「4 · I-3·I-4 · `posting.reverse()` · opus · **3**」 · `plan-api.md:174` 「예상 PR 수 **3**」 | ✅ |
| 2 | `plan.md` §1 = opus 전건 | `plan.md:39` opus | ✅ |
| 4 | `plan-api.md` §5.1-B 가 `INVENTORY_TRANSACTION` 을 문서 축으로 | `plan-api.md:789-791` ⌜`GOODS_RECEIPT`·`GOODS_ISSUE`·`PICKING_ORDER`·`INVENTORY_TRANSACTION` 은 `source_document_*` 역조회⌝ | ✅ (⇒ 문의 035) |
| 5 | `plan-api.md` §5.4 = 409·S22 뿐 | **틀렸다** — `:1054` 에 400·S06 행이 이미 있다. 어긋난 곳은 `plan.md:147` 규칙 6 | ✏ |
| 7 | `plan-api.md` §5.1-B 「한 표」 | `plan-api.md:794-796` 그대로 | ✅ |
| — | (누락) | `plan-api.md:936` 의 `DocumentProgress.screenId` 「키 생략」 행이 §5-1 판정의 정본 근거인데 §11 에 행이 없다 | ✏ 행 추가 |

⇒ **`plan.md` 에 되돌릴 것 2건**: ① §5 규칙 6 의 `CANCEL_IN_PROGRESS` 자리 가르기 ② §1 39행의 「PR 3 · opus 전건」을 「PR 6 · ③④만 sonnet」으로. **`plan-api.md` 에 되돌릴 것 1건**: S06 「예상 PR 수 3」 → 6. §5.4 는 **손댈 것 없다**.

---

### 5줄 요약

1. **I-5.md 에 반영할 수정 10건** — R-api-1 `INVENTORY_TRANSACTION` LOT 축 판정을 **문의 035** 로 승격(계약 문자 ↔ 계약이 인용한 화면의 충돌은 슬라이스가 §2 0단계로 닫을 자리가 아니다) · R-api-2 `CANCEL_IN_PROGRESS` 정정 대상을 `plan-api.md` §5.4 → **`plan.md` §5 규칙 6** 으로 교체(§7-4·§10·§11 #5) · R-api-3 `STATE_LOCKED` 는 `evaluate()` 도달 불가 → PR② 단위테스트 5 문구 교정 + 「알려둘 것」 1줄 · R-api-4 §3-5 에 계약 example `TX-2026-0011`(별도 계열)을 032 ② 근거로 추가 · R-api-5 `derived-permissions.ts` 경로를 `src/common/permissions/` 로 정정 · R-api-6 `approval.service.ts:102` → 호출은 `:73` · R-api-7 PR ③(378줄)을 목록/상세로 2분할 · R-api-8 §6-3 ③-2 에 「`assertApproved` 는 0행이면 통과 — 정본 가드는 상태 자물쇠」 + 단위테스트 1줄 · R-api-9 034 에 「nullable 이냐 그룹 신설이냐」 명시(`'OTHER'` 는 다른 그룹의 값이라 I-3 §5-4 선례와 성격이 다르다) · R-api-10 033 의 물음을 「승인 요청 철회 오퍼레이션 부재」로 세운다.
2. **`plan.md` 에 반영할 것 2건** — §5 규칙 6 에 「`CANCEL_IN_PROGRESS` 는 S22 `:confirm` 만 409 · S06 다형 취소는 400」 · §1 39행 「PR 3 · opus」 → 「PR 6 · 조회 2 PR 만 sonnet」. **`plan-api.md` 는 S06 의 「예상 PR 수 3」 → 6 하나뿐이고 §5.4 는 이미 맞다.**
3. **문의 최종 4건** — 032(역트랜잭션 영업일·시각·번호 · example 근거 보강) · 033(승인 요청 **철회 오퍼레이션** 부재로 축 변경) · 034(`reason_code` NOT NULL — 두 갈래 명시) · **035 신설**(`DocumentSuccessor` 계약 문자가 `INVENTORY_TRANSACTION` 을 문서 하류로 적었는데 계약이 인용한 W-01-13 §5-3·FR-IM-077 은 LOT 축이다 · `cancellableOnly` 뒤거르기의 `totalElements` 문제를 같은 요청서에 묶는다). 기존 인용 2건(026·030)은 그대로.
4. **PR 분할 최종안 6개** — ① `posting.reverse()` 코어 ~162(opus) · ② 매핑표+후속 판정 ~265(opus) · ③ 목록 GET ~230(sonnet) · ④ 상세 GET(`steps`·`successors`) ~150(sonnet) · ⑤ `:request-cancel`+전이 3키 ~258(opus) · ⑥ `:cancel`+어댑터 3+J-8·M1 ~330(opus). 전건 **비테스트 ≤350** · 코어 ≤200 · 마이그레이션 커밋 0 · ⛔ I-8 과 직렬 유지.
5. **api 관점 총평 — 본문 판정은 대체로 계약 실측과 맞고 되돌릴 것은 두 자리다**: 계약 문자와 화면이 충돌하는 후속 축(035)을 슬라이스가 스스로 닫은 것, 그리고 이미 고쳐져 있는 `plan-api.md` §5.4 를 정정 대상으로 잡아 **정작 어긋난 `plan.md` §5 규칙 6 을 놓친 것**. 나머지 여섯은 문구·인용·예산 교정이다.
