# I-31 독립 3관점 재수립 브리프

계획: .backend-dev/lane-b/I-31-draft.md 753줄 전체. 독립 계획 완료본이며 root는 전체를 읽었지만 아직 R 통합하지 않았다. 관점별 새 컨텍스트에서 API / UIUX / 통합 각 한 보고서만 작성한다. 이전 관점의 보고서는 읽지 않는다. 판정 대상은 아래 다섯 축을 그대로 사용한다.

| 축 | 계획자의 판정 / 뒤집힘 영향 |
| --- | --- |
| 1. ⭐ 실적 마감의 의미와 정상 성공 경계 | `closed=false/생략` 실적 기록·수정은 정상 성공 본길이다. 고객 확장 결과값을 완료/해당없음으로 해석하는 원천은 없다. `closed=true`만 422로 명시 거부하는 가장자리 안을 제안한다. 화면의 지시 완료 흐름 전건은 미완이다. 이것만으로 POST/PUT 전체를 유보하거나, 반대로 완료 화면까지 끝났다고 쓰지 않는다(§2·§8). |
| 2. ⭐ A16~19 밖의 물리 결손과 구행 | trigger order UNIQUE가 배열을 막고 int32 두 칸이 int64와 다르다. result는 order/종료/구 동작 코드·설명/종합 결과/순번 NOT NULL이며 사용자 칸은 worker FK다. 신규 nullable/완화, FK 역참조, 구행의 required NULL 오류를 한 묶음으로 검토한다. 결과 대상은 다형 target_id 한 칸 대신 기존 order와 같은 equipment/mold FK 쌍을 제안한다(§3). |
| 3. ⭐ 대상·원천·부여·스냅샷 | 여러 촉발을 한 지시에 담되 다른 대상 혼합 0. EQUIPMENT 유효 부여의 가장 가까운 층을 사용하고 MOLD 자유 이름을 보존한다. PM ‘먼저 도달’은 기존 문의4/O-5가 열려 있다. 최신 화면의 서버 최신값 대체/중복 거부 문구는 고정 커밋 후 변경이므로 조용히 채택하지 않는다(§1-3·§5). |
| 4. ⭐ tx·잠금·reset·날짜 | 멱등 callback의 동일 tx를 끝까지 사용한다. 지시 취소와 실적 등록은 지시 행, 툴 reset은 툴 행을 공통 순서로 잠근다. POST If-Match는 reset 시 **툴** ETag, PUT은 **실적** ETag다. reset의 전후 스냅샷은 확정이나 마지막 PM 날짜/나눠 시행의 갱신 시점은 별도 판정이 필요하다. 이를 finishedAt/완료 집계 시각으로 확대하지 않는다(§6~8). |
| 5. ⭐ 예비품 참조·횡단 코어·실측 PR 크기 | 예비품은 출고 참조만: posting/잔량/LOT/출고 자동 생성 0. 부여 탐색·PM 파생을 공유하면 실제 두 도메인 사용처가 있는 최소 core만 추출하고 A와 조율한다. 3PR에는 물리/응답 전건/동시성 테스트가 들어가지 않는다. §10은 준비 조각과 실제 op를 분리하고 일반 목표350·상한400, core PR 전체200을 지킨다. |



## 책임·범위

