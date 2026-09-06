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
 * ⚠ **여기 선 축은 여섯뿐이다.** `*statusCode` 89자리 중 78자리에 값 목록이 없고
 * (`omf-mes#213`), 값이 시드된 15그룹 중 전이까지 확정된 것이 이 여섯이다.
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
   * 툴 자산 수명주기. 설비와 «같은 값 목록»을 쓴다 — 계약이 `statusCode` 에
   * 「값 목록은 `EQUIPMENT_STATUS` 로 받는다 — 설비·툴·계측기가 같은 규칙을 쓴다」로
   * 적었다. 옛 `MOLD_STATUS`(NEW·NORMAL·REPAIR·DISPOSED)는 그룹째 내렸다 — 고장·보전
   * 중은 거래가 만드는 조건이지 자산 상태가 아니다.
   *
   * 되돌아오는 전이는 없다 — 계약에 되살리는 경로가 없다. 「폐기된 뒤에는 다시
   * 불러와도 편집이 풀리지 않는다」(계약).
   */
  'mdm.mold.status_code': {
    'mold-dispose': {
      from: ['IN_SERVICE'],
      to: 'DISPOSED',
      sourceOperation: 'POST /mdm/molds/{moldId}:dispose',
    },
  },

  /**
   * Routing Rev 수명주기. 설계 결정 07 이 「작성중·확정·폐기」 셋으로 확정했고, 시드
   * `MASTER_VERSION_STATUS` 에 세 값이 있다 — 수가 같고 짝이 하나뿐이라 매핑에 재량이 없다.
   * 값 집합이 정해져 있어 전이를 세울 수 있다 — 금형(`MOLD_STATUS`)이 막힌 것과 갈리는
   * 지점이 여기다. 되돌림 §S-1.
   *
   * ⛔ 폐기는 dead end 다 — 계약 §5-4 상태표가 「폐기 → (없음)」이라 되돌아오는 전이도,
   * 신규 Rev 의 원본으로 쓰는 길도 없다.
   *
   * ⛔ `:new-revision` 은 여기 없다. 그것은 **원본 행의 상태를 안 바꾼다** — 확정 Rev 를
   * 읽어 새 작성중 행을 만든다. 상태 전이가 아니라 「어느 상태에서 복사할 수 있는가」라
   * 서비스가 직접 본다.
   */
  'planning.routing.status_code': {
    'routing-confirm': {
      from: ['DRAFT'],
      to: 'CONFIRMED',
      sourceOperation: 'POST /planning/routings/{routingId}:confirm',
    },
    'routing-obsolete': {
      from: ['CONFIRMED'],
      to: 'OBSOLETE',
      sourceOperation: 'POST /planning/routings/{routingId}:obsolete',
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

  /**
   * 결재 요청 진행. 값은 시드 `APPROVAL_REQUEST_STATUS`(PENDING·APPROVED·REJECTED ·
   * `isSystemOwned` · 2026-09-02 등재)가 확정했고 계약이 두 전이를 열었다.
   *
   * ⛔ 이력 표가 없다 — 기록은 `approval_step` 이 진다. 그래서 `transitionCode` 가 없다.
   * ⛔ 중간 단계 승인은 «전이가 아니다» — 마지막 단계 승인에서만 이 표를 탄다.
   * ⛔ 승인은 자물쇠만 푼다(공유계약 J-8) — 대상 문서의 상태는 이 전이가 건드리지 않는다.
   */
  'app.approval_request.status_code': {
    'approval-approve': {
      from: ['PENDING'],
      to: 'APPROVED',
      sourceOperation: 'POST /app/approval-requests/{approvalRequestId}:approve',
    },
    'approval-reject': {
      from: ['PENDING'],
      to: 'REJECTED',
      sourceOperation: 'POST /app/approval-requests/{approvalRequestId}:reject',
    },
  },

  /**
   * 출고 전표 진행. 값은 시드 `LOGISTICS_DOCUMENT_STATUS` 4값(`REGISTERED`·`POSTED`·
   * `CANCEL_REQUESTED`·`CANCELLED` · `isSystemOwned`)이 확정했다.
   *
   * ⚠ `conflictStatus` 는 호출자가 **400** 을 넘긴다 — 계약이 같은 축에
   * 「전기된 전표의 라인은 바꿀 수 없다 — 400 `STATE_LOCKED`」(`GoodsIssueLineUpsert`)로
   * 400 을 명시했고, `approval.service.ts:263` 이 「409 는 If-Match 저장 충돌이 쓴다」로
   * 이미 못박았다.
   *
   * ⛔ 등록과 동시에 전기하는 경로(`postImmediately`)는 여기 오지 않는다 — `from` 이 없는
   * 전이라 표에 담을 수 없다(전표가 처음부터 `POSTED` 로 태어난다).
   */
  'logistics.goods_issue.status_code': {
    'document-post': {
      from: ['REGISTERED'],
      to: 'POSTED',
      sourceOperation: 'POST /logistics/goods-issues/{goodsIssueId}:post',
    },
    // I-5 가 이 키 안에 document-request-cancel·document-cancel 을 더한다 — 키를 다시 만들지 않는다(I-4.md R-2)
  },
};
