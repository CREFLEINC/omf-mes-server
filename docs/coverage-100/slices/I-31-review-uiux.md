# I-31 독립 재수립 — UI/UX

대상: `.backend-dev/lane-b/I-31-draft.md` 753줄. **Blocker 0 / Major 2 / Minor 2 / Trivial 0.** 구현 PR 승인이나 실행 검증 결과가 아니다. 정상 미마감 기록·수정은 진행하고, 마감 의미와 PM 날짜 효과를 제외한 범위를 실제 화면 완료로 부르지 않는다는 구분을 유지한다. reset=true의 반쪽 효과 성공안은 수정 권고한다.

## 1. 근거와 읽기 범위

- 브리프 전체, CLAUDE.md, README 전체(§2 전문 포함), lanes.md/lane-B.md 전체, server-architecture 전체, 기존-구현-도메인-규칙 전체, 팀 프로토콜을 직접 읽었다. 계획안은 구간별로 1~753줄 전체, DB 관측 원문도 전체 읽었다. 다른 I-31 관점 보고서는 읽지 않았다.
- design:design-critique, CREFLE pr-review/coding-rules SKILL 전체와 checklist/severity/review-comment template, TypeScript/React/commit-convention refs 전체를 직접 읽었다. 이번 위임의 파일만 작성·외부댓글/머지 금지가 스킬의 게시·머지 절차보다 우선한다.
- 계약 `COMMIT.txt=a6a87e144116ebaa32c01df5a12a0fd2924427e7` 확인. equipment-05의 8operation(902~1580), 헤더(2974~3004), Item/Input/Trigger/Order/Create/ResultLine/Part/Result/Create/Update/PageMeta(3537~4255), ConflictResponse(5280~끝)를 직접 읽었다. 필드 수를 재계수하지 않았다.
- 고정 `git show a6a87e1`의 W-05-02/03/05/06 네 화면 전체를 읽었다. 아래 `고정 W-…:줄`은 그 커밋의 `design/wiki/screens/05/` 실제 파일을 뜻한다. W-05-02의 a6a87e1→46f0ef5 diff도 직접 읽었으며 최신 snapshot 대체·대표축·원자중복 문구를 고정 권위로 채택하지 않았다.
- 현재 client는 maintenance-order의 lookups/order-draft, tool-pm-order의 order-draft/queries, maintenance-result의 draft/queries/lookups/types와 screen 관련 구간, tool-pm-result의 draft/queries/types와 screen 관련 구간·ko 문구를 직접 읽었다. 런타임 화면·색 대비·키보드 동작은 관측하지 않았다.
- 서버는 부여 resolver/교체 writer, mold 파생 전체, 멱등 callback, result/order 물리 모델, spare/GI 단위·참조집합 경계를 직접 읽었다. I-30 정본 R9/R13/R14/R15와 I-32 정본 R14·µs·summary 관련 절을 대조했다. 통합 정본을 다른 관점 리뷰 보고서로 대체하지 않았다.
- 기준 main `6bde921`/공식352는 root 통지다. #306 I-32 **계획 정본** 병합과 µs helper **구현 미완**은 다르다. DB 원문은 2026-09-07 10:54:30 UTC, f521a89·당시54 migration의 개발 DB 관측이다. root의 이후55 migration/generate6.19.3/drift0는 별도 통지이며 보전 DDL 변경0이다. 4표0행은 운영 구행 없음이나 기능 성공의 증거가 아니다.

## 2. 다섯 축 판정

