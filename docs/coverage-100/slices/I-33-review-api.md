# I-33 API 관점 독립 재수립

대상: `.backend-dev/lane-b/I-33-draft.md` 756줄. 브리프 86줄과 초안 전건, 고정 `a6a87e144116ebaa32c01df5a12a0fd2924427e7`의 배정 12 operation·연결 schema/parameter/PageMeta/Error/Conflict, DB 관측 원문 전건을 직접 읽었다. 다른 I-33 관점 보고서 읽기0. root 통지 기준 main `6bde921`, 공식352/487이며 I26 후보353은 공식 수가 아니다.

CREFLE `pr-review`·`coding-rules`와 checklist/severity/review-comment/TypeScript/commit-convention 전체를 적용했다. CLAUDE·coverage README(§2 전문)·lanes·lane-B·server-architecture·기존 구현 도메인 규칙을 읽었다. 기존 통합 계획의 I33/T, 이전 API S24·UIUX U36~38 권고는 현재 독립 리뷰와 구분해 선례로만 읽었다. 실제 소스/화면을 아래 실패 조건의 근거로 대조했다. 재측정 대신 root DB 원문을 재사용했고 DB/게이트 실행0이다.

## 다섯 축 판정

| 축 — 브리프 그대로 | verdict | 독립 판단 |
|---|---|---|
| ① 툴 사용 입력·시각·누계 | 채택 | A20 추가4/완화2, required 결손 오류, 제출 증분 보존, 같은 mold 잠금/version 증가, 발생시각·누계 기준시각 분리 모두 타당. 환산 보존의 근거 단계는 아래 Minor로 정리한다. |
| ② 검교정·차단·해소 | 채택 | 기본 PASS/ADJUSTED 합격 및 FAIL 비합격 연결을 채택한다. nonCAL 정상 등록·unknown CAL만 명시422·마스터 효과와 멱등 same tx·clear 행 잠금·새 상태표/error0을 지지한다. |
| ③ 수집 채널 5칸·NULL 유일 | 채택 | 구 필수3 완화, 별도 channelKey, nullable 조건 독립, 활성과 무관한 동일 네 축 유일이 계약을 따른다. NULL 비트와 COALESCE 조합은 실제 id0도 NULL과 구별한다. |
| ④ 관측의 실제 원천 | 수정 후 채택 | T 최근 projection·수집기0·원천 추정0·전체 필터 결과·무페이지를 지지한다. 다만 alreadyMapped의 등록 의미를 unmappedOnly에 그대로 반전 적용하는 부분은 Major다. |
| ⑤ 원자성·예산·배포 | 채택 | 실제 IdempotencyService tx 사용, replay 우선·actor/worker 지문, 10조각/µs 선행 분리, 환경별 legacy 검사를 지지한다. 스키마 적용과 운영 수집자 인수를 별개로 둔다. |

심각도: **Blocker0 / Major1 / Minor2 / Trivial0**. 아래 수정 전 계획 전체 무조건 승인으로 기록하지 않는다. 구현 PR 머지 판정/게이트 PASS를 수행한 보고서가 아니다.

## 1. 버그·정확성

### [Major] API-A1 — 등록 여부와 미매핑 필터는 같은 판정식이라는 근거가 없다

