# I-27 root 통합 판정 — 2026-09-07

root가 초안467줄, DB161줄, 독립 API82/UIUX94/통합70줄, CSV 프로브160줄, writer 감사85줄을 전건 직접 읽었다. 아래는 root의 R 결정이며 편집자에게 판단을 위임하지 않는다. 현재 main #312 3e44f1c·355/487, DB56/drift0. 이 파일은 계획 결정만이며 I27 소스/DDL/게이트0. 문의 새 대역은 사용자 미회신으로 **번호 미배정**이다. 이전 B090~119를 재사용하거나 A/C 번호를 침범하지 않는다.

## R 표

| R | 쟁점/근거 | root 결정 |
|---|---|---|
| R1 | API A2·UIUX M1·통합M1, LOCATION 정상 선례와 POST 전체 유보 | **정상5 operation 진행**: 조회3+발행POST1+보고1. 프린터GET1 유보/rendition1 제외. POST는 아래 정확한 허용/조건부/거부 집합으로 구현하며 항상422가 아니다. LOCATION 계정 정상은 다른 종류 결손과 무관하게 진행. API 수와 문서9종 전체 지원/UI실물 완료는 별개로 기록한다. 정본 출판 때 목표476→475는 printer1만 차감한다. |
| R2 | writer 감사의 종류별 확정 사실 | 아래 지원표를 채택한다. 자재 초기 검사대기+입하hold는 정상이며 모든 LOT에 NORMAL만 강제하지 않는다. 생산은 완료+양품을 둘 다 확인하고 미달완료를 배제하지 않는다. CoA는 확인결과 기록과 미정양식을 분리한다. 품질값/단일LOT/출하배분/기본프린터를 조용히 만들어내지 않는다. 미정 입력군은 이름 있는 정책으로422·배치전건0, 문의에 원천을 구체적으로 적는다. |
| R3 | API A3·통합M2, mold count→별도CAS 경쟁 | TOOL_LABEL+MOLD의 계약 정상성은 인정하되 **writer 선행 보완 조건부**. 기존 코드수정의 mold잠금→현재 참조/발행검사→CAS를 한tx로 만드는 별도 선행PR과 실제2writer barrier2순서를 요구한다. 발행에서 mold.version만 올리는 우회0. 사용자에게 담당자 조율 요청을 보냈으며 응답 전 해당 writer 수정0; LOCATION 및 다른 안전한 가지 중단0. 결과PENDING/FAILED도 코드잠금 이력에 포함한다. |
| R4 | 통합M3·writer 감사, 실제 GI header→line→LOT FK | 초안 LOT-first/FOR UPDATE 일괄안을 폐기. GI는 헤더ids ASC **NKU**→라인/FK 재조회→LOTids ASC NKU 순. LOT직접은 LOTids ASC NKU; HU는 HUids ASC NKU; LOCATION은 LOCATIONids ASC NKU. 부모잠금 뒤 **새 SQL** MAX+1을 읽는다. FK KEY SHARE와 호환되는 NKU로 자격변경/삭제를 직렬화하며 상태·버전은 쓰지 않는다. SQL 식별자는 고정 whitelist. 실제 writer 경합 검증과 경로 재확인은 아래 규칙을 따른다. |
| R5 | HU 내용물·CoA request/LOT 경로, 미래 A writer | HU 포장에는 비어있음 추가제약0; GI-HU는 존재하는 content 최소1행을 SHARE로 잠가 최종 시점까지 비어있지 않음을 보존한다. CoA는 초기 result→request→LOT 후보를 읽고 LOTids ASC NKU→requestids ASC SHARE→resultids ASC NKU, 잠금 뒤 경로/CONFIRMED/confirmedAt 재확인. 초기와 달라지면 전체 run 재시도. 현재 감사에서 production HU writer/최종confirm writer를 찾지 못한 사실은 미래 안전 보장이 아니다. 구현 직전 최신 main의 실제 writer 그래프를 다시 확인하며 새 역순이면 그 가지의 소유조율/R 보완을 먼저 한다. 확인하지 않은 writer를 회귀PASS라고 쓰지 않는다. |
| R6 | MAX/uq/순서·N1000·Prisma 기본timeout5000ms | 부모를 유형별 일괄 잠금, 일괄 MAX, batch INSERT, 유형별 batch mapper로 처리한다. 대상당 N쿼리0·원본ordinal/지문순서 보존. seq2147483647 뒤는422 RANGE/전건0. 다른키 최초경쟁에서 사유없으면 한건만201/다음422, 사유있으면seq1/2. 원인확인된경로변동/40001·40P01·정확히발행회차uq만 **전체 run 최대3회**(처음+2회), 실패tx 안에서문장재시도0. 소진은 기존 ConflictException('user', message)의 409 ConflictResponse 봉투(conflictCause/message만, code추가0), 새오류코드0/횡단편차문의. N1000은 기존5초안에서 실제성공/중간실패/응답저장실패/재생 검증하며 실패원인 없이공용timeout확대0. 물리쿼리 상한을 구현 전에 실제 분할별고정한다. |
| R7 | API A1·root CSV 재현, Express getter | P2의 **summary 경로 전용 middleware**가 guard 전에 scalar targetIds만 split(',')하여 query사본을 Object.defineProperty로 고정한다. AppDomainModule NestModule.configure의 GET app/document-issues/summary만 등록(api prefix중복0). 응답/에러를 middleware에서내지않아 인증순서를 우회하지 않는다. missing그대로, 빈token필터0, 중복/순서보존. 기존배열 repeated-key는그대로검증하며 배열원소안CSV를추가split하지 않는다. controller/pipe전처리로대체0·공용contractserializer수정0. 실제AppModule CSV단건/2,1,2/빈token/1000/1001/정적route/401 검증. |
| R8 | summary required3/lastOutcome nullable, 전건/중복 | A9 뒤 P2 진행. count는 로그행수, documentType미지정은모든종류, 세last는issuedAt DESC,id DESC 동일행. 입력ordinal/multiplicity그대로·미존재target+기록0은count0이며존재/자격증명0. 구행NULL outcome은 **summary lastPrintOutcome:null 정상**, count/seq/time보존. 빈이력last3모두null. DocumentIssue 필수outcome검사를summary에전파하지 않는다. |
| R9 | A9 nullable6·통합M4 oldwriter/P5 | 결과3+귀속3 nullable6, DEFAULT/백필0, SQL wholeCHECK IS TRUE/귀속3FK·NoAction양방향/Prisma기본FK명 채택. 과거전체NULL허용·NULL outcome+보고칸거부·PENDING보고칸NULL·SUCCEEDED사유NULL·FAILED비공백사유+보고actor/worker/time필수. 발행actor기존appuser보존. 환경별구writer종료/갱신→P5/필수값검사→DocumentIssue응답 활성화; rollback으로구writer돌아오면동일hold. 현재production로그writer0과운영writer미확인을구분,fixture기존NULL자동수정0. 개발DDL/정상자료구현은지속한다. |
| R10 | report·귀속·멱등 | PENDING만 두결과로, FAILED사유없음/null/공백422 REQUIRED, SUCCEEDED비공백사유422 INVALID(가장자리2-②)·빈사유는null로표현. 기존NULL outcome은모르는저장값Error500이지이미보고됨422가아니다. 알려진완료결과새key422 STATE_LOCKED, 같은key는최초응답재생. reportedAt은서버접수시각이지실물시각이아니다. callbacktx에서log FOR UPDATE·actor/worker검사·업무/응답저장원자화. report사번필수,POST계정사번선택/검증된terminal이면필수. rawworker/actor/terminal/actualmethodpath/body원본을지문에포함, 인증/토큰검증은재생전·업무자격/사유/worker존재검사는callback안. |
| R11 | F1 고정문자·POST403·P0404 실제소비 | 관리웹계정은terminal없이정상. F1은생산/품질기능구성이지전역보안인가정본이아니며창고공정0정상. 창고 MATERIAL/GI/PACKING에는can_print_label을확대하지 않는다. 생산LOT의검증된terminal입력은확정W/O→process축의해당terminal_process.can_print_label을사용하고불허/행없음403, 임의첫공정/any다른공정0. 관리웹및창고를terminal필수로바꾸지 않는다. CoA의terminal공정축은확정원천을구현전에대조하여없으면그인증가지에대한문의/R 보완(계정정상중단0). 공용무로그인POP/CORS는054/094미완. manual은POST자기op에 P-04-04 보강단독커밋,CoA계정지원에는고정 W-04-03도필요하므로같은자기op에추가. GET/report403등록0·derived/공용guard수정0. |
| R12 | REISSUE_REASON 실제5값/고객확장·시드오염 | 같은tx로정확그룹+활성그룹+활성값검사, 고객추가허용/PRINT_FAILED하드코딩0. 새값은422INVALID·그룹비활성거부. 공급사유는유효성검사하되신규row에는NULL·seq>=2만저장. effective_from/to의평가일/타임존은계약침묵으로새날짜게이트를도출하지 않는다; 기존활성플래그기준을사용하고유효기간규약을별도질문한다. 과거이력의사유명은현재코드가inactive여도표시·새발행자격과다르다. |
| R13 | int64/A5·required표시명·시간 | 로컬입력의 Number.isSafeInteger를검사하고 안전범위밖은입력400 RANGE(POST업무422와횡단차이문의), rawquery/path의정밀도손실은가능한원문경계에서검사·공용parser수정0. JSON parser이전손실까지해결했다고주장0. DB bigint는변환전safe범위검사,필수범위/길이/enum결손Error500·절삭/문자열로계약변형0. 목록/상세16/target3·길이200/lotNo60·현재actor명과7target batch·삭제fallback TYPE #id/screen생략. µs 기간경계는선행I26/알림의읽기경계선례로별도app-local처리하며maintenance 입력저장helper를다른정책으로재사용하지 않는다. |
| R14 | 실제client발견M2/M3/Minor표시 | DELIVERY+LOT와PACKING+LOT실제임시치환/배분소거는서버허용근거0. MATERIAL기록PENDING/FAILED도labelIssued=true인기존서버규칙유지;렌디션실패뒤필터목록에서행사라짐/재시도UI손실을별도소비자문의로남긴다. 서버labelIssued를SUCCEEDED로변경0·자동FAILED/렌디션호출0. 51+이력UI페이지누락/7target screen이동미구현/기본프린터‘서버기본’표시설명은별도미완. API완료와물리라벨업무완료를동일시하지 않는다. |
| R15 | printer 본길·A10 | 단말매핑/식별명/명시기본/지원종류/관측producer가정의되기전 GET유보·handler0·A10적용0. active→READY/OFFLINE/첫행기본/같은plant가능/빈stub0. 기존plan의OFFLINE default를철회한다. 확정DB저장원천만읽는최소경로가정해지면재개하며장치poll/드라이버/스풀접속0. |
| R16 | 분할/등록/검증/추적 | P0 A9→P1조회2(+필요P1t읽기시간)·P2summary/국소middleware→P3report. 발행규칙/부모잠금/배치POST는책임별선행조각,TOOL writer조율별도. 기본350/일부더낮은예산·실제400하드,core발생시전체PR200·별도조율. 조회필드테스트동행·구현자lint/tsc/unit/wholeownE2E·freshreviewerunit/wholechangedE2E·root영향회귀(로그소비mold/inbound/모듈A등록)만. 문의는단건별기록하며새번호대역승인전placeholder를정식번호나완료로표기하지 않는다. |