- CLAUDE.md, docs/coverage-100/README.md(특히 §2 전문), lanes.md/lane-B.md, server-architecture, pinned contracts/COMMIT.txt 및 해당 8operation/연결schema, CREFLE pr-review SKILL.md 및 필수refs/coding-rules를 직접 전부 읽는다. UIUX는 design-critique skill을 추가 사용하고 고정 a6a87e1 화면과 현재client 관찰을 분리한다.
- 현재 main 기준 6bde921ebdd4a7c32f1a672484ec5a29964b8a20, #305점검GET2/#306I32계획 MERGED, 실제352/487. I32 canonical docs/coverage-100/slices/I-32.md937줄의 R14/µs/summary가 새 정본. 초안의 I32ignored-only/모듈미병합 표기는 역사적 상태이며 업데이트 대상으로 따로 표시하되 주요 설계결함과 혼동0.
- DB 실측은 .backend-dev/lane-b/I-31-db-observed.md 전체를 읽어 재사용. 관측당시54migration·업무4표0. root가 이후 A #303 CHECK한건을 BDB에적용:55migration/generate6.19.3/drift0,quality.inspection_result만CHECK,보전DDL변경0. 원래 관측을 최신 실측으로 고쳐쓰지 않는다.
- 아래 실측 표 값은 재측정하지 않는다. 단 네 판정이 값을 뒤집는다면 반드시 실제원천을 재측정한다. 계획자가 보지 않은 자리·경계·소비자·FK·트랜잭션을 찾는다. 전건 코드재계수/DB중복측정0.
- 코드를 구현/수정하지 않는다. DB·E2E·게이트·git/gh writes·외부댓글·계약변경·번호배정·다른agent생성0. 자기 .backend-dev/lane-b/I-31-review-<api|uiux|integration>.md 파일만 apply_patch로 쓴다. 실제파일을 읽기만 한 것을 검증PASS로쓰지 않는다.
- 문제는 Blocker/Major/Minor/Trivial 구분, 근거 파일:줄+실패 예시+README §2 단계/최초 기준+통합 권고+PR 분할/테스트영향. 각 다섯 축 verdict와 source-read 범위를 명시. findings0도 가능하며 질문만 나열하는 리뷰0. 본길/가장자리 분류는 operation 전체와 특정 UI완료흐름을 구별. 닫힘 의미누락으로 정상미마감쓰기 전체를 전건거부하거나, 상태효과를 몰래생략하고 화면완료로 위장하지 않는다.
- fixed contracts만 API권위, 로컬설계gitshow a6a87e1 가능/fetch·contracts:update/check금지. newer문구는후기변동으로만표시. source현재누계update writers, 등록/참조집합은 관련경계만확인.
- 보고서 종료시 파일소유반환·코드/DB/git0·미완/불확실명시. root만 R통합/문의113~119배정/정본PR/구현배정.

## 루틴 §2 전문

0단계 — 선례: 계약 본문·docs/기존-구현-도메인-규칙.md·이미 구현된 다른 전표. 있으면 인용(판단 아님).
1단계 — 가장자리/본길: 특정 조건에서만 갈리면2단계. 모든 호출의 결과가 달라지면 임의로 못 고른다. 계약 문자 그대로+문의; 계약도침묵하면 해당operation건너뛰고사유기록.
2단계 — 처음 걸리는 기준으로: ①재고·원장·상태를 쓰지않는쪽 ②명시적에러거부(거부→허용호환완화) ③스키마안늘리기,늘리면nullable ④조용한값도출안하기 ⑤새개념(테이블·상태값·코드그룹·전이)수가적은쪽.
3단계 — 흔적: 에러/고정값에이름,단언테스트에설계미정문의번호,요청서에단계/기준기록. 번호는root배정전임의생성0.
전체루틴멈춤은 컬럼/표삭제두릴리스위반·원인불명gate3실패·동시에충족불가능한계약모순뿐. 문의가있다고전체중단0.

## 실측 부록 (초안 그대로)


