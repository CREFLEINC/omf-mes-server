# I-28 ③ 수신자 preview 독립 코드 리뷰

**대상**: `feat/coverage-100-b-i28-c`, source `c629bf6f221409ac8286c5f1ea0381827bfdcc05`, base `3e44f1cfed2d0bff5fe4d2c2b4e688f3f5f591ef`. PR 번호는 통합자 생성 후 연결한다.
**요약**: `POST /app/notification-subscriptions/recipients:preview` 1건. ROLE/USER 규칙을 사용자 목록으로 전개하고 전달된 멱등 트랜잭션에 전체 응답을 보존한다. 구현자와 다른 새 컨텍스트에서 검토했다.

## 심각도 요약

| Blocker | Major | Minor | Nit |
|:---:|:---:|:---:|:---:|
| 0 | 1 | 0 | 0 |

## 1. 버그 / 정확성

- **[Major M1] `src/app/notification/notification-preview.service.ts:38` — bigint 식별자를 검사 없이 number로 바꿔 서로 다른 사용자를 같은 ID로 반환한다.** SQL의 PK 중복 제거가 정확해도 `9007199254740992n`과 `9007199254740993n` 두 행은 모두 `userId: 9007199254740992`로 반환된다. 실제 `NotificationPreviewService.previewWithin`에 안전한 ROLE 입력(BU1/role1), 해당 두 PK의 SQL 결과를 전달한 읽기 전용 재현에서 `users.length=2`, `totalCount=2`, `new Set(users.map(u => u.userId)).size=1`을 확인했다. 두 PK 모두 PostgreSQL bigint와 계약 int64 범위 안이다. 사용자가 받는 식별자와 DB 사용자의 대응이 깨지며, 직접 USER 규칙으로 되돌리면 잘못된 사람을 가리킬 수 있다.
- 같은 **M1의 입력 경계**는 `notification-preview.service.ts:93,97,101`이다. 실제 ContractValidator에 raw JSON `userId:9223372036854775807`을 통과시키면 오류 `[]`, 파싱된 Number는 `9223372036854776000`, `BigInt` 변환은 `9223372036854775808n`이다. 실제 lane-B Prisma `app_user.findMany` 읽기 전용 호출에서 `PrismaClientUnknownRequestError`를 확인했다. 기존 `prisma-error.ts`는 이 오류를 매핑하지 않으므로 `error.filter.ts:80`의 500 경로다. 안전 범위 밖 인접 ID는 입력 파싱 때 서로 같아질 수 있어, 잘못된 참조 선택·중복 규칙 판정·멱등 지문 충돌도 가능하다.
- **수정 제안**: 이 preview의 ID 입력 세 칸을 DB 조회 전에 이름 붙인 안전 정수 경계로 검증하고 정확한 `recipients[i].field`의 기존 INVALID/RANGE로 거부한다. DB에서 읽은 PK도 number 변환 전에 검증하여 손실된 성공 응답을 만들지 않는다. 출력 경계에서 어떤 명시적 오류를 낼지는 통합자가 아래 R 판정으로 먼저 고정해야 한다. 공용 JSON 파서·다른 API·계약·스키마를 이 PR에서 확장하지 않는다. 경계 단위 테스트와 HTTP 입력 거부·멱등 rollback/retry 단언을 추가한다.
- **계획 구멍**: I-28 §5·R-5는 PK 중복 제거를 요구하지만 bigint→JSON number의 표현 범위는 보지 않았다. README.md:61–62의 `/mdm` 숫자 반환은 0단계의 직렬화 형식 선례이며, 정확하지 않은 ID까지 성공 반환해도 된다는 승인은 아니다. 루틴 README §6에 따라 **코드 수정 전에 §0-재수립 R 행**을 추가해야 한다. 본길 전체의 계약 형식을 바꾸지 않고 특정 입력/DB PK 가장자리에서 조용한 값 도출을 막는 경계로 한정한다. 입력 거부는 §2의 2단계 2번, 출력 정책은 계약 원문·기존 오류 선례를 검토해 통합자가 결정하고 테스트/문의에 흔적을 남긴다.
- **후속 배정 상태(통합자 통지)**: 최초 리뷰 뒤 root가 docs `754c233`의 I-28 R-11/§12-5에 먼저 판정했다. 모양 검증 후 세 ID 입력의 unsafe integer는400 RANGE, 전개된 DB PK unsafe는전체500 및 멱등 rollback, ±MAX_SAFE_INTEGER 경계·0/음수 기존 FK 처리 유지다. 입력 JSON 파서의 원문 손실을 완전히 해결했다고 주장하지 않는다. 번호 대역 소진은 대기초안과 정본 참조로 추적한다. 수정은 구현자에게 배정됐으며 **이 보고서는 frozen c629의 Major1 판정을 유지**한다. 후속 소스와 게이트는 아직 재검토하지 않았다.

