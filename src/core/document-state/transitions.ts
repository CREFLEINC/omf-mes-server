import { ActionName, Transition, TransitionRegistry } from './document-state.types';

/**
 * 물류 문서 취소 두 액션. 입하·입고·출고 세 표가 «글자 그대로 같은» 규칙을 쓴다 —
 * 취소 주소가 유형 축 하나(`documentTypeCode`)라 표마다 갈릴 자리가 없다(I-5.md §6-1).
 *
 * ⛔ 되돌리는 전이를 만들지 않는다 — 반려 뒤 `CANCEL_REQUESTED` 를 되돌리는 오퍼레이션이
 *    계약에 없다(승인 9경로에 철회·취소 0건 · I-5.md §6-5 · 문의 033).
 * ⛔ `transitionCode` 를 안 쓴다 — 이력 표가 없는 축이다(`trace.lot` 만 갖는 칸).
 */
const DOCUMENT_CANCEL_ACTIONS: Record<ActionName, Transition> = {
  'document-request-cancel': {
    from: ['REGISTERED', 'POSTED'],
    to: 'CANCEL_REQUESTED',
    sourceOperation:
      'POST /logistics/document-progress/{documentTypeCode}/{documentId}:request-cancel',
  },
  'document-cancel': {
    from: ['CANCEL_REQUESTED'],
    to: 'CANCELLED',
    sourceOperation: 'POST /logistics/document-progress/{documentTypeCode}/{documentId}:cancel',
  },
};

// 검사·보류가 여는 오퍼레이션 셋 — 아래 신설 전이 10 중 9 가 이 셋을 되풀이한다.
const CONFIRM = 'POST /quality/inspection-results/{inspectionResultId}:confirm';
const HOLD = 'POST /quality/lot-holds';
const RELEASE = 'POST /quality/lot-holds/{lotHoldId}:release';

