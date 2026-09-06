import { ContractException, ErrorItem } from '../../common/errors';
import { CompletionJudgment } from './completion';
import { WorkOrderClose, assertCloseBody, closePayload } from './close-rules';

/** 던진 400 의 첫 항목만 본다 — 규칙마다 한 칸이 걸린다. */
function rejected(judgment: CompletionJudgment, body: WorkOrderClose): ErrorItem {
  try {
    assertCloseBody(judgment, body);
  } catch (error) {
    return (error as ContractException).errors[0];
  }
  throw new Error('400 이 아니었다');
}

describe('W/O 마감 본문 4+1 규칙 (I-6 PR ⑥b)', () => {
  it('마감 — 미달인데 처분이 없으면 `REMAINDER_DISPOSITION_REQUIRED` 다', () => {
    expect(rejected('UNDER', { reasonCode: 'MATERIAL_SHORTAGE' })).toMatchObject({
      field: 'remainderDispositionCode',
      code: 'REMAINDER_DISPOSITION_REQUIRED',
    });
    // 처분이 오면 통과한다 — 사유도 함께 왔을 때다(규칙 3).
    expect(() =>
      assertCloseBody('UNDER', { remainderDispositionCode: 'CARRY_OVER', reasonCode: 'MATERIAL_SHORTAGE' }),
    ).not.toThrow();
  });

  it('마감 — 정상인데 처분이 있으면 `REMAINDER_DISPOSITION_NOT_ALLOWED` 다', () => {
    const item = { field: 'remainderDispositionCode', code: 'REMAINDER_DISPOSITION_NOT_ALLOWED' };
    expect(rejected('NORMAL', { remainderDispositionCode: 'WRITE_OFF' })).toMatchObject(item);
    // ⌜넘길 잔량도 없앨 잔량도 없다⌝ — 초과도 같은 자리다.
    expect(rejected('OVER', { remainderDispositionCode: 'CARRY_OVER', reasonCode: 'OVER_PRODUCTION' })).toMatchObject(item);
  });

  it('마감 — 미달·초과인데 사유가 없으면 `REQUIRED` 다', () => {
    const item = { field: 'reasonCode', code: 'REQUIRED' };
    expect(rejected('UNDER', { remainderDispositionCode: 'CARRY_OVER' })).toMatchObject(item);
    expect(rejected('OVER', {})).toMatchObject(item);
  });

  it('마감 — 정상인데 사유가 있으면 `INVALID` 다', () => {
    // 규칙 2 와 대칭이다 — 조용히 버리면 화면이 사유를 적었다고 믿는다(R-10).
    expect(rejected('NORMAL', { reasonCode: 'PLAN_CHANGE' })).toMatchObject({
      field: 'reasonCode',
      code: 'INVALID',
    });
    // ⌜정상은 두 칸을 다 비운다⌝ — 그때만 통과한다.
    expect(() => assertCloseBody('NORMAL', { erpSendItems: ['INPUT_MATERIAL'], remarks: '비고' })).not.toThrow();
  });

  it('마감 — `erpSendItems` 는 해석하지 않고 그대로 payload 에 싣는다', () => {
    const payload = closePayload({
      workOrderId: 900,
      workOrderNo: 'WO-20260906-0001',
      itemId: 11,
      orderQty: 100,
      goodQty: 90,
      completionJudgmentCode: 'UNDER',
      closedAt: new Date('2026-09-06T03:00:00.000Z'),
      erpSendItems: ['아직-정해지지-않은-코드'],
    });

    // 코드 목록이 없어 대조할 것이 없다 — 값 검증도, 변환도 하지 않는다(§5-6).
    expect(payload).toEqual({
      header: {
        workOrderId: 900,
        workOrderNo: 'WO-20260906-0001',
        itemId: 11,
        orderQty: 100,
        goodQty: 90,
        completionJudgmentCode: 'UNDER',
        closedAt: '2026-09-06T03:00:00.000Z',
      },
      sendItems: ['아직-정해지지-않은-코드'],
    });
  });
});