## 정확한 발행 집합과 구현 순서

이 표는 documentType 1개/targetsN개의 모든 입력을 분류하는 규칙이다. 열에 나열하지 않은 짝은422 INVALID(field 원본 targets[i].targetTypeCode). 미존재target422 INVALID(targetId), 잘못된nonnull lotId422 PAIR(lotId). 원천lotFK가정의된종류는생략/null을그값으로연결하고non-null일치검사, HU/MOLD/LOCATION은NULL고정. 배치하나실패면새로그/멱등전건0이다.

| 문서 | 지원 정상 | 명시거부/조건부 |
|---|---|---|
| LOCATION_LABEL | 기존LOCATION·lotNULL·계정사번/terminal생략가능 | 다른짝/nonnullLOT거부. 존재외새활성/공정조건0 |
| MATERIAL_LOT_LABEL | LOT typeMATERIAL·status INSPECTION_PENDING 또는 NORMAL, 자기LOT FK. 초기incoming hold허용 | 다른상태는자재재발행자격미확정가장자리422 STATE_LOCKED, `MATERIAL_LABEL_UNRESOLVED_STATE_POLICY='REJECT'`. 모든source_type을INBOUND로새제한0·hold/blocked_qty일괄차단0. 최소정상source증명과유일허용source를혼동하지 않는다 |
| PRODUCTION_LOT_LABEL | ⚠ **2026-09-15 정정(P-18)** — 「`completed_at` 존재·status NORMAL」을 「생명주기 ACTIVE(실적 반영) **또는** completed_at 존재 · status ∈ {INSPECTION_PENDING, NORMAL}」로 **완화**했다. P-02-04 는 라벨을 찍어 그 라벨을 스캔하는 것이 마감 입력이라, 완료를 요구하면 라벨과 마감이 서로를 기다린다(사용자 결정). 원래 결정: LOT typePRODUCTION·completed_at존재·status NORMAL, 자기LOT FK. 미달완료도같음 | 실적 미반영·불량/폐기 상태 422 STATE_LOCKED. 관리웹에는새source제한0, terminal이면실제WORK_ORDER공정축확인/해당flag403. 개체별품질로외삽0 |
| GOODS_ISSUE_QR | 기존GI_LINE+부모POSTED·정확lineLOT, 또는기존HU+content최소1·lotNULL | line부모미전기/빈HU422 STATE_LOCKED. HU의출고소유FK가없으므로literal존재+비어있지않음만채택(0단계화면);‘출고확정소유검증완료’주장0/새FK0·별도문의. GI의반품/폐기를LOT NORMAL게이트로제거0 |
| PACKING_LABEL | 기존HANDLING_UNIT·lotNULL, 비어있는HU도추가금지문자없어임의거부0 | PACKING+LOT실제화면충돌은422 INVALID·`PACKING_LOT_TARGET_POLICY='REJECT'`. 특정‘라벨대기’상태를없던생산자로만들거나필수화0 |
| CERTIFICATE_OF_ANALYSIS | 기존INSPECTION_RESULT statusCONFIRMED+confirmed_at존재, request.lot_id(nullable)그대로 | 미확인결과422 STATE_LOCKED. ACCEPTED/PASS/latest검사조건0. 양식부재는rendition만;record계정정상진행. CoA writer그래프/terminal공정축은R5/R11의구현전확인사항 |
| TOOL_LABEL | 계약정상은MOLD·lotNULL | R3 writer조율/보완/경합회귀전만422 STATE_LOCKED·`TOOL_LABEL_WRITER_READY=false` 명시;소유조율뒤이분기만활성화. location까지막지않음 |
| IDENTIFICATION_TAG | 정확target은SERIAL_NUMBER이나개체양품원천미확정 | 이입력군422 STATE_LOCKED·`IDENTIFICATION_LABEL_ELIGIBILITY_POLICY='REJECT_UNRESOLVED'`. LOT양품/수량배분으로개체양품추정0,기존개체도같음·104/105연계 |
| DELIVERY_LABEL | frozen enum에출하배분표현없음 | 이입력군422 INVALID·`DELIVERY_ALLOCATION_TARGET_POLICY='REJECT_UNREPRESENTABLE'`. LOT/HU/임시id치환0·계약enum변경0 |

