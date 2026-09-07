import { ProductionOrderAcknowledge, acknowledgeBodyErrors } from './acknowledge.service';

/** 영향 W/O 둘 — 하나는 열려 있고 하나는 마감이다. */
const IMPACTED = [
  { work_order_id: 11n, closed_at: null },
  { work_order_id: 12n, closed_at: new Date('2026-09-01T00:00:00.000Z') },
];

const body = (patch: Partial<ProductionOrderAcknowledge>): ProductionOrderAcknowledge => ({ decisionCode: 'APPLY', ...patch });
const codes = (input: ProductionOrderAcknowledge): { field?: string; code: string }[] =>
  acknowledgeBodyErrors(input, IMPACTED).map((item) => ({ field: item.field, code: item.code }));

describe('acknowledgeBodyErrors — 본문 400 다섯 갈래 (I-24 §5-5 ④ · R-10 ⓑⓒ)', () => {
  it('ⓐ 강행인데 조정을 실으면 INVALID 다', () => {
    const input = body({ decisionCode: 'PROCEED', reason: '기존 유지', workOrderAdjustments: [{ workOrderId: 11, versionNo: 1, orderQty: 5 }] });
    expect(codes(input)).toContainEqual({ field: 'workOrderAdjustments', code: 'INVALID' });
  });

  it('ⓑ 이 P/O 의 영향 W/O 가 아니면 INVALID 다', () => {
    const input = body({ workOrderAdjustments: [{ workOrderId: 99, versionNo: 1, orderQty: 5 }] });
    expect(codes(input)).toContainEqual({ field: 'workOrderAdjustments[0].workOrderId', code: 'INVALID' });
  });

  it('ⓒ 같은 workOrderId 가 두 번이면 UNIQUE_VIOLATION 이다', () => {
    const input = body({
      workOrderAdjustments: [
        { workOrderId: 11, versionNo: 1, orderQty: 5 },
        { workOrderId: 11, versionNo: 1, orderQty: 6 },
      ],
    });
    expect(codes(input)).toContainEqual({ field: 'workOrderAdjustments[1].workOrderId', code: 'UNIQUE_VIOLATION' });
  });

  it('ⓓ 고칠 칸을 하나도 안 담으면 REQUIRED 다', () => {
    const input = body({ workOrderAdjustments: [{ workOrderId: 11, versionNo: 1 }] });
    expect(codes(input)).toContainEqual({ field: 'workOrderAdjustments[0]', code: 'REQUIRED' });
  });

  it('ⓔ 강행인데 사유가 없거나 공백이면 REQUIRED 다', () => {
    expect(codes(body({ decisionCode: 'PROCEED' }))).toContainEqual({ field: 'reason', code: 'REQUIRED' });
    expect(codes(body({ decisionCode: 'PROCEED', reason: '   ' }))).toContainEqual({ field: 'reason', code: 'REQUIRED' });
  });

  it('마감 W/O 를 가리키면 STATE_LOCKED 다 — 트리거가 UPDATE 를 예외로 던진다(R-10 ⓑ)', () => {
    const input = body({ workOrderAdjustments: [{ workOrderId: 12, versionNo: 1, orderQty: 5 }] });
    expect(codes(input)).toContainEqual({ field: 'workOrderAdjustments[0].workOrderId', code: 'STATE_LOCKED' });
  });

  it('반영 + 빈 배열은 정상이다 — 조정 없이 확인만 적는다', () => {
    expect(acknowledgeBodyErrors(body({ workOrderAdjustments: [] }), IMPACTED)).toEqual([]);
    expect(acknowledgeBodyErrors(body({}), IMPACTED)).toEqual([]);
  });
});
