# I-11 개별 계획안 재검토 — **api 관점**

> 대상 `slices/I-11.md`(875줄) · 브리프 「판정할 것」 13항 · 자기 관점 정본 `plan-api.md` S15(388~409)·818~820·972·§5.4.
> 실측 기준: worktree `docs/coverage-100-i11-plan` · main `1729dc1` · 계약 `a6a87e1` · 2026-09-07. 근거는 전부 파일:행/계약 키/화면 절.
> ⚠ 통합자 추가 정보(I-10 §0-재수립 R-3 = 「C안 — 오면 채우고 없으면 비운다 + `terminal_id` 완화 마이그」)를 **판정 1 에서 정면으로 갈랐다.**

## 1. ⭐⭐ 단말 토큰 — **✏ I-10 의 C안을 반만 받는다**(축은 공용, 부재 시 처리는 오퍼레이션마다 계약이 다르다)

### §2 절차를 명시로 밟는다
**0단계 선례** — ⓐ `production-result.service.ts:142` ⌜`shift_id`·`terminal_id` 는 비운다 … **단말 토큰이 아직 없다**⌝ = 저장소의 기존 입장(I-11 §2-2 ⓑ 는 「선례 없다」로만 적었다 — **이 주석을 인용해 「우리가 뒤집는 입장」으로 세워야 한다**) ⓑ 그 선례가 성립한 조건은 **칸 nullable + 응답 required 밖**이고 세션은 둘 다 반대다(실측 `schema.prisma:2988` `terminal_id BigInt` · `WorkSession.required` 에 `terminalId`).
**1단계** — 모든 호출에서 갈리므로 **본길** ⇒ 「임의로 못 고른다. 계약 문자 그대로 + 문의.」
**계약 문자(실측)** — ⓐ `app-공통.json` `securitySchemes.terminalToken`(http bearer) ⌜기기가 저장해 보낸다. 서버는 이 토큰의 «종류»로 X-Worker-No 필수 여부를 가른다⌝ ⓑ `security` 부착 **0건**(487 전건 · top-level 도 7벌 전무 — 통합자 실측과 일치) ⓒ `WorkSessionCreate.shiftId` ⌜시작 시각과 **요청을 «인증한» 단말의 공장**⌝ ⓓ `WorkSession.terminalId` **required**(설명 0줄) ⓔ **`POST /production/work-sessions` description ⌜단말 게이팅(`can_start_work`)을 서버가 «강제한다»⌝** ⓕ 화면 `P-CO-01` §5-4 코드블록 ⌜`Authorization: Bearer <단말 토큰> ← 인증` / `X-Worker-No ← 귀속. 인증 아님`⌝ · §3.1 표 ⌜인증=단말 토큰(**유일한 보안 경계**) / 기능구성=`terminal_process` 8플래그 / 귀속=사번⌝.
⇒ 계약·화면은 이 토큰을 **인증 축**으로 못박았다(브리프 검토점 ⓐ 의 답 — **귀속 축이 아니다**). I-11 §2-2 ⓑ 의 ⌜`X-Worker-No` 와 같은 «귀속» 축⌝ 은 **실측과 어긋난 표기**라 고쳐야 한다.

