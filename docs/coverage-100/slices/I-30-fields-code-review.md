# PR #308 I-30 ② 저장 필드 독립 코드 리뷰

2026-09-07, 구현자와 다른 새 컨텍스트의 Codex 리뷰. 대상은 실제 GitHub PR **#308 `[B] feat(maintenance): I-30 점검·고장 저장 필드 보완`**, head `feat/coverage-100-b-i30-b` / `bef46d1592709466297d559a609ea6138da3336a`, base `main` / 배정 기준 `d5979ca`다. `gh pr view`와 `gh pr diff` 전문을 직접 읽어 B 소유를 확인했다. 소스 수정·git 변경 명령·GitHub 쓰기·새 에이전트 생성0.

## 심각도 요약

| Blocker | Major | Minor | Nit |
|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 |

변경 범위에서 수정이 필요한 결함을 발견하지 않았다. 계획을 뒤집는 Major0이며 R 추가 요청0. 코드 승인 기준은 충족한다. 병합 실행은 root 소유이고, root의 precheck/app-user 영향 회귀·최신 main 동기화·최종 drift/workflow 확인은 이 보고서의 완료 주장에 포함하지 않는다.

## 1. 버그 / 정확성

- `prisma/migrations/20260907115007_b_i30_inspection_breakdown_fields/migration.sql:21`: nullable8 추가와 severity_code 완화, `:32` 점검 status_code 완화가 정본 R-2·§2-3 SQL과 일치한다. 새 default·CHECK·인덱스·함수·원인마스터·컬럼/표 삭제·백필0. 기존 값과 제약을 치환하는 SQL0.
- `prisma/schema.prisma:54`, `:4106`: 기존 `app_user.breakdown` 및 `breakdown.app_user` 필드명을 보존한 채 reporter 관계명만 명시한다. handler 역관계와 정방향 관계는 별도 이름이고, `handled_by`는 app_user FK 및 NoAction/NoAction이다. reporter를 worker로 바꾸지 않는다.
- `prisma/schema.prisma:4091`: 발생상태와 보고 사번은 varchar50, 시각은 timestamptz(6), 처리 원인/메모는 text, 알림 의사는 boolean, 처리 계정은 bigint이며 모두 nullable이다. `equipment_inspection.status_code`만 nullable로 완화하고 judgment_code/worker 관계는 보존한다.
- `src/maintenance/inspection/inspection-view.ts:52` 전문 확인: status_code를 읽지 않으므로 소스 보정 없이 nullable 저장값을 매핑할 수 있다. 신규 E2E가 실제 status NULL 행의 PASS·workerNo·inspectedAt 보존을 검증한다.
- `test/maintenance-fields.e2e-spec.ts:175`은 새 값의 왕복·NULL 해제 뒤 기존 행 전체를 비교한다. 원문 description/root_cause·보고 계정/시각·기존 심각도·시작/완료 시각을 새 필드와 혼동하지 않는다.
- 설계 갈림길은 README §2의 0단계 계약·문의053 선례를 먼저 적용했다. 계약 미노출 status/severity를 지어내지 않고 nullable로 완화한다. 원인 완료는 본길 유보090 유지, 저장칸 존재를 신규 비null API 쓰기 허용으로 해석하지 않는다. 새로운 가장자리 정책이나 상태 전이를 추가하지 않았다.

## 2. 보안

특이사항 없음. 인증·권한·핸들러 변경0이며 시크릿 추가0. 신설 FK는 무효 계정 저장과 참조 계정 삭제를 거부한다. 사번은 인증 계정과 분리된 원문 저장칸이다. Raw SQL은 고정 metadata 조회이며 외부 입력 문자열을 연결하지 않는다.

## 3. 테스트

신규343줄7건 및 기존 점검 E2E1006줄35건을 모두 직접 읽었다. 신규 테스트는 metadata의 타입·정밀도·nullable/default, 실제 저장/NULL 해제, reporter/handler 양방향 Prisma 관계, 계정 미연결 worker, FK 거부, 원인 저장칸의 품질 FK 부재를 단언한다.

`test/maintenance-fields.e2e-spec.ts:256`의 제목에는 키 변경이 포함되지만 **실제 PK UPDATE는 실행하지 않았다**. `:277`의 pg_constraint 조회와 `:284`, `:291`의 confupdtype='a' 단언으로 NO ACTION 구조를 검증한 것이다. 무효 handled_by 저장 및 계정 DELETE의 P2003는 실제 실행했다. UPDATE 동작 실행 PASS로 확대하지 않는다. `:295`의 cause 직접저장은 물리 칸 검증이며 API 원인코드 정책 검증이 아니다.

직렬 실행 결과는 아래와 같다. 시간은 exec_command의 wall_time_seconds이며 Jest 보고 시간은 별도다. 모든 test 수에서 skipped0, 실패0, 재실행0이다.

| 실제 명령 | exit | 시간(초) | 결과 |
|---|---:|---:|---|
| `node_modules/.bin/jest --runInBand --no-colors` | 0 | 5.643291292 | 98 suites / 931 tests, Jest5.546s, 브랜치 커버리지353/487 |
| 아래 공통 prefix + `test/maintenance-fields.e2e-spec.ts` | 0 | 0.527649458 | 1 suite / 7 tests, Jest0.290s |
| 아래 공통 prefix + `test/maintenance-inspection.e2e-spec.ts` | 0 | 2.108229917 | 1 suite / 35 tests, Jest1.868s |

```sh
env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand
```

위 prefix 끝에 표의 해당 파일 하나를 지정했다. 전체 E2E·`-t`·동시 E2E0. 기존 점검의 Invalid timezone/Missing required field/Invalid stored result/NULL inspected_at 로그는 파일의 의도된 INTERNAL_ERROR500 단언에 해당한다. 최종 Tests에 failed가 없음을 직접 확인했다.