허용표 전체를한PR에몰지않는다. 먼저LOC 정상POST를등록하더라도그시점의부분지원목록/남은구현가지를정확히기록하고다른정상표행구현을이어간다. 지시서의9종전체완료로세지않는다. 규칙/잠금선행조각은미사용등록stub없이단위검증, 최종POST체인에서실제정상/거부63조합/HTTP로검증한다.

## 잠금·재시도 인수의 구체 경계

- GI 초기line→header는탐색만. 잠근헤더안에서라인/FK를다시읽고다른헤더로바뀌었으면전체run재시도한다. GI_LINE 실제삭제/lot변경 writer와두순서barrier회귀,문서가먼저/기존writer가먼저일때둘다결과·잔존0을확인한다. 대상row잠금하나로header상태를지킨다고하지않는다.
- HU nonempty는찾은content행SHARE+재확인으로고정한다. 전체내용물목록을응답에싣거나여러LOT를한LOT로만들지않는다. 실제HU writer가추가되면행/부모순서를대조하고우회소스변경0.
- CoA의초기request/LOT경로가바뀌면고정잠금순서를부분역행하지말고retry한다. confirmed결과의품질자격은행상태+시각이며overall_judgment추론0. A19등록/수정미병합head는감사근거일뿐현재main기능이라고쓰지않는다.
- 쿼리상한은작업유형별고정상한으로구현브리프에명시: 의미상유형별잠금/경로재확인·코드/actor·MAX·batchinsert·mapper/멱등 저장. N1000에대해쿼리로그숫자와전체실행시간을실측한다. rootR6의3회는오류원인별유한재시도이며프로그램오류/검증422/일반P2002/500을숨기는retry0.

