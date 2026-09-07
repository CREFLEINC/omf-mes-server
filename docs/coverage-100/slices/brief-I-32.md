# I-32 후속 계획 준비 메모 — 미판정

계획·구현 착수 전 탐색 기록이다. 선행 I-11 완료, 배정은 6건(GET 3, 쓰기 3).
고정 계약 a6a87e1 / main 771c541 / 화면 사본46f0ef5. 계획자는 정본7건과 I-24 예시를 읽는다.
원격 변경 시 main 갱신과 B 선행 I-30 변경을 대조한다. 계약 갱신 금지.

## 본문 확인 완료한 자료

- equipment 계약의 `/maintenance/downtimes` 4개 경로·6건 및 Downtime* 스키마 전부.
- P-05-02-비가동실적입력.md 전체341줄, W-05-08-비가동집계조회.md 전체354줄.
- schema.prisma equipment_downtime:4147, work_session:2986.
- plan-integration I-32, plan-uiux U35. plan-api S24도 계획 착수 시 전건 읽는다.

## 반드시 판정할 다섯 축

1. V 하나로는 응답·쓰기 물리를 담지 못한다. equipment_downtime에는 remarks,
   recordedByWorkerNo 저장소가 없고 created_by 의미를 사번이라고 추측할 수 없다.
   downtime_type_code 필수/기본 없음, reason_code nullable. Worker-No와 app_user FK closed_by를
   분리한다. 새 필수 칸을 임의 값으로 백필하지 않으며 과거행 required 응답까지 계획한다.
2. 시간·구간. Create startedAt은 단말 시각인데 :close는 본문이 없고 "지금 시각"이다.
   오프라인 요청의 발생 시각을 받지 않으므로 서버가 존재하지 않는 헤더를 발명하지 않는다.
   계약/공유계약 C-12와의 충돌 여부, 미래 입력 거부, ended>=started, 열린 구간 중복 생성 방지,
   겹친 닫힌 구간은 허용, 동일 설비 병렬 요청 잠금, null 종료 재개 여부를 각각 판정한다.
3. 조회/집계 시간대와 범위. openOnly=true만 기간 생략 가능, 나머지 기간 필수.
   날짜는 plant.timezone_code 축으로 변환하고 UTC를 공장 날짜로 가정하지 않는다.
   기간 경계 구간 자르기/선택 기준, 겹침 판정은 설비별, total은 합집합, 사유별은 배분 금지.
   열린 비가동은 제외+건수지만 열린 작업 세션의 분모 처리는 명시 미정이므로 동일 정책 복제 금지.
4. 집계 소비자. 실제 조업시간 Σ세션과 계획비가동 캘린더를 구분한다. equipment 없는 세션은
   조업시간 포함/설비별 제외+건수. groupBy마다 해당 by배열만, PERIOD DAY/WEEK/MONTH 경계,
   minor stop 정책 MINOR_STOP_THRESHOLD_MINUTES 기본5, actual합계에 포함하되 별도 수치.
   사후/예방 완료 보전 및 지시 없이 완료 고장 건수는 I-30/I-31 원천을 검토한다.
   OEE·W/O 홀드 시간을 합산하지 않는다. nullable workSessionId는 조용히 파생하지 않는다.
5. 헤더/권한/원자성과 분할. 쓰기 3건 멱등, Create/close 사번, PUT If-Match 필수,
   close If-Match 선택, detail만 ETag. close 400 미선언/409 설명의 업무400/422 봉투를 대조한다.
   runIdempotent 공용 래퍼는 업무 tx를 전달하지 않으므로 직접 IdempotencyService.run(tx) 검토.
   비테스트 예산350/상한400, 코어200. 집계는 단순 조회와 분할, 실제 유사 파일로 규모 산정.

설계 미정은 README §2 전 단계와 테스트·문의 후보로 남긴다. 본길 미정이면 해당 operation을
보류하고 @Contract 가짜 핸들러를 붙이지 않는다. 보류와 전체 루틴 멈춤 조건을 구분한다.
문의090~119 배정은 통합자만 한다. 계획 작업은 전용 B DB 읽기만, 시드 재실행 금지.
