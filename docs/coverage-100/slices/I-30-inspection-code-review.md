# I-30 ① 점검 GET 2건 독립 코드 리뷰 — 최초판

- 대상: `feat/coverage-100-b-i30-a`, base/HEAD `f521a89366f349ee691aca1cec0d725dca702ce4`의 미커밋 후보. 2026-09-07 UTC 검토.
- 고정 계약: `contracts/COMMIT.txt:1` = `a6a87e144116ebaa32c01df5a12a0fd2924427e7`. main 공식350/487, 이 후보352/487(+2); 브리프348은 구 수치다.
- 범위: query122줄·view72줄·controller26줄·module12줄·app.module 자기2줄 = 생산 소스 **234추가/0삭제**. 단위2파일 및 `test/maintenance-inspection.e2e-spec.ts` **757줄 전건**을 읽었다.
- 구현자와 다른 fresh reviewer. source/테스트 수정0. 공유 lane-B/plan/I-26 dirty는 root 소유·범위외다.
- 직접 완독: CLAUDE, coverage README(§2 전단계)/lanes/lane-B, server-architecture, I-30 정본 전건·R-1~14, 구현 브리프/구현 결과, 기존 구현 도메인 규칙, 문의091/094.
- 필수 스킬: `pr-review/SKILL.md` 및 checklist/severity/review-comment, `coding-rules/SKILL.md` 및 TypeScript/commit-convention 전건을 읽고 아래 4영역 순서로 대조했다. 저장소의 로컬 검증·파일 보고·merge 정책이 스킬 기본보다 우선한다.

## 심각도 요약

| Blocker | Major | Minor | Suggestion/Nit |
|:---:|:---:|:---:|:---:|
| 0 | **1** | 0 | 0 |

## 1. 버그 / 정확성

**[Major] 기간 WHERE가 시각 NULL인 과거 점검을 목록과 total에서 숨긴다.**

- 위치: `src/maintenance/inspection/inspection-query.service.ts:78`·`:79` (날짜 비교), `:95` (동일 WHERE count), `:105` (필터·페이지 뒤에야 불변식 검사).
- 조건: 설비/유형 등 관계 필터에 해당하는 `inspected_at=NULL` 과거 행이 있고 `inspectedFrom` 또는 `inspectedTo`가 지정된다. SQL 비교 결과가 UNKNOWN이므로 이 행은 page와 count 양쪽에서 제외되고 `inspectionView`까지 도달하지 않는다. 해당 행뿐이면 정상 빈 목록으로 보이게 된다.
- 근거: `docs/coverage-100/slices/I-30.md:235` 및 `docs/design-inquiries/091-점검-고장-저장-결손과-과거-필수값.md:16`은 결손을 INTERNAL_ERROR로 처리하며 목록/total에서 숨기지 않는다고 명시한다. nullable 실물은 `prisma/schema.prisma:4172`, 응답의 inspectedAt 필수는 `contracts/equipment-05설비툴.json:3227`부터 확인했다.
- 테스트 공백: `test/maintenance-inspection.e2e-spec.ts:417`의 NULL 헤더 단언은 `:442`에서 날짜 없는 미발행 조회만 사용한다. `:483`의 NULLS LAST 검증도 날짜가 없으므로 이 경로를 잡지 못한다. 현재 31 tests PASS는 이 결함의 반증이 아니다.
- 제안: 기간을 적용하기 전 같은 관계 후보의 NULL 시각 존재를 확인해 명시 실패한다. 기존 공장 metadata를 `GROUP BY plant/timezone + bool_or(i.inspected_at IS NULL)`로 읽으면 추가쿼리·임의 날짜 도출 없이 count/page 전에 판별할 수 있다. 일반 기간/한쪽 기간+미발행 HTTP 단언을 추가한다. 날짜 없음의 NULLS LAST와 이미 확정된 역전 빈집합은 기존 의미를 따른다.
- 판정은 읽은 SQL 경로에 근거한다. 결함 조건의 추가 HTTP 실행·소스 패치는 하지 않았다. root에 근거를 먼저 전달했고, root가 R-15/091에 판정을 남긴 뒤 구현자 수정 예정임을 회신했다. 이 보고서/게이트 숫자는 **수정 전 최초판**에 한정한다.

그 밖의 정확성 대조:

