# I-2 재검토 — **통합 관점** (물리 모델·마이그레이션·슬라이스 간 의존·코어 이관)

> 대상 `I-2.md` · 브리프 `brief-I-2-review.md`. 계약 사본 `a6a87e1` 읽기 전용. 실측 2026-09-06.
> 판정 축: **§2-5 SQL 이 `schema.prisma` 와 드리프트 없이 서는가 · `count()+1` 세 자리 이관이 기존 것을 깨지 않는가.**

## 0. 실측 근거표 (DB 안 건드림 — `migrate diff` 는 datamodel↔datamodel 파일 비교)

| 잰 것 | 결과 |
|---|---|
| `migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datamodel`(칸 2 + 관계 2 추가본) | 관계에 referential action 을 **안 적으면** → `ON DELETE SET NULL ON UPDATE CASCADE` / **`NoAction` 을 적으면** → `ON DELETE NO ACTION ON UPDATE NO ACTION` |
| Prisma 가 짓는 FK 이름 | `purchase_order_approval_request_id_fkey` · `purchase_order_source_inbound_receipt_line_id_fkey`(49자 — 63 절단 없음) |
| `uq_numbering_counter` | baseline :2608 **진짜 CONSTRAINT**(`CONSTRAINT … UNIQUE`) |
| `uq_numbering_rule` | baseline :2595 **표현식 UNIQUE INDEX**(제약 아님) · `seed.ts:1606` 이 「유니크 제약이 없어 upsert 를 쓸 수 없다」 |
| 기존 번호 e2e 단언 | 정규식 둘뿐 — `/^GR-20260504-\d{4}$/`(:178) · `/^PT-20260504-\d{4}$/`(:230). 정확값 단언 0건 |
| `nextReceiptNo` 호출 위치 | `receipt-posting.ts:63` — `postReceipt` 의 **첫 문장** |
| 입고 트랜잭션 옵션 | `goods-receipt.service.ts:101` `this.prisma.$transaction((tx) => …)` — **옵션 없음 = Prisma 기본 5초** |
| `purchase_order` 행 | `seed.ts`·`test/` 에 0건(참조는 `entity_type_registry` 등재 1건뿐) — M-b 적용 안전 ✓ |

## 1. I-2.md 가 놓친 것 — 넷 (구현 전에 고쳐야 뒤가 안 뒤집힌다)

### G-1 ⛔ `schema.prisma` 관계에 `onDelete: NoAction, onUpdate: NoAction` 을 **반드시** 적는다

§2-5 는 「FK 제약 이름을 적지 않는다」까지만 적었다. **이름은 맞다**(실측 — 위 표). 그런데 Prisma 의 optional 관계
**기본값이 `SetNull`/`Cascade`** 라, 관계 두 줄을 그냥 쓰면 손 SQL 의 `REFERENCES …`(= NO ACTION)와
**참조 동작이 갈린다** → `migrate diff` 드리프트. 선례 `goods_issue.approval_request_id` 도 schema.prisma :758 에
`onDelete: NoAction, onUpdate: NoAction` 이 붙어 있다. **§2-5 둘째 불릿에 이 한 줄을 넣는다.**
➕ 같은 선례가 `ix_goods_issue_approval_request` 를 함께 깔았다. I-2 는 안 깐다 — 조회 축이 아니라 표시용 역참조라
동의하나(§2-5 주석이 그렇게 적었다), 「선례와 달리 인덱스를 안 깐다」를 한 줄로 남겨야 다음 슬라이스가 베끼지 않는다.
➕ schema.prisma 변경은 **6줄**이다 — 스칼라 2 + 관계 2 + `approval_request`·`inbound_receipt_line` 의 역참조 2. §8 PR ③ 의 「~8줄」 맞다.

### G-2 ✏ 규칙 자동 생성 SQL(§3-4) 에 결함 셋

1. **`ON CONFLICT … DO NOTHING` 은 0행을 돌려준다** — `RETURNING` 으로 `numbering_rule_id` 를 못 받는다. INSERT 뒤에 SELECT 를 한 번 더 돌아야 한다(같은 tx · READ COMMITTED 라 남이 방금 커밋한 행도 보인다).
2. **추론 대상이 제약이 아니라 표현식 인덱스다** — `ON CONFLICT ON CONSTRAINT` 를 못 쓴다(초안은 표현식 형태라 맞다). 표현식 추론이 서는지는 DB 없이 못 잰다 → **PR ① 첫 실행에서 확인**하고, 안 서면 `INSERT … SELECT … WHERE NOT EXISTS (…)` 로 접는다. Prisma `upsert` 는 애초에 불가(seed.ts:1606 이 같은 이유로 findFirst 를 쓴다).
3. ⛔ **`is_active` 를 규칙 조회 조건에 넣으면 안 된다.** `uq_numbering_rule` 에 `is_active` 가 없다 — 비활성 규칙이 한 행 있으면 조회는 실패하고 INSERT 는 `DO NOTHING` 이라 **영영 규칙을 못 찾는 무한 자리**가 된다. 「`is_active=false` 규칙은 던진다」로 §3-1 에 명기한다(F-6 과 같은 처리).

