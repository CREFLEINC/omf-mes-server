# I-28 ③ 수신자 preview 구현 기록

최종 수정 소스 fb952053c1b21f45bf446803334a587b9e134641. 비테스트360 추가/0 삭제, root 리뷰 여유380/하드400 이내다. 아래 초기322/999/25 기록은 이전 소스 이력이고 마지막 R-11 변경 뒤103/1013/27이 최종 구현자 검증이다.

## 결과

- 구현 operation: `POST /app/notification-subscriptions/recipients:preview` 1건
- 구현 브랜치 후보 커버리지: **356/487** (`+1`), 공식 main355/487과 구분
- 비테스트 `src`/`prisma` diff: **322 추가 / 0 삭제**
  - 신규 source 318줄: controller 31, service 158, rules 113, view 16
  - `app-domain.module.ts` 자기 등록 4줄
- 계약/Prisma schema/core/auth/manual permission/error code 변경: **0**
- 마이그레이션/업무표 쓰기: **0**. 성공 때 `app.idempotency_record`만 기록
- CREFLE coding-rules의 TypeScript 명시 타입, 명확한 이름, 오류 전파, ESLint/Prettier 우선 규칙을 적용했다.

## 구현 경계

- ROLE은 `app_user.department_id → department.business_unit_id`와 `user_role.role_id`가 함께 맞을 때만 전개한다.
- USER는 계정을 직접 지정한다. `worker`와 `user_data_scope`는 소속으로 대체하지 않는다.
- 사용자 포함 여부, `user_name`, `is_active`, `department_name`은 parameterized raw SQL 한 문장의 `LEFT JOIN` + `EXISTS`에서 읽는다. 서비스 단위 검사가 `$queryRaw` 1회와 SQL의 JOIN/EXISTS/PK 정렬을 단언한다.
- 비활성 계정도 `users`에 표시하고 `countActiveRecipients`가 활성 계정만 `totalCount`로 센다(설계 문의 101).
- ROLE/USER 짝, 중복 규칙, 사업부/역할/사용자 FK를 정확한 `field`와 기존 `PAIR`/`UNIQUE_VIOLATION`/`INVALID`로 검증한다.
- 응답은 사용자 PK 오름차순이고 부서가 없으면 `departmentName`을 생략한다.
- 기존 `notificationWriteContext`와 `IdempotencyService.run(context, tx => ...)`를 그대로 사용해 actor+method+path+raw body 지문, 전달 tx, 응답 전체와 `resolvedAt` 재생을 보존한다.
- bigint→JSON number 변환은 저장소의 기존 `Number(bigint)` 계약 선례를 따른다. 루트 `README.md:61-62`가 「직렬화 방식을 정해야 한다」고 남기면서 `/mdm`은 계약 `type: integer`에 맞춰 숫자로 낸다고 명시한다. 이 전역 경계가 열린 상태라 이 조각만의 신규 rejection/500 정책은 만들지 않았다.

## 최종 게이트

| 명령 | 결과 | 실측 |
|---|---|---|
| `node_modules/.bin/eslint "{src,test}/**/*.ts"` | exit 0 | real 3.08s |
| `node_modules/.bin/tsc --noEmit -p tsconfig.all.json` | exit 0 | real 5.20s |
| `node_modules/.bin/jest --runInBand` | exit 0 | **103 suites / 999 tests passed**, 6.266s(Jest), real 6.54s |
| `FORCE_COLOR=0 node_modules/.bin/jest --config test/jest-e2e.json --no-colors --runInBand test/app-notification-preview.e2e-spec.ts` | exit 0 | **1 suite / 25 tests passed**, 1.417s(Jest) |
| `git diff --check` | exit 0 | 출력 0 |

단위 전체에서 `계약 구현 커버리지: 356/487`과 계약 커버리지 4 tests 통과를 확인했다. E2E는 응답/400/403 계약 schema, 200/403/401, ROLE/USER/FK/중복/null, 비활성·0명·빈 배열, 실제 이름/부서, PK dedup/정렬, 업무표 불변, 같은 키 고정/새 키 재전개, actor/body 충돌, 완료기록 실패 rollback/retry를 검증했다. `afterAll`의 소유 fixture 잔존 단언은 전 항목 0이었다.

## 작업 중 실패와 수정

