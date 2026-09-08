# I-27 독립 계획 리뷰 — UI/UX

기준: frozen 계약 `a6a87e1`, root 전달 main `4fadf31` /353. 초안 467줄·DB 관측 161줄 전문, 지정 운영 문서, CREFLE coding-rules와 TypeScript/React/commit 참조, engineering documentation 스킬을 읽었다. 아래 client는 `../omf-mes-client` 작업 사본의 **실행 경로 소스**를 읽은 결과이며 실행 검증·계약 대체 근거가 아니다. 다른 리뷰 보고서 열람0.

## 판정 요약

**Blocker 0 / Major 4 / Minor 2.** 모두 계획·인수 조건의 보완 요청이며 root의 R 확정 전 구현 승인이 아니다. A9 후 조회3/report1, 프린터 GET 유보, rendition 제외 방향은 수용한다. POST 전체를 미정으로 묶는 대신 확정된 정상 입력과 미해결 입력을 나누는 R이 필요하다.

| 등급 | 찾은 빈칸 | root가 정할 것 |
|---|---|---|
| M1 | POST 전체 조건부에는 이미 확정된 관리웹 기록 정상 가지까지 묶여 있다 | TOOL_LABEL+MOLD / LOCATION_LABEL+LOCATION의 계정 발행 후보를 먼저 구체화하고, 다른 가지의 자격 결손을 별도 명시 |
| M2 | 실제 client가 계약 충돌을 임시 값으로 통과시킨다 | DELIVERY_LABEL+LOT 및 PACKING_LABEL+LOT 소비자 gap을 인수 범위·거부 테스트·문의에 명시; 서버에서 그대로 허용하거나 HU로 치환하지 않음 |
| M3 | PENDING/FAILED도 기존 labelIssued 소비자에서 완료 목록 제외를 일으킨다 | 발행 성공→렌디션 실패→목록 재조회 후 복구 가능성을 별도 인수 조건으로 둠. API 완료와 화면 업무 완료를 구분 |
| M4 | terminal_process를 출력 전반의 서버 권한으로 읽으면 창고·관리웹을 잘못 차단한다 | F-1 적용 범위와 403·계정 기능권한·단말 인증을 분리한 표; P-04-04 파생권한 누락을 자기 operation 보강 여부와 함께 확정 |
| Minor 1 | 실제 발행 이력 화면의 대상 이동 구현은 확인되지 않았다 | 삭제 target fallback/screenId 생략은 서버 검사; 화면 이동 완료라는 주장 금지 |
| Minor 2 | 실제 이력 소비자는 기본/고정 1페이지만 가져온다 | GET 기본50/최대200을 유지하고 51회 이상 이력의 UI 페이지 누락은 consumer 한계로 전달 |

## 축 1 — 정확한 9×7 짝·자격·LOT·summary

0단계 정본은 `contracts/app-공통.json:4518,4539,4594`가 가리키는 요구서 §3-8/§3-7이다. 아래 `D`는 `.design-reference/omf-mes/design/wiki`, `C`는 `../omf-mes-client/apps/web/src/screens`이다.

| documentType | targetType·판정 | 고정 근거 및 실제 소비자 |
|---|---|---|
| MATERIAL_LOT_LABEL | LOT. 초기 검사대기까지 NORMAL 강제 금지. 저장 lot FK=자기 LOT | 요구서 `D/api-contracts/06-API-요구서-app공통출력물.md:183`; 실제 `C/pop-material-lot-label/issue-request.ts:79`. M3 복구 경로는 별도 |
| GOODS_ISSUE_QR | GOODS_ISSUE_LINE 또는 HANDLING_UNIT 후보. HU lot=null, 빈 HU 거부 유지 | 초안의 고정 P-01-02:68,126 근거 수용. 불량 반출에 blanket quality 거부를 만들지 않음 |
| PRODUCTION_LOT_LABEL | LOT. 완료/미달완료 허용과 양품 자격을 구분 | 초안 P-02-07:67,100 근거 수용. serial 품질 도출 금지와 독립 |
| IDENTIFICATION_TAG | SERIAL_NUMBER. 개체 양품 판정 원천 미해결 가지 | `C/packing-label-reprint/targets.ts:43`은 serial 후보를 표시하되 :53에서 선택 불가. 임시 targetId=lotId(:46)는 비활성 행이므로 실제 허용 요청 근거가 아님 |
| PACKING_LABEL | HANDLING_UNIT 정상 후보. PACKING_LABEL+LOT 충돌은 미해결 | 요구서:187은 포장. 반면 고정 P-02-09:64,94,128 및 실제 `C/packing-label-reprint/targets.ts:31`은 LOT+PACKING_LABEL 활성 후보. **충돌을 실제로 소비 중** |
| DELIVERY_LABEL | 출하 배분에 대응 enum 없음. LOT/HU 치환 불가 | 요구서:188; 실제 `C/shipping-packing-label/codes.ts:64`는 LOT 임시값, `issue-request.ts:59`는 배분 여러 행을 같은 LOT로 중복소거. 이는 배분을 식별하지 못하는 consumer gap |
| CERTIFICATE_OF_ANALYSIS | INSPECTION_RESULT. 기록 자격과 양식 유보를 분리 | 요구서:189는 양식 미정이라 아직 호출 안 함. 근거 없이 PASS·최근검사·연관LOT를 만들지 않는 초안 수용 |
| TOOL_LABEL | MOLD. 계정·사번 생략·프린터 생략의 정상 기록 후보 | 고정 `D/screens/05/W-05-13-툴금형지그마스터.md:168,178,184`; 계약:1445도 관리웹은 결과보고 안 부른다고 명시. 프린터 GET 부재로 기록 POST까지 막을 이유 없음 |
| LOCATION_LABEL | LOCATION. 다중 선택의 정상 기록 후보 | 고정 `D/screens/06/W-06-07-창고Location마스터.md:110,113`: POST 기록과 다중 선택을 명시. 화면 렌더링 부분 실패(:137)는 POST 전건원자성 완화 근거 아님 |

