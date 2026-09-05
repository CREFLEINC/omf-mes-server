# I-3 재검토 — **통합 관점** (잠금 순서·마이그레이션·모듈 방향·인계·e2e 정리)

> 대상 `I-3.md` · 브리프 `brief-I-3-review.md`. 계약 사본 `a6a87e1` 읽기 전용. 실측 2026-09-06.
> 판정 축: **부모 `FOR UPDATE` 가 I-2 `replaceLines`·입고와 교착 없이 서는가 · `LotService` 이관 방향이 규칙을 깨지 않는가.**

## 0. 실측 근거표 (DB 안 건드림 — 파일·grep 만)

| 잰 것 | 결과 |
|---|---|
| 두 모듈의 imports | `TraceModule` = `Prisma`·`Idempotency` **둘뿐**·`exports` 없음(`trace.module.ts:13~16`) / `LogisticsModule` = trace 를 안 본다(`logistics.module.ts:22`) ⇒ **DI 순환은 안 생긴다** |
| 도메인 간 service 호출 규칙 | ⛔ `docs/server-architecture.md:67` 「**도메인이 다른 도메인의 service 를 부르지 않는다. 공유가 필요하면 그것은 core 다**」 · 같은 문서 §1 스케치가 **`core/ … lot-genealogy`** 를 이미 이름으로 갖는다 |
| `replaceLines` 의 부모 잠금 위치 | `purchase-order.service.ts:210` `updateMany(version_no+1)` — 라인 읽기(:216)·삭제(:228)보다 **앞** ✓ |
| 입고가 `received_qty`·`purchase_order` 를 만지나 | **0건**(grep `received_qty|FOR UPDATE` 전 소스) — `receipt-posting.ts` 도 `inbound_receipt` 를 UPDATE 하지 않는다 ✓ |
| `app.qty_t` | `numeric(20,6) **CHECK (VALUE >= 0)**`(baseline:59) · `purchase_order_line.received_qty app.qty_t`(baseline:927) |
| `app.code_t` | `varchar(50) CHECK (VALUE <> '')` — **도메인에 NOT NULL 이 없다**(baseline:50) ⇒ 컬럼 `DROP NOT NULL` 로 충분 |
| `logistics` 인덱스 전건 | `ix_inbound_receipt_supplier_date` · `ix_inbound_line_po` **둘뿐** — `inbound_variance.inbound_receipt_line_id` 에 인덱스 **없다** |
| e2e 정리에 걸리는 FK | `document_issue_log.lot_id → trace.lot`(baseline:2651) · `goods_receipt_line.inbound_receipt_line_id`(baseline:1300, `lot_id NOT NULL`) |
| P/O e2e 의 입하 라인 픽스처 | `logistics-purchase-order.e2e-spec.ts:625` 주석 「**P/O 라인의 `received_qty` 는 0 그대로 두고** … 누계 갱신은 I-3 몫」 |
| 문의 번호 | `docs/design-inquiries/` = 016·017·018·019·021·022·023·025(020·024 결번) · 입하 상태 축 문의 **0건** ⇒ 026 은 새 번호 ✓ |
| 01 도메인 화면 | 26장 전수 — **저장된 입하를 다시 여는 화면이 없다**(`M-01-01` 은 등록 폼 · §5-4 가 「등록의 결과」로 끝) |

## 1. I-3.md 가 놓친 것 — 여섯 (구현 전에 고쳐야 뒤가 안 뒤집힌다)