- 계약 GET2 operation/parameters/200·400·404 및 Inspection/InspectionLine/PageMeta/ErrorResponse/ErrorItem 본문을 직접 읽었다(`equipment-05설비툴.json:22`, `:232`, `:3018`, `:3072`, `:3163`, `:4236`). 기간 양끝 REQUIRED·미발행 예외·정렬 독립·PASS/FAIL 원문이 일치한다.
- 공장 Intl 선례(`src/mdm/mold/mold-derivation.ts:97`, `mold.service.ts:342`)와 실제 설비→공장 관계를 사용한다. R-13의 반열림 UTC경계·역전·무관한 공장 제외가 구현되어 있다. 날짜 없는 호출은 helper/metadata 평가0(`inspection-query.service.ts:66`).
- 미발행은 INSPECTION_NG의 NOT EXISTS, 취소 지시도 흔적이며 다른 다형 source를 혼동하지 않는다(`inspection-query.service.ts:58`). 페이지/count는 WHERE·스냅샷을 공유하고 읽은 id 순서를 복원한다(`:87`, `:101`, `:110`).
- 헤더10/라인6·현재 표시마스터·worker_no·저장된 종합판정·nullable 키·항목 sequence/id 정렬을 지킨다(`inspection-view.ts:3`, `:52`). 상세404와 매핑 불변식 오류가 구별된다. 숫자버전 ETag·versionNo를 추가하지 않는다.

## 2. 보안

- 특이사항 없음. 값은 `Prisma.sql` 파라미터, 정렬 방향은 닫힌 상수다(`inspection-query.service.ts:52`, `:88`). 따옴표 포함 유형의 바인딩도 단위/E2E로 확인했다.
- GET2는 실제 `@Contract` 등록과 기존 인증→권한→검증 가드를 사용한다(`inspection.controller.ts:16`, `:22`, `app.module.ts:29`). 계약403 미선언 GET에 별도 권한을 추가하지 않았으며 미인증401을 실제 검증했다.
- 신규 의존성·권한·error code·계약·스키마 변경0. 내부 불변식의 원문/스택은 응답에 노출하지 않는 기존 필터를 따른다(`src/common/errors/error.filter.ts:66`).

## 3. 테스트 / 실제 게이트

`/usr/bin/time -p`로 명령 종료코드와 벽시계를 측정했다. 필터 파이프·전체 E2E·다른 E2E·`-t` 실행0.

| 실행 명령 | exit | 실제 결과 | real |
|---|---:|---|---:|
| `node_modules/.bin/jest --runInBand --no-colors` | 0 | **97 suites / 927 tests**, skipped0, Jest5.288s, 후보352/487 | **5.58s** |
| 아래 exact E2E 전체(승인된 escalation 1회) | 0 | **1 suite / 31 tests**, skipped0, Jest1.691s; 2026-09-07 10:45 UTC | **2.06s** |
| `git diff --check` | 0 | 공백 오류 없음 | — |

```sh
env TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/maintenance-inspection.e2e-spec.ts
```

- E-I01~09의 전필터·정렬tie·최신FAIL·공장별 날짜·반열림·NULLS LAST·다형/취소·실제계정 인증·응답 schema를 검증한다. 위 Major의 기간+NULL 조합이 누락되었다.
- 의도된 invalid-zone/required/enum 500 경로의 로그는 발생했으며 실패 테스트는0이다. 최초판 전체 lint·tsc PASS는 구현 보고서 실측을 승계했고 재실행하지 않았다.

## 4. 컨벤션 / 가독성

- 특이사항 없음. 공개 DTO/반환 타입 명시, 얇은 controller와 service의 읽기 트랜잭션, 필요한 공통 뷰로 구성된다. 추가 추상화·다른 도메인 service 의존·미래 POST/provider 선등록0.
- 브랜치는 레인B 접두어를 지킨다. 이 후보는 아직 커밋 전이므로 커밋/PR 제목 판정은 root의 생성 단계에 남긴다. 주석은 091/094·스냅샷·조회 범위를 설명한다.

## DB·정리·인계

- 실행 전 `.env` URL을 파싱해 `127.0.0.1:55432 / omf_mes_lane_b / omf_lane_b`만 검증했다. 자격증명 출력0.
- E2E 뒤 기본권한 `docker exec omf-mes-lane-b-postgres psql -U omf_lane_b -d omf_mes_lane_b -v ON_ERROR_STOP=1 -c <SELECT>` exit0: 실제 DB/user 일치·UTC·완료 마이그레이션 **54**.
- 같은 SELECT에서 `E2E-B-I30-GET` prefix의 inspection/order/plant와 정확한 테스트 login 계정은 **각0행**. cleanup은 소유 id만 자식→부모 순서로 삭제한다(`test/maintenance-inspection.e2e-spec.ts:706`). 부모 삭제 성공과 FK로 라인/trigger 등 자식 잔여가 없음을 확인한다. seed/reset/dev/TRUNCATE/무조건 전체delete0.
- `afterAll`의 cleanup·`app.close`(`:84`) 완료 및 실행 도구 exit0으로 테스트 프로세스 종료 확인. 전용 E2E lease는 root에 **반환 완료**, 추가 실행 계획0.
- 승인 기준은 최초판 **Blocker0/Major1로 미충족**. root가 계획 판정→수정→변경 파일 재검증을 진행한다. precheck/quality 회귀는 root가 별도 직렬1회 소유한다. 과거 결손/구 작성자 환경의 운영 배포 유보(091)는 계속 유지한다.
- git/gh 변이·외부 메시지·다른 agent 생성0. 이 보고서만 apply_patch로 작성했고 source/테스트 및 보고서 소유권을 root에 반환한다.