## 문의 단건 후보 — 번호는 모두 미배정

1. 납품라벨 출하배분 target enum 및 실제LOT치환/중복소거 정정.
2. PACKING_LABEL+LOT 고정화면과HU 정본 충돌.
3. 개체별 라벨 발행 자격 원천(104/105 참조, 수량질문과 별개).
4. 자재라벨 후기상태 재발행·GI-HU 출고소유/최소자격(같은원천질문인지원문대조뒤별도문서로분리 가능).
5. 프린터 단말매핑/식별명/기본·지원/관측원천.
6. 발행·보고 계정/worker/terminal 귀속·구행결손/구writer 배포/보존(054/107연계, 단건범위확인뒤분리).
7. summary CSV/중복·존재아님·최신행·int64/표시길이/조회경계는확정문자와가장자리질문을섞지않고질문별분리.
8. MATERIAL기록뒤렌디션실패의실제화면복구경로, 기존labelIssued의기록기준은유지.
9. P0404 공정0창고기능구성·POST파생권한누락/CoA W0403권한·생산terminal정확공정축.
10. 재발행사유 effective dates 평가일/TZ·성공보고의불필요사유·멱등/경합소진횡단오류는질문별분리.

위는발행할문서의예약목록이나번호가아니다. 기존B117~119추가2문의와합쳐사용자새대역승인을받고단건정본파일을root가작성한다. 질문없이값을채우지않는다. 일반명칭/화면목록사실은인수문서로남기고질문이없는것을번호절약용합본문서로꾸미지않는다.

