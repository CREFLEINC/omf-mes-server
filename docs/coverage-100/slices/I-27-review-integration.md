# I-27 독립 Integration 계획 리뷰

검토 기준: brief-I-27-review.md 전문, I-27-draft.md 467줄·I-27-db-observed.md 161줄 전문, 지정 저장소 규칙·coding-rules(TypeScript/commit reference 포함)·engineering documentation. 기준 main #308/4fadf31·353은 root 전달값이다. 다른 I-27 리뷰 열람0, 재측정0, DB·DDL·테스트·gate·git/gh 쓰기0. 아래 R은 **후보**이며 확정·정본 편집은 root 소유다.

**Blocker 0 / Major 4 / Minor 3.** A9 nullable6와 출력/기록 분리, summary 전건 복원은 유지한다. 구현 전에 M1~M4의 범위·잠금·활성화 판정을 닫아야 한다. 특히 초안의 ‘MOLD 구현 시 확인’은 실제 writer를 읽으니 수정 의존성이 생겼고, LOT-first는 전체 writer에 안전한 순서가 아니다. 프린터 GET 유보는 타당하지만 POST 전체 유보까지 따라오지는 않는다.

## 1. 문서9 × 대상7·자격·LOT·summary

**M1 — 정상 가지를 가진 POST와 특정 문서/단말 가지의 미정이 분리되지 않았다.** 초안:37·140·273은 POST 전체를 조건부로 두면서 :103~104에는 TOOL_LABEL/MOLD·LOCATION_LABEL/LOCATION의 확정 선례를 이미 가진다. 실제 계약 `contracts/app-공통.json:1196`은 기록 생성이며 :1202는 WorkerNoOptional, :4594는 관리웹 두 종류를 포함한다. 고정 요구서 `.design-reference/omf-mes/design/wiki/api-contracts/06-API-요구서-app공통출력물.md:190`·:191 및 `screens/06/W-06-07-창고Location마스터.md:110`·:113은 관리웹의 다중선택 기록 생성을 명시한다. 따라서 단말 출력권한/개체 품질/납품 target 결손만으로 LOCATION_LABEL 정상 가지까지 유보할 근거는 없다.

- root R 후보: 9×7의 모든 조합을 **허용/명시422/근거 미정**으로 닫는 정적 표를 확정한다. 최소 정상 후보 LOCATION_LABEL+LOCATION(LOT null); TOOL_LABEL+MOLD는 M2 잠금 보완 뒤 정상 후보. 잘못된 짝·없는 대상·non-null LOT는 가장자리 최초2-② 명시거부다. 전체 POST를 항상422로 등록하지 않는다.
- MATERIAL_LOT_LABEL+LOT는 MATERIAL·초기 INSPECTION_PENDING도 정상이라는 초안:96의 근거를 유지한다. PRODUCTION_LOT_LABEL+LOT는 completed_at과 품질 축을 따로 판단한다. 정상 LOT 품질만으로 SERIAL_NUMBER를 개별 양품이라 추정하지 않는다. GOODS_ISSUE_QR+라인/HU·PACKING_LABEL+HU의 조건은 화면 충돌과 writer 규약까지 포함해 root가 별도 확정한다.
- DELIVERY_LABEL은 frozen enum에 출하배분이 없어 해당 종류의 본길 결손(초안:101, 계약:4540, 요구서:188). IDENTIFICATION_TAG의 개체별 품질 공백, PACKING_LABEL+LOT 화면 충돌도 숨기지 않는다. 한 operation의 특정 입력군이므로 확정 정상 가지를 열면서 이 입력군을 명시422하는 안을 root에 추천한다(최초2-②). 이 추천은 enum 확장·HU 치환의 승인이 아니다.
- summary는 초안:133~136 유지: distinct 조회 후 원본 ordinal/multiplicity 복원, 없는 대상+이력0도 count0, 삭제 대상의 이력은 그대로 집계. count≠max(seq), last 세 칸은 동일 행. 문서 미지정의 마지막은 시간+id이며 종류별 최고 회차를 조합하지 않는다. 이는 ‘대상 존재 인증’이 아니다.
- 필수테스트: 63조합 분류, 허용 조합의 실제 정상 요청, 미지원 하나를 섞은 배치 전체rollback, LOT 원천일치/불일치, `[2,1,2]`·미존재·다종류 동률 latest. PR: C1 허용표/R과 C2 실제 POST를 조건부 체인에서 독립 지원 체인으로 재구성할 수 있다.

## 2. 회차·동시성·N1000·사유

