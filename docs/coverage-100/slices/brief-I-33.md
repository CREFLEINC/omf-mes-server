# I-33 툴 사용·검교정·수집 채널 — 독립 개별 계획 브리프

계획만 준비한다. 구현은 I-31 인계 및 자기 3관점 재수립 이후이며 선행을 완료했다고 추정하지 않는다.
기준 main f521a89366f349ee691aca1cec0d725dca702ce4 공식350/487, 계약 a6a87e1 고정.
I-30① 점검GET2는 다른 구현자의 결과가 독립 코드 리뷰 중이며 후보352를 main 수치로 쓰지 않는다.
산출물은 `.backend-dev/lane-b/I-33-draft.md` 한 파일, I-24와 같은 깊이의 전건 계획이다.

## 실제 배정 12건

`docs/coverage-100/assignment.tsv:233~244`의 I-33 행이 범위다.
GET calibrations 목록/상세 2, POST calibrations 등록/`:clear` 2.
GET collection-channels 목록/상세/observations 3, POST 등록·PUT 수정 2.
GET tool-usages 목록/상세 2, POST 등록 1. 다른 operation·센서 수집 daemon·외부 통신 구현0.

## 먼저 직접 읽을 정본

CLAUDE.md, coverage README·lanes·lane-B, server-architecture, 기존 구현 도메인 규칙, I-24 개별계획 전체.
plan.md I33/A20~22/M-g/V/T 및 plan-api S24·관련 마이그/오류, plan-uiux U36/U37/수집채널 절, plan-integration I33 전 절.
고정 equipment-05설비툴.json 대상12 operation·연결 schema/parameter/response 전건, 실제 DB 모델·초기/후속 DDL·코드그룹 정의.
실제 설계 화면 P-05-01/W-05-10/W-05-11 및 수집채널 관련 화면을 경로 검색으로 찾아 전건 읽는다. 제목/코드만 보고 값을 확정하지 않는다.
I-30 R·인계 및 I-31 계획과 이어질 실제 툴 누계/리셋 소비자를 확인한다. I-31 초안은 다른 agent가 작성 중이므로 읽기 전 root에게 요청한다.
설계참고는 읽기전용, 최신 화면 문언이 고정 계약보다 뒤에 추가됐으면 시점 차이를 명시한다. contracts:update/check0.

## 반드시 볼 다섯 축

1. 툴 사용 입력·시각·누계: 입력 원천별 필수/선택, 수집 방식/변환비/누계 산식/정수 범위, 같은 툴 잠금·I31 resetCounter 경합·버전·재생을 실제 계약/물리로 확인한다. 생산실적/재고를 자동 쓰지 않는다.
2. 검교정 필수 응답과 차단/해소: 실제 코드 값/날짜/사번 원천, blocksUse·clearedAt 판정, 이미 해소/비차단 오류, 다음기한·계측기 마스터 갱신 범위를 확인한다. 결과 코드 본길과 가장자리를 구분하고 원천 없는 값을 PASS 등으로 만들지 않는다.
3. 수집 채널의 다섯 추가칸과 nullable 유일성: channel_key와 현 channel_code의 차이, 설비/신호/검사항목/품목/공정 조합, NULL partial unique 및 기존 중복/구 writer, 참조 검증·수정/비활성 의미를 실측한다. 물리 NOT NULL을 임의 기본값으로 메우지 않는다.
4. observations 실제 표·입력자·응답 전필드: 초기 표 이름을 정답으로 가정하지 말고 collection_observation/collection_channel_observation 실재·원천·보관·최신 순서·페이지 전 필터를 확인한다. 조회용 표 신설과 실제 수집기 구현을 구별한다. 빈 DB를 원천 정의 부재로 오인하지 않는다.
5. 350/400 예산·마이그/코어 분리·전건 테스트: required 과거행 SELECT, 추가/완화 SQL 전문(삭제/백필0), API 응답 전필드/오류/헤더, actor·worker·동일 tx 멱등, DI 자기 등록, 실제 비교 파일 줄 수에 근거한 PR 분할. 상태표 A 소유·새 ERROR_CODE 금지.

§0 다섯 축, §0-재수립은 리뷰 전 미판정 표, §1 계약전수표, 물리/SQL전문, 트랜잭션 순서, 테스트 이름 목록, 미정별 0→1→2→3단계 판정, 예산/분할, §11 사실+파일:줄 실측부록, §12 미완/마감표를 둔다.
확정·권고·질문을 분리하고 오래된 통합표를 그대로 복사하지 않는다. source 작성/테스트 실행/PR/DB 변경은 이 역할의 범위 밖이다.

## 설계 미정 절차 전문 요약

0단계 계약 본문·기존 구현 도메인 규칙·이미 구현된 전표를 찾아 인용한다.
1단계 특정 조건만 갈리는 가장자리는2단계, 모든 호출 결과가 갈리는 본길은 계약 문자 그대로+문의이며 계약도 침묵하면 해당 operation 유보한다.
2단계 처음 맞는 기준: ①재고·원장·상태를 쓰지 않음 ②명시 에러 거부 ③스키마 안늘림/필요하면nullable ④값을 조용히 도출하지 않음 ⑤새개념수 기준 난이도.
3단계 이름 붙인 에러/고정값·테스트 문의주석·요청서 선택 단계/기준으로 흔적을 남긴다. 전건 거부 handler/가짜 커버리지0.
중단은 두 릴리스 삭제 위반·원인불명 게이트3회·어느 쪽도 맞출 수 없는 계약 정면모순만이다. 특정 operation 미정은 다른 확정 경로를 막지 않는다.

## 안전·인계

DB를 직접 쓰거나 E2E를 실행하지 않는다. 필요한 읽기 SELECT 전문을 계획서에 제시하면 root가 전용 B DB에서 실행하고 결과를 전달한다. 스키마/DDL과 실제 DB 관측을 구분한다.
새 문의 번호는 root만 배정한다. 현재090~112 사용/예약되어113~119가 남았고 I31과 공유하므로 임의 선점0. 기존문의 중복은 연결한다.
apply_patch 편집만, git 변이·gh·설계/client외부 메시지0, 다른 agent 생성0. source/공유 docs/계약/프리뷰/마이그파일 수정0.
engineering:documentation 및 CREFLE coding-rules SKILL/필수 TS·commit 참조를 직접완독하고 적용을 알린다. 모델 제품/서명 사칭0.
완료 시 읽은 범위·실측/미실측·유보/진행·SQL 요청·source/DB 변경0과 파일 소유 반환을 명시한다.
