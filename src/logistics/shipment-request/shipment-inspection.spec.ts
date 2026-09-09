import {
  OqcInspectionRow,
  ShipmentInspectionLine,
  lineInspectionStatus,
  oqcPassed,
  shipmentInspectionStatus,
} from './shipment-inspection';

/**
 * `shipment-inspection.ts` 의 갈래 단위 시험(계획 §8-6 · 10건). 이 PR 은 HTTP 오퍼레이션이 0건이라
 * **이 파일이 곧 반증**이다.
 *
 * ⭐ 픽스처는 축마다 값이 둘 이상이다(README §6-3 ⑵) — 대상 유형 둘(`LOT`·`SHIPMENT_REQUEST`) ·
 *   판정 셋(`ACCEPTED`·`REJECTED`·`HELD`) · 결과 상태 둘(`CONFIRMED`·`DRAFT`) · 회차 둘 ·
 *   의뢰 둘 · 라인이 집은 LOT 둘. 한 종류뿐이면 어느 필터를 지워도 초록이다.
 */
const REQUEST = 5001;
const LOT_A = 7001;
const LOT_B = 7002;
/** ⭐ 이 라인이 «안» 집은 LOT — R-5 의 그물이다. */
const LOT_OUTSIDE = 7009;

const row = (over: Partial<OqcInspectionRow> = {}): OqcInspectionRow => ({
  inspectionRequestId: 9001,
  inspectionTypeCode: 'OQC',
  targetTypeCode: 'LOT',
  targetId: LOT_A,
  lotId: null,
  statusCode: 'CONFIRMED',
  inspectionRound: 1,
  overallJudgmentCode: 'ACCEPTED',
  ...over,
});

const srLine = (over: Partial<ShipmentInspectionLine> = {}): ShipmentInspectionLine => ({
  shipmentRequestId: REQUEST,
  shippingInspectionRequired: true,
  lotIds: [LOT_A, LOT_B],
  ...over,
});

/** 헤더 대상(`SHIPMENT_REQUEST`) 의뢰 — `lot_id` 가 `target_type_code` 와 «병존»한다(R-5). */
const headerRow = (over: Partial<OqcInspectionRow> = {}): OqcInspectionRow =>
  row({ inspectionRequestId: 9101, targetTypeCode: 'SHIPMENT_REQUEST', targetId: REQUEST, ...over });