| 축 | UI/UX 독립 판정 · 최초 기준 · 영향 |
| --- | --- |
| 1. ⭐ 실적 마감의 의미와 정상 성공 경계 | **핵심 동의.** O7/O8에는 closed=false/생략의 정상 기록·편집이 있다. 고객 결과코드 명칭을 DONE/NA로 해석하지 않는다. closed=true는 특정 입력의 가장자리로 §2 2단계 최초① 상태를 쓰지 않고 422/INVALID field closed로 거부. 화면의 지시완료 흐름 전건은 미완이다. 빈 lines 저장 성공과 빈 lines로 마감 성공을 구분한다. |
| 2. ⭐ A16~19 밖의 물리 결손과 구행 | **동의.** 다중 촉발·진행중 종료null·직접 고장·app_user 수행자·외주 자유이름을 기존 NN/worker FK에 맞추려고 입력을 왜곡하지 않는다. 0단계 계약 우선으로 추가/완화, 필요한 새 구행 칸은 ③ nullable. 결과 target의 equipment/mold FK쌍과 참조보호를 함께 둔다. 구행500을 빈목록/가짜이름으로 숨기지 않되 실제 환경 배포검사는 별도다. M1/M2→Q1/Q2 전필드 단언 유지. |
| 3. ⭐ 대상·원천·부여·스냅샷 | **조건부 동의.** 0단계 같은 대상·effective 부여·MOLD 자유이름을 유지. 부여목록과 전체 마스터목록은 다르며 현재 client 전체목록은 서버 완화의 권위가 아니다. stale snapshot 명시 거부는 가장자리②, 생략 nullable은③. BOTH의 SHOT은 기존 문의4/O-5 잠정 선례이며 실제 선후를 입증하지 못한다. source 재발행 거부는 API 정책 후보로 남기되 N:M 자체를 물리1:1로 바꾸지 않는다. |
| 4. ⭐ tx·잠금·reset·날짜 | **수정 필요(F1/F2).** 동일 tx, target→order→result 순서, 취소/등록 공유잠금, POST 툴 ETag·PUT 실적 ETag는 동의한다. 그러나 lastPM 효과를 유보한 reset=true 정상201을 최종안으로 승인하지 않는다. 최소 reset=true 분기 거부로 좁히고 nonreset 기록 본길은 유지한다. 시작일의 브라우저 offset이 공장 시행일이라는 가정도 성립하지 않는다. |
| 5. ⭐ 예비품 참조·횡단 코어·실측 PR 크기 | **기본 동의 + 인수 보강(F3).** 출고 참조·재고/LOT/출고 생성0은 0단계 확정. 단위 모호 시 null은 거짓 단위 선택을 피하는 조회 표현이지 수량 의미·편집 인수 성공의 증거가 아니다. C1/C2는 실제 MDM+maintenance 두 소비자만 추출, 일반350/400·core PR 전체200 유지. W2p의 실제 reset 쓰기는 F1 해소 뒤 조건부로 이동한다. |

## 3. 버그 / 정확성

### F1 — Major: 날짜 효과를 남겨 둔 reset 성공은 PM 주기 갱신을 반만 수행한다

**근거:** 초안:443,491,512,659~660. 고정 `W-05-03-툴PM실적등록.md`:6은 리셋 시 마지막PM일자·누계 갱신, :138은 시행일→마지막PM일자, :165는 두 master 값을 갱신하는 확정안을 둔다. :168의 차기 판정은 두 값을 함께 사용한다. `src/mdm/mold/mold-derivation.ts`:129~148은 기존 lastPM+주기 날짜가 도래하면 누계가0이어도 BOTH/DATE 도래를 유지한다.

**실패 예:** BOTH 툴의 마지막PM=2026-03-01·주기6개월·현재513180, 2026-09-07 실적에서 reset=true/after=0/closed=false. 초안이면 실적201·누계0·lastPM=03-01이라 날짜 도래는 그대로다. 이후 같은 오더는 오더당1회 리셋을 이미 소비했고 PUT에는 reset/시행일 변경 칸도 없다. 날짜 효과를 추후 별개 저장으로 복구할 경로도 이8건에는 없다. 문서에 ‘PM 완료 미완’을 적는 것만으로 이 업무 상태의 반쪽 커밋이 해결되지는 않는다.

**§2 절차:** 0단계에는 날짜+누계 갱신 요구가 있지만 API 시행일 원천·나눠시행 시점은 미결이다. 1단계는 O7 전체가 아니라 reset=true PM 효과 분기다. 2단계 최초①에 따라 미정 상태효과를 일부만 쓰는 안보다 **해당 입력 전체를 업무쓰기 전에 명시 거부**한다. ②는 422/INVALID로 표현하는 후속 선택이다. `UNRESOLVED_PM_DATE_EFFECT` 같은 내부 사유 이름, field resetCounter를 사용하고 새 ERROR_CODE를 추가하지 않는다.

**권고:** 즉시 안은 reset=true를422, closed=true를 기존대로422. 정상 EQUIPMENT·MOLD nonreset 미마감 실적 기록/편집은 유지하고 차기 PM 완료 인수는 미완으로 둔다. 시작/종료/예정/서버오늘 중 하나를 임의 시행일로 고르지 않는다. 나중 허용안은 시행일 원천·nonreset 적용 여부·1:N 갱신 시점·역행 입력 처리와 날짜/누계/버전/실적의 단일 tx를 함께 확정해야 한다. 현 client의 ‘시작일’도 F2 때문에 공장 시행일을 입증하지 못한다.

