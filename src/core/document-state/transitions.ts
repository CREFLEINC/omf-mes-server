import { TransitionRegistry } from './document-state.types';

/**
 * 전이표. **데이터로 둔다** — 코드에 상태 문자열을 박으면 값이 확정될 때 찾아 고칠 수 없다
 * (`'PREISSUED'` 교훈: 값이 CHECK 한 곳에만 있고 아무 데서도 안 쓰였다).
 *
 * ⛔ **여기 없는 (칸, 액션) 은 「통과」가 아니라 「던짐」이다**(공유계약 F-6 —
 * 「판정할 수 없음」을 「통과」로 처리하지 않는다). 계약의 액션형 오퍼레이션 109건 중
 * 85건이 409 를 선언하는데, 값 목록이 없는 상태에서 그 판정을 흉내 내면 «아무 전이나»
 * 통과시키는 것과 같다.
 *
 * ⚠ **지금 등록된 것은 하나뿐이다.** `*statusCode` 89자리 중 78자리에 값 목록이 없고
 * (`omf-mes#213`), 값이 시드된 15그룹 중 전이까지 확정된 것이 이것 하나다.
 *
 * ⛔ **품질 판정 축(`trace.lot.status_code`)은 일부러 비워 두었다.**
 * `LOT_STATUS_TRANSITION` 이 가리키는 상태(`Release(합격)`·`Hold(불합격)`·`보류`·
 * `PQC 검사 필요`)와 시드된 `LOT_STATUS`(`NORMAL`·`INSPECTION_PENDING`·`DEFECTIVE`·
 * `SCRAPPED`)가 맞지 않는다 — 특히 `C14` 가 가리키는 「PQC 검사 필요」는 값 목록에 없다.
 * 설계도 「판정 유형 값 목록은 **고객 회신 대기(회신 E-3)**」라 적었다. 지금 매핑하면
 * 회신 전에 우리가 판정 체계를 지어내는 것이다.
 *
 * ⛔ `:activate`/`:deactivate` **36건은 여기 오지 않는다.** 그것들은 `is_active` 불리언
 * 토글이고 `status_code` 를 건드리지 않는다(`app/roles/{roleId}:deactivate` 실측).
 * 상태기계가 아니다.
 */
export const TRANSITIONS: TransitionRegistry = {
  /**
   * 설비 자산 수명주기. 시드 `EQUIPMENT_STATUS`(`IN_SERVICE`·`DISPOSED`)가 두 값을
   * 확정했고 계약이 전이를 하나만 열었다(`:dispose`).
   *
   * ⛔ `is_active` 와 «다른 축»이다 — 사용 중지는 목록에서 감추는 것이고 폐기는 자산이
   * 끝난 것이다(공유계약 `B-16`). 그래서 이 표는 두 축을 함께 갖는다.
   * 되돌아오는 전이는 없다 — 계약에 `:restore` 가 없다.
   */
  'mdm.equipment.status_code': {
    'equipment-dispose': {
      from: ['IN_SERVICE'],
      to: 'DISPOSED',
      sourceOperation: 'POST /mdm/equipments/{equipmentId}:dispose',
    },
  },

  /**
   * 생산LOT 생명주기. 설계 확정 2026-08-07(`omf-mes#46`) + `DR-007`(2026-08-12).
   * 전이 코드는 `trace.lot_lifecycle_history.transition_code` 에 들어간다.
   */
  'trace.lot.lifecycle_status_code': {
    /** 첫 실적이 붙는다 — 선발행 슬롯에 실물이 귀속된다. */
    'production-result-recorded': {
      from: ['WAITING'],
      to: 'ACTIVE',
      transitionCode: 'L1',
      sourceOperation: 'POST /production/production-results',
    },
    /** W/O 마감. 실적 없는 슬롯만 대상이다(`R82`). */
    'work-order-close': {
      from: ['WAITING'],
      to: 'VOIDED',
      transitionCode: 'L2',
      sourceOperation: 'POST /production/work-orders/{workOrderId}:close',
    },
    /**
     * W/O 취소. ⭐ `R82` 와 **대상 집합이 다르다** — `:cancel` 은 선발행 슬롯을 «전건»
     * 즉시 폐번한다(`DR-007` · `W-02-06` §5-5). 그래서 `ACTIVE` 도 들어온다.
     * ⚠ `02-SW설계사양서` §4.4 는 「활성→폐번 없음」이라 적었는데 그것은 `PLOT`(2026-07-29)
     * 인용이고 `DR-007` 이 넘어섰다.
     */
    'work-order-cancel': {
      from: ['WAITING', 'ACTIVE'],
      to: 'VOIDED',
      transitionCode: 'L3',
      sourceOperation: 'POST /production/work-orders/{workOrderId}:cancel',
    },
  },
};
