# I-30 독립 계획 리뷰 — API

| # | §0의 검토할 판정 그대로 | 판정 | API 결론 |
|---|---|---|---|
| 1 | 원인코드 본길 — `:complete` 유보가 맞는가 | **유보 유지** | O9 성공의 필수 원천·선택 경로가 미정이다. O7 비null만 가장자리 400 INVALID로 거부하고 메모·null 해제는 진행한다. |
| 2 | A15 3칸을 넘어선 실제 저장 결손과 과거 행 | **수정** | 8칸 추가·2칸 완화와 귀속 분리는 유지. 과거 행 검사를 NULL뿐 아니라 계약 enum까지 확대하고 조회 활성화·배포 조건으로 명시한다. |
| 3 | 조회가 I-11·I-31·I-32와 이어지는 실제 축 | **유지** | 조건부 기간·최신 정렬·다형 연결·상세 집계는 타당하다. 복수 연결/소수 분의 null은 문의를 남기는 가장자리 선택으로 유지한다. |
| 4 | 트랜잭션·상태·오류·귀속의 경계 | **수정** | run의 tx 직접 사용 유지. 주체 없는 지문·재생 전 사번 검증 누락·ETag 의미·start 상태 422 후보를 고친다. 인증/CORS 한계는 공용 책임으로 분리한다. |
| 5 | 채번·알림·PR 크기 | **유지 + 예산 재확인** | EQI/MLF 등록·알림 의사만 저장·7+조건부1 분할 유지. 추가 검증분을 구현 diff에 포함하고 기존 예산으로 무조건 수용된다고 확정하지 않는다. |

계획 I-30.md 673줄·B 브리프·README/lanes/lane-B/CLAUDE를 전체 읽었다. 다른 관점 리뷰는 읽지 않았다.
`engineering:documentation`의 독자 우선·근거 연결 원칙으로 작성했다. 실측 부록 값을 뒤집지 않았으며 DB 재측정·코드/계약/git 변경·게이트 실행은 없다.

## 계약 전건 대조

배정 정본 `docs/coverage-100/assignment.tsv:210`의 6 path·9 operation을 직접 읽었다. 아래 위치는 `contracts/equipment-05설비툴.json`이다.

| operation | 계약 위치 | 확인한 경계 |
|---|---|---|
| O1 GET inspections | :22 | 질의 9개, 기간 조건, sort enum/default, items required·PageMeta·totalCount |
| O2 GET inspection 상세 | :232 | int64 path, 200 Inspection·404, 버전 ETag 선언 없음 |
| O3 POST inspections | :164 | 멱등·사번, 필수 본문, 201·400·403·422 |
| O4 GET breakdowns | :275 | 질의 9개, 기본 미처리·경과일, openOnly와 미발행은 별개 |
| O5 GET breakdown 상세 | :475 | 200 Breakdown·404, ETag=해당 고장 version_no |
| O6 POST breakdowns | :407 | 멱등·사번, 201·400·403·422, notifyAssignee 기본 true |
| O7 PUT breakdown | :526 | 멱등·If-Match, 선택 nullable 2필드, 200·400·403·404·409·422 |
| O8 POST start-handling | :723 | 본문 없음, 멱등·If-Match, 200·403·404·409·422 및 :790의 상태 잠금 400 문언 |
| O9 POST complete | :802 | 원인·메모 필수, 멱등·If-Match, 200·400·403·404·409·422, W/O·비가동 무효과 |

