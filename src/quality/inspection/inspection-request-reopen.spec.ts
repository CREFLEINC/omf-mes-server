import { Tx } from '../../core/lot';
import { reopenInspectionRequestWithin, reopenIqcRequestForReworkWithin, startInspectionRequestWithin } from './inspection-request-reopen';

/** 끝난 의뢰를 다시 여는 두 갈래(장부 P-43) — 재검사 회차 추가 · 처분 재작업. */
const txWith = (request: { inspection_request_id: bigint; inspection_type_code: string; lot_id: bigint | null } | null) => {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const findUnique = jest.fn().mockResolvedValue(
    request === null ? { inspection_result: null } : { inspection_result: { inspection_request: request } },
  );
  const tx = { inspection_request: { updateMany }, nonconformance: { findUnique } } as unknown as Tx;
  return { tx, updateMany, findUnique };
};

describe('reopenInspectionRequestWithin', () => {
  it('끝난(COMPLETED) 의뢰만 진행(IN_PROGRESS)으로 옮긴다 — 조건부 UPDATE · 판 번호를 올린다', async () => {
    const { tx, updateMany } = txWith(null);

    await reopenInspectionRequestWithin(tx, 7n, 3);

    expect(updateMany).toHaveBeenCalledWith({
      where: { inspection_request_id: 7n, status_code: 'COMPLETED' },
      data: { status_code: 'IN_PROGRESS', updated_by: 3, version_no: { increment: 1 } },
    });
  });
});

describe('startInspectionRequestWithin', () => {
  it('⭐ 대기(REQUESTED) 의뢰만 진행(IN_PROGRESS)으로 옮긴다 — 조건부 UPDATE · 판 번호를 올린다(#164)', async () => {
    const { tx, updateMany } = txWith(null);

    await startInspectionRequestWithin(tx, 7n, undefined);

    expect(updateMany).toHaveBeenCalledWith({
      where: { inspection_request_id: 7n, status_code: 'REQUESTED' },
      data: { status_code: 'IN_PROGRESS', updated_by: null, version_no: { increment: 1 } },
    });
  });
});

describe('reopenIqcRequestForReworkWithin', () => {
  it('⭐ 재작업으로 옮겨진 LOT 의 IQC 의뢰를 다시 연다', async () => {
    const { tx, updateMany, findUnique } = txWith({ inspection_request_id: 7n, inspection_type_code: 'IQC', lot_id: 47n });

    await reopenIqcRequestForReworkWithin(tx, 11n, [47n], 3);

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { nonconformance_id: 11n } }));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { inspection_request_id: 7n, status_code: 'COMPLETED' },
    }));
  });

  it('⛔ PQC 의뢰(재작업 W/O · #47)는 건드리지 않는다', async () => {
    const { tx, updateMany } = txWith({ inspection_request_id: 7n, inspection_type_code: 'PQC', lot_id: null });

    await reopenIqcRequestForReworkWithin(tx, 11n, [47n], 3);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('⛔ 의뢰의 LOT 이 이번에 옮겨지지 않았으면 열지 않는다', async () => {
    const { tx, updateMany } = txWith({ inspection_request_id: 7n, inspection_type_code: 'IQC', lot_id: 48n });

    await reopenIqcRequestForReworkWithin(tx, 11n, [47n], 3);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('검사 결과에서 오지 않은 부적합(현장 등록)은 지나간다', async () => {
    const { tx, updateMany } = txWith(null);

    await reopenIqcRequestForReworkWithin(tx, 11n, [47n], 3);

    expect(updateMany).not.toHaveBeenCalled();
  });
});