### G-1 ⛔ `LotService` 를 **도메인 간 직접 호출**하는 것은 규칙 위반이다 — 순환이 아니라 «방향»이 문제
§5-1·§9 #8 은 「`TraceModule` 이 `LotService` 를 export, `LogisticsModule` 이 import」로 적었다.
**순환은 실측상 없다**(위 표) — 그러나 `server-architecture.md:67` 이 그 호출 자체를 금지했고, `plan.md` §3 은
승인 코어 칸에 그 이유를 그대로 적었다(「**도메인 간 service 호출 금지** — 9 상신자가 7 도메인」).
「사용처가 둘이라 코어로 승격하지 않는다」는 근거도 `plan-integration.md` §2 의 기준과 어긋난다 — 그 기준은
「두 번째 사용처가 계약에 실재하고 3슬라이스 안에 오면 첫 번째에서 만든다」인데 **둘째 사용처(`POST /trace/lots`)는
이미 구현돼 있다.** ⇒ ✏ **`createWithin(tx, …)` 을 `src/core/lot/`(아키텍처가 이름 지은 `lot-genealogy`) 에 두고
`TraceModule`·`LogisticsModule` 이 «둘 다 core 를» import** 한다. 덤이 둘 — ① `TraceModule` 에 `exports` 를 안 붙여도 된다
② `inbound_receipt_line.lot_id` 백필도 core 로 가서 **trace 가 logistics 표를 쓰는 역방향 쓰기**(§5-1 「`lot.service.ts` 에 3줄」)가
사라진다. 줄 수는 그대로(~28줄)이고 `plan.md` §3 코어표에 한 행이 는다.

### G-2 ⛔ 부모 `FOR UPDATE` 를 걸면서 `$transaction` 시한을 안 건다 → **P2028 이 500 으로 샌다**
`plan.md` §3 채번 칸이 **이미 같은 실패를 적었다**(「행 잠금이 전표 커밋까지 → Prisma 기본 5초 → `P2028` 이 재시도 루프를
빠져나가 500」). I-2 는 카운터를 트랜잭션 밖으로 빼 그 실패를 없앴는데(`numbering.service.ts:44~50`),
**I-3 이 «다른» 행 잠금으로 되살린다** — `purchase_order` 부모 잠금은 커밋까지 간다. `P2028` 은
`prismaErrorResponse` 가 보는 셋(P2003·P2002·P2025 — `prisma-error.ts:32~62`)에 없어 `undefined` → **500**.
⇒ ✏ 등록·치환·`:split` 셋 다 `this.prisma.$transaction(fn, { timeout: 15_000, maxWait: 5_000 })`.
⚠ 이걸 안 넣으면 §8 PR ② 의 `⭐ 입하 등록과 P/O 라인 치환을 동시에 걸어도 500 이 없다` 가 **간헐 실패**한다.
§8 PR ④ 파일표에도 같은 줄이 필요하다(치환이 같은 잠금을 쓴다).

### G-3 ⛔ 손검사가 «상한»만 본다 — `app.qty_t` 의 **하한**이 같은 500 경로로 샌다
§3-3 은 `ck_po_line_received`(상한)만 앞당긴다. 그런데 §3-1 의 «차분»은 `received_qty` 를 **내린다**.
`received_qty` 는 `app.qty_t` = `CHECK (VALUE >= 0)` 이고 도메인 CHECK 위반도 `PrismaClientUnknownRequestError` 라
**`ck_po_line_received` 와 똑같이 500 이다**(`prisma-error.ts:23` 주석이 그 사실을 적었다).
실제로 내려갈 수 있다 — **I-3 이전에 심긴 입하 라인은 `received_qty` 를 올린 적이 없다**(P/O e2e:625 가 그 실물이고,
하노이의 이관·수기 행도 같은 자리다). 그런 라인을 치환에서 지우면 `0 - 5 < 0` 이다.
⇒ ✏ §3-3 에 하한 한 줄: 잠근 뒤 `received_qty + Δ < 0` 이면 400(`RANGE`, field `items.{i}.receivedQty`).
⛔ **조용히 0 으로 깎지 않는다** — 깎으면 누계가 영영 틀린 채로 남는다(§2 2단계 기준 4). 단위 테스트 1줄.

