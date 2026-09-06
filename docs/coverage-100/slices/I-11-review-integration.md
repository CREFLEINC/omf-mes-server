# I-11 재검토 — **integration 관점** (브리프 `brief-I-11-review.md` 13항 + 통합자 추가 정보 대조)

> 실측: worktree `docs/coverage-100-i11-plan` · main `1729dc1` · 계약 `a6a87e1` · 2026-09-07. 코드·계약·`schema.prisma`·`seed.ts` 직접 대조.
> ✅ 동의 / ✏ 수정 / ⛔ 반대.

## 1. ⭐⭐ 단말 토큰 — **✏ 통합자의 C 를 받되 `POST /work-sessions` «하나»만 예외로 남긴다**

**결정적 실측(두 오퍼레이션의 계약 문장이 다르다)**
- `POST /production/work-sessions` description: ⌜**단말 게이팅(can_start_work)을 서버가 강제한다**⌝ + ⌜여는 조건이 전부 «판정값»이라(can_start_work·점검 이력·W/O 상태) 캐시하면 **차단해야 할 작업이 열린다**⌝ + 근거에 **F-6**.
- `POST /production/material-consumptions` description: 게이팅 문장이 **한 줄도 없다**(「오투입 판정이 서버에서 일어난다」뿐). ⇒ **I-10 의 「게이팅 ✕ + C」는 옳고, 그 근거가 I-11 로 옮겨오지 않는다.**

**판정** — 통합자 방향(Bearer 있으면 채우고 없으면 NULL)을 **세션 도메인의 기본값으로 채택**한다. 단:
- ⛔ **`POST /production/work-sessions` 에서 「토큰 있을 때만 게이팅」은 불가**하다. 헤더를 빼면 계약이 「서버가 강제한다」고 못박은 게이트가 통째로 열린다 — **판정 불가를 통과로 처리하는 것**이라 F-6 정면 위반이고, `transitions.ts` 머리 주석이 인용한 바로 그 조항이다. 통합자가 스스로 지적한 「반쪽 게이트(A-21)」가 여기서 성립한다.
- ⇒ **이 한 오퍼레이션만 B**: Bearer 없으면 **400 `REQUIRED`**, 오면 서명·`typ`·존재·`is_active`·`token_version` 검증(어긋나면 400 `INVALID`). 나머지 셋(`:end`·events·`workers`/`:leave`)은 **C** — 오면 채우고 없으면 비운다. `work_session_event.terminal_id` 는 **이미 nullable**(실측)이라 C 가 마이그 없이 선다.
- ⇒ ⭐ **`work_session.terminal_id` NOT NULL 완화 마이그는 «필요 없다»** — 그 칸을 쓰는 INSERT 는 `POST /work-sessions` 하나뿐이고 거기서는 값이 언제나 선다. **마이그는 `shift_id` 완화 1건 그대로**(조건 ① 판정·D1 형식 복제 유지 · `plan.md` §4 신설 행도 한 줄로 끝난다).
- ⓐ 「종류로 X-Worker-No 필수 여부를 가른다」가 **토큰 없는 호출을 상정한다**는 통합자 독해 ✅ 동의. 그래서 I-11.md 의 「귀속 축으로만 쓴다」 문장은 **틀렸고**(계약은 인증 축을 말한다) 정정해야 한다. 다만 그 문장이 「이 오퍼레이션도 토큰 없이 불릴 수 있다」를 뜻하지는 않는다 — 이 오퍼레이션의 게이트 문장이 그것을 막는다.
- ⓒ **오늘 보낼 수 있다** ✅ — `POST /mdm/terminals/{terminalId}:issue-token` 이 계약·구현 둘 다 실재(`terminal.controller.ts:95`). e2e 가 진짜 토큰을 받아 쓴다.
- ⓓ **「업무를 없애는 거부」 아님** ✅ — `AuthenticationGuard` 의 `ANONYMOUS` 는 로그인 하나뿐이라 **오늘 POP 은 Bearer 와 무관하게 401**(`plan.md` §6 배포 노트가 이미 적었다). 400 이 새로 죽이는 업무는 0.
- ⓔ `src/auth/` 배치 ✅(`TOKEN_TYPE`·`JwtModule` 이 거기 산다 · `auth.module.ts:35`). **코어 아님.**
- ⓕ `token_version`·`is_active` 근거 ✅ — `terminal.service.ts:196` ⌜발급마다 올린다 … 이전 기기 전부가 끊긴다(F-4)⌝.
- ⓖ 응답 검증 가드 부재는 판정을 안 바꾼다 — 축은 응답이 아니라 게이트다.
- ⭐ **헬퍼 자리: ②가 아니라 ③ ✅**(I-11.md 원안 유지). I-10 이 헬퍼를 안 쓰기로 한 순간 ② 로 올릴 이유(두 레인 공통 선행)가 사라진다. 코어(원장·상태기계·posting·마이그) 밖이라 **코어 전용 PR 의 「전용」을 흐리지 않는 편이 맞다.** ③ 예산은 원안 그대로 ~310(토큰 ~55 포함).
- ⚠ **통합자가 균일 C 를 고집한다면 값을 세 개 함께 버려야 한다**: ① 게이팅을 **전면 폐기**(반쪽은 금지) — 계약 명문 「서버가 강제한다」와 어긋나므로 **문의 필수 항목이 하나 는다** ② `shift_id` 도출이 전건 NULL 이 되어 `shift-resolver.ts`(~55)와 단위 4건이 **죽은 코드** ⇒ ② 에서 뺀다 ③ 응답 `terminalId`(required) 키 생략 + 완화 마이그 1 추가. 셋을 다 받을 값이 있는지는 통합자 판정이다.

