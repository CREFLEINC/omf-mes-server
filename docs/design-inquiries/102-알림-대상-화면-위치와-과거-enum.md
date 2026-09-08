# 102. 알림 대상의 화면·위치 원천과 과거 유형 표시

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/app/notifications` · POST `/app/notifications/{notificationId}:read` |
| 구현 상태 | **구현 예정(I-28 R-7). 저장 조회·읽음은 진행** |
| 판정 | 0단계 계약 optional 생략·승인 문의019 fallback; enum 밖 과거값은 가장자리→2단계③ 스키마 추가 없이 optional 대상쌍 생략 |
| 되돌릴 때 | 대상→화면 매핑/위치의 권한 있는 원천이 생기면 view와 테스트 확장. 원본 event/message는 보존 |

`app-공통.json:4970,5010,5034,5039`는 Notification required6칸과 optional 대상/화면/위치를 정의한다. 실제 발생표에는 대상유형/id가 있지만 화면·위치 칸과 확정 payload규약은 없다. 승인 매퍼도 같은 한계로 openable=false다(019).

현재 openable=false, screenId/locationPath 생략, 저장 eventCode/message 유지로 읽는다. 알려진 enum9유형은 대상쌍을 보존한다. 과거 enum밖이면 targetTypeCode/targetId를 함께 생략한다. payload 임의 키나 현재 위치로 과거 알림을 재조립하지 않는다.

**확인 요청: 대상→screenId/locationPath의 원천은 무엇인가? enum 밖 과거 유형 원문을 표시해야 한다면 계약의 어느 칸으로 전달할 것인가?** 지금 생략하면 원본 유형 표시가 사라지는 한계를 알린다. eventCode/message를 임의 수정해 대신 싣지 않는다.

openable=false는 대상 삭제의 증거가 아니다. W-CO-03의 「대상이 더 이상 없습니다」를 매핑 부재에 사용하지 않는다. 항목 클릭→읽음204→미읽음 목록/배지 재조회는 정상 동작한다. 제목/유형 목록 미완은099와 별도다.

흔적: `I-28.md` R-7, §1-2·8-1·8-4. enum밖 생략/openablefalse 대상쌍 보존/읽음 후 배지 제거 단언에 문의102 주석을 둔다.