### G-4 ➕ 잠금 «순서»가 두 자리에서 빠졌다 (등록만 적혔다)
ⓐ **치환(PR ④)의 순서를 못 박아야 한다** — `inbound_receipt` 버전 범프 → **P/O 부모(옛∪새 합집합, `purchase_order_id`
오름차순) `FOR UPDATE`** → `inbound_receipt_line` 쓰기. 뒤집으면 I-2 와 교착한다: `replaceLines` 는 부모 P/O 를 잠근
**뒤**(:210) `purchase_order_line` 을 DELETE 하는데(:228) 그 DELETE 의 RI 검사가 **`inbound_receipt_line` 행에
`FOR KEY SHARE`** 를 잡는다 — 즉 I-2 는 「P/O → 입하 라인」 방향이다. I-3 이 「입하 라인 → P/O」 로 잡는 순간 교착이다.
ⓑ **불변식이 어디에도 안 적혀 있다** — 「`purchase_order_line` 을 쓰는 모든 경로는 부모 `purchase_order` 를 먼저 잠근다」.
지금은 «우연히» 성립한다(:210 · :157 · `create` 는 새 행). **I-5 취소가 `received_qty` 를 되돌릴 때 이걸 모르면 깨진다**
⇒ 코드 주석 + 인계(G-6 ⓐ).
ⓒ ⭕ 나머지는 동의 — `ORDER BY … FOR UPDATE` 는 Postgres 가 `LockRows` 를 `Sort` «위»에 두므로 정렬 순으로 잠근다.
**I-2 코드를 안 고친다**도 동의(:210 이 라인 접근보다 앞이라는 것이 실측으로 참).
ⓓ **입고 교차는 없다** — 입고가 `received_qty` 도 `purchase_order` 잠금도 안 쓴다(grep 0건). 입고가 입하 라인에 거는 것은
FK 삽입의 `FOR KEY SHARE` 뿐이라 §7-4 가드(스냅숏 count)와 경합하면 **DELETE 가 FK 위반(P2003)으로 떨어진다** —
500 은 아니나 문구가 「참조하는 대상이 없습니다」로 **반대 방향**이다(`prisma-error.ts:33`). 막지 말고 「알려둘 것」 한 줄.

### G-5 ✏ e2e 정리 순서(§6-5)에 표 **셋**이 빠졌고, 한 자리는 ⭐ 단언과 충돌한다
① **`app.document_issue_log`** — `lot_id → trace.lot` FK(baseline:2651). PR ③ 의 `labelIssued` 단위·e2e 가 이 표를 심는다.
   ⇒ ④(`trace.lot`) **앞**에 한 줄.
② **`logistics.goods_receipt_line` · `goods_receipt`** — PR ④ 의 `SUCCESSOR_EXISTS` e2e 3건이 입고를 «붙여야» 성립한다.
   `goods_receipt_line.inbound_receipt_line_id` FK 라 ②(`inbound_receipt_line`) **앞**이다.
③ ⛔ 그 입고를 **API 로 만들면 안 된다** — 원장이 생겨 §8 의 두 `⭐ inventory_transaction 이 0건` 단언이 거짓이 되고
   `TRUNCATE inventory.inventory_transaction_line, … CASCADE`(파티션이라 DELETE 불가 — `logistics-goods-receipt.e2e-spec.ts:573~577`)
   까지 끌려온다. ⇒ **`goods_receipt`·`goods_receipt_line` 을 직접 INSERT**(`lot_id NOT NULL` 이라 입하가 만든 LOT 을 그대로 쓴다).
   이 한 줄이 「원장 0건」 단언을 지킨다.
⭕ ②가 ④보다 먼저라는 판정(A3 FK) · `IRE2E` 접두 겹침 0 · P/O e2e 무해 · `numbering_counter` 안 지우기는 동의.

### G-6 ➕ **인계(R-12 식) 절이 «없다»**
I-2 는 R-12 로 셋을 넘겼고 I-3 이 ①②를 받았다(§6-5·§3-4 ✓). **③(`docs/data-model/` 재생성)은 안 받았다** —
I-3 이 마이그레이션 둘을 더하니 그 대기 목록이 늘어난다(§7-5 ⓐ 가 절반만 적었다).
그리고 I-3 이 «넘길» 것이 최소 넷이다 — ⓐ **I-5**: `received_qty` 되돌림도 부모 P/O 오름차순 `FOR UPDATE` + 하한 손검사(G-3)
ⓑ **I-5**: `inbound_receipt.status_code` 축을 `transitions.ts` 에 여는 것 · 그때 §7-4 의 임시 자물쇠를 걷을지 재판정
ⓒ **I-5**: 취소가 `lot_id` 가 가리키는 LOT(이미 입고·원장에 닿았다)을 어떻게 두나 — §5-1 이 만든 새 결손
ⓓ **I-4/I-12**: `POSTED` 축이 서면 입고가 입하를 옮겨야 하는가(026 의 넷째 갈래).
⇒ §9 뒤에 「인계」 절 하나. 없으면 I-5 가 잠금 규약을 모르고 짠다 — I-2 가 R-12 ② 를 남겨 준 것과 같은 이유다.