## 편집자에게 맡기는 일

이R1~R16과표를그대로초안 §0-재수립에반영하고관련본문/SQL보존/테스트/예산/배포/마감표를정합화한다. SQL A9전문은현재후보를보존하고기존CHECK/FK/칼럼삭제0. 새판단/문의번호/공유정본편집/소스/DB/gitgh0. 정적source를다시읽어R이실행불가능함을발견하면root에돌려묻고자의로지원표를바꾸지않는다. 완성파일전건root재독뒤정본화/PR하며이편집완료는루틴종료가아니다.

## R17 — A9 준비 뒤 root 추가 명료화

계획 #315 병합 후 새 물리 준비자가 `btrim`과 모든 whitespace를 같은 보장으로 읽을 위험을 지적했다. root는 고정 PrintOutcomeReport(실패 사유 조건부 필수)와 `src/common/master/not-blank.ts` 전건의 `String.trim()` 선례를 대조했다. 정본 SQL은 변경하지 않는다. CHECK2 중 보고 분기 전체만 IS TRUE이며 DB 실패사유 검사는 빈문자열/일반공백 최소 제약이다. API R10은 String.trim() 공백을422 REQUIRED로 거부하며 원문 내용은 보존한다. SQL 상수/물리 검사와 후속 API whitespace 검증을 분리하고 물리 PASS를 API 검증으로 확대하지 않는다. 이 추가는 source/DB 실행이나 새 문의번호 배정이 아니다.
