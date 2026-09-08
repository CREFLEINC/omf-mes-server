# I-32 독립 API 계획 리뷰

대상: `.backend-dev/lane-b/I-32-draft.md` 전체 858줄·브리프 전체. 기준 main `f85cb51`, 공식 346/487은 통합자 전달값이며 재계수하지 않았다.
판정: **수정 후 계획 확정 — Blocker 0 / Major 3 / Minor 2 / Nit 0.** 목록·상세·등록·수정 4건은 아래 Major 해소 후 진행 가능하다. close·summary 보류 후보는 독립 대조에서도 타당하나, 보류 근거를 좁혀 적어야 한다. 이번 작업 증분 0.
적용: coding-rules·TypeScript·commit-convention, pr-review·checklist·severity·template 전체. CLAUDE·coverage README/lanes/lane-B/plan 규칙과 I-32의 API/UIUX/통합 절을 대조했다. 외부 댓글·git·코드/DB 쓰기·E2E·게이트·하위 에이전트 실행 0.

## 1. 필수 응답·물리 결손·과거행 — 조건부 적합

- 실제 배정은 `docs/coverage-100/assignment.tsv:227`부터 GET 3·POST 2·PUT 1의 6행이다. 계약 operation 6개와 Downtime/Create/Update/Summary 및 하위 3개·PageMeta·헤더·오류 스키마를 직접 읽었다.
- `contracts/equipment-05설비툴.json:4340`의 required 5개 중 reasonCode는 현재 nullable이고 recordedByWorkerNo는 저장칸이 없다(`prisma/schema.prisma:4147`). 메모·사번·version 추가3와 type NOT NULL 완화1은 계약의 쓰기 경로를 여는 데 필요하다. `closed_by`의 app_user FK를 사번으로 쓰지 않는 구분도 맞다(`prisma/schema.prisma:4159`).
- nullable 추가는 과거행의 required 결손을 해소하지 않는다. 초안:243~256의 배포 전 결손/구 작성자 점검, 근거 없는 백필·행 숨김 금지, 결손 시 INTERNAL_ERROR는 유지한다. 점검 DB 0행은 운영 배포 근거가 아니다.
- `workSessionId:null`은 허용된다. 계약:4324~4325가 입력 경로 부재와 채움 주체 미정·필드 제거 기본안을 명시하므로 새 FK나 세션 도출을 만들 필요가 없다.
- **최소 조건:** 추가/완화 선행 커밋, 대상 환경 required 결손 0 또는 근거 있는 별도 이관 결정, 아래 M1의 무손실 반환, 목록·상세·쓰기 응답 12필드 검증. 조회 사전점검을 신규 API가 만든 정상행의 영구 전건 거부로 구현하지 않는다.

## 2. 단말 시각·본문 없는 offline close·오류 — 수정 필요

- close는 `contracts/equipment-05설비툴.json:1926`의 “지금 시각”·오프라인 큐와 `:1948`까지의 입력 선언에 종료 발생시각 경로가 없는 **본길 입력 원천 결손**이다. “서버 now” 명문도, 추가 본문 금지 명문도 없다. C-12의 서버 덮어쓰기 금지와 서로 반대인 두 명문이 확인된 것은 아니다.
- 근거: `.design-reference/omf-mes/design/wiki/decisions-policy/공유계약.md:1872`·`:1891`, `.design-reference/omf-mes/design/wiki/screens/05/P-05-02-비가동실적입력.md:123`·`:131`. 오프라인 종료 10:05가 도착 10:30이면 현재 입력만으로 10:05를 복원할 수 없다. 서버가 임의 endedAt/occurredAt 헤더를 만들어 해소하지 않는다.
- **close 최소 조건:** 종료 발생시각 전달 규약 또는 서버 처리시각을 쓰는 예외를 권한 있는 설계 결정으로 닫는다. 입력을 변경하는 해법은 고정 계약 갱신 승인과 별개로 기록한다. 다른 4건까지 중단할 근거는 없다.

