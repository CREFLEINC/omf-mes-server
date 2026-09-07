# I-28 ③ 수신자 preview 구현 기록

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

