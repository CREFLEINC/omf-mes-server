import { Tx } from '../../core/lot';
import { countIqcJudgmentWithin, IqcJudgmentCount } from './inspection-level-switch';

/** omf-all-around#64 — IQC 확정이 품목 검사 수준을 센다(장부 P-87). */

interface Level {
  inspection_level_code: string;
  auto_switch_enabled?: boolean;
  consecutive_accept_count?: number;
}

const harness = (level: Level | null, options: { alreadyCounted?: boolean } = {}) => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(
      level === null
        ? []
        : [{ item_inspection_level_id: 5n, auto_switch_enabled: true, consecutive_accept_count: 0, ...level }],
    ),
    inspection_request: { updateMany: jest.fn().mockResolvedValue({ count: options.alreadyCounted ? 0 : 1 }) },
    item_inspection_level: { update: jest.fn() },
    item_inspection_level_history: { create: jest.fn() },
  };
  return { tx, run: (input: Partial<IqcJudgmentCount> = {}) => countIqcJudgmentWithin(tx as unknown as Tx, { ...BASE, ...input }) };
};

const AT = new Date('2026-10-21T03:00:00Z');
const BASE: IqcJudgmentCount = {
  inspectionRequestId: 9n,
  inspectionTypeCode: 'IQC',
  itemId: 10n,
  judgment: 'ACCEPTED',
  changedAt: AT,
  appUserId: 1,
};

describe('countIqcJudgmentWithin', () => {
  it('IQC 가 아니면 수준 행을 읽지도 않는다', async () => {
    const { tx, run } = harness({ inspection_level_code: 'NORMAL' });
    await run({ inspectionTypeCode: 'PQC' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('수준 미설정 품목은 의뢰도 수준도 건드리지 않는다 — 지금처럼 동작', async () => {
    const { tx, run } = harness(null);
    await run();
    expect(tx.inspection_request.updateMany).not.toHaveBeenCalled();
    expect(tx.item_inspection_level.update).not.toHaveBeenCalled();
  });

  it('첫 확정이면 의뢰에 검사한 수준을 기록하고 연속 수를 올린다', async () => {
    const { tx, run } = harness({ inspection_level_code: 'NORMAL', consecutive_accept_count: 3 });
    await run();
    expect(tx.inspection_request.updateMany).toHaveBeenCalledWith({
      where: { inspection_request_id: 9n, inspection_level_code: null },
      data: { inspection_level_code: 'NORMAL' },
    });
    expect(tx.item_inspection_level.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ inspection_level_code: 'NORMAL', consecutive_accept_count: 4, version_no: { increment: 1 } }),
      }),
    );
    expect(tx.item_inspection_level_history.create).not.toHaveBeenCalled();
  });

  it('이미 센 의뢰(재검사 회차·재저장)는 다시 세지 않는다', async () => {
    const { tx, run } = harness({ inspection_level_code: 'NORMAL', consecutive_accept_count: 14 }, { alreadyCounted: true });
    await run();
    expect(tx.item_inspection_level.update).not.toHaveBeenCalled();
    expect(tx.item_inspection_level_history.create).not.toHaveBeenCalled();
  });

  it('15 번째 연속 합격이면 수월로 바꾸고 자동 이력(연속 수 15)을 남긴다', async () => {
    const { tx, run } = harness({ inspection_level_code: 'NORMAL', consecutive_accept_count: 14 });
    await run();
    expect(tx.item_inspection_level_history.create).toHaveBeenCalledWith({
      data: {
        item_id: 10n,
        from_level_code: 'NORMAL',
        to_level_code: 'REDUCED',
        change_type_code: 'AUTO',
        consecutive_accept_count: 15,
        inspection_request_id: 9n,
        changed_at: AT,
        changed_by: 1,
        changed_worker_id: null,
      },
    });
  });

  it('불합격이면 엄격으로 바꾸고 그 의뢰를 사유로 남긴다 — 단말 확정이면 처리자는 작업자', async () => {
    const { tx, run } = harness({ inspection_level_code: 'REDUCED', consecutive_accept_count: 20 });
    await run({ judgment: 'REJECTED', appUserId: undefined, workerId: 23n });
    expect(tx.item_inspection_level_history.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        from_level_code: 'REDUCED',
        to_level_code: 'TIGHTENED',
        consecutive_accept_count: null,
        inspection_request_id: 9n,
        changed_by: null,
        changed_worker_id: 23n,
      }),
    });
  });

  it('보류는 수준만 기록하고 연속 수를 바꾸지 않는다', async () => {
    const { tx, run } = harness({ inspection_level_code: 'NORMAL', consecutive_accept_count: 6 });
    await run({ judgment: 'HELD' });
    expect(tx.inspection_request.updateMany).toHaveBeenCalled();
    expect(tx.item_inspection_level.update).not.toHaveBeenCalled();
  });

  it.each([
    ['자동 전환을 끈 품목', { inspection_level_code: 'NORMAL', auto_switch_enabled: false }],
    ['무검사 품목', { inspection_level_code: 'NONE' }],
  ])('%s 은 수준만 기록하고 세지 않는다', async (_label, level) => {
    const { tx, run } = harness(level);
    await run({ judgment: 'REJECTED' });
    expect(tx.inspection_request.updateMany).toHaveBeenCalled();
    expect(tx.item_inspection_level.update).not.toHaveBeenCalled();
    expect(tx.item_inspection_level_history.create).not.toHaveBeenCalled();
  });
});
