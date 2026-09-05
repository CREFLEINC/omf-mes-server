# I-2 재검토 — **API 설계 관점** (브리프 `brief-I-2-review.md`)

> 대상 `I-2.md` · 계약 사본 `a6a87e1` 읽기 전용. 근거는 `jq`·`schema.prisma`·baseline SQL·소스 실측.
> ⭐ **§1-1 횡단표 재실측 — 멱등 4 · If-Match 3 · ETag 4 · 403 4 는 전건 일치. 다만 404 열이 틀렸다(§1).**

---

## 1. §1-1 횡단표 — ⛔ **404 칸 오류 하나. 그 위에 선 §7-4 판정도 좁다**

`jq` 전건 실측 —
```
PUT  /logistics/purchase-orders/{id}          resp=200,400,403,409   ← 404 «없다»
PUT  /logistics/purchase-orders/{id}/lines    resp=200,400,403,409
POST /logistics/purchase-orders/{id}:request-approval  resp=202,400,403,409
GET  /logistics/purchase-orders/{id}          resp=200,404           ← 404 는 여기뿐
```
§1-1 이 `PUT …/{id}` 에 **404 를 적었다**(「200/400/403/404/409」) — 계약에 없다. 따라서 ⭐ 「`PUT …/lines`
와 `PUT …/{id}` 만 404 가 갈린다」도 성립하지 않는다: **대상이 있는 쓰기 3건 전부** 404 미선언이다.
⇒ §7-4 셋째 행의 범위를 셋으로 넓히고 「알려둘 것」 ⓑ 도 셋 다 적는다(한 자리만 적으면 lines 만 고쳐진다).
판정(없는 P/O 는 404)은 ✅ — `plan-api.md` §5.3 ④ 은 미선언 자리를 400 으로 접으라 하지 않았다.

---

## 2. 문의 후보 2건 — 「정말 새 문의인가」

`design-inquiries/016~022`(020 은 I-1 재검토로 내려갔다) · 보낸 1~15번 · `계약-되돌림-mdm.md` 전문 검색:
**P/O 상태 전이·ERP 발주번호 축의 물음 0건.** 둘 다 「새 문의」가 맞다. 번호 023·024 도 비어 있다.

### 023 P/O 상태를 옮기는 오퍼레이션이 없다 — ✅ **동의(근거 보강)**
7건 전수·`cancelBlockedReasonCode` 문장(취소 실행은 3종) 재확인. ✏ `PurchaseOrder.statusCode`
description 원문이 「**취소 가부 판정이 이 값에 걸린다**(W-01-13 §5-1 관문 ②)」라 적었다 ⇒ 물음을
「도달 경로가 없다」에서 「**그 값에 걸린 판정이 P/O 에서 늘 같은 답을 낸다**」로 한 겹 세운다.

### 024 `erp_purchase_order_no` — ✅ **동의 · ⛔ 「I/F 가 계약에 없다」는 절반만 사실**
⚠ **`계약-되돌림-mdm.md` §X-1 실측**: 계약 `InterfaceDefinition.targetCode` 가 「확정된 수신 대상은
품목·자재명세·조직·작업자·**구매발주** 다섯」이라 적었고 서버가 `PURCHASE_ORDER` 문자열을 이미 골라
두었다. ⇒ **오퍼레이션이 없을 뿐, 「ERP 발주를 받는다」는 계약 층위에서 확정됐다.**
- 이것이 §7-3 2단계 판정(지금 부분 유일을 건다)의 **가장 강한 근거**다 — 「올 수도 있는 경로」가 아니라
  「확정된 수신 대상」이다. §2-5 M-b 주석과 024 본문에 이 인용을 넣는다.
- 물음도 좁아진다: 「유일을 걸까」가 아니라 **「확정 수신 대상 `PURCHASE_ORDER` 의 적재 경로가 MES
  계약에 서는가, DB 직접 적재인가 — 후자면 유일 제약이 유일한 방어다」**. X-1 을 인용한다.

### §7-5 ⛔ 「문의로 올리지 않는 것」 3건 — ✅ **셋 다 동의**
①`sourceInboundReceiptLineId` 읽는 경로 없음(응답 스키마에 칸 없음 — jq 확인) ②`PUT …/{id}` 소유
화면 없음(계약이 403 을 선언했으니 서버는 연다) ③`reset_cycle_code` 값 목록(등재 주체가 우리).

---

## 3. 채번 코어(§3) — ⛔ **트랜잭션 위치가 §3-5 의 안전 논거를 무너뜨린다**