### 갈리는 자리는 「없을 때」 하나뿐 — 세 갈래를 실측으로 가른다
| | I-11 B안 400 `REQUIRED` | I-10 C안(비운다) | **이 리뷰 ✏** |
|---|---|---|---|
| 계약이 안 건 헤더를 서버가 요구 | ⭕ 위반(README §5) | ✕ | ✕ |
| `WorkSession.terminalId` **required** 를 못 채움 | ✕ | ⭕ 위반(규칙 7 은 «선택» 칸 규약이다) | ✕ |
| 계약이 명령한 `can_start_work` 강제가 **반쪽 게이트**(A-21) | ✕ | ⭕ | ✕ |
| `terminal_id` 완화 마이그 | 0 | 1 | **0** |
- ⛔ **B안의 400 `REQUIRED` 는 기각한다** — 계약이 어느 오퍼레이션에도 `security`·`Authorization` 을 안 걸었으므로 계약 유효 요청을 서버가 400 으로 막는 것이 맞다(통합자 지적 수용).
- ⛔ **C안을 `POST /work-sessions` 에 그대로 적용하는 것도 기각한다** — 형제 `POST /production/material-consumptions` 는 description 에 **단말 게이팅 문장이 0줄**(실측 — 서버 몫은 「오투입 판정」뿐)이라 거기서는 토큰이 순수 귀속이다. **세션 열기만 계약이 「서버가 강제한다」고 적었다.** 두 오퍼레이션은 토큰 «해석»은 같고 «부재 처리»가 다를 수밖에 없다.
- ⇒ **✏ 채택안** — `resolveTerminalId(request)` 는 **헤더가 없으면 던지지 않고 `null`** 을 낸다(I-10 과 완전히 같은 헬퍼·같은 서명). 온 경우만 서명·`typ`·행 존재·`is_active`·`token_version===tv` 를 보고 어긋나면 400 `INVALID`(근거 `terminal.service.ts:196-198` ⌜발급마다 `token_version` 을 올린다 … 이전 기기의 토큰은 클레임 `tv` 가 어긋나 거부된다(F-4)⌝ — 브리프 ⓕ ✅). **`POST /work-sessions` 에서만** `terminalId === null` 이면 **게이팅을 판정할 수 없으므로 403 `PERMISSION_DENIED`** — 400 이 아니다.
- **근거(F-6 · 이 저장소가 이미 4곳에서 집행한다)**: `transitions.ts:29`·`document-state.service.ts:25·45`·`document-state.spec.ts:103` ⌜판정할 수 없음을 통과로 처리하지 않는다⌝. 봉투도 계약이 이미 이 자리에 준 것이다 — 403 설명 ⌜**단말**·권한 게이팅에 막혔다⌝. 문구는 화면 G-3 그대로(`P-02-01` §5-1).
- **「업무를 없애는 거부」(I-4 §5-3) 에 안 걸린다 — 실측 셋**: ⓐ `terminal_process.can_start_work` 물리 **DEFAULT false**(`schema.prisma:2186`)이고 표가 **0행**이라 **토큰과 무관하게 오늘 전건이 이미 403 이다** — 토큰 조건이 막는 업무를 새로 없애지 않는다 ⓑ `P-02-01` §5-1 ⌜행이 없다 → **시작 불가**⌝ 가 그것을 «설계»로 못박았다 ⓒ 무등록 단말은 API 이전에 셸이 막는다(`P-CO-01` §8 ⌜단말 토큰 만료·폐기 — **이 화면 이전 단계다**, 셸이 「단말 등록이 필요합니다」로 막는다(`W-CO-06` §5-4)⌝). ⇒ 되돌림 비용도 최저다(헬퍼 1파일 + 분기 1줄 · 저장된 값은 진짜 `terminal_id` 라 데이터 정정 0).
- ⛔ **`work_session.terminal_id` 완화 마이그는 반대한다**(통합자 방향 중 이 한 줄만 ⛔) — 위 게이트가 서면 이 컬럼은 **NULL 로 태어날 경로가 0**이라 완화가 죽은 완화다(§2 2단계 **기준 3** 「스키마를 안 늘리는 쪽」). 완화해 두면 required 응답을 못 채우는 행을 «만들 수 있게» 열어 두는 셈이라 오히려 해롭다. **자식 둘은 이미 nullable 이다** — `work_session_event.terminal_id BigInt?`(`:3022`) ⇒ events·`:end` 는 토큰 없으면 **키를 안 넣으면 끝**이고 마이그가 필요 없다.
- 브리프 ⓔ ✅ `src/auth/terminal-token.ts` 자리 동의 — `TOKEN_TYPE`·`JwtService` 가 거기 산다. 코어 아님(`server-architecture.md` §2 코어 여섯에 인증 없음)이라 ③ 에 실어도 CLAUDE.md 200줄 규칙에 안 걸린다.
- 브리프 ⓖ **판정을 바꾸지 않는다** — 응답 검증 가드가 없다는 사실(`src/common/contract/` 에 요청 검증만)은 「required 를 비워도 테스트가 안 깨진다」일 뿐 계약 준수의 근거가 못 된다.
- 브리프 ⓒ ✅ 오늘 토큰을 실을 수 있다 — `POST /mdm/terminals/{terminalId}:issue-token` 이 계약·구현 **둘 다 실재**(`terminal.controller.ts:95`) · 단말 등록·8플래그 화면 `W-CO-06` 실재 ⇒ e2e 가 계정 세션으로 발급받아 Bearer 로 싣는 §10-1 픽스처가 **그대로 선다**.

