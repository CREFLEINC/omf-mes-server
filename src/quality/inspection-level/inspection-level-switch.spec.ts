import { Tx } from '../../core/lot';
import { IqcInspectionLevelRecord, recordIqcInspectionLevelWithin } from './inspection-level-switch';

/** omf-all-around#64 — IQC 확정이 품목 검사 수준을 의뢰에 기록한다(장부 P-87). #133 — 자동 전환 없음. */

const harness = (level: { inspection_level_code: string } | null) => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(level === null ? [] : [level]),
    inspection_request: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    item_inspection_level: { update: jest.fn() },
    item_inspection_level_history: { create: jest.fn() },
  };
  return {
    tx,
    run: (input: Partial<IqcInspectionLevelRecord> = {}) =>
      recordIqcInspectionLevelWithin(tx as unknown as Tx, { ...BASE, ...input }),
  };
};

const BASE: IqcInspectionLevelRecord = { inspectionRequestId: 9n, inspectionTypeCode: 'IQC', itemId: 10n };

describe('recordIqcInspectionLevelWithin', () => {
  it('IQC 가 아니면 수준 행을 읽지도 않는다', async () => {
    const { tx, run } = harness({ inspection_level_code: 'NORMAL' });
    await run({ inspectionTypeCode: 'PQC' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('수준 미설정 품목은 의뢰를 건드리지 않는다 — 지금처럼 동작', async () => {
    const { tx, run } = harness(null);
    await run();
    expect(tx.inspection_request.updateMany).not.toHaveBeenCalled();
  });

  it.each(['NORMAL', 'TIGHTENED', 'REDUCED', 'NONE'])(
    '%s 이면 아직 비어 있는 의뢰에만 수준을 기록하고, 품목 수준·이력은 건드리지 않는다(#133)',
    async (code) => {
      const { tx, run } = harness({ inspection_level_code: code });
      await run();
      expect(tx.inspection_request.updateMany).toHaveBeenCalledWith({
        where: { inspection_request_id: 9n, inspection_level_code: null },
        data: { inspection_level_code: code },
      });
      expect(tx.item_inspection_level.update).not.toHaveBeenCalled();
      expect(tx.item_inspection_level_history.create).not.toHaveBeenCalled();
    },
  );
});