**PR/단언:** W2는 정상 nonreset+reset 명시거부를 인수하며 +1 후보 유지. W2p의 누계치환 실행부와 E-R21/23/24의 성공 단언은 날짜 해소 뒤 조건부 묶음으로 둔다. E-R28을 `미정 reset 요청은 result/parts/counter/lastPM/version/멱등완료 전부 쓰지 않는다`로 바꾼다. 향후 성공은 BOTH 날짜도래→갱신·기준일역행·부분시행·재생의 전후 master 값을 검증한다. 정상 미마감 전체를 거부하는 단언은 금지한다.

### F2 — Major: 입력 날짜의 시간대와 응답 표시의 시간대가 모두 공장 기준과 분리돼 있다

**근거:** 초안:411의 µs UTC projection, §4의 공장별 시작일 필터. client `maintenance-result/screen.tsx`:136과 `tool-pm-result/screen.tsx`:163,507은 `-new Date().getTimezoneOffset()`를 toCreateBody에 넘긴다. 두 draft의 toMoment는 그 offset 자정을 만든다. `maintenance-result/types.ts`:98 및 `tool-pm-result/types.ts`:88의 formatMoment는 offset을 변환하지 않고 문자열 앞 16자에 해당하는 날짜/시간만 사용한다. 호출자는 각각 screen:145~146/:172~173이다. 고정 W-05-06 §4/§5-4는 실제 수행 구간, W-05-03:138은 시행일이다.

**실패 예:** 하노이 브라우저에서 09-07 입력→`09-07T00:00+07`→서버의 정확한 UTC 응답 `09-06T17:00Z`→현 화면은 `09-06 17:00`을 표시한다. 한국 브라우저에서 같은 툴·09-07을 고르면 `09-07T00:00+09`가 돼 공장 날짜로는09-06 22:00이다. 따라서 이 값을 lastPM로 도출하면 사용자가 입력한 시행일과 하루 어긋난다. 두 사례는 소스 조합의 재현 논증이며 브라우저 실행 결과라고 주장하지 않는다.

**§2 절차/권고:** 0단계 CLAUDE의 `plant.timezone_code`와 기존 공장 달력 선례, 계약 date-time의 동일 instant 보존을 적용한다. UTC 직렬화를 client 문자열 자르기에 맞추려고 바꾸거나 server가 입력 시각을 재해석하지 않는다. 입력 공장 날짜→instant 및 조회 instant→표시공장 날짜/시간을 client 인수로 명시하고, 시행일 별도 의미는 F1 문의에 연결한다. API 전체의 본길 유보 사유는 아니다. 새 날짜컬럼/offset 헤더를 만들지 않아 2단계 신규정책 선택은 불필요하다.

**PR/단언:** T/Q2/W2/W3는 동일 instant·µs 보존 단언을 그대로 유지한다. 여기에 `UTC 응답을 공장 시간으로 표시`, `한국 브라우저와 하노이 브라우저에서 같은 대상 시행일`, `시작일 필터와 표시 날짜 일치`를 소비자 연결 인수로 추가한다. client 수정 권한은 이 위임에 없어 인계만 한다. API 게이트 성공으로 이 화면 인수를 PASS하지 않는다.

## 4. 보안

추가 발견 없음. 입력 actor와 수행자/담당자를 분리하고 실제 세션 actor로 멱등 지문을 묶는 계획, 쓰기4 권한·GET403 미선언·PUT 소유화면 보완 방향은 유지한다. `IdempotencyService.run`의 전달 tx 확인은 실행 보안검증 PASS가 아니다. 계정별 멱등 재생과 권한 단언은 구현 PR에 남는다.

## 5. 테스트 / 화면 인수

### F3 — Minor: 예비품의 nullable 단위·표시·편집을 별개 인수 행으로 고정해야 한다

**근거:** 초안:461/E-R13은 다중 단위→null을 정했지만 client `maintenance-result/lookups.ts`:110~160은 예비품 이름과 GI 헤더만 읽고 `screen.tsx`:404~429의 수량·GI 선택에는 단위 표시가 없다. 같은 screen:176~179는 저장 후 예비품 **건수**만 렌더한다. types:84~92에 partName/usedQty/GI번호/출고시각/uom을 보유하는 것은 표시 성공이 아니다. queries:112는 POST이며 결과 상세/PUT 연결이 없다. `src/mdm/spare-part/spare-part.service.ts`:17~25의 public view에는 base_uom이 없고 Prisma:4412의 nullable 물리칸을 client가 조회할 수 있다고 가정할 수 없다.

