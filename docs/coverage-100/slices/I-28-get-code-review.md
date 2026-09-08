# I-28 PR① 독립 코드 리뷰 — 최종 재검토

대상: `feat/coverage-100-b-i28-a`의 알림 GET 2건. 구현자와 다른 컨텍스트에서 최초 리뷰와 두 차례 수정 재검토를 수행했다.
현재 기준: **HEAD = origin/main = `8906fb0e7af29c6062bd44da59b8a8b293179c51` 위 미커밋 알림 변경**. 로컬 `main` ref는 아직 `ab90060`이며 최신 기준과 혼동하지 않는다. PR 미생성.
범위: `src/app/notification/{notification.controller.ts,notification-query.service.ts,notification-view.ts,notification-view.spec.ts,notification-time-boundary.ts,notification-time-boundary.spec.ts}`, `src/app/app-domain.module.ts` 자기 4줄, `test/app-notification.e2e-spec.ts`.
비테스트 실측: **201 추가/0 삭제** = controller34 + query57 + view52 + boundary54 + 공용등록4. GET 일반 PR 상한400/브리프350 이내다.
기준: 고정 계약 `a6a87e144116ebaa32c01df5a12a0fd2924427e7`, I-28 R-1~R-10·§1-2·§4-1·§8-1/8-4·PR①, CLAUDE 및 coverage README/lanes/lane-B.
적용 스킬: CREFLE pr-review 전체·checklist/severity/template와 coding-rules·TypeScript·commit-convention을 직접 읽고 정확성→보안→테스트→컨벤션 순서로 검토했다.

## 심각도 요약

| Blocker | Major | Minor | Nit | 해소한 Major |
|:---:|:---:|:---:|:---:|:---:|
| 0 | 0 | 0 | 0 | 2 |

## 1. 버그 / 정확성

잔존 지적 없음. 아래 두 Major는 수정 후 직접 게이트와 실제 HTTP 결과로 해소 확인했다.

### 해소① — 밀리초 절삭으로 반열림 경계가 바뀌던 문제

- 최초 query의 `new Date()`는 유효한 `.000001Z` 입력을 `.000Z`로 잘랐다. `.000Z`인 행이 from=.000001일 때 잘못 포함되고 to=.000001일 때 잘못 제외됐다. 계약 `app-공통.json:1790`·`:1801`과 물리 `schema.prisma:3853`의 Timestamptz(6)가 근거다.
- `notification-time-boundary.ts:9`~`:17`은 6자리 이하 보존, 7번째 이후 비영 꼬리만 1µs 올림, 0 꼬리 무올림을 구현한다. `notification-query.service.ts:33`·`:34`는 양 경계의 결과를 Date로 재변환하지 않고 Prisma 문자열로 전달한다.
- 저장 시각 x가 1µs 격자이면 `x >= q ⇔ x >= ceilµs(q)`, `x < q ⇔ x < ceilµs(q)`다. 따라서 양 경계에 같은 올림을 쓰는 현재 구현이 맞다. 과거 검토에서 확인한 Prisma 10자리 절삭과 PostgreSQL 직접 cast의 최근접 반올림에 의존하지 않는다.
- `notification-time-boundary.ts:21`~`:53`의 초→분→시→일→월→년 캐리와 Gregorian 4/100/400 윤년 규칙을 직접 대조했다. `notification-time-boundary.spec.ts:35`는 2028 윤일, 2100 평년, 2000 윤년 및 양/음 offset 조합을 검증한다.
- `test/app-notification.e2e-spec.ts:446`~`:508`은 실제 µs 저장 행을 두고 정확한6자리·7/9/10자리·0 꼬리·익년 캐리·동등 UTC/+07/음수 offset을 양 경계의 ID와 total로 검증한다. `:548`·`:563`은 동일 격자/역전·페이지 total·저장 원문 불변도 단언한다. 최초27개 pass만으로 해소 판정한 것이 아니다.

### 해소② — Prisma 문자열 전달 뒤 기존 허용 날짜 형식이 실패하던 문제

