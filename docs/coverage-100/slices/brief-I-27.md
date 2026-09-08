# I-27 개별 계획 작성 브리프 — 판정 전

개별 계획만 작성한다. 선행 I-26 GET은 #307 MERGED d5979ca·공식353/487, POST는 문의104~107의 필수상태/개체단위 원천 때문에 유보. 기존 serial/LOT/HU의 발행기록은 별도 본길로 판정하며 I-26 전체 성공을 가정하지 않는다. 전체7건 중 rendition은 합의된 건너뜀이다.
현재 main d5979ca·고정계약a6a87e1. 계획 착수 시 README/lanes/lane-B/CLAUDE/I-24/아키텍처와
관련 API·UIUX·통합계획, 출력물 요구서 §3-7·§3-8 및 실제 발행 화면/공유계약 §K를 읽는다.
현재 확인분은 app계약의7건 operation 전건 및 DocumentIssue*/Printer*/PrintOutcomeReport 스키마다.
DocumentTarget 연결스키마·헤더 전건 및 화면은 계획 착수 때 추가 대조해야 한다.

## 반드시 판정할 다섯 축

1. 아홉 documentType과 일곱 targetType의 정확한 짝·발행 자격·LOT 일치/파생.
   불량분 거부422, 기존판정/품목조건 선례와 target별 FK를 대조한다. 조용한 품질추론 금지.
   summary는 요청 targetIds 전건(미발행 issueCount0 포함), 중복입력과 순서·미존재대상을 판정한다.
2. 회차는 documentType+targetType+targetId 축. N<=1000 전량원자성·동일대상병렬첫발행·재발행잠금,
   서로다른대상순서의 데드락 방지, 중복targets, 입력순서응답보존. 사유는 한번받지만 seq>=2행에만
   저장하고 신규에는 null이다. REISSUE_REASON 그룹·값 실제검사, 계약example오염값 재사용금지.
3. 기록과실물 분리. POST는 PENDING 발행기록만, print-report는 SUCCEEDED/FAILED와실패사유필수,
   이미보고된건422. 인쇄실패는 기존기록삭제/되돌림이 아니라 새 회차. 동일키는 같은응답.
   A9는 print outcome/reported at/failure reason 외 사번귀속 칸도 검토한다.
   issued_by는 app_userFK이고 POST WorkerNoOptional/report-print WorkerNoRequired다.
4. 프린터 목록의단말귀속·상태 원천. 물리 app.printer는 plant/code/name/type/URI/DPI/active뿐,
   계약은 terminalId기준·displayName/status/isDefault required·지원documentType목록을 요구한다.
   A10 5칸 외 terminal프린터매핑/관측producer를 점검하고 active를READY라고 추측하지 않는다.
   외부장치poll/프린터실행은 금지. DB에확정저장된상태만읽을수있는지 본길/가장자리 판정.
5. 헤더/권한/공용파일/예산. 발행은 멱등+사번선택, 결과보고는 멱등+사번필수, 명시IfMatch0.
   발행만403선언이므로 report-print/GET에기능권한등록추가금지. app-domain자기등록만.
   멱등callback의동일tx에 업무와응답저장, actor/terminal 귀속을지문에반영할근거확인.
   일반PR예산350/상한400, 코어200. 기존파일실측으로발행조회·summary·마이그·쓰기분할.

물리확인: schema.prisma document_issue_log:182 (issued_by필수FK, uq유형+대상+회차), printer:3879.
과거행필수응답에없는상태를추측해채우지않는다. A9/A10 SQL전문과사전SELECT를계획에담되
적용은3관점R확정후. 삭제/백필0·추가완화만·별도선행커밋.
문의번호는통합자가090~119에서배정. DB는B전용, 계획단계읽기만·시드재실행금지.

## 산출·실측·권한

자기 .backend-dev/lane-b/I-27-draft.md 한파일만 apply_patch 작성. 다섯 축을 §0에 그대로 두고 R는 미판정, operation/schema/헤더 전건표·실제코드접점·SQL전문후보·과거필수NULL배포검사·소비자정본과실제코드의구분·테스트이름·PR일반350/400·core전체200와실측부록표를 넣는다. root가독립3리뷰/통합/문의번호/정본/PR을소유한다. 다른관점보고서읽기0.
현재B DB는55 migrations. I30필드구현자가DDL/E2E독점 lease로사용중이므로DB/DDL/E2E/gates0. DB확인필요SQL을자기초안부록에모아root에요청하고계획미측정을PASS로기록0. source/기존docs/계약/git/ghwrites/새agents0. 설계reference는로컬고정a6a87e1만,fetch/update/check0. 문서·코딩skills필수refs직접완독.
README§2 전문을 직접읽고적용: 0선례. 1본길은문자대로+문의/계약침묵이면해당op유보;가장자리는2단계순서①재고원장상태안쓰기②명시거부③스키마안늘림/nullable④조용한값도출안함⑤새개념적음. 최초기준·오류상수·설계미정단언·문의요청근거를기록. 필수값허위생성/항상실패handler등록0. 번호113~119는I31/I33와중복통합후root만배정;예약·초과번호0.