그 밖의 정확성 판정:

- ROLE은 `app_user.department_id → department.business_unit_id`와 `user_role.role_id`의 두 조건을 모두 사용한다. worker/user_data_scope를 대신 읽지 않는다. USER는 부서/사업부가 없어도 직접 포함한다.
- `LEFT JOIN`과 `EXISTS`를 포함한 parameterized `$queryRaw` 한 문장으로 포함 여부·이름·활성·부서명을 함께 읽는다. app_user PK 기준 행은 SQL 단계에서 한 번만 나오며 PK ASC 정렬이다.
- 비활성 사용자를 `users`에 포함하고 `countActiveRecipients`만 활성 인원을 센다. 비활성 역할·사업부·부서로 합성 상태를 만들지 않으며 R-5·문의101과 일치한다. 부서명 null이면 키를 생략한다.
- 컨트롤러는 기존 `notificationWriteContext`와 `IdempotencyService.run(context, tx => ...)`를 실제로 연결한다. 업무 조회와 완료 응답 저장은 전달 tx 안이며 actor/method/path/body 격리, 전체 응답·resolvedAt 재생, 200 상태를 지킨다. If-Match/query/eventCode를 새 지문 축으로 만들지 않는다.
- 업무표 쓰기·마이그·Zalo·이벤트 카탈로그 추가 0. 보류된 구독3 operation을 등록하지 않는다. 일반 비테스트 diff 322추가/0삭제로 350 예산/400 상한 이내다.

## 2. 보안

M1 입력 검증 경계 외 특이사항 없음. SQL 식별자/구조는 코드 상수이고 입력 ID는 Prisma SQL 매개변수로 전달한다. W-CO-11 기존 derived permission, 세션 필수, terminal-only/비활성401, 다른 actor 같은 key409를 확인했다. 새 권한·인증·error code·의존성 변경 및 시크릿 추가는 없다. 실패 주입 문구는 서버 로그에만 있고 HTTP500 응답에는 노출되지 않는다.

## 3. 테스트

- 전체 source/test diff 8파일·1097추가를 직접 읽었다. 계약 operation 전체와 request/response의 모든 연결 `$ref`를 읽고 고정 SHA `a6a87e144116ebaa32c01df5a12a0fd2924427e7`을 확인했다. 계약/Prisma/common/auth diff는 0이다.
- 기존 테스트는 ROLE 경유·USER 직접·활성/비활성·부서/사업부 없음·규칙 모양/중복/FK/null·권한/세션·응답 schema·멱등 저장/재생/실패 rollback을 검증한다. M1의 unsafe ID 입력 및 SQL PK 변환 경계 테스트는 없다. M1 수정에 함께 보완한다.
- 구현자 lint/tsc는 기록을 확인했으며 재실행하지 않았다. 리뷰어 전체 단위와 바뀐 E2E만 아래대로 실행했다. 다른 회귀 E2E는 통합자 몫이다.