- 대상: `.backend-dev/lane-b/I-33-draft.md:464`·`:465`·`:567`·`:568`. alreadyMapped를 등록행 EXISTS로 내는 것은 현재 client의 선택 제어와 맞는다. 그러나 unmappedOnly=true를 그 EXISTS의 NOT으로 정하면 **등록됐지만 검사 항목이 없는 신호가 미매핑 조회에서 사라진다**.
- 원천: `contracts/equipment-05설비툴.json:2636`·`:2654`는 ‘연결 안 된 것만’; 같은 계약 CollectionChannel `:4801`의 inspectionItemName 설명은 검사 항목이 비면 미매핑이라고 정의한다. `.design-reference/omf-mes/design/wiki/screens/05/W-05-07-수집채널매핑관리.md:94`·`:100`·`:103`은 채널만 등록하고 검사 항목이 비어 있는 행을 미매핑으로 명시한다. PUT의 비활성 문언(`contracts/equipment-05설비툴.json:2537`)도 적용되지 않아 미매핑과 같다고 한다.
- 실제 소비자: `../omf-mes-client/apps/web/src/screens/collection-channel/observation.ts:15`·`:24`는 alreadyMapped로 **중복 등록 선택**을 막는다. `queries.ts:387` 이후는 unmappedOnly를 서버에 전달할 뿐 두 의미를 같게 계산하지 않는다. ‘이미 등록’ 주석은 alreadyMapped의 근거이지 ‘연결 안 됨’ 질의를 ‘등록 안 됨’으로 바꾸는 계약 권한이 아니다.
- 실패 예: T에 `(설비1, TEMP)`가 있고 채널에도 같은 설비/key가 있으나 inspection_item_id=NULL이다. true 요청이 현재 안대로면 items=[]가 된다. 매핑할 일이 남았는데 미매핑 조회에서 확인할 수 없다. inactive 연결행만 있는 경우도 같은 문제가 있다. 이미 등록된 행은 목록에 남겨 alreadyMapped=true로 선택만 막는 동작과 양립 가능하다.
- README §2: **0단계의 명시 미매핑 정의가 먼저**다. 1단계에서는 미등록/등록미연결/등록연결이 갈리는 특정 데이터 조건이며, 이를 ‘O6 전 호출 본길’로 뭉쳐⑤로 정하지 않는다. 등록 여부와 연결 여부의 분리는 새 상태 저장이 아니라 기존 칼럼 조회다.
- 권고: alreadyMapped=`EXISTS(동일 equipment/key 등록행)`는 유지하고, unmappedOnly는 독립 조건으로 만든다. 최소 공개 권고는 `NOT EXISTS(동일 equipment/key AND is_active AND inspection_item_id IS NOT NULL)`이다. 조건부 연결은 품목/공정 질의가 없으므로 ‘어떤 연결도 없는 신호’ 여부로만 평가하고 현재 생산의 적용 가능성은 도출하지 않는다. 혼합 조건행에서의 의미는 문의에 명시한다. 등록 여부를 필터 뜻으로 채택하려면 위 계약 용어와 다른 이유/근거를 root R에 명시해야 하며 client 주석만 인용해 확정하지 않는다.
- 영향: Q4의 SQL 조건/테스트만 수정, T/A21 스키마 및 op 수/PR 수 증가0. `E-O02`의 등록 flag 테스트는 유지하고 `E-O03`에 `등록됐지만 미연결이면 미매핑 조회에도 남고 alreadyMapped는 true다`, `비활성 연결만 있으면 미매핑이다`, `활성 연결 존재와 다른 조건의 빈 행이 공존할 때 판정이 고정된다`를 추가한다. 기존 E-O03 이름만으로는 이 오류를 잡지 못한다.

### 기본 검교정 결과 — 채택의 근거와 한계

`docs/coverage-100/plan-api.md:629`에는 이미 **등재값 검사만, 유형별 부분집합 검사0** 권고가 있다. `contracts/equipment-05설비툴.json:2822`의 POST 설명은 CALIBRATION 합격계열의 두 마스터 날짜 갱신과 불합격 무갱신을 직접 요구한다. seed의 기본3 의미는 root DB 원문에도 PASS=적합, ADJUSTED=조정 후 적합, FAIL=부적합으로 남아 있고 W-05-10 §5-2/3과 대응한다. 따라서 이 세 코드의 고정 의미 연결을 승인할 근거가 있다. metadata가 없다는 이유로 기본 CAL까지 전부 거부하거나 성공 이력만 쓰면 이 명시 효과를 빠뜨린다.

