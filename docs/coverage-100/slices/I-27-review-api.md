# I-27 독립 계획 리뷰 — API

검토 범위: `brief-I-27-review.md`·`I-27-draft.md`·`I-27-db-observed.md` 전문, 저장소 지정 규칙, 고정 계약/설계와 현재 소스. 다른 관점 보고서 열람0. DB 관측은 root 제공값만 사용했다. **B 0 / Major 3 / Minor 2**. 아래는 R 후보이며 최종 판정은 root 소유다.

사용 스킬: `crefle-agent-skills:coding-rules`와 TypeScript/commit-convention 참조, `engineering:documentation`. 오류를 명시하고, 계약 문자·소스 사실·미정 제안을 구분해 기록한다. 계약 갱신·원천 수정·DB·테스트·gate 실행0.

약어: C=`contracts/app-공통.json`, D=`.design-reference/omf-mes/design/wiki`, REQ=`D/api-contracts/06-API-요구서-app공통출력물.md`, 초안=`.backend-dev/lane-b/I-27-draft.md`. 아래 경로:줄은 실제 읽은 위치다.

## 주요 판정

| 등급 | 발견·영향 | 수정 제안 / 최초 단계 |
|---|---|---|
| Major A1 | **summary의 정상 CSV가 handler 이전에 거부된다.** C:1534는 array, :1546은 form/explode=false다. `src/common/contract/contract-validation.guard.ts:36`은 원문 query를 전역 가드에서 검증하고 :41에서400을 던진다. `contract-validator.ts:19`의 Parameter와 :118의 schema 조립에는 style/explode 처리가 없으며 :200은 coerceTypes=true뿐이다. `src/app.setup.ts:10`, `src/app.module.ts:26`에도 CSV 전처리 경로가 없다. 초안:383의 CSV 테스트명만으로 해결되지 않으며 controller/pipe의 split은 늦다. | **0단계 계약의 확정 본길.** P2 앞에 실제 HTTP query를 guard 전에 정규화하는 자리를 명시. 권장 최소안은 I-27 summary 경로만 처리하는 app 도메인 middleware와 자기 module 등록. 공용 serializer 수정안이면 root가 공유 소유/별도 예산을 먼저 확정. `targetIds=2,1,2`와 단건을 실제 AppModule에서 검증한다. 실행 재현 없이 소스 정적으로 확인한 결손이다. |
| Major A2 | **특정 종류 결손 때문에 POST 전체를 계속 유보하면 확정된 정상가지를 놓친다.** 초안:33·140은 전체 조건부이나 REQ:190·191은 TOOL_LABEL→툴/금형, LOCATION_LABEL→위치다. `D/screens/06/W-06-07-창고Location마스터.md:110`·:113은 다중 선택 POST와 기록 범위를 명시한다. `D/decisions-policy/공유계약.md:2297`·:2304·:2327은 can_print_label의 생산/품질 단말 범위와 창고 공정행0의 정상성을 명시한다. 단말매핑 공백은 관리웹 Location 기록을 막는 근거가 아니다. | **0단계 확정 선례 + 1단계 종류별 가름.** 최소 `LOCATION_LABEL+LOCATION`의 계정 정상 요청을 R 허용집합 후보로 삼고 A9 뒤 POST를 연다. unresolved 짝·품질 자격은 개별 입력422 INVALID(가장자리 최초2-②)로 명시한다. TOOL_LABEL은 A3 해결 뒤 포함. 생산/창고·개체/납품까지 자동 확대하지 않는다. |
| Major A3 | **TOOL_LABEL 발행측 부모잠금만으로 기존 코드변경 규칙을 보장하지 못한다.** 초안:155가 구현 때 확인으로 넘긴 자리다. `src/mdm/mold/mold.service.ts:186`은 get→label count를 읽고 :192에서 허용한 뒤, :196에서 별도 updateMany를 한다. count 원천은 :293. 따라서 코드변경 요청이 count0을 읽고 대기하는 사이 발행이 잠금·INSERT·commit하면, 이어지는 코드변경은 같은 version 조건으로 성공할 수 있다. | **0단계 기존 불변식, 가장자리 경합.** R에서 TOOL_LABEL 허용 전 writer도 같은 tx에서 부모잠금 후 count 재확인하는 선행 수정/소유/PR을 확정해야 한다. 코드변경을 덮어쓰거나 문서발행으로 version을 임의 증가시키는 안은 채택하지 않는다. 선행 범위가 승인되지 않으면 MOLD 가지만 조건부로 남기고 LOCATION은 진행한다. |
| Minor A4 | **DocumentIssue의 required 결과 결손을 summary에 전파할 필요가 없다.** 초안:398의 P2는 P0 뒤다. C:4747의 summary required는 targetTypeCode/targetId/issueCount뿐이고 :4798의 lastPrintOutcome은 선택·nullable이다. 과거 미확인 결과도 null로 표현하면서 count와 마지막 회차는 정직하게 반환 가능하다. | A9 뒤 P2 순서를 유지해도 오류는 아니지만, A9 적용 후 과거 NULL 때문에 summary까지 hold하지 않도록 분리. A9 이전 구현까지 당기면 선택 lastPrintOutcome 생략과 후속 실제값 연결을 별도 R로 명시한다. 상세/list/report의 required printOutcome은 기존 hold 유지. |
| Minor A5 | **int64 식별자 정밀도 처리 범위가 계획에 없다.** `contract-validator.ts:17`·:56은 int64를 무연산 format으로 등록하고 :200은 query/path를 JS number로 강제 변환한다. 응답/중복키/잠금정렬을 Number로 만들면 안전정수 밖 ID가 합쳐질 수 있다. 초안의 bigint 지문 처리는 terminalId 한 자리만 명시했다(:169). | 새 로컬 경계에서 안전정수 밖 입력의 명시 거부 및 응답 정책을 R에 남긴다(가장자리 최초2-②). 계약 int64 전체 지원 여부는 공용 한계 문의로 분리하며 문자열 응답으로 임의 계약 변경0. 큰 ID 테스트를 필수 목록에 추가한다. |