**M2 — 금형 발행 잠금과 코드변경 writer가 같은 임계구역을 사용하지 않는다.** `src/mdm/mold/mold.service.ts:184`는 assertWritable→get(:186)→codeEditable 검사(:192)→독립 updateMany(:196)다. get의 labelIssueCount는 :147~150, 실제 count는 :293~300이며 트랜잭션/행잠금이 없다. 초안:155·384의 ‘대상 mold 잠금’만으로 코드 수정이 안전해지지 않는다.

- 정적 경쟁 순서: 코드변경이 이력0을 읽음 → 발행이 mold를 잠그고 로그를 commit → 코드변경이 기존 version으로 UPDATE 성공. 발행은 mold.version_no를 바꾸지 않아 낙관적 검사도 이를 검출하지 못한다. 고정 `screens/05/W-05-13-툴금형지그마스터.md:189`의 ‘발행1건 이상이면 코드 잠금’을 위반한다. 실제 병렬 실행은 하지 않았다.
- root R 후보: 금형 코드변경의 **mold 잠금→참조/라벨 검사→UPDATE를 한 tx**로 묶는 선행 보완을 명시한다. 기존 master wrapper가 업무 tx를 전달하지 않는다는 초안:170도 고려한다. 발행에서 버전만 올리는 임시 우회는 계약 밖 쓰기라 추천하지 않는다. 공유 core 필요 여부/금형 파일 소유를 root가 먼저 정하고, 본 리뷰는 해당 source를 고치지 않는다.
- 필수테스트: ‘코드검사 먼저/발행 commit 먼저’와 반대 interleave에서 규칙 유지; 기존 `test/mdm-mold.e2e-spec.ts:312`는 순차 fixture→PUT이라 경합 증거가 아니다. 영향 PR: 금형 보완을 C2에 숨기지 말고 독립 선행 PR·금형 회귀 배정.

**M3 — LOT-first가 출고라인의 실제 FK writer와 역순이다.** 초안:155는 LOT→GOODS_ISSUE_LINE을 제안한다. `src/logistics/goods-issue/goods-issue-update.service.ts:79`는 헤더를 먼저 잠근 뒤 :107 DELETE/:109 일괄 line UPDATE, :120 lot_id 설정, :132 line UPDATE를 수행한다. `prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:1479` 및 `prisma/schema.prisma:791`은 line.lot_id의 실제 LOT FK다.

- 정적 교착 후보: 라인치환 tx가 line A를 잡은 채 lot_id를 LOT2로 바꾸며 FK 검사를 기다림; 발행 tx는 대상군 관련 LOT1·LOT2를 FOR UPDATE로 잡은 뒤 line A를 기다림. FK의 참조행 잠금까지 포함하면 두 tx가 서로 기다린다. 같은 발행끼리 `[A,B]/[B,A]`만 검사해서는 이 경합을 보장할 수 없다. 런타임 재현/빈도는 미확인이다.
- root R 후보: 지원 target마다 **기존 writer의 부모 전표→참조→대상** 그래프를 정한다. 출고라인은 연관 goods_issue 헤더 전건을 numeric id순으로 먼저 잠근 뒤 원천 라인/FK를 재조회하고 LOT 집합을 결정하는 안을 우선 검토한다. 잠금 전 읽은 lot_id를 그대로 쓰지 않는다. 헤더·FK 재확인이 바뀌면 처음부터 tx 재시도 또는 명시거부로 정하고 다른 레인 writer 수정은 root 소유 조율 전 진행0.
- HU 내용물/검사결과 자격 writer는 아직 공통 잠금 검증이 없다는 초안:157을 그대로 유지한다. **불명인 writer까지 보호한다고 선언하지 않는다.** LOT만·LOCATION만 같은 독립 정상 가지에는 필요한 잠금만 적용한다.
- 회차 불변식은 유지: 부모행 잠금 이후 **새 SQL 문장**의 max+1, doc+type+id 축, 첫행0도 직렬화, 로그 자체 MAX행 잠금만으로 해결0, NumberingService 호출0(초안:147~159). uq는 관측:76·87의 최종 보호다. 입력 중복은422, 잠금용 배열만 정렬하고 응답·지문은 원본순서다.
- REISSUE_REASON은 실제 고객관리5값(active) 관측:131~135 유지. 신규/재발행 혼합에서 모든 신규 reason null. `src/common/master/code-reference.ts:24`의 helper는 PrismaService 타입·400 오류이고 :35~38은 그룹활성까지 검사하지 않으므로 그대로 복제했다고 tx/422/그룹활성을 충족한 것으로 적지 않는다. 문서9/target7은 고객 공통코드가 아니다.
- 필수테스트: 잠금 이후 max조회·동일대상 첫발행/재발행·역순 배치 외에 **출고 라인 lot 변경/삭제 vs 발행**, 소속LOT 재확인, 실제 DB 전량1000 성공/실패/응답유실 재생. 교착 재시도는 실패한 tx 전체를 다시 열고 같은 키를 유지해야 한다. 현재 run은 `src/common/idempotency/idempotency.service.ts:92`의 멱등PK P2002만 처리하며 다른 uq/교착 재시도를 제공하지 않는다.

