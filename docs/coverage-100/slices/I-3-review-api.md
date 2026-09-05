# I-3 재검토 — **API 설계 관점** (브리프 `brief-I-3-review.md`)

> 대상 `I-3.md` · 계약 사본 `a6a87e1` 읽기 전용. 근거는 `jq`·`schema.prisma`·baseline SQL·소스 실측.
> ⭐ **§1-1 횡단표 12행은 `jq` 전건 일치**(멱등 5 · If-Match 필수 2+선택 1 · ETag 3 · 403 5 · 404 선언 2 ·
> `X-Worker-No` 2 · `PUT …/lines` 응답 헤더 0). **계약 실측은 정확하다. 막는 것은 코드 쪽 셋이다**(§1·§2·§4).

---

## 1. ⛔ 채번 — `INBOUND_RECEIPT` 는 지금 부르면 **500 이다**

`numbering.service.ts:9~15` `DEFAULT_PREFIX` 는 `PURCHASE_ORDER`·`GOODS_RECEIPT`·`PUTAWAY_TASK`·
`NOTICE`·`APPROVAL_REQUEST` **다섯뿐**, `seed.ts:1390 NUMBERING_RULES` 는 `PRODUCTION_RESULT` **하나뿐**.
규칙이 없으면 `rule()` 이 기본 패턴을 만들며 `prefixOf()` 를 부르고 모르는 유형은 **던진다**(`:141`
「접두어를 지어내지 않는다」). ⇒ §2-5·§4-3 의 `numbering.next('INBOUND_RECEIPT', …)` 와 e2e
`IR-YYYYMMDD-\d{4,}` 가 **닿을 수 없다**. §8-1 「기존 파일 수정 **5**」에 `numbering.service.ts` 가 없다.
⇒ PR② 파일표에 `INBOUND_RECEIPT: 'IR'` **1줄** + 단위 테스트 `채번 — 기본 접두어는 IR 이다(규칙
미등재)`. `plan-api.md` §5.5 가 그 자리를 이미 정해 뒀다 — 새 판단이 아니라 **누락**이다.

## 2. ⛔ LOT — `LogisticsModule` → `TraceModule` 은 **아키텍처 금지 규칙** 위반

`server-architecture.md:67` ⛔ 「**도메인이 다른 도메인의 service 를 부르지 않는다. 공유가 필요하면
그것은 `core` 다**」(CLAUDE.md 「도메인 구현 전 필독」). §5-1·PR② 파일표·§9 #8 이 정면으로 어긴다 —
「사용처가 둘이라 승격 안 한다」는 이 규칙 앞에서 못 선다. 게다가 **I-3.md 가 §6-4 에서 `assertDay` 를
「⛔ 도메인을 가로질러 import 하지 않는다」로 거절했다** — 규칙 helper 는 막고 service 는 들인다.
✏ **`src/core/lot/` 로 승격한다** — 사용처 3(`POST /trace/lots` 구현됨 · I-3 입하 · **I-17 재생재** —
`LOT_SOURCE_TYPE` 시드 2값이 `INBOUND_RECEIPT_LINE`·`RECYCLE_ENTRY`, `seed.ts:1084`) + `server-
architecture.md` §1 코어 목록이 **`lot-genealogy` 를 이미 예고**했다(선제적 레이어 아님). `plan.md` §3
코어표에 한 행.
✏ **쓰기 순서 누락** — `lot.source_id` 가 «라인 id»(`lot.service.ts:248`)라 라인이 먼저, A3 의 `lot_id` 는
LOT 이 먼저 ⇒ 한 트랜잭션 안 **라인 → LOT → 라인 UPDATE 2패스**다. §2-6 주석·PR② 줄 수에 반영.

## 3. ⛔ `PUT …/lines` 에 `runVersioned` 를 쓰면 **계약에 없는 ETag 가 나간다**

§6-2 는 `runVersioned` 라 적었는데 그 헬퍼는 **무조건** `setEtag(…)` 한다(`master-write.ts:54`). 계약은
그 200 에 헤더를 선언하지 않았고 §6-3 이 「⛔ 안 내린다」로 못박았다 — 두 절이 어긋난다.
✏ 선례가 있다: `:request-approval` 이 같은 자리라 `ifMatchVersion(request)` 로 값만 꺼내고
`runIdempotent` 를 쓴다(`purchase-order.controller.ts:133~140`). **그 모양을 복제**하고 §6-2 표를 고친다.

## 4. ⛔ PR ②가 **548줄**이다 — §8-1 합계가 틀렸고 ≤400 을 깬다

