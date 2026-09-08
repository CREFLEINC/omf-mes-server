# I-16 재검토 — **api 관점**

> 대상 `slices/I-16.md`(934줄). 관점: 계약 문장·스키마·`x-*` 원문·에러 봉투·횡단 4축·`X-Worker-No`·권한·채번.
> 실측 부록은 재측정하지 않았다(뒤집는 판정 0건). 아래는 **계획자가 안 본 자리** — 계약 가드 순서·멱등 재전송·도달 불가 갈래.
> 근거 기준: worktree `i16-plan`(base 771c541) · 계약 사본 COMMIT `a6a87e1` · 2026-09-07.

---

## 1. 「반드시 볼 자리 5」 판정

| # | 판정 | 근거 |
|:-:|:-:|---|
| **①** 표 2 신설 | **✅ 동의** | 계약 `HandlingUnitRepackEventLine.required` = `handlingUnitId`·`roleCode`·`itemId`·`lotId`·`qtyBefore`·`qtyAfter` **6칸**(`contracts/logistics-01자재창고.json:8770` 실측 재확인 · `uomId` 없음)이고 헤더 `required` 5 에 `handlingUnitId` 가 없다(`:8724`) — 방향은 라인이 진다. 계약이 저장처를 **넘겼다**(스키마 description·`PUT …/contents` description·`repack-events` description **세 곳**이 「저장 테이블은 데이터 모델 담당에게 통지 — 기다리지 않는다」). API 관점의 반례 0 |
| **②** `status_code` 상수 **둘** | **✅ 동의**(문장 하나 ✏ → R-6) | `HandlingUnit.required` = `handlingUnitId`·`handlingUnitNo`·`handlingUnitTypeCode`·**`statusCode`** 4칸(실측) ⇒ nullable 불가. `:pack` description 「이미 확정된 포장은 409 다」가 축을 강제(`:1585`). `x-no-code-key` 원문도 계획안 인용 그대로 |
| **③** `PUT …/contents` 가 **언제나** 이벤트 | **✅ 동의** | description 에 조건절 0(원문 재확인). 응답 라인의 `qtyBefore`/`qtyAfter` 는 `type: number` 뿐 — 「달라야 한다」는 제약이 계약에 없다 ⇒ 무변화 줄을 남기는 것이 계약 위반이 아니다 |
| **④** `X-Worker-No` 셋 다 400 `REQUIRED` | **✅ 동의**(근거 보강) | 계약 `WorkerNo.required=true` + 「없으면 서버가 거부한다」. ⭐ 관리웹 0건은 uiux 문서가 아니라 **도출표에서 직접 읽힌다** — `derived-permissions.ts:165`=`['M-04-03','P-02-08','P-04-01']` · `:166`=`['P-02-08','P-04-01']` · `:264`=`['M-04-03']`, **`W-` 0건**(실측). `plan.md:154` 예외의 「POP 단말만 부르는 자리」에 든다 |
| **⑤** PR 분할 **4** | **✅ 동의** | api 관점 예산 근거 성립. 조회 PR ① 을 리뷰와 나란히 스폰해도 계약 표면이 안 바뀐다(아래 R-1~R-5 는 전부 ②③④ 범위) |

⇒ **⛔ 반대 0건.** 다섯 판정 모두 유지. 아래는 하위 사실 정정이다.

---

## 2. ⭐ R-1~R-5 — 계약 가드가 핸들러보다 «먼저» 돈다(계획안이 안 본 축)

`app.module.ts:25-26` 원문: 「인증 → 권한 → **계약 검증** → 멱등 → 낙관적 잠금」. `ContractValidationGuard` 가
요청 본문을 ajv 로 검증해 **핸들러 전에** 400 을 던지고(`contract-validation.guard.ts:39-44`), 코드는
`validation-error.mapper.ts:12-28` 가 정한다 — `minItems`·`exclusiveMinimum` 은 **`RANGE`** 다.

- **R-1 ⛔(세부 반대)** — `:pack` `contents: []` 는 **400 `LINE_REQUIRED` 가 아니라 400 `RANGE`** 다.
  계약이 `HandlingUnitPack.contents` 에 `minItems: 1` 을 걸어 뒀으므로(실측) 서비스 손검사에 **도달하지 못한다**.
  ⭐ 같은 자리를 **I-8 이 구현 중에 이미 맞았다** — `I-8.md:892` 「§4-4 `lines: []` 400 `LINE_REQUIRED` → 실제 코드
  **`RANGE`**(계약 가드 `minItems` → `validation-error.mapper.ts:19`) · 가드가 서비스보다 먼저」, 그리고 그 결과가
  `plan.md:207` 「(I-8) … `lines: []` 는 `RANGE`」로 이미 실려 있다.
  ⇒ **I-16 에는 `LINE_REQUIRED` 사용처가 0 이다.** 고칠 곳: §1-6 1행 · §3-3 2행 · §9-2 #22 · §10-1(간접) · §8-6 표.
  (`plan-api.md:1045` 의 「`LINE_REQUIRED` = 취급단위 `:pack`」도 같이 정정 — 아래 §5)