**[Major M1] 밀리초 제한은 실제 저장 한계보다 좁다.**

- 문제: `.backend-dev/lane-b/I-32-draft.md:311`·`:313`·`:625`는 `.123001` 입력을 400으로 거부하고 같은 정밀도의 기존행도 조회 배포 차단 대상으로 삼는다. 계약:4363·4374는 date-time이며, 실제 컬럼은 `timestamptz(6)`이다(`prisma/schema.prisma:4152`). JS Date의 ms 한계는 선택한 매핑 경로의 한계다.
- 선례를 구분해야 한다. `src/app/notification/notification-query.service.ts:32`는 문자열을 Prisma 조건으로 넘기고, `notification-time-boundary.ts:1`은 µs 격자의 **조회 경계**를 보존한다. `test/app-notification.e2e-spec.ts:510`·`:563`도 저장 µs와 필터 경계를 다룬다. 이 선례가 응답 Date까지 무손실임을 증명하지는 않는다.
- **수정:** I-32는 DB가 표현 가능한 µs를 문자열/바인딩 경로로 저장·비교하고, DB에서 UTC 문자열 및 정확한 초 차이를 받아 반환한다. `Date`로 변환한 뒤 원문 복원을 시도하지 않는다. 6자리 뒤 비영 소수는 물리 표현 한계에 따른 400 RANGE 후보로 별도 기록한다. 조회의 올림 helper를 쓰기 값에 적용하면 발생시각을 바꾸므로 금지한다.
- **최소 검증:** `.123456` POST→DB→GET→PUT→GET의 instant/정밀도 보존, 서로 다른 offset의 동일 instant, 기존 µs 행, 날짜 경계 전후 µs·duration 정수/소수분. P0/P1 예산에 읽기·쓰기·매퍼 비용을 다시 배정한다.

**[Major M2] 상태 잠김의 구체 400 규약을 포괄 422보다 뒤로 두었다.**

- 문제: 초안:359·363·588의 이미 닫힌 close `422 STATE_LOCKED` 후보는 계약:1990의 “상태 잠김·참조 존재는 400”과 C-9의 이미 처리된 큐 요청 `400 STATE_LOCKED`에 어긋난다(`.design-reference/omf-mes/design/wiki/decisions-policy/공유계약.md:1822`, `:2502`). generic 422 응답 선언은 이 구체 규약을 뒤집지 않는다. PUT도 계약:1908에 같은 400 문언이 있다.
- **수정:** 다른 키의 이미 닫힌 close는 400 STATE_LOCKED로 정하고, 400 응답항목 누락을 문의한다. PUT의 완료 고장 새 연결 등 “상태 잠김” 분기도 같은 구체 문언과 대조한다. POST의 별도 업무 검증에 422를 쓰는 가능성까지 지울 필요는 없다.
- **오류 봉투 확인:** 400/403/404/422는 `{errors:[{scope,code,message,...}]}`, 409는 `{conflictCause,message}`이다(계약:3018·3058·5280). `NotFoundException`은 `404 / screen / NOT_FOUND`로 변환되며(`src/common/errors/error.filter.ts:51`), `ContractException(422, errors)`도 원형 유지한다(`:47`). 미존재 404를 required 결손 500과 섞지 않는다.
- 헤더 누락/형식 오류의 기존 400은 `idempotency.guard.ts:35`·`:44`, `optimistic-lock.guard.ts:39`·`:50`에 실재한다. close의 400 미선언을 헤더 검증 제거 또는 422 일괄 변환 근거로 읽지 않는다.

**[Minor m1] 미래 시각의 비교 시계·정밀도를 명시해야 한다.**

- 초안:395·406·693은 미래 거부를 화면 명문만으로 해소했다고 적지만, P-05-02:190은 비교 시계를 정하지 않는다. C-12:1891은 5분 빠른 단말도 차가 정확하다고 하고, `:1926`은 서버와 크게 벌어진 시각을 별도 기록으로 사후 판별한다고 한다. 서버 now 비교를 명문이라고 단정하면 빠른 단말의 정상 `[지금]`도 거부될 수 있다.
- **수정:** 미래 입력 거부 자체는 유지하되 서버 비교 시계 선택을 README §2의 가장자리 판정으로 분리하고, 한 번 고정한 기준 instant·µs 비교·빠른 단말의 기대 응답을 적는다. 보정값·새 헤더를 만들지 않는다. 해당 한계를 문의·D20에 연결한다.