⇒ §3-3 의 카운터 SQL 은 `uq_numbering_counter` 가 **진짜 CONSTRAINT** 라 `ON CONFLICT ON CONSTRAINT` 가 ✅ 그대로 선다.

### G-3 ⛔ 카운터 행 잠금이 **입고 트랜잭션 전체를 직렬화한다** — 현행에 없던 실패 모드

`nextReceiptNo` 는 `postReceipt` 의 **첫 문장**(:63)이고 행 잠금은 COMMIT 까지 간다 ⇒ 같은 (유형, 영업일) 의
입고가 전기·잔액·적치까지 **한 줄로 선다**. 그런데 `$transaction` 에 옵션이 없어 **Prisma 기본 timeout 5초**다.
겹친 둘째 건은 잠금 대기로 5초를 태우고 **`P2028`** 로 떨어지는데, 그건 `isDuplicateNo` 가 아니라
**`NUMBER_RETRY = 3` 루프가 못 잡는다 → 500.** `count()+1` 은 잠그지 않으므로 이 실패가 없었다.

**✏ 셋을 함께 넣는다(PR ①)** — ① `this.prisma.$transaction(fn, { timeout: 15_000 })` ② `next()` 를 전표 INSERT
직전까지만 미룬다(효과는 작지만 공짜) ③ §8 PR ① 의 Promise.all e2e 단언을 「둘 다 성공」이 아니라
**「번호가 다르다 + 타임아웃이 안 난다」**로 세운다. ⚠ ①을 안 넣으면 하노이에서 동시 입고가 500 으로 샌다.
(참고: GR → PT 순서가 모든 호출자에서 같아 **교착은 없다**.)

### G-4 ➕ `NTC-` 이관은 「함수 삭제」가 아니다 — `create()` 에 트랜잭션이 **없다**

`notice.service.ts:151` 은 `this.prisma.notice.create({ data: { notice_no: await this.nextNoticeNo(), … } })` 로,
tx 가 아예 없다. `$transaction` 으로 감싸고 `views()` 는 밖에 둬야 한다(+6줄). §3-5 표의 「함수 삭제 + 트랜잭션
안으로 옮김」을 **「`create()` 를 `$transaction` 으로 감싼다」**로 고쳐 적는다. `todayUtc()` 는 `Date` 라
`dateOf(todayUtc())` 로 `YYYY-MM-DD` 를 만들어 넘긴다(§3-1 시그니처는 문자열을 받는다).

## 2. `count()+1` 세 자리 이관이 기존 e2e 를 깨는가 — **✅ 안 깬다**(G-3 제외)

- 번호 형식 단언은 **정규식 둘뿐**이고 `{PREFIX}-{YYYYMMDD}-{SEQ4}` 와 자리수까지 같다 → 그대로 통과. 정확값(`…-0001`) 단언 0건.
- e2e cleanup 은 `goods_receipt`·`putaway_task` 를 DELETE 하지만 `numbering_counter` 는 안 지운다 ⇒ **회차마다 번호가 계속 오른다**. 무해하나 `\d{4}` 는 10,000회차에서 깨진다 — 실무상 무시, 다만 §3-5 에 한 줄.
- `test:e2e` 는 `--runInBand` 라 스위트 간 경합 없음. `logistics-putaway-rule.e2e-spec.ts:381` 은 번호를 직접 박아 코어를 안 탄다 ✓.
- ⭐ **번호 재사용 결함이 실제로 사라진다** — `count()` 는 남은 행을 세므로 cleanup 뒤 회차가 같은 번호를 다시 뽑았다. 카운터는 안 되돌린다.

## 3. 브리프 판정 7항목

1 문의 = **✅ 023·024 둘 다 새 문의**(§4) · 2 채번 코어 = **✏ G-2·G-3** · 3 상신 코어 = **✅ 동의**(§5) ·
4 상태기계 = **✅ 동의** · 5 마이그레이션 = **✅ 동의 + 셋 보강**(§6) · 6 PR 분할 = **✅ 5개·순서·③이 마이그를 싣는 것 동의**(§7) ·
7 어긋남 = **plan.md 본문 4건**(§8)