## 2. 게이팅 `can_start_work`(§3-2) — ✅ + ✏ 두 줄
✅ 행 부재도 거부(`P-02-01` §5-1 실측) · ✅ 403 을 서비스가 냄(`permission.guard.ts:37-41` 은 계정 권한 축이고 이 축은 단말이다) · ✅ `:end`·events·workers 에 안 검(8플래그에 「중단」 없음).
✏ ⓐ **`work_order.routing_operation_id` 는 NOT NULL 이다**(실측 `schema.prisma` work_order 5행) ⇒ 「NULL 이면?」 분기가 **없다**. §3-2 에 한 줄로 못박아 리뷰가 열지 않게 한다. ✏ ⓑ 판정 1 의 결과로 **`terminalId === null` → 403** 분기를 §3-2 에 명시(F-6 인용).
⛔ 「토큰 없으면 게이팅 생략」(통합자 선택지 1)은 반대 — A-21 반쪽 게이트이자 F-6 위반이다. ⛔ 「게이팅 자체를 안 건다」(선택지 2)도 반대 — 계약이 「서버가 강제한다」고 적은 **유일한** 서버 몫이다. `terminal_process` 마스터 등록 경로는 실재한다(`PUT /mdm/terminals/{id}/processes` · `terminal.controller.ts:118`).

## 3. `shift_id` 도출(§3-3) — ✅ 축 유지 · ✏ 구현 함정 하나
✅ 마이그 1(`work_session.shift_id` DROP NOT NULL) — 계약 required 밖 + 명문 + D1 선례. **§2-3 SQL 은 그대로 둔다**(`terminal_id` 를 같은 파일에 넣지 않는다 — 판정 1).
✅ `terminal.plant_id` 축 유지 — 판정 1 의 게이트가 통과한 뒤라 **단말이 반드시 있다** ⇒ 통합자가 우려한 「대체 축(W/O→`production_order.plant_id`)」은 **필요 없고 넣어서도 안 된다**(계약이 축을 못박았고 그 사슬은 nullable 2홉 · 조용한 도출 금지 · I-11 §3-3 의 기각 근거 그대로).
✅ `Intl` 로 시:분만 뽑는 것은 「날짜 타임존 캐스팅 금지」에 안 걸린다 — 선례 `operation-policy.service.ts:226`·`mold-derivation.ts:96`.
✏ **함정** — `shift.start_time`/`end_time` 은 `@db.Time(6)` 이라 Prisma 가 **1970-01-01 UTC 의 `Date`** 로 준다. `getHours()` 로 읽으면 서버 로컬로 어긋난다. 선례가 있다 — `reference.service.ts:193` `row.start_time.toISOString().slice(11, 19)`. §3-3 에 이 한 줄과 단위 테스트 이름(`Time 칸은 UTC 로 읽는다`)을 넣는다.

