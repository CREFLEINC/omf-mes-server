# I-30 ③ 고장 조회 — 독립 CREFLE PR 리뷰

대상: [#310 [B] feat(maintenance): I-30 고장 목록·상세 조회 2건](https://github.com/CREFLEINC/omf-mes-server/pull/310).

- 기준 main `f85b0b252456b10881357b0cf73fb819aa226270`, 구현 소스 `9b9ac16bfbeb4d0efcb926cedd95a70bb657ac56`, 검토 HEAD `c5672d30c567a74ca90543c58d5679e13ff7a058`. 마지막 커밋은 문서뿐이며 소스·Prisma·test·계약 diff 0을 독립 확인했다.
- `feat/coverage-100-b-i30-c`의 GET `/maintenance/breakdowns`, GET `/maintenance/breakdowns/{breakdownId}`만 검토했다. 컨트롤러·쿼리·뷰·인접 단위 2파일·고장 E2E 전체·MaintenanceModule 자기 등록을 직접 읽었다. 구현자와 다른 새 컨텍스트이며 제품 코드 수정 0이다.
- 계약 `a6a87e144116ebaa32c01df5a12a0fd2924427e7` 고정. equipment 계약 GET 2건·9질의·Breakdown 16칸·handling 5칸·Attachment·PageMeta·ErrorResponse/ErrorItem 전문을 대조했다.
- CLAUDE, coverage README/lanes/lane-B, server architecture, I-30 계획 전체 R-1~R-15/본문/검증/분할, 구현 브리프·결과 전문을 읽었다. CREFLE pr-review SKILL·checklist·severity·review-comment, coding-rules SKILL·TypeScript·commit-convention을 완독했다. 계획 실측 부록의 DB 사실은 재측정하지 않고 실행 전제와 종료 잔존만 확인했다.

## 심각도 요약

| Blocker | Major | Minor | Nit |
|:---:|:---:|:---:|:---:|
| 0 | 0 | 0 | 0 |

## 1. 버그 / 정확성

특이사항 없음.

- `src/maintenance/breakdown/breakdown-query.service.ts:46`: sort 생략/elapsedDesc, openOnly=false의 양끝 기간 REQUIRED, without 플래그로 기간 우회 불가, 역전 빈집합을 계획 094와 대조했다. `:64`의 9질의 AND와 DONE 제외는 statusCode=DONE 기본 호출의 빈집합을 유지한다.
- 같은 파일 `:81`: 날짜 외 후보조건으로 공장 metadata만 읽고 NULL 시각을 선검사한다. `maintenanceDateRange`에 설비 공장의 zone을 전달하고 from 포함/to 익일 제외 조건을 DB WHERE로 만든다. 날짜 없는 호출의 zone 평가 0, 잘못된 zone의 INTERNAL_ERROR, 서버 TZ/SQL AT TIME ZONE/24h 도출 0이다. R-15의 reported_at NULL 방어는 읽었으며 현재 실제 컬럼은 NOT NULL이므로 DDL을 바꿔 해당 행을 만들지 않았다.
- 같은 파일 `:104`: count와 page에 같은 WHERE, reported_at/id ASC, 페이지 id 범위의 행·연결 일괄 조회, `:131`의 RepeatableRead 단일 snapshot이다. totalCount=page.total이며 관계상 후보 전체 id를 메모리에 적재하지 않는다.
- 같은 파일 `:70`, `:165`: 직접 FK와 BREAKDOWN 다형 트리거 양쪽 NOT EXISTS/UNION. 상태 조건이 없어 취소 지시도 발행 흔적이고 다른 trigger 종류의 같은 source_id는 무관하다. `:179`의 Set과 `:189`의 단일값 판정은 중복을 제거하고 0/복수 연결을 null로 둔다. 복수 null이 미발행으로 오인되지 않는다(095).
- 같은 파일 `:145`, `:193`: 상세만 전체/열린 count와 닫힌 행별 정확 numeric 초 합계를 구한다. 열린 구간 now 계산 0, 합산 후 mod(60) 판정으로 소수 분은 null이며 정수 분은 안전 정수 여부를 확인한다. 목록의 count 0·상세 전용 키 생략은 `src/maintenance/breakdown/breakdown-view.ts:70`, `:81`에 있다.
- `src/maintenance/breakdown/breakdown-view.ts:42`, `:59`: 필수 결손·저장 상태 오류를 정상 응답으로 꾸미지 않는다. 사번/현장 정지/보고/처리의 원천을 구별하고 root_cause 전환과 현재 품질 원인 마스터 조회 0이다. 선택 notify null은 생략, handling 5칸은 정확한 원천/null, 첨부는 승인된 I-34 제한대로 빈 배열이다.
- `src/maintenance/breakdown/breakdown.controller.ts:23`: 상세만 setEtag(versionNo), 본문 versionNo 없음. 조회의 업무·원장·멱등·버전 쓰기 0이다. 새 상태·채번·권한·DDL·오류코드·계약·완료 핸들러도 추가하지 않았다.

## 2. 보안

특이사항 없음.

- `breakdown-query.service.ts:66`, `:68`, `:95`, `:109`, `:170` 등 외부 값은 Prisma SQL 바인딩이며 raw 문자열 결합/injection 경로가 없다. unknown status 문자열의 SQL 주입 모양도 단위 테스트가 값 바인딩을 확인한다(`breakdown-query.service.spec.ts:60`).
- 컨트롤러 `:18`, `:24`의 @Contract와 기존 전역 인증·검증을 유지한다. GET 두 계약의 403 미선언과 `src/common/permissions/permission.guard.ts:40`을 대조했다. `test/maintenance-breakdown.e2e-spec.ts:325`에서 세션 없는 두 GET은401, 권한을 부여하지 않은 별도 로그인은200을 확인했다.
- diff에 실제 자격증명·토큰·환경값 추가 0이다. E2E의 PASSWORD는 해당 스위트가 직접 만든 임시 사용자 전용 fixture다. .env 내용을 읽거나 출력하지 않고 기존 dotenv로만 실행했다.

## 3. 테스트

특이사항 없음. 독립 실행에서 실패/skip 0이다.

| 독립 명령·검사 | exit | 실측/시간 |
|---|---:|---|
| `/usr/bin/time -p node_modules/.bin/jest --runInBand --no-colors` | 0 | 100 suites / 949 tests, skipped0, Jest5.617s, real5.98s |
| 아래 자기 E2E 파일 전체 | 0 | 1 suite / 10 tests, skipped0, Jest1.582s, real1.95s |
| dotenv 기반 DB identity/조직 count SELECT, 일반 sandbox | 1 | DB 접근 불가 진단, tests0·writes0; 별도 real 미계측 |
| 동일 SELECT, 좁은 로컬 DB 접근 escalation | 0 | omf_mes_lane_b/omf_lane_b/UTC, 조직1/2/1; 별도 real 미계측 |
| 종료 후 identity/migrations/잔존 SELECT | 0 | 56 migrations, 아래 잔존9종 모두0; real0.13s |
| `git diff --check f85b0b2 HEAD` | 0 | whitespace 진단0; 별도 real 미계측 |
| `git diff -w --numstat f85b0b2 HEAD -- src prisma` | 0 | spec 제외327추가+2삭제=329 |
| `git diff 9b9ac16 HEAD -- src prisma test contracts` | 0 | 출력0, 테스트된 소스 동일 |
| `gh pr view 310 --json number,title,body,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,state` | 0 | 자기 번호/브랜치, HEAD c5672d3, main/OPEN/not draft/MERGEABLE/CLEAN; tool wall0.71s |

E2E 실제 명령(배정된 DB 독점 lease에서 1회, UTC):

```sh
/usr/bin/time -p env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/maintenance-breakdown.e2e-spec.ts
```

일반 sandbox의 읽기 진단만 실패했고 동일 SELECT의 로컬 DB 접근 허용 뒤 성공했다. 리뷰 E2E는 첫 실행에 전부 통과했다. invalid zone 1건·required 결손 2건·unknown status 1건의 예외 로그는 기대한500 경로다. 구현자의 이전 테스트 격리 실패/수정 이력은 구현 보고서와 PR 본문에서 별도로 확인했으며 독립 실패로 합산하지 않았다.

E-B01~10의 정상/형식/기간/정렬/페이지, 서울·하노이 같은 순간의 다른 날짜, 양쪽 지시/취소/다형/중복/복수, 16+5 스키마와 값·숫자 ETag, 목록/상세 집계, 실제 PostgreSQL1µs, 과거 결손/원문/없는id, 인증과 GET 전후 불변을 확인했다. query/view 단위 신규18개도 전체 스위트에 포함됐다. 후보 커버리지355/487은 기준 main353 대비 +2이며 공식 main 실측으로 승격하지 않았다.

구현자의 최종 전체 ESLint exit0/3.06s·tsc(all) exit0/4.93s·drift0 기록을 확인했고 README §6에 따라 반복 실행하지 않았다. 전체 E2E·동시 E2E·-t 실행0, 다른 E2E 수정/실행0이다. 기존 inspection/precheck 회귀는 root가 lease 반환 후 수행한다.

## 4. 컨벤션 / 가독성

특이사항 없음.

- TypeScript의 명시적인 공개 타입, 작은 controller/service/view 역할, 명확한 비동기 실패 전파를 기존 Nest/Prisma 패턴과 대조했다. 불필요한 repository·새 공유 개념·죽은 코드·새 의존성0이다. 지역 처리 책임 없는 DB 오류는 Nest 오류 봉투로 전파하며 catch로 삼키지 않는다.
- `src/maintenance/maintenance.module.ts:4`, `:11`은 자기 import/등록만 추가하고 기존 InspectionController/InspectionQueryService를 보존한다. 전체 재정렬/다른 모듈 변경0이다.
- 비테스트 touched329는 브리프350/절대400 이내다. 제품 로직을 테스트로 옮긴 흔적0이며 테스트는 fixture·단언·정리 책임이다. 커밋 `feat(maintenance): 고장 목록과 상세 조회 구현`, 실제 PR의 [B] 접두어·lane 브랜치를 규칙과 대조했다. 문서 커밋도 기능 변경과 분리돼 있다.

## 정리·소유 반환·머지 판정

- `test/maintenance-breakdown.e2e-spec.ts:58`의 자기치유와 `:596`의 FK 역순·PREFIX/소유id 정리를 확인했다. `:81`에서 cleanup 실패에도 finally app.close를 수행한다. globalSetup의 조직 보완은 사전 조직1/2/1 확인으로 기존 데이터만 읽었고 추가하지 않는다. seed/reset/TRUNCATE/조건 없는 deleteMany/마이그 적용0이다.
- E2E 프로세스는 exit0으로 종료했다. 종료 후 별도 SELECT에서 breakdown/order/downtime/trigger **전체4표0**이고 자기 PREFIX의 equipment/plant/business_unit/legal_entity/app_user **5종0**이다. app.close finally와 Prisma 진단 finally disconnect를 확인했다. 이후 DB/E2E 독점 lease는 root에 명시 반환했고 재사용하지 않았다.
- **승인 기준 Blocker0·Major0 충족.** 코드 리뷰 승인. PR의 base main·not draft·MERGEABLE/CLEAN은 read-only gh로 확인했다. GitHub Actions가 비활성이라는 저장소 운영 규칙상 CLEAN을 CI green으로 해석하지 않았다. 최신 main 동기화·root 영향 회귀·최종 로컬 게이트/워크플로 상태 확인 뒤 root가 자기 PR을 `--merge`로 판정한다.
- git/gh 변경·PR 댓글/리뷰 게시·병합·브랜치 변경·외부 메시지·새 agent0이다. 본 보고서 외 파일 편집0이며 **보고서와 검토 대상 소유를 root에 반환**한다. 추가 작업은 root 지시 뒤에만 수행한다.


## root 병합 직전 인수

- root가 변경 source329·unit2파일256줄·E2E655줄·구현 보고서 및 위 독립 리뷰 전문을 직접 읽었다. 추가 지적0.
- 기존 maintenance-inspection.e2e-spec.ts 전체35tests exit0(Jest2.282s/real2.73s), production-precheck-decision.e2e-spec.ts 전체12tests exit0(Jest1.465s/real1.85s). reviewer lease 반납 뒤 두 파일을 직렬1회 실행, 예외 로그는 예상500 경로다.
- PR #310 실제 title/head/base를 확인했고 workflow3개 모두 disabled_manually임을 gh API로 확인했다. statusCheckRollup 빈배열/CLEAN을 CI green으로 표시하지 않는다. 기존 source9b9ac16 이외 기능수정0, 계약/assignment변경0이다.
- 최종 `prisma migrate diff --exit-code --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma` exit0·No difference detected·real0.80s. source/계약 변경 없는 문서 마감 뒤 최신 main을 확인하고 병합한다.
