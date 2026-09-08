# I-31 통합자 결정 — 2026-09-07

root가 개별753줄/독립API·UIUX·통합 보고서 전체를 직접 읽고 아래를 확정했다. 구현 승인 범위는 계획 정본 PR을 거친 뒤 각 브리프에서 부여한다. 이 파일은 편집 인계이며 별도 권위가 아니다. 현재 main d5979ca(#307) 공식353/487. 이전 DB실측54와 이후55를 소급 변경하지 않는다. I30② 물리 구현은 진행중이며 아직 병합 안 됐다.

## 0-재수립 R 표 — 정본에 넣을 통합 판정

| R | 자리 | API | UIUX | 통합 | root 결정 |
|---|---|---|---|---|---|
| R1 | 실적 마감 | 미마감 본길 유지 | 완료인수 분리 | 같은 결론 | O1~O8 정상 성공 본길 유지. closed=true만422 INVALID/field closed/UNRESOLVED_MAINTENANCE_CLOSE. 2단계 최초① 업무상태 전건0 후②명시거부. 코드명·번역·빈 every로 DONE/NA 도출0. 문의113. |
| R2 | PM 날짜/누계 reset | F1 반쪽 성공 반대 | F1 반쪽 성공 반대 | M1 동일 | resetCounter=true는 날짜 원천/적용시점이 닫힐 때까지422 INVALID/field resetCounter, MAINTENANCE_RESET_POLICY='REJECT_UNRESOLVED_PM_DATE'. 첫①로 실적/자식/누계/lastPM/version/멱등완료 전건 쓰기0,②명시거부. 이전 초안의 누계만201 철회. 문의114. |
| R3 | nonreset 본길·향후 reset | 정상 nonreset 유지/F3 폐기검사 | 진행기록 유지 | 진행과완료 구별 | EQUIPMENT/MOLD nonreset 미마감 기록·편집 정상. finishedAt는 구간의 종료값이지 PM완료/시행일 선언이 아님. lastPM/누계 쓰기0. reset 성공·오더당1회/증분경합/폐기 후 최신ETag거부는 날짜 해소 뒤 조건부 인수. 비reset 과거기록을 현재폐기만으로 일괄거부0. |
| R4 | 물리/구행 | 추가완화 유지 | FK쌍 지지 | M3 배포제한 | M1/M2 계획 추가/완화·구행 allNULL 보존. required 결손500/미존재404, 숨김/가짜backfill0. 사전 결손>0 또는 구writer 지속이면 해당환경 관련operation 활성화 유보; 개발정상구현/DDL전체중단0. 091 재사용. |
| R5 | 부여/원천/스냅샷 | 유지 | 소비자 전체lookup≠부여 | M2 잠금 보완 | 가장 가까운 실제 부여층·inactive 층도 상위우회0. source같은대상/현재상태, MOLD자유이름, EQUIPMENT PM_DUE에툴due강제0. stale 제공snapshot422·생략NULL. source 재선택/열린MOLD PM 중복만422, N:M물리globalunique0. 문의115와095. |
| R6 | 다중 writer 잠금 | 기존 tx 지지 | 원자성 지지 | M2 채택 | 아래 writer/모드/재읽기 프로토콜 확정. E/M target FOR NO KEY UPDATE; group/검증master FOR SHARE; order/result FOR UPDATE. 후보경로 정렬잠금 후 재해석·잠긴경로와비교, 바뀌면 whole run tx유한재시도. 기존writer수정0. 096에 정확성 근거. |
| R7 | 전달tx/채번 | 유지 | 유지 | 유지 | actor+raw body+method/path 지문·같은callback tx. MO선채번은 run밖, replay전채번0·경합결번허용. 번호P2002만초기+3재시도. 공용master-write tx버림/Prisma강제cast복제0. 096/098. |
| R8 | 시각·소비자 | F2 GI µs/F4 정본 | F2 공장입력·표시 | I32동일/summary분리 | I32#306 canonical R2/R14 정확µs/ISO0/negative/offset정책 단일 재사용(helper미구현). 결과뿐 아니라 part.issuedAt도 raw epochµs projection. client UTCprefix표시/브라우저offset은 별도미완인수094; 서버재해석/새헤더0. |
| R9 | 예비품·단위·편집 | 참조만/F2 시각 | F3 확인·정정 미완 | 참조만/미래writer | part7필드, GI+spare한UOM이면그값·다중이면NULL/GI없으면baseUOM또는NULL. quota/posting/환산0. unknown은단위확정이아님. GI재선택/수량단위확인/상세ETag PUT소비자인수 미완. 문의116. |
| R10 | 코드 checker | F4 실제 활성만 | 결과의미 미정 | 유지 | code_value.is_active+group_code 선례만. group.is_active/effective_from/to를검사한다고쓰지않음. 새평가일/그룹/시드0. 물리확장은허용코드의권위가아님. 096/113. |
| R11 | 취소/권한/ETag | 유지 | 편집인수 분리 | 취소경합 유지 | 취소ISSUED·결과0·지시token,실적PUT실적token. 상세2만숫자ETag. 상태400와stale409분리093. 쓰기4 403, O8 manual만단독커밋. A소유cancel전이는사용자사전조율후별도core전체200. |
| R12 | core/PR 예산 | 분리 지지 | 과도추출0 | N2 조건화 | 3PR초기안철회, 16~17고정실행수도철회. M1/M2,C0,C1,C2,T공유1회,GETorder/result,POSTorder/cancel/result/PUTresult 최소책임만확정. P1/P2/Q2p는예정diff초과확인때분리. W2preset성공부는조건부·미사용helper병합0. core기존삭제/신규/호출교체/spec전체200. 일반350/400. |
| R13 | 인계/현재성 | F4 | F4 | N1 | I30#305점검GET2/I26#307GET1/main353/I32#306계획정본과helper미구현을분리. 역사DB54실측유지/후속55별도. I32summary111은완료실체·시각·범위여전히미정. I33실제writer미구현을CASfixture PASS로대체0. |

## R6 실제 writer와 잠금 프로토콜

root 직접 대조: inspection-assignment.service.ts84,188(parent version UPDATE 후 child 교체),equipment-group.service.ts156(parent relink 포함),equipment.service.ts185(소속변경),spare-part.service.ts168~183(spare UPDATE 후 equipment FK INSERT). IdempotencyService.run:64~105는 콜백 예외시 업무+멱등행 롤백, P2002 idempotency만 자체 재생한다. source 실행검증 아님.

| writer | 기존 잠금/참조 순서 | I31 프로토콜과 재읽기 |
|---|---|---|
| 설비 소속/직접부여 교체 | equipment UPDATE→group FK 또는 assignment children | I31 equipment FOR NO KEY UPDATE를 먼저 확보해 비키변경·직접부여교체를 막음. 타 writer FK KEY SHARE와는 호환. 이 이후 target와직접부여재읽기 |
| 그룹 부모/그룹부여 교체 | production_line UPDATE→parent FK 또는 assignment children | I31 후보경로의 **부여없는 중간층 포함** group IDs를 ASC로 FOR SHARE. 경로와선택층/부여를다시읽어같은경로인지확인. 그룹 SHARE는그룹UPDATE와충돌하지만상호FK KEY SHARE와호환 |
| 항목 활성/타입 변경 | inspection_item UPDATE | 현재선택층의항목ID를ASC FOR SHARE 후active/type/부여최종검사. 부여가존재하면inactive만으로상위층선택0 |
| 예비품 매핑 교체 | spare UPDATE→equipment FK KEY SHARE | I31 E의NO KEY UPDATE는그FK를막지않음. spareIDs ASC FOR SHARE 뒤매핑/활성/단위최종읽기. E FOR UPDATE로강화하지않음 |
| 취소/실적등록/편집 | I31 master→order→result | 필요target만NO KEY UPDATE→order FOR UPDATE→result FOR UPDATE→종류/ID정렬참조 SHARE. 취소는order만잠그고뒤늦게master잠금추가0. 실제미래GI/툴writer추가시교차대조 |

잠금모드 근거: [PostgreSQL 16 §13.3.2·Table13.3](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS). NO KEY UPDATE와KEY SHARE는호환, SHARE는비키UPDATE와충돌한다. 새정책선택이아니라실제writer와DB잠금규칙의정확성 적용이다.

경로안정화: target잠금→resolver후보경로읽기(선택부여층까지/없으면끝까지)→후보IDs ASC SHARE→resolver재실행. 재해석시새경로가필요하면그행을무정렬추가잠금하지않고내부 MaintenanceAssignmentPathChanged 신호로 **run전체 rollback**. 동일context/이미준비한번호로최초+3회재시도하며tx안채번0. 계속변하면기존409 C/user ‘부여 경로가 변경되었습니다. 다시 조회하세요.’로업무0. 일반SQL/Prisma오류를이신호로삼키지않음; 번호P2002재시도와별도유한수이며곱셈무한루프0. 재시도시멱등선조회가원래성공을발견하면그응답을즉시재생. 그룹의순환은기존resolver seen-set끝처리동일, 임의새계층정책0.

실행전/독립리뷰 필수단언: 빈중간층 동시부여 추가·부모재연결·직접부여교체·항목비활성·예비품매핑과실적등록역대기없음. 실제writer호출과제어된잠금배리어로원천/성공값검증, sleep추정·단순DBversion fixture로대체0. bounded경로retry소진409/재생0쓰기·부분header/child/멱등행0도단언. DBlease는현재I30구현자이므로이계획통합단계DB0.

## 편집 인계 요구

위 R표와 프로토콜을 I31초안에통합하고 상충하는§0/2/5/6/8/9/10/12를동일결정으로고친다. E-R20 reset헤더·E-R21/23/24·폐기후reset성공거부는 **조건부 미래성공**으로옮긴다. 지금 E-R28은 reset true의 전건0거부, nonreset정상본길별도. finishedAt가있어도closedfalse실적≠PM완료라는의미명시; 향후날짜문의는시행일원천/부분/역행/nonreset효과모두확인. 소비자인수는①미마감저장②편집③closed마감④PM기준⑤원천/부여⑥parts확인정정으로분리. 113결과의미,114PM날짜,115원천/부여,116parts단위/편집은root예약이며아직파일발행0. 더필요하면새번호추정0.