**실패 예:** 수량2를 적은 뒤 GI를 EA 출고에서 BOX 출고로 바꿔도 현재 입력 화면은 숫자2만 보인다. 저장 후에도 ‘예비품1건’이라 잘못 고른 출고·단위·수량을 확인하지 못한다. 하나의 GI+spare에 EA/BOX 두 단위면 서버 null은 정직한 불명 표시지만, ‘2 EA’나 환산 합계로 해석할 수 없다. API PUT이 있어도 현 화면에서 이를 정정하는 흐름은 없다.

**§2 절차/권고:** 0단계 readOnly uom·출고참조만·PUT5필드 계약 유지. 불명 단위 조회는 가장자리③ nullable/④ 조용한 단위 도출0이며, 이 때문에 모든 parts 쓰기를 차단하지 않는다. 계약에 없는 수량환산·재고 quota·단위 입력필드를 신설하지 않는다. 단위가 바뀌는 출고 재선택과 저장량 의미는 명시 인수로 남기고, 미정일 때 화면이 단위 확인 불가를 알리도록 인계한다. 정상 단일단위 참조와 GI없는 nullable 사례를 구별한다.

**PR/단언:** Q2의 part7 전필드/다중uom null/미연결 null 단언, W3의 omitted 보존·[] 교체·실패 rollback은 유지한다. 연결 인수에 `예비품명·수량·단위·GI번호·출고일 표시`, `GI 변경 때 수량 단위 확인`, `GETdetail→실적ETag→PUT→GETdetail`, `reset 과거 실적 편집으로 누계 재실행0`를 추가한다. API 예산을 client 개선으로 부풀리지 말고 서버+소비자 인수 상태를 나눈다. 이미 초안에 기록된 PUT 미사용을 새 서버 결함으로 중복 계수하지 않는다.

완료 인수 행은 최소한 ① 정상 미마감 저장 ② 미마감 편집 ③ closed 마감 ④ PM 날짜/누계 기준 갱신 ⑤ 원천 선택/부여 적합 ⑥ 예비품 확인/정정으로 나눈다. ①이 성공해도 ③④는 미완일 수 있다. 현재 무지시 EQUIPMENT의 breakdown 미전송, MOLD의 오더없이 처리 문구, 두 화면의 lines 미입력, 장비 전체항목 lookup은 초안이 이미 찾은 소비자 불일치로 그대로 인계한다. 부여 없음/코드 없음은 사유·재조회·마스터 진입을 보이고 API 실패를 성공 toast로 바꾸지 않는 인수가 필요하다.

## 6. 컨벤션 / 가독성

### F4 — Minor: I-32의 역사적 상태 문구를 정본 기준으로 교체한다

초안:411,495,639,747의 I-32 draft/ignored-only 표현은 #306 뒤 현재 상태가 아니다. `docs/coverage-100/slices/I-32.md`:39,325~351,816의 R14·µs 준비·summary 정책을 현재 정본으로 인용한다. **계획 병합**을 helper 구현 병합으로 바꾸지는 않는다. 실패 예는 root가 이미 정본화한 µs 규약을 새로운 독립 후보로 다시 정의하거나 T를 중복 구현하는 것이다. §2 0단계 최신 정본 선례를 인용하는 정정이며 새 정책·번호·테스트는 필요 없다. T 실제 구현 순서만 조율한다.

스타일·구조는 역할별 파일, 공개 타입, named policy, 신규 layer 제한을 유지한다. 판단용 문서 검토라 새 TS/React diff의 lint 통과나 runtime 접근성 성공을 단언하지 않는다. 스킬의 비평 틀은 특히 액션 성공의 의미·정보 확인·오류 복구를 점검하는 데 사용했고, 시각적 대비와 터치 크기는 미측정으로 남겼다.

## 7. 통합 권고와 소유 반환

F1을 R에 먼저 결정하고 §2/§6-3/§8-2/§9/E-R28/§10 W2p·W2를 같은 방향으로 고친 뒤 구현한다. F2는 날짜 입력 원천과 표시 인수, F3는 예비품 단위 확인·편집 인수에 통합한다. 원천/부여/후기 snapshot 권위와 closed=false 정상 본길은 유지한다. 문의111은 완료 실체/시각 문제로 유지하고 PM 날짜와 혼합해 닫지 않는다. 신규 문의번호113~119 배정·기존 문의 중복 통합은 root 소유다.

**이 보고서 소유를 root에 반환한다.** 작성 파일은 `.backend-dev/lane-b/I-31-review-uiux.md` 하나다. 코드/계약/DB/E2E/게이트/git·gh 쓰기/외부댓글/번호배정/추가 agent 생성 모두0. 구현·운영 구행·브라우저 연결 인수는 미완이며 실행 PASS를 주장하지 않는다.