기존 ESLint exit0 2.672811958초 및 tsc(all) exit0 4.680704958초는 구현자의 PR 본문과 구현 실측 보고서를 재사용했다. 중복 실행0. 신규 마이그55→56, generate6.19.3, drift0, checksum 일치, 기존16제약 보존+FK1, 관련7표0행 및 사전/사후 결손0은 구현자 실측을 재사용했다. 사전·사후 SELECT 파일 전문을 읽었으며 판정을 뒤집을 근거가 없어 같은 DB 구조/전후 수치를 재측정하지 않았다.

## 4. 컨벤션 / 가독성

특이사항 없음. CREFLE TypeScript·commit 규칙과 저장소 ESLint 설정을 직접 대조했다. 새 테스트의 명시 타입·async/await·예외 전파·finally disconnect, 기존 Prisma 관계 이름 보존 및 SQL 주석의 도메인 이유를 확인했다. 테스트343줄은 파일 분리 검토 신호이나 단일 migration 책임7건과 공통 fixture/cleanup으로 구성되어 이 PR에서 분리를 요구할 근거는 없다.

실제 비테스트 `git diff -w --numstat d5979ca...HEAD -- src prisma`는 migration +54/-0, schema +14/-4 = **72줄**로 배정200·상한400 이하다. SQL/schema 선행커밋291031d → 테스트b2a71a3 → 문서bef46d1 순서다. B 브랜치·제목 접두어를 확인했고 계약 파일 변경0이다.

## 환경·정리·잔여

- E2E 전 SELECT로 B DB `omf_mes_lane_b` / role `omf_lane_b` / UTC, 법인1·사업부2·공장1을 확인했다. `test/global-setup.ts`를 직접 읽어 공유 조직 생성 분기가 실행되지 않는 선행조건을 확인했다.
- 두 파일의 `E2E-B-I30-FIELDS` / `E2E-B-I30-GET` 소유 fixture만 기존 파일의 beforeAll/afterAll로 생성·정리했다. 외부 fixture 작성·임의 데이터 삭제·DDL·seed/reset/dev/migrate0.
- 실행 뒤 SELECT exit0: breakdown/inspection/inspection_result/order/trigger/worker/equipment/inspection_item/app_user/plant/business_unit/legal_entity **12표에서 두 PREFIX 잔존 각각0**. 세부 자식은 실제 FK와 부모0 확인으로 고아가 없으며 cleanup이 완료됐다.
- `pgrep -fl 'jest/bin/jest.js|node_modules/.bin/jest'` 출력0/exit1로 Jest 프로세스0을 확인했다. DB/E2E 독점 lease는 root에 반환했다.
- 추가 gh diff 일반 sandbox에서 네트워크 연결 오류1회가 있었고 narrow escalation의 동일 읽기 명령 exit0으로 해소했다. 테스트 게이트 실패0·automatic approval rejection0. 파일 탐색에서 없는 glob에 의한 exit1은 실제 파일명 조회로 해소했다.
- 운영 과거 required/enum 결손·구 작성자 유무는 확인하지 않았다. 이 개발 DB 검증을 운영 배포 승인으로 확대하지 않는다. 완료090·알림/첨부·후속③~⑦ 구현은 여전히 해당 정본 소유자의 후속 작업이다.
- `gh pr view` 확인 당시 base main, MERGEABLE, CLEAN, draft=false였으나 CLEAN을 CI 통과라고 판단하지 않았다. 현재 workflow 상태 확인과 root 회귀는 root가 별도로 마감한다.

스킬 영향: `pr-review`의 4영역·Blocker/Major/Minor/Nit 기준 및 `coding-rules`의 TypeScript·커밋 기준으로 판정했다. 스킬의 GitHub 댓글/자동 squash 기본값은 위임 범위와 저장소 README/lanes/lane-B의 파일 리뷰·root 소유·merge commit 규칙으로 대체했다. 스킬 때문에 미완으로 남긴 요청은 없다.

**리뷰 완료. 보고서 편집 소유도 root에 반환한다.** 검증 HEAD는 bef46d1이며 마지막 상태 확인의 root 문서 변경3건은 건드리지 않았다.

## 통합자 병합 전 추가 관문

2026-09-07 root는 독립 리뷰 전문·구현 SQL/schema/test343줄·사전/사후 SELECT 및 구현 실측을 직접 읽었다. 수정 요청0, 비테스트72(예산200/상한400)·선행 마이그 커밋 분리를 확인했다.

- 독립 리뷰의 DB lease 반환 뒤 같은 E2E prefix로 `test/production-precheck-decision.e2e-spec.ts` 전체 **12/12**, exit0, Jest1.479s/real1.85s.
- 이어 `test/app-user.e2e-spec.ts` 전체 **22/22**, exit0, Jest2.386s/real2.75s. 동시 E2E0·재실행0.
- 최종 Prisma datasource↔datamodel drift **No difference detected**, exit0, real0.572s.
- 최종 `git fetch origin` 뒤 main은 배정 기준 d5979ca 그대로. 실제 자기 PR #308의 제목·head·base main·MERGEABLE/CLEAN을 확인했다.
- GitHub workflows 3개가 모두 **disabled_manually**, statusCheckRollup=[]임을 새로 읽었다. CI green을 주장하지 않고 위 실제 로컬 게이트·독립 리뷰를 병합 판단 근거로 남긴다.
- 마이그는 nullable8추가·NOT NULL2완화이며 삭제/백필0. 병합 직전 사용자 한 줄 보고 후 root가 자기 PR에 merge commit을 실행한다. 실제 MERGED/SHA·열린 자식0·브랜치 정리는 병합 후 §12에 기록한다.