- 1차 수정에서 `2026-09-06T12:00:00+0700`와 tab/newline 구분자는 고정 Ajv와 기존 Date가 받지만 Prisma COUNT가 거부했다. 이는 최초 정밀도 문제와 별도로 발견한 회귀였다.
- 현재 `notification-time-boundary.ts:4`~`:8`은 소문자 t/단일 공백류를 T, z를 Z, ±HHMM/±HH를 ±HH:MM으로 정규화한다. **정규화가 소수초 검사보다 먼저** 수행되어 소수 없는 입력도 복구된다. offset의 의미와 숫자 정밀도는 보존한다.
- `notification-time-boundary.spec.ts:56`~`:111`은 27종 구분자 × 8종 offset × 소수 없음/6자리/7·10자리 캐리 조합을 **저장소 ContractRegistry/ContractValidator**에 통과시킨 뒤 결과를 단언한다. 공용 validator·namespace를 수정하거나 테스트용 완화 판정을 만들지 않았다.
- `test/app-notification.e2e-spec.ts:510`~`:545`는 T/t/공백/tab/newline/CR × Z/z/+07:00/+0700/+07/-0530/-05 × 소수 없음/6자리/캐리를 실제 HTTP로 보낸다. `:521`~`:524`에서 기준 요청의 ID/total을 fixture 기대값으로 먼저 단언하고, 모든 형식의 양 경계 응답을 그 값과 비교한다.
- 따라서 이번 해소 근거는 **고정 validator → 실제 HTTP query → Prisma 조회 → ID/total 일치**다. 이전의 실패 형식을 helper 단위 테스트만 통과시켜 닫지 않았다.

### 계약·조회 전칸 대조

- GET 두 operation 전체와 연결 Notification/PageMeta/ErrorResponse/ErrorItem의 required/property를 직접 읽었다(`contracts/app-공통.json:1757`, `:1860`, `:3602`, `:3624`, `:3664`, `:4970`). 계약 수정·새 ERROR_CODE는0이다.
- `notification-query.service.ts:27`의 같은 where를 목록과 total에 사용한다. `:30`은 event 발생 시각을 제한하며 notification.created_at을 대신 쓰지 않는다. `:42`는 event 시각·notification_id 내림차순이다.
- 필수 occurredFrom/To 및 boolean/integer 형식은 전역 계약 검증에서 검사한다. 서버 날짜 기본값은 없다. unreadOnly true만 미읽음이고 eventCode는 정확 일치다. 없는 코드·동일/역전 기간은 빈 목록이다.
- 공용 pageRequest의 page1/size50·상한200, 빈 페이지에서도 유지되는 필터 전체 total을 확인했다. `notification-query.service.ts:52`~`:54`의 unread-count는 기간/이벤트/페이지 밖 자기 미읽음 전체다.

| 응답 칸 | 실제 처리 및 검증 |
|---|---|
| notificationId·eventCode·message | 저장 ID/이벤트 코드/수신자별 원문. title·payload로 재조립하지 않음 |
| occurredAt·read·openable | event 발생 시각 ISO, read_at 존재, 화면 원천 미정에 따른 false |
| targetTypeCode·targetId | 계약 enum9값이면 대상 쌍 보존, 미등록/소문자/빈 유형은 쌍 생략 |
| screenId·locationPath | optional 키 생략. payload 유사 키에서 도출하지 않음. 문의102 주석/단언 있음 |
| items·page 및 page/size/total | 배열·공용 페이지 봉투, 필터 전체 개수 |
| unreadCount 및 400 errors | integer 배지 개수, ErrorResponse/ErrorItem 필수칸과 정확한 field/code |

`notification-view.ts:41`~`:50`, view 단위 및 E2E의 고정 계약 응답 validator로 위 전칸을 대조했다. openable false·선택키 생략은 R-7의 의도된 한계다.

## 2. 보안

- 잔존 지적 없음. `notification.controller.ts:20`·`:26`·`:30`~`:33`은 서버 세션 userId만 전달하고 세션 부재를401로 막는다. query `:28`·`:53`은 목록/total/배지 모두 recipient_user_id로 제한한다.
- AppModule 인증→권한→계약 검증 순서, SessionResolver의 session token 종류, SessionService의 활성 계정 조건을 대조했다. 실제 HTTP에서 세션 없음·terminal-only·비활성401, 다른 사용자 격리, userId/recipientUserId·X-User-Id·X-Worker-No 위조 무효를 확인했다.
- 403 미선언 GET에 기능권한을 추가하지 않았다. Prisma의 구조화 조건을 사용하며 변경 코드에 비밀값·로그·새 의존성·외부 전송이 없다.
- `.env` 내용은 출력하지 않았다. 실행 전 URL의 host/port/database/user를 조건 검사하여 전용 lane B 대상 일치만 출력했다.