## 다섯 축 — 브리프 원문과 API 판정

### 1. 아홉 documentType과 일곱 targetType의 정확한 짝·발행 자격·LOT 일치/파생.

불량분 거부422, 기존판정/품목조건 선례와 target별 FK를 대조한다. 조용한 품질추론 금지.
summary는 요청 targetIds 전건(미발행 issueCount0 포함), 중복입력과 순서·미존재대상을 판정한다.

- 짝: MATERIAL_LOT_LABEL→LOT, GOODS_ISSUE_QR→GOODS_ISSUE_LINE(화면 HU 추가가지는 별도 R), PRODUCTION_LOT_LABEL→LOT, IDENTIFICATION_TAG→SERIAL_NUMBER, PACKING_LABEL→HANDLING_UNIT, DELIVERY_LABEL→현 enum 대응 없음, CERTIFICATE_OF_ANALYSIS→INSPECTION_RESULT, TOOL_LABEL→MOLD, LOCATION_LABEL→LOCATION. REQ:182의 표와 C:4528의 enum7이 근거다. GOODS_ISSUE_QR/HU·PACKING_LABEL/LOT의 문서 충돌은 초안의 열린 자리로 유지한다.
- 자격: 미완료 생산 LOT·개체별 불량·OQC 합격을 서로 대체하지 않는다. C:1237의 불량분422는 범용 정상코드 추측 권한이 아니다. LOT/FK 원천·HU lotId=null·요청 불일치422 PAIR 제안은 유지. 단말/품질 결손이 없는 master 정상가지는 A2처럼 분리한다. CoA 양식 유보는 REQ:28의 “남은 것은 양식”과 기록 API 자격을 구분해 R 판정한다.
- summary: C:1509·1581의 미발행 포함/요청전건에 따라 `[2,1,2]` 순서·중복 multiplicity 유지, 미존재 대상도 이력 없으면0, 삭제 대상의 기존 이력은 보존한다. 이 API가 대상 존재 증명을 하지 않는다는 초안 해석에 동의한다. max(seq)와 count를 구분하고 마지막 시각/회차/결과를 동일 행에서 읽는다. **정상 HTTP 입력 경계는 A1, 결과 nullable 범위는 A4를 반영해야 한다.**

### 2. 회차는 documentType+targetType+targetId 축. N<=1000 전량원자성·동일대상병렬첫발행·재발행잠금,

서로다른대상순서의 데드락 방지, 중복targets, 입력순서응답보존. 사유는 한번받지만 seq>=2행에만
저장하고 신규에는 null이다. REISSUE_REASON 그룹·값 실제검사, 계약example오염값 재사용금지.

