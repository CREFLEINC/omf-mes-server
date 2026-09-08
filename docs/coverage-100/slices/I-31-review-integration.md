# I-31 독립 통합 재수립

대상: `.backend-dev/lane-b/I-31-draft.md` 753줄. 독립 통합 관점이며 다른 I-31 API/UIUX 보고서·메시지 열람0, R 통합·문의 번호 배정0이다. CREFLE pr-review와 coding-rules를 적용했다. **Blocker 0 / Major 3 / Minor 2 / Trivial 0. 계획 보완 후 구현 배정 권고**이며 코드 검증·머지 승인이 아니다.

## 다섯 축 verdict

| 축 | 판정 |
| --- | --- |
| 1. ⭐ 실적 마감의 의미와 정상 성공 경계 | **조건부 유지.** closed=false/생략의 EQUIPMENT 기록·수정 본길은 성립한다. 확장 결과값을 DONE/NA로 추정하지 않고 closed=true만422로 거부한다. 다만 MOLD PM 정상효과는 축4의 별도 보완 대상이다. 완료 UI 인수·I32 완료집계를 성공으로 계상하지 않는다. |
| 2. ⭐ A16~19 밖의 물리 결손과 구행 | **물리안 유지, 배포 조건 보완(M3).** trigger UNIQUE 완화·bigint, result NN6 완화, worker와 app_user 분리, nullable target+FK쌍·라인/예비품표2는 실제 결손에 대응한다. 구행 allNULL CHECK 보존과 신규 target 정확히한쪽 검증을 함께 유지한다. |
| 3. ⭐ 대상·원천·부여·스냅샷 | **의미 유지, 유효부여 잠금 보완(M2).** 같은 대상 복수촉발·직접부여 우선·가장 가까운 층·MOLD 자유이름 유지. PM 최초축은 문의4/O-5 잠정 선례이며 후기사본은 해결 근거가 아니다. 재발행422는 명시 정책 후보이지 N:M 물리 제약으로 승격하지 않는다. |
| 4. ⭐ tx·잠금·reset·날짜 | **부분 재수립(M1/M2).** 전달tx·재생 우선·order 취소/실적 직렬화·툴 ETag와 결과 ETag 구별·I33 증분 version 증가 인계는 유지. reset 성공+lastPM 무변경을 정상 PM 성공으로 고정하지 않는다. master→order→result라는 순서만으로 다중 writer 안전성이 완성되지 않는다. |
| 5. ⭐ 예비품 참조·횡단 코어·실측 PR 크기 | **참조 범위 유지, PR 수 조건화(N2).** posting/잔량/LOT/자동출고0. 다중UOM의 unknown=null은 수량을 임의 환산하지 않는 nullable 응답 후보로 유지. 최소 core 추출은 타당하지만 기본16~17개가 최소 필요 개수라는 증거는 없다. |

## 1. 버그 / 정확성

### M1 — Major: PM 날짜 효과를 유보한 채 reset을 성공시키는 경계가 충분히 닫히지 않았다