| 실제 실행 명령 | 종료 | 실제 결과·시간 |
|---|---:|---|
| `/usr/bin/time -p node_modules/.bin/jest --runInBand --no-colors` | 0 | 103 suites / 999 tests passed, Jest 5.587s, real 5.83s. 계약356/487 |
| `TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules /usr/bin/time -p node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/app-notification-preview.e2e-spec.ts` | 1 → 0 | 최초 sandbox globalSetup에서 localhost55432 연결 차단(real0.24s, 테스트실행0). 동일 명령 좁은 승격 후 **1 suite / 25 tests passed**, Jest1.486s, real1.86s |
| `git diff --check 3e44f1c c629bf6` | 0 | 출력0 |

추가 진단은 테스트 파일을 만들거나 변경하지 않고 `NODE_PATH=… node -e`에서 `@swc/core`로 실제 TS 모듈을 메모리에 적재했다. `ContractRegistry.load()`와 `ContractValidator.validate()`의 실제 입력 검증 및 실제 preview 서비스에 mock SQL 결과 두 행을 전달한 M1 재현은 exit0이다. 별도 `node -r dotenv/config -e`에서 Prisma의 다음 읽기 조회만 수행했고 DB 행을 변경하지 않았다:

```js
prisma.app_user.findMany({
  where: { app_user_id: { in: [BigInt(JSON.parse('9223372036854775807'))] } },
  select: { app_user_id: true },
});
// PrismaClientUnknownRequestError; finally에서 $disconnect(), 진단 명령 exit0.
```

DB 전후는 `docker exec omf-mes-lane-b-postgres psql -U omf_lane_b -d omf_mes_lane_b -X -P pager=off -c <SELECT count UNION ALL>`로 직접 대조했다. 전후 동일: 적용 완료 migration56, 법인1·사업부2·공장1·app_user1·role4, notification/event/subscription/idempotency/department/worker 각0, `E2E_I28_PREVIEW_%` user/role/department 각0. E2E afterAll은 소유 ID의 idempotency/worker/user/role/department/BU/plant/LE 잔존8항목 모두0을 단언했다. 초기 조직이 충분해 globalSetup의 조직 생성 분기는 실행되지 않는다. seed/reset/TRUNCATE/전체E2E/`-t` 실행0, dotenv 비밀출력0.

## 4. 컨벤션 / 가독성

특이사항 없음. CREFLE pr-review SKILL, checklist/severity/template 전체와 coding-rules SKILL·TypeScript·commit-convention을 실제 읽고 대조했다. 명시적 입력/응답 타입, camelCase/PascalCase, async 오류 전파, DB/계약 경계의 작은 역할, 소유 모듈 등록4줄만 추가한 범위가 적절하다. branch `feat/coverage-100-b-i28-c`와 `[B] feat(notification): 수신자 미리보기 구현`은 저장소의 레인 우선 규칙을 따른다. 숫자 직렬화의 기존 선례는 확인했으나 M1의 정확성을 면제하지 않는다.

## 머지 판정·소유 반환

- 승인 기준(Blocker+Major0): **미충족 — M1 수정·재리뷰 필요**.
- CI green이라고 판정하지 않는다. GitHub Actions disabled 여부·PR base/충돌·병합은 통합자가 최종 확인한다. 이 리뷰의 통과 근거는 위 로컬 게이트이며, 게이트 통과가 M1을 해소하지 않는다.
- 리뷰 파일 외 source/test/정본 docs/git/gh mutation 0. root의 unstaged closure docs4는 보존했다. 계약 update/check 실행0.
- 지정 unit/E2E와 진단 Prisma 프로세스 모두 종료. 종료 후 `pgrep -fl 'jest|notification-preview'` 출력0/exit1(매칭0)을 확인했다. DB/E2E 독점 lease는 통합자에게 반환했다.