## 3. A9·결과·actor·과거행 배포

**M4 — P5 한 번 통과와 응답 활성화 사이의 구형 writer 통제가 빠졌다.** A9 초안:207~223은 NULL outcome+보고칸 전부NULL을 허용해 forward 호환이며 이 선택은 옳다. 그러나 P5 missing0(:365~374) 다음 구형 writer가 똑같은 구형 행을 넣을 수 있다. 결과 required를 내리는 GET·report의 활성화는 P0 적용만으로 완료되지 않는다.

- `rg -n 'document_issue_log' src prisma/seed.ts test --glob '!*.spec.ts'` 결과 현재 production src는 조회 소비자 2곳(`src/mdm/mold/mold.service.ts:294`, `src/logistics/inbound-receipt/inbound-receipt-query.service.ts:35`)뿐이고 로그 INSERT는 없었다. **구형 production writer 실재를 주장하지 않는다.** 외부/운영 writer 재고는 미확인이다. 반면 `test/mdm-mold.e2e-spec.ts:314`·`test/logistics-inbound-receipt.e2e-spec.ts:410`는 outcome 없는 INSERT가 실제 남는 선례다.
- root R 후보: 환경별 writer 확인/구형 writer 종료 또는 갱신→P5와 필수값 사전검사→handler 활성화의 순서를 배포 조건에 적는다. 되돌려 구형 writer가 다시 활성화되는 경우도 같은 hold 조건이다. NULL은 UNKNOWN 과거 상태이며 PENDING/STATE_LOCKED ‘이미보고됨’으로 둔갑하지 않는다. P0은 독립 허용, 운영 데이터/원천이 없으면 결과 노출은 hold. 개발DB 발행0(관측:100~103)을 운영0이나 신규A9 PASS로 외삽0.
- A9 nullable6·계정/worker 분리는 채택 추천. issued_by 기존 account FK 보존, issued_worker optional, 보고 account/worker 별도 FK. printReportedAt은 서버 접수시각이며 물리 인쇄시각이 아니다. `(...) IS TRUE`가 NULL outcome+보고정보의 3값 논리 우회를 막는 초안:210~239도 유지한다. 신규항목에 DEFAULT/backfill0.
- P0 Prisma relation은 새 FK의 기본형 이름뿐 아니라 **onDelete/onUpdate=NoAction**까지 SQL과 맞추고 worker 두 관계·app_user 보고관계의 역관계를 구분한다. nullable relation의 암묵 기본값에 맡기지 않는다. 대상 다형쌍은 물리 FK가 없으므로 존재검사/삭제 이후 fallback과는 별개의 무결성이다(관측:70~76).
- 필수테스트: NULL legacy 허용/응답활성화 hold, NULL outcome+report 거부, 완료 귀속NULL 거부, dangling actor/worker FK 거부, PENDING→두 outcome, 보고두키 승자1, 같은키 원래응답, 최초귀속 불변. 과거 fixture를 무조건 PENDING으로 변조하지 말고 신규 정상 fixture와 legacy 검증을 분리한다. 영향 PR: P0 SQL/schema+검사, P1/P2 활성화 증거, P3 actor/report.

## 4. 프린터 단말귀속·상태 producer

초안:173~187 **본길 유보 유지**. 관측:38~65·94~98은 app.printer/terminal의 실제 칸과 printer 관련표 부재를 이미 확인했다. fixed 요구서 `api-contracts/06-API-요구서-app공통출력물.md:256`~260이 단말 매핑 원천 미정을 명시한다. active→READY, 관측없음→OFFLINE, 같은plant→사용가능, 전건isDefault=false 모두 근거 없는 도출이다. 최초1단계 본길에서 유보하며 2단계 ‘nullable을 더하면 해결’로 넘기지 않는다.

A10 5칸만으로 단말 매핑·기본 설정·문서 지원·관측 writer가 생기지 않는다. 저장된 관측 producer/시각/신선도 규약이 정해지면 DB 조회로 재개 가능하다. 외부poll/URI/OS spool 연결0. root는 기존 정본 `docs/coverage-100/plan.md:18`·:132의 OFFLINE default 결론을 R 이후 함께 정정해야 한다. 필수테스트/PR은 source 확정 후이며 지금 빈 handler로 coverage를 더하지 않는다.

## 5. 헤더·멱등·공유소유·실측 예산