- 근거: 초안:435~443, :487~493. 고정 `a6a87e1:design/wiki/screens/05/W-05-03-툴PM실적등록.md:6,:142,:162`는 reset 시 마지막PM일자·누계 갱신과 시행일→마지막PM일자를 정의한다. `src/mdm/mold/mold-derivation.ts:129,:141`은 그 날짜를 다음 도래와 BOTH 판정에 실제 사용한다. API `contracts/equipment-05설비툴.json:4117` 이하에는 startedAt/finishedAt만 있고 독립 시행일은 없다.
- 실패 예: BOTH 툴의 날짜와 샷이 모두 도래한 상태에서 reset=true, closed=false로 실적201·샷0을 저장하되 lastPM을 그대로 두면 다음 조회는 날짜축 도래를 계속 표시한다. 오더당 reset은 이미 소비되어 같은 오더의 재시도로 날짜 효과를 보완할 수도 없다. ‘화면 인수 미완’ 문서 표시는 저장된 정상효과의 결손을 해결하지 않는다.
- README §2: 0단계에서 **날짜 갱신 효과 자체**는 이미 있다. 미정은 입력 매핑/나눠시행의 적용 시점이다. 1단계에서 정상 PM 저장의 결과를 바꾸는 이 질문을 단순 optional 필드 누락으로 처리하면 안 된다. 특정 reset=true 분기에는 최초② 명시 거부를 선택할 수 있으나 ①을 써서 누계 상태는 쓰고 날짜 상태만 조용히 빼는 결론은 충분하지 않다.
- 권고: reset=true는 시행일 매핑과 날짜 갱신 시점의 원천이 닫히기 전 **명시422/INVALID·전체 업무쓰기0**로 경계를 좁힌다. MOLD reset=false도 ‘PM 시행 완료 기록’과 ‘진행중 기록’의 날짜 효과를 분리해 R 표로 확정한다. 정상 미마감 EQUIPMENT POST/PUT는 유지한다. MOLD 진행중 기록까지 일괄 차단하지 않되 단순 closed=false만으로 PM 날짜 효과가 없다고 선언하지 않는다. startedAt의 공장 로컬일을 채택하려면 고정 원천·소비자 의미·역행/나눠시행·PUT 수정 효과를 함께 명시한다.
- PR/테스트 영향: W2p는 확정된 누계/잠금 원리 준비까지만 가능하며 reset 성공 바인딩은 조건부다. E-R21~24 성공 테스트는 조건부 묶음, 기본 W2에는 reset 거부의 header/parts/mold/version/멱등 완료 저장0을 둔다. 정상 비reset·부분수정 성공을 별도 단언한다. PM 성공 활성화 후에는 DATE/BOTH 차기 도래와 reset=false 시행, 과거일·복수실적 테스트가 필요하다.

### M2 — Major: 다중 writer와 FK의 잠금 모드·경로 재검증이 빠졌다

- 근거: 초안:375,:427은 target→선택된 그룹경로 읽기잠금→참조행 순서만 말한다. `src/mdm/equipment/inspection-assignment.service.ts:84,:188`의 부여 교체는 부모 version UPDATE 뒤 자식을 바꾼다. 추가 writer `src/mdm/equipment/equipment-group.service.ts:156`은 parent_line_id도 변경하고, `src/mdm/equipment/equipment.service.ts:185`는 equipment.production_line_id를 바꾼다. `src/mdm/spare-part/spare-part.service.ts:168,:183`은 spare UPDATE→equipment FK INSERT 순서다(`prisma/schema.prisma:4438`).
- 실패 예①: 발행이 E→G→A 경로를 먼저 읽고 G 잠금을 기다리는 사이 G.parent가 B로 바뀐다. 기존 경로 G/A만 잠근 뒤 resolver가 B의 부여를 다시 읽으면 B는 보호되지 않는다. B 부여 교체가 그 뒤 끝나면 ‘현재 유효부여 검증’이 낡은 집합을 승인한다. 선택된 유효층뿐 아니라 **부여가 없었던 중간층**도 새 부여 삽입을 막아야 한다.
- 실패 예②: I31이 EQUIPMENT E를 FOR UPDATE로 잠근 뒤 spare S의 읽기잠금을 기다린다. 기존 예비품 매핑 writer는 S를 UPDATE한 뒤 E를 참조하는 INSERT의 FK KEY SHARE를 기다릴 수 있다. 각 서비스가 자기 순서를 지켜도 역대기다. 실행 재현 주장이 아니라 현재 소스와 후보 잠금의 교차 판정이다.
- README §2: 0단계 실제 writer/FK와 동일tx 선례에 따른 구현 정확성이다. 새로운 업무 제한을 고르는 문제가 아니므로 2단계로 정상 부여 입력을 거부하는 정책을 만들지 않는다.
- 권고: writer별 **행 종류·모드·획득 순서·재읽기 위치** 표를 R에 추가한다. E의 비키 필드 보호는 FK KEY SHARE와 호환되는 FOR NO KEY UPDATE 후보를 우선 대조한다. 그룹은 version UPDATE와 충돌하는 FOR SHARE 등 실제 모드를 명시한다. 경로 후보 읽기→정렬 잠금→경로/부여 재해석 뒤 잠긴 집합과 일치 검증, 달라지면 전체tx 재시도하는 유한 전략을 둔다. 새 경로를 이미 잡은 잠금 뒤 무정렬로 계속 추가하지 않는다. MDM writer 전체 리팩터를 I31에 끌어들이지 않고 I31 잠금 모드로 해결 가능한 범위를 먼저 고른다.
- PR/테스트 영향: C1은 조회 resolver 추출, P1/W1은 잠금 프로토콜 소유로 분리한다. E-O03 외에 `빈 중간층에 동시 부여 추가`, `부모 재연결`, `직접부여 교체`, `항목 비활성`, `예비품 매핑과 결과 등록 역대기 없음` 테스트를 각 실제 writer와 검증한다. 단순 DB increment fixture는 이 경계를 검증하지 못한다.