| 사실 | 원천 `파일:줄` |
| --- | --- |
| 배정8, GET4/write4, I30=별도9 | docs/coverage-100/assignment.tsv:210, :219 |
| queryorders8/result7, detailETag2, writeheaders/status | contracts/equipment-05설비툴.json:902, :1101, :1153, :1232, :1350, :1429, :1485, :2974 |
| Item/Input/Trigger/Order/Create全schema | contracts/equipment-05설비툴.json:3537, :3576, :3606, :3668, :3784 |
| ResultLine/Part/Result/Create/Update全schema | contracts/equipment-05설비툴.json:3858, :3897, :3958, :4089, :4202 |
| PageMeta3required / ConflictResponse2required | contracts/equipment-05설비툴.json:4236, :5280 |
| ResultLine 고객확장/대상별뜻·readOnly3parts | contracts/equipment-05설비툴.json:3888, :3940 |
| order18scalar·workerFK·trigger0..1 | prisma/schema.prisma:4210 |
| result11 scalar·order/종료/action/결과/seq필수·worker FK | prisma/schema.prisma:4242; prisma/migrations/20260826000000_data_model_v4/migration.sql:742; root DB 관측44칼럼 표 |
| item6scalar·master/free쌍·sequnique | prisma/schema.prisma:4669; prisma/migrations/20260901080000_maintenance_lines_and_judgment_control/migration.sql:30 |
| trigger9scalar·orderUNIQUE·snapshotint32 | prisma/schema.prisma:4688; 같은 migration.sql:60 |
| moldPM/targetpair는이미물리추가됨 | prisma/migrations/20260904160000_mold_pm_and_maintenance_target/migration.sql:1; prisma/schema.prisma:1940 |
| resultline/part 물리없음은Prisma/migration 전건rg 결과 | prisma/schema.prisma:4242 및 prisma/migrations/ 전체 `maintenance_result_line|maintenance_result_part` 검색 |
| 결과코드seed values[]·order/item/trigger분리 | prisma/seed.ts:1089, :1101, :1113, :1124 |
| 보전타입MAINTENANCE실재 / order entity_type 실재 | prisma/seed.ts:885, :1368; contracts/equipment-05설비툴.json:3187 |
| code_value에완료/대상매핑칼럼없음 | prisma/schema.prisma:1599, :1617 |
| spare단위nullable·GIspare라인단위별 | prisma/schema.prisma:4407, :4727 |
| spare/equipment/mold referrer명시집합·DB 대조테스트 | src/mdm/spare-part/spare-part.service.ts:12; src/mdm/equipment/equipment.service.ts:12; src/mdm/mold/mold.service.ts:28; test/mdm-spare-part.e2e-spec.ts:105; test/mdm-mold.e2e-spec.ts:115 |
| 효과부여는가장가까운층·직접부여우선·parent탐색 | src/mdm/equipment/inspection-assignment.service.ts:127 |
| PMnear90·localDate·월말보정·BOTH SHOT잠정 | src/mdm/mold/mold-derivation.ts:19, :97, :110, :125 |
| moldopen=NOT IN DONE,CANCELLED·공장today | src/mdm/mold/mold.service.ts:55, :325, :342 |
| IdempotencyService callbacktx·완료응답같은commit·P2002재생 | src/common/idempotency/idempotency.service.ts:64 |
| master-write callbacktx버림, 코드checker PrismaService서명 | src/common/master/master-write.ts:27; src/common/master/code-reference.ts:24 |
| 번호tx밖·기본pattern·DEFAULT_PREFIX목록 | src/core/numbering/numbering.service.ts:9, :36, :64 |
| StateService 기본409·명시status인자가능 | src/core/document-state/document-state.service.ts:33 |
| pageclamp1/50/200·nullable배열아닌집계봉투 | src/common/pagination/pagination.ts:14 |
| bodycoercefalse·querycoercetrue·int64format무연산 | src/common/contract/contract-validator.ts:17, :204 |
| IfMatch 선택헤더guard는 reset 조건을몰라서비스422필요 | src/common/optimistic-lock/optimistic-lock.guard.ts:38 |
| write권한3도출/O8없음·GET403없는경계 | src/common/permissions/derived-permissions.ts:198; src/common/permissions/manual-permissions.ts:1; src/common/permissions/permission.guard.ts:66 |
| 고정 order1:N/다형촉발·실적직접고장/외주/종료null | 고정a6a87e1의 W-05-05:34, :136; W-05-06:139, :166, :190 |
| 툴 reset 오더당1회·등록시current·자기참조0·시행일date | 고정a6a87e1의 W-05-03:54, :142, :162 |
| 후기 PM 최신값대체/동시중복규칙은고정후변경 | .design-reference/omf-mes 의 `git diff a6a87e1 46f0ef5 -- design/wiki/screens/05/W-05-02-툴보전오더생성.md` |
| 실제장비발행query/모든 masterlookup·입력조합 | ../omf-mes-client/apps/web/src/screens/maintenance-order/queries.ts:61; lookups.ts:101; order-draft.ts:148 |
| 실제 장비 PM_DUE는 설비를 골라 직접 더하는 입력 | ../omf-mes-client/apps/web/src/screens/maintenance-order/trigger-picker.tsx:44, :258 |
| 실제툴발행 snapshot 전송·툴별멱등키 | ../omf-mes-client/apps/web/src/screens/tool-pm-order/order-draft.ts:121; queries.ts:98 |
| 장비실적 lines 생략/직접breakdown미전송·POST 헤더 | ../omf-mes-client/apps/web/src/screens/maintenance-result/result-draft.ts:167; queries.ts:112 |
| 툴실적 lines 생략/orderoptional·resetfalse도 moldETag | ../omf-mes-client/apps/web/src/screens/tool-pm-result/result-draft.ts:146; queries.ts:133; packages/i18n/src/ko/tool-pm-result.ts:35 |
| summary완료건수/분모만정의 | contracts/equipment-05설비툴.json:4557; .design-reference/omf-mes/design/wiki/screens/05/W-05-08-비가동집계조회.md:158 |
| I30기존 actor/tx·번호R14·연결R9·계획+helper병합과API미완구분 | docs/coverage-100/slices/I-30.md:25, :34, :39, :732 |
