import { DocumentIssueSummaryService } from './document-issue-summary.service';

interface Row {
  target_id: bigint;
  issue_count: bigint;
  issue_seq: number;
  issued_at: Date;
  print_outcome_code: string | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    target_id: 1n,
    issue_count: 3n,
    issue_seq: 2,
    issued_at: new Date('2026-09-08T01:02:03.456Z'),
    print_outcome_code: 'FAILED',
    ...overrides,
  };
}

function fixture(rows: Row[]): {
  service: DocumentIssueSummaryService;
  queryRaw: jest.Mock;
} {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  return {
    service: new DocumentIssueSummaryService({ $queryRaw: queryRaw } as never),
    queryRaw,
  };
}

describe('발행 요약 조회 (I-27 P2)', () => {
  it('입력 순서·중복·미발행 대상을 보존하고 최신 행의 세 필드를 함께 낸다', async () => {
    const { service, queryRaw } = fixture([
      row(),
      row({
        target_id: 2n,
        issue_count: 1n,
        issue_seq: 7,
        issued_at: new Date('2026-09-09T00:00:00Z'),
        print_outcome_code: null,
      }),
    ]);
    await expect(
      service.summary({ targetTypeCode: 'LOT', targetIds: [2, 1, 2, 3] }),
    ).resolves.toEqual({
      items: [
        {
          targetTypeCode: 'LOT',
          targetId: 2,
          issueCount: 1,
          lastIssueSeq: 7,
          lastIssuedAt: '2026-09-09T00:00:00.000Z',
          lastPrintOutcome: null,
        },
        {
          targetTypeCode: 'LOT',
          targetId: 1,
          issueCount: 3,
          lastIssueSeq: 2,
          lastIssuedAt: '2026-09-08T01:02:03.456Z',
          lastPrintOutcome: 'FAILED',
        },
        {
          targetTypeCode: 'LOT',
          targetId: 2,
          issueCount: 1,
          lastIssueSeq: 7,
          lastIssuedAt: '2026-09-09T00:00:00.000Z',
          lastPrintOutcome: null,
        },
        {
          targetTypeCode: 'LOT',
          targetId: 3,
          issueCount: 0,
          lastIssueSeq: null,
          lastIssuedAt: null,
          lastPrintOutcome: null,
        },
      ],
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const values = queryRaw.mock.calls[0][0].values as unknown[];
    expect(values.filter((value) => typeof value === 'bigint')).toEqual([
      2n,
      1n,
      3n,
    ]);
  });

  it('1000개도 한 SQL로 읽고 문서 유형 조건을 같은 SQL에 둔다', async () => {
    const { service, queryRaw } = fixture([]);
    await service.summary({
      targetTypeCode: 'LOCATION',
      targetIds: Array.from({ length: 1000 }, (_, index) => index + 1),
      documentTypeCode: 'LOCATION_LABEL',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0][0].values).toContain('LOCATION_LABEL');
  });

  it.each([
    [[], '1개 이상'],
    [Array.from({ length: 1001 }, (_, index) => index), '1000개'],
    [[Number.MAX_SAFE_INTEGER + 1], '범위'],
    [[1.5], '범위'],
  ])('잘못된 targetIds %p는 SQL 전에 RANGE다', async (targetIds, message) => {
    const { service, queryRaw } = fixture([]);
    await expect(
      service.summary({ targetTypeCode: 'LOT', targetIds }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          field: 'targetIds',
          code: 'RANGE',
          message: expect.stringContaining(message),
        }),
      ],
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    [{ issue_count: -1n }, 'issueCount'],
    [{ issue_count: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, 'issueCount'],
    [{ issue_seq: 0 }, 'lastIssueSeq'],
    [{ issued_at: new Date('invalid') }, 'lastIssuedAt'],
    [{ print_outcome_code: 'UNKNOWN' }, 'lastPrintOutcome'],
  ])('저장 요약 결손 %s는 보정하지 않고 오류다', async (overrides, field) => {
    const { service } = fixture([row(overrides)]);
    await expect(
      service.summary({ targetTypeCode: 'LOT', targetIds: [1] }),
    ).rejects.toThrow(field);
  });
});
