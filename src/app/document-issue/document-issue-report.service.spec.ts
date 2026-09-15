import { Prisma } from '@prisma/client';

import { DocumentIssueReportContext } from './document-issue-report-context';
import {
  DocumentIssueReportInput,
  DocumentIssueReportService,
} from './document-issue-report.service';
import { DocumentIssueRow } from './document-issue-view';

function row(overrides: Partial<DocumentIssueRow> = {}): DocumentIssueRow {
  return {
    document_issue_log_id: 101n,
    document_type_code: 'LOCATION_LABEL',
    target_type_code: 'LOCATION',
    target_id: 201n,
    lot_id: null,
    issue_seq: 1,
    reissue_reason_code: null,
    issued_by: 301n,
    issued_at: new Date('2026-09-09T01:02:03Z'),
    terminal_id: null,
    printer_name: 'LABEL-A',
    remarks: '최초 발행',
    print_outcome_code: 'SUCCEEDED',
    print_failure_reason: null,
    print_reported_at: new Date('2026-09-09T01:03:00Z'),
    issued_worker_id: 501n,
    print_reported_worker_id: 502n,
    print_reported_by: 302n,
    app_user: { user_name: '최초 발행 계정' },
    lot: null,
    ...overrides,
  } as DocumentIssueRow;
}

const context: DocumentIssueReportContext = {
  key: 'key',
  fingerprint: 'fingerprint',
  successStatus: 200,
  appUserId: 302,
  workerNo: 'W-REPORT',
  terminalId: null,
};

function fixture(
  options: {
    locked?: {
      document_issue_log_id: bigint;
      print_outcome_code: string | null;
    };
    workerId?: bigint | null;
  } = {},
) {
  const raw = jest
    .fn()
    .mockResolvedValue(
      options.locked === undefined
        ? [{ document_issue_log_id: 101n, print_outcome_code: 'PENDING' }]
        : options.locked
          ? [options.locked]
          : [],
    );
  const update = jest.fn().mockImplementation(({ data }) =>
    Promise.resolve(
      row({
        print_outcome_code: data.print_outcome_code,
        print_failure_reason: data.print_failure_reason,
        print_reported_at: data.print_reported_at,
        print_reported_worker_id: data.print_reported_worker_id,
        print_reported_by: data.print_reported_by,
      }),
    ),
  );
  const findMany = jest.fn().mockResolvedValue([]);
  const worker = {
    findUnique: jest
      .fn()
      .mockResolvedValue(
        options.workerId === null
          ? null
          : { worker_id: options.workerId ?? 502n },
      ),
  };
  const tx = {
    $queryRaw: raw,
    worker,
    document_issue_log: { update },
    lot: { findMany },
    serial_number: { findMany },
    handling_unit: { findMany },
    goods_issue_line: { findMany },
    mold: { findMany },
    location: { findMany },
    inspection_result: { findMany },
  } as unknown as Prisma.TransactionClient;
  return { service: new DocumentIssueReportService(), tx, raw, update, worker };
}