### M3 — Major: 구행 required 결손은 500 규칙에 더해 해당 환경의 배포 제한이 필요하다

- 근거: 초안:94~95,:243~245,:679의 사전조회는 결손 시 500을 정하지만 **양수일 때 배포 판단**은 닫지 않았다. `.backend-dev/lane-b/I-31-db-observed.md:3~6`은 개발 DB 한 시점의4표0행이다. 같은 문제의 0단계 선례 `docs/coverage-100/slices/I-32.md:270`은 required 결손 또는 계속 생성하는 구 writer가 있으면 해당 환경 operation 배포 제한을 명시한다.
- 실패 예: 운영에 planned_date NULL 지시1건이 있는 채 Q1을 활성화하면 정상 목록의 첫 페이지가500이 된다. 숨기거나 보간하면 계약 데이터를 위조하고, 500만 적으면 정상 목록을 열었다는 배포 판단이 잘못된다.
- README §2: 0단계 I32 배포 선례 적용. 1단계 전체 개발 본길의 중단이 아니라 **결손이 실재하는 환경**의 가장자리다. 최초③ nullable 추가로 행을 보존하되 조회가능성과 DDL 적용가능성을 구분한다.
- 권고: root 배포 체크에 기존 required 결손수와 구 writer 지속 여부, 영향을 받는 GET/쓰기 응답 operation을 적고 양수면 그 환경의 활성화를 제한한다. 입력 원천 승인 없이 백필하지 않는다. DDL 추가·완화와 정상 개발 환경 구현은 진행한다.
- PR/테스트 영향: M1/M2의 사전조회·배포 결과에 양수/0 분기, Q1/Q2에 구행500과 정상 신규행 성공을 함께 둔다. 운영0을 가정한 전체 PASS 금지. 별도 영구 격리 테이블·마이그 백필 PR은 필요 없다.

## 2. 보안

추가 발견0. 쓰기4의403·O8 수동 권한, raw request+인증 actor 지문, readOnly whitelist, 사용자/worker 축 구별은 유지한다. 권한 검증 PASS가 아니라 계획 읽기 판정이다. sourceId는 다형이라 DB FK가 대신 보호하지 못하므로 최종 tx에서 유형/대상/존재·상태를 확인해야 한다.

## 3. 테스트·슬라이스 접점

- I30: R9 직접FK UNION trigger, 취소 이력 포함, 복수지시의 단수ID null≠미발행을 유지한다. N:M fixture는 물리로 여러 연결을 만들 수 있음을 검증하고, W1의 재선택422는 별도 정책 단언으로 분리한다. E-O16 하나에 둘을 섞으면 과거 N:M 조회 회귀를 빠뜨린다. I30 cause/complete 유보를 실적 finishedAt로 해결하지 않는다.
- I32: R14의 정확한 epochµs/ISO0→1BC/큰 offset/음수 floor·윤초/응답연도 경계를 그대로 공유한다. summary는 정상계획구간/완료 엔티티·날짜·범위 미정이 남고 I31 API 병합 자체가 필수조건이 아니다. order completed_at·MAX(result.finishedAt) 신설/대입0.
- I33: 현 source `src`의 current_shot_count/last_pm_date 참조 검색에서는 production이 누계를 읽고, MDM은 PM 기준을 수정할 뿐 현재 누계 증분 writer는 확인되지 않았다. 미래 tool_usage가 같은 mold행 원자증분+version 증가를 해야 한다는 인계는 유지한다. I31의 증분 fixture가 미래 I33 handler의 검증 PASS는 아니다. I33이 서면 실제 증분→오래된 reset409/최신 reset 성공/재생 무증분을 다시 연결한다.
- 예비품: FK 추가+REFERRERS 집합 회귀 유지. 같은 GI+spare 복수UOM은 응답null, GI없음은 baseUOM 또는null, 단위환산/재고quota0. 이는 ‘사용수량 단위가 확정되었다’는 인수가 아니며 조회 readOnly 정책이다. 실제 물류 spare writer가 생기면 GI 상태/라인 동시변경 잠금도 함께 대조한다.