- C:4526의 한 tx/전건 실패와 :4574의 혼합 사유 규칙, `D/decisions-policy/공유계약.md:3784`의 축을 따른 초안 설계에 동의한다. 빈 로그에서 MAX행 잠금으로는 첫발행을 직렬화할 수 없으므로 존재 부모잠금→새 문장 MAX+1→배치 INSERT→ordinal 응답 재조립을 유지한다. 원본 순서가 지문/응답에 남아야 한다.
- 중복targets는 가장자리2-② 422 INVALID, 중복 summary는 0단계 요청전건으로 유지하는 서로 다른 정책이 맞다. `[A,B]`/`[B,A]` 잠금순서는 통일하고 응답순서만 다르게 한다. MOLD writer는 A3로 확정 전까지 정상잠금 보장에 포함하지 않는다. HU/품질 writer 전수잠금 규약은 미확인이다.
- `I-27-db-observed.md:123`의 REISSUE_REASON 실제5값을 받아들이되 고객추가값을 허용하는 DB 그룹조회가 정본이다. C:4594의 PRINT_FAILED 오염값 금지 유지. 활성 그룹과 활성 값 검사는 같은 tx에서 하며 공용 `code-reference.ts:33`은 그룹활성/유효일을 검사하지 않고 :51은400이므로 그대로 호출해422라고 주장할 수 없다. 초안의 로컬 검사 계획을 구체화한다. 유효기간 경계의 사용 정책은 별도 R/테스트에 적는다.

### 3. 기록과실물 분리. POST는 PENDING 발행기록만, print-report는 SUCCEEDED/FAILED와실패사유필수,

이미보고된건422. 인쇄실패는 기존기록삭제/되돌림이 아니라 새 회차. 동일키는 같은응답.
A9는 print outcome/reported at/failure reason 외 사번귀속 칸도 검토한다.
issued_by는 app_userFK이고 POST WorkerNoOptional/report-print WorkerNoRequired다.

- C:1400·1434·4635의 확정 규칙대로 report는 PENDING만 전이, 새 키 재보고422 STATE_LOCKED, 같은 키 저장응답 재생을 유지한다. FAILED 사유 공백/누락422 REQUIRED. SUCCEEDED에 비공백 사유를 주는 경우만 가장자리2-② INVALID 제안이며 성공에 사유를 저장하거나 조용히 버리지 않는다.
- A9의 결과3+귀속3 nullable 추가, 최초 issued_by/issued_worker와 보고 actor/worker 분리는 C:3576·3588과 현재 계정FK를 동시에 보존한다. 계정 없는 worker.app_user_id로 issued_by를 만들지 않는다. 결과보고시각은 서버 접수시각이며 요청에 없는 물리인쇄시각을 지어내지 않는다.
- required `DocumentIssue.printOutcome`은 C:4367·4483이 정하므로 구행 NULL을 PENDING으로 일괄 복구하는 안에 반대한다. 개발DB 로그0(`I-27-db-observed.md:102`)은 운영0 근거가 아니다. 다만 summary는 A4처럼 별도 계약이다. SQL CHECK의 실 DB 수용성과 구행 배포검사는 미실행이다.

### 4. 프린터 목록의단말귀속·상태 원천. 물리 app.printer는 plant/code/name/type/URI/DPI/active뿐,

계약은 terminalId기준·displayName/status/isDefault required·지원documentType목록을 요구한다.
A10 5칸 외 terminal프린터매핑/관측producer를 점검하고 active를READY라고 추측하지 않는다.
외부장치poll/프린터실행은 금지. DB에확정저장된상태만읽을수있는지 본길/가장자리 판정.

- **1단계 본길 유보 제안에 동의.** C:1455·1464의 단말사용가능 목록과 C:4664의 required4를 A10 칸만으로 채울 수 없다. REQ:258·260은 원천/단말 매핑 미정 자체를 명시한다. root DB 관측:96도 printer 관련표가 app.printer뿐임을 보인다. 관측없는 active=READY/OFFLINE, 첫행 기본프린터, 동일plant=사용가능을 도출하지 않는다.
- nullable A10의 추가 자체가 producer를 정하지 않는다. 외부 poll 없이 단말매핑·명시 기본/지원설정·상태 관측의 저장 원천이 확정될 때 재개한다. 계약은200만 있으므로 없는 단말404/무매핑422 같은 새 응답도 임의 추가하지 않는다. 프린터 GET 유보는 자유텍스트 printerName을 받는 기록 POST 전체 유보 근거가 아니다(REQ:258).

### 5. 헤더/권한/공용파일/예산. 발행은 멱등+사번선택, 결과보고는 멱등+사번필수, 명시IfMatch0.

발행만403선언이므로 report-print/GET에기능권한등록추가금지. app-domain자기등록만.
멱등callback의동일tx에 업무와응답저장, actor/terminal 귀속을지문에반영할근거확인.
일반PR예산350/상한400, 코어200. 기존파일실측으로발행조회·summary·마이그·쓰기분할.

