import {
  loadDocumentIssueTargets,
  targetKey,
} from './document-issue-target-lookup';

describe('발행 대상 이름 배치 조회 (I-27 P1r)', () => {
  it('7종을 유형별 한 번씩 묶고 확정 이름·화면으로 매핑한다', async () => {
    const tx = {
      lot: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ lot_id: 1n, lot_no: 'LOT-1' }]),
      },
      serial_number: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ serial_number_id: 2n, serial_no: 'SERIAL-2' }]),
      },
      handling_unit: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { handling_unit_id: 3n, handling_unit_no: 'HU-3' },
          ]),
      },
      goods_issue_line: {
        findMany: jest.fn().mockResolvedValue([
          {
            goods_issue_line_id: 4n,
            line_no: 2,
            goods_issue: { goods_issue_no: 'GI-4' },
          },
        ]),
      },
      mold: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ mold_id: 5n, mold_name: '금형-5' }]),
      },
      location: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ location_id: 6n, location_name: '위치-6' }]),
      },
      inspection_result: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { inspection_result_id: 7n, inspection_result_no: '검사-7' },
          ]),
      },
    };
    const rows = [
      ['LOT', 1n],
      ['LOT', 1n],
      ['SERIAL_NUMBER', 2n],
      ['HANDLING_UNIT', 3n],
      ['GOODS_ISSUE_LINE', 4n],
      ['MOLD', 5n],
      ['LOCATION', 6n],
      ['INSPECTION_RESULT', 7n],
    ].map(([target_type_code, target_id]) => ({ target_type_code, target_id }));

    const result = await loadDocumentIssueTargets(tx as never, rows as never);

    expect(result).toEqual(
      new Map([
        [targetKey('LOT', 1n), { displayName: 'LOT-1', screenId: 'P-02-07' }],
        [
          targetKey('SERIAL_NUMBER', 2n),
          { displayName: 'SERIAL-2', screenId: 'P-02-05' },
        ],
        [
          targetKey('HANDLING_UNIT', 3n),
          { displayName: 'HU-3', screenId: 'P-02-09' },
        ],
        // 결정 — 레인 B 번호 없는 통보(I-27): 전표 번호와 라인 번호를 함께 보존한다.
        [
          targetKey('GOODS_ISSUE_LINE', 4n),
          { displayName: 'GI-4 #2', screenId: 'P-01-02' },
        ],
        [targetKey('MOLD', 5n), { displayName: '금형-5', screenId: 'W-05-13' }],
        [
          targetKey('LOCATION', 6n),
          { displayName: '위치-6', screenId: 'W-06-07' },
        ],
        [
          targetKey('INSPECTION_RESULT', 7n),
          { displayName: '검사-7', screenId: 'W-04-03' },
        ],
      ]),
    );
    expect(tx.lot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lot_id: { in: [1n] } } }),
    );
    for (const model of Object.values(tx))
      expect(model.findMany).toHaveBeenCalledTimes(1);
  });

  it('조회 결과가 없으면 빈 lookup이며 유형별 호출 수는 늘지 않는다', async () => {
    const findMany = (): jest.Mock => jest.fn().mockResolvedValue([]);
    const tx = {
      lot: { findMany: findMany() },
      serial_number: { findMany: findMany() },
      handling_unit: { findMany: findMany() },
      goods_issue_line: { findMany: findMany() },
      mold: { findMany: findMany() },
      location: { findMany: findMany() },
      inspection_result: { findMany: findMany() },
    };

    await expect(loadDocumentIssueTargets(tx as never, [])).resolves.toEqual(
      new Map(),
    );
    for (const model of Object.values(tx))
      expect(model.findMany).toHaveBeenCalledTimes(1);
  });
});