초안:144~153·163~171의 같은 tx 업무+완성응답 저장은 유지. `src/common/idempotency/idempotency.service.ts:66`~90이 넘긴 tx를 사용하고 새 transaction/외부 Prisma callback 읽기0. :111은 fingerprint만 비교하므로 account/worker/terminal을 JSON-safe 지문에 담아야 한다. 동일키는 자격/코드 상태 재검사보다 replay 우선이되 현재 요청의 인증 검증은 먼저다. 단말 원천은 `src/auth/terminal-token.ts:26`~42의 검증된 token이며 계정 없는 단말 인증 미지원은 공유 문의054 범위다.

권한은 `src/common/permissions/permission.guard.ts:37`~40대로 403 선언 POST만. :56의 현재 가드는 계정 screen 권한 OR이며 **단말의 출력 가능 공정 검사 자체가 아니다**. frozen POST403(`contracts/app-공통.json:1227`)과 구분하고 POP 가지 재개 조건에 그 gate 근거를 적는다. 관리웹 정상가지까지 terminal 필수로 조이지 않는다. P-04-04 누락 보강은 root R 뒤 manual 자기operation 단독커밋; report/GET 새등록0.

**Minor 1 — N1000 작업의 query 수/시간예산을 C2에 더 명확히 고정.** 초안:384는 N1000 테스트가 있지만 :147~152는 대상당 lock/max/mapper로 풀릴 여지가 있다. 고정 유형별 batch lock, 잠금 뒤 그룹 MAX, batch insert, batch mapping으로 정하고 쿼리수 상한을 테스트한다. run은 tx 옵션을 지정하지 않음(:66~90), PrismaService도 override 없음(`src/prisma/prisma.service.ts:5`); 설치 runtime `node_modules/@prisma/client/runtime/library.d.ts:2653`~2655의 default timeout은5000ms다. **N1000 실패를 실측했다는 뜻이 아니다.** 기본 제한 아래 검증하고 변경 필요 시 공용멱등 수정0 결론을 root가 재수립한다.

**Minor 2 — seq int 최대치 사전검사.** 물리 issue_seq는 integer(관측:31), uq max+1은 2147483647 다음 overflow를 만들 수 있다. 신규seq 범위검사→422 RANGE·배치rollback의 가장자리 최초2-②와 테스트를 명시한다. 계수seq를 NumberingService로 옮길 이유는 없다.

**Minor 3 — 사전검사와 추정 예산의 누락.** 초안:335~336은 lotNo/사유 길이만 직접 검사한다. target별 displayName200(조합명 포함), actor required, 이름의 현재원천·삭제 fallback, A9 전체 truth table과 FK actions/역관계/drift를 P0/P1 인수에 분배한다. 기존 파일 줄 수(초안:444~451)는 재측정하지 않았다. C2의330은 신규 diff 실측이 아니며 M2 금형 보완·M3 부모잠금·재시도·N1000 batch 조각은 아직 별도 비용이다.

root 분할 추천: P0 A9 → P1 목록/상세(+필요시 P1t 시간)·P2 summary → P3 report를 유지하고, 금형잠금 보완을 선행 독립 PR로 추가. C1 pair/자격과 C2 잠금/seq/배치/멱등을 분리하되 P1 target resolver와 미사용 추상화를 중복 생성하지 않는다. **일반 planned350/max400, core를 만지면 PR전체200**. 예산초과 후 긴줄로 접지 않는다. app-domain은 자기등록만, schema는 자기 모델/새관계만. transitions/state spec은 A 소유(`docs/coverage-100/lanes.md:69`), 새error0, 다른 레인 writer 변경·공용core 신설은 root 선행소유판정. 병합 때 실제 AppModule와 양쪽등록 회귀가 필요하다.

## 인계·미확인

root R 후보는 M1 지원집합/정상가지, M2 금형 writer 원자화·소유, M3 실제FK lock graph·재시도, M4 환경별 oldwriter/활성화 조건, 그리고 N1000/seq/prechecks 예산이다. 허용집합·물리·권한·잠금 판정을 본 리뷰가 확정하지 않는다.

원천 정적 확인만 했다. DB SELECT/DDL/P5/통합테스트/교착 재현/운영writer 조사/실제client 읽기 미실행. root 관측0행·56 migrations를 재측정하지 않았으며 A9 성공·runtime N1000 성공을 주장하지 않는다. runtime 줄 번호 외 고정계약·source 근거가 기준이다. 새 에이전트0·외부 메시지0·다른 보고서 열람0.

산출 소유: **이 파일 하나만 apply_patch로 작성 완료. 소유를 root에게 반환한다.** coding-rules의 책임별 분할과 실패 명시, documentation의 실행/관측/미확인 구분을 보고서에 적용했다.
