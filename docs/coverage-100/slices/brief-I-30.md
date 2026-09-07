# I-30 계획 브리프 — 설비 점검·고장 9건

목표는 `I-30.md` 개별 계획안이다. 구현·마이그레이션 적용·계약 변경·git 쓰기는 하지 않는다.
기준 main `771c541`, 고정 계약 `a6a87e144116ebaa32c01df5a12a0fd2924427e7`, 시작 커버리지 342/487.

## 읽을 자료

1. `docs/coverage-100/README.md` 전체(특히 §2), `lanes.md`, `lane-B.md`, `CLAUDE.md`.
2. `plan.md` §1·§2·§4·§5, `plan-api.md` S23·S24 및 A15, `plan-uiux.md` U33,
   `plan-integration.md` I-30. 오래된 3관점 초안보다 배정표·고정 계약·실측이 앞선다.
3. `slices/I-24.md` 전체. 구조와 깊이, §0 검토 항목, 실측 부록, §12 마감표를 따른다.
   I-24의 옛 예산/옛 판정 자체를 복제하지 않는다.
4. `docs/server-architecture.md`, `docs/기존-구현-도메인-규칙.md`의 관련 선례.
5. `contracts/equipment-05설비툴.json`의 배정된 전건과 모든 연결 스키마·파라미터.
6. `.design-reference/omf-mes/design/wiki/screens/05/`의 `M-05-01-설비점검입력.md`,
   `M-05-02-설비고장현장보고.md`, `W-05-04-설비고장상세처리.md`.
   목록 소비자인 W-05-05·P-02-02도 관련 절을 확인한다.

## 배정

`assignment.tsv` 실측: **6 path·9 operation**. 지시서 §11의 "7 path"는 건수 오기다.

- GET `/maintenance/inspections`, GET `/maintenance/inspections/{inspectionId}`
- POST `/maintenance/inspections`
- GET `/maintenance/breakdowns`, GET `/maintenance/breakdowns/{breakdownId}`
- POST `/maintenance/breakdowns`
- PUT `/maintenance/breakdowns/{breakdownId}`
- POST `/maintenance/breakdowns/{breakdownId}:start-handling`
- POST `/maintenance/breakdowns/{breakdownId}:complete`

고장 첨부는 **I-34 건너뜀분**이라 이 슬라이스가 만들지 않는다. 계약은 읽기 전용이다.

## 준비 점검에서 발견한 검토 5축

아래는 미확정 쟁점이며 답으로 취급하지 않는다. 계획자가 실측해 §0의 최종 5개를 정한다.

1. **물리 모델 대조 전건**: A15 3칸만으로 충분한가. 보고자 `reported_by → app_user`와
   계약 `reporterWorkerNo`의 귀속 차이, 처리내역·원인코드의 각각 저장소, 필수 severity/status,
   과거 nullable 행과 required 응답을 확인한다. 점검의 `inspected_by → worker`와 혼동하지 않는다.
2. **원인코드 출처**: 계약 설명은 `mdm.cause_code`, 물리는 `quality.cause_code`, 화면은 품질 원인코드
   사용 금지다. 본길/가장자리를 판정하고 확정 근거 없는 마스터·공통코드·값 집합을 만들지 않는다.
3. **조회·하류**: 최신 점검 1건, 기간 조건부 필수와 미발행 트리거 예외, 기본 미처리 고장,
   비가동 합계·열린 구간, 보전 지시 연결, I-11 `basisInspectionId`를 대조한다.
4. **트랜잭션·전이·헤더**: 현장 사번 2건, 멱등 5건, If-Match 3건, ETag 1건,
   RECEIVED→HANDLING→DONE 및 RECEIVED→DONE. 현장 원문 불변. 상태 오류의 400/422와
   `:start-handling` 400 미선언을 판정한다. 새 error code는 0개다.
5. **경계·채번·PR 분할**: 번호 2개가 물리 NOT NULL UNIQUE이므로 채번 불필요라고 가정하지 않는다.
   notifyAssignee와 I-28의 DB 내 연계 범위를 명확히 하되 외부 발송은 금지한다.
   고장 완료가 W/O 재개·비가동 종료를 하지 않음을 테스트로 단언한다.
   유사 파일의 실제 줄 수를 재서 350줄 예산/400줄 상한, 코어 PR 200줄 상한에 맞춰 분할한다.

## 판정 절차 — README §2

0단계: 계약 본문·기존 구현 도메인 규칙·선례가 있으면 인용한다.
1단계: 가장자리(특정 입력)면 2단계. 본길(모든 호출)은 임의로 못 고른다.
계약 문자 그대로 + 문의. 계약도 침묵하면 해당 오퍼레이션 건너뜀 사유를 기록한다.
2단계: 뒤집는 비용이 싼 쪽을 위에서부터 먼저 걸리는 기준으로 결정한다.
① 재고·원장·상태를 쓰지 않는 쪽 ② 명시적 거부 ③ 스키마를 안 늘리는 쪽, 필요하면 nullable
④ 값을 조용히 도출하지 않는 쪽 ⑤ 새 개념 수가 적은 쪽.
3단계: 에러/상수 이름·설계 미정 테스트·검토 요청서에 단계와 기준을 남긴다.

## 산출물·검증 경계

- 계약 전건 읽기 표, 필드 매핑, SQL 전문(사전 SELECT 주석 포함), 주석·CHECK·FK 실측,
  핵심 트랜잭션 순서, 오류 우선순위, 상태기계, 파일 배치, 테스트 이름 목록, PR별 파일/실측 예산.
- 확정할 수 없는 본길과 계약 모순을 감추지 말고 즉시 통합자에게 알린다.
- 문의 후보 번호는 `090+n`으로 적고 통합자가 충돌 없이 확정한다. 다른 슬라이스 번호는 쓰지 않는다.
- 실측 부록에는 **사실 + 파일:줄**을 한 표로 남긴다. 리뷰어는 재측정하지 않되 판단을 뒤집을 때만 재측정한다.
- 계획만 작성한다. 새 마이그 SQL을 계획에 싣되 실제 적용하지 않는다. 삭제 0·백필 0·추가/완화만.
- 코어 전이표는 A 소유다. B 추가 필요를 계획에서 보고하고 실제 수정은 통합자 보고 이후다.
- 공용 파일은 자기 등록만. 다른 도메인 서비스 호출·다른 레인 기능 수정 금지.
- 로컬 DB는 이미 최초 시드 완료. DB 읽기만 허용, reset/migrate dev/seed/db pull 금지.
- DB 조회는 전용 컨테이너 `omf-mes-lane-b-postgres`, DB `omf_mes_lane_b`, 사용자 `omf_lane_b`.
  비밀값을 출력하지 않는다. E2E는 통합자가 조율하며 동시에 실행하지 않는다.
