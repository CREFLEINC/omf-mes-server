# I-33 독립 3관점 재수립 브리프

개별 계획 .backend-dev/lane-b/I-33-draft.md756줄 전체를 읽는다. root는 전체 읽음, 아직R미판정. 관점 API/UIUX/통합 각각 새컨텍스트 독립보고서이며 다른관점보고서읽기0. 아래다섯축을 계획자가쓴그대로판정한다.

| 축 | 새로 확인한 사실 | 이 초안의 권고·경계 |
|---|---|---|
| ① 툴 사용 입력·시각·누계 | POST가 증분만 받는다. `workOrderId/shotCount/collectionMethodCode/occurredAt/recordedByWorkerNo`는 응답 required인데 기존 물리는 앞의 둘·worker가 nullable, 뒤의 method/time은 없다. `usage_type_code`·`used_from`은 계약 밖 필수다. | A20 nullable4 추가 + 계약 밖 NOT NULL2 완화. 증분과 I-31 리셋은 같은 mold 행 잠금으로 직렬화. 단말 발생시각과 서버 누계 기준시각을 분리한다. 현재 정책 재적용·생산실적 생성·원장·자동 PM 발행 0. |
| ② 검교정·차단·해소 | `CALIBRATION`만 시스템이 이름으로 지목한다. result는 열린 registry; 기존 seed는 PASS/ADJUSTED/FAIL이나 유형·합격계열 메타데이터가 없다. 해소는 토큰 없는 별도 액션이며 응답 ETag도 없다. | POST 전체 보류가 아니라 정상 호출과 미정 분기 분리. 비검교정 등록은 정상 진행; 기본 3값 의미 연결은 재수립 안건, 분류 불명 CALIBRATION 결과만 명시 거부 권고. `:clear`는 이력행 잠금, 상태표0·새 ERROR_CODE0. |
| ③ 수집 채널 5칸·NULL 유일 | 기존 `channel_code(50)/channel_name/data_type_code`는 필수이고 계약은 `channelKey(화면100)`만 필수다. 구 uq는 `(equipment_id,channel_code)`다. 새 품목·공정 조건은 독립 nullable다. | A21 nullable5 추가·옛 필수3 완화. 새 key를 옛 code로 복사하지 않는다. 구 uq 유지 + 새 key 있는 행에 COALESCE 식 유일. 활성 여부는 유일 범위에서 제외. 조건 없는 행과 조건 지정행 공존을 허용한다. |
| ④ 관측의 실제 원천 | `collection_observation`은 실재하나 채널 FK가 필수라 아직 등록되지 않은 신호를 담을 수 없다. `integration_message.payload`는 JSON일 뿐, 채널/값 추출 규약 없음. | 계획 T대로 최소 최근 관측 저장소를 신설한다. 기존 관측·payload를 추정 해석하거나 자동 복사하지 않는다. 수집기/외부 통신0, 빈 DB는 빈 결과이지 원천 정의 부재의 대체물이 아니다. |
| ⑤ 원자성·예산·배포 | `runIdempotent()`는 전달 tx를 버린다. `IdempotencyService.run()`은 실제 tx를 준다. I-30 R5/R15가 actor/worker 재생과 과거 NULL 숨김 금지를 확정했다. | 같은 maintenance 도메인에서 필요한 tx 컨텍스트만 재사용/추가. 일반 브리프≤350·실제400, 코어 전체PR200·선행 독립. 아래 신규 물리/권고 때문에 최초 PR3 추정은 재산정한다. 과거행·구 작성자 배포 판정은 구현 여부와 별도다. |


## 범위·필수읽기·산출물

CLAUDE.md/coverage README(§2전문)/lanes/lane-B/server-architecture/고정contractsCOMMIT과12op·연결schema를직접읽고, CREFLEpr-review/coding-rules및필수refs를직접완독한다. UIUX는design:design-critique도사용하고고정a6a87e1화면과현재client소비자권위를구분한다. .backend-dev/lane-b/I-33-db-observed.md전체원문을재사용:과거54개시점/업무5표0행/70columns22constraints9indexes44comments,root실행·READONLY. 이후A#303CHECK한건으로55/generate6.19.3/drift0통지(보전표DDL변경0)를새실측으로소급0. 현main6bde921official352, I32#306계획정본병합·helper미구현. I26GET동시구현작업소스는I33수정대상아님.