describe('lineInspectionStatus — 5값 각각(계약 shippingInspectionStatusCode)', () => {
  it('NOT_REQUIRED — shipping_inspection_required 가 거짓이면 결과가 무엇이든 대상이 아니다', () => {
    const line = srLine({ shippingInspectionRequired: false });
    expect(lineInspectionStatus(line, [row({ overallJudgmentCode: 'REJECTED' })])).toBe('NOT_REQUIRED');
    // 대상이면 같은 행이 REJECTED 를 낸다 — 두 갈래가 «다른» 답을 내야 이 축이 잠긴다.
    expect(lineInspectionStatus(srLine(), [row({ overallJudgmentCode: 'REJECTED' })])).toBe('REJECTED');
  });

  it('PENDING — 대상인데 겨누는 결과가 0건이다', () => {
    expect(lineInspectionStatus(srLine(), [])).toBe('PENDING');
    // 다른 LOT 의 결과는 이 라인을 안 겨눈다 — 「안 걸리는 행」이다.
    expect(lineInspectionStatus(srLine(), [row({ targetId: LOT_OUTSIDE })])).toBe('PENDING');
    // OQC 가 아닌 검사도 안 센다(IQC·PQC 가 같은 LOT 에 붙는다).
    expect(lineInspectionStatus(srLine(), [row({ inspectionTypeCode: 'IQC' })])).toBe('PENDING');
    // 제3의 대상 유형(WORK_ORDER)도 안 겨눈다 — target_id 가 우연히 같은 값이어도 마찬가지다.
    // ⛔ `target_type_code` 는 `app.code_t` 라 CHECK 가 없고 `target_id` 는 다형 bigint 다.
    expect(lineInspectionStatus(srLine(), [row({ targetTypeCode: 'WORK_ORDER', targetId: REQUEST })])).toBe('PENDING');
  });

  it('PASSED — 겨누는 결과가 전건 ACCEPTED 다(두 LOT · 두 의뢰)', () => {
    const rows = [row({ targetId: LOT_A }), row({ inspectionRequestId: 9002, targetId: LOT_B })];
    expect(lineInspectionStatus(srLine(), rows)).toBe('PASSED');
    // ⭐ LOT 대상 의뢰도 `lot_id` 가 «병존»한다 — 있으면 그것이 이긴다(`coalesce(lot_id, target_id)`).
    //   ⛔ `target_id` 만 보면 아래 두 줄의 답이 뒤바뀐다.
    expect(lineInspectionStatus(srLine(), [row({ targetId: LOT_OUTSIDE, lotId: LOT_A, overallJudgmentCode: 'REJECTED' })])).toBe('REJECTED');
    expect(lineInspectionStatus(srLine(), [row({ targetId: LOT_A, lotId: LOT_OUTSIDE, overallJudgmentCode: 'REJECTED' })])).toBe('PENDING');
  });

  it('REJECTED — 하나라도 불합격이면 불합격이다', () => {
    const rows = [row({ targetId: LOT_A }), row({ inspectionRequestId: 9002, targetId: LOT_B, overallJudgmentCode: 'REJECTED' })];
    expect(lineInspectionStatus(srLine(), rows)).toBe('REJECTED');
  });

  it('HELD — 보류가 있고 불합격은 없다', () => {
    const rows = [row({ targetId: LOT_A }), row({ inspectionRequestId: 9002, targetId: LOT_B, overallJudgmentCode: 'HELD' })];
    expect(lineInspectionStatus(srLine(), rows)).toBe('HELD');
    // 같은 픽스처에 불합격을 더하면 불합격이 이긴다.
    expect(lineInspectionStatus(srLine(), [...rows, row({ inspectionRequestId: 9003, overallJudgmentCode: 'REJECTED' })])).toBe('REJECTED');
  });
});

describe('shipmentInspectionStatus — 헤더 롤업', () => {
  it('우선순위: REJECTED > HELD > PENDING > PASSED > NOT_REQUIRED (가장 나쁜 것이 이긴다)', () => {
    const passed = srLine({ lotIds: [LOT_A] });
    const notRequired = srLine({ shippingInspectionRequired: false });
    const pending = srLine({ lotIds: [LOT_OUTSIDE] });
    const held = srLine({ lotIds: [LOT_B] });
    const rejected = srLine({ lotIds: [7003] });
    const rows = [
      row({ targetId: LOT_A }),
      row({ inspectionRequestId: 9002, targetId: LOT_B, overallJudgmentCode: 'HELD' }),
      row({ inspectionRequestId: 9003, targetId: 7003, overallJudgmentCode: 'REJECTED' }),
    ];
    expect(shipmentInspectionStatus([notRequired, passed, pending, held, rejected], rows)).toBe('REJECTED');
    expect(shipmentInspectionStatus([notRequired, passed, pending, held], rows)).toBe('HELD');
    expect(shipmentInspectionStatus([notRequired, passed, pending], rows)).toBe('PENDING');
    expect(shipmentInspectionStatus([notRequired, passed], rows)).toBe('PASSED');
    expect(shipmentInspectionStatus([notRequired], rows)).toBe('NOT_REQUIRED');
    // 라인이 0건이면(편성 직후) NOT_REQUIRED 다.
    expect(shipmentInspectionStatus([], rows)).toBe('NOT_REQUIRED');
  });
});