## 2. 게이팅 `can_start_work` — ✅ (분기 삭제 · 흔적 추가)

- 판정 입력이 **언제나 풀린다** — `work_order.routing_operation_id` **NOT NULL** · `routing_operation.process_id` **NOT NULL**(실측) ⇒ 계획의 「NULL 이면?」 분기는 **지운다**.
- 행 부재도 거부 ✅ · 403 을 서비스가 냄 ✅(`permission.guard.ts:37-53` 은 계약 403 선언 자리에서 **계정 권한**만 본다 — 축이 다르다) · `terminal_process` 마스터 등록 오퍼레이션 실재 ⇒ 「업무를 없애는 거부」 아님.
- ✏ `:end`·`workers`·`:leave` 의 403 설명도 **같은 문자열**(「단말·권한 게이팅에 막혔다」 실측)이고 `terminal_process` 에 `can_complete_work` 가 **실재**한다 ⇒ 「그 셋엔 안 건다」를 표 한 줄로 두지 말고 단위 테스트(`:end 는 terminal_process 를 읽지 않는다`)로 못박는다.

## 3. `shift_id` 도출 · 마이그 1 — ✅ + ✏ 셋

- 마이그 1 ✅ · D1 형식 복제 ✅(`20260906600000/migration.sql` 실물 대조 — 사전 대조 SQL·FK 미변경 주석 틀이 같다).
- **대체 축은 ⛔** — 통합자가 물은 `work_order.production_plan → production_order.plant_id` 는 `work_order.production_plan_id` 가 **nullable** 이라(실측 · 긴급 W/O = 계획 없는 `POST`) **정확히 우회를 쓰는 모집단에서 뚫린다.** 게다가 계약이 도출 축을 「요청을 인증한 **단말**의 공장」으로 못박아 다른 축은 조용한 도출이다. ⇒ 토큰이 없으면 **NULL**(§1 대로 이 오퍼레이션은 토큰이 늘 있으므로 실제로는 도달하지 않는다).
- ✏ **`shift.start_time`·`end_time` 은 `@db.Time(6)`** ⇒ Prisma 가 1970-01-01 기준 `Date` 로 준다. **UTC 게터로 시:분을 읽는다**(로컬 게터면 축이 서버 TZ 에 매인다). 단위 테스트 1건 추가.
- ✏ Intl 은 `hourCycle:'h23'` 로 **시:분만** 뽑고 초는 버린다 — 반열림 경계가 「분」 단위임을 테스트 이름에 적는다. 선례(`operation-policy.service.ts:219`·`mold-derivation.ts:96`)는 **날짜뿐**이라 시:분은 이 슬라이스가 처음이다. SQL 캐스팅 아님 ⇒ CLAUDE.md 위반 ✕ ✅.

