# I-33 독립 UIUX 재수립 의견

대상: `.backend-dev/lane-b/I-33-draft.md` 756줄 전체. **계획 보완 필요 — Blocker 0 / Major 3 / Minor 2 / Trivial 0.** 아래 Major는 현재 소비자의 실제 요청·표시를 놓친 인수 계획 결손이다. 서버의 고정 계약을 소비자 버그에 맞춰 바꾸거나 12op 전체 구현을 유보하라는 판정이 아니다. 초안 R1~R8은 root 미판정 그대로이며 이 문서는 독립 의견이다.

## 1. 증거·권위·방법

- 브리프86줄, 초안756줄, DB 관측 원문 전체, CLAUDE/README(§2 전문)/lanes/lane-B/server-architecture/기존-구현-도메인-규칙을 직접 읽었다. 고정12op와 ToolUsage/Create·CollectionChannel/Create/Update·Observation·Calibration/Create·WorkerNo·IdempotencyKey·IfMatch·PageMeta·Error/Conflict 연결 스키마를 직접 읽었다.
- design:design-critique, CREFLE pr-review/coding-rules 및 checklist/severity/review-comment/TypeScript/React/commit-convention을 직접 완독했다. 정확성→보안→테스트→가독성 순으로 점검했다. design-critique는 사용자 과업 완결·경고의 실제 도달·성공/실패 인지에 적용했다. 시각 렌더링·대비·터치 실측은 수행하지 않았으므로 접근성/레이아웃 PASS를 주장하지 않는다.
- 계약 SHA는 `contracts/COMMIT.txt:1`의 a6a87e144116ebaa32c01df5a12a0fd2924427e7. P-05-01/W-05-10/W-05-11/W-05-07 화면 전체를 읽었다. 설계 checkout HEAD는46f0ef5이나, 이 네 파일의 `git diff --name-only a6a87e1 -- <네 파일>` 결과가 비어 고정본과 동일함을 확인했다. 최신 client 코드는 현재 소비의 증거이며 계약 변경권한이 아니다.
- 현재 client의 tool-usage·tool-pm-result 요청/환산, gauge-calibration 폼/코드선택/조회/mapper, gauge-master 날짜판정/최근이력, collection-channel 요청/폼mapper/후보선택/import/검사항목picker/경고 및 공용 오류 정규화를 직접 읽었다. 다른 I-33 API/통합 리뷰 파일 읽기0. I-32 canonical R2/R14만 공유 시각 근거로 사용하며 helper 구현 승인으로 읽지 않았다.
- DB값은 root의 `.backend-dev/lane-b/I-33-db-observed.md:1` 원문을 재사용했다. 과거54개 시점·업무5표0행·70칼럼22제약9index44NULL주석을 재측정0. 후속55/generate6.19.3/drift0 통지를 과거 관측에 소급0. 이 검토의 DB/코드/DDL/E2E/gates/git·gh writes/외부댓글/번호배정/하위agents는0.
- root 통지 기준 main6bde921·공식352/487, I-26 #307은 리뷰 중353후보다. 이 보고서·파일 반환·계획 승인으로 API 완료나 공식 수를 늘리지 않는다.

## 2. 계획자가 제시한 다섯 축 그대로 판정