**결론: 수정 후 재리뷰 필요.** pr-review의 근거·4영역·심각도 기준을 적용해 수신자 ID 경계를 Major로 분류했으며, coding-rules의 명시적 실패 처리 원칙으로 수정 방향을 제시했다. 외부 코멘트나 병합은 실행하지 않았다.

## R-11 후속 독립 리뷰 — source fb952053

**최신 코드 판정: M1 해소, Blocker0 / Major0 / Minor0.** 아래 결과가 위 최초 c629 리뷰의 코드 승인 판정을 대체한다. 대상은 실제 **#313 `[B] feat(notification): 수신자 미리보기 1건 (I-28 ③)`**, `feat/coverage-100-b-i28-c`→main, 고정 소스 **fb952053c1b21f45bf446803334a587b9e134641** / base3e44f1c다. R-11 문서754c233과 리뷰 여유380 문서3225683이 코드 수정에 선행했음을 git diff로 확인했다.

### 4영역 재판정

1. **정확성 — M1 해소.** c629→fb952의 소스/테스트 수정5파일을 전부 읽었다. `recipientIdRangeErrors`는 모양 검사 다음, 중복 및 DB 참조 조회 이전에 세 입력축의 `Number.isSafeInteger`를 검사한다. unsafe 양수/음수는 정확한 field의400 RANGE다. 안전한 ±MAX_SAFE_INTEGER·0·음수는 기존 FK 판정으로 간다. `contractUserId`는 SQL PK를 숫자로 바꿀 때 안전성을 검사하고 실패하면 전체 요청이 Error→500이 되어 멱등 tx가 rollback된다. unsafe 사용자를 반올림하거나 일부만 생략한 성공 응답을 만들지 않는다. 사용자 전개 SQL·활성 집계·기존 멱등 경계는 유지됐다. Number로 먼저 변환하더라도 bigint가 안전 범위를 넘으면 변환 결과가 안전 정수 범위 안으로 들어올 수 없어 이 검사로 silent alias를 막는다.
2. **보안 — 신규 지적 없음.** ID 입력을 SQL 호출 전 차단하며 공용 파서·인증·권한·오류코드·계약은 변경하지 않는다. 기존 parameterized SELECT와 actor 격리는 유지된다. 전체 int64 지원 또는 JSON 파싱 전 원문의 무손실 검증을 보증하지 않으며 그 미완은 R-11과 번호 배정 대기 문의 초안으로 명시돼 있다.
3. **테스트 — 변경 경계 통과.** 추가 단위14개가 세축 ±unsafe의 정확한 RANGE, 안전한 경계·0·음수, 숫자로 같은 값이 된 두 ROLE 입력을 각각 RANGE로 거부, 참조조회0, DB PK 변환 실패를 확인한다. 추가 실제 HTTP2개는 세축 unsafe와 원문 int64최대400, 실제 DB unsafe PK 두 행을 안전한 ROLE 규칙으로 읽을 때 전체500·실패키 멱등0·별도 안전 성공키 COMPLETED1을 확인한다. 기존 완료저장 실패 후 같은 키 재시도/재생 검증도 계속 통과한다. 새 unsafe-PK500 테스트 자체는 같은 키 복구 재시도를 별도 단언하지 않고, 실패키 행 부재와 기존 callback 실패 재시도 테스트로 함께 검증한다.
4. **컨벤션 — source 신규 지적 없음.** 명명된 로컬 경계 함수·명시적 예외·정본 R-11 단언 주석으로 CREFLE 규칙을 지킨다. 비테스트 **360추가/0삭제**(controller31/service167/rules142/view16/공용등록4), 승인된380 리뷰 여유·400 상한 이내다. GitHub 댓글/리뷰/수정/병합은 실행하지 않았다.

### 후속 게이트 실측