## 2. 브리프 판정 7항목

1 문의 = **✅ 026 은 새 문의**(+ ⚠ 「둘째 025」 한 자리 — §3) · 2 마이그레이션 = **✅ 동의 + 보강 1**(§4) ·
3 P/O 귀속·잠금 = **✏ G-2·G-3·G-4** · 4 `:split`·차이 = **✅ 전건 동의**(§5) · 5 LOT·상태 = **✏ G-1 + 구멍 둘**(§5) ·
6 PR 5개·순서·테스트 목록 = **✅ 동의 + 단위 3줄 추가** · 7 어긋남 = **`plan.md` 4건 동의 + `plan-integration.md` 1건 추가**(§6)

## 3. 문의 (브리프 1) — ✅ 026 신규 · ⚠ 「둘째 025」가 하나 더 있다
026 ✅ — 016~025 · 보낸 1~15번 · `계약-되돌림-mdm.md` 에 입하 상태 축을 묻는 자리가 **0건**(grep). 023 과 **합치지 않는** 판정도 ✅:
023 본문이 「취소 두 값은 **묻지 않는다**」로 스스로 좁혔고, 026 은 그 두 값과 `POSTED` 를 함께 묻는다(자원도 다르다).
`:split` 원본 처분 **철회** ✅ — 요청 스키마 다섯 칸에 원본을 가리키는 것이 없다(실측). ⛔ 「올리지 않는 것」 5건도 동의.
⚠ **「알려둘 것」에 없고 문의로 서야 할 자리가 하나 더 있다** — §6-1 이 `PUT …/{id}`·`PUT …/lines` 의 403 을 **`M-01-01`**
로 등록하며 든 근거(「등록 폼 안의 라인 그리드」)는 **I-2 재수립 R-11 이 P/O 에서 정확히 그 오인을 정정한 문장**이다
(`plan-uiux.md` U4 의 두 칸을 「— (025)」로 고쳤다). 01 도메인 화면 26장 실측 — 저장된 입하를 다시 여는 화면이 없다.
⇒ **025 와 같은 갈래의 입하판**이다. 026 에 갈래 ④로 붙이는 편이 낫다(자물쇠 물음과 뿌리가 같다).
⛔ 이건 취향이 아니라 **구현에 걸린다** — `manual-permissions.ts` 두 줄의 화면 ID 가 그 답에 매달려 있고,
`M-01-01` 로 두면 **등록 권한자가 곧 수정 권한자**가 된다(그 화면에 수정 진입이 없는데도).

## 4. 마이그레이션 (브리프 2) — ✅ 동의, 보강 하나
- **forward-only ✓ · 두 릴리스 규칙 미해당 ✓** — 삭제 0 · 조임 0. `reason_code DROP NOT NULL` 은 **카탈로그 변경**이고
  `lot_id` 는 새 널 컬럼이라 **재작성 0**. 하노이 기존 데이터에 무해하다.
- ✅ **`app.code_t` 에 NOT NULL 이 없다**(baseline:50)는 것을 실측 확인 — 도메인 쪽을 손댈 필요가 없어 초안 그대로 선다.
- ✅ FK 이름 안 짓기 · `@@index(map:)` · **`onDelete: NoAction, onUpdate: NoAction`**(I-2 R-5)이 §2-6 스니펫에 이미 반영됨.
- ✅ **행 N(`x-no-code-key` nullable)을 안 거는 판정 동의** — 계약이 `required` 로 적은 칸은 nullable 이 문제를 옮길 뿐이다.
  §0 #10 을 「계약이 `required` 로 **안** 적은 자리에만 선다」로 좁히자는 §9 #6 도 동의.