## 재리뷰 — R-15 수정 후 최종 판정 (2026-09-07 UTC)

**최초 Major 1건 해소. 최종 Blocker0 / Major0 / Minor0 / Suggestion·Nit0.** 위 최초판 기록을 보존하며 현재 판정과 게이트는 이 절을 따른다.

- root가 코드 변경 전에 `docs/coverage-100/slices/I-30.md:40`의 R-15·`:238` 및 문의091`:18`에 기간 소속 불명확 판정을 먼저 기록했다. 기존 본길/기간 정책·운영 결손 배포 유보는 유지한다.
- `inspection-query.service.ts:96`의 기존 metadata 조회가 같은 관계 WHERE로 공장별 `bool_or(i.inspected_at IS NULL)`을 집계한다. `:102`에서 참이면 Error를 던져 페이지/count 전에 기존 INTERNAL_ERROR로 끝난다. 추가쿼리·가짜 날짜·NULL의 임의 기간 포함/제외가 없다.
- 설비/유형/판정/미발행 필터는 집계 전에 적용된다(`:73`). 날짜가 없으면 이 검사를 호출하지 않고(`:91`), 역전은 기존 조기 빈집합(`:61`), 무기간 NULLS LAST와 실제 페이지 매핑 오류(`:128`, `:148`)를 유지한다.
- 추가 단위 `inspection-query.service.spec.ts:88`은 metadata1회·page/count 조회0·findMany0을 확인하며 기존 WHERE 동일성 단언에도 집계SQL을 확인한다(`:62`). 추가 E2E `test/maintenance-inspection.e2e-spec.ts:562`는 일반 양끝/미발행 양끝/From만/To만 4개를 각각500으로 검증하고 다른 판정·설비·유형 및 역전의 정상 결과를 확인한다. 기존 무기간 NULLS LAST는 `:624`에서 계속 통과했다.
- 포맷 후 실제 생산 소스는 query165+view72+controller26+module12+root2 = **277추가/0삭제**, 예산350/상한400 이내다. 수정 전237 후보 수치는 포맷 후 값이 아니다. 신규 단위21 tests·E2E35 tests(1006줄). 재리뷰 중 source/테스트 변경0.

| 재리뷰 실행 명령 | exit | 실제 결과 | real |
|---|---:|---|---:|
| `node_modules/.bin/jest --runInBand --no-colors` | 0 | **97 suites / 928 tests**, skipped0, Jest5.291s, 후보352/487 | **5.54s** |
| 앞 절 exact maintenance-inspection E2E 전체 — 첫 회 | 1 | 34 passed / 1 failed / 35 total, Jest1.840s. 기존 마지막 NULLS LAST에서 `socket hang up`; 신규4개는 PASS | **2.21s** |
| 동일 명령·동일 소스 전체 1회 재실행 | 0 | **1 suite / 35 tests**, skipped0, Jest1.820s | **2.18s** |
| `git diff --check` | 0 | 공백 오류 없음 | — |

- E2E는 단독 lease에서 실행했고 첫 통신 실패 뒤 README §3의 간헐 실패1회 재실행 규칙을 따랐다. 소스 변경 없이 전체35 PASS이며 `socket hang up`의 내부 원인까지 확정한 것은 아니다. 다른파일/전체E2E/`-t` 실행0. root의 lint·tsc/후속 회귀는 리뷰어 재실행 범위 밖이다.
- 재검증 전후 SHA256 동일: query `9629b6ab47bc50f93cecfb80988f158892e5432c2f6238ed94049caf126856ca`, query spec `8b009b1ee02d889a3ef5d977c0a56d0c650e02b5266eab64fd7ae6c469254097`, E2E `d6476e6b272cde2ae6db5d15dd8426599d97210513230e13929b1ce140ef3ecf`.
- 실패 회차 뒤에도 소유 inspection/order/plant/user 각0이었다. 최종 기본권한 read-only docker/psql SELECT exit0: **omf_mes_lane_b / omf_lane_b / UTC / 54 migrations**, prefix inspection/order/item/equipment/worker/plant/business_unit/legal_entity/user **9종 각각0행**. 자식 정리·부모 FK와 afterAll/app.close까지 성공했다.
- 실행 프로세스는 종료(exit0), **E2E lease 재반환 완료**. 추가 DB/E2E 실행 계획0. 코드 리뷰 승인 기준은 충족하며 root가 precheck/quality 직렬 회귀·최종 병합 조건을 확인한다. 보고서만 append했고 소스·테스트·보고서 소유권을 root에 반환한다.