## 4. ⭐ `transitions.ts` — ✅ 신설 · ✏ 넷

- **유혹 9 미해당 ✅ 실측** — `seed.ts:348` 주석이 ⌜`work_session.status_code` … **A-25 전이표가 뜻을 정했다: START·RESUME→RUNNING · STOP→STOPPED · END→ENDED** … ⛔ 시스템 소유⌝ 를 이미 적었다. 지어낸 값 0.
- **서비스 상수 대안 ⛔** — 등록부를 우회하면 유혹 9 의 방어(「등록하는 귀찮음」)를 스스로 없앤다. `plan-integration.md` §3-1 I-11 행도 「상태기계 ⭕ 세션」이다.
- ✏ **`document-state.spec.ts` 를 반드시 함께 고친다** — 그 스펙은 **칸 목록 배열**과 `expect(service.registered()).toHaveLength(21)` 을 단언한다(`:163-206` 실측). ② 는 21→**25** + 칸 목록에 `production.work_session.status_code` 추가까지 해야 한다. 「전이 4건」만 적으면 **기존 게이트가 깨진다**. `sourceOperation` 실재 단언은 4경로 계약 실측으로 **통과** ✅.
- ✏ **`from:['RELEASED','IN_PROGRESS']` ✅ 이나 `SUSPENDED` 제외가 막다른 길을 만든다** — `work-order-resume`(SUSPENDED→IN_PROGRESS)은 표에 **이미 있으나**(`transitions.ts:154`) 부르는 화면이 **0건**이다(`P-02-01` §5-5 ⌜⛔ `:resume` 를 부르지 않는다⌝ · `P-02-10` 매핑에 W/O 액션 0). ⇒ 중단→재개하면 세션만 살아나고 **W/O 는 SUSPENDED 로 남아 `:end` 뒤 둘째 세션이 영원히 400**. 035 인용 한 줄로 넘기지 말고 **본문에 이 막다름을 명시** + e2e `SUSPENDED 로 남은 W/O 는 :end 뒤 둘째 세션을 못 연다` `// 문의 035`. (`from` 에 `SUSPENDED` 추가는 ⛔ — 화면이 「작업 시작 = 상태 배포」로 못박았다.)
- ✏ **13단계 12번은 `locked.status_code === transition.to` 면 UPDATE 를 건너뛴다** — 안 그러면 둘째 세션마다 W/O `version_no` 가 올라 화면 If-Match 가 낡는다(§11-3 ⓜ 가 스스로 적은 부작용). 단위 테스트로 못박는다.

## 5. precheck — ✅

`controlLevelCode` 대조 ✕ ✅(`PRECHECK_CONTROL_LEVEL` 은 `operation-policy-rules.ts:17` 실재 · `operation_policy` **0행** — 켜면 본길이 막힌다) · `basisInspectionId` FK 존재만 ✅ · 긴급 값 **`EMERGENCY`** ✅(`seed.ts:1270`) · 세션 열기의 긴급 재판정 ✅(계약이 한 문에만 적었으므로 §11-1 에 「계약이 안 적은 자리에 판정을 더했다」 흔적 유지).

## 6. `:end` — ✅

W/O 무변경 ✅(`work-order-close.from` 에 `IN_PROGRESS` 실재) · `stopReasonCode` 받아 저장 ✕ ✅ · `left_at` 자동 ✕ ✅ + 문의 · 이미 ENDED 400 ✅.

## 7. `/workers`·`:leave` — ✅ + ✏ 하나

`derived-permissions.ts:243-245` 에 셋만 있고 둘이 **없다**(실측) ⇒ 미등록 500 실재 · `manual-permissions.ts` 등록 근거는 `goods-issues/{id}/lines` 선례와 같은 모양 ✅. 중복 참여 400 + 세션 `FOR UPDATE` ✅(물리 UNIQUE 없음). ENDED 참여 400 / 이탈 허용의 비대칭 ✅(§4-8 과 짝). ✏ 「If-Match 를 받되 `version_no` 를 안 올린다」를 **e2e 한 줄**로 못박는다.