파일표 재합산: ①**262 ✅** ③**348 ✅** ④**356 ✅** ⑤**338 ✅** · ② 30+8+**150**+35+45+28+4+6+62+180 =
**548**(서비스 ~150 행이 합에서 빠졌다). ⇒ §8-1 「각 절 파일표 합과 같은 값이다」가 ②에서 거짓,
총합도 1,702 → **1,852**. CLAUDE.md 「PR diff ≤ 400줄」 위반.
✏ **②를 가른다 — PR 은 5 가 아니라 6**: **②a** 마이그 선행 + 등록(검증·채번·`DEFAULT_PREFIX`)+등록 e2e
~250 · opus / **②b** LOT `createWithin` + P/O 귀속 잠금 + 귀속·LOT e2e ~300 · opus. 커버리지 269 불변.

---

## 5. 문의 026 — ✅ **새 문의가 맞다** · ✏ **제목이 사실보다 넓다**

`016~025` 전문 + 보낸 1~15번 grep: 입하 상태 축의 물음 **0건**, 번호 026 비어 있다 ⇒ 새 문의 ✅.
023 과 안 합치는 판정도 ✅(자원도 무게도 다르다 — 입하 라인은 LOT·입고·원장에 닿아 있다).
⛔ 제목 「`REGISTERED` **밖으로 옮기는 오퍼레이션이 없다**」는 **틀린다** — 023 본문이 스스로 「취소 실행
경로가 있는 것은 **입하**·입고·출고 3종뿐」이라 인용했고 §5-3 도 「갈 길은 있다 — I-5 가 연다」라 적었다.
✏ ⇒ **`POSTED` 축 하나로 좁힌다**: 「**입고가 소비한 입하를 「전기 완료」로 옮기는 주체가 없다**」.
그래야 023 의 복사본이 아니라 «더 좁고 더 무거운» 물음이 되고 I-5 병합 뒤에도 문의가 안 썩는다.
✅ **`:split` 원본 처분 철회 동의** — `InboundReceiptSplitRequest` 프로퍼티가 `mode`·`normal`·`excess`·
`businessDate`·`occurredAt` 다섯뿐이라 **원본을 가리킬 칸이 물리적으로 없다**(jq). 0단계에서 끝난다.
✅ §7-6 ⛔ 5건 · 기존 3건 인용 · 14번 표에 `inbound_receipt_no` 추가(§1 이 근거를 세운다).
✏ **「알려둘 것」은 8 이 아니라 10** — ⓘ **`:split`·`variances` 는 409 미선언인데 서버가 409 를 낸다**
(`IdempotencyService` 가 지문 불일치 `:115`·처리 중 `:121` 둘 다 `ConflictException`. 두 응답은
`201,400,403` 뿐 — I-2 쓰기 4건은 전부 409 를 선언해 **처음 겹치는 자리**다. ⓒ 와 같은 등급) ·
ⓙ **`deliveryNoteAttachmentId` 받아서 버림**(§7-3 이 스스로 「알려둘 것」이라 적었는데 목록에 없다).

## 6. 마이그레이션(§2-6) — ✅ **동의. 두 릴리스·forward-only 위반 없음**

추가 1(`lot_id?`+인덱스) · 완화 1(`reason_code` DROP NOT NULL) · **삭제 0**. baseline 일치 —
`ck_po_line_received`(:937) · `ck_inbound_expiry`(:1024) · `inspection_required NOT NULL`(:1016) ·
`inbound_receipt_line` 에 `lot_id` **없음**(schema 19칸 실측). ✏ 인용만 어긋난다: `reason_code … NOT NULL`
은 **:1035 가 아니라 :1036**(§0·§2-6).
✅ **행 N 을 안 거는 판정 동의** — `jq` 로 `InboundReceiptLine.required` 9칸에 `statusCode` 가 **실제로
있다**. nullable 은 문제를 옮길 뿐이다. §9 #6(§0 #10 을 「`required` 로 «안» 적은 자리에만」)도 ✅.
✏ **주석 한 줄** — §7-4 가 자식 셋을 `count` 하는데 `goods_receipt_line.inbound_receipt_line_id` 도
`purchase_order.source_inbound_receipt_line_id` 도 **인덱스가 없다**(schema 실측). I-2 R-6 처방
(「1차 데이터량이 작아 안 넣고 마이그 주석 한 줄」)을 복제한다.

## 7. P/O 귀속·잠금(§3) — ✅ **판정 동의** · ✏ 세 자리

