# I-30 ③ 고장 조회 2건 구현 결과

- 구현 기준: `feat/coverage-100-b-i30-c`, 최종 기준 HEAD `f85b0b252456b10881357b0cf73fb819aa226270`(`#309` 문서 전용 병합 뒤, source/prisma/test/contracts 변화 0).
- 고정 계약: `a6a87e144116ebaa32c01df5a12a0fd2924427e7` 읽기 전용.
- 구현 오퍼레이션: `GET /maintenance/breakdowns`, `GET /maintenance/breakdowns/{breakdownId}`. 단위 전체 실측 후보 커버리지 **355/487**(기준 353에서 +2). 공식 main 수치는 root가 병합 뒤 다시 센다.
- 직접 완독: 구현 브리프, `docs/coverage-100/slices/I-30.md` 전체 R-1~R-15/§1/§4/§8/§10, coverage README/lanes/lane-B, CLAUDE, server architecture, coding-rules SKILL과 TypeScript/commit 참조. 고정 계약의 GET 두 path와 Breakdown 16칸·BreakdownHandling 5칸·Attachment·PageMeta 연결 스키마 전문을 대조했다.
- 제외: 쓰기/채번/상태전이/core/권한/DDL/계약/공유 문서 변경 0. attachment는 확정 경계대로 빈 배열이며 원인 마스터 lookup·가짜 항목 0.

## 구현 의미

- 목록 질의 9칸을 전부 AND한다. 기본 `openOnly=true`는 `status_code <> 'DONE'`; `statusCode=DONE`과 기본값은 빈 집합이다. `openOnly=false`는 `withoutMaintenanceOrder`와 무관하게 기간 양끝을 REQUIRED로 요구한다. sort는 생략/`elapsedDesc`만 허용하고 그 밖은 400 INVALID다.
- 설비→공장의 `timezone_code`만 metadata로 읽고 `maintenanceDateRange`로 From 포함/To 다음 달력일 제외를 만든다. 날짜 없는 호출은 zone 평가 0, 역전은 DB 조회 0의 빈 집합, 관련 공장의 잘못된 zone은 INTERNAL_ERROR다. 동일 관계 조건에서 `reported_at IS NULL` 소속 불명도 날짜 WHERE 전에 검사한다(실물은 NOT NULL 유지).
- DB WHERE로 count/page/정렬 뒤 한 페이지 id와 전체 응답 필드만 읽는다. `reported_at ASC, breakdown_id ASC`, `totalCount=page.total`, 공용 page 1/50/max200이다. metadata/count/page/행/연결은 단일 `RepeatableRead` snapshot이다.
- 미발행은 직접 `maintenance_order.breakdown_id`와 다형 `maintenance_order_trigger(type=BREAKDOWN, source_id)` 양쪽 `NOT EXISTS`; 지시 상태를 보지 않아 취소 이력도 발행 흔적이다. 응답 연결은 두 원천 `UNION`을 페이지 범위에서 일괄 조회하고 0개 null/1개 id/2개 이상 null로 접는다. 같은 지시의 직접+트리거 중복은 제거한다.
- mapper는 Breakdown 16칸/handling 5칸의 저장 원천을 구분한다. `reporter_worker_no`, occurrence/stopped/reported/started 축을 바꾸지 않고 `root_cause`를 cause/note로 전환하지 않는다. cause_code 역사 조회에 현재 품질 마스터를 요구하지 않는다. required 결손과 저장 status enum 밖 값은 INTERNAL_ERROR이며 목록에서 조용히 숨기지 않는다.
- 목록은 `linkedDowntimeCount=0`, minutes/open count 생략. 상세는 전체 count·열린 count·닫힌 행별 초 합계를 먼저 구하고 정확히 60으로 나뉘는 경우만 안전한 정수 분을 반환한다. 열린 구간은 now까지 더하지 않고 1µs 합계는 null이다.
- 상세만 `version_no`를 숫자 ETag로 내리고 본문 versionNo는 없다. GET은 업무/멱등/버전/재고 쓰기를 하지 않는다.

## 파일·예산

| 파일 | 비테스트 추가 | 삭제 |
|---|---:|---:|
| `src/maintenance/breakdown/breakdown-query.service.ts` | 204 | 0 |
| `src/maintenance/breakdown/breakdown-view.ts` | 86 | 0 |
| `src/maintenance/breakdown/breakdown.controller.ts` | 33 | 0 |
| `src/maintenance/maintenance.module.ts` 자기 import/등록 | 4 | 2 |
| 합계 | **327** | **2** |

비테스트 touched **329**로 브리프 예산350/절대상한400 이내다. 바로 옆 신규 unit spec 2파일/18 tests, 신규 E2E 1파일/10 tests다. 테스트로 제품 로직을 옮기지 않았다.

