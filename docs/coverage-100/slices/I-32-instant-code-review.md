# I-32 P0t 독립 코드 리뷰

**대상**: #312 — maintenance exact-microsecond helper. 고정 source `bfde446d12974aceb8735d7a1a8bb1dc92e43581`, 비교 base `2f846e4c1055c304047435ec40000b9be897ada4`.
**요약**: maintenance 내부 공용 순간 경계의 정확한 epoch µs, UTC ISO6, PostgreSQL UTC/1BC 바인딩을 검토했다. API 증분은 0이며 기존 GET·스키마·코어 변경은 없다.

## 심각도 요약

| Blocker | Major | Minor | Nit |
|:---:|:---:|:---:|:---:|
| 0 | 0 | 1 | 0 |

## 1. 버그 / 정확성

특이사항 없음.

- `src/maintenance/maintenance-instant.ts:22`: 정수 달력 초만 Date로 구성하고 `setUTCFullYear` 및 각 성분 역대조로 ISO0/0099·윤년·잘못된 날짜를 처리한다. 소수 원문은 Date에 전달하지 않는다.
- 같은 파일 `:88`: 숫자 offset의 시/분 범위를 검증하고 `:102`에서 정수 초에 offset을 적용한 뒤 별도 BigInt µs를 결합한다. +23:59/음수 offset도 서버 TZ에 의존하지 않는다.
- 같은 파일 `:46`: 저장값 string/bigint 런타임 타입 가드, 정수 문자열 검증, 응답 연도 범위가 일반 Error다. 공용 `src/common/errors/error.filter.ts:70` 이후의 내부 500 경로와 일치한다. 입력은 `:14`, `:93`, `:96`, `:103`에서 실제 fieldName을 가진 400 INVALID/RANGE로 구분한다.
- 같은 파일 `:66`: 음수 나눗셈의 나머지를 보정하여 -1/-1000/-1001 µs를 정확히 복원한다. 허용 연도 범위 안의 정수 ms는 Number 안전 범위 안이다. `:75`의 ISO0→1BC는 달력 날짜/µs를 보존한다.
- R2/R14/R15와 I-31 R8·공유 T 경계를 대조했다. µs 초과 비영 값·윤초·정규 UTC 연도 범위만 정해진 RANGE로 거부하고 서버 now·미래 거부·임의 시각 보완은 없다. 계획을 바꿀 Major/새 R 사유는 없다.

## 2. 보안

특이사항 없음. 새 의존성·시크릿·권한/라우트 변경이 없고, `test/maintenance-instant.e2e-spec.ts:30`은 Prisma 태그 파라미터에 정규 UTC 문자열을 바인딩한다. SQL 문자열 연결과 `AT TIME ZONE`은 없다.

## 3. 테스트

핵심 경로와 경계의 동작 단언을 확인했다. 실제 ContractValidator가 설치된 Ajv date-time 형식을 검증하며, 설치된 ajv-formats 3.0.1의 날짜/시간/구분자 구현과도 대조했다. 소수6·짧은 소수·뒤쪽0·비영 초과, 0000/0099/윤년, 양음 offset, 음수 epoch, 윤초, 응답 양끝과 초과, 저장 런타임 타입, 미래 허용이 포함된다. ISO0 윤일의 소수 µs는 실제 PG 왕복까지 통과했다.

| 리뷰어 명령 | 실제 결과 | 시간 |
|---|---|---|
| `/usr/bin/time -p node_modules/.bin/jest --runInBand --no-colors` | exit 0, 101 suites / 987 tests, 355/487 | Jest 5.8s, real 6.14s |
| `/usr/bin/time -p env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/maintenance-instant.e2e-spec.ts` | 좁은 로컬 네트워크 escalation 후 exit 0, 1 suite / 8 tests | Jest 0.242s, real 0.74s |
| `docker exec omf-mes-lane-b-postgres psql -U omf_lane_b -d omf_mes_lane_b -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname='omf_mes_lane_b' AND pid<>pg_backend_pid();"` | exit 0, 잔존 세션 0 | 명령 즉시 완료 |