## 3. 열린 구간·겹침·잠금·PUT null 재개 — 조건부 적합

- P-05-02:187~188은 겹침 허용과 기존 진행 중일 때 새 시작 금지를 함께 선언한다. 설비 행 잠금으로 빈 open 집합의 경쟁을 막고, 모든 관련 쓰기가 `equipment → downtime` 순서를 공유하는 초안:369는 적합하다. closed interval의 교차를 금지하는 UNIQUE/EXCLUDE는 만들지 않는다.
- 이미 open이 있어도 과거 닫힌 구간 등록을 허용하는 구분은 “새로 시작”보다 넓은 차단을 피한다. 기존 중복 open은 숨기거나 마이그로 고치지 않고 배포 점검/원본 조회 대상으로 남긴다.
- `overlappingOnly`는 같은 설비의 전체 원본 짝을 대상으로 판정한 뒤 후보행의 기간·사유 필터 및 page/count를 적용해야 한다. 초안:323~346의 방식은 다른 사유와의 겹침을 잃지 않는다. 맞닿음·0길이·서로 다른 설비 제외도 맞다.
- PUT nullable는 입력 형식 허용이며 재개 업무 허용 명문은 아니다(계약:4411). closed→null 거부는 가장자리에서 상태를 쓰지 않는 선택으로 가능하다. open+null 유지·생략 유지·closed 종료시각 수정과 구별하는 D25/D27을 유지한다.
- **최소 조건:** 설비 잠금 후 대상 재조회·version 확인, 고장 행 잠금 순서의 I-30/I-31 조율, open 동시 생성/PUT 종료 경합·rollback 검증. closed→null 400 STATE_LOCKED는 명시 미정으로 문의에 남긴다.

## 4. summary 실제 원천·미정 분리 — 보류 후보 유지, 근거 축소

- 실제 조업은 `work_session`의 합이고 무장비 세션을 계획 배정으로 메우지 않는다. 실제 저장도 equipmentId 생략 시 null이다(`src/production/work-session/work-session.service.ts:74`). 열린 세션 정책 미정은 계약:4483에 명문이다. 열린 비가동 제외 규칙을 복사할 수 없다.
- 합집합은 설비별, 사유합은 임의 배분 없이 별개, 열린 비가동은 시간 제외+건수, minor는 actual 포함, groupBy의 by배열은 하나만이다(계약:2050·4505·4515, W-05-08:125~140). OEE·W/O 홀드시간을 더하지 않는 구분은 적합하다.
- 계획분의 교대 재료와 캘린더는 실재한다. 보전 결과의 completed_at도 실재한다(`prisma/schema.prisma:4242`). **I-31 미구현/현재 0행 자체가 “원천 없음”은 아니다.** 완료 보전의 건 단위·귀속 시각·범위가 미정인 점이 핵심이다. 직접 breakdown FK와 BREAKDOWN trigger의 이중 존재 검사는 유지한다.
- **[Minor m2] 닫힌 규칙까지 다시 본길 미정으로 묶지 않는다.** 초안:460·526·702의 minor 사유합 포함 여부/정책 범위는 W-05-08:146·155의 별도 줄과 `:304`의 “공장 단위면 충분” 근거를 먼저 반영한다. `계약:4515`는 minor의 actual 포함을 이미 확정했다. 원본 사유를 minor라는 새 코드로 바꾸지는 않는다. 재논의는 공장별 정책 평가일·복수 임계의 scalar 표현·겹친 minor 시간 등 남은 부분에 한정한다.
- **최소 조건:** 기간 선택/clip·정수분 반올림 단위와 시점, 열린 세션·무장비 범위, 날짜×설비 계획 구간 및 적용 이력/누락, 정책 평가 시점, 완료 보전의 건 단위/시각을 닫는다. 특정 자료에서만 생기는 가장자리는 명시 거부 가능성을 각각 판정한다. 모든 정상 조회의 수치를 바꾸는 미정이 남으면 summary를 등록하지 않는다.

