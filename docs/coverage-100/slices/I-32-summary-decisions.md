# I-32 summary 서버팀 결정·통보 — 111·112

`GET /maintenance/downtimes/summary`는 원천 행과 시각을 바꾸지 않는 파생 집계다. 새 분류 규칙에 따라 현재 계약·화면·물리 모델이 같이 지지하는 아래 규칙으로 구현하고 설계팀에 통보한다.

## 1. 범위·기간

- `plantId`·`equipmentGroupId`·`equipmentId`는 교집으로 적용하고 모순이면 빈 집계를 낸다.
- `equipmentGroupId`는 계약의 EquipmentGroup 원천인 `mdm.production_line.production_line_id`다. 별도 `mdm.equipment_group`으로 바꾸지 않고, 선택한 그룹과 하위 그룹의 설비를 포함한다.
- 각 공장 시간대의 `[startedFrom 00:00, startedTo 익일 00:00)`을 쓴다. 기간과 교차하는 닫힌 세션·비가동은 경계에서 자른다.
- 장비 없는 세션의 공장은 `terminal.plant_id`다. 장비·그룹 필터에서는 빠지만 공장 또는 전체 조회에서는 조업 합계와 `sessionsWithoutEquipmentCount`에 넣는다.

## 2. 시간·묶음

- 닫힌 `work_session`만 조업 시간에 넣고, 열린 작업 세션은 임의의 종료 시각을 만들지 않고 뺈다.
- 실제 비가동은 장비별 닫힌 구간의 합집합이다. 다른 장비 끼리는 합치지 않는다.
- `overlappingIntervalCount`는 조회 기간 안에서 엄밀히 겹침에 참여한 원본 행의 수다. 쌍·병합 그룹 수가 아니고, 맞닿기는 겹침이 아니다.
- 시간은 마이크로초로 계산하고 각 응답 합계의 마지막에서만 분을 내림한다. 비중·평균·가동률은 소수 첫째 자리에서 반올림한다.
- 기간 안의 0초 닫힌 행은 발생 count에는 넣되 minutes에는 0을 더한다. 저장된 원본 행을 지우거나 임의 길이를 만들지 않는다.

## 3. 묶음별 값

- 사유별 count·시간은 원본 닫힌 구간을 쓴다. 겹침을 임의 배분하지 않으므로 사유별 시간·비중 합이 전체 합집합을 넘을 수 있다.
- 설비별 시간은 해당 설비의 합집합, count는 원본 행 수다.
- 추이는 각 공장의 로컬 날짜 경계에서 합집합을 `DAY`·ISO 월요일 시작 `WEEK`·달력 `MONTH`로 자른다. count는 그 칸과 교차한 원본 행 수다.
- `groupBy`가 지정한 `by…` 배열 하나만 내린다. `bucket`은 `PERIOD`가 아니면 무시한다.

## 4. 경미 정지

- 임계는 각 공장에서 조회 종료일을 평가일로 하여 `PLANT > BUSINESS_UNIT > ALL`순으로 `MINOR_STOP_THRESHOLD_MINUTES`를 해석한다. ITEM·PROCESS 범위는 추론하지 않고 정책이 없을 때만 5분을 쓴다.
- 자르기 전 원본 길이가 임계보다 **짧은** 행이 경미 정지다. count는 원본 행, minutes는 기간 안으로 자른 원본 합이다. 실제 비가동 합집합에서 빼지 않고 가짜 사유도 만들지 않는다.
- 선택된 공장들의 임계가 다르면 각 행은 자신의 공장 정책으로 분류하고, 단일 응답칸 `minorStopThresholdMinutes`는 `null`로 낸다.

## 5. 계획 비가동

- 현재 WorkCalendar 도메인과 같이 `equipment.production_line_id`의 가까운 조상 그룹 override를 먼저 찾고, 없으면 공장 기본을 쓴다. `work_calendar_application.effective_from/effective_to`에 해당하는 적용만 해석한다.
- 정상 계획 조업구간은 해당 공장의 활성 교대 합집합이다. `WORKING`은 0, `HOLIDAY`는 교대 합집합 전부, `PARTIAL`은 교대 합집합 중 부분 가동 창 밖의 시간을 계획 비가동으로 세어 설비-분으로 합한다.
- 유효 캘린더·일자·활성 교대 중 하나라도 없으면 `plannedDowntimeMinutes`를 0으로 속이지 않고 응답에서 뺈다. `maintenance.planned_stop`은 계약이 지정한 WorkCalendar 원천을 대체하지 않는다.
- 과거 캘린더 편집으로 요약이 바뀌는 것은 기존 화면 규칙을 따른다. 별도 불변 스냅샷을 발명하지 않는다.

## 6. 보전 건수

- 완료 보전은 `status_code='DONE'`이고 실적이 하나 이상 있는 `maintenance_order` 한 건이다. 완료 시각은 지시별 `max(maintenance_result.completed_at)`이며, 복수 실적을 중복 계수하지 않는다.
- 사후·예방 분류는 트리거에서 파생해 저장된 `order_type_code` `CORRECTIVE`·`PREVENTIVE`를 쓴다.
- 설비 지시는 설비의 공장·그룹 범위를 적용한다. 툰 지시는 툰의 공장으로 공장/전체 조회에만 넣고 설비·그룹 필터에서는 뺀다.
- `breakdownsClosedWithoutOrderCount`는 `status_code='DONE'`이고 `completed_at`이 기간에 든 고장 중, `maintenance_order.breakdown_id` 직접 FK와 `maintenance_order_trigger(trigger_type_code='BREAKDOWN', source_id=breakdown_id)` 양쪽에 어떤 지시도 없는 건수다. 취소된 지시도 이미 발행된 흔적이므로 제외 근거다.

이 결정은 통보 대상이므로 구현을 멈추지 않는다. 구현 코드의 해당 경계에는 `결정 — 통보 111·112`를 남겨 나중에 집계 정책을 바꾸는 자리를 찾을 수 있게 한다.