## 8. If-Match 를 W/O 버전과 대조 — ✅

`production-result.service.ts:88` 실측 — `lockWorkOrder` → `assertVersion(locked, context.version)` → 상태 게이트, **순서까지 같다**. `runVersioned` 미사용 근거(토큰 부재 시 던짐) ✅.

## 9. `X-Worker-No` — ✅ 통합자 방향과 일치 (숫자만 ✏)

실측 사본 **넷**(`assertWorkerNo` ×3 — `lot-complete:164`·`picking-pick:163`·`shopfloor-receipt:192` · `resolveWorker` ×1). I-10 이 공용화를 후속 순수-이동 PR 로 뗀 이상 **I-11 도 만들지 않는다** ✅ — 파일 로컬 사본을 쓰고(세션 셋 한 벌 = **다섯째**, precheck 의 `resolveWorker` = **둘째**) 스윕 PR 이 한 번에 옮긴다. 두 병렬 레인이 같은 신설 파일을 각자 만드는 add/add 충돌이 이로써 사라진다. 「존재 확인 후 버림」이 I-9 R-11 과 다른 근거(저장 안 해도 400 `INVALID` 를 내려면 조회가 필요) ✅. 규칙 9 예외 4→8 ✅ — ✏ **`plan.md` §5 는 계획 PR 이 아니라 예외가 실제로 서는 커밋(③·⑤)에서** 고친다.

## 10. 조회 5 — ✅

계약 질의 칸 재실측(`open`·`workOrderId`·`terminalId`·`shiftId`·`startedFrom/To`·`page`·`size` / `active` / `eventTypeCode`) — 계획과 **일치**. 여집합·정렬·자식 GET 404·ETag 0 ✅.

## 11. 문의 — ✏

- **050+1 → I-10 054 병합 ✅**(통합자 지시대로). 본문에 ⓐ 「종류」 문장이 토큰 없는 호출을 상정한다는 사실 ⓑ **그런데 `POST /work-sessions` 만은 계약이 서버 강제 게이트를 걸어 토큰을 사실상 필수로 만든다**는 비대칭을 함께 싣는다 — 이 비대칭이 회신이 필요한 핵심이다.
- ✏ **신규 3 → 2 를 권한다** — 050+3(참여·이탈 화면 0건 + 사번 행선지)과 050+4(`:end` 의 작업자)는 **같은 표·같은 결손**이라 따로 물으면 회신이 갈린다. 합치면 056(역할 기본값 `OPERATOR`) · 057(세션 참여자 축 — 만드는 경로·사번 행선지·`:end` 마감). 3건 유지도 무해하니 최종은 통합자 판정.
- 035 인용에 **판정 4 의 막다른 길** 추가 · 해소 보고 1 ✅ · 알려둘 것 12 → **14**(+ 세션 열기만 토큰 필수인 비대칭 · + `production-result.service.ts:137` 주석 「단말 토큰이 아직 없다」가 ③ 병합으로 거짓이 되어 두 줄 정정).

## 12. e2e·PR·모델 — ✏ 둘

- e2e **54 과하지 않다** — 선례 `production-work-order` 47건/13op · `production-production-result` 40건/7op. 파일 둘로 갈려 회귀는 파일 단위 1회 ✅.
- PR **5** ✅ · **② 코어 전용 ~110 ≤200** ✅(터미널 토큰을 안 올리므로 원안 그대로) · ③ opus ✅ ~310.
- ✏ **④ 를 opus 로** — 전이 둘을 «타고» 동시성 잠금(중복 참여)·400/409 봉투를 가른다. README §4 의 「기존 패턴 복제」가 아니다. ⇒ **sonnet ×2(①⑤) · opus ×3(②③④)**.
- ✏ 「③ 스폰 전 050+1 답 맞춤」 → **이 재검토로 답이 섰다**. ② 는 토큰과 무관하므로 **즉시 스폰 가능**하다.

## 13. 자기 관점(`plan-integration.md`) 대조 — 구현 영향만 ✏ 다섯

