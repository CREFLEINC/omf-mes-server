# I-31 후속 계획 준비 메모 — 미판정

계획·구현 착수 전 탐색 기록이다. I-30 병합이 선행이며 B 담당 8건(GET4·쓰기4).
main771c541 / 계약a6a87e1 기준. 전체 정본과 I-24 예시, I-30의 확정 R 및 마감 인계를 먼저 읽는다.
현재 equipment 계약의 orders/results 5경로·8건, MaintenanceOrder*/MaintenanceResult* 스키마를 읽었다.
실제 화면 W-05-05·W-05-06·W-05-02·W-05-03과 물리·DDL·코드그룹 전건은 계획자가 추가 실측한다.

## 반드시 판정할 다섯 축

1. 트리거 배열과 물리 카디널리티. 기존 maintenance_order_trigger는 order_id UNIQUE다.
   계약 triggers[]의 복수 사건, source 종류별 required/null, 대상 일치, 중복·동일 사건 재발행을
   정의해야 한다. I-30은 직접 breakdown FK와 다형 trigger 양쪽을 읽으므로 인계와 일치시킨다.
   고장이 하나라도 섞이면 CORRECTIVE, 나머지 PREVENTIVE. 빈 트리거의 본길/가장자리 판정 필요.
   PM_DUE는 가리킬 행이 없어 sourceId=null, shot/date/snapshot은 입력·서버 검증 경계를 확인한다.
2. 지시 항목. EQUIPMENT는 실제 부여된 equipment_inspection_item을 참조, MOLD는 자유 이름.
   items가 있으면 itemNames보다 우선. 빈 items/중복 순서/양쪽 이름/마스터 변경 스냅샷,
   지시 상태 ISSUED/DONE/CANCELLED와 항목 PLANNED/DONE/NA는 별개 축이다.
   취소는 실적0일 때만. 취소·실적등록·마감 경합은 같은 지시 잠금으로 판정한다.
3. 실적 생성·수정·마감. 지시 없어도 생성 가능, 대상·고장·지시 참조 일치, resultLine은
   대상에 따라 결과 의미가 다르지만 고객 확장 그룹 하나다. closed=true 허용 기준(완료/해당없음)과
   그 결과 문자열/소유를 실측한다. 서로 다른 실적의 누적 항목 상태 및 지시 전체 마감 주체를
   추측하지 않는다. 외주 performer/vendor 짝·finishedAt 선후관계·수정 가능한 칸만 검증한다.
4. 툴 누계 resetCounter. POST If-Match는 선택이지만 reset=true일 때는 툴 ETag 필수(없으면422).
   실적 ETag와 다른 자원이며 PUT에는 reset 입력 자체가 없다. 툴 동시 사용량 증분과의 잠금,
   전후 누계 스냅샷·version 증가·보전 기준일/다음 주기 변경 의미를 코드/계약과 대조한다.
   reset을 과거 실적 수정 때 다시 실행하지 않는다. 코어·마이그 심장 R 확정 전 구현 금지.
5. A16~A19/V 이외 결손 전건·PR 예산. 실적 line/part 신설·FK·CHECK·필수 과거행·채번을 실측.
   부품은 이미 발행된 goodsIssue를 참조할 뿐 출고/재고 posting을 만들지 않는다.
   goodsIssueNo/issuedAt/uomCode는 readOnly, 클라이언트가 보낸 값을 저장 정본으로 쓰지 않는다.
   같은 IdempotencyService.run tx 안의 업무/응답 저장, actor/귀속 지문은 확정 B 선례를 따른다.
   조회 응답 필드 단언은 조회 PR에 붙이고, 일반 예산350/상한400·코어200을 실제 유사 파일로 나눈다.

보전 완료가 고장 완료/W/O 재개/비가동 종료를 자동 수행하는지 계약에 근거가 없으면 만들지 않는다.
상태 전이표·spec은 A 소유: 먼저 사용자 보고, 자기 신규 키만, 공용 정렬/기존 전이 변경 금지.
문의는090~119 실제 사용 확인 후 통합자가 배정하며 I-30의 동일 미정은 기존 번호와 연결한다.
DB는 B 전용, 계획 단계 SELECT만. 추가·완화만/삭제·백필0, 마이그 별도 선행 커밋, 시드 금지.
