# PR #307 독립 코드 리뷰

대상: `[B] feat(trace): I-26 제품 개체 목록 조회 1건`, `feat/coverage-100-b-i26-a` → `main`.
검토 HEAD `bb681a9212cf70c54ecb12b3209123b41de27907`, source `871acc9`, 비교 base `6bde921`.
2026-09-07 UTC 검토, 종료 확인 11:36:37 UTC. 구현자와 다른 새 컨텍스트 리뷰어.

## 심각도 요약

| Blocker | Major | Minor | Nit |
|---:|---:|---:|---:|
| 0 | 0 | 1 | 0 |

## 1. 버그 / 정확성

특이사항 없음. `serial-number-query.service.ts:9`의 optional 질의 8개를 실제 production 계약 GET과 대조했다. `:20`은 undefined만 생략하며 lotId/itemId/statusCode 정확 일치, q 대소문자 무시 부분일치, 모든 조건 AND다. 기간 없는 NULL 포함 및 기간 조건의 NULL 제외는 DB 비교 의미와 E2E로 확인했다. 없는 상태·모순 조건은 정상 빈 목록이다. 별도 상태 원천·기본값·POST 핸들러는 없다.

`serial-number-query.service.ts:40`은 공용 pageRequest의 1/50/상한200을 사용하고 PK ASC와 skip/take를 적용한다. `:43`의 배열 tx는 findMany/count에 같은 where를 전달하고 RepeatableRead를 명시한다. total이 현재 페이지 길이로 축소되지 않는다. query service에 write/명시적 행 잠금/상태 전이/발행기록 호출이 없다.

`serial-number-time-boundary.ts:2`는 notification 로컬 순수 알고리즘과 동일하다. T/t/단일 공백류·Z/z·offset 정규화, 6자리 뒤 비영 소수의 양 경계 ceil, 월/윤년/연도 이월을 읽었다. 실제 µs fixture의 6·7·9·10자리·0꼬리·날짜 carry와 허용 표기 HTTP 테스트 통과. 응답의 Date→ISO ms 매핑은 계획이 구분한 기존 응답 정책이며 필터의 µs 비교와 혼동하지 않는다.

`serial-number-view.ts:15`의 7개 응답 필드를 SerialNumber required5/optional2 및 PageMeta required3 실물과 대조했다. 실제 id/no/item/lot/status/version을 반환하고 producedAt NULL은 undefined→키 생략이다. `trace.module.ts:18`의 기존 Prisma/Idempotency/LotRegistry imports, LOT controller2/provider3을 보존하고 자기 controller/provider만 추가했다.

## 2. 보안

특이사항 없음. @Contract 요청 검증은 실제 ContractValidationGuard/Ajv coerceTypes 경로를 따른다. SQL 문자열 연결 없이 Prisma 조건을 전달한다. 403 미선언 GET에 추가 권한·Worker-No·멱등·If-Match를 강제하지 않고 세션 인증은 유지한다(무세션401·역할 없는 fixture 세션200 E2E 통과). 제품 코드에 비밀값·새 의존성·새 권한표·core/auth 변경이 없다. E2E PASSWORD는 고유 테스트 사용자에만 쓰는 fixture 값이다.

## 3. 테스트

- **[Minor] `test/trace-serial-number.e2e-spec.ts:86` — non-null producedAt 반환값 단언 누락.** 첫 응답 검증은 required5와 versionNo를 확인하지만 producedAt은 계약상 optional이라 Ajv만으로 존재 여부를 보장하지 않는다. 다른 시각 테스트도 ID/total만 확인하므로 매퍼의 producedAt 항목을 실수로 삭제한 회귀를 잡지 못한다. 현재 제품 매핑 `serial-number-view.ts:22`는 올바르므로 차단 결함은 아니다. 이 fixture에 `producedAt: '2026-09-07T00:00:00.000Z'`를 추가해 계획의 기존 Date 응답 정책까지 직접 단언하는 보완을 권한다. 실제 소스 변경·변이 실험은 하지 않았다.