| 자리 | 정정 |
|---|---|
| 309행 「`idempotency_key` 는 한쪽만」 | **둘 다** — I-7 실측(`production-result.service.ts:145` 「멱등 기록 만료 뒤 둘째 그물」) |
| 311행 「판정 입력 세 표」 | **두 표**(`routing_operation`→`terminal_process`) · 점검 이력은 서버가 안 본다 |
| §3-1 I-11 행 「마이그 ✕」 | **1**(`shift_id` 완화만 · `terminal_id` 는 §1 대로 **불필요**) |
| §5 병렬 표에 **I-10 ∥ I-11 이 없다** | 헬퍼 충돌은 사라졌지만 **`production.module.ts` 한 파일**은 여전히 겹친다 — I-3 ∥ I-12 와 같은 「모듈 등록 줄 재베이스 1~2줄」 행을 추가한다 |
| §4-1 M2 「투입 → 세션」 | FK 가 nullable 이라 강제는 아니나 `work_session_id` 를 채우려면 **세션이 먼저**. 체인 e2e 는 두 슬라이스 병합 뒤 통합자가 세운다 |

✅ 통합자 추가 항목 — **문의 040 인계 한 줄 동의**: `mdm.terminal.plant_id` 가 **NOT NULL** 이라(실측) 세션 열기에서 토큰이 서는 순간 「긴급 W/O 의 공장」을 단말에서 풀 수 있다. `I-11.md` §12 인계 표에 **I-6/I-24 행 한 줄**로 적는다(040 의 답 후보 — 이 슬라이스가 값을 쓰지는 않는다).

---

**재수립 결과 5줄**
1. **I-11.md 수정 9건** — ⓐ §2-2 ⓑ 의 「귀속 축」 문장 정정(계약은 인증 축) + **`POST /work-sessions` 만 토큰 필수, 나머지 셋은 C** ⓑ `terminal_id` 완화 마이그 **불필요**(마이그 1 유지) ⓒ `document-state.spec.ts` 칸 목록·`21→25` 를 ② 범위에 명시 ⓓ `SUSPENDED` 막다른 길 명시 + e2e 1 ⓔ 13단계 12번 「같은 값이면 UPDATE 안 함」 ⓕ 게이팅의 `routing_operation_id` NULL 분기 삭제 ⓖ shift 도출 `@db.Time` UTC 게터·분 단위 테스트 2건 ⓗ worker-no 공용화 안 함(다섯째 사본) ⓘ `production-result.service.ts:137` 주석 정정을 ③ 에 포함.
2. **plan.md 반영** — §4 에 I-11 행 신설(`work_session.shift_id` 완화 1) · §1 46행 마이그 「—」→1 · PR 3→5 · 모델 sonnet→**sonnet ×2 · opus ×3** · §5 규칙 9 예외 4→8(고치는 커밋은 ③·⑤) · 병렬 표에 I-10 ∥ I-11 모듈 줄 충돌.
3. **문의 최종** — 공유 1(**054 에 병합** · 비대칭을 본문에 추가) + 신규 **2 권고**(056 역할 기본값 · 057 세션 참여자 축 — 통합자가 3 으로 유지해도 무해) · 기존 인용 035(막다른 길 추가) · 해소 보고 1 · 알려둘 것 **14**.
4. **PR·모델 최종** — ①조회 sonnet ~330 / ②**코어 전용** opus ~110(마이그 선행 커밋 + `transitions.ts` + `shift-resolver.ts`) / ③심장+단말 토큰 opus ~310 / ④events·workers **opus** ~279 / ⑤precheck sonnet ~125 · 스택 ①→②→③→④, ⑤∥ · ② 는 즉시 스폰 가능.
5. **단말 토큰 한 줄 판정** — 「**세션 도메인의 기본은 C**(오면 서명·`typ`·존재·`is_active`·`token_version` 검증해 채우고 없으면 비운다). **단 `POST /production/work-sessions` 하나는 B** — 계약이 ⌜단말 게이팅을 서버가 «강제»한다⌝ 로 못박아 토큰 없는 호출을 허용하면 반쪽 게이트(F-6 위반)가 되므로 **없으면 400 `REQUIRED`**. 그 결과 **`work_session.terminal_id` 완화 마이그는 필요 없고 마이그는 `shift_id` 1건 그대로**다.」