시그니처·기본 패턴·토큰 표·`{PLANT}` 던짐·`DAILY` 외 던짐은 ✅ 동의. SQL 도 실측과 맞는다 —
`uq_numbering_counter` 는 **제약**이라 `ON CONFLICT ON CONSTRAINT` 가 서고(baseline:2608),
`uq_numbering_rule` 은 **표현식 인덱스**라 `ON CONSTRAINT` 를 못 써 §3-4 가 컬럼식 추론을 쓴 것도 맞다.

### ⛔ 3-a. 카운터를 업무 트랜잭션 «안»에 두면 이관 창의 재시도가 안 듣는다
§3-5 는 하노이 번호 겹침을 「입고가 `NUMBER_RETRY = 3` 으로 이미 재시도한다」로 넘겼다. 성립하지
않는다 — `goods-receipt.service.ts:101` 의 재시도는 **`$transaction` 을 통째로 다시 연다**. 카운터
증가가 그 안이면 롤백이 증가를 되돌려 **세 번 다 같은 번호**를 뽑고 세 번째에 `ConflictException`
이 난다. 레거시 `count()+1` 행이 있는 그 날의 입고가 **전부 막힌다**. 덤으로, 안쪽에 두면 카운터 행
잠금을 **전표 커밋까지** 쥐어 같은 문서유형·같은 날의 등록이 한 행에 직렬화된다(원장까지 도는
입고에서 특히 길다). ⇒ **카운터 한 문장을 업무 트랜잭션 «밖»(기본 커넥션)에서 돌리고 시그니처에서
`tx` 를 뺀다**(`next(documentTypeCode, plantId, periodDate)`). §3-1 주석이 이미 그 갈래를 적어 두었다
(「밖에서 뽑으면 … 허용된 낭비」) — 계약이 `pattern` 도 연속도 요구하지 않으므로(§5.5) 구멍은 무해하다.

### ✏ 3-b. `numbering_rule.is_active` 를 §3 이 한 번도 안 본다 (실측 `NOT NULL DEFAULT true`)
규칙 조회를 `is_active = true` 로 걸면 §3-4 의 자동 생성이 **비활성 행과 부딪혀 `DO NOTHING`** 하고
카운터가 매달릴 `numbering_rule_id` 를 못 얻는다(FK NOT NULL). 게다가 `DO NOTHING` 은 충돌 시
`RETURNING` 이 아무 행도 안 준다. ⇒ §3-4 를 `ON CONFLICT … DO UPDATE SET updated_at = clock_timestamp(),
is_active = true RETURNING numbering_rule_id` 로 바꾸고 조회의 `is_active` 취급을 한 문장으로 못박는다.

### ✏ 3-c. 계약 `example` `PO-2026-000123` — 각주보다 무겁다
`q` 가 「**발주번호 검색**」이고 `purchaseOrderNo` 는 응답 required ⇒ **사람이 읽고 치는 번호**라
14번이 `GR-`·`PT-` 를 올린 것과 같은 등급인데 14번 표에 P/O 가 없다. ⇒ 각주가 아니라 **14번 표에
`purchase_order_no` 한 행을 더해 재전달**한다. 형식 판정(기본 패턴)은 ✅ — `example` 은 제약이 아니다.

---

## 4. 상신 코어(§4) — ✅ 시그니처 동의 · ⛔ **동시 상신을 막는 것이 하나도 남지 않는다**

`request`·`assertNoOpenRequest` 둘만 만들고 `assertApproved` 를 I-4 로 미루는 것 ✅ 동의
(P/O 에 `:post` 없음 · 입하 계약 승인 문장 0건 · `plan-api.md` §5.4 가 `APPROVAL_REQUIRED` 를 S04·S07 에
배정 — 재확인). 「진행 중 = `PENDING` 만」·`APPROVED` 도 안 막음 ✅ 동의(J-6 문자 그대로).