- 초안§0의옛3조건해당문구는README의2026-09-07기본재수립으로수정할문서문제, 실질설계finding과구분. R1~8미판정행을root대신채우지않고독립의견을낸다.
- 부록실측값은재측정하지않는다. 네판정이그값을뒤집으면원천을직접재측정한다. 계획자가보지않은접점·실패조건·조회/쓰기원자성·소비자본길을찾는다. 이름/번역으로유형별결과의미를runtime분류하는구현0.
- 자기보고서 .backend-dev/lane-b/I-33-review-<api|uiux|integration>.md한파일만apply_patch. 코드/DDL/DB/E2E/gates/git/gh writes/외부댓글/번호배정/agents0. READONLY소스명령은가능하지만설계fetch/contractsupdate/check0.
- 다섯축각verdict, Blocker/Major/Minor/Trivial별finding, 원천파일:줄·실패예·README§2단계/최초기준·구체권고·PR분할/단언이름영향. 보고서는질문목록만으로끝내지않으며문제없으면0도허용. 수행안한게이트를PASS로기록0.
- 신설T최근projection·alreadyMapped·무페이지·최신Rev·기본PASS/ADJUSTED/FAIL매핑·CONVERTED제출정수보존은독립검증후통합할후보. 선행통합문서권고/기존값정의가본길을세울근거가있는지와계약이침묵하는것을추측했는지를구분. 정상nonCAL을전체유보하거나master효과를생략한CAL성공위장0.
- I31초안필요§6/8은인계후보일뿐독립3리뷰중. reset구현성공·lastPM미갱신승인으로인용0. I33증분version/CAS접점은고정계약과실제writer에근거. I32canonical R2/R14µs규칙/P0t150은읽기재사용,미병합helperimport0.
- Aquality item_spec삭제보호/MDMreferrers는실제FK와삭제서비스범위로판정. 소유자직접수정/PR변경0. 문의113~119는root가I31과중복합쳐배정,번호초과예약0. 완료후파일소유반환/코드DB0/미완명시.

## README §2 전문

0단계 선례: 계약본문·docs/기존-구현-도메인-규칙.md·이미구현된다른전표. 있으면인용(판단아님).
1단계 본길/가장자리: 특정조건입력만갈리면2단계. 모든호출결과가달라지면임의로못고르고계약문자그대로+문의. 계약도침묵하면해당op건너뛰고사유기록.
2단계 처음걸리는기준순서: ①재고·원장·상태안쓰기 ②명시적에러거부 ③스키마안늘림/늘리면nullable ④조용한값도출안하기 ⑤새개념수가적은쪽.
3단계 이름있는오류/고정값·실제테스트설계미정문의주석·요청서단계/기준기록(번호는root).
멈춤세조건:컬럼/표삭제두릴리스위반·원인불명gate3실패·어느쪽도만족못하는계약명시모순. 특정operation유보/운영수집자미인수는전체루틴중단아님.

## 실측 부록 (초안 그대로)