## 3. 직접 게이트 및 검증 범위

| 리뷰 시점 | 기준 | 단위 전체 | 지정 알림 E2E | 잔존 Major |
|---|---|---|---|---:|
| 최초 | ab90060, 비테스트146 | 89 suites / 772 pass, 4.781초 | 27 pass, 1.321초 | 1: 정밀도 |
| 정밀도 수정 후 | ab90060, 비테스트195 | 90 suites / 798 pass, 4.871초 | 47 pass, 1.680초 | 1: 형식 회귀 |
| **최종** | **8906fb0, 비테스트201** | **91 suites / 837 pass, 5.115초** | **53 pass, 3.169초** | **0** |

세 차례 모두 리뷰어 직접 실행, 실패0·exit0이다. 최종 계약 커버리지 **346/487**은 변경이 있는 작업 브랜치의 수치이며 공식 main 수치로 승격하지 않는다.

```sh
node_modules/.bin/jest --runInBand --no-colors
env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/app-notification.e2e-spec.ts
```

- E2E는 `:77`의 실제 AppModule·configureApp으로 부팅하고 `:660`~`:670`의 HTTP list 호출과 고정 응답 schema 검증을 사용한다. 최종 두 프로세스 종료 및 E2E 독점 해제 완료.
- 시험 행은 무작위 prefix·생성 ID 배열로 격리하고 `:159`~`:181`에서 해당 ID만 정리하며 finally로 앱을 닫는다. µs fixture도 같은 정리 배열에 들어가며 `:611`의 원문 snapshot으로 GET 쓰기0을 확인한다.
- 전체 E2E·`-t`·seed/reset/TRUNCATE·마이그레이션은 실행하지 않았다. 린트/tsc는 루틴의 중복 금지에 따라 재실행하지 않았으며 구현자 최종 pass 보고와 리뷰어 직접 실측을 구분한다. `eslint .`는 실행하지 않았다.

## 4. 컨벤션 / 가독성 및 통합 인계

- 잔존 지적 없음. 명시적 query/view·함수 반환 타입, 작은 controller/query/view와 로컬 시간 helper, 공용 페이지 도구·오류 전파 패턴을 따른다. any·non-null 단언·죽은 코드가 없다.
- `app-domain.module.ts:17`·`:18`·`:46`·`:57`의 자기 등록4줄만 추가했다. 최초 리뷰와 SHA-256이 같고 controller/view/view spec도 동일하다. 기존 등록 삭제·재정렬·공용 계약/인증/페이지/오류 코드 변경은0이다.
- ab90060→8906fb0의 기존 main 변경 파일명을 확인했다. LOT 품질 코어·ConflictException·문서/기존 테스트 변경이며 알림/app 등록·계약·Prisma 변경은 없다. 최신 전체 단위에는 새 LOT 품질 suite도 포함돼 통과했다.
- 이벤트 카탈로그·구독·읽음 쓰기·preview·발생기·외부 전송은 이번 범위0이다. 보류3건을 구현 커버리지에 넣지 않는다.
- **표준 승인 기준 Blocker0/Major0 충족.** 검토한 현재 작업 내용에서 추가 코드 수정 요구는 없다. 최종 PR 생성·소유 확인·병합 판단은 통합자 담당이며 리뷰어는 git/PR/댓글/외부 쓰기를 하지 않았다.
- PR 미생성으로 제목/본문·CI·최종 PR 충돌 상태는 미검증이다. 저장소 정책상 로컬 게이트가 판정 근거다. 이후 코드/등록/base 변경 시 영향 재검증 판단은 통합자가 맡는다.
- 통합자 보고의 app-user22·app-approval-request9 pass는 리뷰어 직접 게이트와 구분한다. 그 이후 공용 등록은 불변을 확인했다. 다른 E2E 파일은 리뷰어가 실행하지 않았다.
- 유일한 파일 수정은 이 리뷰 문서다. 계획 §12·다른 설계/문의·소스·계약은 수정하지 않았다.