## 4. `transitions.ts`(§5-1) — ✅ · ✏ 게이트 하나 빠졌다
✅ `from:['RELEASED','IN_PROGRESS']` 확장. **I-11 의 근거(둘째 세션)보다 강한 근거가 하나 더 있다** — I-6 §6-2 ⓒ 가 실측한 `RELEASED --hold--> SUSPENDED --resume--> IN_PROGRESS`(`transitions.ts:155` `work-order-resume` `to:'IN_PROGRESS'`) 경로에는 **세션이 한 건도 없다**. `['RELEASED']` 만 두면 그 W/O 는 **영원히 작업을 시작할 수 없다** = 진짜 「업무를 없애는 거부」. §5-1 에 이 문장을 더한다.
✅ `SUSPENDED` 제외 — 나가는 길이 `:resume`(→`IN_PROGRESS`)로 실재하므로 막다른 길이 아니다. ✅ 세션 키 신설이 유혹 9 미해당 — 시드 3값 실재 · `sourceOperation` 셋 다 계약 paths 에 실재(실측)라 `document-state.spec.ts:176` 단언 통과.
✏ **PR ② 가 반드시 함께 고칠 자리 — `document-state.spec.ts:188-204`** 가 등록된 «칸 집합»을 문자열 배열로 못박고 있다. `production.work_session.status_code` 를 더하면 **이 단언이 깨진다.** §14 PR ② 표에 「`document-state.spec.ts` 칸 집합 +1」을 명시하지 않으면 게이트가 먼저 붉어진다.
✏ 「서비스 상수로 두는 대안」은 ⛔ — C-2 가 「61개 표의 `if` 를 흩지 않는다」이고 `transitions.ts:145` 주석이 **이미 `I-11 이 같은 키에 work-session-start 를 더한다`** 라고 예고했다(실측).

## 5. precheck(§3-6·§7) — ✅ · ✏ 인용 한 줄 추가
✅ 서버가 안 읽음 · ✅ `controlLevelCode` 대조 ✕(`operation_policy` 0행 · 스냅샷 명문) · ✅ `basisInspectionId` FK 존재만(`equipment_inspection` 실재 `:4161`) · ✅ 긴급 판정 문자열 **`EMERGENCY`**(`seed.ts:1270` 실측) · x-internal-note ⌜서버가 `work_order_type_code` 로 판정하고 아니면 400⌝ 실측 일치 · ✅ `controlOverride` 도 같은 400(두 문 대칭).
✏ `POST /work-sessions` description 에 ⌜여는 조건이 전부 «판정값»이라(`can_start_work` · **점검 이력** · W/O 상태)⌝ 라는 문장이 **있다**(실측). §3-6 이 이 문장을 인용하지 않으면 리뷰어가 「계약이 점검 이력도 서버 몫이라 했다」로 Major 를 연다. ⇒ 「그 문장은 «오프라인 캐시 금지»의 이유이고, 서버 몫으로 적힌 것은 `can_start_work` 하나다」를 §3-6 에 못박는다.