## 5. 헤더·전달 tx 원자성·배포·350/400 예산 — 수정 후 적합

- 쓰기3 멱등, create/close 사번, PUT If-Match 필수·close 선택, 상세 GET만 버전 ETag가 맞다(계약:2974~3014·1800). PUT의 P-05-02 권한 등록은 필요하다. 현재 POST/close만 derived에 있다(`src/common/permissions/derived-permissions.ts:195`).
- `IdempotencyService.run(tx)`의 업무 실행과 응답 기록은 같은 tx다(`src/common/idempotency/idempotency.service.ts:66`·`:77`·`:79`). `master-write.ts:24`·`:34`는 tx를 전달하지 않으므로 로컬 직접 호출이 맞다. 업무 참조 읽기·mapper·쓰기가 전달 tx만 쓰고, 성공 재생에서는 현재 코드/사번 상태를 재검사하지 않는 구조를 유지한다. actor/worker 지문, If-Match 지문 제외도 재생과 정합한다.
- **[Major M3] 저장된 공장 TZ 결손을 사용자 입력 오류 400으로 내지 않는다.** 초안:307의 400 INVALID 후보는 사용자가 입력하지 않는 `plant.timezone_code`를 요청 오류로 돌린다. 같은 helper 선행 계획은 INTERNAL_ERROR로 닫혀 있다(`docs/coverage-100/slices/I-30.md:278`).
- **수정/최소 조건:** 잘못된 요청 date는 400, 저장 zone 결손·유효 경계 산출 불가는 500 INTERNAL_ERROR로 분리한다(`src/common/errors/error.filter.ts:70`). UTC 대체·행 제외 0, `openOnly=true` 무기간이면 불필요한 TZ 평가 0. 잘못된 zone·DST 23/25시간·자정 전이/없는 달력일을 P0 검증 이름에 넣는다. 상세는 기간 경계 계산에 종속시키지 않는다.
- 비테스트 예산 ≤350/실제 상한400, 코어 PR200, 마이그 별도 선행 커밋은 맞다. 초안:719~759는 기존 파일 실측과 미래 배정치를 구분한다. M1을 반영한 mapper/raw query 비용을 P0/P1에 재배정하고, 넘으면 조회 계산부/배선을 분할한다. 긴 줄 압축으로 예산을 맞추지 않는다. 과거 필수값·구 작성자·인증/CORS 제한을 배포 노트에 유지한다.

## 검토·검증 기록

- 정확성은 위 다섯 축, 보안은 SQL 바인딩·사번/계정 구분·권한·재생 주체·tx, 테스트는 D01~D34/C01~C06/S01~S20의 기대값, 컨벤션은 타입·책임 분리·공용 코드 무변경·레인 규칙 순서로 검토했다. 구현이 없어 테스트 통과/머지 가능 판정은 하지 않았다.
- 계획자 실측의 행 수·코드 수·파일 줄 수는 재측정하지 않았다. M1의 저장/반환 가능성을 확인하려고 전용 `omf_mes_lane_b`에서 **합성 상수 SELECT 1회**만 성공 실행했다. 결과: `TimeZone=UTC`, 문자열 `2026-09-06T03:00:00.123456Z`, 정확한 차 `60.000000`초. 처음 Docker socket 접근은 sandbox에서 거부됐고, 같은 읽기만 권한 검토 후 실행했다. 업무 데이터 조회·변경 0.
- 통합 R은 M1·M2·M3 수정과 m1·m2의 근거 보완을 반영한다. **4건 진행 가능/2건 보류 후보**는 결과이지 전제가 아니며, 전체 루틴 멈춤 조건을 새로 확정할 명문 모순은 찾지 않았다.