- ➕ **한 줄 더**: `inbound_variance.inbound_receipt_line_id` 에 **인덱스가 없다**(실측 — `logistics` 인덱스는 둘뿐).
  `GET …/variances` 와 §7-4 의 자식 count 가 둘 다 이 축이다. 같은 파일에 `CREATE INDEX ix_inbound_variance_line` 한 줄
  (+ `@@index(map:)`). 추가라 규칙에 안 걸린다. ⚠ `schema.prisma` 의 `reason_code String?` 을 읽는 코드는 **0건**(grep) — 회귀 없음.

## 5. `:split`·차이(브리프 4) ✅ · LOT(브리프 5) — 구멍 둘
§4 전건 동의 — 한 트랜잭션·채번 2회 밖·초과분 `purchase_order_line_id` NULL·`exceptionTypeCode` 요청값·`varianceQty` 상한 없음·
차이가 `received_qty` 와 라인 상태를 안 건드림. 전이 0 → `transitions.ts` 미등록 ✅, §7-4 의 계약 밖 자물쇠도 ✅(기준 2 · 자식 셋을 다 보는 것이 I-2 R-6 의 복제로 맞다).
- ⛔ ⓐ **미부착 라인의 `lot_id` 를 두 번 채울 수 있다.** `POST /trace/lots` 를 같은 라인에 두 번 부르면 둘째가 첫째를 덮어
  **첫 LOT 이 고아**가 된다 — `trace.lot` 에 `(source_type_code, source_id)` 유일 제약이 없다는 것을 §2-6 ⓐ 가 스스로 적었다.
  ⇒ `updateMany({ where: { …, lot_id: null } })` + 0행이면 400 `STATE_LOCKED`. 단위 테스트 1줄.
- ⛔ ⓑ **한 요청 안의 공급사 LOT 중복** — 두 라인이 같은 `supplierLotNo` 면 `uq_lot(plant_id, lot_no)`(baseline:1067)로 P2002 이고
  **트랜잭션이 통째로 죽는다**. 손으로 먼저 갈라 `lines.{i}.supplierLotNo` 를 짚는다(§1-5 가 코드는 이미 잡았다).
- ⭕ ⓒ 추출 자체는 동의 — 재시도 루프는 `insert` 가 «매번 새 트랜잭션»이라 성립하는 구조(`lot.service.ts:177~191`)이고
  입하가 만드는 것은 `SUPPLIER` 축이라 재시도가 없다(:186 이 400 으로 끝낸다). 다만 `assertWritable` 이 `this.prisma` 를 쓰므로(:318)
  **`createWithin` 안의 읽기는 반드시 `tx`** 로 — 같은 트랜잭션이 방금 만든 라인을 못 본다.

## 6. 계획서 어긋남 중 «구현에 영향 주는 것» (브리프 7)
`plan.md` 4건(§4 에 완화 한 줄 · 행 N 조건 좁힘 · §1 PR 3→5 · §7 에 026 한 행)은 §9 가 적은 대로 ✅ 동의.
➕ **`plan-integration.md` 는 0건이 아니다** — §6-3 마이그레이션 표(M-a~M-g **7건**)에 **I-3 행이 없고** 그 절이 「실측으로 필요한 것은
7건뿐」이라 못박았다. I-3 한 행(A3 + variance 완화 + 인덱스)을 더하거나 그 문장을 고쳐야 한다.
➕ §6-2 병렬 표의 「I-3 ∥ I-12 … `logistics.module.ts` **한 줄** 충돌」은 **두 줄**이 된다(core LOT import 가 는다) — 재베이스 비용은 그대로.
➕ 단위 테스트 3줄 추가: `귀속 — 차분이 0 미만이면 400 이다(qty_t 하한이 500 으로 새지 않는다)` ·
`치환 — 부모 P/O 를 «먼저» 잠근 뒤 입하 라인을 만진다(I-2 의 RI FOR KEY SHARE 와 같은 방향)` ·
`LOT — 이미 lot_id 가 있는 라인에 다시 채우면 400 이다`.

