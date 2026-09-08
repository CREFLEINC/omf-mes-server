# I-27 독립 3관점 계획 리뷰 브리프

최신 main #308 MERGED 4fadf3184ac2edb214a71e511b373d29ebe412c5 /353, 계약a6a87e1 고정. 이번은 계획 검토이며 source/DDL/실행/gates0. 읽기 대상 `.backend-dev/lane-b/I-27-draft.md` 전체 + `.backend-dev/lane-b/I-27-db-observed.md` 전체. 아래 다섯은 개별계획 §0 그대로이며 다른 판정항목을 재설계하지 않는다. 자기 관점에서 본길/가장자리·의존·예산을 뒤집는 빈칸을 찾는다.

## 반드시 볼 자리 5

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


## 방식/규칙

- README §1-2 기본3관점, §6-1 실측 부록은 재측정하지 않는다. 판정이 뒤집는 경우만 원천을 직접 다시 읽고 정확한 파일:줄을 적는다. 원문463줄+root DB보완이며 root는 전건 읽었다.
- full CLAUDE.md, docs/coverage-100/README.md,lanes.md,lane-B.md,server-architecture.md, docs/기존-구현-도메인-규칙.md. CREFLE coding skill `/Users/rangkim/.codex/plugins/cache/crefle/crefle-agent-skills/0.1.0/.agents/skills/coding-rules/SKILL.md` 및 요구 references 전체. 문서계획 변경검토는 engineering documentation skill도 사용. 계약/고정설계는 읽기 전용이고 contracts:update/check·design fetch금지.
- README§2 전문: 0단계 계약본문·기존구현규칙·다른전표의 선례 있으면 인용. 1 가장자리만2로, 본길은 계약 문자+문의;계약침묵시 해당operation유보. 2 최초 걸리는①재고/원장/상태 안쓰기②명시거부③스키마안늘림/nullable④조용한도출없음⑤새개념수 적음. 3 namedcode/fixedvalue·test 문의주석·요청서에 단계/기준 기록. 이 절차를 '보수적'이라는 말로 대신하지 말 것.
- 코드/문서 판정은 actual frozen contract/source 증거로. 최근client는 소비자 인수증거지 계약 대체권한아님. 적합한 현재 정상가지가 있으면 POST전체유보와 특정 입력거부를 구분해 추천한다. 모순 자체는 숨기지 말 것. 판정 확정/root R표 편집은 root만 한다.
- src/prisma/test/schema/정본/docs/다른리뷰 수정0. 자기 `.backend-dev/lane-b/I-27-review-{api|uiux|integration}.md`만 apply_patch로 작성. git/ghwrites/외부댓글/새agent0. DB/E2E는 I-30③ 구현자 lease이므로 접속0, 추가 SELECT가 필요하면 root에게 SQL만 요청. 테스트/gate0.
- 일반 PR planned350/max400의 비테스트added+deleted -w. core 전체200 별도. 미래diff를실측으로포장0. 허용집합/물리/본길/권한/잠금 변경은 root R先행요청.

## 관점 역할과 산출

API: 5축 전부 중 operation/schema/required/printOutcome/summary/정확한doc-target짝/정밀도·오류/귀속·멱등 집중. UIUX: 5축의 고정화면과 **실제 client** 요청/복수선택/실패/미존재표시/단말결손·기존소비자체인 집중(개별계획이 실제client는 아직 못본 자리). Integration: 5축의 DB A9/기존FK·index/CHECK/구행배포·실제writer잠금·선채번불필요·1000원자성/공유소유/실측예산 집중.

각 보고서: B/M/Minor요약, 5축별 판정, 본길/가장자리 및 단계 최초기준, root가 고칠R후보/필수테스트/영향PR분할, 자기원천 파일:줄, 미실행/미확인 범위. 다른 관점 보고서 읽기0(새컨텍스트 독립). 한 관점이 '원천없음'을 봤다는 이유로 다른부문의 정상경로까지 무조건 유보하지 않는다. 없음도 rg결과/해당정본문구 등 증거를 제시한다.