M1은 **1단계에서 operation 전체와 입력 가지를 구분**하는 보완이다. 정상 관리웹 가지는 0단계 문자대로 후보를 만들고, 미정 짝·대상/LOT 불일치는 가장자리 최초2-② 명시422. 특정 종류의 자격 본길이 미해결이면 그 종류를 문의/유보한다. 계정 기능권한·MOLD 동시 코드변경 보호가 해결되기 전에는 곧바로 구현하라는 뜻이 아니다.

M2는 계약 충돌 자체를 숨기지 않고 root가 R에 기록할 것. client 주석에 쓰인 과거 ‘사용자 결정’은 이번 frozen 계약의 변경 승인으로 승계하지 않는다. `PACKING_LABEL+LOT`, `DELIVERY_LABEL+LOT`를 허용집합에 무언중 추가하지 않고, 계약/정본 회신을 받을 가지로 둔다.

summary의 전건·원본순서·중복 multiplicity·미발행0·미존재0(존재 증명이 아님) 제안을 수용한다. 실제 `C/packing-label-reprint/targets.ts:64`는 summary 누락을 null(모름)로 유지하며 :93에서 사유를 요구한다. 신규0행을 누락하면 정상 최초 발행이 막힌다. 동일 id라도 문서종류 필터를 반드시 보존해야 한다(`C/shipping-packing-label/queries.ts:195`). 미존재0을 ‘존재하고 발행 가능’으로 승인하는 UI/API를 새로 만들지 않는다.

## 축 2 — N≤1000 원자성·회차·순서·사유

초안의 단일tx·대상 부모 첫발행 잠금·고정 잠금순서·원본 응답순서 복원·혼합 신규행 reason=NULL을 수용한다. 실제 client도 단일 POST와 until-applied 키를 사용한다(`C/packing-label-reprint/mutations.ts:41,56`). 계약:4526의 전건원자성은 **발행 기록**에 걸리며 인쇄 성공/실패 집계를 같은 tx로 합치면 안 된다.

대상 중복422는 가장자리 최초2-②. client가 중복소거하는 사례가 있어도 서버 요청 `[A,A]`의 뜻을 임의 변경할 근거는 아니다. 요약 `[2,1,2]`는 요청 전건 규약으로 세 행을 유지하되 count를 세 번 올리지 않는다. REISSUE_REASON 실제5값은 root DB 관측:131부터의 기존 실측을 수용하며, client/계약 오염 PRINT_FAILED를 seed처럼 쓰지 않는다.

필수 인수: N=1000 한 번의201, 중간 부적격 한 행이면 로그/멱등0, 신규+기발행 혼합사유1개, 두 키 첫발행 경합, 역순 targets 교착 방지·응답순서 보존. 시나리오를 줄이려고 낱건 POST로 바꾸지 않는다. 새 번호코어 필요 없음.

## 축 3 — 부분 성공·인쇄 결과·재발행·기존 소비자