실패 기록: 첫 E2E는 sandbox의 127.0.0.1:55432 접근 차단으로 global setup에서 exit 1(real 0.27s), suite 실행 0이었다. 동일 whole-file 명령을 escalation하여 통과했다. 최종 Docker 세션 확인도 최초 sandbox socket 접근은 거부됐고, read-only escalation 재실행은 exit 0/잔존0이다. 테스트 코드 실패는 없었다.

DB 사전 확인: 정확한 B DB/user `omf_mes_lane_b`/`omf_lane_b`, PG16.14, 적용 migration 56, 법인1/사업부2/공장1, 기존 접속0. global setup의 조직 보완 분기가 실행되지 않을 전제가 이미 갖춰져 있었다. 새 suite는 상수 SELECT8만 수행하며 DML/DDL/seed/reset/migration은 0이다. Prisma는 afterAll에서 종료했고 전체 실행 프로세스 종료 및 잔존 세션0 확인 뒤 **독점 DB lease를 root에 반환했다**.

구현자의 최종 lint exit0/real2.55s, tsc exit0/real4.52s 실측은 구현 보고서를 근거로 채택했다. 리뷰어는 중복 lint/tsc, `-t`, 전체 E2E, 다른 E2E를 실행하지 않았다. Full unit 완료 후 root의 I-28 스택 전환을 허용했으며 리뷰 대상 helper3 파일은 고정 source로 유지했다.

## 4. 컨벤션 / 가독성

- **[Minor] `src/maintenance/maintenance-instant.spec.ts:83`** — README §2 3단계가 요구하는 `// 설계 미정 — 문의 109` 연결이 정책 단언에 없다. 현재 동작과 문의109 문서는 일치하지만 테스트만 읽어서는 회신 때 재검토할 정책을 추적하기 어렵다. `:83` 윤초 RANGE 그룹, `:91` 6자리 뒤 비영 RANGE 그룹, `:109` 정규 UTC 연도 초과 RANGE 그룹, `:117` 미래 허용 테스트 위에 해당 주석을 붙이는 것을 권고한다. `:137` 저장 연도 범위 Error 그룹도 같은 R14 경계이므로 함께 연결하면 된다. 동작 수정이나 새 정책 R은 필요 없다.

그 외 특이사항 없음. coding-rules SKILL·TypeScript/commit reference, pr-review SKILL·checklist/severity/template를 완독하여 적용했다. 공개 타입/반환 타입·readonly·명확한 함수 책임과 네이밍이 유지된다. source108줄은 P0t150 및 비테스트400 한도 안이다. 고정 diff는 source108+unit143+E2E38과 관련 canonical docs뿐이며 전체294추가/4삭제다. 계약 사본 a6a87e144116ebaa32c01df5a12a0fd2924427e7·오류코드·스키마 변경0을 확인했다.

## 머지 판정

승인 기준 **Blocker0/Major0 충족**. 로컬 구현/리뷰 게이트 통과. 위 Minor는 주석만 보완 가능하며 gate 중복 실행 사유가 아니다. PR base/충돌/소유 최종 확인 및 실제 merge는 root 소관으로 남긴다. 이 리뷰어의 source/docs 수정·git/gh 변경은 0이며 산출물은 이 리뷰 파일 하나다.

## 최종 보완 확인 — Minor 해결

root가 추가한 `git diff -- src/maintenance/maintenance-instant.spec.ts`를 직접 확인했다. 윤초·비영 초과 정밀도·입력 UTC 연도 범위·미래 허용·저장 UTC 연도 범위의 다섯 그룹 바로 위에 `// 설계 미정 — 문의 109`와 각 판정의 정확한 설명이 추가되었다. 변경은 주석 5줄뿐이며 runtime source·테스트 로직·단언 변경은 0이다. 위 Minor는 해결되었다.

**최종 미해결 개수: Blocker 0 / Major 0 / Minor 0 / Nit 0.** 기존 full unit 101 suites/987 tests 및 changed E2E 1 suite/8 tests 통과 근거를 유지하고 중복 게이트는 실행하지 않았다. DB lease는 이미 반환됐고, 이 리뷰 보고서의 편집 소유도 root에 반환한다.