| 사실 | 원천 파일:줄 |
|---|---|
| 배정12/GET7/POST4/PUT1 | docs/coverage-100/assignment.tsv:233~244 |
| 고정계약전체SHA | contracts/COMMIT.txt:1 — a6a87e144116ebaa32c01df5a12a0fd2924427e7 |
| tool경로·헤더·responses | contracts/equipment-05설비툴.json:2114, :2287 |
| channel경로·detail/PUT·staticobservations | contracts/equipment-05설비툴.json:2330, :2481, :2630 |
| cal경로·detail·clear | contracts/equipment-05설비툴.json:2700, :2882, :2925 |
| ToolUsage12/required7·Create7/required5 | contracts/equipment-05설비툴.json:4580, :4665 |
| Channel18/required4·Create7/Update6 | contracts/equipment-05설비툴.json:4724, :4864, :4918 |
| Observation4/required2·Calibration16/required6·Create12/required4 | contracts/equipment-05설비툴.json:4963, :4989, :5112 |
| WorkerNo max50·ErrorItem/ConflictEnvelope | contracts/equipment-05설비툴.json:3004, :3018, :5280 |
| tool scalar11·oldrequired2/nullable3·new4없음 | prisma/schema.prisma:4282; prisma/migrations/20260826000000_data_model_v4/migration.sql:793 |
| channel scalar15·uqcode·필수3/version존재 | prisma/schema.prisma:4104; 같은v4 migration.sql:807 |
| oldobservation8scalar/registeredFK/onevalue | prisma/schema.prisma:4129; 같은v4 migration.sql:827 |
| cal scalar10/valid_until/uq(equip,date) | prisma/schema.prisma:3205; prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:2065 |
| mold누계/보장/공장/version·equipmentdates/version | prisma/schema.prisma:1940, :1671 |
| 검교정주기/정밀도는이미추가 | prisma/migrations/20260903400000_equipment_calibration_cycle/migration.sql:1 |
| quality item_spec·plan·version 관계와상태 | prisma/schema.prisma:3225, :3277, :3308 |
| 코드2표에attributes/유형별합격분류없음 | prisma/schema.prisma:1599, :1617 |
| calibration result PASS/ADJUSTED/FAIL실제seed | prisma/seed.ts:304 |
| 기관INTERNAL/EXTERNAL·historyCALIBRATION/CHECK | prisma/seed.ts:974, :984 |
| 실제B업무5표0행·코드active/effective NULL·70컬럼/22제약/9index/44주석NULL | .backend-dev/lane-b/I-33-db-observed.md:1 — root실행·2026-09-07 10:56:58UTC·READONLY exit0 |
| I31독립초안mold잠금/reset/version·PM미정 | .backend-dev/lane-b/I-31-draft.md:421, :433, :485, :667; root허가뒤선택절직접읽음·미승인 |
| I31DB결과코드값0과mold0은I33결과그룹3값과다름 | .backend-dev/lane-b/I-31-db-observed.md:1 — root실행·10:54:30UTC·선택관련출력읽음 |
| I32 canonical R2/R14·epochµs/ISO0→1BC/윤초·예산150 | docs/coverage-100/slices/I-32.md:27, :39, :325, :343, :816 — root #306병합통지후직접읽음 |
| 실제멱등callbacktx·response동일commit | src/common/idempotency/idempotency.service.ts:64 |
| master-write callbacktx버림·codechecker PrismaService타입 | src/common/master/master-write.ts:27; src/common/master/code-reference.ts:24 |
| pageclamp1/50/200 | src/common/pagination/pagination.ts:14 |
| 조회calendar·NULL선검사·count/page동일tx 선례 | src/maintenance/inspection/inspection-query.service.ts:1; src/maintenance/maintenance-calendar.ts:1 |
| 공개오류목록·P2002/P2003번역·Error500 | src/common/errors/error-codes.ts:1; prisma-error.ts:1; error.filter.ts:1(동일errors폴더) |
| derived403 네쓰기모두존재 | src/common/permissions/derived-permissions.ts:193, :194, :201, :267 |
| permission은선언403만·authentication은세션 | src/common/permissions/permission.guard.ts:66; src/auth/authentication.guard.ts:1 |
| CORS에Worker헤더없음 | src/common/http/cors.ts:1 |
| EQUIPMENT_REFERRERS20 / PROCESS_REFERRERS16 | src/mdm/equipment/equipment.service.ts:12; src/mdm/process/process.service.ts:25 |
| item ERP원본잠김/referenceCount=null | src/mdm/item/item.service.ts:65 |
| 신규qualityRev=DRAFTmax+1·GET상태무관 | src/quality/inspection-plan/inspection-plan-version.service.ts:116, :301 |
| spec삭제보호가현재measurement만검사 | src/quality/inspection-plan/inspection-plan-version.service.ts:457 |
| 실제tool추가원천·IfMatch0·rawWorker·until-applied | ../omf-mes-client/apps/web/src/screens/tool-usage/mutations.ts:1 |
| client반올림임시Math.round·양수입력·offlinebutton차단 | ../omf-mes-client/apps/web/src/screens/tool-usage/conversion.ts:87; usage-draft.ts:1(같은screen폴더) |
| actualreset은moldGET토큰·nonreset도토큰 | ../omf-mes-client/apps/web/src/screens/tool-pm-result/queries.ts:1, :133; result-draft.ts:146 |
| actualcalPOST에IfMatch없음·PASS만preview | ../omf-mes-client/apps/web/src/screens/gauge-calibration/queries.ts:89; form-draft.ts:82 |
| channelactual필터/200상한·observationsquery2 | ../omf-mes-client/apps/web/src/screens/collection-channel/queries.ts:106, :397 |
| alreadyMapped선택차단·observedAtoffset전제 | ../omf-mes-client/apps/web/src/screens/collection-channel/observation.ts:15, :97 |
| P0501 증분·보장NULL허용·폐기거부·중복unique0 | .design-reference/omf-mes/design/wiki/screens/05/P-05-01-툴사용실적타발수입력.md:138, :142, :180, :225 |
| W0510 유형별합격·같은tx·uq유형확장·수정0 | .design-reference/omf-mes/design/wiki/screens/05/W-05-10-계측기검교정이력등록.md:138, :151, :185 |
| W0511 계측기정체성과calibration_required별개·차단식 | .design-reference/omf-mes/design/wiki/screens/05/W-05-11-계측기마스터관리.md:1 — 전건읽기 |
| W0507 조건NULL/unique·구Rev·단위경고·원천문의 | .design-reference/omf-mes/design/wiki/screens/05/W-05-07-수집채널매핑관리.md:1 — 전건읽기 |
| 기존I33초기3PR/V/T·UIUX결손추정·새오류명 | docs/coverage-100/plan.md:69, :137; plan-uiux.md:497, :505, :514, :603; plan-api.md:917, :1071(동일coverage폴더) |
| 위원칙5축/숫자/게이트·중단범위 | .backend-dev/lane-b/brief-I-33.md:24; docs/coverage-100/lane-B.md:112, :156, :193 |