고정 상수는 읽은 기본 정의를 코드로 옮기는 것이며 runtime label/번역/정렬순서 추론과 다르다. 이후 고객이 PASS의 이름만 바꿔도 효과를 재분류하지 않는다. 확장 CAL result는 의미 원천이 없으므로 `422 STATE_LOCKED`와 쓰기0이 타당하다(가장자리, 최초①·명시 표현②). 비CAL 확장 결과는 기존 등재검사 선례대로 정상201이며 유형별 seed를 새로 발명하지 않는다. `E-C04~07` 유지, `기본 코드 label 변경이 master 효과를 바꾸지 않는다`를 보완 권고한다.

합격 nextDueOn의 생략/null→master null 및 과거 performedOn의 치환도 literal 값의 반영이다. 주기 보정/MAX/현재값 유지 근거는 없다. `E-C09`를 유지한다. ADJUSTED의 master preview 차이는 `form-draft.ts:74`의 실제 소비자 인계이며 서버의 합격 효과 생략으로 맞출 사안이 아니다.

### 원천 T·최신 Rev·유일 제약 — 채택 범위

T 신설은 `plan.md:20`·`:137`, `plan-uiux.md:603`의 기존 명시 권고다. “수집기는 만들지 않는다”도 기존 권고에 있다. 계약의 lastValue와 최근수신 목적에 맞게 설비/key별 최신 projection으로 구체화하는 안은 단일 값을 지어내는 stub가 아니며 채택 가능하다. 구 FK 관측과 JSON payload에서 임의 추출0, lastValue/observedAt 같은 행, µs 보존을 유지한다. writer의 역순 도착/tie 처리는 향후 수집자가 인수해야 하고 이번 API 완료로 인수 완료를 뜻하지 않는다.

O6에는 page/size 입력이 없고 응답 page는 optional이다. `items+totalCount` 전체 필터 결과 및 page 생략을 채택한다. 임의 기간/건수 컷오프를 정할 근거는 없다. 무설비 요청의 동명 key 둘을 합치지 않는 것도 계약 literal이며 장치식별 응답 확장은 문의에만 둔다. **API-A1은 이 T·페이지 채택을 뒤집지 않는다.**

최신 Rev는 같은 plan의 MAX(plan_version), 상태무관을 채택한다. 계약 `:4846` 부근은 서버 판정을 명시 위임하며 ‘최신 확정’이 아니다. 실제 `inspection-plan-version.service.ts:116`·`:301`의 상태무관 내림차순 및 max+1 DRAFT와 이어진다. 생산 적용 가능성과 최신 번호 경고를 혼동하지 않는 조건이다. E-G11에서 다른 plan의 큰 Rev·새 DRAFT·null 연결을 유지한다.

NULL 네 축 unique, inactive 점유 유지, 구 code unique 보존 모두 지지한다. 등록 조건 전체/null 행과 지정행의 공존은 계약이 허용한 서로 다른 네 축이다. 소비 시 적용 우선순위는 이 CRUD가 발명하지 않는다. 부분 index P2002 번역은 실제 adapter 결과를 확인해 로컬 처리하고 멱등 unique를 삼키지 않는 초안의 검증 책임을 유지한다.

## 2. 보안·원자성·배포

새 보안 finding0. O3의 사번은 귀속이며 인증과 구분한다. 403 선언 네 쓰기·공통 인증·O12 별도 권한 미추가, 헤더를 지문에 반영하되 성공 replay에 worker 재조회를 앞세우지 않는 경계를 지지한다. CORS/POP 미인수는 초안에 이미 정확히 남아 있다.

`IdempotencyService.run()`의 callback tx와 response 저장을 그대로 사용해야 한다(`src/common/idempotency/idempotency.service.ts:64`). mold 가산/row lock/version 증가·cal master 치환·clear 한 이력만 해소·channel CAS와 최종 mapper 모두 같은 업무 tx 안이다. clear에 새 version/ETag를 붙일 필요가 없다. 일반409 ConflictResponse, 비차단400 STATE_LOCKED·이미해소409 및 선언누락 문의를 지지한다. error code 신설0.