연결 스키마/헤더 전부: 같은 파일 :2974(IdempotencyKey), :2985(IfMatchVersion), :3004(WorkerNo), :3018(ErrorItem/ErrorResponse), :3072(InspectionLine/Create), :3163(Inspection/Create), :3278(Attachment/Handling/Breakdown/Create/Update/Complete), :4236(PageMeta), :5280(ConflictResponse).
참조 축은 `contracts/mdm-기준정보.json:11113`, :20962, :21268, :21455의 effective→equipmentInspectionItemId와 :6729, :18645의 **quality** 원인 마스터까지 대조했다. 오류 409는 `{conflictCause,message}`이며 production 전용 code를 추가하지 않는다.
원인 판정의 0단계 근거는 `contracts/equipment-05설비툴.json:3315`, :3507, :3525의 mdm.cause_code 지정·공통코드 금지와 `.design-reference/omf-mes/design/wiki/screens/05/W-05-04-설비고장상세처리.md:111`의 품질 원인 사용 금지다. 마스터 부재 실측은 계획 :619를 수용한다.
O9는 모든 성공에 원인이 필요한 본길이므로 선택 목록·원천 정의가 정해질 때까지 유보한다. O7 비null은 특정 입력만 영향을 받으므로 가장자리②로 거부한다. 두 자원을 임의로 동일시하지 않으면 서로 다른 계약을 반드시 위반하게 되는 모순으로 확정할 근거는 없다.

## 놓친 결함·보완 사항

### A1 · Major — 멱등 재생이 주체를 구별하지 않고 필수 사번 검사를 우회한다

근거: `docs/coverage-100/slices/I-30.md:308`, :334, :347; `src/common/idempotency/idempotency.service.ts:60`, :111은 key·fingerprint만 비교하고 app_user_id를 재생 경계로 사용하지 않는다. WorkerNo는 계약 :3007, :3012에서 필수다.
왜: 첫 성공 뒤 같은 method/path/body/key를 다른 계정·사번으로 보내면 이전 주체의 응답을 받는다. 사번을 아예 빼도 콜백 안 검증을 지나치므로 필수 헤더 계약을 위반한다. 기존 행을 덮지 않는다는 것만으로 귀속·응답 격리가 성립하지 않는다.
수정: I-30 호출부에서 실제 자원 path와 `{body, actorUserId, workerNo}`를 기존 requestFingerprint에 넣는다. 세션 ID가 아닌 계정 ID를 쓰고 O7~O9는 계정 귀속, O3/O6는 계정+원문 사번을 포함한다. 사번 필수·공백·50자 검사는 run **전**, 존재 검사는 신규 업무 tx 안에 둔다. 다른 주체는 기존 409 user로 거부한다.
If-Match의 현재 버전 대조를 재생보다 앞으로 끌어올리지 않는다. 같은 주체의 동일 요청은 최초 결과를 재생한다. I-30 쓰기에는 계약 질의가 없으므로 I-28의 query 보강 필요성과 구분해 기록한다. 공용 서비스 변경은 없다.

### A2 · Major — 버전 ETag 미선언과 HTTP ETag 부재는 다르다

근거: `docs/coverage-100/slices/I-30.md:241`, :457, :506; `src/app.setup.ts:10`은 자동 ETag를 끄지 않는다. 설치된 `node_modules/.pnpm/express@5.2.1_supports-color@10.2.2/node_modules/express/lib/application.js:95`, `response.js:169`가 약한 ETag를 생성한다. `test/production-production-result.e2e-spec.ts:177`은 이미 이 차이를 검증한다.
왜: E-I08의 헤더 자체 없음 단언은 기존 앱에서 실패한다. 생성/PUT/start의 약한 해시를 다음 If-Match로 쓰면 버전 파서가 거부한다. 새 고장과 성공한 쓰기 응답에도 다음 수정용 버전이 없다.
수정: 문서·테스트를 “명시적 버전 ETag를 싣지 않음/본문 versionNo 없음”으로 고친다. O5만 버전 토큰을 설정하고, 생성→첫 PUT·PUT→start·재생→새 작업은 상세 GET으로 토큰을 다시 받는다. 전역 ETag 설정 변경으로 해결하지 않는다.

### A3 · Major — start 상태 잠금의 422 후보는 더 구체적인 계약 문언을 거스른다

