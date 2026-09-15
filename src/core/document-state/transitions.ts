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
/** 처분 판정 저장 — LOT 축 전이 3 과 부적합 축 전이 1 을 «한 트랜잭션»에서 연다(I-21 · B-8). */
const DECIDE = 'POST /quality/nonconformances/{nonconformanceId}/disposition-decisions';

/**
 * 전이표. **데이터로 둔다** — 코드에 상태 문자열을 박으면 값이 확정될 때 찾아 고칠 수 없다
 * (`'PREISSUED'` 교훈: 값이 CHECK 한 곳에만 있고 아무 데서도 안 쓰였다).
 *
 * ⛔ **여기 없는 (칸, 액션) 은 「통과」가 아니라 「던짐」이다**(공유계약 F-6 —
 * 「판정할 수 없음」을 「통과」로 처리하지 않는다). 계약의 액션형 오퍼레이션 109건 중
 * 85건이 409 를 선언하는데, 값 목록이 없는 상태에서 그 판정을 흉내 내면 «아무 전이나»
 * 통과시키는 것과 같다.
 *
 * ⚠ **여기 선 축은 «전부»가 아니다.** `*statusCode` 89자리 중 대부분에 값 목록이 없어
 * (`omf-mes#213`) 전이까지 확정된 축만 선다.
 * ⛔ **수를 여기 글로 적지 않는다** — 「일곱」이라 적혀 있던 것이 열아홉이 되도록 아무도 몰랐다
 * (부채 #337). 오늘의 수는 `document-state.spec.ts` 의 「등록된 축은 열아홉이다」가 «세고»,
 * 축을 더하면 그 단언이 빨개진다(README §6-4 — 레지스트리를 늘리면 지키는 표도 늘린다).
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
   *    ⇒ 검사·보류 여덟의 출발 상태는 위 도식의 «수신·발신»에서 그대로 읽는다. ⭐ `DEFECTIVE`
   *    발신은 재등록과 처분 판정 셋뿐이다 — 그 도식은 `W-03-02` 의 3전이(C7·C8·C9) 범위에서
   *    쓰였고 처분 화면 `W-03-10` 은 그보다 «나중»이다(DR-008 확정 3-A · 통보 089 §1).
   * ⭐ **`SCRAPPED` 는 `to` 에만 있고 `from` 에는 없다** — 계약이 도착 상태를 직접 적었고
   *    (`quality-03품질.json:2460`), 폐기된 LOT 을 다시 처분하면 0건이 옮겨져 400
   *    `STATE_LOCKED` 다. 「거부하는 쪽」을 남기는 자리다(결정 — 통보 089 §1).
   * ⛔ `C15`(전수 재검 양품)를 등록하지 않는다 — `C4` 와 (from, to) 가 같은데 어느 LOT 이
   *    `C14` 로 그 자리에 왔는지 가릴 표식이 데이터에 없다(F-6 · 미발행 · I-19 §9-2 후보 8).
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

    // ── I-23(재고 재등록)이 쓴다 ───────────────────────────────────
    // ⭐ `transitionCode` 를 여기서 못 박는다(결정 — 통보 218 · 근거는 통보 089 `:69-70`).
    //    ⛔ 「시드의 빈 첫 번호」가 근거가 «아니다» — 실측이 C11·C12·C13·C16 을 비워 두고 있다.
    //    ⚠ 계약 `LotStatusHistoryEvent.transitionCode`(required enum 9값)에 C20 이 없다 ⇒
    //      `?transitionCode=C20` 은 우리 서버가 400 이다. I-17 선례대로 선반영 + 가드를 둔다.
    // ⭐⭐ `from` 이 «셋»인 근거 — 코어 `moveWithin` 은 `from` 밖이면 «던지지 않고 skip 한다»
    //    (`lot-quality-status.service.ts:84-88`). 좁게 잡으면 400 이 아니라 응답 `lotStatusCode`
    //    (required · 「전이 결과」)가 **조용히 거짓**이 된다 — 그쪽이 더 나쁘다.
    //    ⛔ `INSPECTION_PENDING` 을 빼지 마라: 반품 갈래가 원 LOT 을 그대로 써 그 값으로 들어온다
    //    (`disposition-*` 셋이 같은 이유로 그 값을 갖는다 · `W-04-07` §5-4).
    //    ⛔ `SCRAPPED` 는 넣지 «않는다» — 폐기된 LOT 을 되살리는 오퍼레이션이 아니다.
    'stock-reinstate': { from: ['DEFECTIVE', 'NORMAL', 'INSPECTION_PENDING'], to: 'NORMAL',
      transitionCode: 'C20', sourceOperation: 'POST /logistics/stock-reinstatements' },

    // ── I-21(처분 판정)이 쓴다 · 여기서는 등록만 한다 ──────────────
    // 셋이 «한 오퍼레이션»에서 `dispositionTypeCode`(REWORK·SCRAP·NORMAL)로 갈린다.
    // ⭐ `from` 이 셋인 근거 — 대상 LOT 의 출발이 원천 둘로 갈린다. `PRODUCT`(OQC 불합격)는
    //    `DEFECTIVE`(C6)이고 `RETURN`(반품)은 원 LOT 을 그대로 써(`W-04-07` §5-4) `NORMAL`
    //    이거나 `INSPECTION_PENDING` 이다. 좁히면 반품 갈래 본길이 통째로 400 으로 죽는다.
    // ⚠ `disposition-normal` 과 `stock-reinstate` 는 도착이 같아도 겹치지 않는다 — 코어가
    //    (칸, 액션명)으로 찾고 여는 오퍼레이션이 다르며 이력 코드도 갈린다(C19 ↔ 미정).
    //    ⛔ 겹치는 것은 «본길 순서»다: 처분 정상이 먼저 오면 재등록이 0건을 옮긴다.
    //    ⭐ 그래서 위 `stock-reinstate.from` 이 셋이다 — 2026-09-10 에 닫았다(통보 184).
    //    ⚠ `from` 밖은 «던지지 않고» 건너뛴다 — 좁히면 400 이 아니라 응답이 조용히 거짓이 된다.
    'disposition-rework': { from: ['NORMAL', 'INSPECTION_PENDING', 'DEFECTIVE'], to: 'INSPECTION_PENDING',
      transitionCode: 'C17', sourceOperation: DECIDE },
    'disposition-scrap': { from: ['NORMAL', 'INSPECTION_PENDING', 'DEFECTIVE'], to: 'SCRAPPED',
      transitionCode: 'C18', sourceOperation: DECIDE },
    'disposition-normal': { from: ['NORMAL', 'INSPECTION_PENDING', 'DEFECTIVE'], to: 'NORMAL',
      transitionCode: 'C19', sourceOperation: DECIDE },
  },

  /**
   * 부적합 처리 진행. 값은 시드 `NONCONFORMANCE_STATUS` 3값(⛔ 시스템 소유)이 확정했고
   * 계약이 전이 둘을 연다 — 의뢰는 `W-04-07`, 판정 완료는 `W-03-10` 이 올린다.
   *
   * ⛔ 탄생(`NOT_REQUESTED`)은 여기 오지 않는다 — `from` 이 없는 자리다.
   * ⛔ `DECIDED` 는 «남은 수량 0» 일 때만이다 — 부분 처분은 `PENDING_DECISION` 에 머문다
   *    (계약 `dispositionProgressCode.COMPLETED` = 「남은 수량 0」).
   * ⛔ 되돌리는 전이를 만들지 않는다 — 오판정 정정 경로가 미결이고(`W-03-10` §8 #9) 계약에
   *    그 오퍼레이션이 0건이다.
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다(LOT 축만 갖는 칸).
   */
  'quality.nonconformance.status_code': {
    'nonconformance-request-disposition': { from: ['NOT_REQUESTED'], to: 'PENDING_DECISION',
      sourceOperation: 'POST /quality/nonconformances/{nonconformanceId}:request-disposition' },
    'nonconformance-decide': { from: ['PENDING_DECISION'], to: 'DECIDED',
      sourceOperation: DECIDE },
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
   * 피킹 지시 진행(P-14 · 사용자 결정 2026-09-15). 값은 시드 `LOGISTICS_DOCUMENT_STATUS`
   * 4값이고 계약 `PickingOrder.statusCode` 가 그 그룹을 지목한다 — 「피킹완료」에 해당하는
   * 값이 없어 **전기완료**로 닫는다(전기는 출고가 한다).
   *
   * ⛔ 피킹(`:pick`)은 이 전이를 부르지 않는다 — 출고 전기가 «전 라인 전량» 나갔을 때만
   *    부른다. 부분 출고에서 닫으면 나머지를 집으러 돌아올 길이 사라진다(`issue-followup.ts`).
   * ⛔ 라인 축(`picking_line.status_code`)은 **세우지 않는다** — 계약이 `x-no-code-key` 로
   *    「코드 그룹을 세우지 않는다 — 라인 진행은 `plannedQty ↔ pickedQty` 가 담는다」라 적었다.
   * ⛔ 취소 두 액션을 안 붙인다 — `document-type-registry.ts` 가 `cancelable: false` 다.
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다.
   */
  'logistics.picking_order.status_code': {
    'picking-issue': {
      from: ['REGISTERED'],
      to: 'POSTED',
      sourceOperation: 'POST /logistics/goods-issues',
    },
  },

  /**
   * 자재 출고요청 진행(P-16 · 문의 046 해소). 값은 같은 `LOGISTICS_DOCUMENT_STATUS` 4값이고
   * 계약 `MaterialIssueRequest.statusCode` 가 그 그룹을 지목한다.
   *
   * ⛔ 전 라인이 요청 수량만큼 나갔을 때만 옮긴다 — 라인이 0건이면 「다 나갔다」가 공허한
   *    참이라 옮기지 않는다(`issue-followup.ts`).
   * ⛔ 취소 두 액션을 안 붙인다 — 역시 `cancelable: false` 다. 그래서 되돌리는 전이도 없다.
   */
  'logistics.material_issue_request.status_code': {
    'material-issue-request-issue': {
      from: ['REGISTERED'],
      to: 'POSTED',
      sourceOperation: 'POST /logistics/goods-issues',
    },
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
   * 설비 고장 처리. 계약은 `RECEIVED`에서 처리 시작, `RECEIVED`·`HANDLING`에서 완료를 연다.
   * 결정 — 통보 090·093: 완료 경로도 같은 상태 축에 등록한다.
   * ⛔ 이력 표가 없다 — `transitionCode`를 쓰지 않는다.
   */
  'maintenance.breakdown.status_code': {
    'breakdown-start-handling': {
      from: ['RECEIVED'],
      to: 'HANDLING',
      sourceOperation: 'POST /maintenance/breakdowns/{breakdownId}:start-handling',
    },
    'breakdown-complete': {
      from: ['RECEIVED', 'HANDLING'],
      to: 'DONE',
      sourceOperation: 'POST /maintenance/breakdowns/{breakdownId}:complete',
    },
  },

  /**
   * 보전 지시 취소. 시드 `MAINTENANCE_ORDER_STATUS`가 ISSUED·DONE·CANCELLED를 확정했고,
   * 계약은 발행된 지시 중 실적이 없는 것만 취소하도록 연다(I-31 R11/C0).
   * 실적 존재 여부는 쓰기 서비스가 잠근 뒤 검사하고, 이 표는 상태 축만 판정한다.
   * ⛔ 완료 전이는 등록하지 않는다 — 완료의 업무 의미는 별도 설계 문의가 남아 있다.
   */
  'maintenance.maintenance_order.status_code': {
    'maintenance-order-cancel': {
      from: ['ISSUED'],
      to: 'CANCELLED',
      sourceOperation: 'POST /maintenance/orders/{maintenanceOrderId}:cancel',
    },
  },

  /**
   * 재고 이동 전표 진행. 값은 시드 `LOGISTICS_DOCUMENT_STATUS` 4값(⛔ 시스템 소유)이 확정했고
   * 계약이 전이를 하나만 연다(`:arrive`).
   * ⛔ 반출 등록은 여기 오지 않는다 — 전표가 `REGISTERED` 로 «태어나는» 자리라 `from` 이 없다.
   * ⛔ 취소 두 액션을 안 붙인다 — `documentTypeCode` enum 3값에 `STOCK_TRANSFER` 가 없고
   *    `document-type-registry.ts` 도 `cancelable:false` 다(결정 — 통보 120).
   * ⛔ 부분 도착은 전이가 아니다 — 전량 도착에서만 이 액션을 부른다.
   * ⚠ `conflictStatus` 는 호출자가 400 을 넘긴다 — 형제 물류 전표와 같다.
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다(LOT 축만 갖는 칸).
   */
  'logistics.stock_transfer.status_code': {
    'transfer-arrive': {
      from: ['REGISTERED'],
      to: 'POSTED',
      sourceOperation: 'POST /logistics/stock-transfers/{stockTransferId}:arrive',
    },
  },

  /**
   * 적치 작업 진행. 값은 시드 `PUTAWAY_TASK_STATUS` 4값(DB 실재 · ⛔ 시스템 소유)이 확정했고
   * 계약이 전이 둘을 그대로 연다. ⛔ 되돌아오는 전이는 없다 — 임시 적치에서 정상 적치로 가는
   * 오퍼레이션이 계약에 0건이다(dead end · 문의 059+2). `CANCELLED` 는 공급사 전량 반품의
   * 부수 효과라 별도 사용자 액션을 등록하지 않는다.
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

  /**
   * 재고 조정 전표 진행. 값은 시드 `LOGISTICS_DOCUMENT_STATUS` 4값(`isSystemOwned` · DB 실재)이
   * 확정했다. 계약 `InventoryAdjustment.statusCode` 가 그 넷을 그대로 적는다.
   *
   * ⚠ `conflictStatus` 는 호출자가 **400** 을 넘긴다 — 계약 `InventoryAdjustmentLineUpsert` 가
   * 「전기된 조정은 바꿀 수 없다 — 400 STATE_LOCKED」로 400 을 명시했다(출고와 같다).
   * ⛔ 취소 두 액션을 «넣지 않는다» — `DocumentProgress.documentTypeCode` enum 9값에
   *    `INVENTORY_ADJUSTMENT` 가 없어(계약 실측) 조정을 취소할 경로가 0건이다(결정 — 통보 132).
   *    등록되지 않은 (칸, 액션)은 던지므로 이 부재가 방어다.
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다.
   */
  'inventory.inventory_adjustment.status_code': {
    'document-post': {
      from: ['REGISTERED'],
      to: 'POSTED',
      sourceOperation: 'POST /inventory/adjustments/{inventoryAdjustmentId}:post',
    },
  },

  /**
   * 출하 진행(I-23). 시드 `SHIPMENT_STATUS` **3값**(`UNCONFIRMED`·`CONFIRMED`·`CANCELLED` · 실측).
   *
   * ⭐⭐ **액션이 «둘»이다 — `:request-cancel` 은 전이가 0개다.** 3값에 `CANCEL_REQUESTED` 가
   * **없어** 「취소 결재 진행 중」을 담을 상태가 없다 ⇒ 열린 `approval_request` 로만 판정한다(J-7).
   * ⛔ 이것이 다형 취소(I-5)와 **가장 크게 갈리는 자리**다 — 그쪽은 `CANCEL_REQUESTED` 로 옮긴다.
   * ⛔ 새 상태값을 지어 넣지 않는다: 값 집합이 시드에 있고 화면이 그 목록으로 뱃지를 그린다.
   *
   * ⚠ 확정에서 되돌아오는 전이는 없다 — 계약이 「확정 취소 경로가 없으므로 되돌릴 수 없다」라
   * 적었다(`ShipmentConflictResponse.code` 설명 · `W-04-12` §5-3). 취소는 «미확정»에서만 간다.
   * ⛔ 이력 표가 없다 — `transitionCode` 를 쓰지 않는다(LOT 축만 갖는 칸).
   */
  'logistics.shipment.status_code': {
    'shipment-confirm': {
      from: ['UNCONFIRMED'],
      to: 'CONFIRMED',
      sourceOperation: 'POST /logistics/shipments/{shipmentId}:confirm',
    },
    'shipment-cancel': {
      from: ['UNCONFIRMED'],
      to: 'CANCELLED',
      sourceOperation: 'POST /logistics/shipments/{shipmentId}:cancel',
    },
  },
};