단위 1파일3건과 E2E 1파일14건을 읽고 §8-1과 대조했다. 실제 raw SQL로 µs를 보존한 fixture, nullable 키 생략, raw status, 필터/페이지/추가403 없음/업무·멱등 증분0을 확인했다. 단위가 동일 where/RepeatableRead 배선을 직접 단언한다. B DB 전용 단독 lease와 실행 전 serial0 조건에서 지정 파일 전체를 실행했다. 공유 DB에 다른 개체가 남은 상태까지 테스트 독립성을 검증했다고 주장하지 않는다.

## 4. 컨벤션 / 가독성

특이사항 없음. CREFLE coding-rules TypeScript/commit 규칙과 저장소 eslint.config.js를 실제 대조했다. 명시적 query/view 타입·반환 타입, const·엄격 비교·undefined 처리·Nest 기존 controller/service 패턴, no-any/no-non-null, 새 공용 추상화0, 도메인 간 service 의존0을 확인했다. 비동기 DB 예외는 기존 공용 처리 경로로 전파한다. 브랜치와 PR의 B 접두어는 lanes의 저장소 우선 규칙을 따른다. source 비테스트 155추가+2삭제=157, 배정250/상한400 이내. 추가 spec93줄·E2E363줄은 별도다. 문서 diff는 I-26 진행 및 이미 병합된 I-32 기록이며 root 소유로 보존했다.

## 실제 검증 명령 / 결과

| 검증 | 실제 명령 | exit | 결과·시간 |
|---|---|---:|---|
| PR 읽기 | `gh pr view 307 --json title,body,author,baseRefName,headRefName,headRefOid,files,additions,deletions,mergeable,mergeStateStatus,isDraft` 및 `gh pr diff 307` | 0 | B 소유/HEAD 일치, main, non-draft, CLEAN/MERGEABLE. sandbox 네트워크 실패 후 동일 읽기 명령을 접근 허용으로 성공 |
| 단위 전체 | `/usr/bin/time -p node_modules/.bin/jest --runInBand --no-colors` | 0 | 98 suites/931 tests, Jest5.357s·real5.57s |
| DB 준비 | URL hostname/port/database/user만 Node dotenv로 확인, `docker exec omf-mes-lane-b-postgres pg_isready -U omf_lane_b -d omf_mes_lane_b`, `docker exec … psql -U omf_lane_b -d omf_mes_lane_b -v ON_ERROR_STOP=1 -c <SELECT>` | 0 | 127.0.0.1:55432/omf_mes_lane_b/omf_lane_b/UTC, migration55, serial0. 조직 법인1/사업부2/공장1로 globalSetup의 조직 생성 불필요 |
| E2E 전체 | `/usr/bin/time -p env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/trace-serial-number.e2e-spec.ts` | 0 | 1 suite/14 tests, Jest1.324s·real1.69s |
| whitespace | `git diff --check 6bde921...HEAD` | 0 | 오류0 |
| fixture 종료 | 아래 SELECT를 B 컨테이너 psql로 실행 | 0 | serial/lot/item/plant/legal_entity/user 전부0 |

```sql
SELECT (SELECT count(*) FROM trace.serial_number WHERE serial_no LIKE 'SNE2E-%') AS serials,
 (SELECT count(*) FROM trace.lot WHERE lot_no LIKE 'SNE2E-%') AS lots,
 (SELECT count(*) FROM mdm.item WHERE item_code LIKE 'SNE2E-%') AS items,
 (SELECT count(*) FROM mdm.plant WHERE plant_code LIKE 'SNE2E-%') AS plants,
 (SELECT count(*) FROM mdm.legal_entity WHERE legal_entity_code LIKE 'SNE2E-%') AS legal_entities,
 (SELECT count(*) FROM app.app_user WHERE login_id LIKE 'sn-e2e-%') AS users;
```

lint/tsc는 구현자 실측 exit0(3.06s/5.36s)를 검토하고 중복 실행하지 않았다. Prisma generate6.19.3/drift0은 root 인계 근거이며 리뷰어 재실행0. 단위의 353/487은 브랜치 후보값으로만 기록한다. 공식 최신 main 숫자·GitHub workflow 상태 최종 확인·trace-lot 전체 영향회귀는 root 관문이다. CLEAN 자체를 CI green으로 간주하지 않는다.