## 4. 문의 (브리프 1) — ✅ 023·024 둘 다 새 문의

grep 실측 — `docs/design-inquiries/016~022` · 보낸 1~15번(`~/omf-design-requests/*.md`) · `계약-되돌림-mdm.md` 에
「ERP 발주번호」·「P/O 상태 전이」를 묻는 자리가 **0건**이다. 번호 **020 은 결번**(README 가 「19 각주에 답이 있어 철회」로 명시)이라
023·024 로 잇는 데 충돌 없다. §2 절차 판정(023 = 본길이나 계약 문자가 답을 준다 / 024 = 가장자리 · 2단계 기준 2)도 ✅.
⛔ 「올리지 않는 것」 3건 ✅ 동의. 단 ③ `reset_cycle_code` 에 **한 줄 보강** — 등재 주체가 우리라는 것 말고도
**문의 14 의 회신이 채번 규칙 전체를 주면 리셋 주기 값 목록이 그 회신에 딸려 온다**. 별건으로 세울 이유가 그래서 더 없다.

## 5. 채번·상신 코어 (브리프 2·3)

- 계약 `example` `PO-2026-000123` 불일치 → **✅ 기본 패턴을 따르고 문의 14 각주**에 동의. 어느 응답도 `pattern` 을 안 걸었다.
- **오프라인 재전송 멱등과의 관계 = 문제 없다**(브리프가 물은 것). `runIdempotent` 가 같은 키의 저장 응답을 먼저 돌려주므로 재전송이 카운터를 올리지 않는다. 그리고 실패해 롤백되면 **카운터도 같이 되돌아간다** — 이것이 §3-1 「`tx` 를 받는다」의 진짜 이득이니 주석에 한 줄 남긴다.
- 상신 코어 시그니처에 `approvalTypeCode` 가 실려 있다 — **I-1 리뷰 G-2 의 요구가 반영됐다**(실측 확인) ✅.
- 「진행 중 하나」를 부분 유일 인덱스 없이 조회로 = **✅ 동의**. `ix_approval_request_target` 이 실재하고(schema.prisma:102), 인덱스를 걸면 §0 조건 1 을 세운다. 3단계 흔적 셋도 충분하다.
- `:request-approval` 이 `version_no` 를 안 올리는 것 = **✅ 동의**(202 에 ETag 가 없다). ➕ 통합 근거 — 9 상신자 중 **출하만 200 `Shipment`** 라 ETag 를 내릴 수 있고 나머지 8자리는 전부 같은 자리에 선다. I-2 가 그 **첫 벌**이니 판정이 8자리에 그대로 복사된다는 것을 §6-3 에 적어 둔다.
- `assertApproved` I-4 이관 ✅ — 사용처 0. 단 **`plan.md` §1 I-2 행의 코어 열에 그 이름이 적혀 있어** 본문 수정 대상이다(§8).

## 6. 마이그레이션 (브리프 5) — ✅ 동의 + 보강 셋

- **두 릴리스 규칙 미해당** ✓(삭제·NOT NULL 조임 0) · **forward-only** ✓ · 부분 유일 `erp_purchase_order_no` 를 지금 거는 것 ✅(2단계 기준 2). 대상 표가 0행이라 적용도 즉시다.
- ➕ **`CONCURRENTLY` 를 쓰면 안 된다** — Prisma 는 마이그레이션 파일을 한 트랜잭션으로 돈다. 지금 초안대로가 맞다(0행이라 잠금 시간도 0).
- ➕ **순환 FK 가 생긴다** — `purchase_order → inbound_receipt_line → purchase_order_line → purchase_order`. DDL 은 무해하나 **e2e 정리 순서**에 걸린다: `source_inbound_receipt_line_id` 를 채운 P/O 가 있으면 입하 라인을 먼저 못 지운다. §8 PR ④ e2e cleanup 에 한 줄, 그리고 **I-3 계획안에 인계**한다.
- ➕ **부분 유일 인덱스를 schema.prisma 에 못 적는 것** ✅ — I-1 A6(`uq_approval_route_active`)이 같은 모양으로 이미 서 있다(실측). 관행 일치라 새 부채가 아니다.
- ➕ `docs/data-model/` 산출물(칸 2 + 인덱스 1)은 재생성 대상이나 **최근 마이그레이션 6건이 전부 안 돌렸다**(git 실측 — A6 포함). I-2 도 안 돌리는 데 동의하되 **루틴 끝 일괄 재생성 목록**에 올린다.

## 7. PR 분할 (브리프 6) — ✅ 5개·순서 동의, ③이 마이그를 싣는 것도 동의