- 헤더 표/IfMatch0·ETag0·report/GET 기능권한 추가0에 동의한다. `permission.guard.ts:40`은403 선언 여부, :56은 계정 session.permissions만 본다. **이 가드는 can_print_label의 대체 구현이 아니다.** F-1의 적용범위는 A2 근거로 문서별 분리하고, 관리웹 정상발행은 사번/단말이 없어도 계약상 허용한다. P-04-04 권한 보강은 허용집합 결정 뒤 root가 자기 operation만 정한다.
- `idempotency.service.ts:60`·:77·:79·:111`은 replay 우선, 전달tx 업무+응답저장, fingerprint만 비교를 확인시킨다. `notification-write-context.ts:17`의 계정 포함 선례에 actor/worker/terminal을 확장하는 초안안 유지. 실제path/원본targets순서·bigint 문자열 처리 필수. 업무 자격/사유/worker 존재 재검사는 callback에 두어 완료 replay를 막지 않는다. 인증/토큰 검증은 재생보다 선행하며 만료·회전 token replay 제한은 그 인증 경계로 문서화한다.
- 2PR 폐기·조회/summary/A9/report/조건부 쓰기 분리에 동의한다. **P2는 CSV 전처리와 실제 app 배선을 예산에 추가**, TOOL_LABEL은 A3 writer 수정 별도 조각이 필요하다. 기존 파일 규모는 초안 실측 부록을 재사용하고 신규diff 실측으로 표기하지 않는다. core를 새로 만들 필요는 없고, 새 core가 필요해지면 PR전체200 재분할이다.

## root R 후보·필수 검증·분할 인계

| R 후보 | 필수 검증 이름 | 영향 PR |
|---|---|---|
| API-R1 summary 정상 CSV의 guard 이전 정규화 위치 | 실제 AppModule `targetIds=2,1,2`→200/3행, 단건→200, 빈값/빈token/1001개→400, 정적 `/summary`가 `/:id`에 잡히지 않음 | P2에 로컬middleware/등록예산 또는 별도 공유 준비 PR |
| API-R2 정확한 부분 허용집합 + F-1 범위 | 계정 LOCATION 최초201·사번생략·PENDING·lotId null, 재발행사유필수, 미존재/잘못된짝422, 단말없는 관리웹이 출력gate로 막히지 않음 | C1/C2를 전체유보에서 최소 정상쓰기 후보로; P0/P1 선행 |
| API-R3 MOLD 코드변경 writer 선행 | count0 읽은 코드변경과 최초발행을 barrier로 경합; 어느 순서든 발행 뒤 코드변경이 조용히 성공하지 않음 | MOLD 서비스 선행 조각/R 소유확정 후 C1/C2 허용확장 |
| API-R4 결과 NULL의 응답별 범위 | 구행NULL 상세 배포hold, 같은 구행 summary count/lastSeq 보존+lastOutcome null, 미발행 count0+lastSeq null | P2 배포조건 분리; P0/list/report hold 유지 |
| API-R5 정확한 ID·귀속·재생 경계 | unsafe ID 명시거부, actor/worker/terminal/path/순서 변경 같은키409, reason 비활성화/worker 변경 뒤 원요청 완료응답 재생, 응답저장실패시 업무0 | 로컬 context/쓰기/summary 예산; 공용 정밀도 한계 문의 |

기존 필수검증도 유지: N1000 전량성공·N중1실패 rollback, 같은대상 두키 최초/재발행 경합, 역순 배치, 신규+재발행 혼합사유 신규null, 고객추가 REISSUE_REASON/타그룹/그룹중지/값중지, report FAILED 필수사유/승자1/같은키200, 실제 µs 날짜경계와 동일 마지막행, 모듈 양쪽 레인등록 보존. 이번에는 이름과 원천을 검토했으며 실행 PASS 주장은 없다.

미실행·미확인: DB접속/추가SELECT/DDL/gates/E2E/렌더러/장치0. 실제 client 소스는 이 관점에서 읽지 않았다. HU·품질 전체 writer 잠금과 운영 구행/프린터 producer, int64 전체 시스템 정책은 미확인이다. 계약·설계 사본 갱신0, git/gh쓰기0, 새agent0, 다른리뷰 열람0. 변경 파일은 이 보고서 하나다.

**작성 완료·소유 반환:** `.backend-dev/lane-b/I-27-review-api.md`를 root에 반환한다. R표/정본문서 수정은 하지 않았다.