## 6~10. 나머지
6. `:end`(§4) ✅ — 계약 `:end` description 에 `work_order` 언급 **0회**(실측) · `stopReasonCode` 받고 안 저장 ✅(I-6 `:hold` 선례) · `left_at` 자동 ✕ ✅(침묵 + 기준 4).
7. `/workers`·`:leave`(§6) ✅ — `derived-permissions.ts:243-245` 에 셋만 있고 둘이 없음 실측 ⇒ 미등록 500 확인. ⭐ **`plan-api.md` 972행이 이 둘을 이미 「도출표에 없어 수동 등록할 자리」로 세어 두었다** — §6-1 이 이 줄을 인용하면 「마스터 소유」 규약 논쟁이 끝난다. 중복 참여 400 + 세션 `FOR UPDATE` ✅(물리 UNIQUE 0 실측) · ENDED 참여 400 / 이탈 허용의 비대칭 ✅(§4-8 과 짝이라 논리적) · 참여가 `version_no` 안 올림 ✅.
8. If-Match ↔ W/O `version_no` ✅ — I-7 실측(`production-result.service.ts:88-90` `assertVersion(locked, context.version)` 이 **상태 게이트보다 먼저**). §3-1 의 1→2→3 순서가 그 선례와 일치한다. `runVersioned` 배제 ✅(`master-write.ts:48`).
9. `X-Worker-No`(§3-7) ✅ — `WorkerNo.required=true` + ⌜없으면 서버가 거부한다⌝ 실측 · 네 오퍼레이션의 소유 화면이 전부 POP(`derived-permissions.ts:243-245` `P-02-01/02/03/10`)이라 관리웹 호출자가 0 ⇒ 규칙 9 예외 4→8 타당. `:pick`(담을 칸 0)이 이미 같은 모양이라 「존재 확인 후 버림」도 선례 안이다. ⚠ 판정 1 과 헷갈리지 않게 §3-7 에 「`X-Worker-No` 는 계약이 required 로 «선언한» 헤더이고 `Authorization` 은 아니다 — 그래서 처리가 다르다」를 한 줄 넣는다.
10. 조회 5(§8) ✅ — `open` 은 `ended_at` 축 · 여집합 · 배열 응답 · 정렬 근거(물리 인덱스 `(…, decided_at DESC)` 실측) 전부 실측과 일치.
11. 문의 ✏ — **050+1 을 I-10 054 에 병합 ✅**(같은 물음). 단 병합본에 **「`POST /work-sessions` 만 계약이 단말 게이팅을 «서버 강제»로 적었다 — 그래서 두 오퍼레이션의 부재 처리가 갈린다」**를 반드시 싣는다. 나머지 **신규 3건**(역할 기본값 · 사번/화면 · `:end` 작업자 → 056~058 잠정) ✅ · 알려둘 것 12 ✅ + **2건 추가**: ⓝ `:end`·events·`/workers`·`:leave` 는 **오프라인 대상**(계약 실측)이라 큐 재전송 시점에 계정 세션 쿠키가 만료돼 있을 수 있다(`P-CO-01` §5-5 ⌜단말 토큰은 장기라 오프라인 구간을 넘어 산다⌝) — 오늘 `AuthenticationGuard` 가 계정 세션을 요구하는 한 이 경로는 언젠가 401 이 난다 ⓞ 세션 열기만 ⛔오프라인 대상이 아니다(비대칭).
12. e2e·PR·모델 ✅ — e2e 54 는 과하지 않다(형제 실측: `production-work-order` 47 / `production-production-result` 40 · 11 오퍼레이션 기준 5/건). PR 5 · ② 코어 ~110(≤200) · ③ opus · ①④⑤ sonnet ✅ — ④ 는 전이표를 «타는» 서비스라 복제 성격이 맞다(단, ④ 브리프에 A-25 대응표를 표로 박아 준다). ③ 스폰 전 054 답 맞춤 ✅.
13. 자기 관점 대조 ✏ — **§13 #4 가 틀렸다**: `plan-api.md` S15 표는 `:leave` If-Match 를 **이미 「—」**로 적었고 **사번 열 자체가 없다**(실측 402~409행). ⇒ 「고칠 자리」 목록에서 **「`POST …/workers`·`:leave` 의 If-Match·사번 칸 정정」을 삭제**한다(맞는 문서를 틀리게 고친다). 나머지 S15 정정 3건(마이그 0→1 · PR 2→5 · 미정 자리 없음→3건)은 ✅.