## 4. 컨벤션 / 가독성·예산

### N1 — Minor: I32 정본 상태와 과거 DB 관측의 표기를 분리 갱신

근거 초안:411,:497,:640,:745. 브리프가 제공한 현재 기준은 main `6bde921ebdd4a7c32f1a672484ec5a29964b8a20`, 공식352/487, #305 조회2와 #306 I32 **계획 정본** 병합이다. I32 helper는 아직 구현 전이다. 역사적 DB54 관측 뒤 A #303 CHECK를 root가 적용해55 migration/generate6.19.3/drift0이 됐지만 보전DDL 변경0이다. 이 리뷰는 재측정하지 않았다. 실패 예는 ignored I32 draft를 의존 정본으로 인계하거나55를 과거 SELECT의 결과로 고쳐쓰는 것이다. README §2의 업무미정 판단이 아닌 0단계 원천 최신성 정정이며, 계획 PR에서 링크/상태만 고친다. 새 테스트·구현 PR은 불필요하다.

### N2 — Minor: 16~17 PR은 상한 배정 시나리오이며 최소 실행계획으로 굳히지 않는다

근거 초안:617~625,:639~669. 유사 create341/update293/query137+view89 실측으로 **3PR 폐기**는 타당하다. 하지만 후보별 허용예산을 더한 값은 실제 diff가 아니며 Q2p·W2p까지 항상 독립 PR이어야 함을 증명하지 않는다. README §2 0단계 CLAUDE의 한 사용처 추상화 금지·일반350/400·core 전체200을 적용하며, 난이도 기준⑤는 새 레이어를 추가하는 근거가 아니다.

권고 최소 책임: M1/M2 물리, C0 MO+cancel 기존표 등록, C1 유효층 resolver, C2 addCycle+due 사실만(현 `mold-derivation.ts:110~146` 중 ratio/view 제외), T는 I32 공용 준비1회, GET order/result, POSTorder/cancel/result/PUTresult. P1/P2/Q2p/W2p는 실제 예정 diff에서 초과가 보일 때 분리하는 준비 조각으로 둔다. core 두 소비자는 mdm+maintenance로 실재하지만 기존행 삭제+신규행+교체+테스트 모두200에 포함한다. PM DATE/BOTH의 M1 결정으로 reset 성공이 조건부가 되면 W2p 분량도 재산정한다. 실패 예는 아직 쓰지 않는 helper와 stub를16개 목표에 맞춰 병합하거나 전체 core 이동을200이라고 세는 것이다. 테스트를 줄이거나 파일 압축하지 않는다. PR 수 자체의 정확한 대체 숫자는 아직 구현 diff가 없으므로 미확정이다.

## 직접 읽은 범위·소유 반환

- brief 전체, 초안753줄 전체, DB 관측 전체. CLAUDE, README(§2 전문 포함), lanes/lane-B, server-architecture, 기존 도메인 규칙, contracts/COMMIT.txt. pr-review SKILL·checklist/severity/template, coding-rules SKILL·TypeScript/commit 규칙.
- 고정 equipment 계약8 operation 및 모든 연결 order/result/item/input/trigger/line/part/create/update/PageMeta/Conflict/Error/헤더 스키마. 고정 W05-03과 W05-05 관련 절을 git show로 직접 확인했다. 다른 I31 관점 보고서는 읽지 않았다.
- I30 R9/R14·인계, I32 canonical R 표·µs R14·구행 배포·summary 절, 계획의 I33 접점. MDM 부여/그룹부모/설비소속/예비품매핑/툴 PM 기준 writer, 물류 GI 부모잠금, PM 파생 함수와 관련 FK를 직접 읽었다. 실측 부록 재계수·DB 재접속0.

**이 파일만 작성했다. 코드/DB/E2E/gates/git·gh writes/외부게시/문의번호/추가 agents 모두0. 실행 검증 PASS0. M1~M3의 통합 결정·정본 반영·실제 경합/배포 검증·PM 의미 해소는 미완이며 root 소유다. `/root/i31_review_integration`의 파일 소유를 root에게 반환한다.**