⛔ **§4-2(인덱스 대신 조회)와 §6-3(`version_no` 를 안 올린다)이 «합쳐지면» 방어가 0이 된다.** If-Match
를 필수로 받으면서 버전을 안 올리니 같은 토큰의 두 상신이 둘 다 통과한다 — 낙관적 잠금이 잡아 줄 수
있었던 자리를 스스로 비운다. 두 절이 따로 판정돼 이 합이 안 보였다. ⇒ **호출자가 트랜잭션 첫 문장에서
대상 P/O 행을 잠근다**(`SELECT … WHERE purchase_order_id = $1 FOR UPDATE`). 스키마 0·계약 0·202/ETag
판정 그대로·되돌림 0. 코어가 아니라 호출자 몫이다(코어는 대상 표를 모른다 — §4-1 유지). §4-2 3단계
흔적 주석을 이것으로 바꾸고 PR② 테스트 이름에 「대상 행 잠금은 호출자 몫이다」를 넣는다.
✏ `approval_request_id` 는 **덮어쓴다**(반려 뒤 재상신이 새 요청 — J-6). PR⑤ e2e 에 `상신 — 반려 뒤
재상신하면 approval_request_id 가 새 요청으로 바뀐다`(지금은 「채워진다」뿐이라 옛 요청도 통과한다).

---

## 5. 상태기계(§5) · 마이그레이션(§2-5) — ✅ 동의

§5-2 「전이 0 → `transitions.ts` 미등록」 ✅(선례 `receipt-posting.ts:71` 재확인) · 「작성중=`REGISTERED`
하나」도 4값 실측과 맞다. §2-5 A1·A2·M-b 한 파일 ✅ — 삭제·NOT NULL 조임 0건이라 두 릴리스 규칙
미해당·forward-only 위반 없음, FK 이름 생략도 메모리 규칙대로. M-b 근거는 §2 의 024 인용으로 세진다.
✏ 다만 **A1 은 응답 `required` 가 아니다**(`PurchaseOrder.required` 7칸에 없다) — 「조회가 실어야 하니
마이그가 앞선다」(§8 ⚠)의 근거는 «필수»가 아니라 널을 내리기로 한 §6-4 판정이다. 문장을 바꾼다.

---

## 6. PR 5개 분할·순서·모델 배분(§8) — ✏ **개수·순서 ✅ · ③이 마이그를 싣는 것이 모델 배분과 어긋난다**

5로 가르는 것 ✅(쓰기 4건+e2e 가 ~460줄), 코어 둘을 앞에 두는 것 ✅.
⛔ **③(조회, sonnet)에 마이그레이션 선행 커밋을 실으면 README §4 를 어긴다** — 그 표는 「구현 —
코어(원장 쓰기·상태기계·posting·**마이그레이션**) = opus」다. ⇒ **선행 커밋을 PR ②(상신 코어, opus)의
맨 앞으로 옮긴다.** A1 의 FK 대상이 `app.approval_request` 라 주제도 맞고, ③은 순수 조회 sonnet PR 이
된다. 줄 수만 ② ~165 · ③ ~335 로 옮겨 갈 뿐 총합·PR 수·커버리지(257/487)는 그대로다.

---

## 7. `plan-api.md` ↔ `I-2.md` 어긋남 중 **구현에 영향 주는 것**

| # | 자리 | 어긋남·실측 | 판정 |
|:-:|---|---|---|
| 1 | 라인 삭제 가드(§7-4 넷째) | 「입하가 붙은」을 `inbound_receipt_line` 행 존재로만 본다. **`asn_line.purchase_order_line_id` FK 가 실재하고**(`schema.prisma:717·726` · `onDelete: NoAction`) ASN 만 붙은 라인을 지우면 **FK 위반이 500 으로 샌다** | ✏ **가드에 `asn_line` 을 함께 본다**(코드는 `SUCCESSOR_EXISTS` 하나). ⚠ 그 FK 에는 인덱스가 없다(`ix_inbound_line_po` 는 입하 쪽만) — 1차 데이터량이 작아 지금은 안 넣고 마이그 주석 한 줄(§2 기준 3). e2e `라인 — ASN 이 붙은 라인을 지우면 400 이다(500 이 아니다)` |
| 2 | 등록 본문의 라인 스키마 | `PurchaseOrderCreate.lines.items` 가 **`PurchaseOrderLineUpsert`** 다(실측) ⇒ 등록이 `purchaseOrderLineId` 를 받는다. §1-3 이 이 갈래를 안 적었다 | ✏ **무시한다**(계약이 허용한 칸을 400 으로 막지 않는다). e2e `P/O — 등록 본문의 purchaseOrderLineId 는 무시되고 신규 라인으로 선다` |
| 3 | `tolerance*Qty` | Upsert 에선 **선택**(`minimum: 0`)인데 응답 `PurchaseOrderLine` 에선 **required**. 물리는 `DEFAULT 0` | ✏ 생략 시 **0 으로 내린다**(널·키 생략 아님). §2-2 에 한 줄 |
| 4 | 202 | **이 저장소 최초의 202** — `src/` 에 `HttpStatus.ACCEPTED` 사용 0건(실측), 계약 전체 202 는 7건(logistics 5·production 2). I-1 의 「201+ETag 최초」와 같은 자리 | ✏ 컨트롤러에 `@HttpCode(HttpStatus.ACCEPTED)` 를 **명시**하고(정적이라 재전송도 202), e2e `상신 — 같은 Idempotency-Key 재전송도 202 다` 한 줄 |
| 5 | §6-1 「도출표와 겹치면 검사가 막는다」 | 부정확 — `operation-permissions.spec.ts` 넷째 it 은 **같은 키에 같은 «권한»**만 막고 주석이 그렇게 적었다. I-1 재검토 3번과 같은 정정 | ✅(문구만). 등록 3건·`POST` 는 도출표에 이미 있음(`derived-permissions.ts:176`)은 실측 일치 |
| 6 | 트랜잭션을 누가 여는가 | `runIdempotent` 는 **자기 `tx` 를 `work` 에 넘기지 않는다**(`master-write.ts:31`). 선례는 서비스가 `prisma.$transaction` 을 따로 연다(`goods-receipt.service.ts:101`) ⇒ 멱등 기록과 업무가 **다른 트랜잭션**이다 | ✏ I-2.md 에 한 줄 명시(I-1 재검토 6-④ 와 같은 지적). 상신은 그 안쪽 트랜잭션에서 `request(tx, …)` 를 부른다 |

