# I-21 3관점 재수립 — **통합 관점** 독립 리뷰

> 대상: `docs/coverage-100/slices/I-21.md` **901줄 전문**(PR **#416** · 브랜치 `docs/coverage-100-a-i21-plan` · 계획 커밋 **5edc559**).
> 관점: 물리 모델 · 마이그레이션 · 트랜잭션 경계 · 상태기계 · 원장/재고 파급 · 슬라이스·레인 선후 · 공용 파일 충돌 · 멱등/잠금 · 성능.
> 정본 — `docs/coverage-100/plan-integration.md` · `prisma/migrations/**` · `prisma/schema.prisma` · `src/core/**` · **실 DB**(`postgresql://postgres@127.0.0.1:55432/omf_mes`).
> 독립성 — `I-21-review-api.md`·`I-21-review-uiux.md` **열지 않았다.** 코드·계약·마이그레이션 수정 0 · DB 쓰기 0 · PR 생성/코멘트/병합 0 · 통보문 0.
> 실측일 **2026-09-08** · `main` **03f0166** · HEAD **5edc559** · 계약 사본 `contracts/COMMIT.txt` = **a6a87e1**.
> ⚠ 주 저장소의 미커밋 3파일(`.env.example`·`.gitignore`·`deploy/HANDOFF.md`)은 **건드리지 않았다.**

---

## 0. 판정 요약

| | 수 |
|---|--:|
| **채택**(계획안이 맞다 — 확인 도장) | **9** |
| **반증**(계획안이 틀렸다 — 고쳐야 한다) | **8** |
| **유지**(계획안 그대로 두되 조건·보완이 붙는다) | **6** |

| 심각도 | 건수 |
|---|--:|
| **Blocker** | **2** |
| **Major** | **6** |
| Minor | 11 |
| Nit | 4 |

⭐ **한 줄** — 계약 읽기(§1)와 심장 설계(§3)는 튼튼하다. 무너지는 곳은 **전부 「물리·순서·공용 파일」쪽 넷**이다:
**ⓐ 존재하지 않는 스키마(`app.code_value`)** · **ⓑ 계획에 없는 파일(`test/document-state.e2e-spec.ts`)** ·
**ⓒ 서로를 깨는 두 PR(M-h ↔ ④)** · **ⓓ 이미 물리에 있는 칸을 「없다」고 잰 자리(`mdm.warehouse.is_defect`)**.
넷 다 **구현 첫 PR 이 뜨기 «전에»** 고칠 수 있다.

---

## ⭐ 1. 브리프 §2 — 뒤집기 셋 + 정한 것 둘 (개별 판정)

### 1-1. 「`plan-api.md:871` 과 `I-19.md` §11 ③ 이 틀렸다」 → ✅ **채택**

**재측정했다**(계획서 문장을 근거로 쓰지 않았다). `python3` 으로 계약을 덤프한 결과:

```
contracts/quality-03품질.json
  POST /quality/nonconformances/{nonconformanceId}/disposition-decisions .description
  → 「⭐ 판정 저장과 Lot Status 전이는 한 트랜잭션이다(공유계약 B-8) …
     ⭐ 도착 상태는 처분에 따라 갈린다 — 재작업 → INSPECTION_PENDING(검사 대기) ·
     폐기 → SCRAPPED(폐기) · 정상 → NORMAL(정상). 값 목록은
     GET /mdm/code-values?codeGroupCode=LOT_STATUS 가 갖는다.」
```

⇒ 계약은 **도착 상태를 직접 적었다.** `docs/coverage-100/plan-api.md:871`(「`SCRAPPED` 로 가는 전이도 계약에서 못 찾았다 …
계약이 LOT 상태를 옮긴다고 적지 않았다」)과 `docs/coverage-100/slices/I-19.md:610-616`·`:77` 의 같은 문장은 **실측으로 틀렸다.**
**없는 것은 `transitionCode` 뿐**이라는 계획안의 결론이 맞다.

⚠ **함께 낡는 자리 하나를 계획안이 안 적었다** — `src/core/document-state/transitions.ts:188` 의 주석
「⛔ `SCRAPPED` 는 `from` 에도 `to` 에도 없다 — **계약이 어느 오퍼레이션에도 적지 않았다**」가 **거짓이 된다.**
PR ④ 가 그 주석을 고쳐야 한다(§7-1 의 `transitions.ts` +20 에 그 몫이 없다). ⇒ **m-5**.

### 1-2. 「잔량 초과는 400 이 아니라 409 `DISPOSITION_QTY_EXCEEDED`」 → ✅ **채택**

실측(python):

| 봉투 | `code` enum | 관련 프로퍼티 |
|---|---|---|
| `QualityConflictResponse` | `VERSION_CONFLICT`·`DUPLICATE_KEY`·`INVALID_STATE`·`DUPLICATE_HOLD`·`HOLD_QTY_EXCEEDED`·**`DISPOSITION_QTY_EXCEEDED`** | `conflictingLotId`·**`remainingQty`**·**`remainingQtyUomId`**·`currentVersion`·`currentLotStatusCode`·`conflictCause` |
| `ShipmentConflictResponse` | `VERSION_CONFLICT`·`DUPLICATE_KEY`·`INVALID_STATE`·`ALREADY_CONFIRMED`·`CANCEL_IN_PROGRESS` | `currentVersion`·`conflictCause` |

판정 저장의 409 는 `QualityConflictResponse` 로 선언돼 있고 그 enum 이 값을 **가지고 있다.**
`plan-integration.md:389`(「계약이 말하지 않는다 → 2단계 기준 2 → **400**」)은 **틀렸다.** 계획안이 맞다.

⇒ `plan-integration.md:389` 를 통합자가 고쳐야 한다(계획안 §10-1 #6 이 이미 그렇게 적었다 — **채택**).

### 1-3. 「`plan.md` §4 에 I-21 행이 없는데 `plan-integration.md:185` 만 「마이그 있음」이라 셋이 서로 다르다」 → ⛔ **반증**

**칼럼을 한 칸 밀려 읽었다.** `docs/coverage-100/plan-integration.md:162-163` 의 머리와 범례가 실측이다:

```
범례 — 표: 있음 / 결손(마이그레이션 필요) · 원장: posting 을 부르는가 · 상태기계: transitions.ts 에 칸을 더하는가 · PR: …

| # | 슬라이스 | 건 | 선행 | 표 | 마이그 | 원장 | 상태기계 | PR |
```

I-21 행(`:185`)은
`| I-21 | 부적합·처분·특채 | 11 | I-20 | 있음 | ✕ | ✕(폐기는 I-4 재사용) | ⭕ | 3 |`
⇒ **표 = 있음**(물리 표가 실재한다) · **마이그 = ✕** · 원장 = ✕ · 상태기계 = ⭕ · PR = 3.

⇒ **`plan-integration.md:185` 는 「마이그 있음」이라 적지 않았다. 「마이그 ✕」다.**
`plan.md` §4(원래 I-21 행 없음)와 **정확히 일치**한다 — **셋이 서로 다르지 않았고, 둘이 같았다.**
계획안 §0 머리(13행) · §2-5 머리 · §10-1 **#1** · §10 「왜 9 인가 ⓐ」의 전제가 전부 이 오독 위에 서 있다.

같은 오독이 하나 더 있다 — §10-1 **#7** 이 「`plan-integration.md:185` — 원장 ✕ · **posting ✕** · 상태기계 ⭕ | 같다」라 적었는데
그 표에 **`posting` 칼럼은 없다**(원장 칼럼 하나가 「posting 을 부르는가」다). 없는 칼럼과 「같다」를 판정했다.

⇒ **판정: 「마이그 0 이 정본이었고 I-21 이 그것을 «바꾸는» 것」이 옳은 서술이다.**
「셋이 서로 다르다」는 문장을 §0·§2-5·§10·§10-1 네 자리에서 걷어내라. 마이그 2항목을 세우는 **결론 자체는 유지**한다(§1-6·§2-3 실측이 뒷받침한다).

### 1-4. 「`C17`·`C18`·`C19` 를 새로 만든다」 → ⚠ **조건부 채택**(값은 옳다 · **전달 경로 3건이 깨진다**)

**값 판정은 채택.** 시드·실 DB 를 다 재서 확인했다:

```
psql omf_mes → LOT_STATUS_TRANSITION 활성 9값 = C4,C5,C6,C7,C8,C9,C10,C14,C15   (to=SCRAPPED 0개)
                LOT_STATUS           활성 4값 = NORMAL,INSPECTION_PENDING,DEFECTIVE,SCRAPPED
                NONCONFORMANCE_STATUS 활성 3값 = NOT_REQUESTED,PENDING_DECISION,DECIDED
                CONCESSION_STATUS · DISPOSITION_TYPE → 그룹 자체가 없다
```

3안 비교표의 B(기존 9종으로 접기)는 **성립 불가**가 맞고(폐기가 접힐 코드 0개), C(전이 안 걸기)는 계약 문자에 정면으로 어긋난다.
`C16` 까지 도식이 쓰므로 **다음 빈 번호 = `C17`** 도 맞다(`W-03-02:183-186`).

⛔ **그런데 그 값을 «어디에 어떻게 심는가»가 셋 다 깨진다** — B-1 · B-2 · M-1 을 보라.

### 1-5. 「특채 `concession.status_code` = `'APPROVED'`」 → ✅ **채택**(근거가 계획안보다 «강하다»)

계획안은 「`app.approval_request.status_code` 가 이미 쓰는 값이라 새 개념 0(2단계 기준 5)」이라고만 적었다.
**계약이 그 자리를 직접 적어 두었는데 계획안이 인용하지 않았다** — `Concession.statusCode` 의 `x-no-code-key`(실측):

> 「코드 그룹을 세우지 않는다 — 특채의 승인 상태는 `approval_request` 가 갖는다(`approval_request_id` 가 **NOT NULL**).
> **값 후보 셋이 `APPROVAL_REQUEST_STATUS` 와 정확히 겹치고**, 이 리소스를 움직이는 오퍼레이션이 **0건**이다.
> ⭐ `usable` 은 「상태 유효 ∧ `validTo` ∧ 잔여>0」 3항 논리곱이라 만료·소진은 이 축이 아니다.」

⇒ ⓐ `'APPROVED'` 는 **우리가 정한 값이 아니라 계약이 지시한 값**이다(§2 **0단계**에서 닫힌다 — 1-1단계로 갈 자리가 아니었다).
ⓑ 「시드 그룹을 세우지 않는다」도 계약 문자다. ⓒ `usable` 3항 논리곱도 계약 문자다.
⇒ **판정 유지, 근거를 이 문장으로 교체하라.** 통보 089 §2 는 「정했다」가 아니라 「계약이 이미 적었다 — 회신 대기 12 는 그것으로 닫힌다」가 된다.

⚠ 부수 — 물리 `quality.concession.approval_request_id` 는 **NOT NULL**(baseline `:2050` · `schema.prisma:3104` · 실 DB 확인)이고
`fk_concession_approval` 로 `app.approval_request` 를 가리킨다. **e2e 픽스처 C1~C5 는 `approval_request` 행을 먼저 세워야 한다.**
계획안 §8-1 의 정리 순서(`deleteMany` 역순 13표)에 **`approval_request` 가 없다.** ⇒ **m-7**.

---

## ⭐ 2. 브리프가 지정한 네 자리

### 2-1. `transitions.ts` 키 신설 1 + 전이 5 · `document-state.spec.ts` 41 → 46 → ⚠ **유지 · 결함 3**

**개수는 맞다.** `src/core/document-state/transitions.ts` 전문을 손으로 셌다 —
축 **16**(equipment 1 · mold 1 · routing 2 · production_plan 1 · lot.lifecycle 3 · inspection_result 1 · **lot.status 9** ·
work_order 6 · work_session 3 · approval_request 2 · goods_issue 3 · inbound_receipt 2 · goods_receipt 2 · breakdown 2 ·
maintenance_order 1 · putaway_task 2) = **전이 41**. `document-state.spec.ts:423` `toHaveLength(41)` 과 일치.
`+5`(부적합 축 2 + LOT 축 3) → **46**, 축 **17**. 산술 ✓.

`from = ['NORMAL','INSPECTION_PENDING','DEFECTIVE']` 판정도 유지한다 — `stock-reinstate`(`:218`)가 이미 `DEFECTIVE` 발신
전이를 갖고 있어 「Hold 발신 0」과 부딪히지 않는다는 계획안의 논증이 실측으로 맞다.

⛔ **결함 셋**:
1. **`test/document-state.e2e-spec.ts` 가 계획 전체에 0회 등장한다** → **B-2**(아래).
2. **M-h ⓐ 없이는 그 e2e 가 빨갛고, ④ 없이도 빨갛다** → **M-1**(아래).
3. **레인 C 의 #403 이 «같은 두 줄»에서 부딪히고 «지금 통지를 기다리며 막혀 있다»** → **M-5**(아래).

### 2-2. M-h 가 하위 호환·순서 무의존인가 → ⛔ **반증**(둘 다 아니다)

| 항목 | 계획안 | 실측 판정 |
|:-:|---|---|
| ⓐ `INSERT INTO **app**.code_value` | 「선례 실재 — `20260901010000_add_lot_lifecycle_axis` 등이 `code_value` 를 넣는다」 | ⛔ **표가 없다**(`app` 스키마에 `%code%` 표 **0행** — 실 DB `information_schema` 조회). 정본은 **`mdm.code_value`**. ⛔ **선례도 없다** — B-1·M-4 |
| ⓑ `CREATE INDEX ix_disposition_decision_nonconformance` | FK 인덱스 부재 | ✅ **맞다** — `pg_indexes` 조회 결과 `quality.disposition_decision` 의 인덱스는 **`disposition_decision_pkey` 하나뿐**이다 |
| 「추가만 · 완화 0 · 삭제 0 · 백필 0 ⇒ **순서 의존 0**」 | | ⛔ **틀렸다** — ⓐ 는 **PR ④ 와 «양방향» 순서 의존**이다(M-1) |
| 「하위 호환」 | | ⓑ 는 ✅ 하위 호환. ⓐ 는 스키마를 고치면 하위 호환 ✅ |

### 2-3. 「`logistics.stock_reinstatement` 표가 물리에 없다」 → ✅ **채택**(사실)

```
grep -rn "stock_reinstatement" prisma/ src/ contracts/     → 0건
grep -rni "reinstat"           prisma/schema.prisma prisma/migrations/
  → prisma/migrations/20260901110000_stock_transfer_reason_remarks/migration.sql:3-4 의 «주석» 두 줄뿐
    (「요청: 계약 f736739 의 POST /logistics/stock-reinstatements」 · 「계약: … StockReinstatementCreate」)
```

⇒ 표는 **없다.** 계획안 실측 부록 #29 가 맞다. 그리고 **재등록은 `logistics.stock_transfer` 재사용**이 통합 계획서의 판정이다
(`plan-integration.md:187` — 「있음(재등록은 `stock_transfer` 재사용)」). ⇒ **§11 ① 의 「C 가 그 표를 세워야 한다」는 과한 인계다** —
C 는 표를 세우지 않고 `stock_transfer` 를 쓸 수 있다. 판정 #3 의 「NORMAL 갈래 롤업 원천 0」이라는 **결론은 그대로 유지**되지만
(재등록 오퍼레이션 자체가 아직 없으므로) **인계 문장은 「표를 세워야 한다」가 아니라 「재등록 오퍼레이션이 설 때까지 0이다」로 고쳐라.**

### 2-4. 「`quality.concession` 에 writer 가 0개다」 → ✅ **채택**(사실)

계약 7벌 전수 python 스캔 — `concession` 을 담은 경로는 **`GET /quality/concessions`·`GET /quality/concessions/{concessionId}` 둘뿐**이다.
POST·PUT·PATCH·DELETE **0건**. `Concession.statusCode` 의 `x-no-code-key` 도 「이 리소스를 움직이는 오퍼레이션이 0건이다」라 스스로 적었다.
⇒ **운영에서 이 목록은 빈 채로 뜬다** — 맞다. §2-6 의 「`concession` 에 인덱스를 안 건다」 판정도 그래서 옳다.

⚠ 다만 **`approval_request_id NOT NULL`** 과 겹치면 사실이 하나 더 나온다 — writer 가 0인데 **그 행은 결재 요청 없이는 설 수조차 없다.**
「빈 목록」이 아니라 **「구조적으로 채워질 길이 0인 목록」**이다. 통보 후보로 남긴다.

---

## 3. findings

### Blocker — **2건**

#### **B-1. `app.code_value` 는 존재하지 않는 표다 — M-h ⓐ 가 그대로 돌면 마이그레이션이 실패한다**

- 계획안 `§2-5` 항목 ⓐ: 「`INSERT INTO **app**.code_value`」
- 그리고 **`docs/coverage-100/plan.md` §4 의 M-h 행에도 같은 문자열이 실렸다**(계획 커밋 5edc559 가 추가) — **정본 두 곳이 함께 틀렸다.**
- 실측:
  - `prisma/schema.prisma:1630-1651` — `model code_value { … @@schema("**mdm**") }`
  - baseline `20260727000000:95-111` — `CREATE TABLE **mdm**.code_value (…) CONSTRAINT uq_code_value UNIQUE (code_group_id, code)`
  - 실 DB — `SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_name LIKE '%code%'` → **0행**
- ⇒ `INSERT INTO app.code_value …` 는 `relation "app.code_value" does not exist` 로 **즉시 실패**한다. `migrate deploy` 가 중단된다.
- **고칠 것**: `mdm.code_value`. 그리고 `code_group_id` 는 값이 아니라 **조회**여야 한다 — baseline 의 유일한 선례가 그 모양이다:
  ```sql
  INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
  SELECT cg.code_group_id, v.code, v.code_name, v.ord
    FROM mdm.code_group cg, (VALUES ('C17','처분 → 검사 대기(재작업)',100), …) AS v(code, code_name, ord)
   WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
  ON CONFLICT ON CONSTRAINT uq_code_value DO NOTHING;
  ```
  ⚠ `WHERE cg.group_code=…` 라 **그룹이 없는 DB 에서는 0행이 들어간다**(조용히). 그 자리가 M-1 과 물린다.

#### **B-2. `test/document-state.e2e-spec.ts` 가 계획 전체에 0회 등장한다 — PR ④ 가 그 파일의 «두» 단언을 깬다** (I-19 R-5 의 재발)

`grep -n "document-state" docs/coverage-100/slices/I-21.md` → **7행 전부 `transitions.ts` 와 `document-state.spec.ts`(단위)**다.
`document-state.**e2e**-spec.ts` 는 §7-1 파일 표에도, §8 e2e 표에도, §10 PR ④ 예산(20+6+2=28)에도 **없다.**

그 파일이 실 DB 를 상대로 거는 단언 셋을 직접 읽었다:

| `test/document-state.e2e-spec.ts` | PR ④ 뒤 결과 |
|---|---|
| `:38-61` `STATUS_GROUPS` — 축마다 코드 그룹 지도 | ⛔ **깨진다** — `quality.nonconformance.status_code` 가 지도에 없어 `:83` 이 「코드 그룹이 이 검사에 등록되지 않았다」를 `missing` 에 밀어 넣는다. **`'quality.nonconformance.status_code': 'NONCONFORMANCE_STATUS'` 한 줄을 더해야 한다** |
| `:99-118` 전이 코드 ↔ 시드 대조 | ⛔ **깨진다**(양방향 · M-1) |
| `:121-129` 「코드 그룹을 안 적은 축은 전이 코드를 싣지 않는다」 | ✅ 안 깨진다(부적합 축은 `transitionCode` 가 없다) |

⚠ **그 파일 머리의 주석이 이 사고를 이미 한 번 겪었다고 적어 두었다** — `:44` 「⚠ **I-1 이 결재 축을 열면서 이 표에 안 실어 검사가 「등록되지 않았다」로 이미 붉었다**」.
그리고 **`I-19.md` §0-재수립 R-5 가 «똑같은 자리»를 ⭐⭐ 로 잡았다**(「`test/document-state.e2e-spec.ts` 가 계획안에 없다 — PR ① 이 세 자리를 깬다」).
계획안은 I-19·I-20 을 정독했다고 §0 에 적었는데 **그 R 을 물려받지 못했다.**

⇒ **§7-1 에 넷째 파일**(`test/document-state.e2e-spec.ts` +2~4) · **§8-5 에 다섯째 spec** · **§10 PR ④ 예산 28 → ~34** 로 넣어라.
(선례 그대로 — `I-19.md:1032` 「코어 … `test/document-state.e2e-spec.ts` **3자리 갱신**(R-5)」)

---

### Major — **6건**

#### **M-1. M-h ⓐ 와 PR ④ 는 «서로를» 깬다 — 「순서 의존 0 · main 위에서 병렬」은 어느 순서로도 성립하지 않는다**

`test/document-state.e2e-spec.ts:99-118` 이 **양방향**으로 단언한다:

```ts
const seeded = await activeCodes(groupCode);                     // 실 DB 의 LOT_STATUS_TRANSITION 활성 코드
const used   = …registered().filter(축==trace.lot.status_code)
                 .map(e => e.transition.transitionCode)…;

expect(used.filter((code) => !seeded.includes(code))).toEqual([]);          // ① 표에 있는 코드는 DB 에 있어야 한다
expect(seeded.filter((code) => !used.includes(code)))                        // ② DB 에 있는 코드는 표가 써야 한다
  .toEqual(UNOPENED_TRANSITION_CODES[column] ?? []);                         //    (예외는 손으로 적은 ['C15'] 뿐)
```

| 병합 순서 | 결과 |
|---|---|
| **④ 먼저**(계획안 §6-2 가 「PR ④ 를 단독으로 뜨고 **먼저 병합**한다」라 명시) | ⛔ ① 이 깨진다 — `C17`·`C18`·`C19` 가 DB(`LOT_STATUS_TRANSITION` 활성 9값, 실측)에 없다 |
| **M-h 먼저** | ⛔ ② 가 깨진다 — 시드된 `C17`~`C19` 를 쓰는 전이가 없어 `UNOPENED_TRANSITION_CODES` 밖으로 샌다 |
| 둘을 **한 PR** 로 | ✅ 유일하게 초록 |

⇒ 계획안 §2-5 「**순서 의존 0**(`lanes.md` §1-2)」 · §10 「**M-h 와 ④ 만 `main` 위에서 병렬**이다」 · §6-2 「④ 를 먼저 병합한다」
**셋 다 반증된다.**

⭐ 더 나쁜 것 — **이 창이 열려 있는 동안 `main` 이 빨갛고, 레인 B·C 가 자기 게이트에서 그 빨강을 본다.**
`document-state.e2e-spec.ts` 는 계획안 §10 스스로가 「회귀 … 통합자가 병합 직전 한 번」에 넣은 파일이다.

⇒ **처방**: **M-h ⓐ 를 PR ④ 안으로 옮기고**(마이그 파일 + `seed.ts` + `transitions.ts` + 두 spec 을 한 PR·별 커밋),
**M-h ⓑ(인덱스)만 단독 마이그 PR** 로 남긴다 — ⓑ 는 어느 PR 과도 의존이 없다(순수 추가 인덱스).
그러면 「마이그가 든 PR 병합 전 한 줄 보고」 대상이 **둘**이 된다(`lanes.md` §3).

#### **M-2. `mdm.warehouse.is_defect` 는 «있다» — 판정 #4 의 전제가 무너지고, 계약이 `quantity` 를 그 축으로 정의했다**

계획안 판정 **#4** 와 실측 부록 **#27**:
> 「`mdm.warehouse` 에 「불량창고」를 가리는 칸이 **0개**(`is_defect` 류 없음 · `warehouse_type_code`·`management_level_code`·`is_external` 뿐)라
> `REQ-PR-0025` 「판정은 불량창고 입고 후」를 **창고 축으로 못 만든다** ⇒ **원천 축으로만 만든다**」 · 근거 = **baseline `:299-321`**

⛔ **틀렸다. baseline 을 쟀고 그 뒤 마이그레이션을 안 봤다** — I-20 R-24 와 **정확히 같은 유형**이다.

```
prisma/migrations/20260828000000_add_warehouse_is_defect/migration.sql:25
  ALTER TABLE mdm.warehouse ADD COLUMN is_defect boolean NOT NULL DEFAULT false;
prisma/schema.prisma:2314                is_defect Boolean @default(false)
실 DB information_schema.columns        mdm.warehouse.is_defect / boolean / false / NO   ← 실재
```

그 마이그레이션 머리가 **이 슬라이스가 찾던 축이라고 직접 적었다** — 「불량창고 여부. 요청: 이슈 **#47** · 확정 근거
**DR-012-불량창고유형 3-C(2026-08-13)** … 창고 유형과 «다른 축»이다」. `prisma/seed.ts:243` 은 `WAREHOUSE_TYPE` 의
`DEFECT`·`REWORK` 를 **`retired` 로 내리며** 「`is_defect`(#47)로 옮겼다」라 적었고(`:219-224`),
`src/mdm/logistics/warehouse.service.ts:104`·`:158` 이 **이미 그 칸을 필터·생성 입력으로 쓴다.**

그리고 **계약이 그 축으로 `quantity` 를 정의했다**(python 실측):
> `DispositionCandidate.quantity` — 「판정 대상 수량 — **그 LOT 이 «불량창고»에 들어온 수량이다**」

⇒ 계획안 §4-1 의 `sum(inventory_balance.on_hand_qty)`(**전 창고 합**)와 「잔액 창고가 둘 이상인 LOT 은 목록에서 뺀다」는
**계약이 required 로 요구한 값이 아니다.** 계약이 요구한 것은 **불량창고 한 곳의 잔액**이고, 그러면
`warehouseId`(required)를 「조용히 고르는」 문제 자체가 **처음부터 없다.**

⚠ **다만 오늘 데이터는 비어 있다** — 실 DB `mdm.warehouse` **0행**, `is_defect=true` **0행**. 그리고 `DEFAULT false` 라
운영 DB 의 기존 창고도 전부 false 다(그 마이그레이션이 「비어 보이는 쪽이 안전하다 — 운영에서 해당 창고를 켜면 된다」라 적었다).
⇒ **결론(원천 축 UNION)은 유지될 수 있다.** 그러나 **이유가 완전히 다르다** —
「축이 «없다»」가 아니라 「축이 **있는데 아직 아무도 켜지 않았다**」다. 그 차이가 세 가지를 바꾼다:

1. **e2e 픽스처** — 후보 목록 픽스처는 창고를 만들며 **`is_defect: true` 를 켜야** 계약 문자와 같은 목록이 된다(L1·L2·L4·L5·L7).
2. **`warehouseId` 도출** — `count(DISTINCT warehouse_id)=1` 이 아니라
   `JOIN mdm.warehouse w ON w.warehouse_id=b.warehouse_id AND w.is_defect` 가 계약 문자다.
   ⇒ **L4(잔액 창고 둘)의 「빼는 행」이 「불량창고 아닌 잔액은 안 센다」로 바뀐다** — e2e §8-3 #2·#3 의 뜻이 통째로 달라진다.
3. **통보 후보** — 「`is_defect` 를 켠 창고가 0이라 이 목록이 운영에서 빈다」는 **설계·운영에 알려야 할 사실**이다.

⇒ **PR ③ 의 원시 SQL 과 e2e 8건이 이 판정에 매달려 있다.** 실측 부록 #27 을 정정하고 판정 #4 를 다시 세워라.

#### **M-3. `plan-integration.md:185` 칼럼 오독** — §1-3 참조. §0·§2-5·§10·§10-1 #1·#7 네 자리를 고쳐야 한다.

#### **M-4. 마이그레이션에서 `code_value` 를 INSERT 한 선례가 «없다» — 인용이 허위다**(R-24형)

계획안 §2-5 ⓐ 근거: 「**선례 실재** — `20260901010000_add_lot_lifecycle_axis` **등** 마이그레이션이 `code_value` 를 넣는다」

실측:
```
$ for f in prisma/migrations/*/migration.sql; do grep -c "INSERT INTO mdm.code_value\|INSERT INTO app.code_value" $f; done
  → 20260727000000_baseline_physical_model_v3/migration.sql : 2      (그 외 전부 0)
$ grep -n "code_value" prisma/migrations/20260901010000_add_lot_lifecycle_axis/migration.sql
  → 45:  -- 값 집합은 CHECK 에 박지 않는다. L1~L3 도 대기·활성·폐번도 mdm.code_value 로 푼다 —   ← «주석»뿐
```

⇒ 인용된 마이그레이션은 **`code_value` 를 한 행도 넣지 않는다**(`ALTER TABLE trace.lot` 뿐). 「**등**」에 해당하는 다른 파일도 없다.
`code_value` 를 만진 후속 마이그는 **`20260904110000_master_version_status_confirmed` 의 `UPDATE` 하나뿐**이다.
⇒ **이 슬라이스가 「베이스라인 밖에서 코드값을 INSERT 하는 첫 사례」다.**

⭐ **그렇다고 판정이 틀린 것은 아니다** — 오히려 **필요하다.** 배포는 `prisma migrate deploy` 만 돌고 시드를 안 돌린다
(`deploy/RELEASE.md:23` · `deploy/` 어디에도 `db:seed` 없음 · `lanes.md` §4 가 `pnpm db:seed` 를 금지). 그래서
**`seed.ts` 만 고치면 기존 DB 에는 영영 안 들어간다.** 실제로 그 구멍이 이미 열려 있다 — 실 DB 의
`LOT_STATUS_TRANSITION` 9값·`NONCONFORMANCE_STATUS` 3값은 누군가 시드를 손으로 돌렸을 때만 들어온 것이고,
운영 DB 에 있다는 보장이 없다.

⇒ **판정 유지 · 근거 문장 교체 · 「첫 사례」로 명시.** 그리고 **통보 후보**(운영 통지) 한 줄을 남겨라.

#### **M-5. 레인 C 의 #403(I-13 PR ③)이 «같은 두 줄»에서 부딪히고, 지금 «레인 A 의 통지를 기다리며 막혀 있다» — §11 인계에 없다**

실측(`gh issue view 403`):
> 「PR ③ 의 첫 커밋이 **레인 A 소유 파일**을 건드린다 — `src/core/document-state/transitions.ts`(축 12 → 13 · 전이 28 → 29)
> \+ `document-state.spec.ts` 한 줄. `lanes.md` §1-4 · §3 에 따라 **착수 «전»에 사용자를 통해 A 에게 알린다. 통지 전에는 시작하지 않는다.**」
> 라벨 `Lane-C` · `status:in-progress` · **OPEN**

`docs/coverage-100/slices/I-13.md` 실측 — `:768` `'logistics.stock_transfer.status_code': {` · `:737` 「키 **신설 1 · 전이 «1»**」 ·
`:1008` §13 인계 ② 「축 **12 → 13** · 전이 **28 → 29** · `document-state.spec.ts` 의 축 목록 상수 한 줄 + `toHaveLength(29)` + 주석 한 줄」.

⇒ **부딪히는 자리가 «정확히» 둘이다**:
- `document-state.spec.ts:398-414` 의 **축 목록 배열 리터럴**(A 는 `NONCONFORMANCE_STATUS` 를, C 는 `STOCK_TRANSFER_STATUS` 를 넣는다)
- `document-state.spec.ts:423` 의 **`toHaveLength(n)`**(A: 41→46 · C: 41→42 · 둘 다면 **47**, 축 **18**)
- ⭐ 그리고 **B-2 의 `test/document-state.e2e-spec.ts:38-61` `STATUS_GROUPS` 도 셋째 충돌 자리다** — C 도 `logistics.stock_transfer.status_code` 행을 넣어야 한다. **양쪽 계획서 어디에도 그 파일이 없다.**

⚠ **C 의 숫자가 낡았다** — `28 → 29` 는 I-13 계획 당시 값이고 `main` 은 지금 **41**이다. 나중에 병합하는 쪽이 반드시 다시 세야 한다.

계획안 §11 인계 표에 **I-13/#403 이 한 번도 나오지 않는다.** §11-4 #1 은 「B·C 가 같은 파일을 읽는다」라는 일반론뿐이고,
§11 ① 은 **I-23(재등록)** 을 가리킨다 — **막혀 있는 것은 I-23 이 아니라 I-13 이다.**

⇒ **§11 에 행을 하나 더하라**: 「**레인 C · I-13 PR ③(#403)** — `transitions.ts` 축 +1 · 전이 +1 · `document-state.spec.ts` 두 줄 ·
`document-state.e2e-spec.ts` `STATUS_GROUPS` 한 줄. **A 의 통지를 기다리며 «지금» 막혀 있다.** ⭐ 순서 판정:
**A 의 PR ④(+M-h ⓐ)를 먼저 병합하고 곧바로 C 에게 통지**한다 — A 쪽이 코드값 마이그까지 물려 있어 창이 길고,
C 쪽은 `+1` 이라 뒤에 붙는 편이 재계수가 싸다. 뒤에 오는 쪽이 `origin/main` 을 merge 하고 **숫자를 다시 센다**(`lanes.md` §1-4 공용 등록부 규칙).」

#### **M-6. `followUpQty` 롤업의 «원천 표·칸·상태 필터»가 계획에 없다 — I-20 ①c 의 `POSTED` 필터 사고와 같은 모양이고, `followUpPending` 은 오늘 REWORK·NORMAL 전건을 영구히 포함한다**

계획안 판정 #3 은 「SCRAP → `logistics.goods_issue.source_document_type_code='DISPOSITION_DECISION' + source_document_id` ⇒ **셀 수 있다**」까지만 적었다.
**「무엇을 더하는가」가 없다.** 실측:

- `logistics.goods_issue` 에는 **수량 칸이 없다**(`schema.prisma:745-780` 전수). 수량은 **`goods_issue_line.issue_qty`**(`:790`)다.
- `goods_issue.status_code` 는 `LOGISTICS_DOCUMENT_STATUS` 4값(`REGISTERED`·`POSTED`·`CANCEL_REQUESTED`·`CANCELLED`)이다.
  **취소된·미전기 폐기 출고를 「후속 처리된 수량」으로 셀 것인가**가 계획에 없다.
- 계약 `followUpStatusCode` enum 은 **`NOT_STARTED`·`PARTIAL`·`COMPLETED`** 이고 「**COMPLETED = 처리 수량 = `decisionQty`**」라 정의한다(python 실측).

⭐ **이것이 README §6-2 가 「1순위」라 못 박은 자리다** — 「계획서에 없던 필터를 구현이 추가하면 R-19 의 그물 밖이라 아무도 안 본다」.
그리고 **I-20 에서 실제로 같은 모양으로 났다** — `I-20.md:406` 의 `shippedQty = Σ goods_issue_line.issue_qty` 에
구현이 `POSTED` 필터를 «새로» 붙였고 그게 ①c 의 Major 였다.

⇒ **계획서가 지금 못 박아라**: `Σ goods_issue_line.issue_qty` · `WHERE gi.source_document_type_code='DISPOSITION_DECISION'
AND gi.source_document_id = <decision id> AND gi.status_code = 'POSTED'` (또는 「상태를 안 본다」를 명시).
그리고 e2e §8-3 #24 옆의 「죽이는 변이」에 **「`CANCELLED` 폐기 출고 한 행」**을 픽스처로 넣어라 — 오늘 D1 하나뿐이라
`status_code` 필터를 넣든 빼든 **시험이 안 깨진다**(브리프 §3 이 요구한 「짝이 성립하지 않는 자리」의 표본이다).

⭐ **그리고 계획안이 끝까지 안 따라간 파급 하나** — 판정 #3 이 REWORK·NORMAL 을 **영구 `NOT_STARTED`** 로 고정하면,
`followUpPending=true`(「후속이 남은 것」)는 **모든 REWORK·NORMAL 결정을 영원히 집는다**(3유형 중 둘).
§8-3 #23 은 「D1(부분 30/50)을 집고 완료분을 뺀다」만 단언해 **D2·D3 이 들어오는지 나가는지를 안 묻는다** — 되돌려도 안 깨진다.
⇒ 단언을 **배열 통째**로 바꾸고(`[D1, D2, D3]` 인지 `[D1]` 인지), 그 답을 §0 #3 에 판정으로 적어라. 통보 후보.

---

### Minor — **11건**

| # | 자리 | 내용 |
|:-:|---|---|
| **m-1** | §8-3 | ⛔ **판정 저장의 「If-Match 불일치 → 409 `VERSION_CONFLICT`」 e2e 가 없다.** 38건 중 30(ETag)·34(동시성)은 있는데 토큰 불일치가 빠졌다 — 계약이 If-Match **필수**로 적었고 §7-4 도 「둘 다 필수」라 적은 자리다. 의뢰 쪽(#32)만 있다. ⇒ 「토큰 비교를 아예 안 해도 초록인」 시험 집합이다 |
| **m-2** | §8-3 | 판정 저장의 **멱등 재전송**(§7-4 「쓰기 3건 전부 `runIdempotent`」)과 **없는 `nonconformanceId` → 404**(§1-1 선언) e2e 도 없다 |
| **m-3** | §3-3 ↔ §3-4 | **순서가 서로 다르다.** §3-4 표는 If-Match(5) → 본문 형식(6) 순인데 §3-3 의사코드는 본문 형식(2) → 잠금(3) → … → 판 올림(9) 순이다. 저장소의 실제 기법은 **조건부 UPDATE + `assertUpdated()`**(`src/mdm/code/code.service.ts:132-138` `where:{…, version_no: version}` · `src/common/optimistic-lock/optimistic-lock.ts` `assertUpdated`)라 **토큰 비교는 트랜잭션 «끝»에서 난다.** §3-4 5행의 「`runVersioned` 가 낸다」는 틀렸다 — `runVersioned` 는 헤더를 **파싱만** 한다(`master-write.ts:40-56`). §3-3 step 9 에 `version_no: version` 조건과 409 를 명시하라(안 그러면 m-1 과 겹쳐 토큰이 «있으나 마나»가 된다) |
| **m-4** | 공용 파일 | 판정 저장은 **저장소 첫 「201 + If-Match + ETag」**다. `runVersioned` 는 내부에서 `runIdempotent(…, **HttpStatus.OK**, …)` 로 **성공 상태를 200 으로 고정**한다(`master-write.ts:53`). 실제 HTTP 상태는 `@HttpCode` 가 내므로 **응답은 안 깨지지만** `idempotency_record.response_status` 에 **200 이 적힌다**(`idempotency.service.ts:83`). 기존 `runVersioned` 12자리는 전부 PUT/PATCH(200)라 이 자리가 처음이다. ⇒ §7-1·§10 에 **`src/common/master/master-write.ts` 를 「안 건드린다」로 명시**하거나(권장 — 공용 파일), 건드린다면 단독 커밋으로 |
| **m-5** | `transitions.ts:188` | 주석 「⛔ `SCRAPPED` 는 `from` 에도 `to` 에도 없다 — 계약이 어느 오퍼레이션에도 적지 않았다」가 **거짓이 된다.** PR ④ 가 고쳐야 하는데 §7-1 의 `+20` 에 그 몫이 없다 |
| **m-6** | `transitions.ts:216-217` | 주석 「⛔ `transitionCode` 가 없다 … **설계 미정 — 문의 089(발행 예정)**」 — 089 가 «통보»로 발행되고 §7 이 재등록 자리를 비워 두면 이 문구도 낡는다. `// 결정 — 통보 089(재등록 코드는 §7 · 레인 C 판정)` 로 바꿔야 하는데 계획에 없다 |
| **m-7** | §8-1 정리 | `deleteMany` 역순 13표에 **`approval_request` 가 없다.** `quality.concession.approval_request_id` 는 **NOT NULL + FK(`fk_concession_approval`)** 라 C1~C5 픽스처가 결재 요청 행을 만들어야 하고, 안 지우면 남는다(I-20 R-20 이 같은 자리에서 죽었다) |
| **m-8** | §8-1 픽스처 | 실 DB `mdm.warehouse` **0행** · `is_defect=true` **0행**. M-2 를 반영하면 후보 픽스처가 **창고를 만들며 `is_defect` 를 켜야** 한다 |
| **m-9** | §2-6 | `nonconformance_lot(lot_id)` 인덱스 유예는 **근거가 약하다.** 그 축을 타는 질의가 **넷**이다 — 부적합 목록 `lotId`(§1-2) · 처분 결정 목록 `lotId` · 후보 목록 `withoutNonconformanceOnly` 의 `NOT EXISTS` · `DispositionDecision.lotId` 조인. `uq_nonconformance_lot` 은 선두가 `nonconformance_id` 라 **하나도 못 탄다**. M-h ⓑ 와 같은 파일에 **한 줄**이면 끝난다 — I-20 R-21 이 같은 판단으로 `ix_inventory_balance_lot` 을 M-f 에 실었다(그 인덱스는 `20260908110558:45` 로 `main` 에 이미 있다 — 계획안 §2-6 의 「구현 착수 시 확인한다」는 **확인 완료**다) |
| **m-10** | §10 | **PR 9 는 하한이다** — 아래 §5 |
| **m-11** | 실측 부록 #27 | baseline 을 재서 낡았다(M-2). 같은 표의 다른 baseline 인용 넷(#24 `nonconformance_lot` · #25 `disposition_decision` · #31 `work_order` · #32 `sorting_result` · #33 `trace.lot`)은 **실 DB 로 재확인했고 전부 맞다** — 낡은 것은 #27 하나다 |

### Nit — **4건**

| # | 내용 |
|:-:|---|
| n-1 | 계약이 스스로 모순된다 — `DispositionDecisionCreate.dispositionTypeCode` 는 `enum:[REWORK,SCRAP,NORMAL]` 로 «닫혀» 있는데 같은 오퍼레이션 `x-internal-note` 는 「⚠ `disposition_type_code` 값 목록은 **미확정**이다 — 2차 값 목록 제안안 대상」이라 적었다. 프로퍼티 설명이 「✅ 값 목록 확정 2026-09-01(`omf-mes#336`)」이라 **note 가 낡은 것**이다. 계획안 §1-3 의 판정(enum 3값 상수 검증)이 맞다 — 「note 는 낡았다」만 알려둘 것에 한 줄 |
| n-2 | `ConflictExtra` 에 두 칸을 더할 때 **`remainingQty` 는 `numeric(20,6)`(Prisma `Decimal`)**이고 기존 칸은 `conflictingLotId?: number`·`currentVersion?: string` 이다. 직렬화 형식(계약은 `number`)을 §1-6 에 한 줄로 못 박아라 |
| n-3 | `QualityConflictResponse.conflictCause` 는 `ConflictResponse` 가 이미 낸다(`conflict.exception.ts:39-42`) — 계획안이 「칸 4개」라 센 것은 `ConflictExtra` 기준이라 맞다 |
| n-4 | 알려둘 것 ⓗ 확인 — `src/common/contract/contract-coverage.spec.ts:30` 제목이 `(n/490)` 이다. 사실 ✓ |

---

## 4. 관점별 전수 점검표 — `plan-integration.md` ↔ 계획안

| # | `plan-integration.md` | 계획안 | 내 판정 |
|:-:|---|---|:-:|
| 1 | `:185` 표 = **있음** (물리 표 실재) | §2-1~§2-4 가 전 표 실재 확인 | **같다** ✅ |
| 2 | `:185` **마이그 = ✕** | 「`:185` 는 「있음」이라 적었다 · 셋이 서로 다르다」 | ⛔ **반증**(칼럼 오독 · M-3). 결론(마이그 2)은 유지 |
| 3 | `:185` 원장 **✕**(폐기는 I-4 재사용) | §5 원장 0 · posting 0 | **같다** ✅ |
| 4 | `:185` 상태기계 **⭕** | §6 키 1 + 전이 5 | **같다** ✅(개수까지 실측 일치) |
| 5 | `:185` PR **3** | **9** | **다르다** — 방향은 맞다. 다만 하한이다(§5) |
| 6 | `:387-389` §3-1 체인 마디 ㉓㉔ · 「SCRAP 은 I-4, NORMAL 은 I-23, REWORK 은 I-6」 | §11 ②③ 그대로 | **같다** ✅ |
| 7 | `:388` 「⛔ 원장 직접은 없다 — 전부 다른 슬라이스가 진다」 | §5 · §7-3 | **같다** ✅ |
| 8 | `:389` 「수량 합이 대상을 넘으면 → **400**」 | **409 `DISPOSITION_QTY_EXCEEDED`** | ⛔ **계획안이 옳다 — `plan-integration.md` 를 고쳐라**(§1-2) |
| 9 | `:389` 「부분 처분 · 남은 수량 파생을 서버가 낸다 — `summary` 에 실린다」 | §1-4 `DispositionRemainingSummary` | **같다** ✅ |
| 10 | `:535` **M3** 체인 = 「… 부적합 → 처분(SCRAP) → **폐기 출고(I-4 재사용) 원장 감소**」 | §8-6 끝점 셋 | **같다** ✅ |
| 11 | `:590` 공유 코어 5 「품질 축 전이표(I-19) — I-20·I-21·I-23 이 **재사용**」 | §6-2 「`LotQualityStatusService.moveWithin` 을 그대로 쓴다 · 코어 신설 0」 | **같다** ✅ — `src/core/lot/lot-quality-status.service.ts:46-118` 실측으로 `moveWithin` 이 `FOR UPDATE`·`from` 밖 건너뜀·`lot_status_event` 기록을 다 한다 |
| 12 | `:924-934` §10 부록 I-21 **11 오퍼레이션** | §0 대조 11/11 | **같다** ✅(내가 손으로 대조했다) |
| 13 | `:187` I-23 행 「있음(**재등록은 `stock_transfer` 재사용**)」 | §11 ① 「`logistics.stock_reinstatement` 표가 물리에 없다 — **C 가 세워야 하고**」 | ⚠ **다르다** — 통합 계획서는 표 신설이 아니라 재사용이라 적었다(§2-3). 인계 문장을 고쳐라 |
| 14 | `plan.md` §1 17행 「마이그 —·코어 —·PR 3」 | 계획 커밋 5edc559 가 **이미 §1 17행·§4 M-h·§0 #11 을 갱신했다** | ✅ 갱신됨. ⛔ **단 §4 M-h 행에 `app.code_value` 오기가 함께 실렸다**(B-1) |

---

## 5. §10 PR 분할·줄수 예산 — **9 는 «하한»이다 · 총량 추정은 좋다**

**총량 ≈1,911 은 잘 잡았다.** 직전 슬라이스의 실물로 교차 검증했다 — I-20 이 실제로 내놓은 비테스트 소스:

```
src/quality/lot-hold/*.ts + src/quality/lot-status/*.ts + src/core/lot/lot-hold.service.ts = 2,107줄
  − lot-hold-rules.spec.ts 198  =  1,909줄   (오퍼레이션 10건)
```
I-21 은 오퍼레이션 **11**건에 **≈1,911** — 밀도가 거의 같다. **추정은 신뢰할 만하다.**

⛔ **PR 수는 아니다.** I-20 은 같은 총량을 **12 PR** 로 냈다(`git log --merges` 실측 —
#325·#351·#354·#355·#362·#361·#365·#376·#378·#379·#389·#394). `plan.md` §1 16행도 「~~3~~ **11~12**(I-20 R-17)」로 적혀 있다.

파일별로도 밀리는 자리가 보인다 — I-20 의 **`lot-hold-write.service.ts` 는 335줄**(계획은 ~200대)이고
**`lot-hold-rules.ts` 는 179줄**(I-21 은 `nonconformance-rules.ts` **~90**으로 잡았다). ⇒

| PR | 예산 | 위험 |
|:-:|--:|---|
| **⑥** 심장 A | 325 / ≤350 | ⚠ **넘칠 확률이 높다** — I-20 의 형제 쓰기가 335였다. `lots[]` 검증 6갈래 + 중복 부적합 409 + 채번이 한 서비스에 든다 |
| **⑦** 심장 B | 248 / ≤300 | ⚠ 잠금·잔량·전이·종결·`conflict.exception` 이 한 PR. 여유 52줄뿐 |
| **③** 후보 원시 SQL | 229 / ≤280 | ⚠ **M-2 가 뒤집으면 ±80** — 계획안 스스로 그렇게 적었다 |
| **④** 코어 | 28 / ≤60 | ⛔ **B-2**(e2e spec +2~4) · **M-1**(M-h ⓐ 흡수 시 +~40) ⇒ **~70** — 한도 60 을 넘는다. 코어 한도 200 안이라 문제는 아니나 표를 고쳐야 한다 |

⇒ **판정: 「9」를 「**9~12**」로 적고, ⑥ 을 「쓰기 + 규칙」 둘로 가를 여지를 §10 에 미리 남겨라.**
그리고 **M-1 을 반영해 M-h 를 ⓐ(→④ 흡수) · ⓑ(단독)로 가르면 표가 이렇게 된다**:

| 바뀌는 것 | 전 | 후 |
|---|---|---|
| M-h | 마이그 단독 2항목(55) · `main` 위 · ④ 와 병렬 | **M-h′ = ⓑ 인덱스만**(≈20) · `main` 위 · **누구와도 무의존** |
| ④ | 코어 28 · `main` 위 · M-h 와 병렬 | **④ = 코어 + 마이그 ⓐ + `seed.ts` + `document-state.e2e-spec.ts`**(≈70) · `main` 위 · **단독** · 마이그가 들었으므로 **병합 직전 한 줄 보고** |

나머지(①·②a·②b·③·⑤ 직렬 · ⑥⑦ 심장) 판정은 **유지**한다 —
「`quality.module.ts` 를 공유하므로 직렬」과 「⛔ 파일 0겹침이라 병렬이라고 적지 않는다」(I-20 R-17)는 실측으로 옳다.
`quality.module.ts` 는 controllers 10 · providers 17 로 이미 조밀하고, 라우트 순서 함정 주석(`InspectionSummaryController` 를
`InspectionResultController` «먼저»)이 그 파일에 살아 있다 — §7-2 의 라우트 순서 판정(`candidates` ≠ `decisions` 라 안전)도 맞다.

---

## 6. 「계획자가 안 본 자리」 (새로 찾은 것 · 요약)

1. **`test/document-state.e2e-spec.ts`** — 계획 전체에 0회(B-2). I-19 R-5 가 같은 자리에서 이미 죽었다.
2. **M-h ⓐ ↔ PR ④ 의 양방향 순서 의존**(M-1). 「순서 의존 0」이 그 e2e 를 안 봐서 나온 결론이다.
3. **`app.code_value` 는 없는 표**(B-1). `plan.md` §4 정본에도 그대로 실렸다.
4. **`mdm.warehouse.is_defect` 실재**(M-2). baseline 을 재고 그 뒤 마이그를 안 봤다 — R-24 형.
5. **계약 `DispositionCandidate.quantity` = 「그 LOT 이 «불량창고»에 들어온 수량」**(M-2). 계획안이 이 문장을 인용하지 않았다.
6. **`plan-integration.md:185` 칼럼 오독**(M-3).
7. **마이그 `code_value` INSERT 선례 없음**(M-4) — 그런데 배포가 시드를 안 돌리므로 **필요하다**는 «다른» 근거가 있다.
8. **레인 C #403 이 지금 A 의 통지를 기다리며 막혀 있다**(M-5). §11 에 없다.
9. **`followUpQty` 의 표·칸·상태 필터 미정**(M-6) — I-20 ①c 와 같은 모양.
10. **`followUpPending` 이 REWORK·NORMAL 을 영구 포함**(M-6 뒤).
11. **`concession.approval_request_id` NOT NULL** — writer 0 을 두 배로 무겁게 만든다(§2-4 · m-7).
12. **`runVersioned` 의 200 고정** — 저장소 첫 201+If-Match(m-4).
13. **§3-3 ↔ §3-4 의 If-Match 위치 모순**(m-3).
14. **판정 저장의 If-Match 불일치 e2e 부재**(m-1) — §8 의 「죽이는 변이」 짝이 성립하지 않는 표본.
15. **`Concession.statusCode` 의 `x-no-code-key` 가 값 판정을 이미 줬다**(§1-5) — 0단계에서 닫히는 물음을 1-1단계로 올렸다.

---

## 7. 통보 후보 (⛔ 번호 없음 · 레인 A 대역 소진)

> 계획안이 세운 **089** 는 그대로 유효하다. 아래는 **089 §n 으로 흡수하거나 새 대역이 열리면 낼** 후보다.

| 제목 | 한 줄 요지 | 왜 필요한가 |
|---|---|---|
| **불량창고 축(`mdm.warehouse.is_defect`)이 데이터에 0행이다** | 계약이 `DispositionCandidate.quantity` 를 「그 LOT 이 불량창고에 들어온 수량」으로 정의했는데, `is_defect` 는 2026-08-28 에 서고 **`DEFAULT false` 라 켜진 창고가 0**이다 | 계약 문자대로 만들면 후보 목록이 **운영에서 빈다.** 우리가 원천 축으로 대신 낼지, 운영이 창고를 켤지 갈린다 — **089 §6 에 흡수 가능** |
| **`LOT_STATUS_TRANSITION` 코드값을 마이그레이션으로 넣는 첫 사례** | 배포는 `migrate deploy` 만 돌고 시드를 안 돌린다(`deploy/RELEASE.md`) — `seed.ts` 만 고치면 기존 DB 에 영영 안 들어간다 | 이미 열린 구멍이다(`C4`~`C15`·`NONCONFORMANCE_STATUS` 도 운영 DB 에 있다는 보장이 없다). **운영 통지** 성격이라 089 §1 에 한 줄 |
| **`followUpPending` 이 재작업·정상 결정을 영구히 포함한다** | 후속 원천이 SCRAP 하나뿐이라 REWORK·NORMAL 은 영원히 `NOT_STARTED` 다 — 「후속이 남은 것」 목록이 3유형 중 둘을 통째로 담는다 | 화면의 대기열이 무의미해진다. **089 §4 에 흡수**(같은 결손의 결과) |
| **`quality.concession` 은 writer 0 + `approval_request_id` NOT NULL** | 특채 행이 «설 길»이 구조적으로 0이다 — 목록이 비는 정도가 아니라 채워질 수 없다 | 089 §2 에 한 줄. 회신 12 를 닫는 근거와 같은 자리 |
| **판정 저장이 저장소 첫 「201 + If-Match + ETag」다** | `runVersioned` 가 성공 상태를 200 으로 고정해 `idempotency_record.response_status` 에 200 이 남는다 | 계약 위반은 아니나 **공용 코어의 가정이 깨지는 첫 자리**라 기록이 필요하다. 통보보다 「알려둘 것」이 맞다 |

---

## 8. 내가 실제로 연 파일 · 돌린 명령

**문서(읽기)**
`docs/coverage-100/README.md` 전문 · `docs/coverage-100/lanes.md` **전문 187줄** ·
`docs/coverage-100/slices/I-21.md` **전문 901줄** · `docs/coverage-100/slices/I-18-review-integration.md`(구조) ·
`docs/coverage-100/plan-integration.md:160-190`·`:383-395`·`:530-540`·`:585-595`·`:920-936` ·
`docs/coverage-100/plan.md` §4 전건 · §1 16·17행 · `docs/coverage-100/plan-api.md:865-890` ·
`docs/coverage-100/slices/I-19.md`(SCRAPPED 전건 grep · R-5 · :610-616 · :966 · :1032-1033 · :1072) ·
`docs/coverage-100/slices/I-20.md:406`·`:780-860`(§10·§11·§12) · `docs/coverage-100/slices/I-13.md`(transitions 전건 grep · :737·:768·:1008·:1023)
⛔ **`I-21-review-api.md`·`I-21-review-uiux.md` 는 열지 않았다.**

**소스(읽기)**
`src/core/document-state/transitions.ts` **전문 374줄**(축·전이 손으로 계수 → 16축/41전이) ·
`src/core/document-state/document-state.spec.ts:1-60`·`:375-440` ·
**`test/document-state.e2e-spec.ts` 전문 175줄** ·
`src/core/lot/lot-quality-status.service.ts:1-120` ·
`src/core/numbering/numbering.service.ts:1-55`·`:85-95` ·
`src/common/master/master-write.ts:1-60` · `src/common/optimistic-lock/optimistic-lock.ts:1-60` ·
`src/common/idempotency/idempotency.service.ts:60-135` · `src/common/errors/conflict.exception.ts:1-52` ·
`src/common/permissions/derived-permissions.ts`(11 오퍼레이션 grep — 10건 실재, `GET /quality/concessions/{concessionId}` 부재 확인) ·
`src/common/contract/contract-coverage.spec.ts:25-35` · `src/quality/quality.module.ts` 전문 ·
`src/mdm/code/code.service.ts`(version_no 조건부 UPDATE 패턴) · `src/mdm/logistics/warehouse.service.ts:104`·`:158`

**물리(읽기)**
`prisma/schema.prisma` — `code_value:1630-1651` · `warehouse:2298-2318` · `goods_issue:745-780` · `goods_issue_line:783-805` ·
`goods_receipt:814-835` · `goods_receipt_line:840-859` · `concession:3091-3120` · `disposition_decision:3200-3218` ·
`nonconformance:3427-3455` · `nonconformance_lot:3463-3479` · `inventory_balance:525`
`prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql` — `:95-111`·`:2036-2062`·`:2175-2196`·`:3340-3400` ·
`prisma/migrations/20260828000000_add_warehouse_is_defect/migration.sql` **전문** ·
`prisma/migrations/20260901010000_add_lot_lifecycle_axis/migration.sql` **전문** ·
`prisma/migrations/20260904110000_master_version_status_confirmed/migration.sql` 전문 ·
`prisma/seed.ts:219-244`·`:381`·`:505-560`·`:1550-1600`

**명령(실행)**
```bash
git log --oneline -3 ; git show --stat 5edc559 ; git show 5edc559 -- docs/coverage-100/plan.md
git log --oneline --merges -200 | grep -E "coverage-100-a-i20"      # → I-20 실제 12 PR
gh issue view 403 --json number,title,body,labels,state             # 레인 C 차단 상태
gh pr list --state open --json number,headRefName,title,baseRefName # 열린 PR 3
grep -rn "stock_reinstatement" prisma/ src/ contracts/              # → 0건
grep -rni "reinstat" prisma/schema.prisma prisma/migrations/        # → 주석 2줄
for f in prisma/migrations/*/migration.sql; do grep -c "INSERT INTO mdm.code_value|INSERT INTO app.code_value" $f; done
grep -rn "is_defect" prisma/migrations/*/migration.sql
grep -rn "LOT_STATUS_TRANSITION" src/ test/ prisma/
wc -l src/quality/lot-hold/*.ts src/quality/lot-status/*.ts src/core/lot/lot-hold.service.ts   # I-20 실물 2,107줄

python3  # contracts/*.json 읽기 전용 덤프 (⛔ contracts:update·check 안 돌림)
  · quality-03품질.json  POST …/disposition-decisions  description · x-internal-note · responses
  · QualityConflictResponse.code enum(6) · props(8)
  · DispositionDecisionCreate 전문 · DispositionDecision.followUpStatusCode/Qty · required(10)
  · Concession.statusCode.x-no-code-key
  · shipment-04제품출하.json  ShipmentConflictResponse.code enum(5) · props(4)
  · DispositionCandidate required(7) · quantity · sourceCode · GET 설명 · x-internal-note
  · 7벌 전수 — concession 을 담은 경로 = GET 둘뿐(writer 0 확인)

psql "postgresql://postgres@127.0.0.1:55432/omf_mes"    # 읽기 전용 SELECT 만
  · mdm.code_group ⋈ code_value  — LOT_STATUS_TRANSITION 9 · LOT_STATUS 4 · NONCONFORMANCE_STATUS 3
                                    NONCONFORMANCE_SEVERITY 3 · CONCESSION_STATUS/DISPOSITION_TYPE 없음
  · pg_indexes(quality.*)         — disposition_decision 은 PK 하나뿐
  · information_schema.columns    — mdm.warehouse(is_defect 실재) · trace.lot · production.work_order
                                    · quality.sorting_result · inventory.inventory_balance · quality.inspection_*
  · information_schema.tables     — app 스키마의 %code% 표 = 0행
  · SELECT count(*) FROM mdm.warehouse — 0행 · is_defect=true 0행
```

⛔ **게이트(`jest`·`tsc`·`eslint`·`prisma`)는 한 번도 돌리지 않았다** — 이 리뷰는 코드를 바꾸지 않는다.
⛔ **`contracts/*.json` 은 읽기만** 했고 `contracts:update`·`contracts:check` 는 돌리지 않았다.
⛔ **DB 쓰기 0** · **PR 생성·코멘트·병합 0** · **rebase·force-push 0** · **통보문 0**.

---

## 9. 한 줄 결론

**계약 읽기와 심장은 통과.** ⛔ **구현 착수 전에 반드시 고칠 것 넷** — `app.code_value` → `mdm.code_value`(B-1) ·
`test/document-state.e2e-spec.ts` 를 PR ④ 에 넣기(B-2) · **M-h ⓐ 를 ④ 안으로 흡수**해 상호 의존을 없애기(M-1) ·
**`mdm.warehouse.is_defect` 실측으로 판정 #4 다시 세우기**(M-2). 그리고 **레인 C #403 을 §11 에 적고 순서를 정하라**(M-5).