- **R-2 ✏** — `qty <= 0` 은 `INVALID` 가 아니라 **`RANGE`** 다(`HandlingUnitContentUpsert.qty` `exclusiveMinimum: 0` 실측 ·
  mapper 의 `RANGE_KEYWORDS` 에 `exclusiveMinimum` 실재). **I-8 R-15**(`I-8.md:39`)가 같은 판정을 이미 했다.
  고칠 곳: §1-6 5행 · §3-3 3행 · §4-2 8행 · §5-6 4행 · §9-2 #17 주변.
- **R-3 ✏** — §3-3 의 **갈래 순서가 틀렸다.** 실제 순서는
  `403(권한 가드) → 계약 본문 검증(REQUIRED/RANGE/INVALID) → Idempotency-Key(REQUIRED·비uuid INVALID) →
  If-Match 형식(INVALID) → 핸들러(X-Worker-No REQUIRED → 404 → 409)` 다.
  X-Worker-No 를 1순위로 적은 것(§3-1 ① · §3-3 1행)은 **핸들러 안**이므로 본문 형식 오류보다 **뒤**다.
  ⇒ e2e #18 은 **유효한 본문**으로 쏴야 400 `REQUIRED`(`X-Worker-No`)를 본다. 단위 #3 도 같이 문구 정정.
- **R-4 ✏ (⭐ 계약 위반 위험)** — **멱등 재전송이 `ETag` 를 잃는다.** `runIdempotent` 는 `outcome.body` 만 돌려주고
  `setEtag` 를 **안 부른다**(`master-write.ts:20-37`). 계약은 `POST /inventory/handling-units` **201 에 ETag 를 선언**했고
  응답 본문에는 `version_no` 가 없다(공유계약 A-4 · `optimistic-lock.ts:11-18`) ⇒ 재전송 응답에서 ETag 를 만들 원천이 사라진다.
  대책은 `runVersioned` 가 쓴 모양 그대로 — work 반환을 `{ versionNo, view }` 로 만들어 **캐시 본문에 버전을 실은 뒤**
  컨트롤러가 `setEtag` 하고 `view` 만 내린다(`master-write.ts:39-56`). §4-1 ⑧ · §8-1 컨트롤러 행 · §8-6 에 못 박고,
  e2e #19 에 「**재전송 응답에도 `ETag` 가 온다**」 단언을 붙인다.
- **R-5 ✏** — §1-5 의 `repackTypeCode`·`roleCode` 「서비스 손검사 400 `INVALID`」는 **도달 불가**다.
  7 오퍼레이션의 요청 본문(`HandlingUnitCreate`·`HandlingUnitContentUpsert`·`HandlingUnitPack`) 어디에도 그 두 칸이 **없다**(전수 실측).
  둘 다 서버가 고정(`'RECONFIGURE'`)·도출(`SOURCE`/`RESULT`)하므로 검증할 입력이 없다.
  ⇒ §1-5 두 행의 판정은 「**입력 자리가 없다 — 서버 고정값이므로 검증 0**」으로, §1-6 의 「enum 밖 → `INVALID`」행은 **삭제**.
  (계약 enum 이 정본이라는 결론과 신설 표에 CHECK 를 안 거는 결정은 그대로 ✅)

---

## 3. R-6~R-10 — 계약 문장·문의·e2e