required/nullable/optional 전필드 정책을 채택한다. 과거 required를 기본값으로 채우거나 필터로 숨기지 않고 500 및 환경별 배포검사로 남긴다. GET ToolUsage의 cumulative pair는 optional이라 이력 snapshot을 지어내는 대신 생략한다. root의0행 관측이 구 writer/타환경 안전성을 증명하지 않는다.

MDM 참조목록과 quality 삭제 보호도 계획에 이미 포함됐다. `inspection-plan-version.service.ts:457`은 measurement만 검사하고 새 FK는 item_spec를 직접 참조하므로 항목 삭제 보호가 접점이다. version 직접 FK 목록을 새로 만드는 것은 틀리다. equipment/process 참조목록 보강, item의 ERP잠금/referenceCount=null 보존을 지지한다. 소유자 코드 직접 수정0.

## 3. 테스트·계획 단계 기록

### [Minor] API-A2 — 제출 shotCount 보존은 명시 입력 권한을 먼저 인용한다

대상 `.backend-dev/lane-b/I-33-draft.md:384`·`:597`의 ‘최초④’ 기록. P-05-01 §5-2(`:138` 부근)는 **정하는 것은 화면(증분), 반영하는 것은 서버(누적)**라고 명시하고 ToolUsageCreate는 shotCount를 required로 받는다. 환산식·snapshot은 W-05-01 §3-2/5-5에 있으며 서버가 다시 계산하거나 곱과 정확히 같은지만 받으라는 계약은 없다. 따라서 제출 정수와 환산 근거를 그대로 저장하는 결과를 채택하되 **0단계의 입력 권한이 첫 근거**, 반올림 방식 자체만 미정으로 기록한다. 실패 예는 base1×ratio0.6, 제출 shot1을 서버가0 또는400으로 바꾸는 경우다. 임시 Math.round를 서버 정본으로 승격0. W1/PR 수 변경0, E-T07과 `환산 근거 곱의 반올림으로 제출 타발수를 바꾸지 않는다` 유지. 현재 정책 재조회·cavity 재곱0.

## 4. 컨벤션·문서

### [Minor] API-A3 — 옛 재수립 세 조건 문구 정정

대상 `.backend-dev/lane-b/I-33-draft.md:18`. README §1-2는 2026-09-07부터 기본 재수립이며 §0 다섯 축을 그대로 리뷰하도록 바뀌었다. 세 조건 때문에 재수립한다는 근거문은 정본과 어긋난다. ‘기본 재수립, 위 다섯 축을 판정’으로 바꾼다. 실질 설계 finding과 분리하며 §2 미정판정 대상 아님, PR 분할/op/단언 변화0.

## 인계·완료

API 권고는 기본 CAL3·제출 정수 보존·T/무페이지·최신 Rev·NULL 유일·tx/과거 required를 채택하고, **unmappedOnly와 등록 flag 혼용만 실질 수정**한다. root가 R표 및 문의113~119 중복 배정을 소유한다. M1/M2/M3+Q1~Q4+W1~W3, µs P0t150 선행 후보는 유지한다. API-A1은 Q4 내부 변경으로 해결되며 전체 op 유보 사유가 아니다.

미수행: 코드/DDL/DB 쓰기·E2E·게이트·git/gh 쓰기·외부 댓글/문의번호·추가 에이전트 모두0. 수행하지 않은 검증을 PASS로 기록하지 않았다. DB의54개 시점 원문을 이후55개 통지로 소급하지 않았다. 수정은 이 보고서 한 파일뿐이다. **완료와 함께 `.backend-dev/lane-b/I-33-review-api.md` 파일 소유를 root에 반환한다.**