---

## 7. 재수립 결과 — 5줄 요약
1. **I-3.md 에 반영할 수정 6건** — ①§5-1·§9 #8 의 `TraceModule→LogisticsModule` 을 **`src/core/lot/`(아키텍처가 이름 지은 `lot-genealogy`)** 로 바꾼다(`server-architecture.md:67` 도메인 간 service 호출 금지 · DI 순환은 실측상 없으나 «규칙»이 막는다 · 덤으로 trace→logistics 역방향 쓰기가 사라진다) ②§3-2 에 `$transaction(fn,{timeout:15_000,maxWait:5_000})`(부모 잠금이 커밋까지 가고 `P2028` 은 `prisma-error.ts` 셋에 없어 500 이다 — `plan.md` §3 이 이미 적은 실패의 재발) ③§3-3 에 **하한 손검사**(`app.qty_t CHECK(VALUE>=0)` · 차분이 음수로 내려가면 상한과 똑같은 500 경로 · 0 으로 깎지 않는다) ④§3-2 에 **치환의 잠금 순서**(부모 IR → P/O 부모 옛∪새 오름차순 → 입하 라인) + 「`purchase_order_line` 을 쓰는 경로는 부모를 먼저 잠근다」 불변식 명기 ⑤§6-5 에 `document_issue_log`·`goods_receipt_line`·`goods_receipt` 세 줄 + 「입고 픽스처는 API 가 아니라 직접 INSERT」(안 그러면 두 `⭐ 원장 0건` 단언이 거짓이 된다) ⑥§9 뒤에 **인계 절**(I-5 셋 · I-4 하나 · `docs/data-model/` 재생성 — I-2 R-12 ③ 승계).
2. **plan.md 에 반영할 것 4건 동의**(§4 완화 한 줄 · 행 N 조건 좁힘 · §1 PR **3→5** · §7 에 026) ➕ **`plan-integration.md` 1건** — §6-3 마이그레이션 표 7건에 **I-3 행이 없다**(「7건뿐」이라 못박은 문장). §6-2 의 「`logistics.module.ts` 한 줄 충돌」은 두 줄.
3. **문의 최종 1건(026) ✅ + 갈래 하나 추가 권고** — 016~025·보낸 1~15번에 입하 상태 축 0건이고 020·024 는 결번이라 번호 충돌 없음. 023 과 합치지 않는 판정 ✅, `:split` 원본 처분 철회 ✅, ⛔ 5건 ✅. ⚠ **「저장된 입하를 다시 여는 화면이 없다」**(01 도메인 26장 실측)를 026 의 갈래 ④로 붙인다 — I-2 R-11 이 P/O 에서 정정한 것과 같은 오인이 §6-1 의 403 매핑(`M-01-01`)에 그대로 들어 있다.
4. **마이그레이션 동의** — forward-only ✓ 두 릴리스 미해당 ✓(삭제·조임 0 · 재작성 0 · 하노이 무해) · `app.code_t` 에 NOT NULL 이 없어 컬럼 `DROP NOT NULL` 로 충분(실측) · FK 이름·`@@index(map:)`·`onDelete: NoAction` 이미 반영 · 행 N 을 안 거는 판정과 §0 #10 좁히기 ✅. ➕ **`ix_inbound_variance_line` 한 줄**(그 축에 인덱스가 없다 — `GET …/variances` 와 §7-4 가드가 둘 다 탄다).
5. **잠금 판정은 방향이 옳다** — 부모 `purchase_order` 오름차순 `FOR UPDATE` 는 `replaceLines`(:210)와 **같은 자물쇠·같은 방향**이고 I-2 코드를 안 고쳐도 된다(실측 확인). **입고와의 교차도 없다**(입고는 `received_qty` 도 P/O 잠금도 안 쓴다 — grep 0건). 남은 위험은 «잠금 자체»가 아니라 **그 잠금이 만든 대기**다 — 시한 없는 5초 트랜잭션(②)과 하한 없는 차분(③) 둘이고, 둘 다 500 으로 새며 둘 다 한 줄씩으로 닫힌다.
