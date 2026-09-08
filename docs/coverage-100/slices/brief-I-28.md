# I-28 독립 계획 브리프 — 알림 8건

아래는 새 컨텍스트 계획자에게 준 최초 브리프다. 계획자는 `I-28.md`만 작성했고,
독립3리뷰 뒤 통합자가 R-1~R-10으로 재수립했다. 구현 범위·문의 번호는 최종 계획이 우선한다.
I-30 계획과 독립이며 계획자에게 공용 정본·코드·git·DB 쓰기는 허용하지 않았다.

## 정본

`docs/coverage-100/{README,lanes,lane-B}.md`, `CLAUDE.md`, `plan.md` I-28 및 §4 A7/A8·§5,
`plan-api.md` S10, `plan-uiux.md` 알림 절, `plan-integration.md:435-438`,
`docs/server-architecture.md`, 개별 계획 본보기 `docs/coverage-100/slices/I-24.md`.
계약은 `contracts/app-공통.json`이고 `contracts/COMMIT.txt=a6a87e1` 고정·읽기 전용이다.
화면은 `.design-reference/omf-mes/design/wiki/screens/공통/`의
`W-CO-03-알림센터.md`, `W-CO-11-알람수신자설정.md`다.

## 정확한 범위

`assignment.tsv` I-28 8행을 추출하고 각 계약과 연결 스키마·헤더·응답을 전수 읽는다.
GET 4개(이벤트·구독·알림·미읽음 수), POST 3개(미리보기·읽음·모두 읽음), PUT 1개(구독).
알림 **발생 코드·전송기는 만들지 않는다**(`plan-integration.md:437-438`). Zalo는 설정 저장만.
GET 이벤트 계약의 description(발생 표 미정)과 x-internal-note(사건명별 발생 지점은 있지만
eventCode 문자열은 미확정)를 모두 읽는다. 임의 이벤트 코드 상수·샘플 시드를 만들지 않는다.

## 반드시 볼 5개 자리

1. 이벤트별 구독을 사용자별 기존 스키마에 안전하게 담는 최소 추가/완화 마이그레이션.
   토큰·zaloEnabled의 주체, 이벤트 미등록/수신자 0명/과거 행을 판정한다. 임의 사용자 sentinel 금지.
2. 계약 정본 이벤트 코드의 부재를 데이터와 어떻게 구분할지. 전용 마스터와 발생 이력을 혼동하지 않는다.
3. ROLE(사업부+역할) 및 USER 미리보기: 실제 user_role/app_user/business_unit 관계, 비활성 포함,
   중복 제거·부서 표시·사람 이름과 의미를 지어내지 않는다.
4. 자신의 알림만 조회·읽음, 목록 기간 반열림, read-all/재전송 개수, 이벤트별 ETag/If-Match와
   원자적 recipients 치환. preview는 업무 저장 0이지만 멱등 재전송 결과 유지가 필요하다.
5. 실제 유사 파일 줄 수로 PR 예산을 재고 분리. app-domain.module.ts는 A와 공용, 자기 등록만.
   `:read` 권한이 누락됐으면 자기 오퍼레이션 한 줄을 단독 커밋으로 계획한다.

## 산출물

I-24 수준의 계약 읽기 표, 물리/DB 읽기 실측, 마이그 SQL 전문, 트랜잭션 순서, 오류/코드,
파일 배치, 테스트 이름, 미정 전건 판정(README §2), 350 예산/400 상한 PR 분할,
통합계획 차이, 실측 부록(파일:줄), §12 마감 틀. §0의 검토 5개를 최종화한다.
삭제 0·백필 0. 마이그 이름은 실제 생성 시각을 초까지 사용하며 지금 적용하지 않는다.
문의 후보는 I-30과 충돌하지 않게 **번호 없이 제목만** 적는다(통합자가 090~119에서 배정).
DB 읽기 전용: docker exec omf-mes-lane-b-postgres psql -U omf_lane_b -d omf_mes_lane_b.
시드 최초 1회 완료, seed/reset/migrate dev/db pull 금지. E2E는 실행하지 않는다.
정본끼리 양립 불가능하면 즉시 통합자에게 알려라. 근거 없이 과거 결과나 숫자를 재사용하지 않는다.
