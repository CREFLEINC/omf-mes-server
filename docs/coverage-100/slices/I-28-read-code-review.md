# I-28 PR② 읽음 2건 — 독립 코드 리뷰

대상: `feat/coverage-100-b-i28-b`의 검토 시작 시점 미커밋 구현, 기준 HEAD `f85cb5162196ac9817b4f072c6037a2151349ccc`.
리뷰어는 구현자와 다른 새 컨텍스트다. 검토·검증일: 2026-09-07.
범위: `POST /app/notifications/{notificationId}:read`, `POST /app/notifications:read-all`.

## 심각도 요약

| Blocker | Major | Minor | Nit |
|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 |

## 읽은 정본과 범위

- `brief-I-28-read.md`, `CLAUDE.md`, coverage-100 `README.md`·`lanes.md`·`lane-B.md`·`plan.md`·`slices/I-28.md` 전체를 읽었다.
- `coding-rules`·`pr-review` SKILL과 TypeScript·commit-convention·checklist·severity·review-comment 참조를 직접 읽고 적용했다.
- 고정 계약 `a6a87e144116ebaa32c01df5a12a0fd2924427e7`의 두 operation 전체와 IdempotencyKey·ErrorResponse·ErrorItem·ConflictResponse를 대조했다.
- 실제 `W-CO-03-알림센터.md` 전체, 서버 아키텍처, 인증·계약 검증·권한·멱등·오류 필터·notice 콜론 라우트 선례를 읽었다.
- 신규 소스 3개·context 단위·기존 알림 E2E 전체 및 공용 등록 두 파일의 diff를 검토했다.
- 비테스트는 context 23 + controller 39 + service 38 + app-domain 4 + 권한 2 = **106 추가/0 삭제**, 심장 상한 200 이내다.
- 테스트는 context 78줄 신규, 기존 E2E 423추가/3삭제다. 계약·마이그·코어·다른 도메인 구현 변경 0.

## 1. 버그 / 정확성

- 특이사항 없음. `notification-write.controller.ts:16,29`는 literal colon을 이스케이프하고 read-all을 슬래시 없는 계약 경로에 바인딩한다. 실제 HTTP 두 경로가 통과했다.
- `notification-write.service.ts:11`의 id+actor 조건을 UPDATE와 존재 확인이 함께 사용한다. `read_at:null` 조건으로 최초 시각을 보존하며, 타인/없는 id는 같은 404다(E2E 646·687).
- `notification-write.service.ts:32`는 자기 전체 미읽음 UPDATE의 실제 count를 반환한다. 사전 COUNT·기간/유형 필터·반복 갱신이 없다. 실제 2→0, 동시 단건 이후 1, 동시 모두 읽음 합계 2를 확인했다(E2E 699·852·901).
- `notification-write.controller.ts:24,34`는 전달 tx로 업무를 실행한다. 공용 `idempotency.service.ts:66`의 생성·업무·COMPLETED 기록이 같은 tx다. 양쪽 완료기록 실패에서 read_at과 멱등 기록의 롤백·같은키 재시도·재생을 확인했다(E2E928).
- read는 await 후 void, read-all은 body만 반환한다. 최초 undefined와 저장된 DB null 재생 모두 204 raw body가 빈 문자열이며 내부 outcome을 노출하지 않는다(E2E 646).
- 같은 키 read-all은 처음 count를 재생하고 이후 새 알림은 미읽음 목록·배지에 남긴다. 새 키만 그 1건을 처리한다(E2E 719).
- openable=false도 읽음 가능하고 전체 목록에는 남는다. 알림/발생 원문의 삭제·제목/메시지 변경은 없다(E2E671).

## 2. 보안