| 축 | verdict | 독립 근거·구체 권고 |
|---|---|---|
| ① 툴 사용 입력·시각·누계 | **권고 채택** | 고정 POST 설명(:2221)·P-05-01:138 이하가 증분만 전송하도록 정한다. required 결손을 current/createdAt/계정으로 메우지 않는 A20 추가4·완화2, 양수 제출정수 보존, 과거 GET 누계쌍 생략, mold 잠금/version 증가를 지지한다. 제출시각과 누계 기준시각은 독립이다. actual `tool-usage/mutations.ts:45`는 사번·멱등키/IfMatch0, `tool-pm-result/queries.ts:133`은 mold 상세 토큰을 보낸다. I-31 reset 성공·lastPM 정책 승인을 전제하지 말고 E-T13/14를 실제 병합 후 교차 검증한다. |
| ② 검교정·차단·해소 | **기본/확장 분기 채택 + U3/U4 인수 보완** | 고정 POST(:2830)의 합격계열 master2칸 같은tx가 본길. seed:304~310의 PASS/ADJUSTED/FAIL 의미와 W-05-10:138·151을 연결해 PASS/ADJUSTED 갱신, FAIL 무갱신 권고를 채택한다. runtime 이름/번역분류0. nonCAL 활성확장 result는 정상 이력등록, unknown CAL만422/쓰기0. :clear는 행잠금·한행해소·blocksUse 보존·다른 차단/만료 유지이며 version추가0. |
| ③ 수집 채널 5칸·NULL 유일 | **물리/유일성 채택 + U1/U2 보완** | 고정 POST·PUT:2422·2538과 W-05-07:127~145의 네축 유일/NULL전체를 따른다. key/code 분리·필수3완화·기존uq 유지·새 식unique·비활성도범위 유지는 적절하다. 단위 불일치/미매핑/구Rev는 저장 허용한다. 실제 빈 unitCode PUT와409 소비까지 닫아야 수신→연결·해제·재활성화가 성립한다. |
| ④ 관측의 실제 원천 | **T 최근projection·등록flag·무페이지 권고 채택, 수집기 인수 미완 유지** | 고정 O6(:2630) ‘최근 신호/lastValue’와 W-05-07 §5-4의 실제신호 선택이 본길이다. 등록 전 신호를 담지 못하는 구FK 관측표와 추출규약 없는 JSON으로 대체하지 않는다. 설비+key 최근1행, 무age컷/무임의limit, lastValue/time 같은행, 전체필터 count를 공개권고로 채택한다. 이미등록flag는 U2와 아래 경계대로 쓰며 검사적용가능 판정으로 확대0. |
| ⑤ 원자성·예산·배포 | **tx/10조각 채택 + 소비자 인수 기준 명문화** | 실제 IdempotencyService tx를 쓰고 응답까지 같은commit, actor/worker 재생·과거NULL 명시를 지지한다. 일반350/400·core전체200, M2 타소유FK/참조보호 선행조율을 유지한다. 추가 finding은 canonical 문서/해당 server단언과 별도 client 인수로 배정하며 서버PR에 프론트 수정이나 수집기 구현을 몰래 포함0. |

## 3. Findings — 구체 실패와 최초 기준

### U1 · Major · 단위 없는 채널의 실제 PUT이 본길을 막는다

근거: 초안:83·440·448은 unitCode를 선택 string/실재UOM 조회로 정하지만 빈 문자열은 판정하지 않았다. actual `../omf-mes-client/apps/web/src/screens/collection-channel/mappers.ts:90~101`은 수정마다 `unitCode: trimmed(values.unitCode)`를 보내고 `screen.tsx:311,421`은 항목 편집뿐 아니라 사용중지·재활성화에도 그 mapper를 쓴다. 같은 screen:119의 관측 import는 단위를 보내지 않아 정상 신규행의 uom이 빈다.

실패 예: `POST {equipmentId,channelKey,itemId:null,processId:null}` → 단위없는 행 생성 → 항목 연결 또는 사용중지 → 현재 client는 `unitCode:''` 포함 PUT → 없는 UOM400으로 전체 수정 실패. 단위를 억지로 채워야만 연결·해제할 수 있어 ‘단위 선택’ 약속이 깨진다. 기존 부록 값을 뒤집는 finding이 아니라 부록에 없던 mapper 접점이다.

README §2: 0단계에서 null미허용/string optional과 UOM식별자는 확인되지만 `''=해제` 선례는 없다. 1단계는 **빈 unitCode 요청만의 가장자리**. 처음 갈리는 기준은 **② 명시 거부**이며, 서버가 임의로 `''→NULL`을 도출하는 완화는 여기서 승인하지 않는다. **권고:** `CHANNEL_EMPTY_UNIT_POLICY='REJECT_EMPTY'`를 명문화하고 client 인수에 ‘단위없음 유지 시 unitCode 생략’을 지정한다. 이미 있는 단위의 해제는 현재 계약으로 허용됐다고 쓰지 말고 구체 문의로 남긴다. signalName 빈string 보존과 unit FK 해제를 같은 것으로 취급0.