| 실제 명령 | 종료 | 결과 |
|---|---:|---|
| `/usr/bin/time -p node_modules/.bin/jest --runInBand --no-colors` | 0 | **103 suites / 1013 tests passed**, Jest5.827s, real6.21s, 계약356/487 |
| `TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules /usr/bin/time -p node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/app-notification-preview.e2e-spec.ts` | 0 | **1 suite / 27 tests passed**, Jest1.548s, real1.95s. 직전 localhost sandbox 차단 근거로 동일 한 파일만 승격; 후속 실행 실패0 |
| `git diff --check 3e44f1c fb952053 -- src prisma test` | 0 | 출력0 |

구현자 R-11 최종 기록을 전부 읽었고 lint3.09s/tsc5.36s는 중복 실행하지 않았다. 후속 게이트는 변경된 source에 대해 단위전체와 같은 E2E전체를 각각1회 실행했다. 수행 시 `git diff --name-only fb952053 -- src prisma test` 출력0으로 고정 소스와 실행 파일의 동일성을 확인했다. root의 I-27 문서10개는 검토/수정 대상에 넣지 않았다.

DB 전후 SELECT16개가 전부 동일했다. 초기 조직 LE1/BU2/plant1, 완료 migration56, app_user1/role4, notification/event/subscription/idempotency/department/worker0, preview prefix user/role/department0, unsafe PK9007199254740992/9007199254740993 잔존0. E2E 소유 fixture 잔존8항목0 단언도 통과했다. `pgrep -fl 'jest|notification-preview'`는 출력0/exit1이며 모든 프로세스 종료·DB/E2E lease root 반환을 알렸다. 추가 DB 실행0, seed/reset0, 비밀출력0.

### 최종 인계

소스 승인 기준은 충족한다. 입력/출력 안전정수 경계 밖의 제한은 R-11의 승인된 가장자리 정책이며, 문의 번호 승인 후 정식 문서/단언 참조를 갱신하는 미완은 남아 있다. 실제 원격 PR을 읽은 시점의 head는754c233·본문은초기게이트였으므로 root가 최종 fb952 소스의 push·본문 갱신·최신 원격 동기화·영향 회귀·workflow/충돌 상태를 확인한 뒤 병합해야 한다. CI green은 주장하지 않는다.

frozen fb952의 비소스 문서 `docs/coverage-100/slices/I-28-preview-implementation.md:51`에는 **Nit1: EOF 추가 빈 줄**이 있어 전체 diff-check가 이를 보고했다. source/prisma/test diff-check는 통과했으며 통합자에게 문서 포맷 정리를 전달했다. 이 Nit는 M1 해소나 코드 승인 기준을 막지 않는다.

## 통합자 최종 동기화·회귀

- 후속 독립 리뷰의 문서 EOF Nit1은 root가 정리했고 최종 diff-check exit0이다. 소스 지적은0/0/0/0이다.
- root 영향 회귀: app-user22(exit0/Jest2.433s/real2.79s), app-approval-request9(exit0/1.514s/1.88s), app-role18(exit0/2.237s/2.59s). 모두 같은 AppModule 부팅, 파일별 순차 종료다.
- 병합 전 fetch에서 A #304의 main7153260을 확인해 bdf6bcd로 정상 merge했다. 새 마이그0, I-28 source/공용 AppDomain 등록 변경0·다른 등록 삭제0이다. A 소유 번호IRS/품질등록만 합쳐졌다.
- 동기화 뒤 root ESLint 전체 exit0(도구2.759s), tsc all exit0(4.655s), unit103 suites/1019 tests exit0(Jest5.914s), 변경 품질 E2E39 exit0(Jest1.957s/real2.36s), preview27 exit0(Jest1.448s/real1.82s). 후보357/487이며 공식 main 측정은 병합 뒤 별도로 한다.
- drift No difference detected/exit0(도구0.640s), DB56. workflow3 모두 disabled_manually를 실제 조회했으며 CI green으로 보고하지 않는다. 최종 own PR/head/base/충돌 확인 뒤 merge-commit 판정은 root 소유다.