M3의 직접 연결: 서버 `src/logistics/inbound-receipt/inbound-receipt-query.service.ts:34`는 MATERIAL_LOT_LABEL **로그 존재만**으로 labelIssued를 판정한다. 실제 `C/pop-material-lot-label/queries.ts:66,97`은 헤더/라인 모두 labelIssued=false로 조회한다. `mutations.ts:298`에서 기록 성공 후 :302 렌디션 호출, :340 실패를 보관한 뒤 :353에서 항상 목록을 재조회한다. `screen.tsx:69`는 최신 목록에서 selectedRow를 찾고 :81,216은 그 행이 남아야 실패 결과를 보인다. 따라서 마지막 미발행 라벨 행은 **PENDING 상태의 렌디션 실패여도 목록에서 사라져 실패 안내·재발행 진입이 함께 사라질 수 있다**. 이것은 소스 연결에 따른 재현 예상이며 UI 실행으로 확정하지 않았다.

서버 labelIssued를 SUCCEEDED로 바꾸거나 PENDING을 숨기는 수정은 이번 권한 밖이며 정본 뜻도 바꾼다. 0단계 기록 규약을 유지하고 root가 **소비자 복구 gap**을 문의/인수목록에 올린다. rendition을 건너뛰는 이번 루틴에서는 특히 ‘P-01-01 업무 완료’를 선언할 수 없다. report만 성공시키거나 자동 FAILED를 만들지 않는다.

반대로 P-04-04 실제 `C/repack-label-issue/use-issue-print.ts:164`는 renditionFailed를 보존하고 `screen.tsx:159`는 방금 발행 id로 다시 미리보기를 연다. :report-print는 `use-issue-print.ts:94,123`에서 동일 보고 키를 유지하고 보고만 재시도한다. 정상 복구 사례가 존재하므로 report operation 전체를 유보할 이유는 없다. `C/pop-material-lot-label/mutations.ts:155`는 매번 새 보고 키라 공용 정상 선례로 삼지 않는다.

A9 귀속6칸·발행자/보고자 분리·PENDING→SUCCEEDED/FAILED만·동일키 replay·다른키 재보고422를 수용한다. worker를 issued_by 계정FK에 넣지 않는다. 결과보고 실패 뒤 동일키 재생200/물리 재인쇄0과 새 회차 최초PENDING/기존FAILED 보존을 필수 체인으로 둔다.

MOLD 소비는 `src/mdm/mold/mold.service.ts:293`가 TOOL_LABEL+MOLD 로그를 전부 세어 :154의 코드 editability에 반영한다. 현재 client `C/tool-master/tool-form-dialog.tsx:329`는 labelIssueCount를 표시한다. PENDING/FAILED라도 잠금이 유지됨을 인수하고, 발행과 코드변경 경합은 초안처럼 실제 writer 잠금 확인 후 root가 결정한다. **print outcome으로 코드수정 잠금을 풀지 않는다.**

## 축 4 — 프린터 목록·단말 구성·미존재·이력 표시

프린터 GET 유보는 **1단계 본길**로 수용한다. 고정 요구서:256이 목록 원천/단말 매핑 미정을 직접 명시한다. root DB 관측의 printer0·매핑표0을 운영 상태 없음으로 일반화하지 않으며, active→READY/OFFLINE·전건default=false·지원 전종 같은 값은 만들지 않는다. A10 5칸을 채우는 것만으로 producer가 생기지 않는다.

실제 `C/shipping-packing-label/printer-select.tsx:52,66,91`은 조회실패/빈목록/선택된 상태를 구분한다. 조회 유보를 항상200 빈목록으로 감추면 ‘등록 없음’으로 오도한다. 한편 printerName=null일 때 ‘서버 기본’이라는 client 설명(:40)은 서버가 프린터를 도출하라는 계약이 아니다. POST는 요청값만 기록하고, 실제 기본 장치 선택은 인수 미완으로 남긴다.

Minor1: 초안 삭제target fallback `TYPE #id`+screenId 생략은 기존 approval 선례를 따르는 0단계 제안으로 수용. `rg -n 'target\.screenId' ../omf-mes-client/apps/web/src --glob '!*.test.*'` 결과는 approval-inbox/iqc-skip-approval만이며 발행 이력의 공용 대상이동 런타임은 찾지 못했다. `C/shipping-packing-label/history-dialog.tsx:39`는 회차/시각/outcome/reason만 표시한다. 그러므로 7종 screenId가 response에 있어도 이동이 실제 동작한다는 증거가 아니다. 없는 상세404·삭제target 이력 유지·유효대상 screenId·삭제target 생략 테스트를 서버에서 한다.

Minor2: `C/shipping-packing-label/queries.ts:300`는 page/size 없이 items만 반환하고, `C/repack-label-issue/queries.ts:224`는 page1 고정 후 page 메타를 버린다. 51+ 이력을 전부 본다고 단정하지 않는다. 서버는 계약 페이징을 유지; consumer 개선은 별도 인계다. lotId 필터에 HU 현재 내용물 역조회를 넣지 않는 초안도 수용한다.