PR/단언 영향: W2와 Q3에 `단위 없는 채널은 unitCode 생략 PUT으로 항목연결과 사용중지가 된다`, `빈 unitCode는 field400이고 원래 행과 version이 보존된다`; client 인수에 `수신 가져오기 후 단위 없이 연결/해제/활성전환`. 서버10조각/DDL 추가0. 인수 미완을 표에 남기면 server 구현을 계속할 수 있다.

### U2 · Major · 관측 import의409/500 실패가 성공 건수로 표시된다

근거: 초안:442~444·474는409와 건별등록을 계획했지만 실패집계 경로는 빠졌다. actual `collection-channel/screen.tsx:124` catch가 `reasonOf()` 결과를 넣고, :147~160은 validation/stateLocked/network 외에는 null을 반환한다. `../omf-mes-client/packages/api-client/src/errors.ts:67`은 계약409를 kind=conflict로 만든다. `collection-channel/observation.ts:71~74`는 reason===null을 성공으로 세고 실패목록에서 제외한다.

실패 예: 두 관리자가 같은 미등록 key를 고른 뒤 각각 다른 멱등키로 import → DB유일성으로 한쪽409 → 실패한 창도 ‘1건 생성’ 표시·실패0. 서버500도 같은 길이다. 신규FK 오류 번역을 친절하게 만드는 것만으로 이 문제는 해결되지 않는다.

README §2 **0단계**: 고정 POST:2422의409 문구·네축 유일 범위를 그대로 내고 성공/실패는 HTTP 결과에 따른다. 임의설계 갈림이 아니므로 2단계 첫기준은 **해당없음**. **권고:** client에 성공 여부를 명시하는 outcome과 conflict/http의 실패사유 또는 ‘사유 확인 불가’를 요구한다. 서버409를400 DUPLICATE로 바꿔 소비자에 맞추지 않는다. 재조회 후 alreadyMapped가 바뀌어도 과거 실패를 성공이라 집계해서는 안 된다.

PR/단언 영향: W2 E-G05의 실제409 봉투를 client fixture로 인계한다. `두 창 동시 가져오기에서409 한건은 실패로 남는다`, `500/사유없는 오류도 생성건수0이다`, `부분성공의 성공수+실패수=요청수`. server 단위/E2E만으로 이 UI단언을 PASS 처리0. 현 소스 정적 추적 결과이며 실행재현은 미수행이다.

### U3 · Major · CAL 실제 후보 선택은 preview 수정만으로 열리지 않는다

근거: 초안:491·677은 PASS-only preview·수행자 부재를 인계하지만, actual `gauge-calibration/code-options.ts:36,48,59`는 유형 CALIBRATION/CHECK·결과 PASS/FAIL 고정배열·기관 빈배열이다. `history-form.tsx:99,131,163`이 실제로 그 배열을 Select에 전달한다. `lookups.ts:58`은 calibrationRequired:true만 조회한다. 고정 계약:5007·5129는 registry 조회/유형별 결과·열린 확장을, W-05-10 §6은 검교정 비대상도 경고후등록을 요구한다.

실패 예: ADJUSTED가 DB에 있어도 현재 화면에서 고를 수 없다. EXTERNAL도 선택불가라 외부기관 짝은 입력 경로부터 없다. calibrationRequired=false인 단순게이지에 CHECK 이력을 쓰려 해도 선택 목록에 나오지 않는다. preview 함수만 바꿔 ‘검교정 정상경로 인수완료’로 보고하면 실제 과업이 남는다.