describe('인쇄 결과 보고 (I-27 P3)', () => {
  afterEach(() => jest.useRealTimers());

  it('PENDING을 잠그고 SUCCEEDED·접수시각·보고 계정/worker를 저장해 같은 view를 낸다', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T01:03:00Z'));
    const { service, tx, raw, update } = fixture();
    const result = await service.reportWithin(
      tx,
      101,
      { outcome: 'SUCCEEDED', failureReason: ' \t ' },
      context,
    );
    expect(raw.mock.calls[0][0].sql).toContain('FOR UPDATE');
    expect(update).toHaveBeenCalledWith({
      where: { document_issue_log_id: 101n },
      data: {
        print_outcome_code: 'SUCCEEDED',
        print_failure_reason: null,
        print_reported_at: new Date('2026-09-09T01:03:00Z'),
        print_reported_worker_id: 502n,
        print_reported_by: 302n,
      },
      include: expect.any(Object),
    });
    expect(result).toMatchObject({
      documentIssueLogId: 101,
      issuedBy: 301,
      issuedByName: '최초 발행 계정',
      printOutcome: 'SUCCEEDED',
    });
  });

  it('FAILED 사유는 trim하지 않고 원문 그대로 저장한다', async () => {
    const { service, tx, update } = fixture();
    await service.reportWithin(
      tx,
      101,
      { outcome: 'FAILED', failureReason: '  용지 없음  ' },
      context,
    );
    expect(update.mock.calls[0][0].data).toMatchObject({
      print_outcome_code: 'FAILED',
      print_failure_reason: '  용지 없음  ',
    });
  });

  it.each([
    [{ outcome: 'FAILED' }, 'REQUIRED'],
    [{ outcome: 'FAILED', failureReason: null }, 'REQUIRED'],
    [{ outcome: 'FAILED', failureReason: '\t\n' }, 'REQUIRED'],
    [{ outcome: 'SUCCEEDED', failureReason: '용지 없음' }, 'INVALID'],
  ] as [DocumentIssueReportInput, string][])(
    '%p 사유 규칙은 422 %s다',
    async (input, code) => {
      const { service, tx, update } = fixture();
      await expect(
        service.reportWithin(tx, 101, input, context),
      ).rejects.toMatchObject({
        status: 422,
        errors: [expect.objectContaining({ field: 'failureReason', code })],
      });
      expect(update).not.toHaveBeenCalled();
    },
  );

  // ⭐ D7 — 「한 번만」이 아니라 「성공만 잠근다」다. 실패한 인쇄를 다시 찍고 그 결과를 보고할
  //    길이 없으면, 프린터가 한 번 죽은 LOT 은 영영 마감되지 않는다(화면이 인쇄 성공 뒤에만
  //    마감을 연다). `P-02-04` [발행된 라벨 다시 인쇄]는 새 회차를 만들지 않는다.
  it('이미 SUCCEEDED인 행의 새 보고는 422 STATE_LOCKED다 — 나온 라벨을 되돌리지 않는다', async () => {
    const { service, tx, update } = fixture({
      locked: { document_issue_log_id: 101n, print_outcome_code: 'SUCCEEDED' },
    });

    await expect(
      service.reportWithin(tx, 101, { outcome: 'SUCCEEDED' }, context),
    ).rejects.toMatchObject({
      status: 422,
      errors: [expect.objectContaining({ field: 'outcome', code: 'STATE_LOCKED' })],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('⭐ FAILED 뒤 SUCCEEDED 보고는 덮어쓴다 — 사유는 비우고 시각을 새로 찍는다', async () => {
    const { service, tx, update } = fixture({
      locked: { document_issue_log_id: 101n, print_outcome_code: 'FAILED' },
    });

    await service.reportWithin(tx, 101, { outcome: 'SUCCEEDED' }, context);

    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      print_outcome_code: 'SUCCEEDED',
      print_failure_reason: null,
    });
  });

  it('⭐ FAILED 뒤 새 사유의 FAILED 보고도 받는다 — 다시 시도했다가 또 실패한 자리다', async () => {
    const { service, tx, update } = fixture({
      locked: { document_issue_log_id: 101n, print_outcome_code: 'FAILED' },
    });

    await service.reportWithin(tx, 101, { outcome: 'FAILED', failureReason: '용지 없음' }, context);

    expect((update.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      print_outcome_code: 'FAILED',
      print_failure_reason: '용지 없음',
    });
  });

  it('⛔ FAILED 를 다시 보고할 때도 사유는 여전히 필수다', async () => {
    const { service, tx, update } = fixture({
      locked: { document_issue_log_id: 101n, print_outcome_code: 'FAILED' },
    });

    await expect(
      service.reportWithin(tx, 101, { outcome: 'FAILED' }, context),
    ).rejects.toMatchObject({
      status: 422,
      errors: [expect.objectContaining({ field: 'failureReason', code: 'REQUIRED' })],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([null, 'UNKNOWN'])(
    '저장 outcome %p 결손은 500 원인이다',
    async (outcome) => {
      const { service, tx } = fixture({
        locked: { document_issue_log_id: 101n, print_outcome_code: outcome },
      });
      await expect(
        service.reportWithin(tx, 101, { outcome: 'SUCCEEDED' }, context),
      ).rejects.toThrow('printOutcome');
    },
  );

  it('없는 기록은 404이고 없는 worker는 400 INVALID다', async () => {
    const missing = fixture({ locked: undefined });
    missing.raw.mockResolvedValue([]);
    await expect(
      missing.service.reportWithin(
        missing.tx,
        101,
        { outcome: 'SUCCEEDED' },
        context,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const noWorker = fixture({ workerId: null });
    await expect(
      noWorker.service.reportWithin(
        noWorker.tx,
        101,
        { outcome: 'SUCCEEDED' },
        context,
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        expect.objectContaining({ field: 'X-Worker-No', code: 'INVALID' }),
      ],
    });
    expect(noWorker.update).not.toHaveBeenCalled();
  });

  it('unsafe ID는 bigint 변환·잠금 전에 400 RANGE다', async () => {
    const { service, tx, raw } = fixture();
    await expect(
      service.reportWithin(
        tx,
        Number.MAX_SAFE_INTEGER + 1,
        { outcome: 'SUCCEEDED' },
        context,
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        expect.objectContaining({ field: 'documentIssueLogId', code: 'RANGE' }),
      ],
    });
    expect(raw).not.toHaveBeenCalled();
  });
});