describe('lineInspectionStatus — 모집단을 좁히는 셋(I-20 ①c · I-21 R-3 형 사고)', () => {
  it('⭐ DRAFT 결과는 세지 않는다 — 미확정 판정이 롤업에 새면 안 된다', () => {
    // 확정 합격 + 미확정 불합격 → 합격이다.
    const rows = [row({ inspectionRound: 1 }), row({ inspectionRound: 2, statusCode: 'DRAFT', overallJudgmentCode: 'REJECTED' })];
    expect(lineInspectionStatus(srLine(), rows)).toBe('PASSED');
    // DRAFT 뿐이면 아직 결과가 «없는» 것이다.
    expect(lineInspectionStatus(srLine(), [row({ statusCode: 'DRAFT', overallJudgmentCode: 'REJECTED' })])).toBe('PENDING');
  });

  it('⭐ 같은 의뢰의 최대 CONFIRMED 회차만 센다 — 구회차가 재검사 판정을 되살리면 안 된다', () => {
    const reinspected = [
      row({ inspectionRound: 1, overallJudgmentCode: 'REJECTED' }),
      row({ inspectionRound: 2, overallJudgmentCode: 'ACCEPTED' }),
    ];
    expect(lineInspectionStatus(srLine(), reinspected)).toBe('PASSED');
    // 뒤집힌 방향도 잠근다 — 1회차 합격 → 2회차 불합격이면 불합격이다.
    expect(
      lineInspectionStatus(srLine(), [row({ inspectionRound: 1 }), row({ inspectionRound: 2, overallJudgmentCode: 'REJECTED' })]),
    ).toBe('REJECTED');
    // ⭐ 최대 회차는 «의뢰마다» 따로다 — 다른 의뢰의 1회차를 큰 회차가 덮으면 안 된다.
    expect(
      lineInspectionStatus(srLine(), [
        ...reinspected,
        row({ inspectionRequestId: 9002, targetId: LOT_B, inspectionRound: 1, overallJudgmentCode: 'REJECTED' }),
      ]),
    ).toBe('REJECTED');
  });

  it('⭐ 헤더 대상 의뢰의 lot_id 가 라인 밖이면 그 라인을 안 물들인다 (R-5 · lot_id 는 다형과 병존)', () => {
    // ⛔ 이 갈래를 `TRUE` 로 접으면 헤더 검사 하나가 그 작업지시의 «모든» 라인을 물들인다.
    expect(lineInspectionStatus(srLine(), [headerRow({ lotId: LOT_OUTSIDE, overallJudgmentCode: 'REJECTED' })])).toBe('PENDING');
    // lot_id 가 널이면 라인 «전체»가 대상이다.
    expect(lineInspectionStatus(srLine(), [headerRow({ lotId: null, overallJudgmentCode: 'REJECTED' })])).toBe('REJECTED');
    // lot_id 가 이 라인이 집은 LOT 이면 그 라인을 물들인다(bigint 로 와도 같다).
    expect(lineInspectionStatus(srLine({ lotIds: [BigInt(LOT_B)] }), [headerRow({ lotId: BigInt(LOT_B) })])).toBe('PASSED');
    // 다른 작업지시를 겨눈 헤더 의뢰는 안 센다.
    expect(lineInspectionStatus(srLine(), [headerRow({ targetId: 5002, overallJudgmentCode: 'REJECTED' })])).toBe('PENDING');
  });
});

describe('oqcPassed — 라인 검사와 «같은 함수»다(R-10)', () => {
  it('⭐ 헤더 대상 OQC 도 통과로 읽고, required=false 면 무조건 true 다', () => {
    // ⛔⛔ LOT 축만으로 내면 여기서 false 가 되어 「합격인데 납품라벨을 영원히 못 뽑는」 상태가 된다.
    const headerOnly = [headerRow({ lotId: null })];
    expect(lineInspectionStatus(srLine(), headerOnly)).toBe('PASSED');
    expect(oqcPassed(srLine(), headerOnly)).toBe(true);
    // 계약 명시 — 검사 대상이 아닌 배분은 결과가 무엇이든 true 다(「알려둘 것」 ⓕ).
    expect(oqcPassed(srLine({ shippingInspectionRequired: false }), [row({ overallJudgmentCode: 'REJECTED' })])).toBe(true);
    // PASSED 가 «아닌» 값은 전부 false 다 — PENDING·HELD 도 발행 대상이 아니다.
    expect(oqcPassed(srLine(), [])).toBe(false);
    expect(oqcPassed(srLine(), [row({ overallJudgmentCode: 'HELD' })])).toBe(false);
    expect(oqcPassed(srLine(), [row({ overallJudgmentCode: 'REJECTED' })])).toBe(false);
    expect(oqcPassed(srLine(), [row()])).toBe(true);
  });
});