README §2: **0단계** registry 선택/비대상 경고후등록은 명문이므로 후보 접근의 최초2단계 기준은 해당없음. 유형별 부분집합 메타데이터는 여전히 미정이며 이름/번역으로 분류하지 않는다. CAL 기본3값 연결은 기존값 의미에 근거한 권고, unknown CAL은 **1단계 가장자리→최초① master/이력 쓰기0**, 이를422로 드러낸다. nonCAL 전체유보로 확장0.

PR/단언 영향: W3 E-C04~07 유지 + 별도 client 인수 `registry ADJUSTED 선택과 저장전 master갱신 안내`, `EXTERNAL 선택은 기관명필수/수행자비움`, `비대상 계측기 CHECK 저장가능`, `확장CAL 분류거부는 result 인라인과 입력유지`. 고정부분집합 부재는 문의로 남기되 기본/비검교정 API진행은 유지한다. client scope를 root 인계항목으로 구체화하고 server PR 예산 추가0.

### U4 · Minor · 날짜 인수는 관측 UTC뿐 아니라 기한없는 합격·공장 오늘도 필요하다

근거: 초안:424는 합격 nextDueOn 누락을 null로 치환하고 :474는 관측offset 인수를 이미 적었다. actual `gauge-master/calibration-status.ts:64`는 last가 있어도 due가 없으면 status=never, `calibration-badge.tsx:32`는 never 문구를 낸다. `gauge-master/today.ts:10`은 브라우저 로컬 오늘을 쓰고 `collection-channel/observation.ts:97`은 offset을 제거한 문자만 보여 준다.

실패 예: 정상 PASS+nextDue 생략으로 최근검교정일이 생겼는데 화면에는 ‘이력 없음’ 계열 표시. 서울00:30/하노이 전일22:30의 같은 순간에는 브라우저오늘을 써 하노이 만료일 당일을 만료로 볼 수 있다. 관측07:00+07 입력을 서버00:00Z로 내면 현재 화면은00:00만 보여 공장시간으로 오독한다.

README §2: null기한·DATE 저장·동일순간 보존은 **0단계** 계약/I32 R2·R14를 따르므로 임의서버도출 선택의 첫기준은 해당없음. **권고:** 기한 미기록을 이력 미존재와 구분하고 표시 TZ를 공장TZ로 인수한다. 서버에서 cycle/브라우저TZ로 날짜를 보정0. Q1/Q4·W3 기존 E-T15/E-O06/E-C09 유지, client에 `합격기한없음은이력없음으로표시0`, `서울-하노이자정경계`, `Z와+07은같은공장시각` 추가. 기존 UI 결함이라 server 구현 차단0.

### U5 · Minor · 재수립 구문이 폐기된 세 조건을 여전히 요구한다

근거: 초안:19 vs `docs/coverage-100/README.md:23~29`. 실패 예: 후속 구현자가 ‘세 조건 미해당이면3리뷰 생략’을 선례로 재사용. **README §1-2 명문** 문제여서 §2 최초기준 해당없음. canonical 계획PR에서 ‘3관점 재수립 기본값·다섯축 검토’로 수정한다. 기능 finding과 별개이며 코드/DDL/단언 추가0.

## 4. finding 없이 채택한 경계와 실제 인수 조건

