# I-9 재검토 — **API 설계 관점**(`plan-api.md` 저자)

> 대상 `slices/I-9.md`(625줄) · 실측일 2026-09-07 · worktree `i9-plan` · 계약 `a6a87e1`.
> 판정 11건 중 **✅ 5 · ✏ 5 · ⛔ 1**. 반영할 수정 **7건**(§끝 요약).

## 1. 문의 3건이 정말 새 문의인가 — ✏

- **048 ✅ 신설이 맞다.** `plan.md` 216행이 발행처를 I-9 로 이미 지목했고(`plan-uiux.md` 1184 K 는 «후보»일 뿐 발행되지 않았다), 서버 몫 「앞이 없으면 400」이 **충분하다**는 것도 실측으로 선다 — 계약 `IdempotencyKey` 가 uuid 하나라 큐 묶음·선행 키를 실을 자리가 0이고, 서버→단말 회수 축도 0이다. 제목·논지 그대로.
- **049 ✅ 문의가 맞다.** 반론(「등록이 곧 확정」=`POSTED`)은 실측으로 서지 않는다 — `cancel-eligibility.service.ts:41` 이 `OPEN_STATUSES=['REGISTERED','POSTED']` 로 둘을 같이 열어 두었고, 시드 1069 가 `POSTED`=전기완료다. I-5 「`POSTED` 줄은 원장 행이 있을 때만」과의 충돌은 실재한다 ⇒ `'REGISTERED'` 가 맞다.
  ✏ **049 를 다시 써야 한다** — ⓒ 의 근거가 「영원히 REGISTERED」보다 훨씬 세다: `cancel-eligibility.service.ts:143-155` 는 후속을 `(source_document_type_code, source_document_id)` 축의 **세 표만**(goods_receipt·goods_issue·picking_order) 세고 `shopfloor_receipt.goods_issue_id`(FK 직결)를 **안 본다** ⇒ 수령 전표가 선 출고도 `SUCCESSOR_EXISTS` 에 안 걸려 **취소가 그대로 통과**한다. `M-01-09:224`(§8 #1)가 초과 수령 정정을 바로 그 출고 취소로 돌렸으므로, 이건 곁가지가 아니라 049 의 본론이다.
  ✏ **ⓓ(차이 0 인데 사유)는 049 에서 뗀다** — 049 는 상태 생명주기, ⓓ 는 라인 필드의 계약 침묵이다. **050 에 붙인다**(같은 스키마 `ShopfloorReceiptLineCreate`). 섞으면 회신이 섞인다.
- **050 ✅ 신설이 맞다 — 046 과 겹치지 않는다.** 046 은 `material_issue_request_line.issued_qty` 를 **올리는 오퍼레이션이 없다**(서버가 못 쓰는 칸), 050 은 `shopfloor_receipt_line.issued_qty` 를 **클라이언트가 보낸 사본이 다를 때**다. 표·물음·되돌림 비용이 전부 다르다 ⇒ 별건 + 「046 과 같은 형상」 상호 참조만(계획서가 이미 그렇게 적었다).
- ✏ **해소 보고는 「해소」가 아니라 「확인」이다** — `M-01-09:226` 이 스스로 ⌜2026-09-02 좁힘 — `VARIANCE_REASON` 포인터는 실렸다⌝ 라 절반을 이미 닫았다. 우리가 더한 것은 `seed.ts:628` 6행 실측뿐이다.
- 알려둘 것 10 중 문의로 올릴 것: **없다**(ⓕ·ⓖ 는 후속 마이그 후보 · ⓐⓑⓘⓙ 는 계약 관찰).

## 2. ⭐ 「한 출고 = 수령 하나」 ↔ 「라인 일부만」 — ⛔ **양립하지 않는다**

**실측이 계획서의 근거를 뒤집는다.** `M-01-09:191` 「입고 확정 | **1라인 이상 수령** — C-3」은 §5-6 표의 **버튼 활성 조건**이다(같은 표 :186~190 이 전부 활성 조건). 「본문이 라인을 덜 실어도 된다」는 뜻이 아니다. 뜻은 «수령 수량을 넣은 라인이 하나 이상»이다 — 레이아웃 :48~54 가 출고 한 건의 **5라인을 통째로** 그리고, :131 이 ⌜부족 수령 ✅ 허용 · `variance_qty = 20` · 사유 입력⌝ 이라 **덜 받은 것은 둘째 전표가 아니라 그 라인의 차이로 닫힌다**. 「재수령」 업무가 없다는 §3-8 의 논지가 곧 「라인을 남겨 둘 수 없다」는 뜻이다.
⇒ 계획자안 ⓒ 를 두면 **첫 수령에서 빠진 라인은 영원히 수령 불가**다(둘째 전표 400).

**대안 ⓐ 를 채택한다 — 본문 라인 집합 = 그 출고의 `goods_issue_line` 전건.** 빠지면 400 `LINE_REQUIRED`(중복은 이미 400 `INVALID`).
§2 판정: 1단계 **가장자리**(라인을 덜 실은 요청에서만 갈린다) → 2단계 **기준 2**(거부하는 쪽 — 거부→허용이 완화) + **기준 5**(새 개념 0 — 출고 라인은 §3-1 ②에서 이미 다 읽었다. `Set` 크기 비교 한 줄).
대안 ⓑ(라인 축 중복 금지·둘째 전표 허용)는 `M-01-09:84` 「FK NOT NULL — **1:1**」·:225 「**1:1로 시작**」과 정면으로 갈리고 「부분 수령 상태」라는 **새 개념**을 만든다 ⇒ 기준 5 에서 진다.
효과: §3-8 헤더 `FOR UPDATE` 와 400 `STATE_LOCKED` 는 **그대로 선다**. 문의 신설 없음(§8-1 #6 「1:1 로 시작」에 붙는다). 3단계 흔적: 단위 테스트 `출고 라인을 빠뜨리면 400 LINE_REQUIRED`.

## 3. `issuedQty` 대조 400 — ✅ (근거 한 줄 보강)

- 칸 이름 ✅: `goods_issue_line.**issue_qty**`(`schema.prisma:781`) ↔ `shopfloor_receipt_line.**issued_qty**`(`:1396`). 계획서가 옳게 갈랐다(브리프 8행의 `issued_qty` 가 오기다).
- 에러 코드 5종 **전부 실재**: `error-codes.ts` `REQUIRED:9` · `RANGE:10` · `INVALID:14` · `STATE_LOCKED:19` · `LINE_REQUIRED:23`. 새 코드 0 ✅.
- 「낡은 값에 400 은 업무를 없애는 거부」 반론은 **실측으로 안 선다** — 출고는 언제나 `POSTED` 로 태어나고(`M-01-09:224` `postImmediately: true` · I-4 R-6), 전기된 전표의 라인은 `goods-issue-update.service.ts:261`(`statusCode !== REGISTERED` → 거부)이 못 바꾼다. ⇒ `issue_qty` 는 사실상 불변이고 불일치는 **클라이언트가 틀린 경우뿐**이다. 이 한 줄을 §3-3 ⓔ 에 넣으면 리뷰가 이 자리를 다시 열지 않는다.
- 덮어쓰기 대안은 기준 4 위반이고, `variance_qty` 가 GENERATED 라 **서버가 차이의 분모를 조용히 바꾸는** 셈이 된다 ⇒ 대조가 맞다.

## 4. 출고 상태 게이트 `POSTED` 만 · 400/404 — ✏ (판정은 맞고, **둘이 빠졌다**)

- `POSTED` 만 ✅: `goods-issue.service.ts:34` · `transitions.ts:196-202`(`document-post` `REGISTERED`→`POSTED`). `M-01-09:201`(⌜출고 전표를 못 찾음 — 오프라인이면 아직 안 올라간 것⌝)은 **없는** 출고 갈래이고 `REGISTERED` 출고는 **있는데 물건이 안 나간** 갈래다 ⇒ 400 `INVALID` 와 400 `STATE_LOCKED` 로 갈리는 것이 맞다(단말이 재시도/포기를 가른다).
- 400 vs 404 ✅: 계약 POST 에 404 미선언(jq 실측) · 선례 `material-issue-request.service.ts:149-151` 주석 그대로.
- ✏ **빠진 것 ① — `work_order.status_code` 를 안 본다.** 같은 도메인·같은 본문 칸의 선례가 `material-issue-request.service.ts:39·152-155` 다(`CANCELLED`·`CLOSED` → 400 `STATE_LOCKED`). **판정 자체는 유지**해도 좋다 — 출고가 이미 전기돼 물건이 나갔으므로 여기서 거부하면 I-4 §5-3 「업무를 없애는 거부」다. 그러나 §3-2 ⓑ 에 **그 이유가 한 줄도 없다** ⇒ 명시 + §8-3 알려둘 것 한 줄. 안 적으면 리뷰가 Major 로 연다.
- ✏ **빠진 것 ② — 취소된 출고를 가리키는 수령 전표**(판정 1 의 049 ⓒ 재작성). I-5 역트랜잭션이 잔액을 되돌려도 수령 전표와 그 뒤 `material_consumption` 은 남는다. §9 인계에 **I-5/I-13 행**을 세운다.

## 5. `FOR UPDATE` 를 도메인 서비스가 직접 — ✅

- 선례가 **넷**이다: `lot-complete.service.ts:115-121` · `work-order-write.service.ts:64-75` · `purchase-order.service.ts:274-304` · `production-result-approval.service.ts:75`. 헤더 행 한 줄 잠금은 정확히 같은 모양이다.
- `runIdempotent` 가 tx 를 이미 연다 ✅ **실측 확인**: `idempotency.service.ts:67` 이 `$transaction` 을 열고, `master-write.ts:34` 가 그 `tx` 를 **버리고** `work()` 를 부른다 ⇒ 도메인은 별 커넥션에서 자기 tx 를 연다 = 요청당 2. §3-1 서술이 정확하다.
- ⚠ 한 줄 보강: 바깥 멱등 tx 는 옵션이 없어 **Prisma 기본 5s** 다. `TRANSACTION_OPTIONS` 를 안 쓰는 판정은 맞되(잔액 선잠금 0), 「같은 출고 동시 두 건은 뒤가 즉시 400 을 받아 대기가 짧다」를 §3-8 에 적는다.
- UNIQUE 부분 인덱스 대안은 §2 기준 3 + `plan.md` §4 「—」로 진다. 판정 2 를 ⓐ로 닫으면 **행 잠금 하나로 충분**하다 ⇒ 계획대로.

## 6. `received_by`=세션 · 사번 읽고 버림 — ✅

`plan.md` §5 규칙 9 원문 실측(143행 블록): ⌜주체는 계정 세션 … **예외 — 헤더가 «주체 칸의 유일한 원천»이고 POP 단말만 부르는 자리** … 없으면 400 `REQUIRED`⌝. 여기서는 `received_by` FK 가 `app_user`(`schema.prisma:1377`)라 사번을 담을 칸이 아예 없고, `picking-pick.service.ts:158-168` 주석이 글자 그대로 같은 판정이다 ⇒ 부재 400 + 저장 ✕ ✅, `mdm.worker` 미조회 ✅(I-7 §4-3 과 갈리지 않는다 — I-8 `:pick` 이 같은 자리다). `assertWorkerNo` **셋째 사본 허용** ✅(5줄 · 두 도메인을 함께 고치지 않는다).
✏ 한 줄: **규칙 9 예외 목록의 «네 번째»** 가 된다는 사실을 §8-3 ⓔ 에 적어야 `plan.md` 갱신이 빠지지 않는다.

## 7. 채번 `SR-{YYYYMMDD}-{SEQ4}` — ✅

- 접두어 근거 등급이 **선례와 같다**: `numbering.service.ts:16-17` 의 `GOODS_ISSUE: 'GI'` 주석이 ⌜계약 example `GI-2026-000402` 는 **형식만**⌝ 이라는 **똑같은 논법**을 이미 썼다. 패턴이 다른 것(`YYYY-NNNNNN`)은 GI·WO·MIR 셋 다 그랬다 ⇒ `SR-2026-000077` 로 접두어만 뽑는 것이 일관이다. `prefixOf(:144-152)` 가 없으면 던지므로 한 줄 추가는 **필수**다.
- `next()` 는 `numbering_rule` 만 본다(`:63~121` 실측) ⇒ 등록부 부재 영향 0 ✅. `plantId` 왕복은 `material-issue-request.service.ts:133-137·174` 그대로 ✅(못 풀면 400 `INVALID` · 040 인용).
- **모델 상향 조건 미발동** ✅ — README §4 의 opus 조건은 「원장 쓰기·상태기계·posting·마이그레이션」 넷이고 `DEFAULT_PREFIX` 한 줄은 어디에도 안 걸린다.
- `plan-api.md` 1093행 갱신 + 「문의 14 표에 `shopfloor_receipt_no` 한 행」 ✅ — I-2·I-3·I-6 이 쌓은 관행 그대로다.

## 8. 조회 2 — ✏ (한 줄 보강)

- where 4 매핑 ✅ 실측: `filter`(**`src/common/master/query.ts:36`**) · `statusCode` 문자 그대로는 `picking-query.service.ts:39-40` 주석 선례 그대로 · `page`/`size` 는 `pageRequest`.
- 정렬 **PK 역순 ✅**: `picking-query.service.ts:46-49` 와 글자 그대로 같다. `received_at desc` 는 계약이 그 축을 안 줬고 동시각 타이가 페이지 경계를 흔든다 ⇒ 채택하지 않는 것이 맞다.
- ✏ **목록 `include` 의 N 한도**: 계약 `size` 에 `maximum` 이 **없다**(jq) — 상한은 코드가 준다: `pagination.ts:15` **`MAX_SIZE = 200`**. 최악 200전표 × 라인 × (`item`·`lot` 조인)이다. 계약 description 이 목록 라인을 «명령»했으므로 판정은 유지하되 §4-2 에 「상한은 `MAX_SIZE=200` · 왕복은 `include` 한 번」 한 줄을 적는다. 목록에 자식을 `include` 한 선례는 있다(`document-progress-query.service.ts:72`).
- 상세 `lines` 두 벌 ✅ · 라벨 3칸 조인 ✅ · `statusCode` 값 대조 안 걺 ✅ · 404 ✅ · ETag 0 ✅(계약 `responses.*.headers` 0 — 나도 jq 로 재확인).

## 9. e2e — ✏

- **TRUNCATE 안 씀 ✅** — 이 스위트는 원장 행을 0건 만든다. I-8 ④b-2 가 남긴 저장소 차원 문제를 늘리지 않는 것이 맞다.
- ✏ 픽스처: 출고 직접 INSERT 의 NOT NULL 이 **일곱**이다(`schema.prisma:737-746`) — `goods_issue_no`·`issue_type_code`·`source_document_type_code`·`source_document_id`·`source_warehouse_id`·`issued_at`·`status_code`. 도착지 두 칸은 **둘 다 널**로 두면 `ck_goods_issue_destination`(`20260901090000…:25-27`)을 만족한다. 라인은 `line_no` NOT NULL + `uq_goods_issue_line`(`:797`). 계획서가 이 목록을 안 적었다 ⇒ 브리프에 싣는다.
- ✏ 「원장 무변화」 단언: **전역 COUNT 는 동시 실행 스위트에 흔들린다**(I-8 의 TRUNCATE 가 만든 바로 그 문제). **픽스처 품목/LOT 축으로 좁힌다** — `inventory_transaction_line WHERE item_id = <SRE2E item>` 0행. 이러면 `inventory_balance` 행이 없어도 단언이 성립한다.
- ✏ **M2 마디 ⑧→⑨ 한 케이스를 이 스위트에 넣는다** — e2e 는 비테스트 예산 **밖**이라 값이 싸다: 진짜 `POST /goods-issues`(`postImmediately`)로 선 출고에 수령을 붙여 **잔액 전후 동일**을 단언한다(§9 가 통합자에게 넘긴 그 단언과 같은 모양). 픽스처 사슬은 피킹 e2e 복제로 이미 다 선다. 통합자 체인 e2e 는 그대로 둔다.
- ✏ 숫자 오기: §7-3 이 「e2e **12**」라 적었으나 실제 나열은 **8+13=21** 이다.
- 판정 2 반영 시 이름 하나 추가: `출고 라인을 빠뜨리면 400 LINE_REQUIRED`.

## 10. PR 분할·모델 — ✏

- **스택 ①→② ✅**: ②의 201 이 `ShopfloorReceiptDetailResponse` 라 ①의 매퍼·`…_LINE_INCLUDE` 가 전부 ②의 현역이다. 독립으로 가르면 매퍼가 두 벌이 된다 ⇒ 스택이 맞다.
- **예산 ✅**: ①~226 · ②~199, 둘 다 350 아래. 판정 2·4 반영분은 **+10 안쪽**(집합 비교 한 줄 · 주석 둘) ⇒ 여유 안.
- **모델 ✏**: ① **sonnet ✅**(조회·뷰·컨트롤러 = README §4 sonnet 레인 그대로). ②는 opus 조건 넷 어디에도 안 걸리므로 **sonnet 유지 가능**하되 조건 둘을 단다 — ⓐ 구현 브리프가 `FOR UPDATE` 문장과 「**라인 전건 필수**」 규칙을 **문장 그대로** 준다 ⓑ 판정 2 가 ⓑ안으로 뒤집히면 그때는 **opus**. 근거: `numbering.service.ts` 를 sonnet 이 만진 선례가 0이다(`GI`·`WO`·`MIR` 를 넣은 I-4·I-6·I-8 은 전부 opus PR) — 한 줄이라 위험은 작지만 브리프가 그 한 줄을 **정확히** 지정해야 한다.
- **통합 계획서 자리 6 ✏**: API 관점에서 «우리 것»은 **`plan-api.md` 1093행 하나뿐**이다. S04 표 133·134·140행은 이미 ETag 「—」·멱등 ✓·If-Match 선택·403 ✓ 로 **실측과 일치**하므로 손대지 않는다. 나머지 다섯은 uiux·integration 소관 ⇒ 목록에 **소관을 표기**한다.
- **인계 ✏**: §9 를 6행 → **7행**(I-5/I-13 — cancel-eligibility 가 수령 전표를 못 본다).

## 11. `plan-api.md` ↔ I-9.md 어긋남 중 구현에 영향 주는 것 — **0건**

§10 대조표의 API 관점 행을 실측으로 확인했다: **#3·#4 ✅**(S04 133·134·140행이 계약 실측과 일치 — 어긋난 것은 `plan-uiux.md` 쪽이다) · **#8 ✅**(1093행이 유일한 갱신 대상) · **#9 ✅**(쓰는 표 전부 있음 · 마이그 0) · **#11 ✅**(PR 2 · sonnet).
⚠ 브리프에 실을 잔소리 둘: ⓐ `plan.md` §5 규칙 5 「`@Contract` 전건」이 계획서에 안 적혔다(I-8.md 도 안 적었고 구현은 맞았다) — 3건 데코레이터 한 줄. ⓑ 경로 오기 — `code-reference.ts:24` 의 실제 경로는 **`src/common/master/code-reference.ts:24`**.

---

### 재수립 결과(API 관점)

**I-9.md 에 반영할 수정 7건** — ① §3-3/§8-1 #6: **본문 라인 = 출고 라인 전건 필수**(빠지면 400 `LINE_REQUIRED`) — 판정 2 ⛔ ② §3-2 ⓑ: `work_order.status_code` 를 안 보는 **이유** 명시 + 알려둘 것 ③ 문의 049 재작성(cancel-eligibility 가 수령 전표를 못 본다) + ⓓ 를 050 으로 이관 ④ §3-3 ⓔ 에 「전기된 출고 라인은 불변」 한 줄 ⑤ §4-2 에 `MAX_SIZE=200` 한 줄, §3-8 에 잠금 대기 한 줄 ⑥ §7: 픽스처 NOT NULL 7칸 · 원장 단언을 품목 축으로 · M2 마디 실출고 케이스 1 · e2e 수 21 ⑦ §9 인계 7행 + 해소 보고를 「확인」으로.
**plan.md/plan-api.md 에 반영할 것** — `plan-api.md` 1093행 `shopfloor_receipt_no` = `SR-{YYYYMMDD}-{SEQ4}` **한 자리뿐**(S04 표는 이미 맞다) · `plan.md` §5 규칙 9 예외 목록에 이 오퍼레이션을 네 번째로.
**문의 최종** — 신규 **3건 유지**(048 · 049(재작성) · 050(ⓓ 흡수)) · 대기 15 누적 10 · 046 과는 별건 · 해소 0(확인 1).
**PR 분할·모델 최종안** — **2 · 스택 ①→② · ① sonnet(~226) · ② sonnet(~209, 조건부)**; 판정 2 가 ⓑ안으로 뒤집히면 ② 는 opus.
**멈춤 조건** — 미발동(마이그 0 · 계약끼리 모순 0). 판정 2 는 계약이 아니라 **계획서 안의 모순**이라 §2 절차로 닫힌다.