⛔ **반대할 자리는 없다** — 새 에러 코드 둘(`APPROVAL_IN_PROGRESS`·`SUCCESSOR_EXISTS` 가 `error-codes.ts`
에 없음)·`LINE_REQUIRED`/`STATE_LOCKED`/`UNIQUE_VIOLATION` 기존·`X-Worker-No` 0건·409 봉투 전건
`ConflictResponse`·커버리지 257/487 은 전부 실측과 맞는다.

---

## 재수립 결과 — 5줄 요약

1. **I-2.md 수정 10건** — ① §1-1 `PUT …/{id}` 의 404 삭제(쓰기 3건 전부 미선언) + §7-4·「알려둘 것」 ⓑ 를
   셋으로 넓힘 ② 채번 카운터를 업무 트랜잭션 «밖»으로(§3-5 의 「재시도가 막는다」는 롤백이 카운터를
   되돌려 성립하지 않는다) ③ `numbering_rule.is_active` 갈래 + `DO NOTHING`→`DO UPDATE … RETURNING`
   ④ 상신 시 대상 P/O 행 `FOR UPDATE`(§4-2+§6-3 이 합쳐지면 동시 상신 방어가 0) ⑤ `approval_request_id`
   덮어쓰기 e2e ⑥ 라인 삭제 가드에 `asn_line` ⑦ 등록의 `purchaseOrderLineId` 무시 ⑧ `tolerance*Qty`
   생략 시 0 ⑨ 202 `@HttpCode` 명시 ⑩ A1 「required 라서」 근거 정정 + §6-1 문구.
2. **`plan.md` 반영** — §7 에 I-2 **2행**(023·024) · §1 I-2 의 PR 열 4→5 ·
   §3 「채번 코어」 칸에 「카운터는 업무 트랜잭션 밖」 한 마디(다음 32 전표가 그대로 베낀다).
3. **문의 최종 2건**(수 그대로, 근거가 세진다): **023**(물음을 「상태에 걸린 판정이 늘 같은 답을 낸다」로)
   · **024**(`계약-되돌림-mdm.md` §X-1 「확정 수신 대상 다섯에 구매발주」 인용 — I/F 는 «없는» 것이
   아니라 «오퍼레이션만» 없다). 기존 018·022 인용 유지 · **14 는 각주가 아니라 표에 P/O 한 행 추가**.
4. **마이그레이션은 A1·A2·M-b 한 파일 그대로** — 두 릴리스·forward-only 위반 없음. 다만 그 선행
   커밋을 **PR ③(sonnet)에서 PR ②(opus)로 옮긴다**(README §4 모델 배분). PR 수·커버리지 불변.
5. **결론**: 계약 실측은 404 한 칸 빼고 정확하다. 고칠 핵심은 셋 — **채번 카운터의 트랜잭션 위치**
   (이관 창을 실제로 깬다), **§4-2·§6-3 이 합쳐져 생기는 동시 상신 구멍**, **`asn_line` 을 못 본
   라인 삭제 가드**(500 이 샌다). 나머지는 근거 문장 정정과 테스트 이름 보강이다.