1. 첫 targeted ESLint: exit 1. 콜론 escape 1건과 non-null assertion 6건을 고쳐 재실행 exit 0. 뒤의 tsc는 `&&` 때문에 이 회차에는 실행되지 않았다.
2. 첫 E2E 파일 포함 tsc: exit 2. `it.each`가 `beforeAll` 할당 전 fixture 값을 평가하던 8건과 Supertest `.send(unknown)` 1건을 내부 case loop/`object` 타입으로 고쳐 재실행 exit 0.
3. 첫 DB E2E: sandbox에서 `127.0.0.1:55432` 연결이 막혀 global setup 전에 exit 1(0.4s). 승인된 동일 명령은 24/24 exit 0(1.892s). required-body 단언을 더한 최종 동일 파일 재실행은 25/25 exit 0(1.417s).
4. 초기 Prisma relation select가 한 SQL 스냅샷을 보증하지 않는다는 조기 리뷰를 반영해 parameterized raw SQL 단문으로 교체했다. 교체 후 lint/tsc/단위/E2E 전체를 다시 통과했다.

원인 불명 실패 0, 데이터/fixture 잔존 0, seed/reset/TRUNCATE/전체 E2E/`-t` 실행 0이다.

## 소유·프로세스 상태

- 소유 source/test 파일은 구현 완료 상태이며 git stage/commit/branch/gh 쓰기는 하지 않았다.
- DB/E2E 프로세스는 종료했다.
- 전용 lane-B DB/E2E lease는 최종 exact E2E 뒤 root에게 반환했다.

## R-11 ID 정밀도 수정 — 최종 기록

- root가 코드 수정 전에 확정한 `I-28.md` R-11과 §12-5를 적용했다.
- 형태 검증을 통과한 `businessUnitId`·`roleId`·`userId` 각각에 `Number.isSafeInteger`를 적용한다. unsafe 양수/음수는 정확한 필드의 400 `RANGE`; 안전한 ±MAX_SAFE_INTEGER·0·음수는 기존 FK 판정으로 계속 간다.
- SQL 결과의 `app_user_id bigint`도 숫자 변환 직전에 안전성을 확인한다. 9007199254740992n과 9007199254740993n처럼 서로 다른 저장 ID가 같은 JSON 숫자로 합쳐질 수 있으면 `Error`로 전체 요청을 500 처리하며 멱등 행은 함께 rollback한다.
- 프레임워크 JSON 파싱 전에 원문 숫자가 이미 잃은 소수·표기까지 무손실 검증한다고 주장하지 않는다. 공용 parser/helper/계약/error code는 바꾸지 않았다.
- 단언 주석은 지시된 `설계 미정 — 문의 번호 배정 대기(I-28 R-11)`를 썼다. 임의 문의 번호나 기존 번호를 재사용하지 않았고, 번호 승인 뒤 갱신은 미완 추적 상태다.

### R-11 변경 뒤 전체 게이트

| 명령 | 결과 | 실측 |
|---|---|---|
| `node_modules/.bin/eslint "{src,test}/**/*.ts"` | exit 0 | real 3.09s |
| `node_modules/.bin/tsc --noEmit -p tsconfig.all.json` | exit 0 | real 5.36s |
| `node_modules/.bin/jest --runInBand` | exit 0 | **103 suites / 1013 tests passed**, 6.408s(Jest), real 6.68s |
| `FORCE_COLOR=0 node_modules/.bin/jest --config test/jest-e2e.json --no-colors --runInBand test/app-notification-preview.e2e-spec.ts` | exit 0 | **1 suite / 27 tests passed**, 1.619s(Jest) |
| `git diff --check 754c233 -- src/app/notification src/app/app-domain.module.ts test/app-notification-preview.e2e-spec.ts` | exit 0 | 출력 0 |

R-11 작업 중 실패는 0이다. 실제 HTTP는 세 입력축의 unsafe 숫자와 원문 int64 최대값을 400 `RANGE`로 확인했다. 전용 DB에는 시험 범위에서만 unsafe PK 두 개를 `OVERRIDING SYSTEM VALUE`로 만들고 안전한 ROLE 입력으로 전체 500/멱등0을 확인했으며, 안전한 요청은 COMPLETED1을 확인했다. `afterAll` 소유 fixture 잔존은 전 항목 0이다. seed/reset/TRUNCATE/전체 E2E/`-t` 실행은 0이다.

R-11 source와 test 수정 소유권 및 DB/E2E lease를 root에게 반환했고 실행 중인 프로세스는 없다.