근거: `contracts/equipment-05설비툴.json:790`은 상태 잠김을 **400**이라고 명시한다. :779의 422는 포괄 업무 규칙일 뿐이다. `docs/coverage-100/slices/I-30.md:330`, :497은 422로 계획했다.
수정: README §2 **0단계 계약 문언**에 따라 상태 잠금은 400 ErrorResponse/STATE_LOCKED로 통일한다. 400 응답 항목 누락은 문의로 남긴다. 필수 헤더/잘못된 path의 공용 400, 생성 O3/O6의 멱등 409 미선언도 별도 누락으로 기록한다.
응답표 미등재를 “그 상태를 절대 내지 말라”로 읽지 않는다. 미선언 오류를 내고 알린 기존 선례는 `docs/coverage-100/plan.md:207`이다. 따라서 어느 쪽도 구현할 수 없는 계약 간 모순으로 전체 루틴을 중단할 사유는 아니다. 409에는 업무 잠금을 섞지 않는다.

### A4 · Major — 과거 행의 NULL 검사만으로 정상 응답을 보장하지 못한다

근거: `docs/coverage-100/slices/I-30.md:147`, :206은 필수값 NULL에 집중하지만, `contracts/equipment-05설비툴.json:3096`, :3196은 라인·헤더 판정을 PASS/FAIL enum으로 한정한다. `prisma/schema.prisma:4174`, :4198은 문자열 저장칸이다.
왜: 모든 칸이 있어도 과거 OK/NG/미등록 문자열이면 성공 응답의 계약 검증이 실패한다. 현재 B DB 0행은 운영·이전 작성 경로의 적합성을 증명하지 않는다.
수정: 헤더·라인 enum 및 필수값을 포함한 사전 조회를 **PR① 활성화 전부터** 배포 조건으로 둔다. 결손 행을 숨기거나 조용히 바꾸지 않고 기존 INTERNAL_ERROR 실패를 유지한다. 이 실패는 정상 200 지원으로 세지 않는다. 구 작성자가 결손 행을 다시 만들 수 있는지도 배포 담당이 확인한다.
고장 PUT/start가 갱신 뒤 뷰 불변식에서 실패하면 상태·감사·version·멱등 모두 롤백되어야 한다. 과거 데이터 보완 주체/계약 답이 없으면 해당 환경의 정상 서비스 배포만 유보하고 새 데이터용 구현은 진행한다.

### A5 · Major — 측정값 그대로 저장한다는 약속에 정밀도 경계가 빠졌다

근거: `contracts/equipment-05설비툴.json:3142`의 measuredValue는 제한 없는 number/double이고 `prisma/schema.prisma:4195`의 numeric_value는 Decimal(20,6)이다. `docs/coverage-100/slices/I-30.md:350`은 입력 그대로 저장한다고 한다.
왜: 0.0000001은 0으로 반올림되어 측정 근거가 바뀌고 큰 값은 DB 범위 오류가 된다. 받은 PASS/FAIL을 유지하면서 측정치만 바뀌면 두 값의 근거가 갈린다.
수정: 특정 입력의 가장자리→② 명시 거부로, nullable은 유지하되 Decimal(20,6)에 무손실 저장할 수 없는 값에 기존 400 RANGE/`lines[i].measuredValue`를 낸다. 무조건 소수 자릿수 문자열 길이를 세지 말고 Decimal 값 기준으로 판정한다. 새 계약 제한·컬럼 변경·error code는 만들지 않는다.

### A6 · 보완 — 계정 연결 없는 작업자와 인증 세션 없는 요청을 구분한다

근거: `src/auth/authentication.guard.ts:16`, :42는 요청 세션을 요구한다. `docs/coverage-100/slices/I-30.md:133`, :362의 “세션 없으면 null”은 현재 HTTP 경로에서는 도달하지 못한다. 기존 문의는 `docs/design-inquiries/054-단말-토큰을-정의만-하고-어디에도-걸지-않아-인증-축이-화면과-서버에서-갈렸다.md:17`이다.
수정: E-I12/E-B11은 **유효 요청 세션 + worker.app_user_id=NULL + 별도 사번**으로 명확히 하며 201을 유지한다. 세션 없는/만료된 오프라인 재전송은 현재 401이고, 단말 인증 완성은 공용 인증 담당의 별도 작업이다. 이 한계로 O3/O6 전체를 유보하지 않는다.
추가 경계: `src/common/http/cors.ts:38`의 allowedHeaders에 X-Worker-No가 없어 허용 오리진이어도 교차 오리진 POST가 preflight에서 막힌다. 공용 CORS 담당에게 허용 헤더 보완을 인계하고, 해소 전 현장 배포는 동일 오리진/프록시 조건을 명시한다. B가 공용 인증·CORS를 임의 수정하지 않는다.

