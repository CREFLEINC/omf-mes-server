# I-15 계획 통합·데이터 관점 검토

검토일 2026-09-09 · I-14 병합본(PR #552), Prisma 물리 모델, 재고 원장 코어를 기준으로 검토했다.

## 판정

**진행 가능. 중단 조건 없음.** I-14의 라인 연결 칸이 병합되어 I-15 마감 조건을 라인 단위로 구현할 수 있다.

- `inventory_adjustment_line.inventory_count_line_id`와 부모 `status_code='POSTED'`를 함께 봐야 한다. FK 존재만으로는 등록·승인중 조정을 완료로 오판한다.
- 실사는 원장 비경유다. 생성·치환·마감 어느 단계도 `inventory_balance`나 `inventory_transaction`을 쓰지 않는다.
- 장부는 11개 차원을 가지지만 실사 라인은 4개만 보존한다. `on_hand_qty`를 `(location,item,lot,uom)`로 합산하는 계획이 유실을 가장 정직하게 드러낸다.
- 위치 PUT은 부모 헤더를 먼저 잠가야 두 모바일의 치환과 close가 직렬화된다. 자식부터 쓰면 close가 절반 저장을 볼 수 있다.
- NumberingService는 호출자 트랜잭션 밖에서 써야 커넥션 교착을 피한다. `plannedDate`와 창고 plant를 전달하는 판정에 동의한다.
- `counted` 추가는 forward-only·기본 false라 다른 레인과 데이터 충돌 위험이 낮다. 기존 마이그레이션은 고치지 않는다.
- E2E 정리는 count line을 CASCADE TRUNCATE하지 않고, I-14 조정 라인부터 명시 순서로 지운다.

## 보강 반영

1. 새 현장 라인의 `system_qty`는 요청값이 아니라 PUT 시점 현재 잔액의 같은 4축 합계로 확정했다.
2. 기존 라인을 재제출할 때 `system_qty`를 보존하도록 명시해 스냅샷이 현재 잔액으로 변질되지 않게 했다.
3. 마감 판정과 상태 갱신을 같은 부모 행 잠금 트랜잭션에 두고, 실패 시 버전과 멱등 레코드도 남지 않게 한다.