**③(조회)이 마이그를 싣는 것이 맞다** — A1 이 없으면 조회 응답의 `approvalRequestId` 를 못 채워 ③이 계약을 못 맞춘다.
쓰기 PR 로 미루면 ③이 「나중에 채운다」로 나가고 ④에서 매퍼를 다시 만진다. A2·M-b 를 같은 파일에 묶는 것도 ✅
(같은 표 · 선행 커밋 하나).
✏ **G-3 의 `$transaction timeout` 은 PR ①에 함께** 싣는다 — 195 → ~200줄로 경계지만, ③ 이후로 미루면
그 사이 병합본이 동시 입고에서 500 을 낸다. 넘치면 `numbering.service.spec.ts` 를 5줄 줄인다.

## 8. 계획서 어긋남 중 «구현에 영향 주는 것» (브리프 7) — plan.md 본문 4건

1. §1 I-2 행 **PR 4 → 5**(I-2.md §8 이 옳다 — 쓰기 4건 + e2e 가 ~460줄).
2. §1 I-2 행 **코어 열에서 `assertApproved` 삭제**(첫 사용처 I-4 · I-1 리뷰가 이미 같은 모양으로 §3 을 고쳤다).
3. §0 #3 「`GR-`·`PT-` **두** 함수」 → **셋**(`NTC-` 포함 · `plan-integration.md` §7 대기 10 이 그렇게 적었다).
4. §7 에 **I-2 2행 추가**(023·024).
⇒ §1 순서·§2 마일스톤·§3 코어 «수»·§4 마이그레이션 «목록»·`assignment.tsv` 는 **불변**. 뒤 슬라이스 밀림 0.

---

## 9. 재수립 결과 — 5줄 요약

1. **I-2.md 에 반영할 수정 6건** — ①§2-5 에 「관계 두 줄에 `onDelete: NoAction, onUpdate: NoAction`」 명기(안 적으면 Prisma 가 `SET NULL`/`CASCADE` 를 원해 손 SQL 과 드리프트 · migrate diff 실측) ②§3-4 규칙 자동 생성에 「DO NOTHING 뒤 재-SELECT」·「표현식 인덱스라 `ON CONSTRAINT` 불가」·「`is_active` 를 조회 조건에 넣지 않는다」 ③§3-5 에 `$transaction timeout` 을 함께 싣는다(카운터 잠금 × 기본 5초 → `P2028` 이 `NUMBER_RETRY` 를 빠져나가 500) ④§3-5 `NTC-` 를 「`create()` 를 `$transaction` 으로 감싼다」로 고쳐 적음 ⑤§2-5 에 순환 FK(P/O ↔ 입하 라인)의 e2e 정리 순서 한 줄 + I-3 인계 ⑥§6-3 에 「이 `version_no` 판정이 나머지 8 상신자에 복사되는 첫 벌」 한 줄.
2. **plan.md 에 반영할 것 4건** — §1 I-2 PR **4→5** · §1 I-2 코어 열에서 **`assertApproved` 삭제** · §0 #3 이관 **두 함수 → 셋**(`NTC-`) · §7 에 **I-2 2행 추가**. §1 순서·§2·§3 코어 수·§4 목록은 불변.
3. **문의 최종 2건 — 023·024 둘 다 새 문의**(016~022·보낸 1~15번·`계약-되돌림-mdm.md` grep 0건). 020 은 README 가 밝힌 결번이라 번호 충돌 없음. 기존 3건(018·022·14)은 인용만, ⛔ 3건도 동의(③에 「리셋 주기 값 목록은 문의 14 회신에 딸려 온다」 한 줄 보강).
4. **동의** — M-b 를 지금 거는 것(2단계 기준 2 · 대상 0행) · 두 릴리스/forward-only 미해당 · FK 이름을 안 짓는 것(실측 `purchase_order_approval_request_id_fkey` 확인) · 부분 유일을 schema.prisma 에 안 적는 것(A6 선례) · 전이 0 → `transitions.ts` 미등록 · 「진행 중 하나」를 조회로 · `assertApproved` I-4 이관 · PR 5개와 ③이 마이그를 싣는 것.
5. **`count()+1` 세 자리 이관은 기존 e2e 를 깨지 않는다** — 번호 단언이 정규식 둘뿐이고 형식·자리수가 같다(실측). **유일한 회귀 위험은 G-3(카운터 행 잠금 × 기본 5초 트랜잭션)** 이고, PR ① 에 `timeout` 한 줄로 닫힌다. 「차이가 크다」는 셋째(문의)에 걸리는 것 ✅ 동의하되, I-1 때와 같이 **plan.md 본문 수정 4건은 별도로 남는다.**