## R-n 반영 제안·필수 테스트 이름

| 제안 | 확정할 내용·소유 | 필수 테스트 이름 |
|---|---|---|
| R-API1 | §3 O9 본길 유보, O7 비null 거부 유지. 원천 없음은 마스터 값 0행과 다르며 새 마스터의 소유·선택 경로를 임의 신설하지 않는다. | `원인 미확정 complete는 계약 핸들러가 없다`; `PUT 원인 생략·null·품질코드·동일값 재대입 경계를 구분한다` |
| R-API2 | A1을 PR⑤⑥⑦에 반영. I-28과 주체 지문 원칙은 맞추고 query 없는 차이는 명시. | `같은 키의 다른 계정·사번은 과거 응답을 받지 않는다`; `재전송도 사번 필수·형식 검사를 통과해야 한다`; `같은 주체 재전송은 오래된 If-Match로도 최초 결과를 재생한다` |
| R-API3 | A2를 PR①③ 및 쓰기 테스트에 반영. 버전 ETag 미선언은 유지. | `미선언 응답의 약한 ETag는 버전 토큰이 아니다`; `생성·PUT·start 뒤 상세 재조회 토큰으로 다음 쓰기가 성공한다` |
| R-API4 | A3을 §5 오류표·E-B21·상태 코어 호출 인자에 반영. A 소유 전이표 조율 유지. | `start 상태 잠금은 400 STATE_LOCKED이고 버전 충돌만 409 봉투다`; `start 필수헤더·잘못된 path의 실제 400 누락을 기록한다` |
| R-API5 | A4를 PR①②③·배포 조건에 반영. nullable 확장·백필0 유지. | `과거 헤더·라인 OK/NG를 PASS/FAIL로 꾸미지 않는다`; `과거 필수결손 고장 PUT/start의 응답 실패는 업무·멱등을 롤백한다` |
| R-API6 | A5를 PR⑤ 입력 검증·문의 후보에 추가. | `측정 0.0000001·범위 초과는 400 RANGE이며 헤더·라인이 남지 않는다`; `정확히 표현 가능한 측정값과 null은 보존된다` |
| R-API7 | A6의 귀속 테스트 정정은 B, 인증·CORS는 공용 소유. 문의054에 I-30 영향을 인계. | `유효 세션과 계정 미연결 사번으로 201`; `세션 없는 동일키 재전송은 401`; `현장 POST preflight가 X-Worker-No를 허용한다`(공용 보완 뒤) |
| R-API8 | §4 조회 유지. UTC는 기존 선례, 기간 없는 일반 이력/unknown sort는 가장자리②, 복수 지시·소수 분은 nullable+임의 도출 없음으로 기록. | 기존 E-I02~07·E-B01~08 + `닫힌 30초 두 구간은 합계1분이고 열린 구간은 합계에서 빠진다` |
| R-API9 | §7·§10 유지. notifyAssignee 의사와 실제 발송을 구분하고 알림·첨부 제한 인계. 추가 검증을 포함해 PR별 실제 diff를 확인. | E-B12·E-I18 유지; `번호 실패 뒤 업무·멱등만 롤백되고 허용된 결번을 감춘 재사용이 없다` |

기간 예외가 FAIL/asc를 자동 선택하지 않는 점, 다형 type+source와 직접 FK의 UNION 중복 제거, 취소 지시의 발행 흔적, 목록 count=0/상세 닫힌 구간 합계는 계약 의미를 보존하므로 변경하지 않는다.
결론: **8건 구현 진행 + O9 본길 유보 유지 권고**이며 실제 커버리지 증가·배포 적합성·PR 승인을 뜻하지 않는다. 신규 error code 0·계약 변경 0. 문의 최종 번호와 R-n 통합은 통합자 소유다.
