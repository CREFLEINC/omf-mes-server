# 095. 고장 복수 지시·소수 분의 null 의미

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/maintenance/breakdowns` · GET `/maintenance/breakdowns/{breakdownId}` |
| 구현 상태 | R-9대로 구현 예정 |
| 판정 | 0단계 실제다형/FK·nullable스키마. 복수/소수인 가장자리→③ 스키마유지·④ 임의선택/반올림 없음 |
| 되돌릴 때 | 단일ID 선정/반올림 또는 응답확장 결정에 따라 view/집계·클라이언트표시 변경. 원자료 보존 |

`maintenance_order.breakdown_id`와 trigger(BREAKDOWN,source_id) 양쪽을 UNION 중복제거한다. source는유일하지 않아 0건/1건/복수건이 가능하다. 1건은id, 0건과복수건은nullable응답null이며 임의최근1건을 고르지 않는다. withoutMaintenanceOrder는 존재여부를 판정하므로 복수/취소된 지시도 미발행에서 제외한다.

상세의 linkedDowntimeCount는 열린것 포함, 분합계는 종료구간의 초를 먼저합산한다. 합계가60으로나뉘면 정수분, 소수분이면null이다. 열린구간을now까지더하거나 겹침을OEE합집합으로 바꾸지 않는다. 30초2건=1분,0초=0분이며 소수분null은0이 아니다.

**확인 요청: 복수지시를 단일ID로 표현할 규칙과 소수분 표시/반올림 규칙이 필요한가?** 지금 null만으로0건과복수건을구별할수없는한계를 알린다. null을지시없음통계의 근거로 쓰지 않는다. 목록 linkedDowntimeCount=0은 계약의 목록형placeholder이며 실제비가동없음이나 경고해제의증거가 아니다. 상세GET으로 집계를 확인한다.

흔적: I-30 §4-2/3·R-9·E-B03~08, 다중연결null이어도미발행제외/0분·소수분·열린수 구별 단언에 문의095.