- 특이사항 없음. `notification-write-context.ts:11`은 실제 인증 세션을 필수로 고정하고 actor를 지문·저장 주체에 포함한다. body·query·X-User-Id·X-Worker-No로 recipient를 바꿀 수 없다.
- method/path+actor+body가 지문에 들어가며 If-Match는 제외된다. 같은 키의 다른 actor·다른 id·다른 operation·다른 body는 409이고 원응답을 노출하지 않는다(E2E 736·756·772, context 단위 8건).
- 세션 없음·terminal-only·비활성 계정은 401, 멱등 헤더 누락/빈 값/잘못된 UUID는 400, 잘못된 id는 field=notificationId의 INVALID 400이다(E2E 794·816·836).
- `manual-permissions.ts:12`의 W-CO-03 등록은 화면 §5-5와 단건 403 선언에 근거한다. GET/read-all에 새 권한 게이트를 만들지 않았다. 권한 없는 단건 403, 같은 계정 GET/read-all 정상 경로를 확인했다(E2E 782).
- 새 시크릿·의존성·동적SQL·외부전송 추가0. 실패주입 오류 문자열은 HTTP 응답에 노출되지 않는다.

## 3. 테스트

- 직접 단위 전체: `env TZ=UTC node_modules/.bin/jest --runInBand --no-colors` → **92 suites / 845 tests passed**, 4.788s, **exit0**.
- 직접 알림 E2E: 아래 명령 → **1 suite / 75 tests passed**(기존53+신규22), 4.357s, **exit0**.

```sh
env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand --runTestsByPath test/app-notification.e2e-spec.ts
```

- 최초 샌드박스 E2E는 로컬DB 접근불가로 globalSetup에서exit1, 테스트 시작0. 동일 명령 권한승격 실행1회가 위75/75다. 원인불명 실패나 코드 수정 후 재실행이 아니다.
- `I28_TEST_COMPLETION_FAILURE` 로그2건은 read/read-all 롤백 검증의 의도된 주입이며 실패 테스트0이다.
- 검증은 실제 Nest AppModule·HTTP·고정계약 Ajv·전용DB를 사용했다. 변경 후 기존 GET53건도 모두 통과했다.
- E2E 독점은 root 배정 뒤 취득했다. 실행 종료 후 SELECT로 `omf_mes_lane_b`의 I28 users/roles/notifications/events 각각0, idempotency_record 전체0을 확인했다.
- 단위·E2E·정리확인 명령 모두 종료됐으며 실행 중인 본 리뷰의 tool 세션0. root에 독점 해제를 통보했다.
- `git diff --check` 직접 exit 0. lint/tsc는 구현자의 통과 보고를 구분해 인용하며 재실행하지 않았다.

## 4. 컨벤션 / 가독성

- 특이사항 없음. 공개 반환 타입·camelCase/PascalCase·const·명시적 오류 전파·작은 책임을 확인했다. 오류는 멱등 서비스와 공용 필터가 처리하며 삼키지 않는다.
- 저장소 ESLint 설정을 직접 읽었다. 불필요한 추상화·미사용 query 확장·요청본문 변조·공용파일 재정렬은 없다.
- app-domain은 자기 import/controller/provider 4줄만 추가했고 기존 등록을 보존한다. 브랜치는 Lane B 규칙에 맞는다. 검토 시작 시점에는 커밋/PR 생성 전이었으며 해당 메타데이터 판정은 통합자 몫이다.

## 판정과 기준 변경 인계

- **검토한 f85cb516 기준 구현은 Blocker+Major0으로 코드 승인 기준 충족.** 신규 계획 누락·범위 확대 요구0.
- 단위에서 브랜치 **348/487(+2)**를 확인했다. 공식 main값346/487과 구분하며 병합 전 공식 증가로 기록하지 않는다.
- root가 통보한 최신 origin/main `a2cdbbc`(#294 A품질)는 아직 이 검증 기준에 포함하지 않았다. root 설명상 품질nullable/수량CHECK·품질뷰/E2E 변경이며 알림·공용등록diff0이다.
- 최신 main 병합·필요한 DB 동기화·generate·후속 로컬 게이트 및 충돌 검증은 root가 수행한다. 이 리뷰의 75/75를 병합 후 실측으로 바꿔 적지 않는다.
- 외부댓글·커밋·PR·머지·다른문서 수정0. 본 리뷰파일만 작성했다. 실제 머지 판정은 최신base 반영과 root 게이트 완료 뒤 가능하다.