## 축 5 — 단말·권한·헤더·공용파일·예산

M4: 고정 `D/decisions-policy/공유계약.md:2297`은 F-1 적용을 **생산·품질 단말**로 한정하고 :2304는 창고 단말 공정0행이 정상, :2311의 can_print_label 실증은 P-02-05/07/09다. 실제 `C/repack-label-issue/terminal-gating.ts:77`은 공정 행 없으면 false로 내려 P-04-04도 막는다. 이 client의 확장 적용을 서버 정본으로 채택하지 않는다. 반면 P-01-01은 `screen.tsx:83`에서 서버403을 보고만 차단한다. 단말 플래그는 보안경계가 아니라 기능구성(:2295)이고 서버 POST403(:1227)과 동일 개념이라고 단정할 수 없다.

root R은 ① 관리웹 계정/사번 선택/terminal 생략 정상 ② 생산·품질 단말의 확정 공정 축 ③ 창고 단말 공정0행 정상 ④ 각 미확정 출력403 원천을 나누어야 한다. 출하·창고에 임의 공정/첫 공정/any-true를 적용하지 않는다. 본길 원천이 없는 해당 인증 가지는 문자+문의; 잘못된 토큰·입력은 기존 오류로 명시 거부한다. report/GET은 계약403 선언이 없어 추가 등록0 유지한다.

`src/common/permissions/derived-permissions.ts:147`의 POST는 P-04-04 누락. 실제 `C/repack-label-issue/mutations.ts:43`이 해당 POST를 소비하므로 자기 operation의 manual 보강 여부를 root가 확정해야 한다. report derived :148의 화면 두 개만 보고 새403을 만들지 않는다. 공용 AppDomain 자기 등록/동일tx 멱등/actor+worker+terminal 지문·원본targets순서 보존 제안 수용.

## root R 후보·필수 테스트·PR 영향

| 후보(번호 root 소유) | 결정/필수 단언 | 영향 조각 |
|---|---|---|
| R-지원집합 | 9종×7종 매트릭스, 확정 master 정상계정 입력, 미정/잘못된 짝422, nonnull LOT 불일치422 | C1 규칙→C2 심장. MATERIAL 복구와 master writer 보호를 따로 점검 |
| R-client-gap | DELIVERY+LOT/PACKING+LOT 실제 입력 거부와 안내, 미존재summary0을 자격으로 쓰지 않음 | P2/C1 인수자료·문의; client source PR은 이번 서버 PR과 분리 |
| R-부분성공 | 로그PENDING 뒤 렌디션 실패/labelIssued=true·재조회 후 복구, 보고 응답 유실 동일키200, 신규회차/기존FAILED 보존 | P3+C2 체인; 서버 소비자 회귀 테스트를 마지막 관련 PR에 추가 |
| R-단말권한 | 생산·품질/창고/관리웹 분리, 공정0행 창고 정상, P-04-04 전용권한 사용자, report권한추가0, worker계정 분리 | context/권한 자기 줄 별도 커밋+C1/C2; 해결 전 일괄 단말게이트 추가0 |
| R-조회표시 | summary0/1000/중복/문서축·동일 last행, 삭제target fallback/screenId 생략, 기본50/51+, HU lot필터 경계 | P1/P2 각 조회 필드 테스트 |

초안 P0 A9 / P1 목록·상세 / P2 summary / P3 report / C1 규칙 / C2 심장 분할을 유지하되 M1에 따라 C1/C2의 구체 범위를 확정한다. P1t는 초안 기존helper 실측을 재사용한다. 일반 planned350/max400, core 발생 시 PR전체200; 새로운 client 작업이나 권한/복구 변경을 2PR 원안에 묶지 않는다. 미래 diff를 실측이라고 쓰지 않는다.

## 미확인 범위·소유 반환

DB 접속·추가SELECT·DDL·gate·테스트·브라우저/물리 인쇄·디자인 fetch·git/gh 쓰기0. root P1~P4 결과를 읽었고 운영 과거행/A9후 P5는 미확인이다. client는 현재 파일 정적 흐름만 확인했으며 배포 버전·화면 렌더링·소비자 테스트 성공 여부는 확인하지 않았다. `TOOL_LABEL|LOCATION_LABEL|document-issues` runtime 검색에서 master 발행 호출을 찾지 못했으므로 계약의 ‘구현완료’ 주석을 로컬 완료 사실로 적지 않는다. 허용 코드·품질·잠금·권한·물리 변경의 최종 R은 root 소유다.

수정 파일은 이 보고서 하나. **보고서 소유를 root로 반환한다.**