## 읽은 범위 / 종료 / 미완

CREFLE pr-review SKILL/checklist/severity/template, coding-rules SKILL/TypeScript/commit-convention 전체, CLAUDE, coverage README(§2 전문 포함)/lanes/lane-B, server-architecture, I-26 전체(R1~R10·조건부 POST·§8·부록 포함), brief-I-26-get 및 구현 인계 전체를 읽었다. 고정 COMMIT a6a87e144116ebaa32c01df5a12a0fd2924427e7, production GET/SerialNumber/PageMeta 실물, 관련 공용 pagination/validation/permission/omitEmpty와 notification helper, 변경 diff 전부를 읽었다.

테스트 자체 cleanup은 고유 SNE2E 접두어 및 소유 사용자 id의 역순 삭제만 수행했다. 리뷰어 직접 삭제/seed/reset/migrate/설정 변경0. E2E afterAll cleanup/app.close 통과 및 실행 세션37935 종료 exit0, 단위 세션92567 종료 exit0. 별도 서버/감시 프로세스 시작0. OS 전체 ps 조회는 sandbox에서 operation not permitted라 전체 프로세스 목록은 확인하지 못했으며, 두 실행 세션의 정상 종료로 본인 실행 종료를 확인했다. E2E lease 사용 종료·root에 반납.

source·계약·다른 레인·공유 문서 변경0. 본 로컬 보고서만 작성. gh comment/review/approve/merge/edit/push0. 발번 POST의 필수 상태·개체 단위 원천과 문의104~107/If-Match 재수립은 유보 유지.

## 머지 판정

승인 기준 Blocker0/Major0 충족. Minor1은 응답 테스트 보완 권고다. 제품 코드 수정 요구0. 독립 리뷰 관문 통과이며 실제 병합은 root의 최신 main·공용 TraceModule·trace-lot 영향회귀·로컬 게이트 최종 판정 후 수행한다. 리뷰어는 병합하지 않았다.

## 후속 재검토 — Minor 해소

root가 `test/trace-serial-number.e2e-spec.ts:91`의 첫 응답 `toMatchObject`에 `producedAt: '2026-09-07T00:00:00.000Z'` 한 줄을 추가했다. 리뷰어는 실제 `git diff -- test/trace-serial-number.e2e-spec.ts`를 읽어 이 변경을 확인했다. non-null fixture의 기존 Date→ISO 응답값을 직접 검증하므로 위 Minor를 해소한다. 제품 source 변경0이며 남은 심각도는 **Blocker0 / Major0 / Minor0 / Nit0**이다.

재검증은 **root 실측 인계**: 기존 exact `test/trace-serial-number.e2e-spec.ts` 파일 전체 명령으로 14/14, exit0, Jest1.309s·real1.68s. 리뷰어가 이번 후속에서 실행한 테스트/게이트는0이며 독립 재실행으로 표기하지 않는다. E2E lease는 root가 유지한다. root의 trace-lot 영향회귀 및 병합 최종 관문은 별도이며, 본 보고서 작성 소유도 root에 반환한다.
## 통합자 병합 전 관문

2026-09-07 root가 최신 origin/main 6bde921을 fetch로 확인했다. TraceModule 기존 LOT imports/controller/provider는 그대로이고 자기 시리얼 등록만 추가된 diff를 대조했다. 기존 `test/trace-lot.e2e-spec.ts` 파일 전체는 같은 B 전용 DB에서 exit0, 20/20, Jest2.379s·real2.74s. 새 E2E 날짜값 단언 보완 후 파일 전체14/14도 위 후속 표에 기록했다.

GitHub workflows 실제 조회는 Build & Push to Harbor/CI/Deploy to dev server 모두 `disabled_manually`다. CI 실행 성공으로 가장하지 않고, 구현자 lint/tsc·독립 전체 단위/변경 E2E·통합자 LOT 회귀의 로컬 검증을 근거로 판정한다. 계약 a6a87e1/DDL/core/auth/권한 변경0, 비테스트157. 최종 잔여 Blocker/Major/Minor/Nit0. 실제 MERGED 여부·main 공식 커버리지는 병합 후 기록한다.