| 자리 | 판정·인수 |
|---|---|
| 환산 제출값 | `conversion.ts:87` Math.round는 현 소비자의 임시정책이다. base3×ratio0.5→제출2 사례에서 서버는2와근거3/0.5를 보존한다. 엄격곱일치·현재정책 재적용·cavity재곱0. 미정은 소수환산 가장자리이며 최초④ 조용한값도출0. E-T07/08을 지지하되 14자리/소수6자리 무손실은 별도 검증한다. |
| 등록flag와 미매핑 | `observation.ts:15,24`의 후보선택 차단에 맞춰 alreadyMapped=같은설비/key의 어떤 등록행존재를 지지한다. inactive·inspectionnull·품목조건행도true, ‘수집에 적용가능’ 뜻이 아니다. 미매핑 채널목록은 inspectionItemId null이며 용어를 구분해 인계한다. 조건A만 등록돼도 importer는 차단하지만 수동폼에서 조건B/전체행을 추가할 수 있다. O6 본길의 권고로 공개하고 ⑤를 본길 임의선택 면허로 쓰지 않는다. |
| 원천·페이지 | T 최근 projection은 고정 계약에 상세 저장처가 있는 선례가 아니라 승인할 구체 권고다. 이를 승인하는 독립 의견을 낸다. 무페이지 전체 items+totalCount, 미필터 동명key의설비별독립 유지. 현재 client는 설비선택후만 조회하므로 동명key 선택충돌 없음. 원천writer/동률tie/수집기 운영인수 미완, 빈fixture만으로 실제 수신 성공 주장0. |
| 최신 Rev | 계약:4839의 최신 표시와 실제 quality service:116·317의 모든상태/max+1 DRAFT를 근거로 같은plan 최대plan_version을 채택한다. current=false는 경고, CONFIRMED/유효성/검사집행과 별개다. actual `mapping-state.ts:57`은 서버false만 믿고 `item-picker.tsx:151`은 모든Rev를 선택한다. 새DRAFT·다른plan·구Rev저장허용 단언 E-G11 유지. R7 본길 공개권고로 확정하며 자동이관0. |
| 단위·미매핑 표시 | actual `mapping-state.ts:69`는 두단위가 있을때만 차이, `unit-match.ts:43`은 UOM조회실패를 unknown으로 분리한다. 서버의18칸 전체조인이 경고 근거다. API가 null을 올바르게 내리는것과 편집창이 기존항목명/Rev를 충분히 보여주는것은 다르다(`item-picker.tsx:89,167`은 현재picker목록에서 못찾으면unknown). 필드복원·불일치경고·미매핑건수는 client 인수대상, 서버임의환산0. |
| clear 실제 경로 | `gauge-calibration/queries.ts:89`는POST생성만, `types.ts:56` mapper는blocksUse/clearedAt을 보존하지 않는다. gauge-master 이력pane:41~66도 차단/해소 액션없음. 따라서 O12 제공과 해소UI완성은 별개다. 열린2차단 중1건해소·다른차단유지·만료유지·이미해소409·같은키재생200을 실제 인수해야 한다. 새권한/ETag를 추가하지 않는다. |
| 인증·권한 | `src/auth/authentication.guard.ts:21`의 세션필수와 `src/common/http/cors.ts:40`의Worker헤더누락은 실제 POP 호출 인수 미완이다. WorkerNo는귀속이며 인증대체0. 403네쓰기/clear403미선언을 유지하고 인증401·can_input_result 잠정포섭을 별개로 기록한다. 세션fixture E-X02는 현장단말인수 증거가 아니다. |
| 삭제보호 | actual quality service:230·234·458의 항목 제거경로는 measurement만 사전검사하며 새채널FK는 DB삭제를막는다. 참조손실 위험과 친절한도메인오류/조회후경합을 구분한다. M2에 quality소유자협의·E-M04 실제서비스호출을 유지하고 존재하지않는 plan_version 직접FK를 참조목록에추가0. equipment/process 실제목록에 새FK2접점 반영, item ERP referenceCount=null을 임의목록으로 교체0. |

## 5. 결론·소유 반환

정확성: U1/U2/U3을 canonical 소비자 인수 계획에 추가해야 한다. 보안: 기존 인증/권한 경계를 유지하며 새 우회 발견0, 실환경 인수는 미완이다. 테스트: 이름 제안만 했으며 실행0/PASS0. 가독성: U5 문서 정정, 무단 client 수정/서명/커밋0. 계획 반영 뒤에도 UI 인수 미완이면 그 상태를 분리해 보고하고, 서버의 정상경로 구현을 전부 중단하지 않는다.

**파일 작성 완료와 함께 `.backend-dev/lane-b/I-33-review-uiux.md` 소유를 root에 반환한다.** 미완: root R통합/문의번호/계획PR, 실제구현/마이그/게이트, client 수정·브라우저 검증, 운영 구writer/POP·오프라인큐/관측수집자/clear UI 인수. 이 리뷰에 의한 공식API증가0.