- **R-6 ✏(문장)** — ② 는 `plan.md` §0 **#10 을 뒤집지 않는다.** #10 이 스스로 단 단서가 그대로 걸린다:
  「⚠ **계약이 응답에 `required` 로 적은 자리에는 안 선다** … 그 자리는 상수(… I-3 재수립 R-9)」(`plan.md:24`).
  뒤집히는 것은 **`plan-api.md:194` 의 「고정 상수 하나」뿐**이다. §0-2 ② · §3-2 · §12-1 의 문구를 그렇게 좁힌다
  (지금 표현은 통합자가 `plan.md` §0 #10 본문을 고치게 만든다 — 고칠 것이 없다).
- **R-7 ✏(문의 141)** — 141 은 새 물음이 **맞다**(`design-inquiries/` 001~062 · `계약-되돌림-mdm.md` 에 취급단위 항목 0건 · 같은 회차
  120~125·130~135 와 겹침 0). 다만 **문의 053 의 일곱째**이므로 그 파일을 인용하고 **차이**를 첫 줄에 적어야 한다 —
  053 은 「상수를 **판정에는 쓰지 않는다**(조회도 대조하지 않는다)」로 위험을 닫았는데,
  **I-16 의 상수는 `:pack` 의 409 판정에 쓰인다.** 값 목록이 뒤에 오면 데이터가 아니라 **거부 동작**이 바뀐다 — 053 보다 무겁다.
- **R-8 ✏(문의 142 · 409 봉투)** — `:pack` 의 두 409 가 **클라이언트에게 구분되지 않는다.**
  `ConflictResponse` 는 `conflictCause`(enum `user`·`erpSync`·`workerLease`) + `message` **둘뿐**이고 `code` 칸이 없어(실측)
  「이미 확정 — 재로드해도 안 풀린다」와 「낡은 토큰 — 재로드로 풀린다」가 같은 봉투로 나간다.
  그 둘을 **반드시 갈라야 한다**고 적은 것이 공유계약 G-1 이고 `error-codes.ts:4-6` 이 그 주석을 들고 있다.
  ⇒ 순서를 못 박는 것(§3-3 주)만으로는 부족하다. **`message` 문구를 상수 둘로 갈라** e2e #23·#25 가 그 문자열을 단언하고,
  **문의 142 에 한 줄**(「409 두 뜻을 가를 칸이 계약에 없다」)을 더한다. 새 `ERROR_CODE` 는 여전히 **0**이다.
- **R-9 ✏(e2e 공백 2 · ⭐ 신설 표를 «안 지나는» 것을 못 박는 시험이 없다)**
  ⓐ **`POST`(contents 포함)와 `:pack` 뒤 `repack-events` 가 0건**이라는 e2e 가 없다. 계약이 반대 방향까지 못 박은 자리다
  (`HandlingUnitRepackEvent` description 「**신규 생성분(신규 발번)은 이 이벤트가 아니라 `POST /inventory/handling-units` 가 별도로 만든다**」).
  §3-4·§5-3 이 계획의 심장인데 **그 판정을 지키는 시험이 0** 이다 — 마이그가 만든 칸을 잘못 채워도 아무도 안 붉어진다(I-13 R-15 와 같은 종류).
  ⓑ **`PUT …/contents` 200 · `:pack` 200 에 `ETag` 헤더가 없다**는 단언이 없다(4축 실측 — 두 응답에 `headers` 키 자체가 없다).
  ⇒ e2e **31 → 33**(#20·#28 에 헤더 부재 단언을 얹거나 독립 2건).
- **R-10 ✏(§10-1 #10)** — 빈 배열 `PUT` 허용 판정 자체는 **✅**(계약이 `minItems` 를 `:pack` 에만 걸었다 = 명시 신호).
  다만 그 결과가 **`:pack` 이 세운 불변식을 사후에 깬다** — 「내용물 없이 확정할 수 없다」(`HandlingUnitPack` description)로 닫은 포장을
  `PUT` 이 **빈 `PACKED`** 로 만든다. §10-1 #10 과 §5-1 에 그 충돌을 적고 **문의 143 에 ⓓ** 로 올린다(허용/거부를 계약이 답한다).

---

## 4. 계획안이 맞다고 확인한 것 (재측정 아님 · api 축 전수)

- **횡단 4축 ↔ `responses.*.headers` 실측** — ETag 응답 헤더는 `POST` **201** 과 `GET …/{id}` **200** 둘뿐, `PUT …/contents` 200·`:pack` 200 에는
  `headers` 키가 **없다**. If-Match 는 `PUT`·`:pack` 둘 다 `IfMatchVersionOptional`(`required:false`), 멱등 3건, 403 3건. **§1-1 표 전건 일치.**
  `plan-api.md` 4축 표(204~218행)도 이 7행은 계약과 어긋나지 않는다 — 고칠 것 0.
- **`runVersioned` 불가** ✅ — 가드가 `optional` 이면 헤더 없이 통과시키고(`optimistic-lock.guard.ts:40`) `runVersioned` 는 값이 없으면 던진다(`master-write.ts:47-51`).
- **새 `ERROR_CODE` 0건** ✅ — `error-codes.ts` 전수: `REQUIRED`·`RANGE`·`INVALID`·`UNIQUE_VIOLATION`·`LINE_REQUIRED` 실재(R-1·R-2 로 실제 쓰는 것은 앞 넷).
- **권한 등록 0줄** ✅ — `derived-permissions.ts:165`·`:166`·`:264` 실재. ⭐ 보강: `plan-api.md:967` 표의 슬라이스별 건수 합이 **정확히 28**
  (S02 3·S01 3·S03 1·S04 2·S05 2·**S07 4**·S08 1·S09 4·S10 1·S13 2·S15 2·S16 1·S23 1·S24 1)이라, `:725` 의 「S07(**6건**)」은 **산술로도 오기**다.
- **채번** ✅ — `DEFAULT_PATTERN_SUFFIX = '-{YYYYMMDD}-{SEQ4}'`(`numbering.service.ts:33`)라 `HU-{YYYYMMDD}-{SEQ4}` 가 기본 패턴 그대로이고,
  계약 example `HU-2026-000058`(파일 전체에서 유일한 `HU-` 문자열)은 형식만이다 — `GI`·`SR`·`MR` 주석과 같은 모양. 기간 축 = 서버 UTC 날짜 ✅(`HandlingUnitCreate` 에 `businessDate` 0).
- **문의 5건** — 140·142·143·144 는 새 물음이 맞다(041~062 · README §0 대기 15 · 120~125/130~135 와 겹침 0). 141 만 R-7 처럼 053 을 인용한다. **최종 5건 유지.**
- **멈춤 조건 미해당** ✅ — 마이그가 `CREATE` 2 + `INDEX` 1, 삭제·완화 0 ⇒ 두 릴리스 규칙 미해당(README §3). 계약끼리의 모순도 없다(⓶ 는 계약 «안»의 침묵이지 모순이 아니다).

---

## 5. `plan*.md` 에 반영할 것 (§12-1 에 더하거나 고칠 행)

| 문서·줄 | 계획안이 적은 것 | api 재검토 |
|---|---|---|
| `plan-api.md` **1045행** | 「`LINE_REQUIRED` 400 — 라인이 0건(**취급단위 `:pack`**·전표 생성) · S02·S04·S07」 | **`취급단위 :pack` 을 뺀다** — 계약 `minItems:1` 이라 가드가 `RANGE` 로 먼저 막는다(R-1 · I-8 선례). §12-1 에 **행 추가** |
| `plan-api.md` **194행** | 「고정 상수 **하나**」 | 계획안 정정안 그대로 ✅ (단 `plan.md` §0 #10 은 **고칠 것 없음** — R-6) |
| `plan-api.md` **725행** | 「S07(6건)」 | 계획안 정정안 ✅ + 근거 보강(합계 28 산술 — §4) |
| `plan-api.md` **190·1099행** | 마이그 「없음」 · 채번 「재포장 `reconfiguration_no` ❌」 | 계획안 정정안 그대로 ✅ |
| `plan.md` **§0 #10** | — | ⛔ **고치지 않는다**(계획안 §0-2 ② 의 「뒤집는다」 표현만 좁힌다 · R-6) |

---

## 5줄 요약

1. **`I-16.md` 반영 수정 10건** — R-1 `:pack` 빈 배열 = **`RANGE`**(`LINE_REQUIRED` 아님) · R-2 `qty<=0` = **`RANGE`** · R-3 갈래 순서(계약 가드가 `X-Worker-No` 보다 먼저) · R-4 **멱등 재전송이 201 ETag 를 잃는다** · R-5 `repackTypeCode`·`roleCode` 손검사는 도달 불가 · R-6 `plan.md` §0 #10 은 안 뒤집힌다 · R-7 문의 141 에 053 인용+차이 · R-8 409 두 뜻이 봉투로 안 갈린다(문의 142 한 줄) · R-9 e2e 2건 추가(신설 표 **0행** 단언 · ETag 부재) · R-10 빈 `PACKED` 불변식 충돌(문의 143 ⓓ).
2. **`plan*.md` 반영** — `plan-api.md:1045` 에서 「취급단위 `:pack`」 삭제(신규) + 계획안의 190·194·725·1099 정정안 유지. `plan.md` §0 #10 은 **무변경**.
3. **문의 최종 5건**(140~144 · 번호 그대로). 141 에 053 인용 · 142 에 409 구분 불가 한 줄 · 143 에 ⓓ 한 줄만 덧댄다.
4. **⛔ 반대 0건** — 「반드시 볼 자리 5」 전건 ✅ 동의(①②③④⑤). 세부 사실 ⛔ 는 R-1·R-5 둘.
5. **멈춤 조건 미해당** — 마이그는 `CREATE` 2 + `INDEX` 1, 삭제·제약 완화 0(README §3). PR 분할 4 와 조회 PR ① 병렬 스폰도 그대로 성립한다.