## 검증 실측

모든 Jest는 파일 전체 또는 단위 전체이며 `-t`·전체 E2E·동시 E2E는 0이다. E2E는 root가 배정한 lane-B 독점 lease에서 직렬 실행했다.

| 게이트 | exit | 결과 | `/usr/bin/time -p` real |
|---|---:|---|---:|
| `node_modules/.bin/eslint "{src,test}/**/*.ts"` 최초 | 0 | 전체 lint 오류 0 | 3.11s |
| `node_modules/.bin/tsc --noEmit -p tsconfig.all.json` 최초 | 0 | 전체 타입 오류 0 | 4.97s |
| `node_modules/.bin/jest --runInBand --no-colors` | 0 | **100 suites / 949 tests**, skipped 0, Jest 5.765s, coverage 355/487 | 6.12s |
| 자기 E2E 일반 sandbox | 1 | localhost 55432 접근 불가, globalSetup에서 종료, 실행 tests/fixture 0 | 0.29s |
| 자기 E2E DB 첫 회차 | 1 | **1 suite / 9 passed, 1 failed**. sort 허용 단언이 의도적 required 결손 fixture까지 전건 조회한 테스트 격리 결손 | 2.43s |
| 자기 E2E DB 최종 전체 | 0 | **1 suite / 10 tests**, skipped 0, Jest 1.557s | 1.93s |
| 전체 ESLint 최종 | 0 | E2E 단언 수정 포함 오류 0 | 3.06s |
| 전체 TypeScript 최종 | 0 | E2E 단언 수정 포함 오류 0 | 4.93s |
| `prisma migrate status` | 0 | **56 migrations**, database up to date | 0.51s |
| `prisma migrate diff --exit-code --from-schema-datasource ... --to-schema-datamodel ...` | 0 | **No difference detected** | 0.80s |
| final prefix/DB identity SELECT | 0 | `omf_mes_lane_b` / `omf_lane_b` / UTC, 자기 7종 잔존 모두 0 | — |
| `git diff --check` 및 신규 파일별 `--no-index --check` | 0 / 차이만 1 | whitespace 진단 출력 0 | — |

E2E 실제 명령:

```sh
env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/maintenance-breakdown.e2e-spec.ts
```

첫 DB 회차의 제품 경로는 10개 중 9개를 통과했고 실패는 테스트 자체가 필수결손 fixture를 무필터로 포함한 데서 발생했다. 해당 단언에 유효한 `orderEquipment` 필터만 추가했으며 제품 source는 바꾸지 않았다. 최종 전체 파일에서 10/10을 확인했다. 출력의 invalid zone/required 결손/unknown status 로그는 각각 500을 기대한 테스트 경로이며 실패가 아니다.

## E2E 범위·정리·소유 반환

- E-B01~10과 §8-6의 GET 해당 경계를 실행했다: 전필터/기본 open/false 기간/정렬·형식오류/페이지 total, 서울·하노이 동일순간과 반열림 날짜, invalid zone/역전, 직접·다형·취소·중복 UNION·복수 연결, 목록/상세 집계, 열린 구간 now 불변, PostgreSQL 실제 1µs, root_cause 원문, Breakdown16/handling5/Ajv, 숫자 ETag, 404/401/무권한 auth200, GET 전후 업무·멱등·version·inventory 불변.
- 고유 `E2E-B-I30-BREAKDOWN` PREFIX의 법인→사업부→공장→설비→고장/비가동/지시/트리거와 별도 로그인만 생성했다. beforeAll 자기치유/afterAll FK 역순 자기정리, finally app.close. seed/reset/TRUNCATE/조건 없는 deleteMany/마이그 적용 0.
- 최종 외부 SELECT에서 breakdown/order/equipment/plant/business_unit/legal_entity/user가 각각 0이다. downtime/trigger는 부모 FK 정리 성공과 E2E cleanup으로 함께 제거됐다. Jest 프로세스 확인은 일반 sandbox에서 sysmond 부재 exit3 후 승인된 read-only 재확인에서 출력0/exit1(매칭 프로세스 없음)이었다.
- 독점 DB/E2E lease는 최종 정리·drift 확인 뒤 root에 반환했다. 이후 DB/E2E 추가 실행 계획 0.
- git add/commit/branch 변경/push/gh/외부 메시지/새 agent 0. 구현 source/spec/E2E/report 소유는 이 보고로 root에 반환한다. 추가 수정은 root 재허가 뒤에만 한다.

CREFLE coding-rules는 명시 타입, 읽기 트랜잭션의 실패 전파, 이름으로 드러나는 계약 경계, 사용처 하나뿐인 얇은 controller/service/view 구성에 적용했다. 미등록 값을 정상으로 꾸미거나 원인·시간·지시를 조용히 도출하지 않았다.