## I-11.md 에 반영할 수정 — **9건**
1. §2-2 ⓑ 전면 개정 — 「귀속 축」→「**인증 축의 값을 오늘은 읽기만 한다**」 · 부재 시 **400 `REQUIRED` → 403 `PERMISSION_DENIED`(F-6)** · 0단계 선례에 `production-result.service.ts:142` 인용 · 「업무를 없애는 거부 미해당」 실측 셋(`can_start_work` DEFAULT false · `P-02-01` §5-1 · `P-CO-01` §8).
2. §2-3 SQL **무변경**(`shift_id` 만) + 「⛔ `terminal_id` 는 완화하지 않는다 — 게이트가 NULL 경로를 0으로 만든다 · 자식 `work_session_event.terminal_id` 는 이미 nullable」 주석 3줄.
3. §3-1 tx — ①에서 `Authorization` 부재를 **에러로 만들지 않는다**(파싱만) · ②는 「토큰이 온 경우만 검증」 · **5번 게이팅에 `terminalId === null → 403`** · 8번 INSERT 의 `terminal_id` 는 5번이 보장.
4. §3-2 — `routing_operation_id` NOT NULL 실측 한 줄 + F-6 분기.
5. §3-3 — `@db.Time` 을 `toISOString().slice(11,19)` 로 읽는다(`reference.service.ts:193`) + 단위 테스트 1건 추가 · 대체 축 도입 ⛔ 명시.
6. §5-1 — hold→resume 경로를 `from` 확장의 둘째 근거로 추가.
7. §14 PR ② — `document-state.spec.ts:188` 칸 집합 단언 갱신을 산출물에 명시.
8. §3-6 — 「점검 이력」 문장 인용 + 반박 한 줄.
9. §13/§11-2 — #4 정정 삭제 · 050+1 은 054 병합(신규 3건) · 알려둘 것 ⓝⓞ 추가. e2e 이름 2건 교체(`단말 토큰이 없으면 400 REQUIRED` → `단말 토큰이 없으면 403 — 게이팅을 판정할 수 없다`), 단위 `terminal-token.spec` 의 `헤더가 없으면 400 REQUIRED` → `헤더가 없으면 null 을 낸다(던지지 않는다)`.

## 5줄 요약
1. **I-11.md 수정 9건** — ①§2-2 ⓑ 개정(400→403·인증 축 표기) ②§2-3 SQL 유지+`terminal_id` 완화 반대 주석 ③§3-1 헤더 부재 비에러화+게이팅 403 ④§3-2 `routing_operation_id` NOT NULL ⑤§3-3 `@db.Time` UTC 읽기 ⑥§5-1 hold→resume 근거 ⑦PR② `document-state.spec:188` ⑧§3-6 「점검 이력」 반박 ⑨§13 #4 삭제·e2e/단위 이름 2건 교체.
2. **plan.md 반영** — §4 에 I-11 행 신설(`work_session.shift_id` **1건만**) · §1 46행 마이그 「—」→1 · PR 3→5 · 모델 sonnet→sonnet×3+opus×2 · §5 규칙 9 예외 4→8. `plan-api.md` S15 는 마이그 0→1 · PR 2→5 · 미정 3건만 고치고 **If-Match·사번 칸은 손대지 않는다**.
3. **문의 최종 3건**(056~058 잠정) — 역할 기본값 `OPERATOR` · 사번/참여 화면 부재 · `:end` 의 참여 작업자. 단말 토큰은 **I-10 054 에 병합**하되 「세션 열기만 계약이 단말 게이팅을 서버 강제로 적었다」를 병합본에 싣는다.
4. **PR 분할·모델 최종** — 5개 ①330 sonnet → ②110 opus(코어·마이그) → ③310 opus(심장+단말 토큰) → ④279 sonnet, ⑤125 sonnet 은 ① 뒤 병렬. ③ 스폰 전 054 답을 맞춘다.
5. **단말 토큰 한 줄 판정(I-10 과 맞출 답)** — 헬퍼 `resolveTerminalId()` 는 **헤더가 없으면 던지지 않고 `null`**(I-10 C안과 같은 축·같은 서명), 온 경우만 서명·`typ`·존재·`is_active`·`token_version` 검증 후 400 `INVALID`. **다만 `POST /work-sessions` 는 계약이 「`can_start_work` 를 서버가 강제한다」고 적은 유일한 자리라 `null` 이면 판정 불가 → 403 `PERMISSION_DENIED`(F-6)** — 그래서 `work_session.terminal_id` 완화 마이그는 **필요 없고 넣지 않는다**(마이그는 `shift_id` 1건 그대로).