/**
 * 전이표. **데이터로 둔다** — 코드에 상태 문자열을 박으면 값이 확정될 때 찾아 고칠 수 없다
 * (`'PREISSUED'` 교훈: 값이 CHECK 한 곳에만 있고 아무 데서도 안 쓰였다).
 *
 * ⛔ **여기 없는 (칸, 액션) 은 「통과」가 아니라 「던짐」이다**(공유계약 F-6 —
 * 「판정할 수 없음」을 「통과」로 처리하지 않는다). 계약의 액션형 오퍼레이션 109건 중
 * 85건이 409 를 선언하는데, 값 목록이 없는 상태에서 그 판정을 흉내 내면 «아무 전이나»
 * 통과시키는 것과 같다.
 *
 * ⚠ **여기 선 축은 일곱뿐이다.** `*statusCode` 89자리 중 78자리에 값 목록이 없고
 * (`omf-mes#213`), 값이 시드된 15그룹 중 전이까지 확정된 것이 이 일곱이다.
 *
 * ⭐ **품질 판정 축(`trace.lot.status_code`)을 2026-09-07 에 채웠다**(I-19 PR ①).
 * 비워 둔 이유였던 「판정 유형 값 목록은 고객 회신 대기(회신 E-3)」가 **2026-08-07 에
 * 종결**됐다(`design/raw/process/uiux/2026-08-07-E3-판정유형-제안안/LOT상태-확정기록.md:5` ·
 * 계약도 `INSPECTION_RESULT_OVERALL_JUDGMENT` 설명에 「근거: 회신 E-3 종결 2026-08-07」을
 * 적었다). 그 확정이 `LOT_STATUS_TRANSITION` 이 말하는 「보류」와 「PQC 검사 필요」를 값
 * 하나(`INSPECTION_PENDING`)로 합쳤다 — 상태 목록이 LOT 종류 공통인데 이름에 검사 종류를
 * 박을 수 없어서다(확정 기록 §1.2). 그래서 시드 두 그룹이 이제 맞물린다.
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
   * 생산계획 확정. 값은 시드 `PRODUCTION_PLAN_STATUS` 2값(`DRAFT`·`CONFIRMED` ·
   * `isSystemOwned` · DB 실재)이 확정했다.
   *
   * ⚠ `conflictStatus` 는 호출자가 **400** 을 넘긴다 — 계약 `ProductionPlan.statusCode` 가
   * 「확정 뒤에는 수정·삭제가 막힌다(400 STATE_LOCKED)」라 적었다(`planning.routing` 과 같다).
   * ⛔ 되돌아오는 전이가 없다 — 확정을 푸는 오퍼레이션이 계약에 0건이다.
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다.
   */
  'planning.production_plan.status_code': {
    'plan-confirm': {
      from: ['DRAFT'],
      to: 'CONFIRMED',
      sourceOperation: 'POST /planning/production-plans/{productionPlanId}:confirm',
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
   * 검사 성적서 확정. 값은 시드 `INSPECTION_RESULT_STATUS` 2값(`DRAFT`·`CONFIRMED`)이 확정했다.
   *
   * ⚠ `conflictStatus` 는 호출자가 **400** 을 넘긴다 — 재확정은 재로드해도 안 풀리는 잠금이다.
   *    ⛔ 그러나 `PUT` 의 확정본 수정은 **409 `INVALID_STATE`** 다 — 계약이 그 자리에만 409 를
   *    문자로 적었다(`InspectionResultUpdate` 설명). 두 자리의 봉투가 다르다.
   * ⛔ 되돌아오는 전이가 없다 — 확정을 푸는 오퍼레이션이 계약에 0건이고 번복은 재검 회차다(B-10).
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다.
   */
  'quality.inspection_result.status_code': {
    'inspection-confirm': { from: ['DRAFT'], to: 'CONFIRMED', sourceOperation: CONFIRM },
  },

  /**
   * LOT 품질 판정 축. 값은 시드 `LOT_STATUS` 4값이고 전이 코드는 시드
   * `LOT_STATUS_TRANSITION`(C4~C15)이 갖는다 — 코드는 `trace.lot_status_event.transition_code`
   * (NOT NULL)에 그대로 들어간다. 생명주기 축과 «한 필드에 섞지 않는다»(`02-SW설계사양서` §4.2).
   *
   * ⭐ **`from` 이 액션마다 다르다 — 한 상수로 묶지 않는다.** 계약이 「불량(Hold)은 발신 전이가
   *    0」이라 적었고(`contracts/quality-03품질.json:4472` · 화면 정본 `W-03-02` §5-5 도식이
   *    「Hold 발신 (없음)」), 그 유일한 예외를 재등록 한 경로에만 열었다 — 「⭐ 이 경로에서만
   *    반영 목적의 Hold → 정상 전이가 허용된다」(B-13 · `shipment-04제품출하.json:431`).
   *    ⇒ `DEFECTIVE` 는 `stock-reinstate` 의 `from` 에만 있고, 나머지 여덟의 출발 상태는
   *    위 도식의 «수신·발신»에서 그대로 읽는다.
   * ⛔ `SCRAPPED` 는 `from` 에도 `to` 에도 없다 — 계약이 어느 오퍼레이션에도 적지 않았다.
   * ⛔ `C15`(전수 재검 양품)를 등록하지 않는다 — `C4` 와 (from, to) 가 같은데 어느 LOT 이
   *    `C14` 로 그 자리에 왔는지 가릴 표식이 데이터에 없다(F-6 · 문의 069+8).
   */
  'trace.lot.status_code': {
    // ── 검사 확정(I-19)이 쓴다 ─────────────────────────────────────
    'inspection-accepted': { from: ['NORMAL', 'INSPECTION_PENDING'], to: 'NORMAL',
      transitionCode: 'C4', sourceOperation: CONFIRM },
    'inspection-held': { from: ['NORMAL', 'INSPECTION_PENDING'], to: 'INSPECTION_PENDING',
      transitionCode: 'C5', sourceOperation: CONFIRM },
    'inspection-rejected': { from: ['NORMAL', 'INSPECTION_PENDING'], to: 'DEFECTIVE',
      transitionCode: 'C6', sourceOperation: CONFIRM },
    // 「PQC 불합격이 합격판정개수를 넘으면 같은 W/O 의 생산LOT 전체를 옮긴다」 — 대상이
    // 집합이라 `from` 밖의 LOT 이 섞인다. 코어가 던지지 않고 건너뛰는 이유가 여기다.
    'pqc-acceptance-exceeded': { from: ['NORMAL', 'INSPECTION_PENDING'], to: 'INSPECTION_PENDING',
      transitionCode: 'C14', sourceOperation: CONFIRM },

    // ── I-20(보류)이 쓴다 · 여기서는 등록만 한다 ───────────────────
    'lot-hold-release-accepted': { from: ['INSPECTION_PENDING'], to: 'NORMAL',
      transitionCode: 'C7', sourceOperation: RELEASE },
    'lot-hold-release-rejected': { from: ['INSPECTION_PENDING'], to: 'DEFECTIVE',
      transitionCode: 'C8', sourceOperation: RELEASE },
    'lot-hold-claim': { from: ['NORMAL'], to: 'DEFECTIVE',
      transitionCode: 'C9', sourceOperation: HOLD },
    'lot-hold-suspect': { from: ['NORMAL', 'INSPECTION_PENDING'], to: 'INSPECTION_PENDING',
      transitionCode: 'C10', sourceOperation: HOLD },

    // ── I-23(레인 C · 재고 재등록)이 쓴다 ──────────────────────────
    // ⛔ `transitionCode` 가 없다 — 이력 칸은 NOT NULL 인데 계약 enum 9값(C4~C15)에 재등록을
    //    가리키는 코드가 «없다». 지어내지 않고 호출자가 넘기게 둔다. 설계 미정 — 문의 069+12.
    'stock-reinstate': { from: ['DEFECTIVE'], to: 'NORMAL',
      sourceOperation: 'POST /logistics/stock-reinstatements' },
  },

  /**
   * 작업지시 진행. 값은 시드 `WORK_ORDER_STATUS` 8값이 확정했다(2026-09-02 사용자 확정 · G-32).
   *
   * ⛔ `CONFIRMED` 를 «지나지» 않는다 — `PLANNED`→`CONFIRMED` 를 여는 오퍼레이션이 계약에 없고
   *    `:release` 하나가 「확정과 배포와 선발행」을 한 트랜잭션으로 한다. 두 값을 다 `from` 에 둔다.
   * ⛔ `IN_PROGRESS` 로 «들어가는» 액션은 세션 열기의 부수효과다 — I-11 이 같은 키에
   *    `work-session-start` 를 더했다(I-4 R-2 방식 — 키를 다시 만들지 않는다).
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다(LOT 축만 갖는 칸).
   */
  'production.work_order.status_code': {
    'work-order-release': { from: ['PLANNED', 'CONFIRMED'], to: 'RELEASED',
      sourceOperation: 'POST /production/work-orders/{workOrderId}:release' },
    'work-order-hold':    { from: ['RELEASED', 'IN_PROGRESS'], to: 'SUSPENDED',
      sourceOperation: 'POST /production/work-orders/{workOrderId}:hold' },
    'work-order-resume':  { from: ['SUSPENDED'], to: 'IN_PROGRESS',
      sourceOperation: 'POST /production/work-orders/{workOrderId}:resume' },
    'work-order-close':   { from: ['COMPLETED', 'IN_PROGRESS'], to: 'CLOSED',
      sourceOperation: 'POST /production/work-orders/{workOrderId}:close' },
    'work-order-cancel':  { from: ['PLANNED','CONFIRMED','RELEASED','IN_PROGRESS','SUSPENDED'], to: 'CANCELLED',
      sourceOperation: 'POST /production/work-orders/{workOrderId}:cancel' },
    // `IN_PROGRESS` 도 `from` 에 있다 — 계약 `sessionNo` ⌜`:end` 한 뒤 다시 시작⌝ 이
    // 둘째 세션을 `IN_PROGRESS` 에서 연다.
    // `SUSPENDED` 는 없다 — 중단된 W/O 는 새 세션이 아니라 같은 세션의 RESUME 로만
    // 돌아온다(`P-02-01` §5-5).
    'work-session-start': { from: ['RELEASED', 'IN_PROGRESS'], to: 'IN_PROGRESS',
      sourceOperation: 'POST /production/work-sessions' },
  },

  /**
   * 작업 세션 진행. 값은 시드 `WORK_SESSION_STATUS` 3값(`RUNNING`·`STOPPED`·`ENDED` ·
   * DB 실재)이 확정했고 A-25 전이표가 START·RESUME→진행 / STOP→중단 / END→종료를
   * 문장으로 확정했다.
   *
   * ⚠ `conflictStatus` 는 호출자가 **400** 을 넘긴다 — 계약이 같은 축에 400 `STATE_LOCKED`
   * 를 적었다(`work-order-transition.service.ts:71` 과 같다).
   *
   * ⛔ 세션의 탄생(`RUNNING`)은 여기 오지 않는다 — `from` 이 없는 자리라 표에 담을 수 없다
   *    (`logistics.goods_issue.status_code` 의 `postImmediately` 와 같은 판단).
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다(LOT 축만 갖는 칸).
   */
  'production.work_session.status_code': {
    'work-session-stop':   { from: ['RUNNING'],            to: 'STOPPED',
      sourceOperation: 'POST /production/work-sessions/{workSessionId}/events' },
    'work-session-resume': { from: ['STOPPED'],            to: 'RUNNING',
      sourceOperation: 'POST /production/work-sessions/{workSessionId}/events' },
    'work-session-end':    { from: ['RUNNING', 'STOPPED'], to: 'ENDED',
      sourceOperation: 'POST /production/work-sessions/{workSessionId}:end' },
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
    ...DOCUMENT_CANCEL_ACTIONS,
  },

  /**
   * 입하·입고 전표 진행. 출고와 «같은 두 액션»만 갖는다 — 세 유형이 한 취소 경로를 탄다
   * (계약 `documentTypeCode` enum 3값 · I-5.md §6-1).
   *
   * ⚠ 입하는 `POSTED` 에 도달하는 길이 아직 없다(I-3 §5-3 · 문의 026) — `from` 의 `POSTED`
   *   는 입하에서 도달 불가지만 계약 문장대로 두고 좁히지 않는다.
   */
  'logistics.inbound_receipt.status_code': { ...DOCUMENT_CANCEL_ACTIONS },
  'logistics.goods_receipt.status_code': { ...DOCUMENT_CANCEL_ACTIONS },

  /**
   * 적치 작업 진행. 값은 시드 `PUTAWAY_TASK_STATUS` 3값(DB 실재 · ⛔ 시스템 소유)이 확정했고
   * 계약이 전이 둘을 그대로 연다. ⛔ 되돌아오는 전이는 없다 — 임시 적치에서 정상 적치로 가는
   * 오퍼레이션이 계약에 0건이다(dead end · 문의 059+2).
   * ⚠ `conflictStatus` 는 호출자가 400 을 넘긴다 — `M-01-05` §6 「이미 완료된 지시 400 STATE_LOCKED」.
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다(LOT 축만 갖는 칸).
   */
  'logistics.putaway_task.status_code': {
    'putaway-complete': {
      from: ['PENDING'],
      to: 'COMPLETED',
      sourceOperation: 'POST /logistics/putaway-tasks/{putawayTaskId}:complete',
    },
    'putaway-complete-temporary': {
      from: ['PENDING'],
      to: 'COMPLETED_TEMPORARY',
      sourceOperation: 'POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary',
    },
  },
};