✅ 부모 `FOR UPDATE` — `replaceLines` 가 **라인을 만지기 전** 부모를 `updateMany` 로 잠근다(`purchase-
order.service.ts:210~214` → 라인 읽기 :216). 순서가 양쪽 다 「부모 → 라인」이라 **I-2 코드 불변** ✅.
오름차순 한 문장도 ✅(LockRows 가 Sort 위에 서 정렬 순서로 잠긴다). ✅ `ck_po_line_received` 손검사 ·
`Decimal` 비교(`assertLinesFit:358` 이 `Number()` 를 쓴 자리와 방향이 반대라는 지적도 맞다) · 승인 안 봄
(입하 12건 전문에 승인 문장 **0건** — `assertApproved` I-4 유지) · `source_inbound_receipt_line_id` 밖.
✏ **7-a. 잠글 부모를 «어디서 얻는가»가 §3-2 절차에 없다.** 요청은 `purchaseOrderLineId` 만 준다 ⇒
라인→부모 매핑을 **트랜잭션 «안»에서 먼저** 읽고, 4단계 재조회에 요청의 라인 id 가 **없으면 400
`INVALID`** 로 끝낸다(안 그러면 FK 가 받아 `field` 가 최상위를 짚는다 — #193 Minor-1 과 같은 자리).
✏ **7-b.** `= ANY($1)` 은 Prisma 가 배열 타입을 못 붙일 수 있다 — 선례(`requestApproval:300`)를 따르되
`IN (${Prisma.join(ids)})` 로 적는다. ✏ **7-c.** 동시성 e2e(`⭐ … 500 이 없다`)는 PR②b 로 간다.

## 8. `:split`·차이(§4) — ✅ 대부분 · ⛔ **검증 두 축이 통째로 빠졌다**

✅ 한 트랜잭션·부분 실패 금지 · 채번 2회 트랜잭션 밖(part 마다 그 `plantId`) · 초과분 `purchase_order_
line_id` NULL · `exceptionTypeCode` 요청값 · `varianceQty` 상한 없음 · 차이가 `received_qty`·라인 상태를
안 바꿈(`inbound_variance` 감사 칸 둘) · 중복 등록 허용(유일 제약 없음 — baseline 실측).
⛔ **8-a. 코드값 검증 0.** `exceptionTypeCode`(`CD-INBOUND-RECEIPT-EXCEPTION-TYPE` · 시드 4값 `seed.ts:640`)
와 `substituteLotReasonCode`(`CD-SUBSTITUTE-LOT-REASON` · 시드 5값 `:617`) 둘 다 `x-code-key` 인데
§1-5·§3·§4 어디에도 `assertCodeValues` 가 없다(차이 두 칸만 걸었다). ⇒ **등록·치환·`:split` 셋 다** 건다.
⛔ **8-b. 「P/O 를 고르지 않고 진행할 때 필수」가 가드로 안 섰다** — `InboundReceiptCreate.
exceptionTypeCode` description 원문이다(jq). 지금은 `PAIR`(유형↔사유)뿐 ⇒ **모든 라인에
`purchaseOrderLineId` 가 없으면 `REQUIRED`**. ⚠ **`:split` 에는 걸지 않는다** — `SplitPart` 는 「초과분
쪽에서 쓰는」이라고만 적었고 초과분은 «정의상» 무발주다(§2 기준 4 — 계약이 안 적은 곳에 규칙을 옮기지
않는다). 갈림을 §4-1 표에 한 행 + e2e `입하 — 무발주인데 exceptionTypeCode 가 없으면 400 이다`.
✏ **8-c.** `InboundReceiptSplitResponse.created` 는 **`InboundReceipt[]`(헤더뿐 · 라인 id 없음)**(jq).
`W-01-03` §5-5 의 「초과분 → 신규 P/O(`sourceInboundReceiptLineId`)」가 그 id 를 필요로 해 화면이
`GET …/{id}/lines` 를 한 번 더 돈다 — 경로가 계약에 있으니 문의가 아니라 「알려둘 것」이다.

## 9. LOT·상태(§5)·§7-4 — ✅ 동의

`inspection_required` 품목 승계 ✅(`schema.prisma:1731` `@default(false)` NOT NULL · 계약 `Item` 실측) ·
`manufactured_at` 안 채움 ✅ · 라인 `status_code='REGISTERED'` ✅(`lot_hold` §Z-3 과 같은 형태) · 전이 0 ✅
(`transitions.ts` 에 `logistics.` 축 0건 · `receipt-posting.ts` 가 `inbound_receipt` 를 안 건드림 — grep).
§7-4 는 **§2 기준 2 로 선다** ✅ — 자식 셋이 실재한다(`goods_receipt_line`·`inbound_variance`·
`purchase_order` 역참조 — schema 실측). 코드 재사용 ✅(`error-codes.ts:40`) · 새 코드 1개가 맞다.

## 10. `plan-api.md` ↔ `I-3.md` 어긋남 중 **구현에 영향 주는 것**

| # | 자리 | 어긋남·실측 | 판정 |
|:-:|---|---|---|
| 1 | 등록·`:split` 본문 라인 | `InboundReceiptCreate.lines.items`·`SplitPart.lines.items` 가 **`InboundReceiptLineUpsert`** 라 `inboundReceiptLineId` 를 받는다(jq). I-3.md 가 이 갈래를 안 적었다 | ✏ **무시한다**(계약이 허용한 칸을 400 으로 막지 않는다 — `purchase-order.service.ts:114` R-8 ⓑ). e2e `등록 — 본문의 inboundReceiptLineId 는 무시되고 신규 행으로 선다` |
| 2 | S02 「상태기계 있음」 | §5-3 이 전이 0 으로 한 겹 더 갔다 | ✅ I-3.md 가 맞다 |
| 3 | S02 「PR 3」·문의 초안 | 철회 ✅ · PR 수는 5 가 아니라 **6**(§4) | ✏ 두 칸 다 고친다 |
| 4 | 테스트 이름 구멍 5 | ⓒ 는 404 를 3건이라 적었는데 e2e 는 수정만 · 치환에 If-Match/409 0 · 치환의 «상향» 수량이 `QTY_EXCEEDS_ORDERED` 를 타는 것 0 · `:split` 403 e2e 0 | ✏ 5줄 추가: `치환 — 없는 입하면 404` · `치환 — 낡은 If-Match 면 409` · `치환 — If-Match 가 없으면 400` · `치환 — 수량을 올려 발주+허용치를 넘기면 400 QTY_EXCEEDS_ORDERED` · `분리 — 권한 없는 사용자의 POST 는 403` |

---

## 재수립 결과 — 5줄 요약

1. **I-3.md 수정 12건** — ① `DEFAULT_PREFIX` 에 `INBOUND_RECEIPT: 'IR'`(없으면 채번이 **500**) ② LOT 을
   `src/core/lot/` 로 승격(`server-architecture.md:67` 도메인 간 service 호출 금지) ③ 라인→LOT→라인
   UPDATE 2패스 명시 ④ `PUT …/lines` 는 `runVersioned` 가 아니라 `ifMatchVersion`+`runIdempotent`
   ⑤ PR② 를 ②a/②b 로 분할(548줄) ⑥ 026 제목을 `POSTED` 축으로 좁힘 ⑦ 「알려둘 것」 8→**10**(409
   미선언·첨부 버림) ⑧ `assertCodeValues` 두 축 ⑨ 무발주 `exceptionTypeCode` `REQUIRED`(`:split` 제외)
   ⑩ 잠글 부모 사전 조회 + 없는 라인 400 ⑪ 본문 `inboundReceiptLineId` 무시 ⑫ 인용 :1035→:1036.
2. **`plan.md` 반영 5건** — §4 I-3 행에 「+ `reason_code` 완화」 · §4 행 N·§0 #10 을 「계약이 `required` 로
   «안» 적은 자리에만」으로 좁힘 · §1 I-3 PR 열 3 → **6** · §7 에 I-3 026 한 행 · **§3 코어표에
   「LOT 등록 — I-3 · `createWithin(tx, …)`」 한 행**(위 ②가 코어표를 늘린다).
3. **문의 최종 1건** — 026(제목을 「입고가 소비한 입하를 「전기 완료」로 옮기는 주체가 없다」로) ·
   **철회 1**(`:split` 원본 — 요청 스키마에 원본 칸이 물리적으로 없다) · 기존 3건 인용 · 14번 표 보강.
4. **마이그레이션은 A3 + `reason_code` 완화 한 파일 그대로 ✅** — 추가·완화만이라 두 릴리스 미해당·
   forward-only 위반 0. 선행 커밋은 **PR ②a**(opus 유지) · 자식 FK 두 곳의 인덱스 부재를 주석 한 줄로.
5. **결론**: 계약 실측(횡단표·스키마·404·ETag)은 **전건 정확하다.** 막는 것은 코드 쪽 셋 — **채번 접두어
   부재(즉시 500)** · **도메인 간 service 호출 금지 위반** · **PR② 548줄**. 나머지는 검증 두 축(코드값·
   무발주 필수)과 테스트 이름 보강이다.
